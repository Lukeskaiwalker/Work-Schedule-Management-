"""The three things a Pi station does beyond scanning and printing.

``server.py`` owns the five-second scan path and should stay owning only that.
The Pi adds a SMPL identity, an SD-card importer and an uploader, all three of
which are optional, all three of which can fail permanently without the
station stopping being useful. Assembling them here keeps that separation
honest: if this whole module fails to import, the agent still boots, still
scans, still counts, still prints.

That is not a hypothetical. On a fresh Pi, before anyone has paired anything,
every one of these is inert - and the station is still the thing the owner
wanted on the bench.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Dict, Optional

import agent_paths
import pairing
import sd_import
import sd_upload
import station_heartbeat

__all__ = ["Station"]

DEFAULT_DEVICE_NAME = "SMPL Werkstatt-Station"


class Station:
    """Pairing, SD import and upload, assembled and reportable."""

    def __init__(self, db_path: Path, *, base_url: str = "", env_token: str = "",
                 device_name: str = "", agent_version: str = "",
                 sd_enabled: bool = True, sd_simulate: Optional[str] = None,
                 sd_poll_s: float = sd_import.DEFAULT_POLL_S,
                 status_provider=None) -> None:
        self.agent_version = agent_version
        self.base_url = (base_url or "").rstrip("/")
        self._env_token = env_token or ""
        self.device_id = agent_paths.device_id()
        self.device_name = device_name or os.environ.get("STATION_NAME") or DEFAULT_DEVICE_NAME

        self.tokens = pairing.TokenStore()
        self.pairing = pairing.PairingSession(
            pairing.PairingClient(self.base_url), self.tokens,
            device_id=self.device_id, device_name=self.device_name,
            agent_version=agent_version,
        )

        self._rejected = False  # SMPL answered 401/403 with the token we hold
        self._lock = threading.Lock()

        # Without this, SMPL's station admin page cannot tell a station that
        # is working from one that was unplugged months ago - every row would
        # read "never seen".
        self.heartbeat = station_heartbeat.Heartbeat(
            self.base_url,
            token_provider=self.token,
            agent_version=agent_version,
            status_provider=status_provider,
            on_auth=self._note_status,
            user_agent="smpl-label-agent/%s" % (agent_version or "dev"),
        )

        self.importer: Optional[sd_import.SdImporter] = None
        self.uploader: Optional[sd_upload.ImportUploader] = None
        if sd_enabled:
            store = sd_import.ImportStore(Path(db_path))
            self.uploader = sd_upload.ImportUploader(
                store, base_url=self.base_url, token_provider=self.token,
                user_agent="smpl-label-agent/%s" % (agent_version or "dev"),
            )
            self.importer = sd_import.SdImporter(
                store, simulate_root=sd_simulate, poll_s=sd_poll_s,
                agent_version=agent_version, uploader=self.uploader,
            )

    # -- identity ---------------------------------------------------------

    def token(self) -> str:
        """The token to talk to SMPL with: the paired one, else the env one.

        The paired token wins because it is the one an admin can revoke from
        SMPL without touching the hardware. ``SMPL_API_TOKEN`` remains as the
        escape hatch for a station that was set up before pairing existed, or
        for a SMPL that never grows the endpoint.
        """
        stored = self.tokens.load()
        if stored is not None and not stored.expired:
            return stored.token
        return self._env_token

    def note_rejection(self, status: int) -> None:
        """Called when SMPL answers 401/403, so /health can say 'go re-pair'."""
        with self._lock:
            self._rejected = status in (401, 403)

    def note_success(self) -> None:
        with self._lock:
            self._rejected = False

    def _note_status(self, status: int) -> None:
        if status in (401, 403):
            self.note_rejection(status)
        elif 200 <= status < 400:
            self.note_success()

    # -- lifecycle --------------------------------------------------------

    def start(self) -> None:
        if self.importer is not None:
            self.importer.start()
        self.heartbeat.start()
        if self.uploader is not None and self.uploader.configured:
            # Anything that was staged while SMPL was down goes out now.
            threading.Thread(target=self._resume_uploads, daemon=True).start()

    def _resume_uploads(self) -> None:
        try:
            self.uploader.submit_pending()
        except Exception:  # noqa: BLE001 - a failed resume is not a failed boot
            pass

    def shutdown(self) -> None:
        self.heartbeat.stop()
        if self.importer is not None:
            self.importer.stop()
        if self.uploader is not None:
            self.uploader.stop()

    # -- reporting --------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        stored = self.tokens.load()
        with self._lock:
            rejected = self._rejected
        identity: Dict[str, Any] = {
            "device_id": self.device_id,
            "device_name": self.device_name,
            "paired": stored is not None and not stored.expired,
            "token_source": self._token_source(stored),
            "token_file": str(self.tokens.path),
            "token_file_secure": self.tokens.secure(),
            "token_rejected": rejected,
        }
        if stored is not None:
            identity["token"] = stored.public()
        payload: Dict[str, Any] = {"identity": identity}
        if self.importer is not None:
            payload["sd_import"] = self.importer.status()
        else:
            payload["sd_import"] = {"running": False, "disabled": True}
        if self.uploader is not None:
            payload["upload"] = self.uploader.status()
        payload["heartbeat"] = self.heartbeat.status()
        return payload

    def _token_source(self, stored) -> str:
        if stored is not None and not stored.expired:
            return "paired"
        if stored is not None:
            return "paired-expired"
        if self._env_token:
            return "environment"
        return "none"

    # -- endpoints --------------------------------------------------------

    def pair_start(self, device_name: str = "") -> Dict[str, Any]:
        return self.pairing.begin(device_name)

    def pair_status(self) -> Dict[str, Any]:
        return self.pairing.snapshot()

    def pair_cancel(self) -> Dict[str, Any]:
        return self.pairing.cancel()

    def unpair(self) -> Dict[str, Any]:
        """Forget the token. Revoking it in SMPL is a separate, server-side act."""
        self.tokens.clear()
        self.note_success()
        return {"ok": True, "paired": False,
                "note": "the local token is deleted; revoke it in SMPL as well "
                        "if the station is being decommissioned"}

    def imports(self, limit: int = 50) -> Dict[str, Any]:
        if self.importer is None:
            return {"imports": [], "disabled": True}
        return {"imports": self.importer.store.list(limit=limit)}

    def import_detail(self, import_id: str) -> Optional[Dict[str, Any]]:
        """Metadata only.

        The staged files themselves are deliberately not served over HTTP: on a
        Pi the agent binds the LAN so the station page can be opened from a
        phone, and test protocols are not something to hand to anything that
        can reach port 8765. The manifest names the directory; someone with an
        account on the Pi can copy from there.
        """
        if self.importer is None:
            return None
        row = self.importer.store.get(import_id)
        if row is None:
            return None
        manifest_path = self.importer.manifest_path(import_id)
        if manifest_path is not None:
            import json
            try:
                row["manifest"] = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                row["manifest"] = None
        return row

    def rescan(self) -> Dict[str, Any]:
        if self.importer is None:
            return {"ok": False, "error": "SD import is disabled"}
        return self.importer.rescan()

    def retry_uploads(self) -> Dict[str, Any]:
        if self.uploader is None or not self.uploader.configured:
            return {"ok": False, "error": "no SMPL server configured for uploads"}
        return {"ok": True, "requeued": self.uploader.submit_pending()}
