"""Tests for the Mobile BE Werkstatt endpoints.

Covers:
  - Scan cascade (all 6 branches) — the ordering is load-bearing, so each
    branch gets a dedicated happy-path test.
  - Quick checkout / return flows (happy-path + error cases)
  - ``my-checkouts`` outstanding-balance math
  - Movements list permission check

The tests follow the sibling ``test_werkstatt_tablet.py`` convention: all
DB seeding happens inside a single ``with SessionLocal()`` block that is
committed *before* any TestClient request, so the fixture's autouse
``reset_db`` between-tests cleanup never collides with an open session.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.db import SessionLocal, engine
from app.core.security import get_password_hash
from app.core.time import utcnow
from app.models.entities import (
    MaterialCatalogItem,
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattMovement,
    WerkstattSupplier,
)


# ──────────────────────────────────────────────────────────────────────────
# Local fixtures
# ──────────────────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_sqla_pool_between_tests():
    """Force a fresh SQLAlchemy connection pool before each test body.

    The autouse ``reset_db`` fixture in the shared ``conftest.py`` runs a
    DELETE-all under ``engine.begin()``. On SQLite, when the connection
    pool hands that connection back to our test's ``SessionLocal()``, the
    next INSERT sometimes fails with
    ``sqlite3.OperationalError: attempt to write a readonly database``.
    Disposing the pool once after ``reset_db`` has finished but before
    our test starts forces a new connection to be minted, which sidesteps
    the flake. We do NOT dispose on teardown — leaving that to the next
    test's pre-dispose — because disposing after teardown was observed
    to occasionally race with the session-scoped ``migrate_schema``
    fixture and trigger a spurious "schema not ready" error.
    """

    engine.dispose()
    yield


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _admin_login(client: TestClient) -> str:
    """Admin login inline. Returns a bearer token.

    We deliberately DO NOT use the ``admin_token`` fixture from
    ``conftest.py`` — evaluating that fixture before the test body runs
    was observed to cause flaky "attempt to write a readonly database"
    errors on the SQLite test DB when the test body then opens its own
    ``SessionLocal`` to seed fixtures. Logging in inline (same pattern
    as ``test_werkstatt_tablet.py``) avoids the issue entirely.
    """

    response = client.post(
        "/api/auth/login",
        json={"email": "admin@example.com", "password": "ChangeMe123!"},
    )
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _create_user(client: TestClient, admin_token: str, email: str) -> dict:
    response = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": "Mobile Tester",
            "role": "employee",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post(
        "/api/auth/login",
        json={"email": email, "password": "Password123!"},
    )
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


class _SeedSession:
    """Thin context-manager wrapper around ``SessionLocal`` that commits on
    a clean exit and rolls back on error. Mirrors the seeding pattern used
    in ``test_werkstatt_tablet.py``."""

    def __enter__(self) -> Session:
        self._session = SessionLocal()
        return self._session

    def __exit__(self, exc_type, exc, tb) -> None:
        try:
            if exc_type is None:
                self._session.commit()
            else:
                self._session.rollback()
        finally:
            self._session.close()


def _seed_scaffold_user(db: Session) -> User:
    """Create the shared "intake scaffolding" user. Required so seed
    ``intake`` movements aren't attributed to the admin user (which would
    pollute the admin's movements list in per-caller tests)."""

    user = User(
        email="ws-scaffold@example.com",
        password_hash=get_password_hash("unused-Password123!"),
        full_name="Werkstatt Scaffold",
        role="employee",
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _seed_article(
    db: Session,
    *,
    scaffold_user: User,
    article_number: str = "SP-0001",
    ean: str | None = None,
    item_name: str = "Bosch Bohrhammer",
    stock_total: int = 5,
    stock_available: int | None = None,
    stock_out: int = 0,
    supplier_article_no: str | None = None,
) -> WerkstattArticle:
    """Seed one supplier + article + optional supplier link and an
    ``intake`` ledger row so ``recompute_article_stock`` reproduces the
    same snapshot counters after the first API-initiated movement."""

    supplier = WerkstattSupplier(name=f"Acme Supply for {article_number}")
    db.add(supplier)
    db.flush()

    article = WerkstattArticle(
        article_number=article_number,
        ean=ean,
        item_name=item_name,
        unit="Stk",
        stock_total=stock_total,
        stock_available=stock_total if stock_available is None else stock_available,
        stock_out=stock_out,
        stock_repair=0,
        stock_min=1,
        currency="EUR",
    )
    db.add(article)
    db.flush()

    if stock_total > 0:
        db.add(
            WerkstattMovement(
                article_id=article.id,
                movement_type="intake",
                quantity=stock_total,
                user_id=scaffold_user.id,
                created_at=utcnow(),
                notes="scaffold-intake",
            )
        )
    if supplier_article_no is not None:
        db.add(
            WerkstattArticleSupplier(
                article_id=article.id,
                supplier_id=supplier.id,
                supplier_article_no=supplier_article_no,
            )
        )
    db.flush()
    return article


def _seed_catalog_item(
    db: Session,
    *,
    external_key: str,
    article_no: str | None = None,
    ean: str | None = None,
    item_name: str = "Catalog Widget",
) -> MaterialCatalogItem:
    row = MaterialCatalogItem(
        external_key=external_key,
        source_file="test.csv",
        source_line=1,
        article_no=article_no,
        item_name=item_name,
        ean=ean,
        search_text=f"{article_no or ''} {ean or ''} {item_name}".lower(),
    )
    db.add(row)
    db.flush()
    return row


# ──────────────────────────────────────────────────────────────────────────
# §3.1 Scan cascade — six branches
# ──────────────────────────────────────────────────────────────────────────


def test_scan_branch_1_sp_number(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        _seed_article(db, scaffold_user=scaffold, article_number="SP-0001", ean="1111111111111")

    resp = client.get(
        "/api/werkstatt/scan/resolve",
        headers=_auth(admin_token),
        params={"code": "SP-0001"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "werkstatt_article"
    assert data["matched_by"] == "sp"
    assert data["article"]["article_number"] == "SP-0001"


def test_scan_branch_2_ean(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        _seed_article(db, scaffold_user=scaffold, article_number="SP-0010", ean="4003333000012")

    resp = client.get(
        "/api/werkstatt/scan/resolve",
        headers=_auth(admin_token),
        params={"code": "4003333000012"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "werkstatt_article"
    assert data["matched_by"] == "ean"
    assert data["article"]["ean"] == "4003333000012"


def test_scan_branch_3_supplier_article_no(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        _seed_article(
            db,
            scaffold_user=scaffold,
            article_number="SP-0020",
            supplier_article_no="ACME-XYZ-42",
        )

    resp = client.get(
        "/api/werkstatt/scan/resolve",
        headers=_auth(admin_token),
        params={"code": "ACME-XYZ-42"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "werkstatt_article"
    assert data["matched_by"] == "supplier_no"
    assert data["article"]["article_number"] == "SP-0020"


def test_scan_branch_4_catalog_ean_multiple(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        _seed_catalog_item(db, external_key="k1", article_no="A1", ean="9999999999999", item_name="Supplier A row")
        _seed_catalog_item(db, external_key="k2", article_no="A2", ean="9999999999999", item_name="Supplier B row")

    resp = client.get(
        "/api/werkstatt/scan/resolve",
        headers=_auth(admin_token),
        params={"code": "9999999999999"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "catalog_match"
    assert data["matched_by"] == "catalog_ean"
    assert len(data["catalog_items"]) == 2
    assert {row["item_name"] for row in data["catalog_items"]} == {
        "Supplier A row",
        "Supplier B row",
    }


def test_scan_branch_5_catalog_article_no(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        _seed_catalog_item(db, external_key="k1", article_no="ARTX-777", item_name="Foo")

    resp = client.get(
        "/api/werkstatt/scan/resolve",
        headers=_auth(admin_token),
        params={"code": "ARTX-777"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "catalog_match"
    assert data["matched_by"] == "catalog_article_no"
    assert len(data["catalog_items"]) == 1
    assert data["catalog_items"][0]["article_no"] == "ARTX-777"


def test_scan_branch_6_not_found(client: TestClient):
    admin_token = _admin_login(client)
    resp = client.get(
        "/api/werkstatt/scan/resolve",
        headers=_auth(admin_token),
        params={"code": "does-not-exist-0000"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "not_found"
    assert data["code"] == "does-not-exist-0000"


def test_scan_prefers_sp_over_ean_when_both_match(client: TestClient):
    admin_token = _admin_login(client)
    """Ordering guarantee: if SP-Nr matches, we never fall through to EAN."""

    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        _seed_article(
            db,
            scaffold_user=scaffold,
            article_number="12345678",
            ean=None,
            item_name="SP row",
        )
        _seed_article(
            db,
            scaffold_user=scaffold,
            article_number="SP-EAN-Row",
            ean="12345678",
            item_name="EAN row",
        )

    resp = client.get(
        "/api/werkstatt/scan/resolve",
        headers=_auth(admin_token),
        params={"code": "12345678"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "werkstatt_article"
    assert data["matched_by"] == "sp"
    assert data["article"]["item_name"] == "SP row"


def test_scan_requires_authentication(client: TestClient):
    resp = client.get("/api/werkstatt/scan/resolve", params={"code": "anything"})
    assert resp.status_code == 401


# ──────────────────────────────────────────────────────────────────────────
# §3.2 Quick checkout / return
# ──────────────────────────────────────────────────────────────────────────


def test_checkout_happy_path(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, stock_total=5)
        article_id = article.id

    resp = client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 2, "notes": "Baustelle X"},
    )
    assert resp.status_code == 200, resp.text
    article = resp.json()
    assert article["stock_available"] == 3
    assert article["stock_out"] == 2
    assert article["stock_total"] == 5


def test_checkout_exceeding_available_is_400(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, stock_total=1)
        article_id = article.id

    resp = client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 5},
    )
    assert resp.status_code == 400, resp.text
    assert "exceeds stock_available" in resp.json()["detail"]


def test_return_ok_condition_restores_stock(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, stock_total=3)
        article_id = article.id

    r1 = client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 2},
    )
    assert r1.status_code == 200, r1.text

    r2 = client.post(
        "/api/werkstatt/mobile/return",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 2, "condition": "ok"},
    )
    assert r2.status_code == 200, r2.text
    article = r2.json()
    assert article["stock_available"] == 3
    assert article["stock_out"] == 0


def test_return_repair_condition_moves_to_repair(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, stock_total=3)
        article_id = article.id

    client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 2},
    )
    resp = client.post(
        "/api/werkstatt/mobile/return",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 1, "condition": "repair"},
    )
    assert resp.status_code == 200, resp.text
    article = resp.json()
    assert article["stock_out"] == 1
    assert article["stock_repair"] == 1
    # Total unchanged — repair doesn't destroy the item.
    assert article["stock_total"] == 3


def test_return_lost_condition_shrinks_total(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, stock_total=3)
        article_id = article.id

    client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 2},
    )
    resp = client.post(
        "/api/werkstatt/mobile/return",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 1, "condition": "lost"},
    )
    assert resp.status_code == 200, resp.text
    article = resp.json()
    assert article["stock_total"] == 2
    assert article["stock_out"] == 1


def test_checkout_on_unknown_article_is_404(client: TestClient):
    admin_token = _admin_login(client)
    resp = client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": 999_999, "quantity": 1},
    )
    assert resp.status_code == 404


# ──────────────────────────────────────────────────────────────────────────
# /mobile/movements and /mobile/my-checkouts
# ──────────────────────────────────────────────────────────────────────────


def test_movements_list_defaults_to_caller_only(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article = _seed_article(db, scaffold_user=scaffold, stock_total=5)
        article_id = article.id

    # Admin performs one checkout.
    client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_id, "quantity": 1},
    )

    # Second user has no movements.
    other = _create_user(client, admin_token, "mob-other@example.com")
    other_token = _login(client, other["email"])

    r = client.get(
        "/api/werkstatt/mobile/movements",
        headers=_auth(other_token),
        params={"limit": 10},
    )
    assert r.status_code == 200
    assert r.json() == []

    # Admin sees their own movement only (scaffold intake is filtered out
    # because it's attributed to the scaffold user).
    r2 = client.get(
        "/api/werkstatt/mobile/movements",
        headers=_auth(admin_token),
        params={"limit": 10},
    )
    assert r2.status_code == 200
    body = r2.json()
    assert len(body) == 1
    assert body[0]["movement_type"] == "checkout"
    assert body[0]["quantity"] == 1


def test_movements_all_requires_manage_permission(client: TestClient):
    admin_token = _admin_login(client)
    other = _create_user(client, admin_token, "mob-nomgr@example.com")
    other_token = _login(client, other["email"])
    r = client.get(
        "/api/werkstatt/mobile/movements",
        headers=_auth(other_token),
        params={"all": "true"},
    )
    assert r.status_code == 403


def test_my_checkouts_only_shows_outstanding(client: TestClient):
    admin_token = _admin_login(client)
    with _SeedSession() as db:
        scaffold = _seed_scaffold_user(db)
        article_a = _seed_article(db, scaffold_user=scaffold, article_number="SP-A", stock_total=5)
        article_b = _seed_article(db, scaffold_user=scaffold, article_number="SP-B", stock_total=5)
        article_a_id = article_a.id
        article_b_id = article_b.id

    # Two checkouts on A that are fully returned, one on B that's still open.
    client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_a_id, "quantity": 2},
    )
    client.post(
        "/api/werkstatt/mobile/return",
        headers=_auth(admin_token),
        json={"article_id": article_a_id, "quantity": 2, "condition": "ok"},
    )
    client.post(
        "/api/werkstatt/mobile/checkout",
        headers=_auth(admin_token),
        json={"article_id": article_b_id, "quantity": 1},
    )
    resp = client.get(
        "/api/werkstatt/mobile/my-checkouts",
        headers=_auth(admin_token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Only article B should appear — A is fully returned.
    assert len(body) == 1
    assert body[0]["article_number"] == "SP-B"
    assert body[0]["quantity_out"] == 1
