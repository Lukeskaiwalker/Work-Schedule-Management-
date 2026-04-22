from __future__ import annotations
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import _initialize_runtime_data
from app.core.permissions import set_permissions_override
from app.routers import admin as admin_router


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client: TestClient, email: str, password: str = "Password123!") -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    return response.headers["X-Access-Token"]


def test_admin_can_manage_users_and_employee_cannot(client: TestClient, admin_token: str):
    create = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "employee1@example.com",
            "password": "Password123!",
            "full_name": "Employee One",
            "role": "employee",
        },
    )
    assert create.status_code == 200

    login_employee = client.post(
        "/api/auth/login",
        json={"email": "employee1@example.com", "password": "Password123!"},
    )
    assert login_employee.status_code == 200
    employee_token = login_employee.headers["X-Access-Token"]

    denied = client.get("/api/admin/users", headers=auth_headers(employee_token))
    assert denied.status_code == 403


def test_new_user_defaults_to_employee_role(client: TestClient, admin_token: str):
    create = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "defaultrole@example.com",
            "password": "Password123!",
            "full_name": "Default Role",
        },
    )
    assert create.status_code == 200
    payload = create.json()
    assert payload["role"] == "employee"


def test_admin_soft_delete_user_keeps_record_and_blocks_login(client: TestClient, admin_token: str):
    create = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "softdelete@example.com",
            "password": "Password123!",
            "full_name": "Soft Delete User",
            "role": "employee",
        },
    )
    assert create.status_code == 200
    created = create.json()

    remove = client.delete(
        f"/api/admin/users/{created['id']}",
        headers=auth_headers(admin_token),
    )
    assert remove.status_code == 200
    assert remove.json()["deleted"] is True

    users = client.get("/api/admin/users", headers=auth_headers(admin_token))
    assert users.status_code == 200
    target = next((item for item in users.json() if item["id"] == created["id"]), None)
    assert target is not None
    assert target["is_active"] is False

    login = client.post(
        "/api/auth/login",
        json={"email": "softdelete@example.com", "password": "Password123!"},
    )
    assert login.status_code == 401

    invite = client.post(
        f"/api/admin/users/{created['id']}/send-invite",
        headers=auth_headers(admin_token),
    )
    assert invite.status_code == 400


def test_admin_cannot_soft_delete_self(client: TestClient, admin_token: str):
    users = client.get("/api/admin/users", headers=auth_headers(admin_token))
    assert users.status_code == 200
    admin_id = users.json()[0]["id"]

    remove = client.delete(f"/api/admin/users/{admin_id}", headers=auth_headers(admin_token))
    assert remove.status_code == 400


def test_admin_can_export_encrypted_database_backup(client: TestClient, admin_token: str, monkeypatch):
    captured: dict[str, bytes | str] = {}

    def fake_create_encrypted_database_backup(database_url: str, key_material: bytes) -> bytes:
        captured["database_url"] = database_url
        captured["key_material"] = key_material
        return b"encrypted-backup-content"

    monkeypatch.setattr(admin_router, "_create_encrypted_database_backup", fake_create_encrypted_database_backup)

    response = client.post(
        "/api/admin/backups/database",
        headers=auth_headers(admin_token),
        files={"key_file": ("backup.key", b"very-secret-key-material", "application/octet-stream")},
    )
    assert response.status_code == 200
    assert response.content == b"encrypted-backup-content"
    assert "attachment; filename=" in (response.headers.get("content-disposition") or "")
    assert response.headers.get("x-backup-encryption") == "aes-256-gcm+pbkdf2"
    assert captured["key_material"] == b"very-secret-key-material"


def test_initial_admin_credential_change_disables_bootstrap_recreation(client: TestClient, admin_token: str):
    update_profile = client.patch(
        "/api/auth/me",
        headers=auth_headers(admin_token),
        json={
            "email": "owner@example.com",
            "current_password": "ChangeMe123!",
            "new_password": "OwnerPass123!A",
        },
    )
    assert update_profile.status_code == 200
    assert update_profile.json()["email"] == "owner@example.com"

    _initialize_runtime_data()

    old_login = client.post("/api/auth/login", json={"email": "admin@example.com", "password": "ChangeMe123!"})
    assert old_login.status_code == 401

    new_login = client.post("/api/auth/login", json={"email": "owner@example.com", "password": "OwnerPass123!A"})
    assert new_login.status_code == 200


def test_admin_can_manage_weather_settings(client: TestClient, admin_token: str):
    before = client.get("/api/admin/settings/weather", headers=auth_headers(admin_token))
    assert before.status_code == 200
    assert before.json()["provider"] == "openweather"

    update = client.patch(
        "/api/admin/settings/weather",
        headers=auth_headers(admin_token),
        json={"api_key": "owm_test_api_key_12345"},
    )
    assert update.status_code == 200
    payload = update.json()
    assert payload["configured"] is True
    assert payload["masked_api_key"].endswith("2345")

    after = client.get("/api/admin/settings/weather", headers=auth_headers(admin_token))
    assert after.status_code == 200
    assert after.json()["configured"] is True

    create_employee = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "weather-employee@example.com",
            "password": "Password123!",
            "full_name": "Weather Employee",
            "role": "employee",
        },
    )
    assert create_employee.status_code == 200
    employee_login = client.post(
        "/api/auth/login",
        json={"email": "weather-employee@example.com", "password": "Password123!"},
    )
    assert employee_login.status_code == 200
    employee_token = employee_login.headers["X-Access-Token"]

    forbidden = client.get("/api/admin/settings/weather", headers=auth_headers(employee_token))
    assert forbidden.status_code == 403


def test_user_override_can_grant_weather_settings_access(client: TestClient, admin_token: str):
    create_employee = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "weather-manager@example.com",
            "password": "Password123!",
            "full_name": "Weather Manager",
            "role": "employee",
        },
    )
    assert create_employee.status_code == 200
    employee_id = create_employee.json()["id"]

    grant = client.put(
        f"/api/admin/user-permissions/{employee_id}",
        headers=auth_headers(admin_token),
        json={"extra": ["settings:manage"], "denied": []},
    )
    assert grant.status_code == 200
    assert grant.json()["extra"] == ["settings:manage"]

    employee_token = _login(client, "weather-manager@example.com")

    before = client.get("/api/admin/settings/weather", headers=auth_headers(employee_token))
    assert before.status_code == 200

    update = client.patch(
        "/api/admin/settings/weather",
        headers=auth_headers(employee_token),
        json={"api_key": "delegated_weather_key_9876"},
    )
    assert update.status_code == 200
    assert update.json()["configured"] is True
    assert update.json()["masked_api_key"].endswith("9876")


def test_admin_role_keeps_full_builtin_permissions_even_with_stale_override_map(client: TestClient, admin_token: str):
    set_permissions_override(
        {
            "admin": ["users:manage"],
            "employee": ["projects:view"],
        }
    )
    try:
        role_permissions = client.get("/api/admin/role-permissions", headers=auth_headers(admin_token))
        assert role_permissions.status_code == 200
        admin_permissions = set(role_permissions.json()["permissions"]["admin"])
        assert "permissions:manage" in admin_permissions
        assert "settings:manage" in admin_permissions
        assert "system:manage" in admin_permissions
        assert "backups:export" in admin_permissions

        weather_settings = client.get("/api/admin/settings/weather", headers=auth_headers(admin_token))
        assert weather_settings.status_code == 200

        auth_me = client.get("/api/auth/me", headers=auth_headers(admin_token))
        assert auth_me.status_code == 200
        effective_permissions = set(auth_me.json()["effective_permissions"])
        assert "permissions:manage" in effective_permissions
        assert "settings:manage" in effective_permissions
        assert "system:manage" in effective_permissions
        assert "backups:export" in effective_permissions
    finally:
        set_permissions_override(None)


def test_users_manage_without_permissions_manage_cannot_assign_roles(client: TestClient, admin_token: str):
    create_manager = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "delegated-users-manager@example.com",
            "password": "Password123!",
            "full_name": "Delegated Users Manager",
            "role": "employee",
        },
    )
    assert create_manager.status_code == 200
    manager_id = create_manager.json()["id"]

    grant = client.put(
        f"/api/admin/user-permissions/{manager_id}",
        headers=auth_headers(admin_token),
        json={"extra": ["users:manage"], "denied": []},
    )
    assert grant.status_code == 200

    manager_token = _login(client, "delegated-users-manager@example.com")

    list_users = client.get("/api/admin/users", headers=auth_headers(manager_token))
    assert list_users.status_code == 200

    create_employee = client.post(
        "/api/admin/users",
        headers=auth_headers(manager_token),
        json={
            "email": "delegated-created-employee@example.com",
            "password": "Password123!",
            "full_name": "Delegated Employee",
            "role": "employee",
        },
    )
    assert create_employee.status_code == 200

    create_ceo = client.post(
        "/api/admin/users",
        headers=auth_headers(manager_token),
        json={
            "email": "delegated-created-ceo@example.com",
            "password": "Password123!",
            "full_name": "Delegated CEO",
            "role": "ceo",
        },
    )
    assert create_ceo.status_code == 403

    promote_employee = client.patch(
        f"/api/admin/users/{create_employee.json()['id']}",
        headers=auth_headers(manager_token),
        json={"role": "planning"},
    )
    assert promote_employee.status_code == 403


def test_admin_can_read_update_status(client: TestClient, admin_token: str, monkeypatch):
    monkeypatch.setattr(admin_router.settings, "app_release_version", "1.0.0", raising=False)
    monkeypatch.setattr(admin_router.settings, "app_release_commit", "1111111111111111111111111111111111111111", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_owner", "example", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_name", "repo", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_branch", "main", raising=False)
    monkeypatch.setattr(admin_router, "_can_auto_install_updates", lambda: False)

    def fake_github_api_json(path: str):
        if path.endswith("/releases"):
            return [
                {
                    "tag_name": "v1.1.0",
                    "html_url": "https://github.com/example/repo/releases/tag/v1.1.0",
                    "published_at": "2026-02-20T10:00:00Z",
                    "target_commitish": "main",
                }
            ]
        if path.endswith("/commits/main"):
            return {"sha": "2222222222222222222222222222222222222222"}
        raise AssertionError(f"Unexpected path: {path}")

    monkeypatch.setattr(admin_router, "_github_api_json", fake_github_api_json)

    response = client.get("/api/admin/updates/status", headers=auth_headers(admin_token))
    assert response.status_code == 200
    payload = response.json()
    assert payload["repository"] == "example/repo"
    assert payload["current_version"] == "1.0.0"
    assert payload["latest_version"] == "v1.1.0"
    assert payload["update_available"] is True
    assert payload["install_supported"] is False
    assert payload["install_mode"] == "manual"
    assert len(payload["install_steps"]) >= 2


def test_admin_update_status_resolves_placeholder_release_version_from_git(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    monkeypatch.setattr(admin_router.settings, "app_release_version", "local-production", raising=False)
    monkeypatch.setattr(admin_router.settings, "app_release_commit", "", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_owner", "example", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_name", "repo", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_branch", "main", raising=False)
    monkeypatch.setattr(admin_router, "_can_auto_install_updates", lambda: False)
    monkeypatch.setattr(
        admin_router,
        "_resolve_current_release_from_git",
        lambda: ("v1.2.3", "333333333333"),
    )

    def fake_github_api_json(path: str):
        if path.endswith("/releases"):
            return [
                {
                    "tag_name": "v1.2.4",
                    "html_url": "https://github.com/example/repo/releases/tag/v1.2.4",
                    "published_at": "2026-02-20T10:00:00Z",
                    "target_commitish": "main",
                }
            ]
        if path.endswith("/commits/main"):
            return {"sha": "4444444444444444444444444444444444444444"}
        raise AssertionError(f"Unexpected path: {path}")

    monkeypatch.setattr(admin_router, "_github_api_json", fake_github_api_json)

    response = client.get("/api/admin/updates/status", headers=auth_headers(admin_token))
    assert response.status_code == 200
    payload = response.json()
    assert payload["current_version"] == "v1.2.3"
    assert payload["current_commit"] == "333333333333"
    assert payload["latest_version"] == "v1.2.4"
    assert payload["update_available"] is True


def test_admin_update_status_infers_current_version_from_matching_latest_commit(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    monkeypatch.setattr(admin_router.settings, "app_release_version", "local-production", raising=False)
    monkeypatch.setattr(
        admin_router.settings,
        "app_release_commit",
        "2222222222222222222222222222222222222222",
        raising=False,
    )
    monkeypatch.setattr(admin_router.settings, "update_repo_owner", "example", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_name", "repo", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_branch", "main", raising=False)
    monkeypatch.setattr(admin_router, "_can_auto_install_updates", lambda: False)
    monkeypatch.setattr(admin_router, "_resolve_current_release_from_git", lambda: (None, None))

    def fake_github_api_json(path: str):
        if path.endswith("/releases"):
            return [
                {
                    "tag_name": "v1.2.0",
                    "html_url": "https://github.com/example/repo/releases/tag/v1.2.0",
                    "published_at": "2026-02-20T10:00:00Z",
                    "target_commitish": "main",
                }
            ]
        if path.endswith("/commits/main"):
            return {"sha": "2222222222222222222222222222222222222222"}
        raise AssertionError(f"Unexpected path: {path}")

    monkeypatch.setattr(admin_router, "_github_api_json", fake_github_api_json)

    response = client.get("/api/admin/updates/status", headers=auth_headers(admin_token))
    assert response.status_code == 200
    payload = response.json()
    assert payload["current_version"] == "v1.2.0"
    assert payload["current_commit"] == "222222222222"
    assert payload["latest_version"] == "v1.2.0"
    assert payload["update_available"] is False


def test_admin_update_status_uses_release_tag_commit_instead_of_branch_tip(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    monkeypatch.setattr(admin_router.settings, "app_release_version", "v1.2.0", raising=False)
    monkeypatch.setattr(
        admin_router.settings,
        "app_release_commit",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        raising=False,
    )
    monkeypatch.setattr(admin_router.settings, "update_repo_owner", "example", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_name", "repo", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_branch", "main", raising=False)
    monkeypatch.setattr(admin_router, "_can_auto_install_updates", lambda: False)

    def fake_github_api_json(path: str):
        if path.endswith("/releases"):
            return [
                {
                    "tag_name": "v1.2.0",
                    "html_url": "https://github.com/example/repo/releases/tag/v1.2.0",
                    "published_at": "2026-02-20T10:00:00Z",
                    "target_commitish": "main",
                    "draft": False,
                    "prerelease": False,
                }
            ]
        if path.endswith("/commits/v1.2.0"):
            return {"sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
        if path.endswith("/commits/main"):
            return {"sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
        raise AssertionError(f"Unexpected path: {path}")

    monkeypatch.setattr(admin_router, "_github_api_json", fake_github_api_json)

    response = client.get("/api/admin/updates/status", headers=auth_headers(admin_token))
    assert response.status_code == 200
    payload = response.json()
    assert payload["latest_version"] == "v1.2.0"
    assert payload["latest_commit"] == "aaaaaaaaaaaa"
    assert payload["update_available"] is False


def test_admin_update_status_resolves_current_commit_from_current_version_tag(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    monkeypatch.setattr(admin_router.settings, "app_release_version", "v1.1.0", raising=False)
    monkeypatch.setattr(admin_router.settings, "app_release_commit", "", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_owner", "example", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_name", "repo", raising=False)
    monkeypatch.setattr(admin_router.settings, "update_repo_branch", "main", raising=False)
    monkeypatch.setattr(admin_router, "_can_auto_install_updates", lambda: False)
    monkeypatch.setattr(admin_router, "_resolve_current_release_from_git", lambda: (None, None))

    def fake_github_api_json(path: str):
        if path.endswith("/releases"):
            return [
                {
                    "tag_name": "v1.2.0",
                    "html_url": "https://github.com/example/repo/releases/tag/v1.2.0",
                    "published_at": "2026-02-20T10:00:00Z",
                    "target_commitish": "main",
                    "draft": False,
                    "prerelease": False,
                }
            ]
        if path.endswith("/commits/v1.1.0"):
            return {"sha": "1111111111111111111111111111111111111111"}
        if path.endswith("/commits/v1.2.0"):
            return {"sha": "2222222222222222222222222222222222222222"}
        raise AssertionError(f"Unexpected path: {path}")

    monkeypatch.setattr(admin_router, "_github_api_json", fake_github_api_json)

    response = client.get("/api/admin/updates/status", headers=auth_headers(admin_token))
    assert response.status_code == 200
    payload = response.json()
    assert payload["current_version"] == "v1.1.0"
    assert payload["current_commit"] == "111111111111"
    assert payload["latest_version"] == "v1.2.0"
    assert payload["latest_commit"] == "222222222222"
    assert payload["update_available"] is True


def test_admin_install_update_returns_manual_when_auto_install_unavailable(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    monkeypatch.setattr(
        admin_router,
        "_fetch_update_status",
        lambda: admin_router.UpdateStatusOut(
            repository="example/repo",
            branch="main",
            install_supported=False,
            install_mode="manual",
            install_steps=["git fetch --tags --prune"],
        ),
    )

    response = client.post(
        "/api/admin/updates/install",
        headers=auth_headers(admin_token),
        json={"dry_run": False},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is False
    assert payload["mode"] == "manual"
    assert "Automatic install is unavailable" in payload["detail"]


def test_admin_install_update_dry_run_runs_preflight(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    monkeypatch.setattr(
        admin_router,
        "_fetch_update_status",
        lambda: admin_router.UpdateStatusOut(
            repository="example/repo",
            branch="main",
            install_supported=True,
            install_mode="auto",
            install_steps=[],
        ),
    )
    monkeypatch.setattr(admin_router, "_resolve_repo_root", lambda: Path("/tmp/repo"))

    called: dict[str, bool] = {"preflight": False}

    def fake_preflight(*, repo_root: Path, alembic_workdir: Path) -> list[str]:
        called["preflight"] = True
        assert repo_root == Path("/tmp/repo")
        assert alembic_workdir == Path("/tmp/repo")
        return ["alembic upgrade head (preflight temp db)"]

    monkeypatch.setattr(admin_router, "_run_migration_preflight", fake_preflight)

    response = client.post(
        "/api/admin/updates/install",
        headers=auth_headers(admin_token),
        json={"dry_run": True},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["dry_run"] is True
    assert called["preflight"] is True
    assert any("git fetch --tags --prune origin" in step for step in payload["ran_steps"])
    assert any("alembic upgrade head (preflight temp db)" in step for step in payload["ran_steps"])


def test_admin_install_update_creates_snapshot_and_runs_preflight_before_migration(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    monkeypatch.setattr(
        admin_router,
        "_fetch_update_status",
        lambda: admin_router.UpdateStatusOut(
            repository="example/repo",
            branch="main",
            install_supported=True,
            install_mode="auto",
            install_steps=[],
            latest_version="v1.2.0",
            latest_commit="abcdef123456",
        ),
    )
    monkeypatch.setattr(admin_router, "_resolve_repo_root", lambda: Path("/tmp/repo"))
    monkeypatch.setattr(
        admin_router,
        "_create_pre_update_db_snapshot",
        lambda repo_root: Path("/tmp/repo/backups/pre-update/db-smpl-20260226-220000.dump"),
    )
    monkeypatch.setattr(
        admin_router,
        "_run_migration_preflight",
        lambda **_: ["alembic upgrade head (preflight temp db)"],
    )

    executed: list[str] = []

    def fake_run_update_command(command: list[str], *, cwd: Path, env=None):  # noqa: ANN001
        executed.append(" ".join(command))

        class _Result:
            returncode = 0
            stdout = ""
            stderr = ""

        return _Result()

    monkeypatch.setattr(admin_router, "_run_update_command", fake_run_update_command)

    response = client.post(
        "/api/admin/updates/install",
        headers=auth_headers(admin_token),
        json={"dry_run": False},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert executed == [
        "git fetch --tags --prune origin",
        "git pull --ff-only origin main",
        "./scripts/update_release_metadata.sh",
        "alembic upgrade head",
    ]
    assert any("pre-update snapshot:" in step for step in payload["ran_steps"])
    assert any("alembic upgrade head (preflight temp db)" in step for step in payload["ran_steps"])
