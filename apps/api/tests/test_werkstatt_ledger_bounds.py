"""The ledger's own upper bounds — ``services/werkstatt_movements.apply_movement``.

Request schemas bound every quantity they accept, but ``apply_movement`` is the
single write path for every stock change, and not every caller reaches it from
a bounded request: a delivery books whatever a stored order line still says, a
stock-take books the difference to a count that was built up scan by scan. So
the ledger refuses on its own, with a ``MovementError`` the callers already
turn into a 400:

* more than ``MAX_STOCK_QUANTITY`` pieces in one booking;
* a booking that would carry a snapshot counter (``stock_total`` & co., all
  ``Integer``) past ``INT32_MAX`` — the "saved, then overflows a later sum"
  half of the bug: each booking fits, their sum does not.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.limits import INT32_MAX, MAX_STOCK_QUANTITY
from app.models.entities import User, WerkstattArticle, WerkstattMovement, WerkstattOrderLine
from app.services.werkstatt_movements import (
    MovementError,
    apply_movement,
    recompute_article_stock,
)


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _admin_id(db) -> int:
    return int(db.scalars(select(User.id).where(User.email == "admin@example.com")).one())


def _new_article(db, number: str) -> WerkstattArticle:
    article = WerkstattArticle(article_number=number, item_name=f"Grenzartikel {number}", unit="Stk")
    db.add(article)
    db.flush()
    return article


def _ledger(article_id: int) -> list[tuple[str, int]]:
    with SessionLocal() as db:
        rows = db.scalars(
            select(WerkstattMovement)
            .where(WerkstattMovement.article_id == article_id)
            .order_by(WerkstattMovement.id)
        )
        return [(row.movement_type, int(row.quantity)) for row in rows]


def _article_near_the_column(headroom: int) -> int:
    """An article whose ledger already sums to ``INT32_MAX - headroom``.

    Written straight into the ledger: no single booking may be that large any
    more, which is the point — the sum got there one bounded booking at a time.
    """
    with SessionLocal() as db:
        article = _new_article(db, f"SP-NEAR-{headroom}")
        db.add(
            WerkstattMovement(
                article_id=article.id,
                movement_type="intake",
                quantity=INT32_MAX - headroom,
                user_id=_admin_id(db),
            )
        )
        db.flush()
        recompute_article_stock(db, article)
        db.commit()
        return int(article.id)


# ── one booking past the bound ───────────────────────────────────────────────


@pytest.mark.parametrize(
    "movement_type", ["intake", "inventory_plus", "consumption", "consumption_undo", "checkout"]
)
def test_the_ledger_refuses_a_booking_past_the_bound(client: TestClient, movement_type: str) -> None:
    with SessionLocal() as db:
        article = _new_article(db, f"SP-BIG-{movement_type}")
        with pytest.raises(MovementError, match=f"höchstens {MAX_STOCK_QUANTITY}"):
            apply_movement(
                db,
                article=article,
                movement_type=movement_type,
                quantity=MAX_STOCK_QUANTITY + 1,
                user_id=_admin_id(db),
            )
        db.commit()
        article_id = int(article.id)
    assert _ledger(article_id) == []


def test_the_ledger_books_the_bound_itself(client: TestClient) -> None:
    with SessionLocal() as db:
        article = _new_article(db, "SP-MAX")
        apply_movement(
            db, article=article, movement_type="intake", quantity=MAX_STOCK_QUANTITY, user_id=_admin_id(db)
        )
        db.commit()
        assert article.stock_total == MAX_STOCK_QUANTITY
        article_id = int(article.id)
    assert _ledger(article_id) == [("intake", MAX_STOCK_QUANTITY)]


# ── a sum past the column ────────────────────────────────────────────────────


@pytest.mark.parametrize("movement_type", ["intake", "inventory_plus", "consumption_undo"])
def test_the_ledger_refuses_a_booking_that_would_overflow_the_stock_counter(
    client: TestClient, movement_type: str
) -> None:
    article_id = _article_near_the_column(headroom=5)
    with SessionLocal() as db:
        article = db.get(WerkstattArticle, article_id)
        with pytest.raises(MovementError, match=str(INT32_MAX)):
            apply_movement(db, article=article, movement_type=movement_type, quantity=6, user_id=_admin_id(db))
        db.commit()
    assert _ledger(article_id) == [("intake", INT32_MAX - 5)]


def test_the_ledger_fills_the_stock_counter_to_the_column_exactly(client: TestClient) -> None:
    article_id = _article_near_the_column(headroom=5)
    with SessionLocal() as db:
        article = db.get(WerkstattArticle, article_id)
        apply_movement(db, article=article, movement_type="intake", quantity=5, user_id=_admin_id(db))
        db.commit()
        assert article.stock_total == INT32_MAX


def test_a_loan_moving_within_the_counters_is_not_refused_near_the_column(client: TestClient) -> None:
    """A checkout moves stock from ``available`` to ``out`` — ``total`` does
    not grow, so it can never overflow and must not be refused for it."""
    article_id = _article_near_the_column(headroom=0)
    with SessionLocal() as db:
        article = db.get(WerkstattArticle, article_id)
        apply_movement(db, article=article, movement_type="checkout", quantity=10, user_id=_admin_id(db))
        db.commit()
        assert (article.stock_total, article.stock_out) == (INT32_MAX, 10)


# ── the 400 at the boundary ──────────────────────────────────────────────────


def test_the_desk_answers_400_when_the_stock_counter_would_overflow(client: TestClient, admin_token: str) -> None:
    """``POST /api/werkstatt/articles/{id}/movements`` — the "Bestand anpassen"
    dialog. Each intake is within the desk's own cap; the sum is not."""
    article_id = _article_near_the_column(headroom=5)
    refused = client.post(
        f"/api/werkstatt/articles/{article_id}/movements",
        headers=_auth(admin_token),
        json={"kind": "intake", "quantity": 6, "reason": "Lieferschein 4711"},
    )
    assert refused.status_code == 400, refused.text
    assert refused.json()["detail"].startswith("Buchung nicht möglich:")
    assert _ledger(article_id) == [("intake", INT32_MAX - 5)]


def test_a_stored_order_line_past_the_bound_is_refused_on_delivery(client: TestClient, admin_token: str) -> None:
    """``mark-delivered`` books what the stored line still says — a row written
    before the order-line bound existed is not bounded by any request."""
    from tests.test_werkstatt_tablet import _seed_article, _seed_supplier

    with SessionLocal() as db:
        supplier = _seed_supplier(db, name="Altbestand GmbH")
        article = _seed_article(db, article_number="SP-ALT-1", stock_total=0, stock_min=0)
        db.commit()
        supplier_id, article_id = int(supplier.id), int(article.id)

    headers = _auth(admin_token)
    draft = client.post(
        "/api/werkstatt/orders",
        headers=headers,
        json={"supplier_id": supplier_id, "lines": [{"article_id": article_id, "quantity_ordered": 3}]},
    )
    assert draft.status_code == 200, draft.text
    order = draft.json()
    sent = client.post(f"/api/werkstatt/orders/{order['id']}/mark-sent", headers=headers)
    assert sent.status_code == 200, sent.text
    with SessionLocal() as db:
        line = db.get(WerkstattOrderLine, order["lines"][0]["id"])
        line.quantity_ordered = MAX_STOCK_QUANTITY + 1
        db.commit()

    delivered = client.post(f"/api/werkstatt/orders/{order['id']}/mark-delivered", headers=headers)
    assert delivered.status_code == 400, delivered.text
    assert _ledger(article_id) == []
    with SessionLocal() as db:
        line = db.get(WerkstattOrderLine, order["lines"][0]["id"])
        assert (line.quantity_received, line.line_status) == (0, "pending")
