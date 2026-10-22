"""Every /auth/me* route that returns the signed-in user answers the full
UserMeOut shape (docs/DASHBOARD.md §4.4, D18).

The SPA replaces its user object with whatever these routes answer. When the
preference PATCH or the 2FA disable answered the slimmer UserOut, the client
lost `effective_permissions` and the fresh vacation balance until the next
reload, and every permission-gated control vanished. The stored dashboard
layouts stay out of every user response (D19): the dashboard API is their
only reader.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

import pyotp
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlalchemy.dialects import postgresql
from sqlalchemy.orm import ORMExecuteState, Session

from app.core.db import SessionLocal
from app.core.permissions import PERMISSIONS_BY_ROLE, ROLE_ACCOUNTANT, ROLE_CEO, ROLE_PLANNING
from app.models.entities import User
from app.schemas.user import UserMeOut, UserOut

PASSWORD = "Password123!"

# Invented data only: the repository is public.
STORED_LAYOUTS = {
    "tablet": {
        "version": 1,
        "role": "employee",
        "updated_at": "2026-10-21T18:40:12Z",
        "widgets": [
            {"id": "my_status", "size": "medium"},
            {"id": "shortcuts", "size": "large", "settings": {"views": ["my_tasks", "planning"]}},
        ],
    }
}


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str = "employee") -> dict:
    created = client.post(
        "/api/admin/users",
        headers=_headers(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": "Tilda Testfeld", "role": role},
    )
    assert created.status_code == 200, created.text
    return created.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _employee_with_vacation(client: TestClient, admin_token: str, email: str) -> tuple[dict, str]:
    """An employee with a non-zero balance, so comparing balances proves something."""
    user = _create_user(client, admin_token, email)
    updated = client.patch(
        f"/api/admin/users/{user['id']}",
        headers=_headers(admin_token),
        json={"vacation_days_available": 12.5, "vacation_days_carryover": 2.5},
    )
    assert updated.status_code == 200, updated.text
    return user, _login(client, email)


def _store_layouts(user_id: int, layouts: dict) -> None:
    # Written straight to the row: the dashboard service (part A2) is the only
    # API writer of this key, and this suite must not depend on it.
    with SessionLocal() as db:
        user = db.get(User, user_id)
        assert user is not None
        base = user.preferences if isinstance(user.preferences, dict) else {}
        user.preferences = {**base, "planning_mobile_view": "list", "dashboard_layouts": layouts}
        db.commit()


def _stored_preferences(user_id: int) -> dict:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        assert user is not None
        return dict(user.preferences or {})


def _assert_full_me_shape(body: dict, me: dict) -> None:
    assert body["effective_permissions"], "the response lost the resolved permissions"
    assert body["effective_permissions"] == me["effective_permissions"]
    assert "can_update_recent_own_time_entries" in body
    assert body["vacation_days_total_remaining"] == me["vacation_days_total_remaining"]


def test_preferences_patch_answers_the_me_shape_with_the_fresh_balance(client: TestClient, admin_token: str):
    _user, token = _employee_with_vacation(client, admin_token, "prefs-shape@example.com")
    me = client.get("/api/auth/me", headers=_headers(token)).json()
    assert me["vacation_days_total_remaining"] == 15.0

    patched = client.patch("/api/auth/me/preferences", headers=_headers(token), json={"planning_mobile_view": "list"})

    assert patched.status_code == 200, patched.text
    body = patched.json()
    _assert_full_me_shape(body, me)
    assert body["preferences"]["planning_mobile_view"] == "list"


def test_profile_patch_answers_the_me_shape(client: TestClient, admin_token: str):
    _user, token = _employee_with_vacation(client, admin_token, "profile-shape@example.com")
    me = client.get("/api/auth/me", headers=_headers(token)).json()

    patched = client.patch("/api/auth/me", headers=_headers(token), json={"full_name": "Tilda Umbenannt"})

    assert patched.status_code == 200, patched.text
    body = patched.json()
    _assert_full_me_shape(body, me)
    assert body["full_name"] == "Tilda Umbenannt"


def test_mfa_disable_answers_the_me_shape(client: TestClient, admin_token: str):
    _user, token = _employee_with_vacation(client, admin_token, "mfa-shape@example.com")
    enroll = client.post("/api/auth/me/mfa/enroll", headers=_headers(token), json={"current_password": PASSWORD})
    assert enroll.status_code == 200, enroll.text
    secret = enroll.json()["secret"]
    verify = client.post("/api/auth/me/mfa/verify", headers=_headers(token), json={"code": pyotp.TOTP(secret).now()})
    assert verify.status_code == 200, verify.text
    me = client.get("/api/auth/me", headers=_headers(token)).json()
    assert me["mfa_enabled"] is True

    disabled = client.post(
        "/api/auth/me/mfa/disable",
        headers=_headers(token),
        json={"current_password": PASSWORD, "code": pyotp.TOTP(secret).now()},
    )

    assert disabled.status_code == 200, disabled.text
    body = disabled.json()
    _assert_full_me_shape(body, me)
    assert body["mfa_enabled"] is False


def test_user_responses_never_show_stored_dashboard_layouts(client: TestClient, admin_token: str):
    user = _create_user(client, admin_token, "hidden-layouts@example.com")
    token = _login(client, "hidden-layouts@example.com")
    _store_layouts(user["id"], STORED_LAYOUTS)

    me = client.get("/api/auth/me", headers=_headers(token))
    assert me.status_code == 200
    assert "dashboard_layouts" not in me.json()["preferences"]
    # Only the internal key goes; the user's other preferences stay visible.
    assert me.json()["preferences"]["planning_mobile_view"] == "list"

    profile = client.patch("/api/auth/me", headers=_headers(token), json={"full_name": "Tilda Versteckt"})
    assert "dashboard_layouts" not in profile.json()["preferences"]
    prefs = client.patch("/api/auth/me/preferences", headers=_headers(token), json={"planning_mobile_view": "single"})
    assert "dashboard_layouts" not in prefs.json()["preferences"]

    users = client.get("/api/admin/users", headers=_headers(admin_token))
    assert users.status_code == 200
    row = next(item for item in users.json() if item["id"] == user["id"])
    assert "dashboard_layouts" not in row["preferences"]
    assert row["preferences"]["planning_mobile_view"] == "single"


def test_preferences_patch_keeps_stored_layouts_and_ignores_them_in_the_body(client: TestClient, admin_token: str):
    user = _create_user(client, admin_token, "keep-layouts@example.com")
    token = _login(client, "keep-layouts@example.com")
    _store_layouts(user["id"], STORED_LAYOUTS)

    patched = client.patch(
        "/api/auth/me/preferences",
        headers=_headers(token),
        json={
            "planning_mobile_view": "scroll",
            "dashboard_layouts": {"mobile": {"version": 1, "widgets": [{"id": "weather", "size": "huge"}]}},
        },
    )
    assert patched.status_code == 200, patched.text
    stored = _stored_preferences(user["id"])
    assert stored["planning_mobile_view"] == "scroll"
    assert stored["dashboard_layouts"] == STORED_LAYOUTS

    only_layouts = client.patch(
        "/api/auth/me/preferences",
        headers=_headers(token),
        json={"dashboard_layouts": {}},
    )
    assert only_layouts.status_code == 200, only_layouts.text
    assert _stored_preferences(user["id"])["dashboard_layouts"] == STORED_LAYOUTS


@contextmanager
def _record_locking_selects() -> Iterator[list[str]]:
    """Collect every ORM SELECT that would lock rows, rendered for PostgreSQL.

    SQLite drops FOR UPDATE when compiling, so the SQL sent here never shows
    the lock. The statement object still carries it; rendering it with the
    PostgreSQL dialect shows what production sends.
    """
    seen: list[str] = []

    def _listener(state: ORMExecuteState) -> None:
        if not state.is_select:
            return
        sql = str(state.statement.compile(dialect=postgresql.dialect()))
        if "FOR UPDATE" in sql:
            seen.append(sql)

    event.listen(Session, "do_orm_execute", _listener)
    try:
        yield seen
    finally:
        event.remove(Session, "do_orm_execute", _listener)


def test_preferences_patch_locks_the_user_row(client: TestClient, admin_token: str):
    # A phone and a desktop saving at the same time must not drop each other's
    # keys; the dashboard writer takes the same lock (§4.1). The real race is
    # checked on PostgreSQL in the integration gate.
    _create_user(client, admin_token, "row-lock@example.com")
    token = _login(client, "row-lock@example.com")

    with _record_locking_selects() as locking:
        patched = client.patch(
            "/api/auth/me/preferences", headers=_headers(token), json={"planning_mobile_view": "list"}
        )

    assert patched.status_code == 200, patched.text
    assert any("FROM users" in sql for sql in locking), locking


def test_user_out_drops_hidden_preference_keys_into_a_new_dict():
    # Imported here so that, before the constant exists, only this test fails
    # and the route tests above still report their own reasons.
    from app.schemas.user import HIDDEN_PREFERENCE_KEYS

    assert "dashboard_layouts" in HIDDEN_PREFERENCE_KEYS
    preferences = {"planning_mobile_view": "list", "dashboard_layouts": STORED_LAYOUTS}
    base = {
        "id": 1,
        "email": "unit@example.com",
        "full_name": "Tilda Testfeld",
        "display_name": "Tilda Testfeld",
        "role": "employee",
        "is_active": True,
    }

    out = UserMeOut.model_validate({**base, "preferences": preferences})

    assert out.preferences == {"planning_mobile_view": "list"}
    # The source dict is the ORM row's value: removing the key from it in
    # place would drop the layouts from the next save that copies it.
    assert preferences["dashboard_layouts"] == STORED_LAYOUTS
    assert UserOut.model_validate({**base, "preferences": None}).preferences == {}
    assert UserOut.model_validate({**base, "preferences": ["not", "a", "dict"]}).preferences == {}


def test_office_roles_can_clock_and_see_their_own_time(client: TestClient, admin_token: str):
    # Owner answer Q1 (2026-10-21): Geschäftsführung, Buchhaltung and Planung
    # get „Mein Status“ and „Urlaub“ on their start page, which need these two.
    for role in (ROLE_CEO, ROLE_ACCOUNTANT, ROLE_PLANNING):
        assert {"time:clock", "time:view_own"} <= PERMISSIONS_BY_ROLE[role], role

    for role in (ROLE_CEO, ROLE_ACCOUNTANT, ROLE_PLANNING):
        email = f"time-{role}@example.com"
        _create_user(client, admin_token, email, role)
        me = client.get("/api/auth/me", headers=_headers(_login(client, email))).json()
        assert me["role"] == role
        assert {"time:clock", "time:view_own"} <= set(me["effective_permissions"]), role
