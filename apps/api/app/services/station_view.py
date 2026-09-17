"""How a station row becomes what the Scan-Station page renders.

Everything on ``StationOut`` that is not a stored column is computed here, in
one place, so the pairing router, the heartbeat and the admin operations all
describe a station identically:

* ``status`` — freshness of the last heartbeat, judged against the server
  clock. The agent beats every 120 s, so "online" is three minutes (one missed
  beat is not an outage) and "stale" fifteen; beyond that the box is off;
* ``hardware`` — the agent's free-form blob normalised into the fixed shape
  the page renders, so the printer row can never say "nicht verbunden" while
  the heartbeat underneath says the printer is fine;
* ``paired_by_name`` and ``pending_count`` — one user lookup and one grouped
  count over imported inventory sessions, batched for the list.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import Station, User, WerkstattInventorySession
from app.schemas.station import StationHardwareOut, StationOut, StationStatus

# Heartbeat interval on the Pi is 120 s (tools/label_agent/station_heartbeat.py).
ONLINE_WITHIN_SECONDS = 3 * 60
STALE_WITHIN_SECONDS = 15 * 60

# A station row is created the moment an admin approves, so the approval is
# visible immediately — but its token does not exist yet. Until the device
# collects it, ``token_hash`` holds a value with this prefix, which no sha256
# digest can ever equal (a digest is 64 hex characters; this is not). That
# keeps the "never store a plaintext token" rule absolute without deferring
# the row.
UNCLAIMED_HASH_PREFIX = "unclaimed:"


def is_station_claimed(station: Station) -> bool:
    return not station.token_hash.startswith(UNCLAIMED_HASH_PREFIX)


def is_station_active(station: Station, now: datetime | None = None) -> bool:
    """True when the token would authenticate right now."""
    now = now or utcnow()
    if station.revoked_at is not None:
        return False
    if station.expires_at is not None and station.expires_at <= now:
        return False
    return is_station_claimed(station)


def is_station_retired(station: Station, now: datetime | None = None) -> bool:
    """Revoked or expired — the rows the default list hides.

    Distinct from ``not is_station_active``: an approved station whose device
    has not collected its token yet is neither, and the admin who just
    approved it must still see it.
    """
    now = now or utcnow()
    if station.revoked_at is not None:
        return True
    return station.expires_at is not None and station.expires_at <= now


def station_status(last_seen_at: datetime | None, now: datetime | None = None) -> StationStatus:
    if last_seen_at is None:
        return "unknown"
    age = ((now or utcnow()) - last_seen_at).total_seconds()
    if age <= ONLINE_WITHIN_SECONDS:
        return "online"
    if age <= STALE_WITHIN_SECONDS:
        return "stale"
    return "offline"


def _text(value: Any) -> str | None:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    return None


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def normalise_hardware(blob: dict[str, Any] | None) -> StationHardwareOut:
    """The agent's blob → the fixed shape.

    New agents send a ``hardware`` sub-dict; older ones only the top-level
    ``printer_connected``/``media_width_mm``/``error`` plus whatever their
    ``status`` extras were spread into the blob (``simulated`` among them).
    Both are read, sub-dict first, so an upgrade on either side never blanks
    a row that was populated before.
    """
    blob = blob if isinstance(blob, dict) else {}
    hw = blob.get("hardware") if isinstance(blob.get("hardware"), dict) else {}
    scanner = blob.get("scanner") if isinstance(blob.get("scanner"), dict) else {}
    scanner_present = (
        bool(hw["scanner_present"]) if "scanner_present" in hw else bool(scanner.get("active"))
    )
    return StationHardwareOut(
        printer_connected=bool(blob.get("printer_connected")),
        printer_model=_text(hw.get("printer_model")) or _text(blob.get("printer_model")),
        media_width_mm=_number(blob.get("media_width_mm")),
        printer_error=_text(blob.get("error")) or _text(hw.get("printer_error")),
        scanner_present=scanner_present,
        scanner_name=_text(hw.get("scanner_name")) or _text(scanner.get("device")),
        simulated=bool(hw.get("simulated", blob.get("simulated", False))),
    )


def imported_session_names(db: Session, station_ids: Iterable[int]) -> dict[int, int]:
    """How many distinct Pi sessions each station has ever had imported."""
    ids = [int(i) for i in station_ids]
    if not ids:
        return {}
    rows = db.execute(
        select(
            WerkstattInventorySession.source_station_id,
            func.count(func.distinct(WerkstattInventorySession.source_session_name)),
        )
        .where(
            WerkstattInventorySession.source_station_id.in_(ids),
            WerkstattInventorySession.source_session_name.is_not(None),
        )
        .group_by(WerkstattInventorySession.source_station_id)
    ).all()
    return {int(station_id): int(count) for station_id, count in rows}


def _user_names(db: Session, user_ids: Iterable[int | None]) -> dict[int, str]:
    ids = sorted({int(i) for i in user_ids if i is not None})
    if not ids:
        return {}
    rows = db.execute(select(User.id, User.full_name).where(User.id.in_(ids))).all()
    return {int(user_id): name for user_id, name in rows}


def _build(
    station: Station,
    *,
    now: datetime,
    paired_by_name: str | None,
    imported_count: int,
) -> StationOut:
    blob = station.hardware_status or {}
    session_count = int(station.session_count or 0)
    return StationOut(
        id=station.id,
        name=station.name,
        prefix=station.prefix,
        created_at=station.created_at,
        created_by=station.created_by,
        paired_from_ip=station.paired_from_ip,
        agent_version=station.agent_version,
        last_seen_at=station.last_seen_at,
        hardware_status=blob,
        expires_at=station.expires_at,
        revoked_at=station.revoked_at,
        revoked_by=station.revoked_by,
        active=is_station_active(station, now),
        status=station_status(station.last_seen_at, now),
        location=station.location,
        host=station.agent_host,
        port=station.agent_port,
        agent_url_override=station.agent_url_override,
        uptime_seconds=station.uptime_seconds,
        paired_at=station.created_at,
        paired_by_name=paired_by_name,
        session_count=session_count,
        pending_count=max(0, session_count - imported_count),
        agent_error=_text(blob.get("agent_error")),
        hardware=normalise_hardware(blob),
    )


def station_out(db: Session, station: Station, *, now: datetime | None = None) -> StationOut:
    """One station, fully described. Two small queries."""
    now = now or utcnow()
    names = _user_names(db, [station.created_by])
    imported = imported_session_names(db, [station.id])
    return _build(
        station,
        now=now,
        paired_by_name=names.get(station.created_by) if station.created_by else None,
        imported_count=imported.get(station.id, 0),
    )


def stations_out(
    db: Session, stations: list[Station], *, now: datetime | None = None
) -> list[StationOut]:
    """The list, with the lookups batched: two queries however many rows."""
    now = now or utcnow()
    names = _user_names(db, [s.created_by for s in stations])
    imported = imported_session_names(db, [s.id for s in stations])
    return [
        _build(
            station,
            now=now,
            paired_by_name=names.get(station.created_by) if station.created_by else None,
            imported_count=imported.get(station.id, 0),
        )
        for station in stations
    ]
