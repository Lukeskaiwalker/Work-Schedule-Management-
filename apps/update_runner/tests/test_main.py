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
    """Replace subprocess.Popen so the job completes immediately without forking
    a real shell — we want to verify the runner's lifecycle plumbing AND the
    new ::SMPL_STAGE: marker parsing, not the contents of backup.sh.

    v2.3.2 switched _run_subprocess from subprocess.run() to subprocess.Popen()
    so it can read stdout line-by-line and parse progress markers in real time.
    The stub here mirrors that contract: returns a Popen-like object whose
    .stdout iterates over canned lines including marker lines.
    """
    import subprocess

    captured: dict[str, Any] = {}

    class _FakePopen:
        def __init__(self, cmd, cwd, stdout, stderr, env, text, bufsize):
            captured["cmd"] = cmd
            captured["cwd"] = cwd
            captured["env_has_compose"] = "COMPOSE_PROJECT_NAME" in env
            self.returncode = 0
            self.stdout = iter([
                "backup.sh starting\n",
                "::SMPL_STAGE: ensure_containers 5 Container vorbereiten\n",
                "Ensuring database + api containers are running...\n",
                "::SMPL_STAGE: db_dump 25 Datenbank-Dump\n",
                "Creating database dump...\n",
                "::SMPL_STAGE: done 100 Fertig\n",
                "::SMPL_SUMMARY: filename=backup-20260501-145012.tar.enc "
                "size_bytes=3671152672 duration_seconds=492 warnings=0\n",
                "backup-...tar.enc created\n",
            ])

        def wait(self):
            return 0

    monkeypatch.setattr(subprocess, "Popen", _FakePopen)

    response = runner_test_client.post("/jobs/backup")
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    # Regression for v2.3.3 prod outage: backup.sh's progress markers were
    # invisible during the run because libc inside the subprocess full-
    # buffered stdout when piped. The fix is to prepend `stdbuf -oL` so
    # libc switches to line-buffering. Lock that contract in here so any
    # future refactor that drops the wrapping fails loudly at CI time.
    captured_cmd = captured.get("cmd", [])
    assert captured_cmd[:2] == ["stdbuf", "-oL"], (
        f"runner must prepend stdbuf -oL for line-buffered progress markers; "
        f"got cmd={captured_cmd}"
    )
    assert "backup.sh" in str(captured_cmd[2:]), (
        f"backup.sh script invocation should follow stdbuf args; got {captured_cmd}"
    )

    # The thread runs synchronously enough that by the time we poll, it should
    # have completed. We're stubbing subprocess.Popen so there's no I/O latency.
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
    # Marker parsing reached the final stage and summary
    assert status["stage"] == "done"
    assert status["progress_percent"] == 100
    assert status["stage_label"] == "Fertig"
    assert status["summary_filename"] == "backup-20260501-145012.tar.enc"
    assert status["summary_size_bytes"] == 3671152672
    assert status["summary_duration_seconds"] == 492
    assert status["summary_warnings"] == 0
    # Marker lines are still preserved in the log_tail (operators see them)
    assert "::SMPL_STAGE: db_dump" in status["log_tail"]


def test_update_job_check_only_appends_flag(runner_test_client, monkeypatch: pytest.MonkeyPatch):
    """v2.5.9: POST /jobs/update with check_only=true must invoke
    safe_update.sh with --check-only appended.

    Backs the UI's Dry-run button: before this fix, the api fell through to
    its own in-process preflight which couldn't see /repo on this deployment
    style and surfaced "Could not locate a git repository" to the operator.
    The runner now handles both real installs AND dry-runs through the same
    endpoint, with check_only swapping in --check-only for the script."""
    import subprocess

    captured: dict[str, Any] = {}

    class _FakePopen:
        def __init__(self, cmd, cwd, stdout, stderr, env, text, bufsize):
            captured["cmd"] = cmd
            self.returncode = 0
            self.stdout = iter([
                "safe_update.sh (--check-only) starting\n",
                "::SMPL_STAGE: build 50 Build\n",
                "::SMPL_STAGE: done 100 Preflight OK\n",
            ])

        def wait(self):
            return 0

    monkeypatch.setattr(subprocess, "Popen", _FakePopen)

    response = runner_test_client.post(
        "/jobs/update",
        json={"branch": "main", "pull": True, "check_only": True},
    )
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    captured_cmd = captured.get("cmd", [])
    # stdbuf wrapping is preserved for line-buffered progress markers.
    assert captured_cmd[:2] == ["stdbuf", "-oL"], (
        f"runner must prepend stdbuf -oL; got cmd={captured_cmd}"
    )
    cmd_str = " ".join(str(part) for part in captured_cmd[2:])
    assert "safe_update.sh" in cmd_str
    assert "--pull" in cmd_str
    assert "--branch" in cmd_str
    assert "--check-only" in cmd_str, (
        f"check_only=true must append --check-only to safe_update.sh; "
        f"got cmd={captured_cmd}"
    )

    # Drain the stubbed run so the job reaches a terminal state cleanly.
    import time
    for _ in range(20):
        status = runner_test_client.get(f"/jobs/{job_id}").json()
        if status["status"] in ("succeeded", "failed"):
            break
        time.sleep(0.05)
    assert status["status"] == "succeeded"
    assert status["kind"] == "update"


def test_update_job_restores_repo_ownership_at_end(
    runner_test_client, runner_tmp_repo: Path, monkeypatch: pytest.MonkeyPatch
):
    """v2.5.10: every job (update/backup/restore) must chown -R the bind-mounted
    /repo back to its original uid:gid after the subprocess finishes.

    The runner runs as root for docker-socket access, so any file it writes
    to /repo via safe_update.sh / backup.sh lands root-owned on the host —
    which silently breaks subsequent host-side ``git fetch`` from the
    non-root operator account, both via the "dubious ownership" guard and
    via root-owned ``.git/objects/<xx>/`` subdirs. The fix runs in
    _run_subprocess's finally block, snapshotting REPO_ROOT.stat() and
    invoking chown -R."""
    import subprocess

    chown_calls: list[list[str]] = []

    real_run = subprocess.run

    def captured_run(cmd, *args, **kwargs):
        # Only intercept the chown invocations from _restore_repo_ownership.
        # Other subprocess.run calls (none currently in the runner, but
        # belt-and-suspenders) fall through to the real implementation.
        if isinstance(cmd, list) and cmd and cmd[0] == "chown":
            chown_calls.append(list(cmd))

            class _Result:
                returncode = 0
                stdout = ""
                stderr = ""

            return _Result()
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", captured_run)

    class _FakePopen:
        def __init__(self, cmd, cwd, stdout, stderr, env, text, bufsize):
            self.returncode = 0
            self.stdout = iter(["safe_update.sh starting\n", "done\n"])

        def wait(self):
            return 0

    monkeypatch.setattr(subprocess, "Popen", _FakePopen)

    response = runner_test_client.post(
        "/jobs/update",
        json={"branch": "main", "pull": True},
    )
    assert response.status_code == 202
    job_id = response.json()["job_id"]

    import time
    for _ in range(20):
        status = runner_test_client.get(f"/jobs/{job_id}").json()
        if status["status"] in ("succeeded", "failed"):
            break
        time.sleep(0.05)
    assert status["status"] == "succeeded"

    # Exactly one chown -R was invoked at end of job.
    assert len(chown_calls) == 1, f"expected one chown call, got {chown_calls}"
    chown_cmd = chown_calls[0]
    assert chown_cmd[0] == "chown"
    assert "-R" in chown_cmd
    # Target is the uid:gid from REPO_ROOT.stat() — verify the chown targets
    # the test's REPO_ROOT (the conftest tmpdir) and that uid:gid was captured
    # from a real stat() call (digits + colon). We can't assert the literal
    # uid/gid values because the test runner's process uid is arbitrary.
    assert chown_cmd[-1] == str(runner_tmp_repo)
    uid_gid = chown_cmd[-2]
    assert ":" in uid_gid, f"expected uid:gid token, got {uid_gid!r}"
    uid_str, gid_str = uid_gid.split(":")
    assert uid_str.isdigit() and gid_str.isdigit()
    # Sanity-check it matches what os.stat() reports for the tmpdir.
    actual_stat = runner_tmp_repo.stat()
    assert uid_gid == f"{actual_stat.st_uid}:{actual_stat.st_gid}"

    # The chown step's outcome must appear in the log tail so an operator
    # debugging "why are my files still root-owned" can confirm whether the
    # post-job hook actually ran.
    assert "[ownership]" in status["log_tail"]


def test_update_job_default_omits_check_only_flag(runner_test_client, monkeypatch: pytest.MonkeyPatch):
    """Default behavior (no check_only in body, or check_only=false) MUST NOT
    pass --check-only — otherwise every real install would silently become a
    preflight. Regression guard for the v2.5.9 change."""
    import subprocess

    captured: dict[str, Any] = {}

    class _FakePopen:
        def __init__(self, cmd, cwd, stdout, stderr, env, text, bufsize):
            captured["cmd"] = cmd
            self.returncode = 0
            self.stdout = iter(["safe_update.sh starting\n"])

        def wait(self):
            return 0

    monkeypatch.setattr(subprocess, "Popen", _FakePopen)

    # check_only omitted → defaults to False (Pydantic schema default).
    response = runner_test_client.post(
        "/jobs/update",
        json={"branch": "main", "pull": True},
    )
    assert response.status_code == 202

    cmd_str = " ".join(str(part) for part in captured.get("cmd", []))
    assert "safe_update.sh" in cmd_str
    assert "--check-only" not in cmd_str, (
        f"default invocation MUST NOT include --check-only; got cmd={captured.get('cmd')}"
    )
