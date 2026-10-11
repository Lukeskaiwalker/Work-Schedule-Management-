"""Consumables leaving the shelf for good — the rule the Regal station, the
desk and the phone share (owner, 2026-10-10: "any item that is not inside the
machine tab is a consumable, when we scan it we book it out of the inventory
and it is installed at a work site").

What must hold:

* a consumable (``is_serialized`` False) leaves the stock as ``consumption``,
  with the person who took it and the project it went into — never as a
  ``checkout`` loan that waits for a return;
* a short shelf is not refused (the person holds the part): the shortfall is
  booked first as ``inventory_plus`` and the answer says so, so the ledger
  never goes negative;
* a machine type (``is_serialized``) and an archived article are refused;
* taking pieces back is bounded by what is still net consumed in that
  (article, project) bucket — Verteiler rows and other projects are other
  buckets;
* an unknown and an archived project are refused with one sentence.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import Project, User, WerkstattArticle, WerkstattMovement
from app.services import werkstatt_consumption as consumption
from tests.test_schaltplan import _customer, _project
from tests.test_schaltplan_material import _article
from tests.test_station_werkstatt import _make_user


def _admin_id(db) -> int:
    return db.scalars(select(User.id).where(User.email == "admin@example.com")).one()


def _rows(db, article_id: int) -> list[tuple[str, int, int | None]]:
    return [
        (row.movement_type, row.quantity, row.project_id)
        for row in db.scalars(
            select(WerkstattMovement).where(WerkstattMovement.article_id == article_id).order_by(WerkstattMovement.id)
        )
    ]


def test_a_consumable_leaves_the_stock_with_person_and_project(client: TestClient, admin_token: str):
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=10)
    project_id = _project(client, admin_token, _customer(client, admin_token), number="381")
    with SessionLocal() as db:
        admin = _admin_id(db)
        article = db.get(WerkstattArticle, ties["id"])
        result = consumption.book_stock_consumption(
            db, article=article, quantity=3, user_id=admin, assignee_user_id=admin,
            project_id=project_id, notes="Regal-Station Werkstatt", station_id=None, client_request_id="req-1",
        )
        db.commit()
        assert (result.topped_up, result.stock_warning) == (0, None)
        assert (article.stock_total, article.stock_available, article.stock_out) == (7, 7, 0)
        row = db.get(WerkstattMovement, result.movement.id)
        assert (row.movement_type, row.quantity, row.project_id, row.assignee_user_id) == ("consumption", 3, project_id, admin)
        assert row.client_request_id == "req-1" and row.panel_id is None


def test_a_short_shelf_is_topped_up_first_and_said_so(client: TestClient, admin_token: str):
    ferrules = _article(client, admin_token, "Aderendhülsen 1,5 mm²", stock=1)
    with SessionLocal() as db:
        admin = _admin_id(db)
        article = db.get(WerkstattArticle, ferrules["id"])
        result = consumption.book_stock_consumption(
            db, article=article, quantity=3, user_id=admin, assignee_user_id=admin, project_id=None, notes="Theke",
        )
        db.commit()
        assert result.topped_up == 2
        assert result.stock_warning and "2" in result.stock_warning
        # Never negative: the ledger and the snapshot agree at zero.
        assert (article.stock_total, article.stock_available) == (0, 0)
        assert _rows(db, ferrules["id"])[-2:] == [("inventory_plus", 2, None), ("consumption", 3, None)]


def test_machines_and_archived_articles_are_refused(client: TestClient, admin_token: str):
    drill = _article(client, admin_token, "Bohrhammer", stock=2)
    old = _article(client, admin_token, "Alte Klemme", stock=2)
    assert client.delete(f"/api/werkstatt/articles/{old['id']}", headers={"Authorization": f"Bearer {admin_token}"}).status_code == 200
    with SessionLocal() as db:
        admin = _admin_id(db)
        machine = db.get(WerkstattArticle, drill["id"])
        machine.is_serialized = True
        db.flush()
        with pytest.raises(consumption.ConsumptionError, match="Maschinen"):
            consumption.book_stock_consumption(
                db, article=machine, quantity=1, user_id=admin, assignee_user_id=admin, project_id=None, notes=None,
            )
        with pytest.raises(consumption.ConsumptionError, match="archiviert"):
            consumption.book_stock_consumption(
                db, article=db.get(WerkstattArticle, old["id"]), quantity=1, user_id=admin,
                assignee_user_id=admin, project_id=None, notes=None,
            )


def test_taking_back_is_bounded_by_the_bucket(client: TestClient, admin_token: str):
    duct = _article(client, admin_token, "Verdrahtungskanal 40x60", stock=20)
    customer = _customer(client, admin_token)
    first = _project(client, admin_token, customer, number="381")
    second = _project(client, admin_token, customer, number="382")
    with SessionLocal() as db:
        admin = _admin_id(db)
        article = db.get(WerkstattArticle, duct["id"])
        for project_id, quantity in ((first, 3), (second, 2)):
            consumption.book_stock_consumption(
                db, article=article, quantity=quantity, user_id=admin, assignee_user_id=admin,
                project_id=project_id, notes=None,
            )
        db.commit()
        assert consumption.net_consumed(db, article_id=article.id, project_id=first) == 3
        with pytest.raises(consumption.ConsumptionError, match="3"):
            consumption.undo_stock_consumption(
                db, article=article, quantity=4, user_id=admin, assignee_user_id=admin, project_id=first, notes=None,
            )
        back = consumption.undo_stock_consumption(
            db, article=article, quantity=2, user_id=admin, assignee_user_id=admin, project_id=first, notes="Rest",
        )
        db.commit()
        assert (back.movement_type, back.quantity, back.project_id) == ("consumption_undo", 2, first)
        assert consumption.net_consumed(db, article_id=article.id, project_id=first) == 1
        assert consumption.net_consumed(db, article_id=article.id, project_id=second) == 2
        assert article.stock_total == 20 - 3 - 2 + 2
        # Nothing went out without a project: that bucket has nothing to take back.
        with pytest.raises(consumption.ConsumptionError):
            consumption.undo_stock_consumption(
                db, article=article, quantity=1, user_id=admin, assignee_user_id=admin, project_id=None, notes=None,
            )


def test_open_buckets_name_the_person_s_own_most_recent_first(client: TestClient, admin_token: str):
    duct = _article(client, admin_token, "Hutschiene 35 mm", stock=20)
    customer = _customer(client, admin_token)
    first = _project(client, admin_token, customer, number="381")
    second = _project(client, admin_token, customer, number="382")
    with SessionLocal() as db:
        admin = _admin_id(db)
        article = db.get(WerkstattArticle, duct["id"])
        for project_id in (first, second, None):
            consumption.book_stock_consumption(
                db, article=article, quantity=1, user_id=admin, assignee_user_id=admin, project_id=project_id, notes=None,
            )
        db.commit()
        assert consumption.open_buckets(db, article_id=article.id, assignee_user_id=admin) == [None, second, first]
        consumption.undo_stock_consumption(
            db, article=article, quantity=1, user_id=admin, assignee_user_id=admin, project_id=second, notes=None,
        )
        db.commit()
        assert consumption.open_buckets(db, article_id=article.id, assignee_user_id=admin) == [None, first]


def test_own_buckets_count_the_person_s_own_net_not_the_bucket_s(client: TestClient, admin_token: str):
    """"Own" is what the person consumed minus what was taken back under
    their name — not "they booked into that bucket once". A cancelled
    consumption leaves them nothing there, and a colleague's pieces in the
    same project are not theirs to give back."""
    ties = _article(client, admin_token, "Kabelbinder 200 mm", stock=100)
    customer = _customer(client, admin_token)
    first = _project(client, admin_token, customer, number="381")
    second = _project(client, admin_token, customer, number="382")
    anna = _make_user(client, admin_token, "anna@example.com", "employee")["id"]
    with SessionLocal() as db:
        admin = _admin_id(db)
        article = db.get(WerkstattArticle, ties["id"])

        def book(person: int, project_id: int, quantity: int, *, undo: bool = False) -> None:
            booking = consumption.undo_stock_consumption if undo else consumption.book_stock_consumption
            booking(
                db, article=article, quantity=quantity, user_id=admin, assignee_user_id=person,
                project_id=project_id, notes=None,
            )
            db.commit()

        book(admin, first, 5)
        book(anna, first, 20)
        book(admin, first, 5, undo=True)  # the ABBRUCH of the admin's own 5
        book(anna, second, 3)
        # Nothing of the admin's is left anywhere, so nothing comes first for
        # them: the most recent consumption leads, as for anybody.
        assert consumption.own_open_buckets(db, article_id=article.id, assignee_user_id=admin) == []
        assert consumption.open_buckets(db, article_id=article.id, assignee_user_id=admin) == [second, first]

        book(admin, first, 2)
        assert consumption.own_open_buckets(db, article_id=article.id, assignee_user_id=admin) == [first]
        assert consumption.own_open_buckets(db, article_id=article.id, assignee_user_id=admin, quantity=2) == [first]
        # 3 is more than the admin's own 2 — the other 20 in 381 are Anna's.
        assert consumption.own_open_buckets(db, article_id=article.id, assignee_user_id=admin, quantity=3) == []
        assert consumption.open_buckets(db, article_id=article.id, assignee_user_id=admin) == [first, second]

        # Somebody else's take-back out of that bucket shrinks what is left
        # in it, so the admin's own share there is bounded by it too.
        book(anna, first, 21, undo=True)
        assert consumption.net_consumed(db, article_id=article.id, project_id=first) == 1
        assert consumption.own_open_buckets(db, article_id=article.id, assignee_user_id=admin, quantity=2) == []
        assert consumption.own_open_buckets(db, article_id=article.id, assignee_user_id=admin) == [first]


def test_a_project_must_exist_and_be_open(client: TestClient, admin_token: str):
    project_id = _project(client, admin_token, _customer(client, admin_token), number="390")
    with SessionLocal() as db:
        assert consumption.require_bookable_project(db, None) is None
        assert consumption.require_bookable_project(db, project_id).id == project_id
        with pytest.raises(consumption.ConsumptionError) as unknown:
            consumption.require_bookable_project(db, 999_999)
        db.get(Project, project_id).status = "archived"
        db.flush()
        with pytest.raises(consumption.ConsumptionError) as archived:
            consumption.require_bookable_project(db, project_id)
        # One sentence for both: the station must not learn which ids exist.
        assert str(unknown.value) == str(archived.value)


def test_a_top_up_is_linked_to_its_consumption_by_the_request_id(client: TestClient, admin_token: str):
    """The undo of that consumption has to find the top-up to take it back
    (ABBRUCH after a wrong MENGE). The link is the token plus ``+t`` — and
    only when that still fits the 64-character column."""
    ferrules = _article(client, admin_token, "Aderendhülsen 0,75 mm²", stock=1)
    fits = "r" * 62
    too_long = "s" * 63
    with SessionLocal() as db:
        admin = _admin_id(db)
        article = db.get(WerkstattArticle, ferrules["id"])
        for token in (fits, too_long, None):
            consumption.book_stock_consumption(
                db, article=article, quantity=2, user_id=admin, assignee_user_id=admin, project_id=None,
                notes=None, client_request_id=token,
            )
        db.commit()
        top_ups = [
            row.client_request_id
            for row in db.scalars(
                select(WerkstattMovement)
                .where(WerkstattMovement.article_id == article.id, WerkstattMovement.movement_type == "inventory_plus")
                .order_by(WerkstattMovement.id)
            )
        ]
        assert top_ups == [fits + "+t", None, None]
