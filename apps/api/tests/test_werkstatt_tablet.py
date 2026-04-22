"""Tests for the Werkstatt Tablet persona API (orders, reorder, inspections).

Covers:
  - Happy paths for every endpoint.
  - The order status machine (valid + invalid transitions → 409).
  - Reorder suggestion engine (preferred vs fallback supplier, subtotal,
    minimum order quantity honoured).
  - BG-Prüfung recording (next_bg_due_at recompute, correction movement).
  - RBAC: employees without werkstatt:manage may not mutate.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.core.permissions import set_user_permissions_override
from app.core.time import utcnow
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattMovement,
    WerkstattOrder,
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.services.werkstatt_orders import (
    ALLOWED_TRANSITIONS,
    generate_order_number,
    transition_order,
)


# ──────────────────────────────────────────────────────────────────────────
# Fixtures / helpers
# ──────────────────────────────────────────────────────────────────────────


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login_admin(client: TestClient) -> str:
    resp = client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "ChangeMe123!"},
    )
    assert resp.status_code == 200
    return resp.headers["X-Access-Token"]


def _grant_werkstatt_to_admin(db) -> int:
    admin = db.scalar(
        __import__("sqlalchemy").select(User).where(User.email == "admin@example.com")
    )
    assert admin is not None
    set_user_permissions_override({admin.id: {"extra": ["werkstatt:manage"], "denied": []}})
    return admin.id


def _seed_supplier(db, *, name="Acme GmbH", lead_days=5) -> WerkstattSupplier:
    supplier = WerkstattSupplier(
        name=name,
        short_name=name[:3].upper(),
        default_lead_time_days=lead_days,
    )
    db.add(supplier)
    db.flush()
    return supplier


def _seed_article(
    db,
    *,
    article_number: str,
    name: str = "Hammer",
    stock_total: int = 10,
    stock_min: int = 5,
    bg_required: bool = False,
    bg_interval: int | None = None,
    bg_next_due: datetime | None = None,
) -> WerkstattArticle:
    article = WerkstattArticle(
        article_number=article_number,
        item_name=name,
        stock_total=stock_total,
        stock_available=stock_total,
        stock_min=stock_min,
        bg_inspection_required=bg_required,
        bg_inspection_interval_days=bg_interval,
        next_bg_due_at=bg_next_due,
    )
    db.add(article)
    db.flush()
    return article


def _seed_link(
    db,
    *,
    article: WerkstattArticle,
    supplier: WerkstattSupplier,
    price: int | None = 100,
    moq: int = 1,
    preferred: bool = False,
    lead_override: int | None = None,
) -> WerkstattArticleSupplier:
    link = WerkstattArticleSupplier(
        article_id=article.id,
        supplier_id=supplier.id,
        typical_price_cents=price,
        minimum_order_quantity=moq,
        is_preferred=preferred,
        typical_lead_time_days=lead_override,
    )
    db.add(link)
    db.flush()
    return link


# ──────────────────────────────────────────────────────────────────────────
# Service-level unit tests (no HTTP)
# ──────────────────────────────────────────────────────────────────────────


def test_generate_order_number_resets_per_year(client: TestClient):
    # Uses the shared fixture DB; the reset_db autouse fixture keeps rows clean.
    with SessionLocal() as db:
        admin = db.scalar(
            __import__("sqlalchemy").select(User).where(User.email == "admin@example.com")
        )
        assert admin is not None
        supplier = _seed_supplier(db)
        db.commit()

        n1 = generate_order_number(db, now=datetime(2026, 6, 1))
        assert n1 == "BST-2026-0001"

        # Persist a few rows to check increment.
        for seq in (1, 2, 3):
            db.add(
                WerkstattOrder(
                    order_number=f"BST-2026-{seq:04d}",
                    supplier_id=supplier.id,
                    status="draft",
                    created_by=admin.id,
                )
            )
        db.flush()
        assert generate_order_number(db, now=datetime(2026, 6, 1)) == "BST-2026-0004"

        # Different year resets to 0001.
        assert generate_order_number(db, now=datetime(2027, 1, 1)) == "BST-2027-0001"


def test_transition_order_rejects_invalid_transitions(client: TestClient):
    """The status machine must raise 409 for every non-adjacent move."""

    import fastapi
    from sqlalchemy import select

    # Exhaustive matrix: for each (current, new) pair, only those in the
    # ALLOWED_TRANSITIONS map should succeed. Each iteration uses its own
    # session so a raised HTTPException never leaves a half-open txn.
    for current, allowed in ALLOWED_TRANSITIONS.items():
        for target in ALLOWED_TRANSITIONS.keys():
            with SessionLocal() as db:
                admin = db.scalar(select(User).where(User.email == "admin@example.com"))
                assert admin is not None
                supplier = _seed_supplier(db, name=f"Sup-{current}-{target}")
                order = WerkstattOrder(
                    order_number=f"BST-TEST-{current}-{target}",
                    supplier_id=supplier.id,
                    status=current,
                    created_by=admin.id,
                )
                db.add(order)
                db.flush()

                if target == current:
                    raised = False
                    try:
                        transition_order(db, order, target, actor_id=admin.id)
                    except fastapi.HTTPException as exc:
                        raised = True
                        assert exc.status_code == 409
                    assert raised, f"No-op transition {current}->{target} should raise"
                elif target in allowed:
                    transition_order(db, order, target, actor_id=admin.id)
                    assert order.status == target
                else:
                    raised = False
                    try:
                        transition_order(db, order, target, actor_id=admin.id)
                    except fastapi.HTTPException as exc:
                        raised = True
                        assert exc.status_code == 409
                    assert raised, f"Illegal transition {current}->{target} should 409"

                db.rollback()


# ──────────────────────────────────────────────────────────────────────────
# Reorder endpoint tests
# ──────────────────────────────────────────────────────────────────────────


def test_reorder_suggestions_groups_by_preferred_supplier(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)

        supplier_a = _seed_supplier(db, name="Alpha Supplies", lead_days=3)
        supplier_b = _seed_supplier(db, name="Beta Supplies", lead_days=7)

        # Article 1 is low: 2 < min 5.
        article1 = _seed_article(
            db, article_number="SP-0001", stock_total=2, stock_min=5
        )
        _seed_link(db, article=article1, supplier=supplier_a, price=500, preferred=True)
        _seed_link(db, article=article1, supplier=supplier_b, price=300, preferred=False)

        # Article 2 is low: 0 < min 2; only Beta supplier → grouped there.
        article2 = _seed_article(
            db, article_number="SP-0002", stock_total=0, stock_min=2
        )
        _seed_link(db, article=article2, supplier=supplier_b, price=250, moq=3)

        # Article 3 is fine (above min).
        article3 = _seed_article(
            db, article_number="SP-0003", stock_total=10, stock_min=5
        )
        _seed_link(db, article=article3, supplier=supplier_a, price=800, preferred=True)

        db.commit()

    resp = client.get("/api/werkstatt/reorder/suggestions", headers=auth_headers(token))
    assert resp.status_code == 200
    groups = resp.json()
    assert len(groups) == 2

    by_name = {g["supplier_name"]: g for g in groups}
    assert "Alpha Supplies" in by_name and "Beta Supplies" in by_name

    alpha = by_name["Alpha Supplies"]
    assert len(alpha["lines"]) == 1
    assert alpha["lines"][0]["article_number"] == "SP-0001"
    # suggested = max(5*2 - 2, 1) = 8
    assert alpha["lines"][0]["suggested_quantity"] == 8
    # subtotal = 8 * 500
    assert alpha["subtotal_cents"] == 4000
    assert alpha["default_lead_time_days"] == 3

    beta = by_name["Beta Supplies"]
    assert len(beta["lines"]) == 1
    assert beta["lines"][0]["article_number"] == "SP-0002"
    # suggested = max(2*2 - 0, 3) = 4
    assert beta["lines"][0]["suggested_quantity"] == 4


def test_reorder_suggestions_fallback_to_cheapest_when_no_preferred(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier_a = _seed_supplier(db, name="Alpha Supplies")
        supplier_b = _seed_supplier(db, name="Beta Supplies")
        article = _seed_article(
            db, article_number="SP-1000", stock_total=0, stock_min=3
        )
        _seed_link(db, article=article, supplier=supplier_a, price=900, preferred=False)
        _seed_link(db, article=article, supplier=supplier_b, price=500, preferred=False)
        db.commit()

    resp = client.get("/api/werkstatt/reorder/suggestions", headers=auth_headers(token))
    assert resp.status_code == 200
    groups = resp.json()
    assert len(groups) == 1
    assert groups[0]["supplier_name"] == "Beta Supplies"  # cheaper wins


def test_reorder_suggestions_skips_archived_supplier(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        archived = _seed_supplier(db, name="Archived Inc")
        archived.is_archived = True
        supplier_ok = _seed_supplier(db, name="Zulu Supplies")
        article = _seed_article(
            db, article_number="SP-2000", stock_total=0, stock_min=2
        )
        _seed_link(db, article=article, supplier=archived, price=100, preferred=True)
        _seed_link(db, article=article, supplier=supplier_ok, price=200)
        db.commit()

    resp = client.get("/api/werkstatt/reorder/suggestions", headers=auth_headers(token))
    assert resp.status_code == 200
    groups = resp.json()
    assert len(groups) == 1
    assert groups[0]["supplier_name"] == "Zulu Supplies"


def test_reorder_submit_creates_sent_order_with_expected_delivery(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier = _seed_supplier(db, name="Acme GmbH", lead_days=7)
        article1 = _seed_article(
            db, article_number="SP-0100", stock_total=0, stock_min=4
        )
        _seed_link(db, article=article1, supplier=supplier, price=250)
        db.commit()
        article1_id = article1.id
        supplier_id = supplier.id

    resp = client.post(
        "/api/werkstatt/reorder/submit",
        headers=auth_headers(token),
        json={
            "supplier_id": supplier_id,
            "lines": [{"article_id": article1_id, "quantity": 10}],
            "notes": "Hello",
        },
    )
    assert resp.status_code == 200, resp.text
    order = resp.json()
    assert order["status"] == "sent"
    assert order["ordered_at"] is not None
    assert order["expected_delivery_at"] is not None
    assert order["order_number"].startswith("BST-")
    assert len(order["lines"]) == 1
    assert order["lines"][0]["quantity_ordered"] == 10
    assert order["lines"][0]["unit_price_cents"] == 250
    assert order["total_amount_cents"] == 2500


def test_reorder_submit_requires_werkstatt_permission(client: TestClient):
    # Create an employee without werkstatt:manage.
    token_admin = _login_admin(client)
    resp = client.post(
        "/api/admin/users",
        headers=auth_headers(token_admin),
        json={
            "email": "empl@example.com",
            "password": "Password123!",
            "full_name": "Empl",
            "role": "employee",
        },
    )
    assert resp.status_code == 200
    login = client.post(
        "/api/auth/login",
        json={"email": "empl@example.com", "password": "Password123!"},
    )
    employee_token = login.headers["X-Access-Token"]

    with SessionLocal() as db:
        supplier = _seed_supplier(db)
        article = _seed_article(db, article_number="SP-9999")
        _seed_link(db, article=article, supplier=supplier)
        db.commit()
        supplier_id = supplier.id
        article_id = article.id

    resp = client.post(
        "/api/werkstatt/reorder/submit",
        headers=auth_headers(employee_token),
        json={
            "supplier_id": supplier_id,
            "lines": [{"article_id": article_id, "quantity": 1}],
        },
    )
    assert resp.status_code == 403


# ──────────────────────────────────────────────────────────────────────────
# Orders endpoint tests
# ──────────────────────────────────────────────────────────────────────────


def _create_draft_order(client: TestClient, token: str, supplier_id: int, article_id: int) -> dict:
    resp = client.post(
        "/api/werkstatt/orders",
        headers=auth_headers(token),
        json={
            "supplier_id": supplier_id,
            "lines": [
                {"article_id": article_id, "quantity_ordered": 3, "unit_price_cents": 500}
            ],
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_create_get_patch_order_happy_path(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier = _seed_supplier(db, lead_days=4)
        article = _seed_article(db, article_number="SP-3000", stock_total=0, stock_min=2)
        _seed_link(db, article=article, supplier=supplier, price=500)
        db.commit()
        s_id, a_id = supplier.id, article.id

    created = _create_draft_order(client, token, s_id, a_id)
    assert created["status"] == "draft"
    assert created["total_amount_cents"] == 1500
    oid = created["id"]

    fetched = client.get(f"/api/werkstatt/orders/{oid}", headers=auth_headers(token))
    assert fetched.status_code == 200
    assert fetched.json()["order_number"] == created["order_number"]

    patched = client.patch(
        f"/api/werkstatt/orders/{oid}",
        headers=auth_headers(token),
        json={"notes": "Bitte schnell", "delivery_reference": "LS-42"},
    )
    assert patched.status_code == 200
    assert patched.json()["notes"] == "Bitte schnell"
    assert patched.json()["delivery_reference"] == "LS-42"


def test_list_orders_filters_by_status_and_supplier(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier1 = _seed_supplier(db, name="S1")
        supplier2 = _seed_supplier(db, name="S2")
        article = _seed_article(db, article_number="SP-LIST")
        _seed_link(db, article=article, supplier=supplier1)
        _seed_link(db, article=article, supplier=supplier2)
        db.commit()
        s1, s2, a_id = supplier1.id, supplier2.id, article.id

    _create_draft_order(client, token, s1, a_id)
    o2 = _create_draft_order(client, token, s2, a_id)

    # Mark the second one sent.
    client.post(f"/api/werkstatt/orders/{o2['id']}/mark-sent", headers=auth_headers(token))

    all_orders = client.get("/api/werkstatt/orders", headers=auth_headers(token)).json()
    assert len(all_orders) == 2

    draft_only = client.get(
        "/api/werkstatt/orders?status=draft", headers=auth_headers(token)
    ).json()
    assert len(draft_only) == 1
    assert draft_only[0]["status"] == "draft"

    s1_only = client.get(
        f"/api/werkstatt/orders?supplier_id={s1}", headers=auth_headers(token)
    ).json()
    assert len(s1_only) == 1
    assert s1_only[0]["supplier_name"] == "S1"


def test_mark_sent_stamps_timestamps_and_computes_expected(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier = _seed_supplier(db, lead_days=10)
        article = _seed_article(db, article_number="SP-SENT")
        _seed_link(db, article=article, supplier=supplier, lead_override=14)
        db.commit()
        s_id, a_id = supplier.id, article.id

    draft = _create_draft_order(client, token, s_id, a_id)
    resp = client.post(
        f"/api/werkstatt/orders/{draft['id']}/mark-sent", headers=auth_headers(token)
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "sent"
    assert body["ordered_at"] is not None
    assert body["expected_delivery_at"] is not None
    ordered = datetime.fromisoformat(body["ordered_at"])
    expected = datetime.fromisoformat(body["expected_delivery_at"])
    # 14-day per-link override wins over 10-day supplier default.
    assert (expected - ordered).days == 14


def test_mark_delivered_creates_intake_and_updates_stock(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier = _seed_supplier(db)
        article = _seed_article(
            db, article_number="SP-DELI", stock_total=2, stock_min=1
        )
        _seed_link(db, article=article, supplier=supplier)
        db.commit()
        s_id, a_id = supplier.id, article.id

    draft = _create_draft_order(client, token, s_id, a_id)
    # Draft has quantity_ordered=3, so after delivery stock_available should be 3
    # (since we start with stock_total=2, stock_available=2 (no existing
    # movements) the movement-based recompute resets to 3 because only intake
    # movements exist in the ledger — the seeded counters are wiped).
    client.post(f"/api/werkstatt/orders/{draft['id']}/mark-sent", headers=auth_headers(token))
    resp = client.post(
        f"/api/werkstatt/orders/{draft['id']}/mark-delivered",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "delivered"
    assert body["delivered_at"] is not None
    assert body["lines"][0]["quantity_received"] == 3
    assert body["lines"][0]["line_status"] == "complete"

    with SessionLocal() as db:
        movements = list(
            db.scalars(
                __import__("sqlalchemy")
                .select(WerkstattMovement)
                .where(WerkstattMovement.article_id == a_id)
            ).all()
        )
        assert len(movements) == 1
        m = movements[0]
        assert m.movement_type == "intake"
        assert m.quantity == 3
        assert m.related_order_line_id is not None

        article = db.get(WerkstattArticle, a_id)
        assert article.stock_total == 3
        assert article.stock_available == 3


def test_mark_delivered_twice_is_idempotent(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier = _seed_supplier(db)
        article = _seed_article(db, article_number="SP-IDEM")
        _seed_link(db, article=article, supplier=supplier)
        db.commit()
        s_id, a_id = supplier.id, article.id

    draft = _create_draft_order(client, token, s_id, a_id)
    client.post(f"/api/werkstatt/orders/{draft['id']}/mark-sent", headers=auth_headers(token))
    client.post(
        f"/api/werkstatt/orders/{draft['id']}/mark-delivered",
        headers=auth_headers(token),
    )
    # Second mark-delivered should 409 because terminal.
    again = client.post(
        f"/api/werkstatt/orders/{draft['id']}/mark-delivered",
        headers=auth_headers(token),
    )
    assert again.status_code == 409

    # But finalize_delivery itself is idempotent — check only one movement.
    with SessionLocal() as db:
        movements = list(
            db.scalars(
                __import__("sqlalchemy")
                .select(WerkstattMovement)
                .where(WerkstattMovement.article_id == a_id)
            ).all()
        )
        assert len(movements) == 1


def test_mark_sent_on_already_sent_order_returns_409(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier = _seed_supplier(db)
        article = _seed_article(db, article_number="SP-SS")
        _seed_link(db, article=article, supplier=supplier)
        db.commit()
        s_id, a_id = supplier.id, article.id

    draft = _create_draft_order(client, token, s_id, a_id)
    first = client.post(
        f"/api/werkstatt/orders/{draft['id']}/mark-sent", headers=auth_headers(token)
    )
    assert first.status_code == 200
    second = client.post(
        f"/api/werkstatt/orders/{draft['id']}/mark-sent", headers=auth_headers(token)
    )
    assert second.status_code == 409


def test_cancel_order_allowed_from_draft_and_sent_only(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier = _seed_supplier(db)
        article = _seed_article(db, article_number="SP-CAN")
        _seed_link(db, article=article, supplier=supplier)
        db.commit()
        s_id, a_id = supplier.id, article.id

    # Cancel from draft: OK.
    draft1 = _create_draft_order(client, token, s_id, a_id)
    can1 = client.post(
        f"/api/werkstatt/orders/{draft1['id']}/cancel", headers=auth_headers(token)
    )
    assert can1.status_code == 200
    assert can1.json()["status"] == "cancelled"

    # Cancel from sent: OK.
    draft2 = _create_draft_order(client, token, s_id, a_id)
    client.post(f"/api/werkstatt/orders/{draft2['id']}/mark-sent", headers=auth_headers(token))
    can2 = client.post(
        f"/api/werkstatt/orders/{draft2['id']}/cancel", headers=auth_headers(token)
    )
    assert can2.status_code == 200

    # Cancel from delivered: 409.
    draft3 = _create_draft_order(client, token, s_id, a_id)
    client.post(f"/api/werkstatt/orders/{draft3['id']}/mark-sent", headers=auth_headers(token))
    client.post(
        f"/api/werkstatt/orders/{draft3['id']}/mark-delivered", headers=auth_headers(token)
    )
    can3 = client.post(
        f"/api/werkstatt/orders/{draft3['id']}/cancel", headers=auth_headers(token)
    )
    assert can3.status_code == 409


def test_overdue_only_filter(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        supplier = _seed_supplier(db, lead_days=1)
        article = _seed_article(db, article_number="SP-OVD")
        _seed_link(db, article=article, supplier=supplier)
        db.commit()
        s_id, a_id = supplier.id, article.id

    draft = _create_draft_order(client, token, s_id, a_id)
    client.post(f"/api/werkstatt/orders/{draft['id']}/mark-sent", headers=auth_headers(token))

    with SessionLocal() as db:
        order = db.get(WerkstattOrder, draft["id"])
        assert order is not None
        # Force expected delivery into the past.
        order.expected_delivery_at = utcnow() - timedelta(days=3)
        db.add(order)
        db.commit()

    none_resp = client.get(
        "/api/werkstatt/orders?overdue_only=false", headers=auth_headers(token)
    )
    assert len(none_resp.json()) == 1

    overdue_resp = client.get(
        "/api/werkstatt/orders?overdue_only=true", headers=auth_headers(token)
    )
    items = overdue_resp.json()
    assert len(items) == 1
    assert items[0]["days_overdue"] and items[0]["days_overdue"] >= 3


# ──────────────────────────────────────────────────────────────────────────
# Inspections endpoint tests
# ──────────────────────────────────────────────────────────────────────────


def test_inspections_due_surfaces_overdue_and_due_soon(client: TestClient):
    token = _login_admin(client)
    now = utcnow()
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        _seed_article(
            db,
            article_number="SP-INSP-1",
            name="Bohrhammer",
            bg_required=True,
            bg_interval=365,
            bg_next_due=now - timedelta(days=2),  # overdue
        )
        _seed_article(
            db,
            article_number="SP-INSP-2",
            name="Leiter",
            bg_required=True,
            bg_interval=365,
            bg_next_due=now + timedelta(days=3),  # due soon
        )
        _seed_article(
            db,
            article_number="SP-INSP-3",
            name="Säge",
            bg_required=True,
            bg_interval=365,
            bg_next_due=now + timedelta(days=200),  # out of window
        )
        _seed_article(
            db,
            article_number="SP-INSP-4",
            name="Kabeltrommel",
            bg_required=True,
            bg_interval=365,
            bg_next_due=None,  # never inspected → overdue
        )
        # Not required at all → should not appear.
        _seed_article(
            db, article_number="SP-INSP-5", name="Schraube", bg_required=False
        )
        db.commit()

    resp = client.get(
        "/api/werkstatt/inspections/due?days_ahead=30", headers=auth_headers(token)
    )
    assert resp.status_code == 200
    rows = resp.json()
    numbers = {r["article_number"]: r["urgency"] for r in rows}
    assert numbers.get("SP-INSP-1") == "overdue"
    assert numbers.get("SP-INSP-2") == "due_soon"
    assert numbers.get("SP-INSP-4") == "overdue"
    assert "SP-INSP-3" not in numbers
    assert "SP-INSP-5" not in numbers


def test_record_inspection_stamps_article_and_creates_correction(client: TestClient):
    token = _login_admin(client)
    now = utcnow()
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        article = _seed_article(
            db,
            article_number="SP-REC-1",
            name="Leiter",
            bg_required=True,
            bg_interval=365,
            bg_next_due=now - timedelta(days=1),
        )
        db.commit()
        article_id = article.id

    resp = client.post(
        f"/api/werkstatt/inspections/{article_id}",
        headers=auth_headers(token),
        json={"passed": True, "notes": "Alles ok"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["last_bg_inspected_at"] is not None
    assert body["next_bg_due_at"] is not None
    # next_due ~ now + 365 days
    next_due = datetime.fromisoformat(body["next_bg_due_at"])
    assert abs((next_due - (now + timedelta(days=365))).total_seconds()) < 120

    with SessionLocal() as db:
        movements = list(
            db.scalars(
                __import__("sqlalchemy")
                .select(WerkstattMovement)
                .where(WerkstattMovement.article_id == article_id)
            ).all()
        )
        assert len(movements) == 1
        m = movements[0]
        assert m.movement_type == "correction"
        assert m.quantity == 0
        assert m.notes and m.notes.startswith("BG-Prüfung")
        assert "bestanden" in m.notes


def test_record_inspection_rejects_non_required_article(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)
        article = _seed_article(db, article_number="SP-NOBG", bg_required=False)
        db.commit()
        article_id = article.id

    resp = client.post(
        f"/api/werkstatt/inspections/{article_id}",
        headers=auth_headers(token),
        json={"passed": True},
    )
    assert resp.status_code == 400


def test_record_inspection_requires_werkstatt_permission(client: TestClient):
    token_admin = _login_admin(client)
    client.post(
        "/api/admin/users",
        headers=auth_headers(token_admin),
        json={
            "email": "empl2@example.com",
            "password": "Password123!",
            "full_name": "Empl2",
            "role": "employee",
        },
    )
    login = client.post(
        "/api/auth/login",
        json={"email": "empl2@example.com", "password": "Password123!"},
    )
    employee_token = login.headers["X-Access-Token"]

    with SessionLocal() as db:
        article = _seed_article(
            db, article_number="SP-EMP", bg_required=True, bg_interval=365
        )
        db.commit()
        article_id = article.id

    resp = client.post(
        f"/api/werkstatt/inspections/{article_id}",
        headers=auth_headers(employee_token),
        json={"passed": True},
    )
    assert resp.status_code == 403


def test_inspections_due_404_on_missing_article(client: TestClient):
    token = _login_admin(client)
    with SessionLocal() as db:
        _grant_werkstatt_to_admin(db)

    resp = client.post(
        "/api/werkstatt/inspections/99999",
        headers=auth_headers(token),
        json={"passed": True},
    )
    assert resp.status_code == 404
