"""The desk "Entnehmen" and the phone checkout — ``POST /api/werkstatt/mobile/checkout``.

Owner, 2026-10-10: "any item that is not inside the machine tab is a
consumable, when we scan it we book it out of the inventory and it is
installed at a work site". The desk and the phone book through the same rule
as the Regal station (``services/werkstatt_consumption.py``):

* a consumable (``is_serialized`` False) leaves the stock as ``consumption``
  with the person who took it and, when chosen, the project — never as a
  ``checkout`` loan that waits for a return that never comes;
* a short shelf is not refused: the shortfall is topped up first and the
  answer carries a German ``stock_warning``;
* the project is checked: unknown, archived and one the caller cannot open
  answer one sentence — naming a project writes onto its Material tab;
* a machine type (``is_serialized`` True) is still lent, exactly as before;
* the answer stays the article snapshot it always was, plus ``booked_as`` and
  ``stock_warning``.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import Project, User, WerkstattArticle, WerkstattMovement
from tests.conftest import auth_headers
from tests.test_schaltplan import _customer, _project
from tests.test_schaltplan_material import _article

CHECKOUT = "/api/werkstatt/mobile/checkout"


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _user(client: TestClient, admin_token: str, email: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={"email": email, "password": "Password123!", "full_name": "Max Monteur", "role": "employee"},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return int(created.json()["id"]), login.headers["X-Access-Token"]


def _admin_id() -> int:
    with SessionLocal() as db:
        return int(db.scalars(select(User.id).where(User.email == "admin@example.com")).one())


def _rows(article_id: int) -> list[WerkstattMovement]:
    with SessionLocal() as db:
        rows = list(
            db.scalars(
                select(WerkstattMovement)
                .where(WerkstattMovement.article_id == article_id)
                .order_by(WerkstattMovement.id)
            )
        )
        db.expunge_all()
        return rows


def _make_machine_type(article_id: int) -> None:
    with SessionLocal() as db:
        db.get(WerkstattArticle, article_id).is_serialized = True
        db.commit()


def _archive(project_id: int) -> None:
    with SessionLocal() as db:
        db.get(Project, project_id).status = "archived"
        db.commit()


# ── consumables ───────────────────────────────────────────────────────────────


def test_a_consumable_leaves_the_stock_for_the_project(client: TestClient, admin_token: str) -> None:
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=10)
    project_id = _project(client, admin_token, _customer(client, admin_token), number="381")

    booked = client.post(
        CHECKOUT,
        headers=_auth(admin_token),
        json={"article_id": ties["id"], "quantity": 3, "project_id": project_id, "notes": "Theke"},
    )
    assert booked.status_code == 200, booked.text
    body = booked.json()
    assert body["booked_as"] == "consumption"
    assert body["stock_warning"] is None
    # Out of the inventory for good: the total goes down, nothing is "out".
    assert (body["stock_total"], body["stock_available"], body["stock_out"]) == (7, 7, 0)

    row = _rows(ties["id"])[-1]
    admin = _admin_id()
    assert (row.movement_type, row.quantity, row.project_id) == ("consumption", 3, project_id)
    assert (row.user_id, row.assignee_user_id) == (admin, admin)
    assert row.panel_id is None and row.unit_id is None and row.station_id is None
    assert row.notes == "Theke"
    # Not a loan: nothing waits on "Meine Entnahmen" for a return.
    assert client.get("/api/werkstatt/mobile/my-checkouts", headers=_auth(admin_token)).json() == []


def test_a_consumable_without_a_project_is_booked_to_the_person(client: TestClient, admin_token: str) -> None:
    ferrules = _article(client, admin_token, "Aderendhülsen 1,5 mm²", stock=50)
    monteur_id, _ = _user(client, admin_token, "max@example.com")

    booked = client.post(
        CHECKOUT,
        headers=_auth(admin_token),
        json={"article_id": ferrules["id"], "quantity": 20, "assignee_user_id": monteur_id},
    )
    assert booked.status_code == 200, booked.text
    assert booked.json()["booked_as"] == "consumption"

    row = _rows(ferrules["id"])[-1]
    assert (row.movement_type, row.project_id) == ("consumption", None)
    assert row.assignee_user_id == monteur_id, "the person who took it"
    assert row.user_id == _admin_id(), "who booked it stays the caller"


def test_a_consumable_ignores_the_return_date(client: TestClient, admin_token: str) -> None:
    tape = _article(client, admin_token, "Isolierband schwarz", stock=4)
    booked = client.post(
        CHECKOUT,
        headers=_auth(admin_token),
        json={"article_id": tape["id"], "quantity": 1, "expected_return_at": "2026-10-20T08:00:00Z"},
    )
    assert booked.status_code == 200, booked.text
    assert _rows(tape["id"])[-1].expected_return_at is None


def test_a_short_shelf_is_topped_up_and_said_so(client: TestClient, admin_token: str) -> None:
    wago = _article(client, admin_token, "WAGO 221-413", stock=1)

    booked = client.post(CHECKOUT, headers=_auth(admin_token), json={"article_id": wago["id"], "quantity": 4})
    assert booked.status_code == 200, booked.text
    body = booked.json()
    assert body["booked_as"] == "consumption"
    assert body["stock_warning"] and "3" in body["stock_warning"]
    assert "Bestand" in body["stock_warning"]
    # Never negative: the ledger and the snapshot agree at zero.
    assert (body["stock_total"], body["stock_available"]) == (0, 0)
    assert [(row.movement_type, row.quantity) for row in _rows(wago["id"])] == [
        ("intake", 1),
        ("inventory_plus", 3),
        ("consumption", 4),
    ]


def test_a_consumable_on_nothing_at_all_is_booked_too(client: TestClient, admin_token: str) -> None:
    """Added without a Startbestand — the case the loan path always refused."""
    new = _article(client, admin_token, "Schrumpfschlauch 6 mm")
    booked = client.post(CHECKOUT, headers=_auth(admin_token), json={"article_id": new["id"], "quantity": 2})
    assert booked.status_code == 200, booked.text
    assert booked.json()["stock_warning"]
    assert [row.movement_type for row in _rows(new["id"])] == ["inventory_plus", "consumption"]


def test_an_unknown_or_archived_project_is_refused_with_one_sentence(
    client: TestClient, admin_token: str
) -> None:
    ties = _article(client, admin_token, "Kabelbinder 300 mm", stock=10)
    closed = _project(client, admin_token, _customer(client, admin_token), number="370")
    _archive(closed)

    answers = [
        client.post(
            CHECKOUT,
            headers=_auth(admin_token),
            json={"article_id": ties["id"], "quantity": 1, "project_id": project_id},
        )
        for project_id in (closed, 999_999)
    ]
    assert [answer.status_code for answer in answers] == [400, 400]
    assert [answer.json()["detail"] for answer in answers] == ["Projekt nicht verfügbar."] * 2
    assert [row.movement_type for row in _rows(ties["id"])] == ["intake"], "nothing was booked"


def _shut_out(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    # Everyone is on every project by default, so "no access" is made on
    # purpose — the same way test_project_report hides a project.
    removed = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert removed.status_code in (200, 204), removed.text


def test_a_project_the_caller_cannot_open_is_refused_like_an_unknown_one(
    client: TestClient, admin_token: str
) -> None:
    """A consumption lands on the project's Material tab ("Lager (Entnahme)")
    and a loan in its ledger bucket, so naming a project is writing to it.
    Somebody shut out of a project must not plant material on it from the
    phone — and must not learn that the id exists either."""
    monteur_id, monteur_token = _user(client, admin_token, "aussen@example.com")
    customer = _customer(client, admin_token)
    hidden = _project(client, admin_token, customer, number="383")
    own = _project(client, admin_token, customer, number="384")
    _shut_out(client, admin_token, hidden, monteur_id)
    ties = _article(client, admin_token, "Kabelbinder 250 mm", stock=10)
    drill = _article(client, admin_token, "Bohrhammer GBH 2-26", stock=2)
    _make_machine_type(drill["id"])

    answers = [
        client.post(
            CHECKOUT,
            headers=_auth(monteur_token),
            json={"article_id": article_id, "quantity": 1, "project_id": project_id},
        )
        for article_id in (ties["id"], drill["id"])
        for project_id in (hidden, 999_999)
    ]
    assert [answer.status_code for answer in answers] == [400] * 4, [answer.text for answer in answers]
    assert {answer.json()["detail"] for answer in answers} == {"Projekt nicht verfügbar."}
    assert [row.movement_type for row in _rows(ties["id"])] == ["intake"], "nothing was booked"
    assert [row.movement_type for row in _rows(drill["id"])] == ["intake"], "nothing was lent"

    # Their own project still takes it.
    booked = client.post(
        CHECKOUT,
        headers=_auth(monteur_token),
        json={"article_id": ties["id"], "quantity": 1, "project_id": own},
    )
    assert booked.status_code == 200, booked.text
    assert (_rows(ties["id"])[-1].movement_type, _rows(ties["id"])[-1].project_id) == ("consumption", own)


def test_ids_outside_the_id_range_are_a_422_not_a_500(client: TestClient, admin_token: str) -> None:
    """``db.get`` with an id wider than the column is an OverflowError on
    SQLite and a DataError on PostgreSQL — an unhandled 500."""
    ties = _article(client, admin_token, "Kabelbinder 280 mm", stock=10)
    answers = [
        client.post(CHECKOUT, headers=_auth(admin_token), json={"article_id": ties["id"], "quantity": 1, field: value})
        for field in ("project_id", "assignee_user_id")
        for value in (2**31, 10**20, 0)
    ]
    assert [answer.status_code for answer in answers] == [422] * 6, [answer.text for answer in answers]
    assert [row.movement_type for row in _rows(ties["id"])] == ["intake"]


def test_on_behalf_of_books_the_consumption_for_that_person(client: TestClient, admin_token: str) -> None:
    monteur_id, _ = _user(client, admin_token, "fuer@example.com")
    ties = _article(client, admin_token, "Kabelbinder 100 mm", stock=10)

    booked = client.post(
        CHECKOUT,
        params={"on_behalf_of": monteur_id},
        headers=_auth(admin_token),
        json={"article_id": ties["id"], "quantity": 2},
    )
    assert booked.status_code == 200, booked.text
    row = _rows(ties["id"])[-1]
    assert (row.movement_type, row.user_id, row.assignee_user_id) == ("consumption", monteur_id, monteur_id)


def test_an_unknown_person_is_still_refused(client: TestClient, admin_token: str) -> None:
    ties = _article(client, admin_token, "Kabelbinder 140 mm", stock=10)
    refused = client.post(
        CHECKOUT,
        headers=_auth(admin_token),
        json={"article_id": ties["id"], "quantity": 1, "assignee_user_id": 999_999},
    )
    assert refused.status_code == 404, refused.text
    assert [row.movement_type for row in _rows(ties["id"])] == ["intake"]


def test_an_employee_books_a_consumable_for_themselves(client: TestClient, admin_token: str) -> None:
    monteur_id, monteur_token = _user(client, admin_token, "selbst@example.com")
    ties = _article(client, admin_token, "Kabelbinder 360 mm", stock=10)
    booked = client.post(CHECKOUT, headers=_auth(monteur_token), json={"article_id": ties["id"], "quantity": 1})
    assert booked.status_code == 200, booked.text
    row = _rows(ties["id"])[-1]
    assert (row.movement_type, row.user_id, row.assignee_user_id) == ("consumption", monteur_id, monteur_id)



def test_a_quantity_past_the_bound_is_refused_before_anything_is_booked(
    client: TestClient, admin_token: str
) -> None:
    """A short shelf is topped up instead of refused, so the stock no longer
    bounds a consumable — the loan path's ``quantity > stock_available`` guard
    used to. Unbounded, 10**20 reached ``db.flush()`` as an ``inventory_plus``
    and came back as an OverflowError/DataError: an unhandled 500. The wire
    carries the station's bound instead (``STATION_MAX_QUANTITY``)."""
    ties = _article(client, admin_token, "Kabelbinder 500 mm", stock=10)

    answers = [
        client.post(CHECKOUT, headers=_auth(admin_token), json={"article_id": ties["id"], "quantity": quantity})
        for quantity in (10_001, 10**20)
    ]
    assert [answer.status_code for answer in answers] == [422, 422], [answer.text for answer in answers]
    assert [row.movement_type for row in _rows(ties["id"])] == ["intake"], "nothing was booked"


def test_the_bound_itself_is_still_booked(client: TestClient, admin_token: str) -> None:
    ties = _article(client, admin_token, "Kabelbinder 750 mm")
    booked = client.post(CHECKOUT, headers=_auth(admin_token), json={"article_id": ties["id"], "quantity": 10_000})
    assert booked.status_code == 200, booked.text
    assert [(row.movement_type, row.quantity) for row in _rows(ties["id"])] == [
        ("inventory_plus", 10_000),
        ("consumption", 10_000),
    ]


# ── machine types: unchanged loan ─────────────────────────────────────────────


def test_a_machine_type_is_still_lent(client: TestClient, admin_token: str) -> None:
    drill = _article(client, admin_token, "Bohrhammer GBH 2-28", stock=2)
    _make_machine_type(drill["id"])
    project_id = _project(client, admin_token, _customer(client, admin_token), number="382")

    booked = client.post(
        CHECKOUT,
        headers=_auth(admin_token),
        json={
            "article_id": drill["id"],
            "quantity": 1,
            "project_id": project_id,
            "expected_return_at": "2026-10-20T08:00:00Z",
        },
    )
    assert booked.status_code == 200, booked.text
    body = booked.json()
    assert (body["booked_as"], body["stock_warning"]) == ("checkout", None)
    assert (body["stock_total"], body["stock_available"], body["stock_out"]) == (2, 1, 1)
    row = _rows(drill["id"])[-1]
    assert (row.movement_type, row.project_id) == ("checkout", project_id)
    assert row.expected_return_at is not None
    loans = client.get("/api/werkstatt/mobile/my-checkouts", headers=_auth(admin_token)).json()
    assert [(loan["article_id"], loan["quantity_out"]) for loan in loans] == [(drill["id"], 1)]


def test_a_machine_type_beyond_the_shelf_is_still_refused(client: TestClient, admin_token: str) -> None:
    drill = _article(client, admin_token, "Bohrhammer GBH 5-40", stock=1)
    _make_machine_type(drill["id"])
    refused = client.post(CHECKOUT, headers=_auth(admin_token), json={"article_id": drill["id"], "quantity": 2})
    assert refused.status_code == 400, refused.text
    assert [row.movement_type for row in _rows(drill["id"])] == ["intake"]


# ── the answer stays what it was ──────────────────────────────────────────────


def test_the_answer_is_still_the_full_article_snapshot(client: TestClient, admin_token: str) -> None:
    ties = _article(client, admin_token, "Kabelbinder 450 mm", stock=3)
    snapshot = client.get(f"/api/werkstatt/articles/{ties['id']}", headers=_auth(admin_token)).json()
    booked = client.post(CHECKOUT, headers=_auth(admin_token), json={"article_id": ties["id"], "quantity": 1})
    assert booked.status_code == 200, booked.text
    body = booked.json()
    for key in (
        "id", "article_number", "item_name", "unit", "stock_total", "stock_available", "stock_out",
        "stock_repair", "stock_status", "is_serialized", "is_archived", "suppliers",
    ):
        assert key in body, key
    assert body["id"] == snapshot["id"] and body["article_number"] == snapshot["article_number"]
    assert {"booked_as", "stock_warning"} <= set(body)
