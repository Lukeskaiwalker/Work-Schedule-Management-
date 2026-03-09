from __future__ import annotations
import json
import os
from fastapi.testclient import TestClient
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}



def _create_user(client: TestClient, admin_token: str, email: str, role: str):
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": f"{role.title()} User",
            "role": role,
        },
    )
    assert response.status_code == 200
    return response.json()

def _login(client: TestClient, email: str):
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200
    return response.headers["X-Access-Token"]


def test_profile_avatar_upload_and_preview(client: TestClient, admin_token: str):
    created = _create_user(client, admin_token, "avatar-user@example.com", "employee")
    token = _login(client, "avatar-user@example.com")

    upload = client.post(
        "/api/users/me/avatar",
        headers=auth_headers(token),
        files={"file": ("avatar.png", b"fake-png-binary", "image/png")},
    )
    assert upload.status_code == 200
    assert upload.json()["ok"] is True

    me = client.get("/api/auth/me", headers=auth_headers(token))
    assert me.status_code == 200
    assert me.json().get("avatar_updated_at")

    preview = client.get(f"/api/users/{created['id']}/avatar", headers=auth_headers(token))
    assert preview.status_code == 200
    assert preview.content == b"fake-png-binary"
    assert preview.headers.get("content-type", "").startswith("image/")

    invalid_upload = client.post(
        "/api/users/me/avatar",
        headers=auth_headers(token),
        files={"file": ("not-image.txt", b"text", "text/plain")},
    )
    assert invalid_upload.status_code == 400

    delete_avatar = client.delete("/api/users/me/avatar", headers=auth_headers(token))
    assert delete_avatar.status_code == 200
    assert delete_avatar.json()["ok"] is True
    assert delete_avatar.json()["deleted"] is True
    assert delete_avatar.json()["avatar_updated_at"] is None

    me_without_avatar = client.get("/api/auth/me", headers=auth_headers(token))
    assert me_without_avatar.status_code == 200
    assert me_without_avatar.json().get("avatar_updated_at") is None

    preview_after_delete = client.get(f"/api/users/{created['id']}/avatar", headers=auth_headers(token))
    assert preview_after_delete.status_code == 404

    delete_avatar_again = client.delete("/api/users/me/avatar", headers=auth_headers(token))
    assert delete_avatar_again.status_code == 200
    assert delete_avatar_again.json()["deleted"] is False

def test_profile_avatar_upload_accepts_heic_extension_without_image_mime(client: TestClient, admin_token: str):
    created = _create_user(client, admin_token, "avatar-heic-user@example.com", "employee")
    token = _login(client, "avatar-heic-user@example.com")

    upload = client.post(
        "/api/users/me/avatar",
        headers=auth_headers(token),
        files={"file": ("avatar.heic", b"fake-heic-binary", "application/octet-stream")},
    )
    assert upload.status_code == 200
    assert upload.json()["ok"] is True

    preview = client.get(f"/api/users/{created['id']}/avatar", headers=auth_headers(token))
    assert preview.status_code == 200
    assert preview.content
    assert preview.headers.get("content-type", "").startswith("image/")

def test_profile_settings_update_name_email_password(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "profile-user@example.com", "employee")
    token = _login(client, "profile-user@example.com")

    rename_only = client.patch(
        "/api/auth/me",
        headers=auth_headers(token),
        json={"full_name": "Profile User Updated"},
    )
    assert rename_only.status_code == 200
    assert rename_only.json()["full_name"] == "Profile User Updated"

    email_without_password = client.patch(
        "/api/auth/me",
        headers=auth_headers(token),
        json={"email": "profile-user-new@example.com"},
    )
    assert email_without_password.status_code == 403

    update_all = client.patch(
        "/api/auth/me",
        headers=auth_headers(token),
        json={
            "full_name": "Profile User Final",
            "email": "profile-user-new@example.com",
            "current_password": "Password123!",
            "new_password": "Password123!New",
        },
    )
    assert update_all.status_code == 200
    assert update_all.json()["email"] == "profile-user-new@example.com"

    old_login = client.post("/api/auth/login", json={"email": "profile-user@example.com", "password": "Password123!"})
    assert old_login.status_code == 401
    new_login = client.post("/api/auth/login", json={"email": "profile-user-new@example.com", "password": "Password123!New"})
    assert new_login.status_code == 200

def test_admin_nickname_is_optional_unique_changeable_and_removable(client: TestClient, admin_token: str):
    available_before = client.get(
        "/api/auth/nickname-availability",
        headers=auth_headers(admin_token),
        params={"nickname": "SiteWolf"},
    )
    assert available_before.status_code == 200
    assert available_before.json()["available"] is True

    set_nickname = client.patch(
        "/api/auth/me",
        headers=auth_headers(admin_token),
        json={"nickname": "SiteWolf"},
    )
    assert set_nickname.status_code == 200
    assert set_nickname.json()["nickname"] == "SiteWolf"
    assert set_nickname.json()["display_name"] == "SiteWolf"
    assert set_nickname.json().get("nickname_set_at")

    same_nickname = client.get(
        "/api/auth/nickname-availability",
        headers=auth_headers(admin_token),
        params={"nickname": "sitewolf"},
    )
    assert same_nickname.status_code == 200
    assert same_nickname.json()["available"] is True
    assert same_nickname.json()["locked"] is False

    other_admin = _create_user(client, admin_token, "admin-two@example.com", "admin")
    other_admin_token = _login(client, "admin-two@example.com")
    taken = client.get(
        "/api/auth/nickname-availability",
        headers=auth_headers(other_admin_token),
        params={"nickname": "SiteWolf"},
    )
    assert taken.status_code == 200
    assert taken.json()["available"] is False
    assert taken.json()["reason"] == "nickname_taken"
    assert taken.json()["locked"] is False
    assert other_admin["role"] == "admin"

    changed_nickname = client.patch(
        "/api/auth/me",
        headers=auth_headers(admin_token),
        json={"nickname": "DifferentName"},
    )
    assert changed_nickname.status_code == 200
    assert changed_nickname.json()["nickname"] == "DifferentName"
    assert changed_nickname.json()["display_name"] == "DifferentName"

    old_now_available = client.get(
        "/api/auth/nickname-availability",
        headers=auth_headers(other_admin_token),
        params={"nickname": "SiteWolf"},
    )
    assert old_now_available.status_code == 200
    assert old_now_available.json()["available"] is True

    take_old_nickname = client.patch(
        "/api/auth/me",
        headers=auth_headers(other_admin_token),
        json={"nickname": "SiteWolf"},
    )
    assert take_old_nickname.status_code == 200
    assert take_old_nickname.json()["nickname"] == "SiteWolf"

    cleared_nickname = client.patch(
        "/api/auth/me",
        headers=auth_headers(admin_token),
        json={"nickname": ""},
    )
    assert cleared_nickname.status_code == 200
    assert cleared_nickname.json()["nickname"] is None
    assert cleared_nickname.json()["nickname_set_at"] is None
    assert cleared_nickname.json()["display_name"] == cleared_nickname.json()["full_name"]

def test_nickname_admin_only(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "employee-nickname@example.com", "employee")
    employee_token = _login(client, "employee-nickname@example.com")

    check = client.get(
        "/api/auth/nickname-availability",
        headers=auth_headers(employee_token),
        params={"nickname": "CrewOne"},
    )
    assert check.status_code == 403

    set_nickname = client.patch(
        "/api/auth/me",
        headers=auth_headers(employee_token),
        json={"nickname": "CrewOne"},
    )
    assert set_nickname.status_code == 403
