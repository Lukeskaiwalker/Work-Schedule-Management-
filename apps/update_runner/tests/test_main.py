"""HTTP-level tests for the runner's backup endpoints.

These tests boot the FastAPI app in-process via ``TestClient`` rather than
spinning up a real container — that's enough to catch routing mistakes,
auth wiring, and serialization shape regressions. The actual subprocess
runs (backup.sh / restore.sh) are stubbed via monkeypatch.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest


def test_runner_app_exposes_upload_endpoint(runner_test_client):
    """Regression for v2.3.0 prod outage:

    `/backups/upload` is decorated with `Form()` / `UploadFile` parameters,
    which FastAPI's route loader validates at import time by trying to
    import `python-multipart`. If the runner's requirements.txt forgets
    that dep (as v2.3.0 originally did), the entire app fails to load
    with `RuntimeError: Form data requires python-multipart to be
    installed`, the container crashloops, and every backup-UI button
    starts returning 405 against the still-running v2.2.x runner.

    This assertion is the smallest possible smoke test: if the route
    isn't registered, the runner image is missing python-multipart
    (or some other Form-related dep) — fail CI early instead of
    discovering it during a prod rollout.
    """
    paths = {route.path for route in runner_test_client.app.routes}
    assert "/backups/upload" in paths, (
        "POST /backups/upload missing — likely python-multipart not in "
        "apps/update_runner/requirements.txt; FastAPI silently skipped the "
        "route during import. See v2.3.1 changelog."
    )


def test_health_endpoint(runner_test_client):
    response = runner_test_client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["active_job_id"] is None


def test_list_backups_empty(runner_test_client):
    response = runner_test_client.get("/backups")
    assert response.status_code == 200
    body = response.json()
    assert body["files"] == []
    assert body["free_bytes"] >= 0
    assert body["total_bytes"] >= 0


def test_list_backups_after_upload(runner_test_client):
    upload = runner_test_client.post(
        "/backups/upload",
        files={"file": ("backup-20260427-103000.tar.enc", b"hello", "application/octet-stream")},
    )
    assert upload.status_code == 201
    assert upload.json()["filename"] == "backup-20260427-103000.tar.enc"

    listing = runner_test_client.get("/backups").json()
    assert len(listing["files"]) == 1
    assert listing["files"][0]["filename"] == "backup-20260427-103000.tar.enc"
    assert listing["files"][0]["size_bytes"] == 5
    assert listing["files"][0]["is_generated"] is True


def test_upload_rejects_bad_filename(runner_test_client):
    response = runner_test_client.post(
        "/backups/upload",
        files={"file": ("../etc/passwd", b"x", "application/octet-stream")},
    )
    assert response.status_code == 400


def test_download_streams_file_body(runner_test_client):
    payload = b"\x00\x01\x02ENCRYPTED-BLOB"
    runner_test_client.post(
        "/backups/upload",
        files={"file": ("backup-20260427-103000.tar.enc", payload, "application/octet-stream")},
    )

    response = runner_test_client.get("/backups/backup-20260427-103000.tar.enc")
    assert response.status_code == 200
    assert response.content == payload
    assert "attachment" in response.headers.get("content-disposition", "")


def test_download_404_for_missing(runner_test_client):
    response = runner_test_client.get("/backups/nope.tar.enc")
    assert response.status_code == 404


def test_delete_removes_file(runner_test_client):
    runner_test_client.post(
        "/backups/upload",
        files={"file": ("backup-20260427-103000.tar.enc", b"x", "application/octet-stream")},
    )

    response = runner_test_client.delete("/backups/backup-20260427-103000.tar.enc")
    assert response.status_code == 200

    listing = runner_test_client.get("/backups").json()
    assert listing["files"] == []


def test_restore_404_when_file_missing(runner_test_client):
    response = runner_test_client.post(
        "/jobs/restore",
        json={"filename": "nonexistent.tar.enc"},
    )
    assert response.status_code == 404


def test_restore_400_for_invalid_filename(runner_test_client):
    response = runner_test_client.post(
        "/jobs/restore",
        json={"filename": "../escape"},
    )
    assert response.status_code == 400


def test_backup_job_queued_writes_log(runner_test_client, monkeypatch: pytest.MonkeyPatch):
    """Replace subprocess.run so the job completes immediately without forking
    a real shell — we want to verify the runner's lifecycle plumbing, not the
    contents of backup.sh.
    """
    import subprocess

    captured: dict[str, Any] = {}

    def fake_run(cmd, cwd, stdout, stderr, env, check):  # noqa: D401
        captured["cmd"] = cmd
        captured["cwd"] = cwd
        captured["env_has_compose"] = "COMPOSE_PROJECT_NAME" in env
        # Write something so read_log_tail() returns it.
        if hasattr(stdout, "write"):
            stdout.write("backup.sh starting\nbackup-...tar.enc created\n")
            stdout.flush()

        class _Result:
            returncode = 0

        return _Result()

    monkeypatch.setattr(subprocess, "run", fake_run)

    response = runner_test_client.post("/jobs/backup")
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    # The thread runs synchronously enough that by the time we poll, it should
    # have completed. We're stubbing subprocess.run so there's no I/O latency.
    import time
    for _ in range(20):
        status = runner_test_client.get(f"/jobs/{job_id}").json()
        if status["status"] in ("succeeded", "failed"):
            break
        time.sleep(0.05)

    assert status["status"] == "succeeded"
    assert status["kind"] == "backup"
    assert "backup.sh" in str(captured.get("cmd"))
    assert captured.get("env_has_compose") is True
