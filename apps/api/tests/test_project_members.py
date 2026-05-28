"""v2.5.36 — project member management endpoints.

The member system had a DB table + one Form-based POST since the start,
but no list/delete endpoints and no UI — so projects only ever had
members when created through the UI (creator auto-added). These tests
cover the completed CRUD: list, JSON upsert, can_manage update, remove,
and the permission boundaries.
"""
from __future__ import annotations

from fastapi.testclient import TestClient


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_project(client: TestClient, admin_token: str, number: str = "MEM-1") -> int:
    r = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": number, "name": f"Project {number}", "status": "active"},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _create_employee(client: TestClient, admin_token: str, email: str) -> dict:
    r = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={"email": email, "password": "Password123!", "full_name": email.split("@")[0], "role": "employee"},
    )
    assert r.status_code == 200, r.text
    return r.json()


def _login(client: TestClient, email: str) -> str:
    r = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert r.status_code == 200, r.text
    return r.headers["X-Access-Token"]


def test_add_list_update_remove_member_flow(client: TestClient, admin_token: str):
    pid = _create_project(client, admin_token, "MEM-FLOW")
    emp = _create_employee(client, admin_token, "mem-flow@example.com")

    # Add as plain member (no manage).
    add = client.post(
        f"/api/projects/{pid}/members",
        headers=_auth(admin_token),
        json={"user_id": emp["id"], "can_manage": False},
    )
    assert add.status_code == 200, add.text
    assert add.json()["user_id"] == emp["id"]
    assert add.json()["can_manage"] is False
    assert add.json()["full_name"]  # enriched with user info

    # List includes the new member (+ the admin creator).
    listing = client.get(f"/api/projects/{pid}/members", headers=_auth(admin_token))
    assert listing.status_code == 200
    member_ids = {m["user_id"] for m in listing.json()}
    assert emp["id"] in member_ids

    # Upsert to grant can_manage.
    upd = client.post(
        f"/api/projects/{pid}/members",
        headers=_auth(admin_token),
        json={"user_id": emp["id"], "can_manage": True},
    )
    assert upd.status_code == 200
    assert upd.json()["can_manage"] is True
    # No duplicate row created — still one entry for this user.
    listing2 = client.get(f"/api/projects/{pid}/members", headers=_auth(admin_token))
    assert sum(1 for m in listing2.json() if m["user_id"] == emp["id"]) == 1

    # Remove.
    rem = client.delete(f"/api/projects/{pid}/members/{emp['id']}", headers=_auth(admin_token))
    assert rem.status_code == 204
    listing3 = client.get(f"/api/projects/{pid}/members", headers=_auth(admin_token))
    assert emp["id"] not in {m["user_id"] for m in listing3.json()}


def test_remove_nonexistent_member_is_idempotent(client: TestClient, admin_token: str):
    pid = _create_project(client, admin_token, "MEM-IDEM")
    emp = _create_employee(client, admin_token, "mem-idem@example.com")
    # Never added — delete should still 204.
    rem = client.delete(f"/api/projects/{pid}/members/{emp['id']}", headers=_auth(admin_token))
    assert rem.status_code == 204


def test_employee_cannot_manage_members(client: TestClient, admin_token: str):
    """Member management requires projects:manage — an employee (even a
    project member) can't add/remove others."""
    pid = _create_project(client, admin_token, "MEM-PERM")
    emp = _create_employee(client, admin_token, "mem-perm@example.com")
    # Make the employee a member so they have read access.
    client.post(
        f"/api/projects/{pid}/members",
        headers=_auth(admin_token),
        json={"user_id": emp["id"], "can_manage": False},
    )
    emp_token = _login(client, "mem-perm@example.com")

    other = _create_employee(client, admin_token, "mem-perm-other@example.com")
    denied = client.post(
        f"/api/projects/{pid}/members",
        headers=_auth(emp_token),
        json={"user_id": other["id"], "can_manage": False},
    )
    assert denied.status_code == 403

    denied_del = client.delete(f"/api/projects/{pid}/members/{emp['id']}", headers=_auth(emp_token))
    assert denied_del.status_code == 403


def test_member_can_read_list(client: TestClient, admin_token: str):
    """A project member (read access) can view the member list even
    without manage permission."""
    pid = _create_project(client, admin_token, "MEM-READ")
    emp = _create_employee(client, admin_token, "mem-read@example.com")
    client.post(
        f"/api/projects/{pid}/members",
        headers=_auth(admin_token),
        json={"user_id": emp["id"], "can_manage": False},
    )
    emp_token = _login(client, "mem-read@example.com")
    listing = client.get(f"/api/projects/{pid}/members", headers=_auth(emp_token))
    assert listing.status_code == 200
    assert emp["id"] in {m["user_id"] for m in listing.json()}


def test_non_member_employee_cannot_list(client: TestClient, admin_token: str):
    """An employee with no membership and no task in the project can't
    even read the member list."""
    pid = _create_project(client, admin_token, "MEM-NOACCESS")
    _create_employee(client, admin_token, "mem-noaccess@example.com")
    emp_token = _login(client, "mem-noaccess@example.com")
    denied = client.get(f"/api/projects/{pid}/members", headers=_auth(emp_token))
    assert denied.status_code == 403


def test_add_unknown_user_404(client: TestClient, admin_token: str):
    pid = _create_project(client, admin_token, "MEM-404")
    r = client.post(
        f"/api/projects/{pid}/members",
        headers=_auth(admin_token),
        json={"user_id": 999999, "can_manage": False},
    )
    assert r.status_code == 404
