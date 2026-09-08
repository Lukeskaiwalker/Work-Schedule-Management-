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
