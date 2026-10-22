"""``/api/dashboard/role-defaults`` — the admin's start page per role and device.

What must hold (docs/DASHBOARD.md §4, §12 A2):

* only ``settings:manage`` reaches the three routes;
* a stored default applies to every user of that role who has not customised
  the device, and never overrides a user's own layout;
* a default may hold a widget the role cannot see; the answer names it;
* ``external`` and unknown roles do not exist here;
* a reset goes back to the built-in default, and both writes are audited.
"""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.core.permissions import ALL_ROLES
from app.models.entities import AppSetting, AuditLog
from app.services.dashboard_defaults import builtin_widgets
from tests.conftest import auth_headers

PASSWORD = "Password123!"
DEVICES = ("mobile", "tablet", "desktop")
PLANNING_DESKTOP = {
    "version": 1,
    "widgets": [
        {"id": "shortcuts", "size": "large", "settings": {"views": ["my_tasks", "planning", "projects_all", "customers", "calendar", "messages", "time", "wiki"]}},
        {"id": "planning_today", "size": "medium"},
    ],
}


def _user(client: TestClient, admin_token: str, email: str, role: str, name: str) -> str:
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": name, "role": role},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return login.headers["X-Access-Token"]


def test_only_settings_managers_reach_the_role_defaults(client: TestClient, admin_token: str) -> None:
    employee = auth_headers(_user(client, admin_token, "worker@example.com", "employee", "Willi Beispiel"))
    assert client.get("/api/dashboard/role-defaults", headers=employee).status_code == 403
    assert client.put("/api/dashboard/role-defaults/employee/desktop", headers=employee, json=PLANNING_DESKTOP).status_code == 403
    assert client.delete("/api/dashboard/role-defaults/employee/desktop", headers=employee).status_code == 403

    ceo = auth_headers(_user(client, admin_token, "boss@example.com", "ceo", "Berta Beispiel"))
    listed = client.get("/api/dashboard/role-defaults", headers=ceo)
    assert listed.status_code == 200, listed.text
    saved = client.put("/api/dashboard/role-defaults/planning/desktop", headers=ceo, json=PLANNING_DESKTOP)
    assert saved.status_code == 200, saved.text


def test_the_listing_has_the_catalog_the_roles_and_fifteen_defaults(client: TestClient, admin_token: str) -> None:
    body = client.get("/api/dashboard/role-defaults", headers=auth_headers(admin_token)).json()
    assert len(body["catalog"]) == 20
    my_status = next(entry for entry in body["catalog"] if entry["id"] == "my_status")
    assert my_status == {"id": "my_status", "group": "personal", "default_size": "medium", "requires": [["time:clock"]]}
    approvals = next(entry for entry in body["catalog"] if entry["id"] == "vacation_approvals")
    assert approvals["requires"] == [["time:approve_vacation"], ["time:view_all", "time:manage"]]
    assert body["roles"] == ALL_ROLES
    assert [(entry["role"], entry["device"]) for entry in body["defaults"]] == [
        (role, device) for role in ALL_ROLES for device in DEVICES
    ]
    for entry in body["defaults"]:
        assert entry["source"] == "builtin"
        assert entry["updated_at"] is None
        assert entry["widgets"] == builtin_widgets(entry["role"], entry["device"])
    employee_desktop = next(e for e in body["defaults"] if (e["role"], e["device"]) == ("employee", "desktop"))
    assert employee_desktop["hidden_for_role"] == []
    admin_desktop = next(e for e in body["defaults"] if (e["role"], e["device"]) == ("admin", "desktop"))
    assert admin_desktop["hidden_for_role"] == []


def test_a_stored_default_applies_to_users_without_their_own_layout(client: TestClient, admin_token: str) -> None:
    saved = client.put("/api/dashboard/role-defaults/planning/desktop", headers=auth_headers(admin_token), json=PLANNING_DESKTOP)
    assert saved.status_code == 200, saved.text
    assert saved.json()["source"] == "role"
    assert saved.json()["role"] == "planning" and saved.json()["device"] == "desktop"
    assert saved.json()["updated_at"]
    assert saved.json()["widgets"] == PLANNING_DESKTOP["widgets"]

    plain = auth_headers(_user(client, admin_token, "planner@example.com", "planning", "Pia Beispiel"))
    desktop = client.get("/api/dashboard", headers=plain).json()["layouts"]["desktop"]
    assert desktop["source"] == "role"
    assert desktop["widgets"] == PLANNING_DESKTOP["widgets"]
    assert desktop["updated_at"]

    own = auth_headers(_user(client, admin_token, "custom@example.com", "planning", "Carl Beispiel"))
    mine = {"version": 1, "widgets": [{"id": "my_tasks", "size": "large"}]}
    assert client.put("/api/dashboard/layouts/desktop", headers=own, json=mine).status_code == 200
    assert client.put("/api/dashboard/role-defaults/planning/desktop", headers=auth_headers(admin_token), json=PLANNING_DESKTOP).status_code == 200
    kept = client.get("/api/dashboard", headers=own).json()["layouts"]["desktop"]
    assert kept["source"] == "user"
    assert kept["widgets"] == mine["widgets"]

    with SessionLocal() as db:
        row = db.get(AppSetting, "dashboard_default:planning:desktop")
        assert row is not None
        assert " " not in row.value and len(row.value) < 2000


def test_a_default_may_hold_a_widget_the_role_cannot_see(client: TestClient, admin_token: str) -> None:
    body = {"version": 1, "widgets": [{"id": "my_tasks", "size": "medium"}, {"id": "clocked_in", "size": "small"}]}
    saved = client.put("/api/dashboard/role-defaults/employee/mobile", headers=auth_headers(admin_token), json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["widgets"] == body["widgets"]
    assert saved.json()["hidden_for_role"] == ["clocked_in"]
    listed = client.get("/api/dashboard/role-defaults", headers=auth_headers(admin_token)).json()
    entry = next(e for e in listed["defaults"] if (e["role"], e["device"]) == ("employee", "mobile"))
    assert entry["source"] == "role" and entry["hidden_for_role"] == ["clocked_in"]

    employee = auth_headers(_user(client, admin_token, "viewer@example.com", "employee", "Vera Beispiel"))
    mobile = client.get("/api/dashboard", headers=employee).json()["layouts"]["mobile"]
    assert mobile["source"] == "role"
    assert [item["id"] for item in mobile["widgets"]] == ["my_tasks"]


def test_a_role_default_is_validated_like_a_user_layout(client: TestClient, admin_token: str) -> None:
    response = client.put(
        "/api/dashboard/role-defaults/ceo/tablet",
        headers=auth_headers(admin_token),
        json={"version": 1, "widgets": [{"id": "weather", "size": "small"}]},
    )
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "unknown_widget"
    bad_device = client.put("/api/dashboard/role-defaults/ceo/watch", headers=auth_headers(admin_token), json=PLANNING_DESKTOP)
    assert bad_device.status_code == 422
    assert isinstance(bad_device.json()["detail"], list)


def test_external_and_unknown_roles_do_not_exist_here(client: TestClient, admin_token: str) -> None:
    headers = auth_headers(admin_token)
    for role in ("external", "superuser", "Admin"):
        put = client.put(f"/api/dashboard/role-defaults/{role}/desktop", headers=headers, json=PLANNING_DESKTOP)
        assert put.status_code == 404, (role, put.text)
        assert put.json()["detail"] == "Unbekannte Rolle."
        assert client.delete(f"/api/dashboard/role-defaults/{role}/desktop", headers=headers).status_code == 404
    with SessionLocal() as db:
        assert db.scalars(select(AppSetting).where(AppSetting.key.like("dashboard_default:%"))).all() == []


def test_a_reset_returns_the_builtin_default_and_both_writes_are_audited(client: TestClient, admin_token: str) -> None:
    headers = auth_headers(admin_token)
    assert client.put("/api/dashboard/role-defaults/planning/desktop", headers=headers, json=PLANNING_DESKTOP).status_code == 200

    reset = client.delete("/api/dashboard/role-defaults/planning/desktop", headers=headers)
    assert reset.status_code == 200, reset.text
    assert reset.json()["source"] == "builtin"
    assert reset.json()["updated_at"] is None
    assert reset.json()["widgets"] == builtin_widgets("planning", "desktop")

    with SessionLocal() as db:
        assert db.get(AppSetting, "dashboard_default:planning:desktop") is None
        rows = db.scalars(
            select(AuditLog).where(AuditLog.target_type == "dashboard_default").order_by(AuditLog.id)
        ).all()
    assert [(row.action, row.target_id, row.category) for row in rows] == [
        ("dashboard.role_default.update", "planning:desktop", "settings"),
        ("dashboard.role_default.reset", "planning:desktop", "settings"),
    ]
    assert rows[0].details == {"widgets": ["shortcuts", "planning_today"]}
    assert rows[1].details == {"widgets": [item["id"] for item in builtin_widgets("planning", "desktop")]}

    # Resetting what was never set is harmless and still answers the built-in.
    again = client.delete("/api/dashboard/role-defaults/ceo/mobile", headers=headers)
    assert again.status_code == 200 and again.json()["source"] == "builtin"
