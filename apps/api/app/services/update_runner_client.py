"""HTTP client for talking to the ``update_runner`` sidecar.

The runner owns docker-socket access and orchestrates ``safe_update.sh`` plus
``backup.sh`` / ``restore.sh`` runs. The api never touches docker directly —
every privileged action is mediated through this client. Keeping the client
small and well-typed makes the trust boundary easy to audit: anything that
hits the runner goes through one of these functions.

For long-running streaming endpoints (backup download/upload) the client uses
``httpx.Client.stream()`` so multi-GB files never need to be buffered in api
memory. The connect-timeout still bounds "is the runner alive?", but the read
timeout is relaxed because a backup transfer can legitimately take minutes.
"""
from __future__ import annotations

from typing import Any, AsyncIterator, BinaryIO, Iterator

import httpx

from app.core.config import get_settings


class UpdateRunnerError(RuntimeError):
    """Base class for any failure reaching or talking to the runner."""


class UpdateRunnerUnreachable(UpdateRunnerError):
    """The runner is not configured, not running, or refused the connection.

    Callers should treat this as "feature unavailable" and fall back to the
    legacy in-process path or surface a manual-install message — not as an
    operational error to propagate to the end user as a 500.
    """


class UpdateRunnerJobConflict(UpdateRunnerError):
    """The runner already has an active job. ``active_job_id`` carries it."""

    def __init__(self, active_job_id: str | None, message: str) -> None:
        super().__init__(message)
        self.active_job_id = active_job_id


class UpdateRunnerRemoteError(UpdateRunnerError):
    """Runner reachable but returned a non-2xx response we don't translate."""

    def __init__(self, status_code: int, body: str) -> None:
        super().__init__(f"Runner returned HTTP {status_code}: {body[:200]}")
        self.status_code = status_code
        self.body = body


def _runner_base_url() -> str | None:
    """Resolve the runner URL from settings, or ``None`` if disabled.

    Empty string is the explicit "disabled" sentinel — that's how operators
    opt out of the runner path on stacks where it isn't deployed.
    """
    raw = (get_settings().update_runner_url or "").strip()
    return raw.rstrip("/") or None


def _runner_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    token = (get_settings().update_runner_token or "").strip()
    if token:
        headers["X-Update-Token"] = token
    return headers


def _runner_auth_header() -> dict[str, str]:
    """Just the auth header, without Content-Type — for streaming bodies."""
    token = (get_settings().update_runner_token or "").strip()
    return {"X-Update-Token": token} if token else {}


def _runner_timeout() -> float:
    return float(get_settings().update_runner_timeout_seconds or 5.0)


def _runner_stream_timeout() -> httpx.Timeout:
    """Timeout profile for endpoints that move large payloads.

    Connect/write timeouts stay tight (we want to fail fast if the runner is
    unreachable), but the read timeout is unbounded because a multi-GB stream
    can legitimately take a while. Setting ``read=None`` instead of a large
    finite value avoids spurious timeouts on slow disks during pg_dump.
    """
    return httpx.Timeout(
        connect=_runner_timeout(),
        write=_runner_timeout(),
        read=None,
        pool=_runner_timeout(),
    )


def is_runner_reachable() -> bool:
    """Quick health probe used to decide whether to delegate or fall back.

    Returns False on any error (network, timeout, HTTP 4xx/5xx). Designed to
    be cheap and side-effect-free — does not raise.
    """
    base_url = _runner_base_url()
    if base_url is None:
        return False
    try:
        with httpx.Client(timeout=_runner_timeout()) as client:
            response = client.get(f"{base_url}/health", headers=_runner_headers())
            response.raise_for_status()
            payload = response.json()
            return bool(payload.get("ok"))
    except (httpx.HTTPError, ValueError):
        return False


def queue_update_job(*, branch: str = "main", pull: bool = True) -> dict[str, Any]:
    """Ask the runner to start a safe_update.sh run. Returns the job dict.

    Raises:
        UpdateRunnerUnreachable: runner not configured or network failure.
        UpdateRunnerJobConflict: runner already has an active job.
        UpdateRunnerRemoteError: runner returned an unexpected non-2xx.
    """
    base_url = _runner_base_url()
    if base_url is None:
        raise UpdateRunnerUnreachable("update_runner_url is empty (runner disabled)")

    body = {"branch": branch, "pull": pull}
    try:
        with httpx.Client(timeout=_runner_timeout()) as client:
            response = client.post(
                f"{base_url}/jobs/update",
                headers=_runner_headers(),
                json=body,
            )
    except httpx.HTTPError as exc:
        raise UpdateRunnerUnreachable(f"Could not reach update runner: {exc}") from exc

    if response.status_code == 409:
        try:
            detail = response.json().get("detail") or {}
            active_id = detail.get("active_job_id") if isinstance(detail, dict) else None
            message = detail.get("message") if isinstance(detail, dict) else "Job conflict"
        except ValueError:
            active_id = None
            message = "An update job is already running."
        raise UpdateRunnerJobConflict(active_id, message)

    if response.status_code >= 400:
        raise UpdateRunnerRemoteError(response.status_code, response.text)

    try:
        return response.json()
    except ValueError as exc:
        raise UpdateRunnerRemoteError(response.status_code, response.text) from exc


def get_job_status(job_id: str) -> dict[str, Any]:
    """Fetch status + log tail for a runner job.

    Raises:
        UpdateRunnerUnreachable: runner unreachable or disabled.
        UpdateRunnerRemoteError: HTTP error other than 404.
        KeyError: job_id is unknown to the runner (HTTP 404).
    """
    base_url = _runner_base_url()
    if base_url is None:
        raise UpdateRunnerUnreachable("update_runner_url is empty (runner disabled)")

    try:
        with httpx.Client(timeout=_runner_timeout()) as client:
            response = client.get(
                f"{base_url}/jobs/{job_id}",
                headers=_runner_headers(),
            )
    except httpx.HTTPError as exc:
        raise UpdateRunnerUnreachable(f"Could not reach update runner: {exc}") from exc

    if response.status_code == 404:
        raise KeyError(job_id)

    if response.status_code >= 400:
        raise UpdateRunnerRemoteError(response.status_code, response.text)

    try:
        return response.json()
    except ValueError as exc:
        raise UpdateRunnerRemoteError(response.status_code, response.text) from exc


# ── Backup-management helpers ─────────────────────────────────────────────────


def _require_base_url() -> str:
    """Resolve the runner URL or raise ``UpdateRunnerUnreachable``."""
    base_url = _runner_base_url()
    if base_url is None:
        raise UpdateRunnerUnreachable("update_runner_url is empty (runner disabled)")
    return base_url


def _raise_for_status_or_decode(response: httpx.Response) -> dict[str, Any]:
    """Translate a non-streaming runner response to (json | exception)."""
    if response.status_code == 404:
        raise KeyError(response.url.path)
    if response.status_code == 409:
        try:
            detail = response.json().get("detail") or {}
            active_id = detail.get("active_job_id") if isinstance(detail, dict) else None
            message = detail.get("message") if isinstance(detail, dict) else "Job conflict"
        except ValueError:
            active_id = None
            message = "A runner job is already running."
        raise UpdateRunnerJobConflict(active_id, message)
    if response.status_code >= 400:
        raise UpdateRunnerRemoteError(response.status_code, response.text)
    try:
        return response.json()
    except ValueError as exc:
        raise UpdateRunnerRemoteError(response.status_code, response.text) from exc


def list_backups() -> dict[str, Any]:
    """Return the runner's backup-listing payload (files + disk usage)."""
    base_url = _require_base_url()
    try:
        with httpx.Client(timeout=_runner_timeout()) as client:
            response = client.get(f"{base_url}/backups", headers=_runner_headers())
    except httpx.HTTPError as exc:
        raise UpdateRunnerUnreachable(f"Could not reach update runner: {exc}") from exc
    return _raise_for_status_or_decode(response)


def queue_backup_job() -> dict[str, Any]:
    """Ask the runner to start a backup.sh run. Returns the job dict."""
    base_url = _require_base_url()
    try:
        with httpx.Client(timeout=_runner_timeout()) as client:
            response = client.post(
                f"{base_url}/jobs/backup",
                headers=_runner_headers(),
                json={},
            )
    except httpx.HTTPError as exc:
        raise UpdateRunnerUnreachable(f"Could not reach update runner: {exc}") from exc
    return _raise_for_status_or_decode(response)


def queue_restore_job(*, filename: str) -> dict[str, Any]:
    """Ask the runner to start a restore.sh run for the given filename."""
    base_url = _require_base_url()
    try:
        with httpx.Client(timeout=_runner_timeout()) as client:
            response = client.post(
                f"{base_url}/jobs/restore",
                headers=_runner_headers(),
                json={"filename": filename},
            )
    except httpx.HTTPError as exc:
        raise UpdateRunnerUnreachable(f"Could not reach update runner: {exc}") from exc
    return _raise_for_status_or_decode(response)


def delete_backup(filename: str) -> dict[str, Any]:
    """Remove a backup file from the runner's backups directory."""
    base_url = _require_base_url()
    try:
        with httpx.Client(timeout=_runner_timeout()) as client:
            response = client.delete(
                f"{base_url}/backups/{filename}",
                headers=_runner_headers(),
            )
    except httpx.HTTPError as exc:
        raise UpdateRunnerUnreachable(f"Could not reach update runner: {exc}") from exc
    return _raise_for_status_or_decode(response)


def stream_backup_download(filename: str) -> tuple[Iterator[bytes], dict[str, str]]:
    """Open a streaming download for a backup file.

    Returns ``(iterator, headers)``. The caller is responsible for forwarding
    Content-Length / Content-Disposition to its own client. Iterating the
    returned generator drives the underlying stream; once exhausted, the
    httpx connection is released.
    """
    base_url = _require_base_url()
    try:
        client = httpx.Client(timeout=_runner_stream_timeout())
        request = client.build_request(
            "GET",
            f"{base_url}/backups/{filename}",
            headers=_runner_headers(),
        )
        response = client.send(request, stream=True)
    except httpx.HTTPError as exc:
        raise UpdateRunnerUnreachable(f"Could not reach update runner: {exc}") from exc

    if response.status_code == 404:
        response.close()
        client.close()
        raise KeyError(filename)
    if response.status_code >= 400:
        body = response.read().decode("utf-8", errors="replace")
        response.close()
        client.close()
        raise UpdateRunnerRemoteError(response.status_code, body)

    forward_headers: dict[str, str] = {}
    for header_name in ("content-length", "content-disposition", "content-type"):
        value = response.headers.get(header_name)
        if value:
            forward_headers[header_name] = value

    def _iter() -> Iterator[bytes]:
        try:
            for chunk in response.iter_bytes(chunk_size=1024 * 256):
                if chunk:
                    yield chunk
        finally:
            response.close()
            client.close()

    return _iter(), forward_headers


def upload_backup(
    *,
    filename: str,
    fileobj: BinaryIO,
    content_type: str = "application/octet-stream",
) -> dict[str, Any]:
    """Forward a file-like to the runner's multipart upload endpoint.

    ``fileobj`` may be any read-able stream (eg. the ``UploadFile.file``
    attribute on a FastAPI ``UploadFile``). httpx handles streaming the body
    so the api process never holds the full payload in memory.
    """
    base_url = _require_base_url()
    files = {"file": (filename, fileobj, content_type)}
    try:
        with httpx.Client(timeout=_runner_stream_timeout()) as client:
            response = client.post(
                f"{base_url}/backups/upload",
                headers=_runner_auth_header(),
                files=files,
            )
    except httpx.HTTPError as exc:
        raise UpdateRunnerUnreachable(f"Could not reach update runner: {exc}") from exc
    return _raise_for_status_or_decode(response)


__all__ = [
    "UpdateRunnerError",
    "UpdateRunnerUnreachable",
    "UpdateRunnerJobConflict",
    "UpdateRunnerRemoteError",
    "is_runner_reachable",
    "queue_update_job",
    "get_job_status",
    "list_backups",
    "queue_backup_job",
    "queue_restore_job",
    "delete_backup",
    "stream_backup_download",
    "upload_backup",
]


# Silence "imported but unused" — these imports document the public types
# referenced in helper signatures via type hints / docstrings.
_ = (AsyncIterator,)
