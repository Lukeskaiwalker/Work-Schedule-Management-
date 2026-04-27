"""In-memory job registry + the safe_update.sh subprocess runner.

Design constraints worth knowing before changing this module:

- **Single active job at a time.** The lock is intentionally process-local
  because the runner runs with ``--workers 1``. Adding a worker would silently
  break the "one job at a time" invariant; if you ever scale the runner,
  promote this lock to something like a filesystem flock or a Redis SETNX.

- **Subprocess is detached from the request.** ``threading.Thread`` is fine
  here because uvicorn's request lifecycle does not bound the subprocess —
  the http response returns the moment the job is queued, then the worker
  thread runs ``safe_update.sh`` to completion in the background.

- **Logs go to disk, not the process buffer.** A complete safe_update.sh run
  can produce tens of thousands of lines (docker build output, alembic SQL,
  etc). We write to a per-job file and serve a tail; we do not hold the
  full transcript in memory.
"""
from __future__ import annotations

import os
import subprocess
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from .config import COMPOSE_PROJECT_NAME, JOB_LOG_DIR, LOG_TAIL_BYTES, REPO_ROOT


JobStatus = Literal["queued", "running", "succeeded", "failed"]


class Job:
    """A single safe_update.sh invocation tracked by the runner."""

    __slots__ = (
        "id",
        "kind",
        "status",
        "started_at",
        "finished_at",
        "exit_code",
        "detail",
        "log_path",
    )

    def __init__(self, job_id: str, kind: str) -> None:
        self.id: str = job_id
        self.kind: str = kind
        self.status: JobStatus = "queued"
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.exit_code: int | None = None
        self.detail: str | None = None
        self.log_path: Path = JOB_LOG_DIR / f"{job_id}.log"

    def to_dict(self) -> dict:
        return {
            "job_id": self.id,
            "kind": self.kind,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "exit_code": self.exit_code,
            "detail": self.detail,
        }


_jobs: dict[str, Job] = {}
_active_job: Job | None = None
_lock = threading.Lock()


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_job(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def get_active_job() -> Job | None:
    return _active_job


def read_log_tail(job: Job) -> str:
    """Read the last ``LOG_TAIL_BYTES`` of the job's log file as utf-8.

    Returns an empty string if the file does not yet exist (job just queued)
    or could not be read. Read errors are intentionally swallowed — the
    log tail is informational, not authoritative.
    """
    if not job.log_path.is_file():
        return ""
    try:
        with job.log_path.open("rb") as handle:
            try:
                handle.seek(-LOG_TAIL_BYTES, os.SEEK_END)
            except OSError:
                # File smaller than tail size; read from start.
                handle.seek(0)
            data = handle.read()
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""


def queue_update_job(*, branch: str, pull: bool) -> Job:
    """Create and start a new safe_update.sh job. Raises if one is in flight."""
    global _active_job
    with _lock:
        if _active_job is not None and _active_job.status in ("queued", "running"):
            raise JobInFlightError(_active_job)
        job_id = uuid.uuid4().hex[:12]
        job = Job(job_id, "update")
        _jobs[job_id] = job
        _active_job = job

    thread = threading.Thread(
        target=_run_safe_update,
        args=(job, branch, pull),
        daemon=False,
        name=f"update-runner-{job_id}",
    )
    thread.start()
    return job


class JobInFlightError(RuntimeError):
    def __init__(self, active: Job) -> None:
        self.active = active
        super().__init__(f"An update job is already running: {active.id}")


def _build_command(branch: str, pull: bool) -> list[str]:
    cmd = ["./scripts/safe_update.sh"]
    if pull:
        cmd.extend(["--pull", "--branch", branch])
    return cmd


def _run_safe_update(job: Job, branch: str, pull: bool) -> None:
    """Background worker. Captures all output to the per-job log file."""
    global _active_job

    job.status = "running"
    job.started_at = _utcnow_iso()
    cmd = _build_command(branch, pull)
    env = os.environ.copy()
    env["COMPOSE_PROJECT_NAME"] = COMPOSE_PROJECT_NAME

    try:
        with job.log_path.open("w", encoding="utf-8") as log:
            log.write(
                f"[{job.started_at}] Starting safe_update.sh "
                f"(cwd={REPO_ROOT}, cmd={' '.join(cmd)}, "
                f"COMPOSE_PROJECT_NAME={COMPOSE_PROJECT_NAME})\n"
            )
            log.flush()
            try:
                result = subprocess.run(
                    cmd,
                    cwd=str(REPO_ROOT),
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    env=env,
                    check=False,
                )
                job.exit_code = result.returncode
                if result.returncode == 0:
                    job.status = "succeeded"
                    job.detail = "safe_update.sh completed successfully."
                else:
                    job.status = "failed"
                    job.detail = (
                        f"safe_update.sh exited with code {result.returncode}. "
                        "Check the log tail for details."
                    )
            except FileNotFoundError as exc:
                job.status = "failed"
                job.detail = f"Update script missing: {exc}"
                log.write(f"\n[runner-error] FileNotFoundError: {exc}\n")
            except Exception as exc:  # noqa: BLE001 — we want to surface anything
                job.status = "failed"
                job.detail = f"Update runner crashed: {exc!r}"
                log.write(f"\n[runner-error] {exc!r}\n")
    finally:
        job.finished_at = _utcnow_iso()
        try:
            with job.log_path.open("a", encoding="utf-8") as log:
                log.write(
                    f"[{job.finished_at}] Finished. status={job.status} "
                    f"exit_code={job.exit_code}\n"
                )
        except OSError:
            pass
        with _lock:
            if _active_job is job:
                _active_job = None
