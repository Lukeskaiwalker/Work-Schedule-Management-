"""In-memory job registry + subprocess runners for the update_runner sidecar.

Design constraints worth knowing before changing this module:

- **Single active job at a time.** The lock is intentionally process-local
  because the runner runs with ``--workers 1``. Adding a worker would silently
  break the "one job at a time" invariant; if you ever scale the runner,
  promote this lock to something like a filesystem flock or a Redis SETNX.
  This invariant is what keeps ``backup``, ``restore`` and ``update`` jobs
  from ever overlapping — running ``pg_dump`` while ``safe_update.sh`` is
  rebuilding the db service would corrupt either side.

- **Subprocess is detached from the request.** ``threading.Thread`` is fine
  here because uvicorn's request lifecycle does not bound the subprocess —
  the http response returns the moment the job is queued, then the worker
  thread runs the script to completion in the background.

- **Logs go to disk, not the process buffer.** A complete safe_update.sh run
  can produce tens of thousands of lines (docker build output, alembic SQL,
  etc). We write to a per-job file and serve a tail; we do not hold the
  full transcript in memory. backup/restore output is much smaller but uses
  the same plumbing for consistency.

- **Passphrases never land in process state.** ``BACKUP_PASSPHRASE`` is
  forwarded into the subprocess env and immediately discarded — Job objects
  carry only ids, status flags, and human-readable detail strings. The log
  files contain whatever the scripts print, which is intentionally never the
  passphrase.
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
JobKind = Literal["update", "backup", "restore"]


class Job:
    """A single privileged subprocess invocation tracked by the runner.

    The ``kind`` field discriminates between safe_update.sh, backup.sh and
    restore.sh runs — all three share the same lifecycle and log plumbing
    but produce different artefacts.
    """

    __slots__ = (
        "id",
        "kind",
        "status",
        "started_at",
        "finished_at",
        "exit_code",
        "detail",
        "log_path",
        # ── progress fields, populated by ::SMPL_STAGE: markers ──
        "stage",                       # short key, e.g. "db_dump"
        "stage_label",                 # human label, e.g. "Datenbank-Dump"
        "progress_percent",            # int 0..100
        # ── summary fields, populated by ::SMPL_SUMMARY: marker on success ──
        "summary_filename",
        "summary_size_bytes",
        "summary_duration_seconds",
        "summary_warnings",
    )

    def __init__(self, job_id: str, kind: JobKind) -> None:
        self.id: str = job_id
        self.kind: JobKind = kind
        self.status: JobStatus = "queued"
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.exit_code: int | None = None
        self.detail: str | None = None
        self.log_path: Path = JOB_LOG_DIR / f"{job_id}.log"
        self.stage: str | None = None
        self.stage_label: str | None = None
        self.progress_percent: int | None = None
        self.summary_filename: str | None = None
        self.summary_size_bytes: int | None = None
        self.summary_duration_seconds: int | None = None
        self.summary_warnings: int | None = None

    def to_dict(self) -> dict:
        return {
            "job_id": self.id,
            "kind": self.kind,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "exit_code": self.exit_code,
            "detail": self.detail,
            "stage": self.stage,
            "stage_label": self.stage_label,
            "progress_percent": self.progress_percent,
            "summary_filename": self.summary_filename,
            "summary_size_bytes": self.summary_size_bytes,
            "summary_duration_seconds": self.summary_duration_seconds,
            "summary_warnings": self.summary_warnings,
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
                handle.seek(0)
            data = handle.read()
        return data.decode("utf-8", errors="replace")
    except OSError:
        return ""


# ── Subprocess runner (shared by all job kinds) ───────────────────────────────


def _start_job(kind: JobKind) -> Job:
    """Allocate a Job, register it as the active one, return it.

    Raises ``JobInFlightError`` when another job is still running. The active
    flag is cleared by ``_finish_job``.
    """
    global _active_job
    with _lock:
        if _active_job is not None and _active_job.status in ("queued", "running"):
            raise JobInFlightError(_active_job)
        job_id = uuid.uuid4().hex[:12]
        job = Job(job_id, kind)
        _jobs[job_id] = job
        _active_job = job
    return job


def _finish_job(job: Job) -> None:
    """Mark the active slot empty if it still points at this job."""
    global _active_job
    with _lock:
        if _active_job is job:
            _active_job = None


_STAGE_MARKER_PREFIX = "::SMPL_STAGE: "
_SUMMARY_MARKER_PREFIX = "::SMPL_SUMMARY: "


def _maybe_parse_marker(line: str, job: Job) -> None:
    """Update ``job`` in place when ``line`` carries a progress marker.

    Markers are emitted by scripts/backup.sh (and future scripts). Format:
        ::SMPL_STAGE: <key> <percent> <human label may include spaces>
        ::SMPL_SUMMARY: filename=<f> size_bytes=<n> duration_seconds=<n> warnings=<n>

    Lines that don't match are passed through to the log unchanged. Parsing
    is intentionally forgiving — a malformed marker is treated as a regular
    log line, never as a job failure.
    """
    if line.startswith(_STAGE_MARKER_PREFIX):
        rest = line[len(_STAGE_MARKER_PREFIX):].rstrip("\n")
        parts = rest.split(maxsplit=2)
        if len(parts) >= 2:
            job.stage = parts[0]
            try:
                job.progress_percent = max(0, min(100, int(parts[1])))
            except ValueError:
                # Malformed percent — leave previous value, but still record stage
                pass
            if len(parts) == 3:
                job.stage_label = parts[2]
        return

    if line.startswith(_SUMMARY_MARKER_PREFIX):
        rest = line[len(_SUMMARY_MARKER_PREFIX):].rstrip("\n")
        # Each token is "key=value". We only accept a small whitelist so an
        # accidentally-emitted marker can't poison fields it shouldn't.
        for token in rest.split():
            if "=" not in token:
                continue
            key, value = token.split("=", 1)
            if key == "filename":
                job.summary_filename = value
            elif key in ("size_bytes", "duration_seconds", "warnings"):
                try:
                    int_value = int(value)
                except ValueError:
                    continue
                if key == "size_bytes":
                    job.summary_size_bytes = int_value
                elif key == "duration_seconds":
                    job.summary_duration_seconds = int_value
                elif key == "warnings":
                    job.summary_warnings = int_value


def _run_subprocess(
    job: Job,
    cmd: list[str],
    env: dict[str, str],
    *,
    success_detail: str,
    failure_detail_prefix: str,
    header: str | None = None,
) -> None:
    """Run ``cmd`` to completion, capturing all output to the job log file.

    Common shape for all three job kinds. The ``cwd`` is always ``REPO_ROOT``
    so script-relative paths (``./scripts/...``) resolve correctly. Keeps
    Job state immutable-by-method: each call sets a coherent
    started_at → exit_code → status → detail → finished_at sequence.

    Reads the subprocess's stdout line-by-line so progress markers can be
    parsed in real time (see ``_maybe_parse_marker``). Each line is still
    written to the log file unchanged — the marker prefix is preserved as a
    breadcrumb so an operator viewing the log tail sees the same checkpoints
    the UI does.
    """
    job.status = "running"
    job.started_at = _utcnow_iso()

    try:
        with job.log_path.open("w", encoding="utf-8") as log:
            log.write(
                f"[{job.started_at}] {header or 'Starting subprocess'}\n"
                f"  cwd={REPO_ROOT}\n"
                f"  cmd={' '.join(cmd)}\n"
                f"  COMPOSE_PROJECT_NAME={COMPOSE_PROJECT_NAME}\n"
            )
            log.flush()
            try:
                process = subprocess.Popen(
                    cmd,
                    cwd=str(REPO_ROOT),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    env=env,
                    text=True,
                    bufsize=1,  # line-buffered so progress shows up live
                )
                assert process.stdout is not None  # PIPE is always set above
                for line in process.stdout:
                    log.write(line)
                    log.flush()
                    _maybe_parse_marker(line, job)
                process.wait()
                job.exit_code = process.returncode
                if process.returncode == 0:
                    job.status = "succeeded"
                    job.detail = success_detail
                else:
                    job.status = "failed"
                    job.detail = (
                        f"{failure_detail_prefix} exited with code "
                        f"{process.returncode}. Check the log tail for details."
                    )
            except FileNotFoundError as exc:
                job.status = "failed"
                job.detail = f"Script missing: {exc}"
                log.write(f"\n[runner-error] FileNotFoundError: {exc}\n")
            except Exception as exc:  # noqa: BLE001
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
        _finish_job(job)


# ── safe_update.sh ────────────────────────────────────────────────────────────


class JobInFlightError(RuntimeError):
    def __init__(self, active: Job) -> None:
        self.active = active
        super().__init__(f"A runner job is already running: {active.id}")


def _build_update_command(branch: str, pull: bool) -> list[str]:
    cmd = ["./scripts/safe_update.sh"]
    if pull:
        cmd.extend(["--pull", "--branch", branch])
    return cmd


def queue_update_job(*, branch: str, pull: bool) -> Job:
    """Create and start a new safe_update.sh job. Raises if one is in flight."""
    job = _start_job("update")
    thread = threading.Thread(
        target=_run_update,
        args=(job, branch, pull),
        daemon=False,
        name=f"update-runner-{job.id}",
    )
    thread.start()
    return job


def _run_update(job: Job, branch: str, pull: bool) -> None:
    cmd = _build_update_command(branch, pull)
    env = os.environ.copy()
    env["COMPOSE_PROJECT_NAME"] = COMPOSE_PROJECT_NAME
    _run_subprocess(
        job,
        cmd,
        env,
        success_detail="safe_update.sh completed successfully.",
        failure_detail_prefix="safe_update.sh",
        header="Starting safe_update.sh",
    )


# ── scripts/backup.sh ─────────────────────────────────────────────────────────


def queue_backup_job() -> Job:
    """Create and start a new backup.sh job. Raises if one is in flight.

    The runner reads ``BACKUP_PASSPHRASE`` from its own env (forwarded by
    docker-compose). We do not accept the passphrase as a request parameter
    because every additional hop is one more place a leaked log could embarrass
    us. If the env var is missing the script bails out cleanly.
    """
    job = _start_job("backup")
    thread = threading.Thread(
        target=_run_backup,
        args=(job,),
        daemon=False,
        name=f"backup-runner-{job.id}",
    )
    thread.start()
    return job


def _run_backup(job: Job) -> None:
    cmd = ["./scripts/backup.sh"]
    env = os.environ.copy()
    env["COMPOSE_PROJECT_NAME"] = COMPOSE_PROJECT_NAME
    _run_subprocess(
        job,
        cmd,
        env,
        success_detail="Encrypted backup created in backups/.",
        failure_detail_prefix="backup.sh",
        header="Starting scripts/backup.sh",
    )


# ── scripts/restore.sh ────────────────────────────────────────────────────────


def queue_restore_job(*, filename: str) -> Job:
    """Create and start a restore.sh job for the given backup filename.

    The filename is resolved relative to the runner's repo root, which is the
    same path the api sees for listing. Filename safety is the caller's
    responsibility — endpoints validate via ``backups.safe_resolve`` before
    handing in.
    """
    job = _start_job("restore")
    thread = threading.Thread(
        target=_run_restore,
        args=(job, filename),
        daemon=False,
        name=f"restore-runner-{job.id}",
    )
    thread.start()
    return job


def _run_restore(job: Job, filename: str) -> None:
    backup_relpath = f"backups/{filename}"
    cmd = ["./scripts/restore.sh", backup_relpath]
    env = os.environ.copy()
    env["COMPOSE_PROJECT_NAME"] = COMPOSE_PROJECT_NAME
    _run_subprocess(
        job,
        cmd,
        env,
        success_detail=f"Restore from {filename} completed.",
        failure_detail_prefix="restore.sh",
        header=f"Starting scripts/restore.sh for {filename}",
    )
