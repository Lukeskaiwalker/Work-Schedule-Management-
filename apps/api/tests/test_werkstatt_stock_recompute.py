"""One recompute, or the ledger stops being the source of truth.

``werkstatt_movements`` is authoritative and the four ``stock_*`` columns are
snapshots rebuilt from it. That only holds while exactly ONE piece of code
knows how a movement type maps onto the counters. The delivery path used to
carry its own inline aggregation which had never heard of ``inventory_plus`` /
``inventory_minus`` and gave ``correction`` the opposite sign — so marking an
order delivered rewrote the snapshot from a partial reading of the ledger and
silently undid whatever the workshop had booked in between.

These tests are end-to-end on purpose: the reversal is invisible in either
half. The adjustment is correct when it is made, the delivery adds exactly
what it should, and the wrong number only appears because the second one
recomputed from scratch.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

BASE = "/api/werkstatt"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _article(client: TestClient, token: str, name: str, *, stock: int = 0) -> dict:
    resp = client.post(
        f"{BASE}/articles",
        headers=auth_headers(token),
        json={"item_name": name, "unit": "Stk", "stock_total": stock},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _get(client: TestClient, token: str, article_id: int) -> dict:
    resp = client.get(f"{BASE}/articles/{article_id}", headers=auth_headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def _supplier(client: TestClient, token: str, name: str = "Unielektro") -> dict:
    resp = client.post(f"{BASE}/suppliers", headers=auth_headers(token), json={"name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _deliver_order(
    client: TestClient, token: str, *, supplier_id: int, article_id: int, quantity: int
) -> dict:
    """Order ``quantity`` of one article from ``supplier_id`` and mark it
    delivered — the whole draft → sent → delivered walk the buyer does."""
    created = client.post(
        f"{BASE}/orders",
        headers=auth_headers(token),
        json={
            "supplier_id": supplier_id,
            "lines": [{"article_id": article_id, "quantity_ordered": quantity}],
        },
    )
    assert created.status_code == 200, created.text
    order_id = created.json()["id"]

    sent = client.post(f"{BASE}/orders/{order_id}/mark-sent", headers=auth_headers(token))
    assert sent.status_code == 200, sent.text
    delivered = client.post(
        f"{BASE}/orders/{order_id}/mark-delivered", headers=auth_headers(token)
    )
    assert delivered.status_code == 200, delivered.text
    return delivered.json()


def _book(article_id: int, movement_type: str, quantity: int) -> None:
    """Write one ledger row through the canonical service, for the movement
    types no HTTP endpoint exposes (``checkout``, ``correction``)."""
    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle
    from app.services.werkstatt_movements import apply_movement

    with SessionLocal() as db:
        article = db.get(WerkstattArticle, article_id)
        admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
        apply_movement(
            db,
            article=article,
            movement_type=movement_type,
            quantity=quantity,
            user_id=admin.id,
        )
        db.commit()


def _assert_invariant(snapshot: dict) -> None:
    assert snapshot["stock_total"] == (
        snapshot["stock_available"] + snapshot["stock_out"] + snapshot["stock_repair"]
    ), f"invariant broken: {snapshot}"


# ──────────────────────────────────────────────────────────────────────────
# A delivery may not reverse a stock-take
# ──────────────────────────────────────────────────────────────────────────


def test_a_delivery_does_not_resurrect_a_written_off_quantity(
    client: TestClient, admin_token: str
) -> None:
    """100 on the shelf, 8 booked as Schwund/Defekt, then 20 delivered = 112.

    The reversal this pins is not a rounding error: the 8 come back, weeks
    later, triggered by an unrelated order. Nobody looking at either the
    adjustment or the delivery can see it happen.
    """

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Wago 221-413", stock=100)

    defect = client.post(
        f"{BASE}/articles/{article['id']}/movements",
        headers=auth_headers(admin_token),
        json={"kind": "defect", "quantity": 8, "reason": "Wasserschaden Regal 3"},
    )
    assert defect.status_code == 200, defect.text
    assert defect.json()["stock_total"] == 92

    _deliver_order(
        client, admin_token, supplier_id=supplier["id"], article_id=article["id"], quantity=20
    )

    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 112, "the Schwund booking came back"
    assert after["stock_available"] == 112
    _assert_invariant(after)


def test_a_delivery_does_not_reverse_an_inventur_count(
    client: TestClient, admin_token: str
) -> None:
    """The absolute case, both directions: a stock-take that counted MORE than
    the snapshot must survive the next delivery just as the shrinkage did."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Schuko-Steckdose", stock=40)

    counted = client.post(
        f"{BASE}/articles/{article['id']}/movements",
        headers=auth_headers(admin_token),
        json={"kind": "inventory", "target_total": 47, "reason": "Inventur 2026"},
    )
    assert counted.status_code == 200, counted.text
    assert counted.json()["stock_total"] == 47

    _deliver_order(
        client, admin_token, supplier_id=supplier["id"], article_id=article["id"], quantity=5
    )

    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 52
    assert after["stock_available"] == 52
    _assert_invariant(after)


def test_a_delivery_keeps_the_sign_of_a_correction(
    client: TestClient, admin_token: str
) -> None:
    """``correction`` is a write-off of something checked out: −total, −out.

    The delivery path counted it as an arrival, so a tool confirmed lost was
    added back to the total by the next Wareneingang — and because the same
    aggregation rebuilt ``stock_out`` from a different pair of sums, the four
    counters stopped adding up.
    """

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Bohrhammer", stock=10)
    _book(article["id"], "checkout", 4)
    _book(article["id"], "correction", 2)

    before = _get(client, admin_token, article["id"])
    assert (before["stock_total"], before["stock_out"], before["stock_available"]) == (8, 2, 6)

    _deliver_order(
        client, admin_token, supplier_id=supplier["id"], article_id=article["id"], quantity=3
    )

    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 11, "the written-off tool was delivered back to us"
    assert after["stock_out"] == 2
    assert after["stock_available"] == 9
    _assert_invariant(after)


def test_a_delivery_leaves_repair_and_checkout_columns_alone(
    client: TestClient, admin_token: str
) -> None:
    """A Wareneingang says nothing about what is in a van or at the workshop —
    it may only add to ``total`` and ``available``."""

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Akkuschrauber", stock=12)
    _book(article["id"], "checkout", 5)
    _book(article["id"], "repair_out", 2)

    before = _get(client, admin_token, article["id"])
    assert (before["stock_available"], before["stock_out"], before["stock_repair"]) == (7, 3, 2)

    _deliver_order(
        client, admin_token, supplier_id=supplier["id"], article_id=article["id"], quantity=6
    )

    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 18
    assert after["stock_available"] == 13
    assert after["stock_out"] == 3
    assert after["stock_repair"] == 2
    _assert_invariant(after)


def test_the_delivery_intake_is_one_ledger_row_per_line(
    client: TestClient, admin_token: str
) -> None:
    """The delivery must still ADD the goods — a recompute that drops the
    intake would satisfy every assertion above about what must not change."""

    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattMovement

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Kabelbinder", stock=0)

    delivered = _deliver_order(
        client, admin_token, supplier_id=supplier["id"], article_id=article["id"], quantity=30
    )
    order_number = delivered["order_number"]

    with SessionLocal() as db:
        rows = list(
            db.scalars(
                select(WerkstattMovement)
                .where(WerkstattMovement.article_id == article["id"])
                .order_by(WerkstattMovement.id.asc())
            ).all()
        )
    assert [(r.movement_type, int(r.quantity)) for r in rows] == [("intake", 30)]
    assert rows[0].notes == f"Wareneingang {order_number}"
    assert rows[0].related_order_line_id == delivered["lines"][0]["id"]

    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 30
    _assert_invariant(after)


def test_two_lines_of_the_same_article_both_land(
    client: TestClient, admin_token: str
) -> None:
    """One order, the same article on two lines — the shape that makes the
    delivery loop touch one article twice inside a single transaction.

    Both intakes must reach the ledger and the snapshot must equal their sum:
    the per-line recompute reads the ledger rather than the counter it just
    wrote, so the second pass cannot overwrite the first one's arithmetic with
    a value read back from a row that has not been flushed yet.
    """

    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import WerkstattMovement

    supplier = _supplier(client, admin_token)
    article = _article(client, admin_token, "Wago 2273-204", stock=5)

    created = client.post(
        f"{BASE}/orders",
        headers=auth_headers(admin_token),
        json={
            "supplier_id": supplier["id"],
            "lines": [
                {"article_id": article["id"], "quantity_ordered": 10},
                {"article_id": article["id"], "quantity_ordered": 7},
            ],
        },
    )
    assert created.status_code == 200, created.text
    order_id = created.json()["id"]
    client.post(f"{BASE}/orders/{order_id}/mark-sent", headers=auth_headers(admin_token))
    delivered = client.post(
        f"{BASE}/orders/{order_id}/mark-delivered", headers=auth_headers(admin_token)
    )
    assert delivered.status_code == 200, delivered.text

    with SessionLocal() as db:
        rows = list(
            db.scalars(
                select(WerkstattMovement)
                .where(WerkstattMovement.article_id == article["id"])
                .order_by(WerkstattMovement.id.asc())
            ).all()
        )
    assert [(r.movement_type, int(r.quantity)) for r in rows] == [
        ("intake", 5),
        ("intake", 10),
        ("intake", 7),
    ]

    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 22
    assert after["stock_available"] == 22
    _assert_invariant(after)
