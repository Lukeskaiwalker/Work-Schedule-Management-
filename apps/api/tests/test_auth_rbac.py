from __future__ import annotations
from fastapi.testclient import TestClient

from app.routers import admin as admin_router


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


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
