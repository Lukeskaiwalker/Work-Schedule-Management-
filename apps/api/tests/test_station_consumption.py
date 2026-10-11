"""POST /api/station/werkstatt/consumptions (+ /undo) — consumables at the rack.

Owner, 2026-10-10: "'Waren Ausgabe' only works for tools never for
consumables, any item that is not inside the machine tab is a consumable, when
we scan it we book it out of the inventory and it is installed at a work
site."

So a consumable taken at the wall is a ``consumption`` — gone for good, with
the person who took it and, when one was picked, the project it went into —
never a ``checkout`` loan waiting forever for a return. The rule itself lives
in ``services/werkstatt_consumption.py`` (shared with the desk and the phone);
what is pinned here is the station's boundary around it:

  * a person is required, and it must be somebody the crew list offers —
    unknown, inactive and partner logins are one sentence;
  * a project is optional; unknown and archived are one sentence;
  * a machine type and an archived article are refused in German;
  * a short shelf is not refused: the shortfall is booked first and the answer
    says so;
  * every row names the station's acting user, carries ``station_id`` and the
    "Regal-Station" note prefix;
  * a retry carrying the same ``request_id`` replays, it never books twice —
    also when two attempts race past the first lookup;
  * taking back is bounded by the (article, project) bucket; with
    ``pick_project`` the server picks the bucket the person most recently
    booked into;
  * a Rückgabe at the rack first closes what is really out: the person's own
    consumption (their own net, and only up to it — a cancelled booking or a
    colleague's pieces in the same project are not their leftovers), else
    their own old loan (a consumable lent before 2026-10-10), else — with
    nobody named — the loan the station infers, else anybody's consumption,
    else a German "nothing to take back";
  * ABBRUCH of a consumption that topped up a short shelf takes the top-up
    back too, once;
  * a user token opens none of it.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.db import SessionLocal
from app.models.entities import Project, Station, User, WerkstattArticle, WerkstattMovement
from app.routers import workflow_station_consumption
from app.services.werkstatt_consumption import ARTICLE_ARCHIVED, MACHINE_NOT_CONSUMABLE, net_consumed
from app.services.werkstatt_movements import apply_movement, list_my_checkouts
from tests.test_station_werkstatt import BASE, _article, _make_user, _pair, auth_headers

PERSON_UNKNOWN = "Unbekannte Person."
PROJECT_UNAVAILABLE = "Projekt nicht verfügbar."
NOTHING_TO_TAKE_BACK = "Kein Verbrauch dieses Artikels zum Zurücknehmen."


@pytest.fixture
def station(client: TestClient, admin_token: str) -> dict:
    token, row = _pair(client, admin_token, name="Werkstatt Pi")
    return {"token": token, "id": row["id"], "name": row["name"]}


def _project(number: str, *, name: str | None = None, status: str = "in_durchfuehrung") -> int:
    with SessionLocal() as db:
        row = Project(project_number=number, name=name or f"Projekt {number}", status=status)
        db.add(row)
        db.commit()
        return row.id


def _consume(client: TestClient, station: dict, **payload):
    return client.post(f"{BASE}/consumptions", headers=auth_headers(station["token"]), json=payload)


def _undo(client: TestClient, station: dict, **payload):
    return client.post(f"{BASE}/consumptions/undo", headers=auth_headers(station["token"]), json=payload)


def _rows(article_id: int) -> list[WerkstattMovement]:
    with SessionLocal() as db:
        return list(
            db.scalars(
                select(WerkstattMovement)
                .where(WerkstattMovement.article_id == article_id)
                .order_by(WerkstattMovement.id.asc())
            ).all()
        )


def _types(article_id: int) -> list[tuple[str, int, int | None]]:
    return [(row.movement_type, row.quantity, row.project_id) for row in _rows(article_id)]


def _user(user_id: int) -> User:
    with SessionLocal() as db:
        row = db.get(User, user_id)
        db.expunge(row)
        return row


def _admin_id() -> int:
    with SessionLocal() as db:
        return db.scalars(select(User.id).where(User.email == "admin@example.com")).one()


def _stock(article_id: int) -> tuple[int, int, int]:
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article_id)
        return int(row.stock_total), int(row.stock_available), int(row.stock_out)


# --------------------------------------------------------------------------
# booking
# --------------------------------------------------------------------------


def test_a_consumable_leaves_the_stock_for_good_with_person_and_project(
    client: TestClient, admin_token: str, station: dict
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=5)
    project = _project("381", name="Neubau Schulze")

    resp = _consume(
        client, station,
        article_id=ties["id"], quantity=3, assignee_user_id=max_["id"], project_id=project, request_id="req-1",
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {
        "movement_id", "booked_as", "quantity", "article", "assignee", "project",
        "stock_warning", "topped_up", "reversed_top_up", "replayed",
    }
    assert body["booked_as"] == "consumption"
    assert body["quantity"] == 3
    assert body["assignee"] == {"id": max_["id"], "display_name": _user(max_["id"]).display_name}
    assert body["project"] == {"id": project, "project_number": "381", "name": "Neubau Schulze"}
    assert (body["stock_warning"], body["topped_up"], body["replayed"]) == (None, 0, False)
    # Gone for good: total and available both drop, nothing is "out" on loan.
    article = body["article"]
    assert article["id"] == ties["id"]
    assert (article["stock_total"], article["stock_available"], article["stock_out"]) == (2, 2, 0)

    row = _rows(ties["id"])[-1]
    assert row.id == body["movement_id"]
    assert (row.movement_type, row.quantity, row.project_id, row.assignee_user_id) == (
        "consumption", 3, project, max_["id"],
    )
    # Booked like every other station write: the acting user, the station,
    # the note prefix nobody can remove.
    assert row.user_id == _admin_id()
    assert row.station_id == station["id"]
    assert row.notes == "Regal-Station Werkstatt Pi — Verbrauch für 381"
    assert row.client_request_id == "req-1"
    assert row.panel_id is None and row.unit_id is None


def test_without_a_project_the_booking_is_still_a_consumption(
    client: TestClient, admin_token: str, station: dict
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 300 mm", stock=5)

    resp = _consume(
        client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], notes="für die Werkstatt",
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["project"] is None
    row = _rows(ties["id"])[-1]
    assert (row.movement_type, row.project_id) == ("consumption", None)
    assert row.notes == "Regal-Station Werkstatt Pi — Verbrauch — für die Werkstatt"


def test_a_consumption_needs_a_person(client: TestClient, admin_token: str, station: dict) -> None:
    """The name rule used to live only on the Pi. A nameless consumption would
    be charged to the administrator who approved the station."""
    ties = _article(client, admin_token, "Kabelbinder 100 mm", stock=5)

    missing = _consume(client, station, article_id=ties["id"], quantity=1)
    null = _consume(client, station, article_id=ties["id"], quantity=1, assignee_user_id=None)

    assert missing.status_code == 422, missing.text
    assert null.status_code == 422, null.text
    assert _types(ties["id"]) == [("intake", 5, None)]


def test_an_unknown_an_inactive_and_a_partner_person_are_one_sentence(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Only somebody the crew list offers — and the answer must not say which
    ids exist."""
    gone = _make_user(client, admin_token, "weg@example.com", "employee")
    assert client.delete(f"/api/admin/users/{gone['id']}", headers=auth_headers(admin_token)).status_code == 200
    partner = _make_user(client, admin_token, "partner@example.com", "employee")
    with SessionLocal() as db:
        db.get(User, partner["id"]).role = "external"
        db.commit()
    ties = _article(client, admin_token, "Kabelbinder 150 mm", stock=5)

    answers = [
        _consume(client, station, article_id=ties["id"], quantity=1, assignee_user_id=person)
        for person in (987_654, gone["id"], partner["id"])
    ]

    assert [r.status_code for r in answers] == [400, 400, 400], [r.text for r in answers]
    assert {r.json()["detail"] for r in answers} == {PERSON_UNKNOWN}
    assert _types(ties["id"]) == [("intake", 5, None)]


def test_an_unknown_and_an_archived_project_are_one_sentence(
    client: TestClient, admin_token: str, station: dict
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 250 mm", stock=5)
    archived = _project("399", status="archived")

    answers = [
        _consume(client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], project_id=project)
        for project in (987_654, archived)
    ]

    assert [r.status_code for r in answers] == [400, 400], [r.text for r in answers]
    assert {r.json()["detail"] for r in answers} == {PROJECT_UNAVAILABLE}
    assert _types(ties["id"]) == [("intake", 5, None)]


def test_a_missing_article_is_404(client: TestClient, admin_token: str, station: dict) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    resp = _consume(client, station, article_id=987_654, quantity=1, assignee_user_id=max_["id"])
    assert resp.status_code == 404, resp.text


def test_a_machine_type_and_an_archived_article_are_refused_in_german(
    client: TestClient, admin_token: str, station: dict
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    drill = _article(client, admin_token, "Bohrhammer", stock=2)
    old = _article(client, admin_token, "Alte Klemme", stock=2)
    with SessionLocal() as db:
        db.get(WerkstattArticle, drill["id"]).is_serialized = True
        db.commit()
    assert client.delete(f"/api/werkstatt/articles/{old['id']}", headers=auth_headers(admin_token)).status_code == 200

    machine = _consume(client, station, article_id=drill["id"], quantity=1, assignee_user_id=max_["id"])
    archived = _consume(client, station, article_id=old["id"], quantity=1, assignee_user_id=max_["id"])

    assert (machine.status_code, machine.json()["detail"]) == (400, MACHINE_NOT_CONSUMABLE)
    assert (archived.status_code, archived.json()["detail"]) == (400, ARTICLE_ARCHIVED)
    assert _types(drill["id"]) == [("intake", 2, None)]
    assert [t for t, _, _ in _types(old["id"])] == ["intake"]


def test_a_short_shelf_is_topped_up_and_the_answer_says_so(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """The person is holding the parts, so the count was wrong — refusing would
    only send them away; booking past the count would leave a hole in the
    ledger that swallows the next delivery."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ferrules = _article(client, admin_token, "Aderendhülsen 1,5 mm²", stock=1)

    resp = _consume(client, station, article_id=ferrules["id"], quantity=3, assignee_user_id=max_["id"])

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["topped_up"] == 2
    assert body["stock_warning"] and "nur 1" in body["stock_warning"]
    assert (body["article"]["stock_total"], body["article"]["stock_available"]) == (0, 0)
    rows = _rows(ferrules["id"])
    assert [(r.movement_type, r.quantity) for r in rows] == [("intake", 1), ("inventory_plus", 2), ("consumption", 3)]
    # The top-up is the station's row too.
    assert rows[1].station_id == station["id"]


def test_the_quantity_is_bounded(client: TestClient, admin_token: str, station: dict) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 400 mm", stock=5)
    for quantity in (0, -1, 10_001):
        resp = _consume(client, station, article_id=ties["id"], quantity=quantity, assignee_user_id=max_["id"])
        assert resp.status_code == 422, resp.text


# --------------------------------------------------------------------------
# retries
# --------------------------------------------------------------------------


def test_a_retry_with_the_same_request_id_replays_instead_of_booking_twice(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """The Pi gives up after a few seconds and asks again; the first attempt may
    well have been committed by then."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=5)
    project = _project("381")
    payload = dict(article_id=ties["id"], quantity=2, assignee_user_id=max_["id"], project_id=project, request_id="abc-1")

    first = _consume(client, station, **payload)
    second = _consume(client, station, **payload)

    assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
    assert first.json()["replayed"] is False
    replay = second.json()
    assert replay["replayed"] is True
    assert replay["movement_id"] == first.json()["movement_id"]
    assert (replay["booked_as"], replay["quantity"]) == ("consumption", 2)
    assert replay["project"]["id"] == project
    assert replay["assignee"]["id"] == max_["id"]
    assert _types(ties["id"]) == [("intake", 5, None), ("consumption", 2, project)]
    assert _stock(ties["id"]) == (3, 3, 0)


def test_a_concurrent_duplicate_rolls_back_and_replays(
    client: TestClient, admin_token: str, station: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two attempts race: both look for the token before either committed. The
    unique column stops the second at the database; that one is rolled back
    — top-up and all — and answers with the first one's booking."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=4)
    payload = dict(article_id=ties["id"], quantity=3, assignee_user_id=max_["id"], request_id="race-1")

    first = _consume(client, station, **payload)
    assert first.status_code == 200, first.text

    real_lookup = workflow_station_consumption._movement_for_request
    misses = {"left": 1}

    def _lookup_that_misses_once(db, request_id):
        if misses["left"]:
            misses["left"] -= 1
            return None
        return real_lookup(db, request_id)

    monkeypatch.setattr(workflow_station_consumption, "_movement_for_request", _lookup_that_misses_once)
    second = _consume(client, station, **payload)

    assert second.status_code == 200, second.text
    assert second.json()["replayed"] is True
    assert second.json()["movement_id"] == first.json()["movement_id"]
    # The racing attempt's top-up (the shelf held 1 for its 3) went with it.
    assert _types(ties["id"]) == [("intake", 4, None), ("consumption", 3, None)]
    assert _stock(ties["id"]) == (1, 1, 0)


def test_a_request_id_that_belongs_to_another_booking_is_refused(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """A token names ONE booking attempt. Replaying a different article's
    booking as if it were this one would tell the wall a lie."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=5)
    tape = _article(client, admin_token, "Isolierband", stock=5)
    assert _consume(client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], request_id="t-1").status_code == 200

    other = _consume(client, station, article_id=tape["id"], quantity=1, assignee_user_id=max_["id"], request_id="t-1")
    undo = _undo(client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], request_id="t-1")

    assert other.status_code == 409, other.text
    assert undo.status_code == 409, undo.text
    assert _types(tape["id"]) == [("intake", 5, None)]
    assert _types(ties["id"]) == [("intake", 5, None), ("consumption", 1, None)]


# --------------------------------------------------------------------------
# taking back
# --------------------------------------------------------------------------


def test_undo_takes_back_from_exactly_the_named_bucket(
    client: TestClient, admin_token: str, station: dict
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    duct = _article(client, admin_token, "Verdrahtungskanal 40x60", stock=10)
    project = _project("381", name="Neubau Schulze")
    assert _consume(client, station, article_id=duct["id"], quantity=3, assignee_user_id=max_["id"], project_id=project).status_code == 200
    assert _consume(client, station, article_id=duct["id"], quantity=2, assignee_user_id=max_["id"]).status_code == 200

    back = _undo(client, station, article_id=duct["id"], quantity=2, assignee_user_id=max_["id"], project_id=project)

    assert back.status_code == 200, back.text
    body = back.json()
    assert body["booked_as"] == "consumption_undo"
    assert body["quantity"] == 2
    assert body["project"] == {"id": project, "project_number": "381", "name": "Neubau Schulze"}
    assert body["assignee"]["id"] == max_["id"]
    assert (body["stock_warning"], body["topped_up"], body["replayed"]) == (None, 0, False)
    assert body["article"]["stock_total"] == 10 - 3 - 2 + 2
    row = _rows(duct["id"])[-1]
    assert (row.movement_type, row.quantity, row.project_id, row.station_id) == (
        "consumption_undo", 2, project, station["id"],
    )
    assert row.notes == "Regal-Station Werkstatt Pi — Verbrauch zurück für 381"

    # Only 1 left for the project: 2 more is refused by the bucket.
    too_many = _undo(client, station, article_id=duct["id"], quantity=2, assignee_user_id=max_["id"], project_id=project)
    assert too_many.status_code == 400, too_many.text
    assert "1" in too_many.json()["detail"]

    # project_id null names the "without project" bucket — not "any".
    without = _undo(client, station, article_id=duct["id"], quantity=2, assignee_user_id=None, project_id=None)
    assert without.status_code == 200, without.text
    assert without.json()["project"] is None
    assert without.json()["assignee"] is None
    assert _stock(duct["id"]) == (9, 9, 0)


def test_a_rueckgabe_without_a_project_goes_back_to_the_person_s_latest_bucket(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Leftovers carried back with no project selected: the server picks the
    bucket the person most recently booked into — their own before anybody
    else's."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")
    duct = _article(client, admin_token, "Hutschiene 35 mm", stock=20)
    first = _project("381")
    second = _project("382")
    assert _consume(client, station, article_id=duct["id"], quantity=2, assignee_user_id=max_["id"], project_id=first).status_code == 200
    assert _consume(client, station, article_id=duct["id"], quantity=2, assignee_user_id=anna["id"], project_id=second).status_code == 200

    mine = _undo(client, station, article_id=duct["id"], quantity=1, assignee_user_id=max_["id"], pick_project=True)
    anyone = _undo(client, station, article_id=duct["id"], quantity=1, assignee_user_id=None, pick_project=True)

    assert mine.status_code == 200, mine.text
    assert mine.json()["project"]["id"] == first
    assert anyone.status_code == 200, anyone.text
    assert anyone.json()["project"]["id"] == second


def test_nothing_to_take_back_is_said_in_german(client: TestClient, admin_token: str, station: dict) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=5)

    picked = _undo(client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], pick_project=True)
    exact = _undo(client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], project_id=None)

    assert (picked.status_code, picked.json()["detail"]) == (400, NOTHING_TO_TAKE_BACK)
    assert exact.status_code == 400, exact.text
    assert "Zurücknehmen" in exact.json()["detail"]
    assert _types(ties["id"]) == [("intake", 5, None)]


def test_a_verteiler_scan_is_not_a_bucket_the_rack_can_take_back_from(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Parts built into a board belong to the board's own undo."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=5)
    with SessionLocal() as db:
        from app.models.entities import Customer
        from app.models.schaltplan import PanelPlan

        customer = Customer(name="Familie Schmitt")
        db.add(customer)
        db.flush()
        plan = PanelPlan(panel_number="VT-0001", customer_id=customer.id, name="UV", designation="UV1")
        db.add(plan)
        db.flush()
        db.add(
            WerkstattMovement(
                article_id=ties["id"], movement_type="consumption", quantity=2, user_id=_admin_id(), panel_id=plan.id,
            )
        )
        db.commit()

    picked = _undo(client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], pick_project=True)
    assert (picked.status_code, picked.json()["detail"]) == (400, NOTHING_TO_TAKE_BACK)


def test_an_undo_retry_replays(client: TestClient, admin_token: str, station: dict) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=5)
    assert _consume(client, station, article_id=ties["id"], quantity=3, assignee_user_id=max_["id"]).status_code == 200
    payload = dict(article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], project_id=None, request_id="undo-1")

    first = _undo(client, station, **payload)
    second = _undo(client, station, **payload)

    assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
    assert second.json()["replayed"] is True
    assert second.json()["movement_id"] == first.json()["movement_id"]
    assert second.json()["booked_as"] == "consumption_undo"
    assert [t for t, _, _ in _types(ties["id"])] == ["intake", "consumption", "consumption_undo"]


def test_an_undo_names_only_somebody_from_the_crew(client: TestClient, admin_token: str, station: dict) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=5)
    assert _consume(client, station, article_id=ties["id"], quantity=3, assignee_user_id=max_["id"]).status_code == 200

    resp = _undo(client, station, article_id=ties["id"], quantity=1, assignee_user_id=987_654, project_id=None)

    assert (resp.status_code, resp.json()["detail"]) == (400, PERSON_UNKNOWN)
    assert [t for t, _, _ in _types(ties["id"])] == ["intake", "consumption"]


def test_an_undo_of_a_missing_article_is_404(client: TestClient, admin_token: str, station: dict) -> None:
    resp = _undo(client, station, article_id=987_654, quantity=1, assignee_user_id=None, project_id=None)
    assert resp.status_code == 404, resp.text


# --------------------------------------------------------------------------
# a Rückgabe at the rack: what is really out comes back first
# --------------------------------------------------------------------------


def _old_loan(article_id: int, borrower_id: int, quantity: int, project_id: int | None = None) -> None:
    """A consumable lent out before 2026-10-10, when every Ausgabe was a
    ``checkout`` — nothing converted those rows, so they are still open."""
    with SessionLocal() as db:
        apply_movement(
            db, article=db.get(WerkstattArticle, article_id), movement_type="checkout", quantity=quantity,
            user_id=_admin_id(), assignee_user_id=borrower_id, project_id=project_id, notes="vor der Umstellung",
        )
        db.commit()


def _open_loans(user_id: int, article_id: int) -> list[tuple[int | None, int]]:
    with SessionLocal() as db:
        return [
            (row["project_id"], row["quantity_out"])
            for row in list_my_checkouts(db, user_id)
            if row["article_id"] == article_id
        ]


def _net(article_id: int, project_id: int | None) -> int:
    with SessionLocal() as db:
        return net_consumed(db, article_id=article_id, project_id=project_id)


def test_a_rueckgabe_closes_the_person_s_old_loan_before_anybody_s_consumption(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Finding F1: Max took 10 as a loan before the change, Anna consumed 20 for
    381 after it. Max's 10 coming back used to be booked out of Anna's bucket:
    10 phantom pieces in stock, his loan open forever, 381 short by 10."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=100)
    project = _project("381", name="Neubau Schulze")
    _old_loan(ties["id"], max_["id"], 10)
    assert _consume(client, station, article_id=ties["id"], quantity=20, assignee_user_id=anna["id"], project_id=project).status_code == 200

    back = _undo(client, station, article_id=ties["id"], quantity=10, assignee_user_id=max_["id"], pick_project=True, request_id="rg-1")

    assert back.status_code == 200, back.text
    body = back.json()
    assert body["booked_as"] == "return"
    assert (body["quantity"], body["project"], body["replayed"]) == (10, None, False)
    assert body["assignee"] == {"id": max_["id"], "display_name": _user(max_["id"]).display_name}
    assert (body["article"]["stock_total"], body["article"]["stock_available"], body["article"]["stock_out"]) == (80, 80, 0)
    row = _rows(ties["id"])[-1]
    assert row.id == body["movement_id"]
    assert (row.movement_type, row.quantity, row.assignee_user_id, row.project_id) == ("return", 10, max_["id"], None)
    assert (row.user_id, row.station_id, row.client_request_id) == (_admin_id(), station["id"], "rg-1")
    assert row.notes == "Regal-Station Werkstatt Pi — Rückgabe"
    # The shelf, the loan list and the project all tell the truth.
    assert _stock(ties["id"]) == (80, 80, 0)
    assert _open_loans(max_["id"], ties["id"]) == []
    assert _net(ties["id"], project) == 20


def test_the_person_s_own_consumption_still_comes_before_their_old_loan(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Leftovers of what the person consumed themselves go back into that
    bucket — the old loan is only the next guess."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 300 mm", stock=50)
    project = _project("382")
    _old_loan(ties["id"], max_["id"], 10)
    assert _consume(client, station, article_id=ties["id"], quantity=5, assignee_user_id=max_["id"], project_id=project).status_code == 200

    back = _undo(client, station, article_id=ties["id"], quantity=2, assignee_user_id=max_["id"], pick_project=True)

    assert back.status_code == 200, back.text
    assert back.json()["booked_as"] == "consumption_undo"
    assert back.json()["project"]["id"] == project
    assert _net(ties["id"], project) == 3
    assert _open_loans(max_["id"], ties["id"]) == [(None, 10)]


def test_a_cancelled_own_consumption_does_not_hide_the_old_loan(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Review finding: Max's own consumption in 381 was cancelled (ABBRUCH),
    Anna consumed 20 there afterwards. "Max booked into 381 once" is not
    "Max has leftovers from 381": his 10 coming back are the old loan, and
    Anna's 20 stay hers."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=100)
    project = _project("381", name="Neubau Schulze")
    _old_loan(ties["id"], max_["id"], 10)
    booked = _consume(
        client, station, article_id=ties["id"], quantity=5, assignee_user_id=max_["id"], project_id=project, request_id="c1",
    )
    assert booked.status_code == 200, booked.text
    cancelled = _undo(
        client, station, article_id=ties["id"], quantity=5, assignee_user_id=max_["id"], project_id=project,
        undo_of_movement_id=booked.json()["movement_id"], request_id="c1-undo",
    )
    assert cancelled.status_code == 200, cancelled.text
    assert _consume(client, station, article_id=ties["id"], quantity=20, assignee_user_id=anna["id"], project_id=project).status_code == 200

    back = _undo(client, station, article_id=ties["id"], quantity=10, assignee_user_id=max_["id"], pick_project=True)

    assert back.status_code == 200, back.text
    assert (back.json()["booked_as"], back.json()["project"]) == ("return", None)
    assert back.json()["assignee"]["id"] == max_["id"]
    assert _net(ties["id"], project) == 20
    assert _open_loans(max_["id"], ties["id"]) == []
    assert _stock(ties["id"]) == (80, 80, 0)


def test_a_colleague_s_consumption_in_the_same_project_is_not_the_person_s_leftovers(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Max consumed 2 for 381, Anna 20. Ten pieces Max carries back cannot be
    leftovers of his 2 — they close his old loan, and 381 keeps all 22."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=100)
    project = _project("381")
    _old_loan(ties["id"], max_["id"], 10)
    assert _consume(client, station, article_id=ties["id"], quantity=2, assignee_user_id=max_["id"], project_id=project).status_code == 200
    assert _consume(client, station, article_id=ties["id"], quantity=20, assignee_user_id=anna["id"], project_id=project).status_code == 200

    back = _undo(client, station, article_id=ties["id"], quantity=10, assignee_user_id=max_["id"], pick_project=True)

    assert back.status_code == 200, back.text
    assert back.json()["booked_as"] == "return"
    assert _net(ties["id"], project) == 22
    assert _open_loans(max_["id"], ties["id"]) == []
    assert _stock(ties["id"]) == (78, 78, 0)

    # Up to his own 2 they still are his leftovers.
    mine = _undo(client, station, article_id=ties["id"], quantity=2, assignee_user_id=max_["id"], pick_project=True)
    assert mine.status_code == 200, mine.text
    assert (mine.json()["booked_as"], mine.json()["project"]["id"]) == ("consumption_undo", project)
    assert _net(ties["id"], project) == 20


def test_leftovers_go_to_the_latest_own_bucket_that_holds_that_many(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Max consumed 10 for 381 and later 2 for 382: 8 pieces back can only be
    from 381."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=50)
    first = _project("381")
    second = _project("382")
    assert _consume(client, station, article_id=ties["id"], quantity=10, assignee_user_id=max_["id"], project_id=first).status_code == 200
    assert _consume(client, station, article_id=ties["id"], quantity=2, assignee_user_id=max_["id"], project_id=second).status_code == 200

    eight = _undo(client, station, article_id=ties["id"], quantity=8, assignee_user_id=max_["id"], pick_project=True)
    one = _undo(client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], pick_project=True)

    assert eight.status_code == 200, eight.text
    assert eight.json()["project"]["id"] == first
    assert one.status_code == 200, one.text
    assert one.json()["project"]["id"] == second
    assert (_net(ties["id"], first), _net(ties["id"], second)) == (2, 1)


def test_the_old_loan_comes_back_with_its_project(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """``list_my_checkouts`` balances per (article, project): a return without
    the loan's project would leave the loan standing."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Aderendhülsen 2,5 mm²", stock=40)
    project = _project("383", name="Umbau Meier")
    _old_loan(ties["id"], max_["id"], 6, project_id=project)

    back = _undo(client, station, article_id=ties["id"], quantity=6, assignee_user_id=max_["id"], pick_project=True)

    assert back.status_code == 200, back.text
    body = back.json()
    assert body["booked_as"] == "return"
    assert body["project"] == {"id": project, "project_number": "383", "name": "Umbau Meier"}
    assert _rows(ties["id"])[-1].project_id == project
    assert _open_loans(max_["id"], ties["id"]) == []
    assert _stock(ties["id"]) == (40, 40, 0)


def test_more_than_the_old_loan_is_refused_rather_than_split(
    client: TestClient, admin_token: str, station: dict
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Wago 221-413", stock=30)
    _old_loan(ties["id"], max_["id"], 10)

    too_many = _undo(client, station, article_id=ties["id"], quantity=12, assignee_user_id=max_["id"], pick_project=True)

    assert (too_many.status_code, too_many.json()["detail"]) == (400, "Nur 10 ausgeliehen – bitte die Menge anpassen.")
    assert [t for t, _, _ in _types(ties["id"])] == ["intake", "checkout"]

    # Bounded by what the snapshot has out, too: apply_movement refuses a
    # return above ``stock_out``, so the sentence names that number.
    with SessionLocal() as db:
        db.get(WerkstattArticle, ties["id"]).stock_out = 4
        db.commit()
    snapshot = _undo(client, station, article_id=ties["id"], quantity=5, assignee_user_id=max_["id"], pick_project=True)
    assert (snapshot.status_code, snapshot.json()["detail"]) == (400, "Nur 4 ausgeliehen – bitte die Menge anpassen.")
    assert [t for t, _, _ in _types(ties["id"])] == ["intake", "checkout"]


def test_a_nameless_rueckgabe_closes_the_loan_the_station_infers(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Nobody tapped a name: the loan ``/movements`` would close for a bare
    Rückgabe comes before anybody's consumption bucket."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=100)
    project = _project("381")
    _old_loan(ties["id"], max_["id"], 10, project_id=project)
    assert _consume(client, station, article_id=ties["id"], quantity=20, assignee_user_id=anna["id"], project_id=project).status_code == 200

    back = _undo(client, station, article_id=ties["id"], quantity=10, assignee_user_id=None, pick_project=True)

    assert back.status_code == 200, back.text
    body = back.json()
    assert body["booked_as"] == "return"
    assert body["assignee"]["id"] == max_["id"]
    assert body["project"]["id"] == project
    row = _rows(ties["id"])[-1]
    assert (row.movement_type, row.assignee_user_id, row.project_id) == ("return", max_["id"], project)
    assert _open_loans(max_["id"], ties["id"]) == []
    assert _net(ties["id"], project) == 20
    assert _stock(ties["id"]) == (80, 80, 0)

    # The same bound applies to the inferred loan.
    _old_loan(ties["id"], max_["id"], 3)
    too_many = _undo(client, station, article_id=ties["id"], quantity=4, assignee_user_id=None, pick_project=True)
    assert (too_many.status_code, too_many.json()["detail"]) == (400, "Nur 3 ausgeliehen – bitte die Menge anpassen.")


def test_a_named_rueckgabe_without_own_consumption_or_loan_takes_from_anybody_s_bucket(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """A colleague's old loan is not the named person's: with a name tapped the
    station does not guess a different borrower — the next stop is anybody's
    consumption, and with none of that the German "nothing"."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")
    tom = _make_user(client, admin_token, "tom@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=100)
    tape = _article(client, admin_token, "Isolierband", stock=10)
    project = _project("381")
    _old_loan(ties["id"], tom["id"], 5)
    _old_loan(tape["id"], tom["id"], 5)
    assert _consume(client, station, article_id=ties["id"], quantity=20, assignee_user_id=anna["id"], project_id=project).status_code == 200

    back = _undo(client, station, article_id=ties["id"], quantity=2, assignee_user_id=max_["id"], pick_project=True)
    nothing = _undo(client, station, article_id=tape["id"], quantity=1, assignee_user_id=max_["id"], pick_project=True)

    assert back.status_code == 200, back.text
    assert back.json()["booked_as"] == "consumption_undo"
    assert back.json()["project"]["id"] == project
    assert back.json()["assignee"]["id"] == max_["id"]
    assert _net(ties["id"], project) == 18
    assert _open_loans(tom["id"], ties["id"]) == [(None, 5)]
    assert (nothing.status_code, nothing.json()["detail"]) == (400, NOTHING_TO_TAKE_BACK)
    assert _open_loans(tom["id"], tape["id"]) == [(None, 5)]


def test_a_nameless_rueckgabe_of_nothing_at_all_is_said_in_german(
    client: TestClient, admin_token: str, station: dict
) -> None:
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=5)
    resp = _undo(client, station, article_id=ties["id"], quantity=1, assignee_user_id=None, pick_project=True)
    assert (resp.status_code, resp.json()["detail"]) == (400, NOTHING_TO_TAKE_BACK)
    assert _types(ties["id"]) == [("intake", 5, None)]


def test_a_retried_loan_rueckgabe_replays_the_return(
    client: TestClient, admin_token: str, station: dict
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=20)
    project = _project("381")
    _old_loan(ties["id"], max_["id"], 4, project_id=project)
    payload = dict(article_id=ties["id"], quantity=4, assignee_user_id=max_["id"], pick_project=True, request_id="rg-9")

    first = _undo(client, station, **payload)
    second = _undo(client, station, **payload)

    assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
    replay = second.json()
    assert replay["replayed"] is True
    assert replay["movement_id"] == first.json()["movement_id"]
    assert (replay["booked_as"], replay["quantity"]) == ("return", 4)
    assert replay["assignee"]["id"] == max_["id"]
    assert replay["project"]["id"] == project
    assert [t for t, _, _ in _types(ties["id"])] == ["intake", "checkout", "return"]
    # A consumption must not replay a return's token.
    clash = _consume(client, station, article_id=ties["id"], quantity=1, assignee_user_id=max_["id"], request_id="rg-9")
    assert clash.status_code == 409, clash.text


# --------------------------------------------------------------------------
# ABBRUCH after a short-shelf top-up
# --------------------------------------------------------------------------


def test_abbruch_of_a_topped_up_consumption_takes_the_top_up_back(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """Finding F2: MENGE-50 by mistake against a shelf of 12 booked 38 as a
    top-up. ABBRUCH used to leave those 38 phantom pieces in stock."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=12)
    booked = _consume(client, station, article_id=ties["id"], quantity=50, assignee_user_id=max_["id"], request_id="c-1")
    assert booked.status_code == 200, booked.text
    assert booked.json()["topped_up"] == 38
    top_up = _rows(ties["id"])[1]
    assert (top_up.movement_type, top_up.quantity, top_up.client_request_id) == ("inventory_plus", 38, "c-1+t")

    undo = _undo(
        client, station, article_id=ties["id"], quantity=50, assignee_user_id=max_["id"], project_id=None,
        undo_of_movement_id=booked.json()["movement_id"], request_id="u-1",
    )

    assert undo.status_code == 200, undo.text
    body = undo.json()
    assert (body["booked_as"], body["reversed_top_up"], body["replayed"]) == ("consumption_undo", 38, False)
    assert (body["article"]["stock_total"], body["article"]["stock_available"]) == (12, 12)
    assert _stock(ties["id"]) == (12, 12, 0)
    reversal = _rows(ties["id"])[-1]
    assert (reversal.movement_type, reversal.quantity, reversal.client_request_id) == ("inventory_minus", 38, "c-1+u")
    assert (reversal.station_id, reversal.user_id) == (station["id"], _admin_id())
    assert reversal.notes == "Regal-Station Werkstatt Pi — Nachbuchung bei Abbruch zurückgenommen"

    # A retried ABBRUCH replays the same answer and reverses nothing more.
    again = _undo(
        client, station, article_id=ties["id"], quantity=50, assignee_user_id=max_["id"], project_id=None,
        undo_of_movement_id=booked.json()["movement_id"], request_id="u-1",
    )
    assert again.status_code == 200, again.text
    assert (again.json()["replayed"], again.json()["reversed_top_up"]) == (True, 38)
    assert again.json()["movement_id"] == body["movement_id"]
    assert [t for t, _, _ in _types(ties["id"])] == [
        "intake", "inventory_plus", "consumption", "consumption_undo", "inventory_minus",
    ]


def test_a_second_undo_of_the_same_consumption_reverses_nothing_more(
    client: TestClient, admin_token: str, station: dict
) -> None:
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=12)
    booked = _consume(client, station, article_id=ties["id"], quantity=50, assignee_user_id=max_["id"], request_id="c-2")
    consumption_id = booked.json()["movement_id"]

    first = _undo(
        client, station, article_id=ties["id"], quantity=10, assignee_user_id=max_["id"], project_id=None,
        undo_of_movement_id=consumption_id, request_id="u-2a",
    )
    second = _undo(
        client, station, article_id=ties["id"], quantity=40, assignee_user_id=max_["id"], project_id=None,
        undo_of_movement_id=consumption_id, request_id="u-2b",
    )
    replay_of_second = _undo(
        client, station, article_id=ties["id"], quantity=40, assignee_user_id=max_["id"], project_id=None,
        undo_of_movement_id=consumption_id, request_id="u-2b",
    )

    assert first.status_code == 200 and second.status_code == 200, (first.text, second.text)
    # Never more than is on the shelf after the undo: 10 came back, 10 go.
    assert first.json()["reversed_top_up"] == 10
    assert second.json()["reversed_top_up"] == 0
    assert (replay_of_second.json()["replayed"], replay_of_second.json()["reversed_top_up"]) == (True, 0)
    assert [t for t, _, _ in _types(ties["id"])].count("inventory_minus") == 1
    assert _stock(ties["id"]) == (40, 40, 0)


def test_only_an_exact_undo_of_this_station_s_linked_consumption_reverses_a_top_up(
    client: TestClient, admin_token: str, station: dict
) -> None:
    """A Rückgabe of leftovers is not a correction; another station's booking,
    another bucket and a consumption booked without a token have nothing
    linked to reverse."""
    max_ = _make_user(client, admin_token, "max@example.com", "employee")
    project = _project("381")
    other_token, other_row = _pair(client, admin_token, name="Zweite Station")
    other = {"token": other_token, "id": other_row["id"], "name": other_row["name"]}

    def _short_shelf(name: str, consumer: dict, **extra) -> tuple[int, int]:
        article = _article(client, admin_token, name, stock=2)
        booked = _consume(client, consumer, article_id=article["id"], quantity=5, assignee_user_id=max_["id"], **extra)
        assert booked.status_code == 200 and booked.json()["topped_up"] == 3, booked.text
        return article["id"], booked.json()["movement_id"]

    leftovers, leftovers_booking = _short_shelf("Kabelbinder A", station, request_id="x-1")
    foreign, foreign_booking = _short_shelf("Kabelbinder B", other, request_id="x-2")
    elsewhere, elsewhere_booking = _short_shelf("Kabelbinder C", station, request_id="x-3", project_id=project)
    untokened, untokened_booking = _short_shelf("Kabelbinder D", station)
    _consume(client, station, article_id=elsewhere, quantity=1, assignee_user_id=max_["id"])

    answers = [
        _undo(client, station, article_id=leftovers, quantity=2, assignee_user_id=max_["id"], pick_project=True,
              undo_of_movement_id=leftovers_booking),
        _undo(client, station, article_id=foreign, quantity=5, assignee_user_id=max_["id"], project_id=None,
              undo_of_movement_id=foreign_booking),
        _undo(client, station, article_id=elsewhere, quantity=1, assignee_user_id=max_["id"], project_id=None,
              undo_of_movement_id=elsewhere_booking),
        _undo(client, station, article_id=untokened, quantity=5, assignee_user_id=max_["id"], project_id=None,
              undo_of_movement_id=untokened_booking),
    ]

    assert [r.status_code for r in answers] == [200] * 4, [r.text for r in answers]
    assert [r.json()["reversed_top_up"] for r in answers] == [0, 0, 0, 0]
    for article_id in (leftovers, foreign, elsewhere, untokened):
        assert "inventory_minus" not in [t for t, _, _ in _types(article_id)]
    assert _rows(untokened)[1].client_request_id is None


# --------------------------------------------------------------------------
# the boundary
# --------------------------------------------------------------------------


def test_a_user_token_opens_none_of_it(client: TestClient, admin_token: str) -> None:
    head = auth_headers(admin_token)
    body = {"article_id": 1, "quantity": 1, "assignee_user_id": 1}
    attempts = [
        client.post(f"{BASE}/consumptions", headers=head, json=body),
        client.post(f"{BASE}/consumptions/undo", headers=head, json=body),
        client.post(f"{BASE}/consumptions", json=body),
        client.post(f"{BASE}/consumptions/undo", json=body),
    ]
    assert [r.status_code for r in attempts] == [401] * 4, [r.text for r in attempts]
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(WerkstattMovement)) == 0
        assert db.scalar(select(func.count()).select_from(Station)) == 0
