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


def test_thread_icon_upload_accepts_heic_extension_without_image_mime(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "thread-heic-owner@example.com", "employee")
    employee_token = _login(client, "thread-heic-owner@example.com")

    created = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={"name": "HEIC icon thread"},
    )
    assert created.status_code == 200
    thread_id = created.json()["id"]

    icon_upload = client.post(
        f"/api/threads/{thread_id}/icon",
        headers=auth_headers(employee_token),
        files={"file": ("thread-icon.heic", b"fake-heic-icon", "application/octet-stream")},
    )
    assert icon_upload.status_code == 200
    assert icon_upload.json()["ok"] is True

    icon_file = client.get(f"/api/threads/{thread_id}/icon", headers=auth_headers(employee_token))
    assert icon_file.status_code == 200
    assert icon_file.content
    assert icon_file.headers.get("content-type", "").startswith("image/")
