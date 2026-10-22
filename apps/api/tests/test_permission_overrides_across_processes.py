"""Permission overrides saved by one process apply in every process.

Production runs two uvicorn workers plus the api_worker, and each keeps its
own copy of the role and per-user overrides. Before 2026-10-21 that copy was
read once at startup and only the worker that handled an admin's save
updated it, so a deny saved on worker A was not enforced on worker B until B
recycled (hours). Saves were built from the local copy too, so a save on B
overwrote what A had saved before.

"Another process" is simulated here by putting the module cache back to the
snapshot it held before a save: exactly what a worker that did not handle the
save still holds. The last test runs a real second process on the same
database file.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

from app.core import permissions
from app.core.db import SessionLocal
from app.models.entities import AppSetting
from app.services.permission_store import (
    ROLE_PERMISSIONS_KEY,
    USER_PERMISSIONS_KEY,
    reset_user_permissions_from_db,
    save_role_permissions,
    save_user_permissions_to_db,
)

WIKI = "/api/wiki/library/files"  # guarded by wiki:view, which employees hold by default


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _employee(client: TestClient, admin_token: str, email: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        headers=_headers(admin_token),
        json={"email": email, "password": "Password123!", "full_name": "Test Monteur", "role": "employee"},
    )
    assert created.status_code == 200, created.text
    login = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def _stored_json(key: str) -> dict:
    with SessionLocal() as db:
        row = db.get(AppSetting, key)
        return json.loads(row.value) if row else {}


def _effective(client: TestClient, token: str) -> set[str]:
    me = client.get("/api/auth/me", headers=_headers(token))
    assert me.status_code == 200, me.text
    return set(me.json()["effective_permissions"])


# ── A deny saved elsewhere is enforced here ──────────────────────────────────


def test_a_user_deny_saved_by_another_process_is_enforced(client: TestClient, admin_token: str) -> None:
    user_id, token = _employee(client, admin_token, "monteur@example.com")
    assert client.get(WIKI, headers=_headers(token)).status_code == 200
    other_process = permissions.permission_snapshot()

    saved = client.put(
        f"/api/admin/user-permissions/{user_id}",
        headers=_headers(admin_token),
        json={"extra": [], "denied": ["wiki:view"]},
    )
    assert saved.status_code == 200, saved.text

    permissions.install_permission_snapshot(other_process)
    assert client.get(WIKI, headers=_headers(token)).status_code == 403
    assert "wiki:view" not in _effective(client, token)


def test_a_role_change_saved_by_another_process_is_enforced(client: TestClient, admin_token: str) -> None:
    _, token = _employee(client, admin_token, "monteur@example.com")
    assert client.get(WIKI, headers=_headers(token)).status_code == 200
    other_process = permissions.permission_snapshot()

    employee_without_wiki = sorted(permissions.PERMISSIONS_BY_ROLE["employee"] - {"wiki:view"})
    saved = client.put(
        "/api/admin/role-permissions/employee",
        headers=_headers(admin_token),
        json={"permissions": employee_without_wiki},
    )
    assert saved.status_code == 200, saved.text

    permissions.install_permission_snapshot(other_process)
    assert client.get(WIKI, headers=_headers(token)).status_code == 403


def test_a_grant_withdrawn_by_another_process_is_withdrawn_here(client: TestClient, admin_token: str) -> None:
    user_id, token = _employee(client, admin_token, "monteur@example.com")
    granted = client.put(
        f"/api/admin/user-permissions/{user_id}",
        headers=_headers(admin_token),
        json={"extra": ["finance:manage"], "denied": []},
    )
    assert granted.status_code == 200, granted.text
    assert "finance:manage" in _effective(client, token)
    other_process = permissions.permission_snapshot()

    withdrawn = client.delete(f"/api/admin/user-permissions/{user_id}", headers=_headers(admin_token))
    assert withdrawn.status_code == 200, withdrawn.text

    permissions.install_permission_snapshot(other_process)
    assert "finance:manage" not in _effective(client, token)


def test_a_cache_set_by_hand_is_replaced_by_the_stored_state(client: TestClient, admin_token: str) -> None:
    """The plain setters leave the cache matching no stored revision, so the
    next request reads the database instead of trusting it."""
    user_id, token = _employee(client, admin_token, "monteur@example.com")
    saved = client.put(
        f"/api/admin/user-permissions/{user_id}",
        headers=_headers(admin_token),
        json={"extra": [], "denied": ["wiki:view"]},
    )
    assert saved.status_code == 200, saved.text

    permissions.set_user_permissions_override({})
    assert client.get(WIKI, headers=_headers(token)).status_code == 403


# ── Saves build on the stored state, not on the local copy ───────────────────


def test_user_override_saves_from_two_stale_processes_both_survive(client: TestClient, admin_token: str) -> None:
    first_id, _ = _employee(client, admin_token, "erster@example.com")
    second_id, _ = _employee(client, admin_token, "zweiter@example.com")
    before_any_save = permissions.permission_snapshot()

    with SessionLocal() as db:
        save_user_permissions_to_db(db, first_id, [], ["wiki:view"])

    # A process that never saw the first save makes the second.
    permissions.install_permission_snapshot(before_any_save)
    with SessionLocal() as db:
        save_user_permissions_to_db(db, second_id, ["finance:manage"], [])

    stored = _stored_json(USER_PERMISSIONS_KEY)
    assert stored[str(first_id)] == {"extra": [], "denied": ["wiki:view"]}
    assert stored[str(second_id)] == {"extra": ["finance:manage"], "denied": []}
    # ...and the saving process now holds both.
    assert permissions.get_user_override(first_id)["denied"] == ["wiki:view"]
    assert permissions.get_user_override(second_id)["extra"] == ["finance:manage"]


def test_a_reset_from_a_stale_process_keeps_the_other_users_overrides(client: TestClient, admin_token: str) -> None:
    first_id, _ = _employee(client, admin_token, "erster@example.com")
    second_id, _ = _employee(client, admin_token, "zweiter@example.com")
    with SessionLocal() as db:
        save_user_permissions_to_db(db, second_id, [], ["time:clock"])
    stale = permissions.permission_snapshot()

    with SessionLocal() as db:
        save_user_permissions_to_db(db, first_id, [], ["wiki:view"])

    permissions.install_permission_snapshot(stale)
    with SessionLocal() as db:
        reset_user_permissions_from_db(db, second_id)

    stored = _stored_json(USER_PERMISSIONS_KEY)
    assert stored == {str(first_id): {"extra": [], "denied": ["wiki:view"]}}


def test_role_saves_from_two_stale_processes_both_survive(client: TestClient, admin_token: str) -> None:
    before_any_save = permissions.permission_snapshot()
    ceo = sorted(permissions.PERMISSIONS_BY_ROLE["ceo"] - {"finance:manage"})
    saved = client.put("/api/admin/role-permissions/ceo", headers=_headers(admin_token), json={"permissions": ceo})
    assert saved.status_code == 200, saved.text

    # Straight to the store: through the API, the request's own freshness
    # check would hide a save that builds on the local copy.
    permissions.install_permission_snapshot(before_any_save)
    planning = sorted(permissions.PERMISSIONS_BY_ROLE["planning"] | {"finance:view"})
    with SessionLocal() as db:
        effective = save_role_permissions(db, "planning", planning)

    stored = _stored_json(ROLE_PERMISSIONS_KEY)
    assert stored["ceo"] == ceo
    assert stored["planning"] == planning
    assert effective["ceo"] == ceo
    assert effective["planning"] == planning


# ── Size ─────────────────────────────────────────────────────────────────────


def test_the_override_store_is_not_capped_at_2048_characters() -> None:
    """SQLite never enforces a VARCHAR length, so the column type is the
    check here; tests/test_permission_overrides_postgres.py saves a large map
    on PostgreSQL, where VARCHAR(2048) refused it."""
    column = AppSetting.__table__.c.value
    assert getattr(column.type, "length", None) is None, column.type


# ── A real second process ────────────────────────────────────────────────────

_SECOND_PROCESS = """
import json, sys, time
from pathlib import Path

from app.services import update_runner_client
update_runner_client.is_runner_reachable = lambda: False  # no network probe at startup

from fastapi.testclient import TestClient
from app.main import app

token, ready, go = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
headers = {"Authorization": f"Bearer {token}"}

def observe(client):
    me = client.get("/api/auth/me", headers=headers).json()
    return {
        "wiki": client.get("/api/wiki/library/files", headers=headers).status_code,
        "permissions": sorted(me["effective_permissions"]),
    }

with TestClient(app) as client:
    result = {"before": observe(client)}
    ready.touch()
    deadline = time.monotonic() + 60
    while not go.exists() and time.monotonic() < deadline:
        time.sleep(0.05)
    result["after"] = observe(client)
print("RESULT " + json.dumps(result), flush=True)
"""


def _wait_for(path: Path, process: subprocess.Popen, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while not path.exists():
        if process.poll() is not None:
            raise AssertionError(f"second process exited early:\n{process.communicate()[0]}")
        if time.monotonic() > deadline:
            process.kill()
            raise AssertionError(f"second process never got ready:\n{process.communicate()[0]}")
        time.sleep(0.05)


def test_a_second_process_enforces_a_deny_saved_by_this_one(
    client: TestClient, admin_token: str, tmp_path: Path
) -> None:
    user_id, token = _employee(client, admin_token, "monteur@example.com")
    ready, go = tmp_path / "ready", tmp_path / "go"
    second = subprocess.Popen(
        [sys.executable, "-c", _SECOND_PROCESS, token, str(ready), str(go)],
        cwd=os.getcwd(),  # DATABASE_URL is sqlite:///./test.db: the same file
        env=dict(os.environ),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        _wait_for(ready, second, 60)

        denied = client.put(
            f"/api/admin/user-permissions/{user_id}",
            headers=_headers(admin_token),
            json={"extra": [], "denied": ["wiki:view"]},
        )
        assert denied.status_code == 200, denied.text
        employee_without_clock = sorted(permissions.PERMISSIONS_BY_ROLE["employee"] - {"time:clock"})
        role = client.put(
            "/api/admin/role-permissions/employee",
            headers=_headers(admin_token),
            json={"permissions": employee_without_clock},
        )
        assert role.status_code == 200, role.text
        go.touch()

        output, _ = second.communicate(timeout=60)
    finally:
        if second.poll() is None:
            second.kill()
            second.communicate()

    lines = [line for line in output.splitlines() if line.startswith("RESULT ")]
    assert lines, output
    result = json.loads(lines[-1].removeprefix("RESULT "))
    assert result["before"]["wiki"] == 200
    assert {"wiki:view", "time:clock"} <= set(result["before"]["permissions"])
    assert result["after"]["wiki"] == 403
    assert "wiki:view" not in result["after"]["permissions"]
    assert "time:clock" not in result["after"]["permissions"]
