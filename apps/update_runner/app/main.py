"""HTTP API for the SMPL update runner sidecar.

Surface (kept intentionally small):
- ``GET  /health``                 — liveness + active job summary
- ``POST /jobs/update``            — queue a new safe_update.sh run
- ``GET  /jobs/{job_id}``          — poll job status + log tail

All write endpoints require the ``X-Update-Token`` header to match the
configured shared secret. Read endpoints are also gated to keep the
auth model uniform.
"""
from __future__ import annotations

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import EXPECTED_TOKEN, ensure_directories
from .jobs import (
    JobInFlightError,
    JobStatus,
    get_active_job,
    get_job,
    queue_update_job,
    read_log_tail,
)


app = FastAPI(title="SMPL Update Runner", version="1.0.0")


@app.on_event("startup")
def _startup() -> None:
    ensure_directories()


def _check_auth(token: str | None) -> None:
    """Validate the shared-secret header. No-op when no token is configured.

    The "no token configured" path is for the local dev stack, where the
    runner sits on a private docker network with no host port exposure.
    Production deployments should always set ``UPDATE_RUNNER_TOKEN``.
    """
    if not EXPECTED_TOKEN:
        return
    if token != EXPECTED_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid update runner token")


# ── Schemas ───────────────────────────────────────────────────────────────────


class CreateUpdateJobRequest(BaseModel):
    branch: str = Field(default="main", min_length=1, max_length=200)
    pull: bool = True


class CreateUpdateJobResponse(BaseModel):
    job_id: str
    status: JobStatus


class JobResponse(BaseModel):
    job_id: str
    kind: str
    status: JobStatus
    started_at: str | None
    finished_at: str | None
    exit_code: int | None
    detail: str | None
    log_tail: str


class HealthResponse(BaseModel):
    ok: bool
    active_job_id: str | None


# ── Endpoints ─────────────────────────────────────────────────────────────────


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    active = get_active_job()
    return HealthResponse(ok=True, active_job_id=active.id if active else None)


@app.post("/jobs/update", response_model=CreateUpdateJobResponse, status_code=202)
def create_update_job(
    payload: CreateUpdateJobRequest,
    x_update_token: str | None = Header(default=None),
) -> CreateUpdateJobResponse:
    _check_auth(x_update_token)
    try:
        job = queue_update_job(branch=payload.branch, pull=payload.pull)
    except JobInFlightError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "An update job is already running.",
                "active_job_id": exc.active.id,
                "active_status": exc.active.status,
            },
        )
    return CreateUpdateJobResponse(job_id=job.id, status=job.status)


@app.get("/jobs/{job_id}", response_model=JobResponse)
def get_job_status(
    job_id: str,
    x_update_token: str | None = Header(default=None),
) -> JobResponse:
    _check_auth(x_update_token)
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Unknown job id")
    return JobResponse(
        job_id=job.id,
        kind=job.kind,
        status=job.status,
        started_at=job.started_at,
        finished_at=job.finished_at,
        exit_code=job.exit_code,
        detail=job.detail,
        log_tail=read_log_tail(job),
    )
