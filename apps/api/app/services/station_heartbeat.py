"""Folding a heartbeat into a station row.

Two callers, one code path: the Pi's own ``POST /api/station/heartbeat`` every
two minutes, and the Scan-Station page's *Hardware prüfen*, which asks the
agent's ``/health`` synchronously and reshapes the answer into the same
request model. Keeping the fold in one place is what guarantees a check and a
heartbeat can never populate the row differently — the hardware rows on the
page read the same keys either way.
"""

from __future__ import annotations

import json
from datetime import datetime

from fastapi import HTTPException

from app.models.entities import Station
from app.schemas.station import StationHeartbeatRequest
from app.services.station_agent_client import is_private_host

# Cap on the free-form hardware blob a device may store, serialized. Stops an
# agent (or something wearing its token) turning the stations table into a
# data dump.
MAX_HARDWARE_STATUS_BYTES = 4096


def assemble_hardware_status(payload: StationHeartbeatRequest) -> dict:
    """Merge the named health fields with the agent's free-form extras.

    The named keys win over anything of the same name in ``status``, and the
    whole thing is size-capped — a device may describe itself, not use the
    stations table as storage.
    """
    blob: dict = dict(payload.status or {})
    if payload.printer_connected is not None:
        blob["printer_connected"] = payload.printer_connected
    if payload.media_width_mm is not None:
        blob["media_width_mm"] = payload.media_width_mm
    if payload.error is not None:
        blob["error"] = payload.error
    if payload.hardware is not None:
        # The normalised sub-dict (printer model, scanner, simulated) — kept
        # under its own key so it can never be shadowed by a same-named extra.
        blob["hardware"] = dict(payload.hardware)

    serialized = json.dumps(blob, default=str)
    if len(serialized.encode("utf-8")) > MAX_HARDWARE_STATUS_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Hardware status must serialise to at most {MAX_HARDWARE_STATUS_BYTES} bytes",
        )
    return blob


def _apply_reported_address(station: Station, payload: StationHeartbeatRequest) -> None:
    """Store the agent's own LAN address — or drop it, never a public one.

    ``model_fields_set`` rather than ``is None``: an older agent that sends no
    ``host`` key leaves a previously stored address alone, while a newer one
    that reports something unusable clears it, so a stale address can never
    outlive the Pi that moved. The private-address check is the boundary: a
    station token must never be able to point the api at a public host.
    """
    if "host" not in payload.model_fields_set:
        return
    host = (payload.host or "").strip()
    if host and payload.port and is_private_host(host):
        station.agent_host = host[:64]
        station.agent_port = int(payload.port)
    else:
        station.agent_host = None
        station.agent_port = None


def apply_heartbeat(station: Station, payload: StationHeartbeatRequest, now: datetime) -> None:
    """Fold one heartbeat into the row. The caller commits."""
    station.last_seen_at = now
    if payload.agent_version is not None:
        station.agent_version = payload.agent_version.strip()[:64] or None
    if payload.uptime_seconds is not None:
        station.uptime_seconds = int(payload.uptime_seconds)
    if payload.session_count is not None:
        station.session_count = int(payload.session_count)
    _apply_reported_address(station, payload)
    station.hardware_status = assemble_hardware_status(payload)
