"""Tests for the admin Backups page endpoints (v2.3.0).

The api never touches the host filesystem for these endpoints — every call
proxies to the update_runner sidecar via ``app.services.update_runner_client``.
The ``_isolate_update_runner_client`` autouse fixture in ``conftest.py`` makes
each helper raise ``UpdateRunnerUnreachable`` by default, so individual tests
opt in by stubbing the specific helpers they exercise.

Tests fall into three buckets:

1. **Permission gates** — verify the new ``backups:manage`` /
   ``backups:restore`` permissions actually block non-admin callers.
2. **Happy path proxying** — stub the runner client and assert the api
   forwards arguments and shapes the response correctly.
3. **Error translation** — assert that runner-level errors (404 for missing
   files, 409 for in-flight jobs, ``UpdateRunnerUnreachable`` for a downed
   runner) map to the right HTTP statuses.
"""
from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str) -> dict[str, Any]:
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


def _login(client: TestClient, email: str, password: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    return response.headers["X-Access-Token"]


# ── Permission gates ─────────────────────────────────────────────────────────


def test_employee_cannot_list_backups(client: TestClient, admin_token: str):
    """Listing requires backups:manage; a vanilla employee must be 403'd."""
    _create_user(client, admin_token, "alice@example.com", "employee")
    employee_token = _login(client, "alice@example.com", "Password123!")

    response = client.get("/api/admin/backups", headers=auth_headers(employee_token))
    assert response.status_code == 403


def test_employee_cannot_create_full_backup(client: TestClient, admin_token: str):
    """Creating a full backup is a manage-level action."""
    _create_user(client, admin_token, "bob@example.com", "employee")
    employee_token = _login(client, "bob@example.com", "Password123!")

    response = client.post("/api/admin/backups/full", headers=auth_headers(employee_token))
    assert response.status_code == 403


def test_employee_cannot_restore_backup(client: TestClient, admin_token: str):
    """Restore is a separate, more dangerous permission."""
    _create_user(client, admin_token, "carol@example.com", "employee")
    employee_token = _login(client, "carol@example.com", "Password123!")

    response = client.post(
        "/api/admin/backups/backup-20260101-120000.tar.enc/restore",
        headers=auth_headers(employee_token),
    )
    assert response.status_code == 403


def test_employee_cannot_upload_backup(client: TestClient, admin_token: str):
    """Upload paves the road to a restore — same permission gate."""
    _create_user(client, admin_token, "dan@example.com", "employee")
    employee_token = _login(client, "dan@example.com", "Password123!")

    response = client.post(
        "/api/admin/backups/upload",
        headers=auth_headers(employee_token),
        files={"file": ("evil.tar.enc", b"junk", "application/octet-stream")},
    )
    assert response.status_code == 403


def test_employee_cannot_delete_backup(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "eve@example.com", "employee")
    employee_token = _login(client, "eve@example.com", "Password123!")

    response = client.delete(
        "/api/admin/backups/backup-20260101-120000.tar.enc",
        headers=auth_headers(employee_token),
    )
    assert response.status_code == 403


# ── Happy-path proxying (admin role with stubbed runner) ─────────────────────


def test_admin_list_backups_proxies_runner_payload(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    """The api should forward the runner's listing verbatim and add the
    passphrase_configured flag from settings.
    """
    from app.services import update_runner_client

    runner_payload = {
        "files": [
            {
                "filename": "backup-20260427-103000.tar.enc",
                "size_bytes": 12345678,
                "created_at": "2026-04-27T10:30:00+00:00",
                "is_generated": True,
            }
        ],
        "free_bytes": 9_000_000_000,
        "total_bytes": 50_000_000_000,
    }
    monkeypatch.setattr(update_runner_client, "list_backups", lambda: runner_payload)

    response = client.get("/api/admin/backups", headers=auth_headers(admin_token))
    assert response.status_code == 200
    body = response.json()
    assert body["files"] == runner_payload["files"]
    assert body["free_bytes"] == runner_payload["free_bytes"]
    assert body["total_bytes"] == runner_payload["total_bytes"]
    # passphrase_configured reflects settings.backup_passphrase — empty by
    # default in tests, so it must be False.
    assert body["passphrase_configured"] is False


def test_admin_list_backups_reports_passphrase_configured(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    """Setting BACKUP_PASSPHRASE flips the passphrase_configured flag."""
    from app.core.config import get_settings
    from app.services import update_runner_client

    monkeypatch.setattr(update_runner_client, "list_backups", lambda: {"files": []})
    monkeypatch.setattr(get_settings(), "backup_passphrase", "s3cret-passphrase")

    response = client.get("/api/admin/backups", headers=auth_headers(admin_token))
    assert response.status_code == 200
    assert response.json()["passphrase_configured"] is True


def test_admin_create_full_backup_returns_job_id(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services import update_runner_client

    captured: dict[str, Any] = {}

    def fake_queue() -> dict[str, Any]:
        captured["called"] = True
        return {"job_id": "abc123", "status": "queued"}

    monkeypatch.setattr(update_runner_client, "queue_backup_job", fake_queue)

    response = client.post("/api/admin/backups/full", headers=auth_headers(admin_token))
    assert response.status_code == 200
    assert response.json() == {"job_id": "abc123", "status": "queued"}
    assert captured.get("called") is True


def test_admin_restore_endpoint_forwards_filename(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services import update_runner_client

    captured: dict[str, str] = {}

    def fake_queue(*, filename: str) -> dict[str, Any]:
        captured["filename"] = filename
        return {"job_id": "restorejob1", "status": "queued"}

    monkeypatch.setattr(update_runner_client, "queue_restore_job", fake_queue)

    target = "backup-20260427-103000.tar.enc"
    response = client.post(
        f"/api/admin/backups/{target}/restore",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200
    assert captured["filename"] == target
    assert response.json()["job_id"] == "restorejob1"


def test_admin_delete_backup_proxies_to_runner(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services import update_runner_client

    captured: dict[str, str] = {}

    def fake_delete(filename: str) -> dict[str, Any]:
        captured["filename"] = filename
        return {"deleted": filename}

    monkeypatch.setattr(update_runner_client, "delete_backup", fake_delete)

    target = "backup-20260427-103000.tar.enc"
    response = client.delete(
        f"/api/admin/backups/{target}",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200
    assert captured["filename"] == target


# ── Error translation ────────────────────────────────────────────────────────


def test_runner_unreachable_returns_503(
    client: TestClient,
    admin_token: str,
):
    """The conftest fixture leaves all helpers raising UpdateRunnerUnreachable.
    Without re-stubbing, the list endpoint should map that to a 503 service
    unavailable so the UI knows the runner sidecar is down.
    """
    response = client.get("/api/admin/backups", headers=auth_headers(admin_token))
    assert response.status_code == 503


def test_restore_returns_404_when_runner_says_missing(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services import update_runner_client

    def fake_queue(*, filename: str):
        raise update_runner_client.UpdateRunnerRemoteError(
            404, f"Backup not found: {filename}"
        )

    monkeypatch.setattr(update_runner_client, "queue_restore_job", fake_queue)

    response = client.post(
        "/api/admin/backups/missing.tar.enc/restore",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 404


def test_restore_returns_409_when_other_job_active(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services import update_runner_client

    def fake_queue(*, filename: str):
        raise update_runner_client.UpdateRunnerJobConflict(
            "running-update-job", "An update job is already running."
        )

    monkeypatch.setattr(update_runner_client, "queue_restore_job", fake_queue)

    response = client.post(
        "/api/admin/backups/backup-20260101-120000.tar.enc/restore",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 409
    body = response.json()
    detail = body.get("detail", {})
    assert isinstance(detail, dict)
    assert detail.get("active_job_id") == "running-update-job"


# ── Audit logging ────────────────────────────────────────────────────────────


def test_full_backup_creation_writes_audit_entry(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    """Every state-changing backup action should leave a trail in the audit log."""
    from app.services import update_runner_client

    monkeypatch.setattr(
        update_runner_client,
        "queue_backup_job",
        lambda: {"job_id": "audit-test-job", "status": "queued"},
    )

    response = client.post("/api/admin/backups/full", headers=auth_headers(admin_token))
    assert response.status_code == 200

    audit = client.get("/api/admin/audit-logs", headers=auth_headers(admin_token))
    assert audit.status_code == 200
    actions = [entry["action"] for entry in audit.json()]
    assert "backup.full.start" in actions


def test_delete_backup_writes_audit_entry(
    client: TestClient,
    admin_token: str,
    monkeypatch: pytest.MonkeyPatch,
):
    from app.services import update_runner_client

    monkeypatch.setattr(
        update_runner_client,
        "delete_backup",
        lambda filename: {"deleted": filename},
    )

    response = client.delete(
        "/api/admin/backups/backup-20260427-103000.tar.enc",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200

    audit = client.get("/api/admin/audit-logs", headers=auth_headers(admin_token))
    assert audit.status_code == 200
    entries = audit.json()
    delete_entries = [
        entry for entry in entries if entry["action"] == "backup.full.delete"
    ]
    assert delete_entries, "expected backup.full.delete entry in audit log"
    assert delete_entries[0]["target_id"] == "backup-20260427-103000.tar.enc"
