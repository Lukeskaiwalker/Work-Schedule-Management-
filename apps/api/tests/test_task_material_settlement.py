"""Completing a task settles what its construction box took to site.

The crate was checked out of the warehouse when it was handed over
(services/werkstatt_boxes.py). Until now nothing ever closed that loop: the
crate came back through a manual "zurueck" that returned *everything*, or it
never came back on paper at all. These tests pin the loop:

  * a report filed from the task writes the fitted quantities onto the task's
    material lines (a line left out of the report counts as unused),
  * marking the task done writes the fitted part off (`correction`) and puts
    the rest back on the shelf (`return`), once and only once,
  * the crate is then empty, "offen" and unassigned, ready to pack again,
  * a crate that never left the workshop is left alone.
"""
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


_project_counter = iter(range(7000, 9999))


def _customer(client: TestClient, admin_token: str, name: str) -> int:
    resp = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _project(client: TestClient, admin_token: str, name: str, customer_id: int) -> int:
    resp = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": f"2026-{next(_project_counter)}",
            "name": name,
            "description": "",
            "status": "active",
            "customer_id": customer_id,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _article(client: TestClient, admin_token: str, name: str, stock: int) -> int:
    """An article with `stock` on the shelf, seeded through the ledger."""
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": name, "unit": "Stk"},
    )
    assert created.status_code == 200, created.text
    article_id = created.json()["id"]

    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle
    from app.services.werkstatt_movements import apply_movement

    with SessionLocal() as db:
        admin = db.scalars(select(User).where(User.email == "admin@example.com")).one()
        apply_movement(
            db,
            article=db.get(WerkstattArticle, article_id),
            movement_type="intake",
            quantity=stock,
            user_id=admin.id,
        )
        db.commit()
    return article_id


def _box(client: TestClient, admin_token: str, label: str) -> dict:
    resp = client.post("/api/werkstatt/boxes", headers=auth_headers(admin_token), json={"label": label})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _pack_article(client: TestClient, admin_token: str, box_id: int, article_id: int, qty: int) -> None:
    resp = client.post(
        f"/api/werkstatt/boxes/{box_id}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article_id, "quantity": qty},
    )
    assert resp.status_code == 200, resp.text


def _hand_over(client: TestClient, admin_token: str, box_id: int, customer_id: int) -> None:
    resp = client.post(
        f"/api/werkstatt/boxes/{box_id}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "zugewiesen"


def _task(client: TestClient, admin_token: str, **payload) -> dict:
    resp = client.post(
        "/api/tasks", headers=auth_headers(admin_token), json={"title": "Montage", **payload}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _materials(client: TestClient, admin_token: str, task_id: int) -> list[dict]:
    """The task's lines off the list endpoint (there is no GET /tasks/{id}).

    The default view hides completed tasks, so a settled task is read through
    the "completed" view — the same one the UI uses for finished work.
    """
    for view in ("all_open", "completed"):
        resp = client.get(f"/api/tasks?view={view}", headers=auth_headers(admin_token))
        assert resp.status_code == 200, resp.text
        match = [row for row in resp.json() if row["id"] == task_id]
        if match:
            return match[0]["materials"]
    raise AssertionError(f"task {task_id} in neither view")


def _set_status(client: TestClient, admin_token: str, task_id: int, status: str) -> dict:
    resp = client.patch(
        f"/api/tasks/{task_id}", headers=auth_headers(admin_token), json={"status": status}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _report(client: TestClient, admin_token: str, project_id: int, task_id: int, rows: list[dict]) -> dict:
    resp = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-09-08",
            "payload": {
                "customer": "",
                "workers": [{"name": "Monteur"}],
                "materials_consumed": rows,
                "source_task_id": task_id,
            },
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _stock(article_id: int) -> tuple[int, int, int]:
    """(total, available, out) straight from the article snapshot."""
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattArticle

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        return row.stock_total, row.stock_available, row.stock_out


def _movements(article_id: int) -> list[tuple[str, int, int | None]]:
    from app.core.db import SessionLocal
    from app.models.entities import WerkstattMovement

    with SessionLocal() as db:
        rows = db.scalars(
            select(WerkstattMovement)
            .where(WerkstattMovement.article_id == article_id)
            .order_by(WerkstattMovement.id)
        ).all()
        return [(r.movement_type, r.quantity, r.construction_box_id) for r in rows]


def _box_state(client: TestClient, admin_token: str, box_id: int) -> dict:
    resp = client.get(f"/api/werkstatt/boxes/{box_id}", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    return resp.json()


class _Site:
    """One handed-over crate on one task: the state every scenario starts from."""

    def __init__(self, client: TestClient, admin_token: str, *, packed: int = 10, stock: int = 20):
        self.client, self.token = client, admin_token
        self.customer_id = _customer(client, admin_token, "Kunde Abrechnung")
        self.project_id = _project(client, admin_token, "Baustelle Abrechnung", self.customer_id)
        self.article_id = _article(client, admin_token, "Wago 221-415", stock)
        self.box = _box(client, admin_token, "Kiste Abrechnung")
        _pack_article(client, admin_token, self.box["id"], self.article_id, packed)
        _hand_over(client, admin_token, self.box["id"], self.customer_id)
        self.task = _task(
            client,
            admin_token,
            customer_id=self.customer_id,
            project_id=self.project_id,
            construction_box_id=self.box["id"],
        )
        self.line = _materials(client, admin_token, self.task["id"])[0]


def test_handover_is_the_only_movement_before_completion(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    assert _stock(site.article_id) == (20, 10, 10)
    assert _movements(site.article_id) == [("intake", 20, None), ("checkout", 10, site.box["id"])]
    assert site.line["quantity"] == 10 and site.line["quantity_used"] is None
    assert site.line["settled_at"] is None


def test_report_from_task_records_used_quantities_without_moving_stock(
    client: TestClient, admin_token: str
):
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "unit": "Stk", "task_material_id": site.line["id"]}],
    )
    line = _materials(client, admin_token, site.task["id"])[0]
    assert line["quantity_used"] == 6
    # The report is a statement, not a booking. Stock moves on completion.
    assert _stock(site.article_id) == (20, 10, 10)


def test_completion_writes_off_used_and_returns_the_rest(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "task_material_id": site.line["id"]}],
    )

    done = _set_status(client, admin_token, site.task["id"], "done")

    assert _movements(site.article_id)[2:] == [
        ("correction", 6, site.box["id"]),
        ("return", 4, site.box["id"]),
    ]
    # 20 on the shelf, 6 fitted: 14 left, none out.
    assert _stock(site.article_id) == (14, 14, 0)

    box = _box_state(client, admin_token, site.box["id"])
    assert box["status"] == "offen"
    assert box["customer_id"] is None and box["project_id"] is None
    assert box["items"] == []

    # The task keeps the record and lets go of the crate.
    assert done["construction_box_id"] is None
    assert done["materials"][0]["quantity_used"] == 6
    assert done["materials"][0]["settled_at"] is not None
    listed = _materials(client, admin_token, site.task["id"])
    assert listed[0]["quantity_used"] == 6 and listed[0]["settled_at"] is not None


def test_completion_without_a_report_consumes_everything(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    _set_status(client, admin_token, site.task["id"], "done")
    assert _movements(site.article_id)[2:] == [("correction", 10, site.box["id"])]
    assert _stock(site.article_id) == (10, 10, 0)


def test_a_line_left_out_of_the_report_counts_as_unused(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    other_article = _article(client, admin_token, "Hager MBN116", 8)
    # Second line, packed before handover is impossible (locked) — so re-open
    # the crate is not an option either; build a second site instead.
    site2 = _Site.__new__(_Site)
    site2.client, site2.token = client, admin_token
    site2.customer_id = site.customer_id
    site2.project_id = site.project_id
    box = _box(client, admin_token, "Kiste Zwei Zeilen")
    _pack_article(client, admin_token, box["id"], site.article_id, 4)
    _pack_article(client, admin_token, box["id"], other_article, 5)
    _hand_over(client, admin_token, box["id"], site.customer_id)
    task = _task(
        client, admin_token,
        customer_id=site.customer_id, project_id=site.project_id, construction_box_id=box["id"],
    )
    lines = {row["item_name"]: row for row in _materials(client, admin_token, task["id"])}

    _report(
        client, admin_token, site.project_id, task["id"],
        [{"item": "Wago 221-415", "qty": "3", "task_material_id": lines["Wago 221-415"]["id"]}],
    )
    after = {row["item_name"]: row for row in _materials(client, admin_token, task["id"])}
    assert after["Wago 221-415"]["quantity_used"] == 3
    assert after["Hager MBN116"]["quantity_used"] == 0

    _set_status(client, admin_token, task["id"], "done")
    # intake, checkout at handover, then the whole line comes back.
    assert _movements(other_article)[2:] == [("return", 5, box["id"])]
    assert _stock(other_article) == (8, 8, 0)


def test_report_rows_without_ids_leave_usage_unreported(client: TestClient, admin_token: str):
    """A hand-typed material list (the old free-text path) says nothing about the crate."""
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Sonstiges Kleinmaterial", "qty": "3"}],
    )
    assert _materials(client, admin_token, site.task["id"])[0]["quantity_used"] is None
    _set_status(client, admin_token, site.task["id"], "done")
    assert _movements(site.article_id)[2:] == [("correction", 10, site.box["id"])]


def test_settlement_happens_once(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    _set_status(client, admin_token, site.task["id"], "done")
    first = _movements(site.article_id)
    _set_status(client, admin_token, site.task["id"], "open")
    _set_status(client, admin_token, site.task["id"], "done")
    assert _movements(site.article_id) == first
    assert _stock(site.article_id) == (10, 10, 0)


def test_usage_beyond_what_went_out_is_capped(client: TestClient, admin_token: str):
    """Fitting 15 of a crate that held 10 cannot write off stock that was never out."""
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "15", "task_material_id": site.line["id"]}],
    )
    _set_status(client, admin_token, site.task["id"], "done")
    assert _movements(site.article_id)[2:] == [("correction", 10, site.box["id"])]
    assert _stock(site.article_id) == (10, 10, 0)


def test_a_crate_that_never_left_the_workshop_is_left_alone(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Kunde Ohne Übergabe")
    project_id = _project(client, admin_token, "Ohne Übergabe", customer_id)
    article_id = _article(client, admin_token, "Wago 2273-203", 30)
    box = _box(client, admin_token, "Kiste Noch Im Lager")
    _pack_article(client, admin_token, box["id"], article_id, 7)
    task = _task(
        client, admin_token,
        customer_id=customer_id, project_id=project_id, construction_box_id=box["id"],
    )

    done = _set_status(client, admin_token, task["id"], "done")

    assert _movements(article_id) == [("intake", 30, None)]
    box_after = _box_state(client, admin_token, box["id"])
    assert box_after["status"] == "offen" and len(box_after["items"]) == 1
    assert done["construction_box_id"] == box["id"]
    assert done["materials"][0]["settled_at"] is None


def test_unlinking_after_settlement_keeps_the_record(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    _set_status(client, admin_token, site.task["id"], "done")

    from app.core.db import SessionLocal
    from app.services.task_materials import remove_box_from_task, task_materials

    with SessionLocal() as db:
        removed = remove_box_from_task(db, task_id=site.task["id"], box_id=site.box["id"])
        db.commit()
        assert removed == 0
        assert len(task_materials(db, site.task["id"])) == 1


def test_patch_response_carries_the_material_lines(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    patched = client.patch(
        f"/api/tasks/{site.task['id']}",
        headers=auth_headers(admin_token),
        json={"title": "Montage, umbenannt"},
    )
    assert patched.status_code == 200, patched.text
    assert [row["item_name"] for row in patched.json()["materials"]] == ["Wago 221-415"]


# ── "Was ist mit dem Rest passiert?" ─────────────────────────────────────────
#
# The ledger is identical for all three outcomes — used is written off, the
# rest comes back into the workshop. What differs is which crate the rest sits
# in afterwards, which is exactly what the dialog asks and what these pin.


def _preview(client: TestClient, admin_token: str, task_id: int) -> dict:
    resp = client.get(
        f"/api/tasks/{task_id}/material-settlement", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _complete(client: TestClient, admin_token: str, task_id: int, remainder: dict | None) -> dict:
    body: dict = {"status": "done"}
    if remainder is not None:
        body["material_remainder"] = remainder
    resp = client.patch(
        f"/api/tasks/{task_id}", headers=auth_headers(admin_token), json=body
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _boxes(client: TestClient, admin_token: str) -> list[dict]:
    resp = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _pack_site(client: TestClient, admin_token: str, *, packed: int = 10, stock: int = 20):
    """A crate packed for a customer and NOT handed over, linked to a task."""
    site = _Site.__new__(_Site)
    site.client, site.token = client, admin_token
    site.customer_id = _customer(client, admin_token, "Kunde Gepackt Abschluss")
    site.project_id = _project(client, admin_token, "Baustelle Gepackt", site.customer_id)
    site.article_id = _article(client, admin_token, "Wago 221-413", stock)
    site.box = _box(client, admin_token, "Kiste Gepackt")
    _pack_article(client, admin_token, site.box["id"], site.article_id, packed)
    packed_resp = client.post(
        f"/api/werkstatt/boxes/{site.box['id']}/pack",
        headers=auth_headers(admin_token),
        json={"customer_id": site.customer_id, "project_id": site.project_id},
    )
    assert packed_resp.status_code == 200, packed_resp.text
    assert packed_resp.json()["status"] == "gepackt"
    site.task = _task(
        client,
        admin_token,
        customer_id=site.customer_id,
        project_id=site.project_id,
        construction_box_id=site.box["id"],
    )
    site.line = _materials(client, admin_token, site.task["id"])[0]
    return site


def test_preview_lists_the_rest_and_asks_for_a_decision(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "task_material_id": site.line["id"]}],
    )

    preview = _preview(client, admin_token, site.task["id"])
    assert preview["needs_decision"] is True
    assert preview["handover_pending"] is False
    assert preview["remainder_total"] == 4
    assert preview["box"]["box_number"] == site.box["box_number"]
    assert preview["box"]["status"] == "zugewiesen"
    line = preview["lines"][0]
    assert (line["quantity"], line["quantity_used"], line["remainder"]) == (10, 6, 4)


def test_preview_asks_nothing_when_everything_was_used(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "10", "task_material_id": site.line["id"]}],
    )
    preview = _preview(client, admin_token, site.task["id"])
    assert preview["needs_decision"] is False
    assert preview["remainder_total"] == 0


def test_preview_of_a_task_without_a_crate_is_empty(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Kunde Ohne Kiste")
    project_id = _project(client, admin_token, "Ohne Kiste", customer_id)
    task = _task(client, admin_token, customer_id=customer_id, project_id=project_id)
    preview = _preview(client, admin_token, task["id"])
    assert preview == {
        "box": None,
        "lines": [],
        "remainder_total": 0,
        "handover_pending": False,
        "needs_decision": False,
    }


def test_the_rest_can_stay_in_the_same_crate(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "task_material_id": site.line["id"]}],
    )

    done = _complete(client, admin_token, site.task["id"], {"disposition": "same_box"})

    # The ledger is the same as for every other outcome.
    assert _movements(site.article_id)[2:] == [
        ("correction", 6, site.box["id"]),
        ("return", 4, site.box["id"]),
    ]
    assert _stock(site.article_id) == (14, 14, 0)

    box = _box_state(client, admin_token, site.box["id"])
    assert box["status"] == "gepackt"
    assert box["customer_id"] == site.customer_id
    assert [(row["item_name"], row["quantity"]) for row in box["items"]] == [("Wago 221-415", 4)]
    assert done["construction_box_id"] is None

    line = _materials(client, admin_token, site.task["id"])[0]
    assert line["settled_at"] is not None


def test_a_fully_used_line_leaves_the_same_crate_empty_and_open(
    client: TestClient, admin_token: str
):
    """``same_box`` with nothing left is an empty crate — and an empty crate is not packed."""
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "10", "task_material_id": site.line["id"]}],
    )
    _complete(client, admin_token, site.task["id"], {"disposition": "same_box"})

    box = _box_state(client, admin_token, site.box["id"])
    assert box["items"] == []
    assert box["status"] == "offen"
    assert box["customer_id"] is None

    # And the line records the OUTCOME, not the intention: there is no crate
    # holding the rest, so "same_box" would be a lie about where to look.
    from app.core.db import SessionLocal
    from app.models.entities import TaskMaterial

    with SessionLocal() as db:
        row = db.get(TaskMaterial, site.line["id"])
        assert row.remainder_disposition == "shelf"
        assert row.remainder_box_id is None


def test_the_rest_can_move_into_a_new_crate(client: TestClient, admin_token: str):
    # Packed for a customer AND a project, then carried out properly: the new
    # crate has to inherit both, or the leftovers lose their job.
    site = _pack_site(client, admin_token)
    handed = client.post(
        f"/api/werkstatt/boxes/{site.box['id']}/status",
        headers=auth_headers(admin_token),
        json={"status": "zugewiesen"},
    )
    assert handed.status_code == 200, handed.text
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-413", "qty": "6", "task_material_id": site.line["id"]}],
    )

    _complete(
        client,
        admin_token,
        site.task["id"],
        {"disposition": "new_box", "new_box_label": "Rest Musterstraße"},
    )

    assert _stock(site.article_id) == (14, 14, 0)

    old = _box_state(client, admin_token, site.box["id"])
    assert old["status"] == "offen" and old["items"] == [] and old["customer_id"] is None

    fresh = [row for row in _boxes(client, admin_token) if row["label"] == "Rest Musterstraße"]
    assert len(fresh) == 1
    new_box = _box_state(client, admin_token, fresh[0]["id"])
    assert new_box["status"] == "gepackt"
    assert new_box["customer_id"] == site.customer_id
    assert new_box["project_id"] == site.project_id
    assert [(row["item_name"], row["quantity"], row["source"]) for row in new_box["items"]] == [
        ("Wago 221-413", 4, "article")
    ]


def test_a_new_crate_needs_a_name(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    resp = client.patch(
        f"/api/tasks/{site.task['id']}",
        headers=auth_headers(admin_token),
        json={"status": "done", "material_remainder": {"disposition": "new_box"}},
    )
    assert resp.status_code == 400
    assert "Bezeichnung" in resp.json()["detail"]
    # Nothing was settled — the task is still open and the crate still out.
    assert _movements(site.article_id)[2:] == []
    assert _box_state(client, admin_token, site.box["id"])["status"] == "zugewiesen"


def test_the_rest_goes_back_to_the_rack_by_default(client: TestClient, admin_token: str):
    """No choice at all still means today's behaviour: the crate is emptied."""
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "task_material_id": site.line["id"]}],
    )
    _complete(client, admin_token, site.task["id"], {"disposition": "shelf"})

    assert _stock(site.article_id) == (14, 14, 0)
    box = _box_state(client, admin_token, site.box["id"])
    assert box["status"] == "offen" and box["items"] == [] and box["customer_id"] is None


def test_a_packed_crate_that_never_got_booked_out_is_settled_anyway(
    client: TestClient, admin_token: str
):
    """Taken to site while still ``gepackt``: the handover is booked at completion."""
    site = _pack_site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-413", "qty": "6", "task_material_id": site.line["id"]}],
    )
    preview = _preview(client, admin_token, site.task["id"])
    assert preview["handover_pending"] is True
    assert preview["needs_decision"] is True
    assert preview["box"]["status"] == "gepackt"
    _complete(client, admin_token, site.task["id"], {"disposition": "same_box"})

    # intake, then the retro-booked handover, then the normal settlement.
    assert _movements(site.article_id) == [
        ("intake", 20, None),
        ("checkout", 10, site.box["id"]),
        ("correction", 6, site.box["id"]),
        ("return", 4, site.box["id"]),
    ]
    assert _stock(site.article_id) == (14, 14, 0)
    box = _box_state(client, admin_token, site.box["id"])
    assert box["status"] == "gepackt"
    assert [(row["item_name"], row["quantity"]) for row in box["items"]] == [("Wago 221-413", 4)]


def test_the_settlement_records_what_happened_to_the_rest(client: TestClient, admin_token: str):
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "task_material_id": site.line["id"]}],
    )
    _complete(client, admin_token, site.task["id"], {"disposition": "same_box"})

    from app.core.db import SessionLocal
    from app.models.entities import TaskMaterial

    with SessionLocal() as db:
        row = db.get(TaskMaterial, site.line["id"])
        assert row.remainder_disposition == "same_box"
        assert row.remainder_box_id == site.box["id"]


def _employee(client: TestClient, admin_token: str, email: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": email.split("@", 1)[0],
            "role": "employee",
        },
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def test_the_preview_is_readable_by_exactly_who_may_complete_the_task(
    client: TestClient, admin_token: str
):
    """It names a customer and the contents of their crate — a preview that
    were readable more widely than the PATCH it precedes would leak both."""
    site = _Site(client, admin_token)
    monteur_id, monteur_token = _employee(client, admin_token, "monteur.rest@example.com")
    stranger_id, stranger_token = _employee(client, admin_token, "fremder.rest@example.com")
    assert stranger_id != monteur_id

    refused = client.get(
        f"/api/tasks/{site.task['id']}/material-settlement",
        headers=auth_headers(stranger_token),
    )
    assert refused.status_code == 403

    assigned = client.patch(
        f"/api/tasks/{site.task['id']}",
        headers=auth_headers(admin_token),
        json={"assignee_ids": [monteur_id]},
    )
    assert assigned.status_code == 200, assigned.text

    allowed = client.get(
        f"/api/tasks/{site.task['id']}/material-settlement",
        headers=auth_headers(monteur_token),
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["box"]["box_number"] == site.box["box_number"]


def test_an_employee_may_settle_the_crate_while_completing_their_task(
    client: TestClient, admin_token: str
):
    """The person on site is the one who knows where the rest went, and the
    employee path used to refuse every field but ``status``."""
    site = _Site(client, admin_token)
    monteur_id, monteur_token = _employee(client, admin_token, "monteur.abschluss@example.com")
    client.patch(
        f"/api/tasks/{site.task['id']}",
        headers=auth_headers(admin_token),
        json={"assignee_ids": [monteur_id]},
    )
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "task_material_id": site.line["id"]}],
    )

    done = client.patch(
        f"/api/tasks/{site.task['id']}",
        headers=auth_headers(monteur_token),
        json={"status": "done", "material_remainder": {"disposition": "same_box"}},
    )
    assert done.status_code == 200, done.text
    box = _box_state(client, admin_token, site.box["id"])
    assert box["status"] == "gepackt"
    assert [(row["item_name"], row["quantity"]) for row in box["items"]] == [("Wago 221-415", 4)]


# ── The crate is the authority, not the task's copy of it ────────────────────
#
# A task holds a COPY of the crate's contents, taken when the crate was linked.
# The two drift: a ``gepackt`` crate stays editable, and two tasks of the same
# customer may each hold a copy of the same crate. Booking a line's own number
# would then move stock the crate does not have — and ``apply_movement`` clamps
# the resulting negative counter to zero in silence, so the loss shows up
# nowhere at all. These pin both directions of the drift.


def _box_items(client: TestClient, admin_token: str, box_id: int) -> list[dict]:
    resp = client.get(
        f"/api/werkstatt/boxes/{box_id}/items", headers=auth_headers(admin_token)
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _hand_over_packed(client: TestClient, admin_token: str, box_id: int) -> None:
    resp = client.post(
        f"/api/werkstatt/boxes/{box_id}/status",
        headers=auth_headers(admin_token),
        json={"status": "zugewiesen"},
    )
    assert resp.status_code == 200, resp.text


def test_two_tasks_on_one_crate_cannot_settle_it_twice(client: TestClient, admin_token: str):
    """One crate, two tasks of the same customer — the second settlement may
    only book what the first one left standing.

    Nothing forbids the pair: a crate is refused only to a task anchored to a
    DIFFERENT customer, and the picker offers a customer's own crates to every
    one of their tasks. With ``same_box`` leaving the crate packed, the second
    task then meets a crate that still exists and still has its lines — and
    used to book its own stale 10 against it.
    """
    customer_id = _customer(client, admin_token, "Kunde Zwei Aufgaben")
    project_id = _project(client, admin_token, "Baustelle Zwei Aufgaben", customer_id)
    article_id = _article(client, admin_token, "Wago 221-612", 20)
    box = _box(client, admin_token, "Kiste Zwei Aufgaben")
    _pack_article(client, admin_token, box["id"], article_id, 10)
    packed = client.post(
        f"/api/werkstatt/boxes/{box['id']}/pack",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id, "project_id": project_id},
    )
    assert packed.status_code == 200, packed.text

    first = _task(
        client, admin_token,
        customer_id=customer_id, project_id=project_id, construction_box_id=box["id"],
    )
    second = _task(
        client, admin_token,
        customer_id=customer_id, project_id=project_id, construction_box_id=box["id"],
    )
    first_line = _materials(client, admin_token, first["id"])[0]
    second_line = _materials(client, admin_token, second["id"])[0]
    assert first_line["quantity"] == second_line["quantity"] == 10

    _hand_over_packed(client, admin_token, box["id"])
    _report(
        client, admin_token, project_id, first["id"],
        [{"item": "Wago 221-612", "qty": "6", "task_material_id": first_line["id"]}],
    )
    _complete(client, admin_token, first["id"], {"disposition": "same_box"})

    # The crate is packed again and holds 4 — so 4 is all the second task can
    # possibly settle, whatever its own copy still claims.
    assert [(row["item_name"], row["quantity"]) for row in _box_items(client, admin_token, box["id"])] == [
        ("Wago 221-612", 4)
    ]
    preview = _preview(client, admin_token, second["id"])
    assert preview["lines"][0]["quantity"] == 4

    _complete(client, admin_token, second["id"], None)

    assert _movements(article_id) == [
        ("intake", 20, None),
        ("checkout", 10, box["id"]),
        ("correction", 6, box["id"]),
        ("return", 4, box["id"]),
        # The second task met a packed crate, so its handover was booked too.
        ("checkout", 4, box["id"]),
        ("correction", 4, box["id"]),
    ]
    total, available, out = _stock(article_id)
    assert (total, available, out) == (10, 10, 0)
    # The documented invariant, stated as the invariant: without the cap this
    # read total 4 / available 10 / out 0 and four units had simply vanished.
    assert total == available + out

    after = _box_state(client, admin_token, box["id"])
    assert after["status"] == "offen" and after["items"] == []


def test_material_added_after_the_task_took_its_copy_comes_back_too(
    client: TestClient, admin_token: str
):
    """A top-up into a still-``gepackt`` crate is checked out with the rest at
    handover, and no task line will ever write it off — so the settlement has
    to hand it back, and leave it in the crate under ``same_box``."""
    site = _pack_site(client, admin_token)
    _pack_article(client, admin_token, site.box["id"], site.article_id, 5)
    assert _box_items(client, admin_token, site.box["id"])[0]["quantity"] == 15
    # The task's copy is untouched: re-importing on every save would resurrect
    # lines somebody removed, so the list is only re-read when the LINK changes.
    assert _materials(client, admin_token, site.task["id"])[0]["quantity"] == 10

    _hand_over_packed(client, admin_token, site.box["id"])
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-413", "qty": "6", "task_material_id": site.line["id"]}],
    )
    _complete(client, admin_token, site.task["id"], {"disposition": "same_box"})

    assert _movements(site.article_id) == [
        ("intake", 20, None),
        ("checkout", 15, site.box["id"]),
        ("correction", 6, site.box["id"]),
        ("return", 4, site.box["id"]),
        # The five nobody accounted for come back in full — nobody said they
        # were fitted.
        ("return", 5, site.box["id"]),
    ]
    assert _stock(site.article_id) == (14, 14, 0)

    box = _box_state(client, admin_token, site.box["id"])
    assert box["status"] == "gepackt"
    assert [(row["item_name"], row["quantity"]) for row in box["items"]] == [("Wago 221-413", 9)]


def test_the_unaccounted_part_comes_back_when_the_rest_is_shelved_too(
    client: TestClient, admin_token: str
):
    """Same drift, the default outcome: the ledger still sums back to the
    checkout, and the crate goes back on the rack empty."""
    site = _pack_site(client, admin_token)
    _pack_article(client, admin_token, site.box["id"], site.article_id, 5)
    _hand_over_packed(client, admin_token, site.box["id"])
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-413", "qty": "6", "task_material_id": site.line["id"]}],
    )
    _complete(client, admin_token, site.task["id"], {"disposition": "shelf"})

    assert _movements(site.article_id)[1:] == [
        ("checkout", 15, site.box["id"]),
        ("correction", 6, site.box["id"]),
        ("return", 4, site.box["id"]),
        ("return", 5, site.box["id"]),
    ]
    assert _stock(site.article_id) == (14, 14, 0)
    box = _box_state(client, admin_token, site.box["id"])
    assert box["status"] == "offen" and box["items"] == [] and box["customer_id"] is None


def test_a_line_reduced_after_the_task_took_its_copy_is_not_over_booked(
    client: TestClient, admin_token: str
):
    """The other direction: the packer takes five back out of a sealed crate
    before it leaves, so only five were ever checked out — and a report
    claiming six may not write off a sixth that never went anywhere."""
    site = _pack_site(client, admin_token)
    item = _box_items(client, admin_token, site.box["id"])[0]
    reduced = client.patch(
        f"/api/werkstatt/boxes/{site.box['id']}/items/{item['id']}",
        headers=auth_headers(admin_token),
        json={"quantity": 5},
    )
    assert reduced.status_code == 200, reduced.text

    _hand_over_packed(client, admin_token, site.box["id"])
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-413", "qty": "6", "task_material_id": site.line["id"]}],
    )
    _complete(client, admin_token, site.task["id"], {"disposition": "same_box"})

    assert _movements(site.article_id) == [
        ("intake", 20, None),
        ("checkout", 5, site.box["id"]),
        ("correction", 5, site.box["id"]),
    ]
    total, available, out = _stock(site.article_id)
    assert (total, available, out) == (15, 15, 0)
    assert total == available + out
    # Nothing is left, so the crate is empty and back on the rack whatever the
    # dialog asked for.
    box = _box_state(client, admin_token, site.box["id"])
    assert box["status"] == "offen" and box["items"] == []


def test_the_completion_answers_with_what_it_did_with_the_rest(
    client: TestClient, admin_token: str
):
    """The notice is phrased from the response, so the response has to carry
    the outcome — which is not always the choice that was sent."""
    site = _Site(client, admin_token)
    _report(
        client, admin_token, site.project_id, site.task["id"],
        [{"item": "Wago 221-415", "qty": "6", "task_material_id": site.line["id"]}],
    )
    done = _complete(client, admin_token, site.task["id"], {"disposition": "same_box"})
    assert done["material_settlement"] == {
        "disposition": "same_box",
        "remainder_box_id": site.box["id"],
        "remainder_box_number": site.box["box_number"],
        "handover_booked": False,
    }

    # Asking for "same_box" with nothing left empties the crate — and says so.
    other = _Site(client, admin_token)
    _report(
        client, admin_token, other.project_id, other.task["id"],
        [{"item": "Wago 221-415", "qty": "10", "task_material_id": other.line["id"]}],
    )
    emptied = _complete(client, admin_token, other.task["id"], {"disposition": "same_box"})
    assert emptied["material_settlement"]["disposition"] == "shelf"
    assert emptied["material_settlement"]["remainder_box_id"] is None

    # A crate carried out without booking the handover says that too.
    packed = _pack_site(client, admin_token)
    retro = _complete(client, admin_token, packed.task["id"], {"disposition": "shelf"})
    assert retro["material_settlement"]["handover_booked"] is True


def test_a_completion_without_a_crate_carries_no_settlement(
    client: TestClient, admin_token: str
):
    customer_id = _customer(client, admin_token, "Kunde Ohne Abrechnung")
    project_id = _project(client, admin_token, "Ohne Abrechnung", customer_id)
    task = _task(client, admin_token, customer_id=customer_id, project_id=project_id)
    done = _complete(client, admin_token, task["id"], None)
    assert done["material_settlement"] is None
