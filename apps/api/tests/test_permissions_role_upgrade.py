"""Permissions added to a role's defaults reach installs that stored the role.

The owner's answer to docs/DASHBOARD.md Q1 (2026-10-21) gives Geschäftsführung,
Buchhaltung and Planung `time:clock` and `time:view_own`, so „Mein Status“ and
„Urlaub“ appear on their start page. A role list stored in the Rechte matrix
replaces that role's defaults, and saving any one role there stores all five —
so on an install where an admin ever saved the matrix, a new default never
reached those roles. `ROLE_PERMISSION_UPGRADES` grants it once to the stored
lists that predate it; a list saved afterwards carries the revision, so a box
the admin unticks later stays unticked.
"""
from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.core.permissions import (
    ALL_ROLES,
    PERMISSIONS_BY_ROLE,
    ROLE_ACCOUNTANT,
    ROLE_CEO,
    ROLE_EMPLOYEE,
    ROLE_PERMISSIONS_REVISION,
    ROLE_PLANNING,
)
from app.services.runtime_settings import (
    ROLE_PERMISSIONS_KEY,
    get_runtime_setting,
    load_role_permissions_from_db,
    reset_role_to_defaults,
    set_runtime_setting,
)

PASSWORD = "Password123!"
TIME_WIDGET_PERMISSIONS = {"time:clock", "time:view_own"}
OFFICE_ROLES = (ROLE_CEO, ROLE_ACCOUNTANT, ROLE_PLANNING)


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _matrix_saved_before_the_upgrade() -> dict[str, list[str]]:
    """All five roles, as one Rechte-matrix save stored them before 2026-10-21."""
    return {
        role: sorted(PERMISSIONS_BY_ROLE[role] - (TIME_WIDGET_PERMISSIONS if role in OFFICE_ROLES else set()))
        for role in ALL_ROLES
    }


def _plant(stored: dict) -> None:
    with SessionLocal() as db:
        set_runtime_setting(db, ROLE_PERMISSIONS_KEY, json.dumps(stored))
        db.commit()
        load_role_permissions_from_db(db)


def _stored() -> dict:
    with SessionLocal() as db:
        raw = get_runtime_setting(db, ROLE_PERMISSIONS_KEY)
    return json.loads(raw) if raw else {}


def _sign_in_as_new(client: TestClient, admin_token: str, role: str) -> str:
    email = f"upgrade-{role}@example.com"
    created = client.post(
        "/api/admin/users",
        headers=_headers(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": "Rike Rollenprobe", "role": role},
    )
    assert created.status_code == 200, created.text
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def test_office_roles_gain_the_time_permissions_from_a_matrix_saved_before(client: TestClient, admin_token: str):
    _plant(_matrix_saved_before_the_upgrade())

    for role in OFFICE_ROLES:
        token = _sign_in_as_new(client, admin_token, role)
        me = client.get("/api/auth/me", headers=_headers(token)).json()
        assert TIME_WIDGET_PERMISSIONS <= set(me["effective_permissions"]), role
        # What the owner asked for: the two widgets can be placed.
        available = client.get("/api/dashboard", headers=_headers(token)).json()["available_widgets"]
        assert {"my_status", "my_vacation"} <= set(available), role

    stored = _stored()
    for role in OFFICE_ROLES:
        assert TIME_WIDGET_PERMISSIONS <= set(stored[role]), role
    # Only what the revision added, and only to the roles it names.
    assert stored[ROLE_EMPLOYEE] == _matrix_saved_before_the_upgrade()[ROLE_EMPLOYEE]
    assert set(stored[ROLE_CEO]) - set(_matrix_saved_before_the_upgrade()[ROLE_CEO]) == TIME_WIDGET_PERMISSIONS
    assert stored["_revision"] == ROLE_PERMISSIONS_REVISION


def test_a_box_unticked_after_the_upgrade_stays_unticked(client: TestClient, admin_token: str):
    _plant(_matrix_saved_before_the_upgrade())
    ceo = client.get("/api/admin/role-permissions", headers=_headers(admin_token)).json()["permissions"][ROLE_CEO]
    assert "time:clock" in ceo

    saved = client.put(
        f"/api/admin/role-permissions/{ROLE_CEO}",
        headers=_headers(admin_token),
        json={"permissions": [p for p in ceo if p != "time:clock"]},
    )
    assert saved.status_code == 200, saved.text
    assert _stored()["_revision"] == ROLE_PERMISSIONS_REVISION

    # A restart reads the stored lists again.
    with SessionLocal() as db:
        load_role_permissions_from_db(db)
    after = client.get("/api/admin/role-permissions", headers=_headers(admin_token)).json()["permissions"][ROLE_CEO]
    assert "time:clock" not in after
    assert "time:view_own" in after


def test_lists_stored_at_the_current_revision_are_read_as_they_are(client: TestClient, admin_token: str):
    stamped = {ROLE_CEO: ["projects:view"], "_revision": ROLE_PERMISSIONS_REVISION}
    _plant(stamped)

    permissions = client.get("/api/admin/role-permissions", headers=_headers(admin_token)).json()["permissions"]
    assert permissions[ROLE_CEO] == ["projects:view"]
    assert _stored() == stamped


def test_roles_the_matrix_never_stored_follow_the_defaults(client: TestClient, admin_token: str):
    _plant({ROLE_EMPLOYEE: ["projects:view", "time:clock"]})

    permissions = client.get("/api/admin/role-permissions", headers=_headers(admin_token)).json()["permissions"]
    for role in OFFICE_ROLES:
        assert permissions[role] == sorted(PERMISSIONS_BY_ROLE[role]), role
    assert permissions[ROLE_EMPLOYEE] == ["projects:view", "time:clock"]
    # Nothing was granted, so nothing was written back.
    assert _stored() == {ROLE_EMPLOYEE: ["projects:view", "time:clock"]}


def test_resetting_every_stored_role_still_removes_the_row(client: TestClient, admin_token: str):
    saved = client.put(
        f"/api/admin/role-permissions/{ROLE_PLANNING}",
        headers=_headers(admin_token),
        json={"permissions": ["projects:view"]},
    )
    assert saved.status_code == 200, saved.text
    assert "_revision" in _stored()

    with SessionLocal() as db:
        for role in ALL_ROLES:
            reset_role_to_defaults(db, role)
        assert get_runtime_setting(db, ROLE_PERMISSIONS_KEY) is None
