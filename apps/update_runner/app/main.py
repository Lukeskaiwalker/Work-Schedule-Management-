"""HTTP API for the SMPL update runner sidecar.

Surface (kept intentionally small):
- ``GET    /health``                  — liveness + active job summary
- ``POST   /jobs/update``             — queue a new safe_update.sh run
- ``POST   /jobs/backup``             — queue a new backup.sh run
- ``POST   /jobs/restore``            — queue a new restore.sh run for a file
- ``GET    /jobs/{job_id}``           — poll job status + log tail
- ``GET    /backups``                 — list encrypted archive files
- ``GET    /backups/{filename}``      — stream a backup file body
- ``POST   /backups/upload``          — accept a multipart upload
- ``DELETE /backups/{filename}``      — remove a backup file

All write endpoints require the ``X-Update-Token`` header to match the
configured shared secret. Read endpoints are also gated to keep the
auth model uniform.
"""
from __future__ import annotations

from typing import Iterator

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import backups as backup_files
from .config import EXPECTED_TOKEN, ensure_directories
from .jobs import (
    JobInFlightError,
    JobStatus,
    get_active_job,
    get_job,
    queue_backup_job,
    queue_restore_job,
    queue_update_job,
    read_log_tail,
)


app = FastAPI(title="SMPL Update Runner", version="1.1.0")


@app.on_event("startup")
def _startup() -> None:
    ensure_directories()
    backup_files.ensure_backup_dir()


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


class CreateJobResponse(BaseModel):
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


class BackupFileOut(BaseModel):
    filename: str
    size_bytes: int
    created_at: str
    is_generated: bool


class BackupListResponse(BaseModel):
    files: list[BackupFileOut]
    free_bytes: int
    total_bytes: int


class CreateRestoreJobRequest(BaseModel):
    filename: str = Field(..., min_length=1, max_length=260)


class UploadBackupResponse(BaseModel):
    filename: str
    size_bytes: int


# ── Helpers ───────────────────────────────────────────────────────────────────


def _job_in_flight_error(exc: JobInFlightError) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "message": "A runner job is already running.",
            "active_job_id": exc.active.id,
            "active_status": exc.active.status,
            "active_kind": exc.active.kind,
        },
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    active = get_active_job()
    return HealthResponse(ok=True, active_job_id=active.id if active else None)


@app.post("/jobs/update", response_model=CreateJobResponse, status_code=202)
def create_update_job(
    payload: CreateUpdateJobRequest,
    x_update_token: str | None = Header(default=None),
) -> CreateJobResponse:
    _check_auth(x_update_token)
    try:
        job = queue_update_job(branch=payload.branch, pull=payload.pull)
    except JobInFlightError as exc:
        raise _job_in_flight_error(exc)
    return CreateJobResponse(job_id=job.id, status=job.status)


@app.post("/jobs/backup", response_model=CreateJobResponse, status_code=202)
def create_backup_job(
    x_update_token: str | None = Header(default=None),
) -> CreateJobResponse:
    """Kick off ``scripts/backup.sh`` in the background.

    The script reads the passphrase from ``BACKUP_PASSPHRASE`` in the runner's
    env (forwarded via docker-compose). Returns immediately with a job id; the
    caller polls ``/jobs/{id}`` for completion.
    """
    _check_auth(x_update_token)
    try:
        job = queue_backup_job()
    except JobInFlightError as exc:
        raise _job_in_flight_error(exc)
    return CreateJobResponse(job_id=job.id, status=job.status)


@app.post("/jobs/restore", response_model=CreateJobResponse, status_code=202)
def create_restore_job(
    payload: CreateRestoreJobRequest,
    x_update_token: str | None = Header(default=None),
) -> CreateJobResponse:
    """Kick off ``scripts/restore.sh <backups/filename>`` in the background.

    The filename must already exist in the backups directory and pass the
    safety check. The script does the rest: decrypt, ``pg_restore --clean``,
    untar uploads, restart the stack.
    """
    _check_auth(x_update_token)
    try:
        path, _ = backup_files.open_for_read(payload.filename)
    except backup_files.InvalidBackupName as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Backup not found: {payload.filename}")

    try:
        job = queue_restore_job(filename=path.name)
    except JobInFlightError as exc:
        raise _job_in_flight_error(exc)
    return CreateJobResponse(job_id=job.id, status=job.status)


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


@app.get("/backups", response_model=BackupListResponse)
def list_backup_files(
    x_update_token: str | None = Header(default=None),
) -> BackupListResponse:
    """Return every recognised backup file with size + mtime, plus disk stats.

    The ``free_bytes`` value lets the api warn the operator before kicking off
    a backup that might exhaust the partition.
    """
    _check_auth(x_update_token)
    files = backup_files.list_backups()
    total_bytes, free_bytes = backup_files.disk_usage()
    return BackupListResponse(
        files=[
            BackupFileOut(
                filename=item.filename,
                size_bytes=item.size_bytes,
                created_at=item.created_at,
                is_generated=item.is_generated,
            )
            for item in files
        ],
        free_bytes=free_bytes,
        total_bytes=total_bytes,
    )


@app.get("/backups/{filename}")
def download_backup(
    filename: str,
    x_update_token: str | None = Header(default=None),
) -> StreamingResponse:
    """Stream the contents of a backup file. The api proxies this through to
    its own admin endpoint so browsers never see the runner's URL."""
    _check_auth(x_update_token)
    try:
        path, size = backup_files.open_for_read(filename)
    except backup_files.InvalidBackupName as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Backup not found: {filename}")

    def _iter_file(chunk_size: int = 1024 * 256) -> Iterator[bytes]:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(chunk_size)
                if not chunk:
                    return
                yield chunk

    return StreamingResponse(
        _iter_file(),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(size),
            "Content-Disposition": f'attachment; filename="{path.name}"',
        },
    )


@app.post("/backups/upload", response_model=UploadBackupResponse, status_code=201)
def upload_backup(
    file: UploadFile = File(...),
    x_update_token: str | None = Header(default=None),
) -> UploadBackupResponse:
    """Stream an uploaded backup file into the backups directory.

    Filename is taken from the multipart part. Operators can rename a file
    before upload but the result still has to satisfy the filename whitelist
    so it shows up in the listing afterwards.
    """
    _check_auth(x_update_token)
    raw_name = (file.filename or "").strip()
    if not raw_name:
        raise HTTPException(status_code=400, detail="Uploaded file has no filename")
    try:
        backup_files.safe_resolve(raw_name)  # validates name only
    except backup_files.InvalidBackupName as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    def _chunks() -> Iterator[bytes]:
        # UploadFile.file is a sync stream; iterate in chunks to keep memory flat.
        while True:
            chunk = file.file.read(1024 * 256)
            if not chunk:
                return
            yield chunk

    try:
        size = backup_files.write_uploaded_chunks(raw_name, _chunks())
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write backup: {exc}")
    return UploadBackupResponse(filename=raw_name, size_bytes=size)


@app.delete("/backups/{filename}")
def delete_backup_file(
    filename: str,
    x_update_token: str | None = Header(default=None),
) -> dict:
    _check_auth(x_update_token)
    try:
        removed = backup_files.delete_backup(filename)
    except backup_files.InvalidBackupName as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not removed:
        raise HTTPException(status_code=404, detail=f"Backup not found: {filename}")
    return {"deleted": filename}
