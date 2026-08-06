"""Linking a task to a real construction box.

Covers the three things most likely to break silently:
  * the legacy ``storage_box_number`` column keeps working untouched, and is
    mirrored (not replaced) when a rack box is linked,
  * the customer-mismatch rule holds on BOTH task-create paths,
  * picking a box on a task never moves warehouse stock.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _customer(client: TestClient, admin_token: str, name: str) -> int:
    resp = client.post("/api/customers", headers=auth_headers(admin_token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


_project_counter = iter(range(2000, 9999))


def _project(client: TestClient, admin_token: str, name: str, customer_id: int | None) -> int:
    payload: dict = {
        "project_number": f"2026-{next(_project_counter)}",
        "name": name,
        "description": "",
        "status": "active",
    }
    if customer_id is not None:
        payload["customer_id"] = customer_id
    resp = client.post("/api/projects", headers=auth_headers(admin_token), json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _box(client: TestClient, admin_token: str, label: str) -> dict:
    resp = client.post(
        "/api/werkstatt/boxes", headers=auth_headers(admin_token), json={"label": label}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _assign_box(client: TestClient, admin_token: str, box_id: int, customer_id: int) -> dict:
    resp = client.post(
        f"/api/werkstatt/boxes/{box_id}/assign",
        headers=auth_headers(admin_token),
        json={"customer_id": customer_id},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _rack(client: TestClient, admin_token: str) -> list[dict]:
    """Seed + return the eight permanent boxes."""
    resp = client.get("/api/werkstatt/boxes", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    return [row for row in resp.json() if row["slot"] is not None]


def _create_task(client: TestClient, admin_token: str, **payload):
    body = {"title": "Kistenaufgabe", **payload}
    return client.post("/api/tasks", headers=auth_headers(admin_token), json=body)


def test_task_create_links_box_and_serialises_it(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Kisten Kunde")
    box = _box(client, admin_token, "Kiste Auftrag 42")

    created = _create_task(
        client, admin_token, customer_id=customer_id, construction_box_id=box["id"]
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["construction_box_id"] == box["id"]
    assert body["construction_box_number"] == box["box_number"]
    assert body["construction_box_label"] == "Kiste Auftrag 42"
    assert body["construction_box_status"] == "offen"
    # Ad-hoc boxes have no rack slot, so the legacy mirror stays empty.
    assert body["storage_box_number"] is None

    listed = client.get(
        f"/api/tasks?customer_id={customer_id}", headers=auth_headers(admin_token)
    ).json()
    row = next(t for t in listed if t["id"] == body["id"])
    assert row["construction_box_number"] == box["box_number"]


def test_linking_a_rack_box_mirrors_its_slot_into_the_legacy_column(
    client: TestClient, admin_token: str
):
    """The happy coincidence: rack slots 1..8 are what the typed numbers meant."""
    customer_id = _customer(client, admin_token, "Regal Kunde")
    k3 = next(box for box in _rack(client, admin_token) if box["slot"] == 3)

    created = _create_task(
        client, admin_token, customer_id=customer_id, construction_box_id=k3["id"]
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["construction_box_number"] == "K3"
    # Every existing reader of storage_box_number keeps working, unchanged.
    assert body["storage_box_number"] == 3


def test_free_rack_box_is_linkable_by_any_customer(client: TestClient, admin_token: str):
    """A box still in the rack has no owner, so nobody's claim conflicts."""
    for name in ("Kunde Eins", "Kunde Zwei"):
        customer_id = _customer(client, admin_token, name)
        k1 = next(box for box in _rack(client, admin_token) if box["slot"] == 1)
        created = _create_task(
            client, admin_token, customer_id=customer_id, construction_box_id=k1["id"]
        )
        assert created.status_code == 200, created.text


def test_box_of_another_customer_is_refused(client: TestClient, admin_token: str):
    owner_id = _customer(client, admin_token, "Eigentümer")
    other_id = _customer(client, admin_token, "Fremder")
    box = _box(client, admin_token, "Kiste Eigentümer")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Klemme", "quantity": 1},
    )
    _assign_box(client, admin_token, box["id"], owner_id)

    refused = _create_task(
        client, admin_token, customer_id=other_id, construction_box_id=box["id"]
    )
    assert refused.status_code == 400
    assert "belongs to a different customer" in refused.json()["detail"]

    # The rightful owner may still link it.
    allowed = _create_task(
        client, admin_token, customer_id=owner_id, construction_box_id=box["id"]
    )
    assert allowed.status_code == 200, allowed.text


def test_unknown_box_returns_400(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Kunde 404")
    resp = _create_task(
        client, admin_token, customer_id=customer_id, construction_box_id=999999
    )
    assert resp.status_code == 400
    assert "Unknown construction box id: 999999" in resp.json()["detail"]


def test_project_only_task_resolves_its_customer_through_the_project(
    client: TestClient, admin_token: str
):
    owner_id = _customer(client, admin_token, "Projekt Kunde")
    other_id = _customer(client, admin_token, "Anderer Kunde")
    owned_project = _project(client, admin_token, "Projekt A", owner_id)
    other_project = _project(client, admin_token, "Projekt B", other_id)

    box = _box(client, admin_token, "Kiste Projektkunde")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Dose", "quantity": 1},
    )
    _assign_box(client, admin_token, box["id"], owner_id)

    ok = _create_task(
        client, admin_token, project_id=owned_project, construction_box_id=box["id"]
    )
    assert ok.status_code == 200, ok.text

    refused = _create_task(
        client, admin_token, project_id=other_project, construction_box_id=box["id"]
    )
    assert refused.status_code == 400


def test_project_without_a_customer_can_link_any_box(client: TestClient, admin_token: str):
    """Legacy projects carry a free-text customer name and no customer_id.

    With no resolvable anchor customer there is nothing to contradict, so the
    link is allowed rather than blocked — otherwise the picker would be dead on
    every legacy project.
    """
    owner_id = _customer(client, admin_token, "Irgendein Kunde")
    anonymous_project = _project(client, admin_token, "Projekt ohne Kunde", None)
    box = _box(client, admin_token, "Kiste fremd")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Kabel", "quantity": 1},
    )
    _assign_box(client, admin_token, box["id"], owner_id)

    resp = _create_task(
        client, admin_token, project_id=anonymous_project, construction_box_id=box["id"]
    )
    assert resp.status_code == 200, resp.text


def test_patch_sets_and_clears_the_link(client: TestClient, admin_token: str):
    customer_id = _customer(client, admin_token, "Patch Kunde")
    task_id = _create_task(client, admin_token, customer_id=customer_id).json()["id"]
    k5 = next(box for box in _rack(client, admin_token) if box["slot"] == 5)

    linked = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"construction_box_id": k5["id"]},
    )
    assert linked.status_code == 200, linked.text
    assert linked.json()["construction_box_id"] == k5["id"]
    assert linked.json()["storage_box_number"] == 5

    cleared = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"construction_box_id": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["construction_box_id"] is None
    # The mirror is cleared with it — a stale rack number would be worse than none.
    assert cleared.json()["storage_box_number"] is None


def test_linking_an_ad_hoc_box_clears_a_stale_legacy_number(
    client: TestClient, admin_token: str
):
    customer_id = _customer(client, admin_token, "Altlast Kunde")
    task_id = _create_task(
        client, admin_token, customer_id=customer_id, storage_box_number=7
    ).json()["id"]
    box = _box(client, admin_token, "Sonderkiste")

    patched = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"construction_box_id": box["id"]},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["construction_box_id"] == box["id"]
    assert patched.json()["storage_box_number"] is None


def test_legacy_storage_box_number_still_works_untouched(client: TestClient, admin_token: str):
    """The old free-typed field must keep accepting values outside 1..8."""
    customer_id = _customer(client, admin_token, "Legacy Kunde")
    created = _create_task(client, admin_token, customer_id=customer_id, storage_box_number=7)
    assert created.status_code == 200, created.text
    assert created.json()["storage_box_number"] == 7
    assert created.json()["construction_box_id"] is None

    patched = client.patch(
        f"/api/tasks/{created.json()['id']}",
        headers=auth_headers(admin_token),
        json={"storage_box_number": 9},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["storage_box_number"] == 9


def test_selecting_a_box_on_a_task_moves_no_stock(client: TestClient, admin_token: str):
    """The load-bearing test.

    Wiring the picker to the box's assign endpoint would decrement warehouse
    stock every time an office user saved a task. Linking is a pure
    association; handover stays a deliberate Werkstatt action.
    """
    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle, WerkstattMovement
    from app.services.werkstatt_movements import apply_movement

    article = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Kiste Stock Artikel", "unit": "Stk"},
    ).json()
    with SessionLocal() as db:
        import sqlalchemy

        admin = db.scalars(
            sqlalchemy.select(User).where(User.email == "admin@example.com")
        ).first()
        apply_movement(
            db,
            article=db.get(WerkstattArticle, article["id"]),
            movement_type="intake",
            quantity=40,
            user_id=admin.id,
            notes="test-intake",
        )
        db.commit()

    customer_id = _customer(client, admin_token, "Bestand Kunde")
    box = _box(client, admin_token, "Kiste Bestand")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"article_id": article["id"], "quantity": 6},
    )

    def snapshot() -> tuple[int, int, str]:
        stock = client.get(
            f"/api/werkstatt/articles/{article['id']}", headers=auth_headers(admin_token)
        ).json()["stock_available"]
        status = client.get(
            f"/api/werkstatt/boxes/{box['id']}", headers=auth_headers(admin_token)
        ).json()["status"]
        with SessionLocal() as db:
            import sqlalchemy

            movements = db.scalar(
                sqlalchemy.select(sqlalchemy.func.count(WerkstattMovement.id))
            )
        return stock, int(movements or 0), status

    before = snapshot()

    task_id = _create_task(
        client, admin_token, customer_id=customer_id, construction_box_id=box["id"]
    ).json()["id"]
    assert snapshot() == before, "creating a task with a box must not move stock"

    client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"construction_box_id": None},
    )
    assert snapshot() == before, "unlinking a box must not move stock"


def test_planning_week_path_enforces_the_same_rule(client: TestClient, admin_token: str):
    """POST /planning/week builds Tasks from the same schema — same guard."""
    owner_id = _customer(client, admin_token, "Planung Eigentümer")
    other_id = _customer(client, admin_token, "Planung Fremd")
    other_project = _project(client, admin_token, "Planung Projekt", other_id)
    box = _box(client, admin_token, "Kiste Planung")
    client.post(
        f"/api/werkstatt/boxes/{box['id']}/items",
        headers=auth_headers(admin_token),
        json={"item_name": "Werkzeug", "quantity": 1},
    )
    _assign_box(client, admin_token, box["id"], owner_id)

    resp = client.post(
        "/api/planning/week/2026-08-10",
        headers=auth_headers(admin_token),
        json=[
            {
                "title": "Planungsaufgabe",
                "project_id": other_project,
                "construction_box_id": box["id"],
                "due_date": "2026-08-11",
            }
        ],
    )
    assert resp.status_code == 400, resp.text
    assert "belongs to a different customer" in str(resp.json()["detail"])
