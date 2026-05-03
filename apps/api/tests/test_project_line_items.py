"""Tests for the v2.4.0 ProjectLineItem CRUD endpoints (manual path).

The LLM extraction path will be tested separately when it lands. This
file covers the manual-typed-by-an-operator workflow plus the derived-
status logic — the parts you can fully exercise without any LLM
dependency.
"""
from __future__ import annotations

from decimal import Decimal

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_employee_with_projects_manage(client: TestClient, admin_token: str, email: str) -> str:
    """Helper: create an employee user, grant them projects:manage, log in.
    Returns the user's auth token. Most tests need a non-admin actor so we
    actually exercise the permission gate."""
    client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": "Line Items Test User",
            "role": "ceo",  # ceo role inherits projects:manage by default
        },
    )
    login = client.post(
        "/api/auth/login",
        json={"email": email, "password": "Password123!"},
    )
    return login.headers["X-Access-Token"]


def _create_project(client: TestClient, token: str) -> int:
    """Create a project, return its id."""
    response = client.post(
        "/api/projects",
        headers=auth_headers(token),
        json={
            "project_number": "P-LITEST-001",
            "name": "Line items test project",
            "status": "active",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_line_item_lifecycle_create_list_update_softdelete(client: TestClient, admin_token: str):
    """Full CRUD round-trip for a manually-entered line item:
    create → list (sees it) → update one field → soft-delete → list
    (excluded by default, included with include_inactive=true)."""
    user_token = _create_employee_with_projects_manage(
        client, admin_token, "lineitem-lifecycle@example.com"
    )
    project_id = _create_project(client, user_token)

    # ── create ──
    create = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(user_token),
        json={
            "type": "material",
            "section_title": "DC Montage",
            "position": "02.01",
            "description": "WINAICO WST-485BD/X54-B2 Solarmodul Backcontact",
            "sku": "WST-485BD/X54-B2",
            "manufacturer": "WINAICO",
            "quantity_required": "26.00",
            "unit": "Stck",
            "unit_price_eur": "123.69",
            "total_price_eur": "3215.94",
        },
    )
    assert create.status_code == 200, create.text
    item = create.json()
    assert item["id"] > 0
    assert item["status"] == "offen"  # nothing ordered yet → offen
    assert item["quantity_missing"] == "26.00"
    item_id = item["id"]

    # ── list (active only) ──
    listing = client.get(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(user_token),
    )
    assert listing.status_code == 200
    rows = listing.json()
    assert len(rows) == 1
    assert rows[0]["id"] == item_id

    # ── update: bump quantity_ordered to half (→ teilbestellt) ──
    update = client.patch(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(user_token),
        json={"quantity_ordered": "13.00"},
    )
    assert update.status_code == 200
    assert update.json()["status"] == "teilbestellt"
    assert update.json()["quantity_ordered"] == "13.00"

    # ── update: bump ordered to full → bestellt ──
    full_order = client.patch(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(user_token),
        json={"quantity_ordered": "26.00"},
    )
    assert full_order.json()["status"] == "bestellt"

    # ── update: half delivered → teilgeliefert ──
    half_delivered = client.patch(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(user_token),
        json={"quantity_delivered": "13.00"},
    )
    assert half_delivered.json()["status"] == "teilgeliefert"

    # ── update: fully delivered, none on site yet → vollstaendig_im_lager ──
    fully_delivered = client.patch(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(user_token),
        json={"quantity_delivered": "26.00"},
    )
    assert fully_delivered.json()["status"] == "vollstaendig_im_lager"

    # ── update: half at site → teilweise_auf_baustelle ──
    half_at_site = client.patch(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(user_token),
        json={"quantity_at_site": "13.00"},
    )
    assert half_at_site.json()["status"] == "teilweise_auf_baustelle"

    # ── update: all at site → vollstaendig_auf_baustelle ──
    all_at_site = client.patch(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(user_token),
        json={"quantity_at_site": "26.00"},
    )
    assert all_at_site.json()["status"] == "vollstaendig_auf_baustelle"

    # ── soft delete ──
    delete = client.delete(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(user_token),
    )
    assert delete.status_code == 200
    assert delete.json()["soft_deleted"] is True

    # ── list excludes by default ──
    listing_after = client.get(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(user_token),
    )
    assert listing_after.json() == []

    # ── list with include_inactive=true brings it back ──
    listing_with_inactive = client.get(
        f"/api/projects/{project_id}/line-items?include_inactive=true",
        headers=auth_headers(user_token),
    )
    rows_inactive = listing_with_inactive.json()
    assert len(rows_inactive) == 1
    assert rows_inactive[0]["is_active"] is False

    # ── soft-delete is idempotent ──
    redelete = client.delete(
        f"/api/projects/{project_id}/line-items/{item_id}",
        headers=auth_headers(user_token),
    )
    assert redelete.status_code == 200
    assert redelete.json()["soft_deleted"] is True


def test_line_item_status_offen_when_nothing_ordered(client: TestClient, admin_token: str):
    """Trivial baseline: a freshly-created item with no quantity_ordered
    must report status='offen'."""
    user_token = _create_employee_with_projects_manage(
        client, admin_token, "lineitem-status-offen@example.com"
    )
    project_id = _create_project(client, user_token)
    create = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(user_token),
        json={
            "type": "leistung",
            "description": "Montage",
            "quantity_required": "5.00",
            "unit": "Stck",
        },
    )
    assert create.status_code == 200
    assert create.json()["status"] == "offen"
    assert create.json()["quantity_missing"] == "5.00"


def test_line_item_create_rejects_negative_quantity(client: TestClient, admin_token: str):
    """Pydantic ge=0 must reject negative quantities."""
    user_token = _create_employee_with_projects_manage(
        client, admin_token, "lineitem-negq@example.com"
    )
    project_id = _create_project(client, user_token)
    create = client.post(
        f"/api/projects/{project_id}/line-items",
        headers=auth_headers(user_token),
        json={
            "type": "material",
            "description": "Bad item",
            "quantity_required": "-1.00",
        },
    )
    assert create.status_code == 422  # pydantic validation error


def test_line_item_belongs_to_correct_project(client: TestClient, admin_token: str):
    """An item created on project A must not be visible on project B
    (the project_id check in the path matters for security)."""
    user_token = _create_employee_with_projects_manage(
        client, admin_token, "lineitem-cross@example.com"
    )
    project_a = _create_project(client, user_token)
    # Second project — slight name twist to avoid project_number collision.
    project_b_response = client.post(
        "/api/projects",
        headers=auth_headers(user_token),
        json={
            "project_number": "P-LITEST-002",
            "name": "Other project",
            "status": "active",
        },
    )
    project_b = project_b_response.json()["id"]

    # Create item on project A
    create = client.post(
        f"/api/projects/{project_a}/line-items",
        headers=auth_headers(user_token),
        json={
            "type": "material",
            "description": "Belongs to A",
            "quantity_required": "1.00",
        },
    )
    item_id = create.json()["id"]

    # Try to fetch via project B's path — must 404
    cross_get = client.get(
        f"/api/projects/{project_b}/line-items/{item_id}",
        headers=auth_headers(user_token),
    )
    assert cross_get.status_code == 404

    # Same for update
    cross_update = client.patch(
        f"/api/projects/{project_b}/line-items/{item_id}",
        headers=auth_headers(user_token),
        json={"description": "hacked"},
    )
    assert cross_update.status_code == 404

    # And for delete
    cross_delete = client.delete(
        f"/api/projects/{project_b}/line-items/{item_id}",
        headers=auth_headers(user_token),
    )
    assert cross_delete.status_code == 404


def test_line_item_unauthenticated_rejected(client: TestClient, admin_token: str):
    """No auth → 401 for any endpoint. Verifies the get_current_user
    gate on the list endpoint and the require_permission gate on
    mutating endpoints.

    NOTE: TestClient carries cookies across requests within a test, so
    we must explicitly clear them after setup to simulate a fresh
    unauthenticated caller. Without the clear, the access_token cookie
    from the setup login bleeds into the supposedly-unauthenticated
    requests below."""
    # Set up a project so the path is real (not 404'd by missing project)
    user_token = _create_employee_with_projects_manage(
        client, admin_token, "lineitem-noauth@example.com"
    )
    project_id = _create_project(client, user_token)

    # Strip every credential the TestClient learned during setup.
    client.cookies.clear()

    no_auth_list = client.get(f"/api/projects/{project_id}/line-items")
    assert no_auth_list.status_code == 401

    no_auth_create = client.post(
        f"/api/projects/{project_id}/line-items",
        json={"type": "material", "description": "X", "quantity_required": "1.00"},
    )
    assert no_auth_create.status_code == 401
