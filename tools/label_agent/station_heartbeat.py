"""Tell SMPL the station is alive, and what its hardware is doing.

SMPL's station admin page shows ``last_seen_at`` and a hardware status for
every paired station. Nothing fills those in by itself: a station that never
reports is indistinguishable, on that page, from a station somebody unplugged
in March. So this posts a small heartbeat on a slow timer.

It is a *report*, never a dependency. The station does not need SMPL's
permission to keep working, and every failure mode here is silent by design:

* no pairing token yet          -> nothing is sent, and nothing is retried
* SMPL has no heartbeat route   -> the loop stops permanently after one 404
* the token was revoked         -> /health says so; the loop keeps trying
                                   slowly, because a re-pair should recover
                                   without a restart
* the network is down           -> next tick, no backoff drama

Deliberately slow. A Pi on a small office line has better things to do with
its uplink, and "seen within the last two minutes" answers the only question
the admin page is really asking.
"""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

__all__ = ["Heartbeat", "HEARTBEAT_PATHS"]

HEARTBEAT_PATHS = (
    "/api/station/heartbeat",
    "/api/station/ping",
)

INTERVAL_S = 120.0
REJECTED_INTERVAL_S = 600.0
REQUEST_TIMEOUT_S = 10.0
MAX_RESPONSE_BYTES = 64 * 1024


class Heartbeat:
    """One background thread posting a status summary to SMPL."""

    def __init__(self, base_url: str, *, token_provider: Callable[[], str],
                 agent_version: str = "", status_provider: Optional[Callable[[], Dict]] = None,
                 on_auth: Optional[Callable[[int], None]] = None,
                 user_agent: str = "smpl-label-agent") -> None:
        self.base_url = (base_url or "").rstrip("/")
        self._token_provider = token_provider
        self._status_provider = status_provider
        self._on_auth = on_auth
        self.agent_version = agent_version
        self.user_agent = user_agent
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._path = ""
        self._supported: Optional[bool] = None
        self._last_ok = ""
        self._last_error = ""

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def start(self) -> None:
        if not self.configured:
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="station-heartbeat", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        # A first beat shortly after boot, so a station that was just plugged
        # in shows up on the admin page while somebody is still standing next
        # to it - not two minutes later when they have walked away.
        if self._stop.wait(5.0):
            return
        while not self._stop.is_set():
            interval = INTERVAL_S
            try:
                interval = self.beat()
            except Exception as exc:  # noqa: BLE001 - a reporter must never crash the station
                with self._lock:
                    self._last_error = "%s: %s" % (type(exc).__name__, exc)
            if self._supported is False:
                return  # this SMPL has no heartbeat; stop asking forever
            self._stop.wait(interval)

    def beat(self) -> float:
        """Send one heartbeat. Returns how long to wait before the next."""
        token = self._token_provider() if self._token_provider else ""
        if not token:
            # Not paired. There is nothing to authenticate with and nothing
            # for SMPL to attach the report to.
            return INTERVAL_S

        payload = self._payload()
        for path in ([self._path] if self._path else list(HEARTBEAT_PATHS)):
            status, detail = self._post(path, payload, token)
            if status == 0:
                with self._lock:
                    self._last_error = detail
                return INTERVAL_S
            if status in (404, 405, 501):
                continue
            self._path = path
            if 200 <= status < 300:
                self._supported = True
                with self._lock:
                    self._last_ok = detail[:200]
                    self._last_error = ""
                if self._on_auth:
                    self._on_auth(status)
                return INTERVAL_S
            if status in (401, 403):
                if self._on_auth:
                    self._on_auth(status)
                with self._lock:
                    self._last_error = "SMPL rejected the station token (HTTP %d)" % status
                return REJECTED_INTERVAL_S
            with self._lock:
                self._last_error = "HTTP %d" % status
            return INTERVAL_S

        self._supported = False
        with self._lock:
            self._last_error = "this SMPL server has no station heartbeat endpoint"
        return INTERVAL_S

    def _payload(self) -> Dict[str, Any]:
        status: Dict[str, Any] = {}
        if self._status_provider is not None:
            try:
                status = self._status_provider() or {}
            except Exception:  # noqa: BLE001
                status = {}
        body: Dict[str, Any] = {"agent_version": self.agent_version}
        if "printer_connected" in status:
            body["printer_connected"] = bool(status["printer_connected"])
        width = status.get("media_width_mm")
        if isinstance(width, (int, float)):
            body["media_width_mm"] = float(width)
        error = status.get("error")
        if isinstance(error, str) and error:
            body["error"] = error[:500]
        extra = status.get("status")
        if isinstance(extra, dict):
            body["status"] = extra
        return body

    def _post(self, path: str, payload: Dict[str, Any], token: str):
        request = urllib.request.Request(
            self.base_url + path, data=json.dumps(payload).encode("utf-8"), method="POST"
        )
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", self.user_agent)
        request.add_header("Authorization", "Bearer %s" % token)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as handle:  # noqa: S310
                return handle.status, handle.read(MAX_RESPONSE_BYTES).decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, exc.read(MAX_RESPONSE_BYTES).decode("utf-8", "replace")
            except Exception:  # noqa: BLE001
                return exc.code, ""
        except Exception as exc:  # noqa: BLE001
            return 0, "%s: %s" % (type(exc).__name__, exc)

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "configured": self.configured,
                "running": self._thread is not None and self._thread.is_alive(),
                "supported": self._supported,
                "endpoint": self._path or None,
                "last_error": self._last_error or None,
            }
