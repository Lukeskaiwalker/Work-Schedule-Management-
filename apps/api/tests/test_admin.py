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


def test_admin_project_csv_template_and_import(client: TestClient, admin_token: str):
    template = client.get("/api/admin/projects/import-template.csv", headers=auth_headers(admin_token))
    assert template.status_code == 200
    assert "project_number" in template.text
    assert "customer_name" in template.text
    assert "order_value_net" in template.text
    assert "planned_hours_total" in template.text

    csv_payload = (
        "project_number,name,status,customer_name,Notiz,order_value_net,planned_costs,planned_hours_total\n"
        "7001,CSV Import Projekt,active,CSV Kunde,Importiert,100000,70000,120\n"
        ",Temp Projekt,in_progress,Temp Kunde,Ohne Nummer,5000,2000,8\n"
    )
    imported = client.post(
        "/api/admin/projects/import-csv",
        headers=auth_headers(admin_token),
        files={"file": ("projects.csv", csv_payload.encode("utf-8"), "text/csv")},
    )
    assert imported.status_code == 200
    assert imported.json()["processed_rows"] == 2
    assert imported.json()["created"] == 2
    assert imported.json()["temporary_numbers"] == 1
    assert imported.json()["skipped_filled_fields"] == 0

    projects = client.get("/api/projects", headers=auth_headers(admin_token))
    assert projects.status_code == 200
    assert any(entry["project_number"] == "7001" for entry in projects.json())

    imported_project = next(entry for entry in projects.json() if entry["project_number"] == "7001")
    finance = client.get(f"/api/projects/{imported_project['id']}/finance", headers=auth_headers(admin_token))
    assert finance.status_code == 200
    assert finance.json()["order_value_net"] == 100000.0
    assert finance.json()["planned_costs"] == 70000.0
    assert finance.json()["planned_hours_total"] == 120.0

def test_admin_invite_and_password_reset_links(client: TestClient, admin_token: str):
    created = _create_user(client, admin_token, "reset-user@example.com", "employee")

    invite = client.post(
        f"/api/admin/users/{created['id']}/send-invite",
        headers=auth_headers(admin_token),
    )
    assert invite.status_code == 200
    invite_payload = invite.json()
    assert invite_payload["user_id"] == created["id"]
    assert "/invite?token=" in invite_payload["invite_link"]
    invite_token = invite_payload["invite_link"].split("token=", 1)[1]

    accept = client.post(
        "/api/auth/invites/accept",
        json={
            "token": invite_token,
            "new_password": "InviteAccept123!",
            "full_name": "Invited Employee",
            "email": "reset-user-updated@example.com",
        },
    )
    assert accept.status_code == 200
    assert accept.json()["invite_accepted_at"] is not None
    assert accept.json()["email"] == "reset-user-updated@example.com"

    login_after_invite = client.post(
        "/api/auth/login",
        json={"email": "reset-user-updated@example.com", "password": "InviteAccept123!"},
    )
    assert login_after_invite.status_code == 200

    reset = client.post(
        f"/api/admin/users/{created['id']}/send-password-reset",
        headers=auth_headers(admin_token),
    )
    assert reset.status_code == 200
    reset_payload = reset.json()
    assert "/reset-password?token=" in reset_payload["reset_link"]
    reset_token = reset_payload["reset_link"].split("token=", 1)[1]

    confirm_reset = client.post(
        "/api/auth/password-reset/confirm",
        json={"token": reset_token, "new_password": "ResetDone123!"},
    )
    assert confirm_reset.status_code == 200
    assert confirm_reset.json()["ok"] is True

    login_after_reset = client.post(
        "/api/auth/login",
        json={"email": "reset-user-updated@example.com", "password": "ResetDone123!"},
    )
    assert login_after_reset.status_code == 200


def test_action_links_use_forwarded_public_host_when_config_is_localhost(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    from app.routers import admin as admin_router

    monkeypatch.setattr(admin_router.settings, "app_public_url", "https://localhost")

    created = _create_user(client, admin_token, "invite-host@example.com", "employee")
    invite = client.post(
        f"/api/admin/users/{created['id']}/send-invite",
        headers={
            **auth_headers(admin_token),
            "x-forwarded-proto": "https",
            "x-forwarded-host": "app.example.com",
        },
    )
    assert invite.status_code == 200
    assert invite.json()["invite_link"].startswith("https://app.example.com/invite?token=")

    reset = client.post(
        f"/api/admin/users/{created['id']}/send-password-reset",
        headers={
            **auth_headers(admin_token),
            "x-forwarded-proto": "https",
            "x-forwarded-host": "app.example.com",
        },
    )
    assert reset.status_code == 200
    assert reset.json()["reset_link"].startswith("https://app.example.com/reset-password?token=")


def test_smtp_settings_round_trip_and_invite_uses_runtime_config(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    from app.services import emailer

    captured: dict[str, object] = {}

    class FakeSMTP:
        def __init__(self, host: str, port: int, timeout: int):
            captured["host"] = host
            captured["port"] = port
            captured["timeout"] = timeout

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def ehlo(self):
            captured["ehlo"] = True

        def starttls(self):
            captured["starttls"] = True

        def login(self, username: str, password: str):
            captured["login"] = (username, password)

        def send_message(self, message):
            captured["from"] = message["From"]
            captured["to"] = message["To"]
            captured["subject"] = message["Subject"]

    monkeypatch.setattr(emailer.smtplib, "SMTP", FakeSMTP)

    update = client.patch(
        "/api/admin/settings/smtp",
        headers=auth_headers(admin_token),
        json={
            "host": "smtp.runtime.example",
            "port": 2525,
            "username": "mailer-user",
            "password": "runtime-secret",
            "starttls": True,
            "ssl": False,
            "from_email": "noreply@example.com",
            "from_name": "SMPL Admin",
        },
    )
    assert update.status_code == 200
    assert update.json()["host"] == "smtp.runtime.example"
    assert update.json()["port"] == 2525
    assert update.json()["username"] == "mailer-user"
    assert update.json()["has_password"] is True
    assert update.json()["configured"] is True
    assert update.json()["masked_password"].endswith("cret")

    settings_row = client.get("/api/admin/settings/smtp", headers=auth_headers(admin_token))
    assert settings_row.status_code == 200
    assert settings_row.json()["host"] == "smtp.runtime.example"
    assert settings_row.json()["from_email"] == "noreply@example.com"
    assert settings_row.json()["has_password"] is True

    created = _create_user(client, admin_token, "smtp-invite@example.com", "employee")
    invite = client.post(
        f"/api/admin/users/{created['id']}/send-invite",
        headers=auth_headers(admin_token),
    )
    assert invite.status_code == 200
    assert invite.json()["sent"] is True
    assert captured["host"] == "smtp.runtime.example"
    assert captured["port"] == 2525
    assert captured["login"] == ("mailer-user", "runtime-secret")
    assert captured["starttls"] is True
    assert captured["from"] == "SMPL Admin <noreply@example.com>"
    assert captured["to"] == "smtp-invite@example.com"


def test_password_reset_completion_marks_pending_invite_as_accepted(client: TestClient, admin_token: str):
    created = _create_user(client, admin_token, "invite-reset-state@example.com", "employee")

    invite = client.post(
        f"/api/admin/users/{created['id']}/send-invite",
        headers=auth_headers(admin_token),
    )
    assert invite.status_code == 200

    reset = client.post(
        f"/api/admin/users/{created['id']}/send-password-reset",
        headers=auth_headers(admin_token),
    )
    assert reset.status_code == 200
    reset_token = reset.json()["reset_link"].split("token=", 1)[1]

    confirm_reset = client.post(
        "/api/auth/password-reset/confirm",
        json={"token": reset_token, "new_password": "StateReset123!"},
    )
    assert confirm_reset.status_code == 200

    users = client.get("/api/admin/users", headers=auth_headers(admin_token))
    assert users.status_code == 200
    updated = next(row for row in users.json() if row["id"] == created["id"])
    assert updated["invite_sent_at"] is not None
    assert updated["invite_accepted_at"] is not None

    login_after_reset = client.post(
        "/api/auth/login",
        json={"email": "invite-reset-state@example.com", "password": "StateReset123!"},
    )
    assert login_after_reset.status_code == 200
