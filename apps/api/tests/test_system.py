from __future__ import annotations
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
import json
from fastapi.testclient import TestClient

from app.main import _rate_bucket
from app.routers import admin as admin_router
from app.services import update_runner_client


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}



def test_rate_limiter_returns_429_response_without_middleware_exception(client: TestClient):
    _rate_bucket.clear()
    warmup = client.get("/api")
    assert warmup.status_code == 200
    key = next((value for value in _rate_bucket.keys() if value.endswith(":default")), None)
    assert key is not None
    bucket = _rate_bucket[key]
    bucket.clear()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for _ in range(480):
        bucket.append(now)

    limited = client.get("/api")
    assert limited.status_code == 429
    assert limited.json().get("detail") == "Too many requests"
    assert limited.headers.get("Retry-After") == "60"
    _rate_bucket.clear()


# ── v2.4.6 cross-admin update visibility ─────────────────────────────────


def _stub_install_runner_path(monkeypatch) -> None:
    """Stub helpers shared by the active-update tests so dispatch
    succeeds without actually shelling out to git/alembic."""
    monkeypatch.setattr(
        admin_router,
        "_fetch_update_status",
        lambda: admin_router.UpdateStatusOut(
            repository="example/repo",
            branch="main",
            install_supported=True,
            install_mode="auto",
            install_steps=[],
            latest_version="v2.4.6",
            latest_commit="abc1234",
        ),
    )
    monkeypatch.setattr(admin_router, "_resolve_repo_root", lambda: Path("/tmp/repo"))


def test_active_update_endpoint_starts_null(client: TestClient, admin_token: str):
    """Steady state: with no job in flight, GET /admin/updates/active
    returns an all-null shape (not a 404). The FE polls this on every
    System-tab visit and treats null as the show-Install-button signal."""
    response = client.get(
        "/api/admin/updates/active",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["job_id"] is None
    assert body["started_at"] is None
    assert body["started_by_user_id"] is None
    assert body["started_by_display_name"] is None


def test_install_persists_active_job_for_other_admins(
    client: TestClient, admin_token: str, monkeypatch
):
    """When admin A dispatches an install, the active-job snapshot is
    written so admin B (any other session) can see the in-flight job
    via GET /admin/updates/active without knowing the job_id locally."""
    _stub_install_runner_path(monkeypatch)
    monkeypatch.setattr(
        update_runner_client,
        "queue_update_job",
        lambda branch="main", pull=True: {"job_id": "job-cross-1", "status": "queued"},
    )

    install = client.post(
        "/api/admin/updates/install",
        headers=auth_headers(admin_token),
        json={"dry_run": False},
    )
    assert install.status_code == 200
    assert install.json()["job_id"] == "job-cross-1"

    # Simulate admin B fetching the active-update endpoint — they get
    # the same job_id without ever having received it from /install.
    active = client.get(
        "/api/admin/updates/active",
        headers=auth_headers(admin_token),
    )
    assert active.status_code == 200
    assert active.json()["job_id"] == "job-cross-1"
    assert active.json()["started_by_display_name"]  # populated from admin user
    assert active.json()["started_at"]               # ISO timestamp


def test_progress_terminal_status_clears_active_job(
    client: TestClient, admin_token: str, monkeypatch
):
    """Once the runner reports a terminal status (succeeded / failed /
    cancelled), the next progress poll clears the cached active-job
    snapshot so the next install starts cleanly."""
    _stub_install_runner_path(monkeypatch)
    monkeypatch.setattr(
        update_runner_client,
        "queue_update_job",
        lambda branch="main", pull=True: {"job_id": "job-terminal-1", "status": "queued"},
    )

    install = client.post(
        "/api/admin/updates/install",
        headers=auth_headers(admin_token),
        json={"dry_run": False},
    )
    assert install.status_code == 200

    # First poll: still running. Active snapshot stays.
    monkeypatch.setattr(
        update_runner_client,
        "get_job_status",
        lambda job_id: {"job_id": job_id, "kind": "update", "status": "running"},
    )
    running = client.get(
        "/api/admin/updates/progress/job-terminal-1",
        headers=auth_headers(admin_token),
    )
    assert running.status_code == 200
    still_active = client.get(
        "/api/admin/updates/active",
        headers=auth_headers(admin_token),
    )
    assert still_active.json()["job_id"] == "job-terminal-1"

    # Now the runner reports succeeded. Polling once should clear the
    # active-job snapshot.
    monkeypatch.setattr(
        update_runner_client,
        "get_job_status",
        lambda job_id: {"job_id": job_id, "kind": "update", "status": "succeeded"},
    )
    done = client.get(
        "/api/admin/updates/progress/job-terminal-1",
        headers=auth_headers(admin_token),
    )
    assert done.status_code == 200
    cleared = client.get(
        "/api/admin/updates/active",
        headers=auth_headers(admin_token),
    )
    assert cleared.json()["job_id"] is None


def test_progress_404_for_unknown_job_clears_stale_snapshot(
    client: TestClient, admin_token: str, monkeypatch
):
    """If the runner has forgotten the job (e.g. runner restarted
    between dispatch and poll), GET /admin/updates/progress/{job_id}
    returns 404 AND clears the stale active-job snapshot — otherwise
    other admin sessions would keep polling a ghost id forever."""
    _stub_install_runner_path(monkeypatch)
    monkeypatch.setattr(
        update_runner_client,
        "queue_update_job",
        lambda branch="main", pull=True: {"job_id": "job-ghost-1", "status": "queued"},
    )
    install = client.post(
        "/api/admin/updates/install",
        headers=auth_headers(admin_token),
        json={"dry_run": False},
    )
    assert install.status_code == 200

    def _missing(job_id: str):
        raise KeyError(job_id)

    monkeypatch.setattr(update_runner_client, "get_job_status", _missing)

    response = client.get(
        "/api/admin/updates/progress/job-ghost-1",
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 404

    cleared = client.get(
        "/api/admin/updates/active",
        headers=auth_headers(admin_token),
    )
    assert cleared.json()["job_id"] is None
