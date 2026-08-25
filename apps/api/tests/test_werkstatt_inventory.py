"""Stock-take (Inventur) — counting sessions and the stock maths they rely on.

The two behaviours pinned first are the ones that would silently corrupt a
count rather than fail loudly:

  * an article's OPENING quantity must live in the ledger, not in the snapshot
    counters. The counters are rebuilt from the ledger on every movement, so a
    scalar-assigned opening stock is erased by the next unrelated movement;
  * a stock-take reconciles what is ON THE SHELF. It must not disturb the
    checked-out or in-repair columns, which a shelf count says nothing about.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _article(client: TestClient, admin_token: str, name: str, *, stock: int = 0, ean: str | None = None) -> dict:
    payload: dict = {"item_name": name, "unit": "Stk", "stock_total": stock}
    if ean:
        payload["ean"] = ean
    resp = client.post("/api/werkstatt/articles", headers=auth_headers(admin_token), json=payload)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _get(client: TestClient, admin_token: str, article_id: int) -> dict:
    resp = client.get(f"/api/werkstatt/articles/{article_id}", headers=auth_headers(admin_token))
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_opening_stock_survives_a_later_movement(client: TestClient, admin_token: str) -> None:
    """The regression: opening stock used to be assigned straight onto
    stock_total/stock_available with no ledger row. The next movement called
    recompute_article_stock, which rebuilds every counter from the ledger
    alone — and silently reset the opening quantity to zero."""

    article = _article(client, admin_token, "Kabelbinder 200mm", stock=40)
    assert article["stock_total"] == 40
    assert article["stock_available"] == 40

    # Any unrelated movement forces a full recompute from the ledger.
    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle
    from app.services.werkstatt_movements import apply_movement

    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article["id"])
        admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
        apply_movement(db, article=row, movement_type="checkout", quantity=5, user_id=admin.id)
        db.commit()

    after = _get(client, admin_token, article["id"])
    # Before the fix this read stock_total=0, stock_available=0, stock_out=5.
    assert after["stock_total"] == 40, "opening stock was erased by the recompute"
    assert after["stock_available"] == 35
    assert after["stock_out"] == 5


def test_a_shelf_count_does_not_touch_checked_out_or_repair_stock(
    client: TestClient, admin_token: str
) -> None:
    """`correction` decrements `out` as well as `total` — correct for "a
    checked-out item is confirmed lost", wrong for a shelf count. The
    inventory_* types exist so a stock-take reconciles only what it can see."""

    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle
    from app.services.werkstatt_movements import apply_movement

    article = _article(client, admin_token, "Schrauben 4x40", stock=100)
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article["id"])
        admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
        apply_movement(db, article=row, movement_type="checkout", quantity=30, user_id=admin.id)
        apply_movement(db, article=row, movement_type="repair_out", quantity=10, user_id=admin.id)
        db.commit()

    before = _get(client, admin_token, article["id"])
    assert (before["stock_available"], before["stock_out"], before["stock_repair"]) == (70, 20, 10)
    assert before["stock_total"] == 100

    # Counted 65 on the shelf where the system expected 70 — five short.
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article["id"])
        admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
        apply_movement(db, article=row, movement_type="inventory_minus", quantity=5, user_id=admin.id)
        db.commit()

    after = _get(client, admin_token, article["id"])
    assert after["stock_available"] == 65, "the shelf count should land on available"
    assert after["stock_out"] == 20, "a shelf count must not touch checked-out stock"
    assert after["stock_repair"] == 10, "a shelf count must not touch repair stock"
    assert after["stock_total"] == 95
    # The invariant the whole ledger rests on.
    assert after["stock_total"] == after["stock_available"] + after["stock_out"] + after["stock_repair"]


def test_counting_more_than_recorded_increases_stock(client: TestClient, admin_token: str) -> None:
    from sqlalchemy import select

    from app.core.db import SessionLocal
    from app.models.entities import User, WerkstattArticle
    from app.services.werkstatt_movements import apply_movement

    article = _article(client, admin_token, "Wago 221-413", stock=12)
    with SessionLocal() as db:
        row = db.get(WerkstattArticle, article["id"])
        admin = db.scalars(select(User).where(User.email == "admin@example.com")).first()
        apply_movement(db, article=row, movement_type="inventory_plus", quantity=8, user_id=admin.id)
        db.commit()

    after = _get(client, admin_token, article["id"])
    assert after["stock_total"] == 20
    assert after["stock_available"] == 20


# ──────────────────────────────────────────────────────────────────────────
# Counting sessions
# ──────────────────────────────────────────────────────────────────────────


def _session(client: TestClient, admin_token: str, name: str = "Inventur Halle 1") -> dict:
    resp = client.post(
        "/api/werkstatt/inventory/sessions", headers=auth_headers(admin_token), json={"name": name}
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _scan(client: TestClient, admin_token: str, session_id: int, code: str, qty: int = 1) -> dict:
    resp = client.post(
        f"/api/werkstatt/inventory/sessions/{session_id}/scan",
        headers=auth_headers(admin_token),
        json={"code": code, "quantity": qty},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_scanning_the_same_ean_repeatedly_is_the_quantity(
    client: TestClient, admin_token: str
) -> None:
    """The core interaction: amount is entered by scanning an item n times."""

    article = _article(client, admin_token, "Leitung NYM-J 3x1,5", stock=0, ean="4011234567890")
    session = _session(client, admin_token)

    for expected in (1, 2, 3):
        result = _scan(client, admin_token, session["id"], "4011234567890")
        assert result["status"] == "counted"
        assert result["counted_qty"] == expected, "a repeat scan must increment, not duplicate"
        assert result["article"]["id"] == article["id"]

    detail = client.get(
        f"/api/werkstatt/inventory/sessions/{session['id']}", headers=auth_headers(admin_token)
    ).json()
    assert detail["counted_articles"] == 1, "one row per article, however many scans"
    assert detail["total_units"] == 3
    assert detail["counts"][0]["scan_count"] == 3


def test_counting_does_not_move_real_stock_until_finalize(
    client: TestClient, admin_token: str
) -> None:
    """A half-finished count on a Friday must not disturb Monday's picking."""

    article = _article(client, admin_token, "Dose tief 60mm", stock=50, ean="4019876543210")
    session = _session(client, admin_token)
    for _ in range(3):
        _scan(client, admin_token, session["id"], "4019876543210")

    mid = _get(client, admin_token, article["id"])
    assert mid["stock_available"] == 50, "counting must not touch stock while the session is open"

    resp = client.post(
        f"/api/werkstatt/inventory/sessions/{session['id']}/finalize",
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    summary = resp.json()
    assert summary["adjusted"] == 1
    assert summary["units_removed"] == 47

    after = _get(client, admin_token, article["id"])
    assert after["stock_available"] == 3, "finalize books the variance"


def test_an_unknown_code_asks_for_a_name_once_and_then_counts(
    client: TestClient, admin_token: str
) -> None:
    session = _session(client, admin_token)
    first = _scan(client, admin_token, session["id"], "9999999999999")
    assert first["status"] == "needs_name"
    assert first["article"] is None

    named = client.post(
        f"/api/werkstatt/inventory/sessions/{session['id']}/articles",
        headers=auth_headers(admin_token),
        json={"code": "9999999999999", "item_name": "Sonderklemme", "unit": "Stk", "quantity": 2},
    )
    assert named.status_code == 200, named.text
    assert named.json()["counted_qty"] == 2

    # The very next scan of that code resolves — the interruption happens once.
    again = _scan(client, admin_token, session["id"], "9999999999999")
    assert again["status"] == "counted"
    assert again["counted_qty"] == 3


def test_a_finalized_session_refuses_further_counting(client: TestClient, admin_token: str) -> None:
    _article(client, admin_token, "Schelle 16mm", stock=5, ean="4015555555555")
    session = _session(client, admin_token)
    _scan(client, admin_token, session["id"], "4015555555555")
    client.post(
        f"/api/werkstatt/inventory/sessions/{session['id']}/finalize",
        headers=auth_headers(admin_token),
    )

    closed = _scan(client, admin_token, session["id"], "4015555555555")
    assert closed["status"] == "session_closed"
    again = client.post(
        f"/api/werkstatt/inventory/sessions/{session['id']}/finalize",
        headers=auth_headers(admin_token),
    )
    assert again.status_code == 409


def test_a_typed_correction_replaces_the_count_but_keeps_the_scan_history(
    client: TestClient, admin_token: str
) -> None:
    article = _article(client, admin_token, "Kabelkanal 40x40", stock=0, ean="4016666666666")
    session = _session(client, admin_token)
    for _ in range(4):
        _scan(client, admin_token, session["id"], "4016666666666")

    fixed = client.patch(
        f"/api/werkstatt/inventory/sessions/{session['id']}/counts/{article['id']}",
        headers=auth_headers(admin_token),
        json={"counted_qty": 12},
    )
    assert fixed.status_code == 200, fixed.text
    body = fixed.json()
    assert body["counted_qty"] == 12
    assert body["scan_count"] == 4, "a typed correction does not rewrite how many scans happened"
    assert body["delta"] == 12
