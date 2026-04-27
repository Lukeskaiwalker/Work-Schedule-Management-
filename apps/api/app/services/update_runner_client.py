"""HTTP client for talking to the ``update_runner`` sidecar.

The runner owns docker-socket access and orchestrates ``safe_update.sh`` runs.
The api never touches docker directly — every privileged action is mediated
through this client. Keeping the client small and well-typed makes the trust
boundary easy to audit: anything that hits the runner goes through one of
these functions.
"""
from __future__ import annotations

from typing import Any

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


def _runner_timeout() -> float:
    return float(get_settings().update_runner_timeout_seconds or 5.0)


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
