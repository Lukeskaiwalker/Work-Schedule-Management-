"""Scan-station authentication, heartbeat and the admin list.

What a *paired* station does. The office scan station is a Raspberry Pi
running ``tools/label_agent``; it holds a long-lived station token that it
obtained through the device authorization grant in
``workflow_station_pairing.py`` (the RFC 8628 story, the ``/pair/*`` routes
and their flood control live there). This module is everything after that:

* ``get_current_station`` — the dependency that turns
  ``Authorization: Bearer smpl_station_…`` into an active station row, used
  here and by ``workflow_station_werkstatt.py``;
* ``/heartbeat`` and ``/me`` — the station reporting in;
* ``/stations`` — the admin list, hiding retired rows unless asked, and the
  soft revoke that locks a device out on its very next request.

The three token primitives both halves need — the bearer prefix, the entropy
and ``hash_token`` — are defined here and imported by the pairing module, so
the dependency runs in one direction only. A token is only ever persisted as
its sha256; the raw value exists in the single poll response that delivers
it and nowhere else.
"""

from __future__ import annotations

import hashlib

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status as http_status
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.core.time import utcnow
from app.models.entities import Station, User
from app.schemas.station import StationHeartbeatOut, StationHeartbeatRequest, StationOut
from app.services.audit import log_admin_action
from app.services.station_heartbeat import apply_heartbeat
from app.services.station_view import (
    is_station_claimed,
    is_station_retired,
    station_out,
    stations_out,
)

router = APIRouter(prefix="/station", tags=["station"])

# ---------------------------------------------------------------------------
# Token primitives — shared with the pairing router
# ---------------------------------------------------------------------------

# Bearer prefix for a station credential. Distinct from ``smpl_pat_`` so the
# user-auth dependency in core/deps.py never mistakes one for the other: a
# station token presented to a normal user endpoint fails JWT decoding and is
# rejected, which is the correct outcome — a station is not a user.
STATION_TOKEN_PREFIX = "smpl_station_"

# 32 random bytes → 43 url-safe chars → 256 bits, matching the PAT format.
TOKEN_RANDOM_BYTES = 32


def hash_token(raw: str) -> str:
    """sha256 hex of a raw credential. The only form we ever persist."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Station authentication
# ---------------------------------------------------------------------------


def get_current_station(
    request: Request,
    db: Session = Depends(get_db),
    authorization: str | None = Header(default=None),
) -> Station:
    """Resolve ``Authorization: Bearer smpl_station_…`` to an active station.

    Every failure that a prober could learn from returns the same opaque
    message: an unknown hash, a revoked station and an unclaimed one are
    indistinguishable from outside. Expiry is the one exception — the
    legitimate device needs to know it must be re-paired rather than that it
    has been thrown out.
    """
    raw = (authorization or "").strip()
    if not raw.lower().startswith("bearer "):
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )
    token = raw.split(" ", 1)[1].strip()
    if not token.startswith(STATION_TOKEN_PREFIX):
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Not authenticated"
        )

    station = db.scalars(
        select(Station).where(Station.token_hash == hash_token(token))
    ).first()
    if station is None or station.revoked_at is not None or not is_station_claimed(station):
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Invalid station token"
        )

    now = utcnow()
    if station.expires_at is not None and station.expires_at <= now:
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Station token expired"
        )

    # Best-effort liveness stamp, throttled to once a minute — the station
    # polls and prints far more often than that, and a write per request would
    # be pure contention. Never allowed to break a legitimate request.
    try:
        if station.last_seen_at is None or (now - station.last_seen_at).total_seconds() >= 60:
            db.execute(
                update(Station).where(Station.id == station.id).values(last_seen_at=now)
            )
            db.commit()
    except Exception:  # pragma: no cover — diagnostic only, never block auth
        db.rollback()

    request.state.auth_type = "station"
    return station


# ---------------------------------------------------------------------------
# 5. Station-authenticated endpoints
# ---------------------------------------------------------------------------


# The fold itself — hardware blob, size cap, address validation — lives in
# ``services/station_heartbeat.py`` because the admin router's synchronous
# "Hardware prüfen" reshapes the agent's /health into the same request and
# must populate the row identically.


@router.post("/heartbeat", response_model=StationHeartbeatOut)
def station_heartbeat(
    payload: StationHeartbeatRequest,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
):
    """Liveness plus self-reported hardware state and address.

    The station calls this on a timer, so it doubles as the "is the Pi alive?"
    signal in the admin list. ``last_seen_at`` is written unconditionally here
    (unlike the throttled stamp in the auth dependency) because that is the
    entire purpose of the call.
    """
    now = utcnow()
    apply_heartbeat(station, payload, now)
    db.add(station)
    db.commit()
    db.refresh(station)
    return StationHeartbeatOut(station=station_out(db, station, now=now), server_time=now)


@router.get("/me", response_model=StationOut)
def station_me(
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
):
    """Who am I? Lets the agent confirm its token still works and show the
    admin-chosen name on its own screen."""
    return station_out(db, station)


# ---------------------------------------------------------------------------
# 6. Administrator manages paired stations (system:manage)
# ---------------------------------------------------------------------------


@router.get("/stations", response_model=list[StationOut])
def list_stations(
    include_inactive: bool = False,
    _: User = Depends(require_permission("system:manage")),
    db: Session = Depends(get_db),
):
    """Paired stations, newest first.

    By default only the ones that can still authenticate or are waiting to
    collect their token: a revoked or expired Pi must vanish from the page's
    switcher, or it is auto-selected and every action on it answers 409.
    ``include_inactive=1`` brings the retired rows back, because "when did we
    retire that Pi?" is an audit question and the row is its answer.
    """
    now = utcnow()
    rows = list(db.scalars(select(Station).order_by(Station.created_at.desc())).all())
    if not include_inactive:
        rows = [row for row in rows if not is_station_retired(row, now)]
    return stations_out(db, rows, now=now)


def _revoke(db: Session, station_id: int, actor: User) -> Station:
    station = db.get(Station, station_id)
    if station is None:
        raise HTTPException(status_code=404, detail="Station not found")
    if station.revoked_at is None:
        station.revoked_at = utcnow()
        station.revoked_by = actor.id
        db.add(station)
        db.commit()
        db.refresh(station)
        log_admin_action(
            db,
            actor,
            "station.revoke",
            "station",
            str(station.id),
            details={"name": station.name, "prefix": station.prefix},
            category="system",
        )
    return station


@router.post("/stations/{station_id}/revoke", response_model=StationOut)
def revoke_station(
    station_id: int,
    current_user: User = Depends(require_permission("system:manage")),
    db: Session = Depends(get_db),
):
    """Kill a station's token.

    The row is kept (audit trail); ``revoked_at`` is what the auth dependency
    checks on every single request, so the device is locked out on its very
    next call with no cache to wait for. Idempotent.
    """
    return station_out(db, _revoke(db, station_id, current_user))


@router.delete("/stations/{station_id}", status_code=204)
def delete_station(
    station_id: int,
    current_user: User = Depends(require_permission("system:manage")),
    db: Session = Depends(get_db),
):
    """REST-shaped alias for revoke — same soft revocation, no hard delete,
    so a DELETE from the UI can never destroy the audit trail."""
    _revoke(db, station_id, current_user)
    return None
