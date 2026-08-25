"""Scan-station pairing and station-authenticated endpoints.

The office scan station is a Raspberry Pi running ``tools/label_agent``: a
barcode scanner, a Brother label printer, and SD-card imports from the test
instruments. It has no comfortable keyboard, so the owner's requirement was
"log in with your SMPL account without looking up your password".

The answer is OAuth 2.0's device authorization grant (RFC 8628), which exists
for precisely this hardware:

    Pi                              Admin (SMPL web UI)
    │  POST /pair/start                     │
    │─────────────────────────────>         │
    │  { user_code: "WXYZ-4821",            │
    │    device_token: <256-bit secret> }   │
    │                                       │
    │  shows WXYZ-4821 on its screen ──────>│  GET  /pair/pending
    │                                       │  POST /pair/approve  ← the
    │  POST /pair/poll (every 5s)           │        authorising act
    │─────────────────────────────>         │
    │  { status: "approved", token: … }     │
    │  ← issued exactly once                │

Nothing on the Pi ever handles a user password, and nothing an unapproved
device sends grants it anything at all.

Security posture of the unauthenticated half (``/pair/start``, ``/pair/poll``):

* the device token is 256 bits from ``secrets.token_urlsafe`` and is stored
  only as a sha256 hash. Guessing it is the only way to steal a pairing, and
  it is not guessable;
* the short ``user_code`` is not a credential. Knowing one lets you do
  nothing — the token goes to whoever holds the *device token*, so an attacker
  who reads a code off a screen still cannot collect anything;
* codes live 10 minutes, are single-use, and the number that can be waiting at
  once is capped globally and per source IP, so the approval list cannot be
  flooded into uselessness;
* ``/pair/poll`` is throttled to one poll per 5 seconds per pairing while the
  answer is still "pending" (RFC 8628 ``slow_down``), on top of the per-IP
  ceiling ``app.main`` applies to both unauthenticated paths;
* the station token itself is minted at *claim* time, not at approval, so a
  raw credential never exists anywhere but in the single response that
  delivers it.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status as http_status
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.core.time import utcnow
from app.models.entities import (
    PAIRING_APPROVED,
    PAIRING_CLAIMED,
    PAIRING_DENIED,
    PAIRING_PENDING,
    Station,
    StationPairing,
    User,
)
from app.schemas.station import (
    StationHeartbeatOut,
    StationHeartbeatRequest,
    StationOut,
    StationPairApproveOut,
    StationPairApproveRequest,
    StationPairDenyOut,
    StationPairDenyRequest,
    StationPairPollOut,
    StationPairPollRequest,
    StationPairStartOut,
    StationPairStartRequest,
    StationPairingOut,
)
from app.services.audit import log_admin_action

router = APIRouter(prefix="/station", tags=["station"])

# ---------------------------------------------------------------------------
# Constants — every lifetime decision in one place, with its reasoning.
# ---------------------------------------------------------------------------

# Bearer prefix for a station credential. Distinct from ``smpl_pat_`` so the
# user-auth dependency in core/deps.py never mistakes one for the other: a
# station token presented to a normal user endpoint fails JWT decoding and is
# rejected, which is the correct outcome — a station is not a user.
STATION_TOKEN_PREFIX = "smpl_station_"
# Prefix for the throwaway handle the device polls with. Never authenticates
# anything; it only names an in-flight pairing attempt.
DEVICE_TOKEN_PREFIX = "smpl_pair_"

# 32 random bytes → 43 url-safe chars → 256 bits, matching the PAT format.
_TOKEN_RANDOM_BYTES = 32

# 10 minutes, the RFC 8628 convention. Long enough for somebody to walk to a
# desk and approve; short enough that a code left on a screen over lunch is
# already dead. It is also the window during which the pending list can be
# occupied, which is why it is short rather than generous.
PAIRING_TTL_SECONDS = 600
# A second 10-minute window opens at approval so the device — which polls
# every 5 seconds — always has ample time to collect, even if the admin
# approved in the last second of the original window.
PAIRING_CLAIM_TTL_SECONDS = 600
# Minimum seconds between two polls of the same pairing while it is still
# pending. The device is told this value at /pair/start.
POLL_MIN_INTERVAL_SECONDS = 5

# Default station-token lifetime. A year, not "never": the device is
# unattended, so short expiries would strand it, but an unbounded credential
# sitting on a Pi in an office with physical access is the worse failure. A
# year forces one deliberate re-pair (two clicks for an admin) and bounds the
# damage from a device that quietly left the building. An admin can pass
# ``expires_in_days: null`` to opt out.
DEFAULT_STATION_TOKEN_DAYS = 365

# Flood control for the unauthenticated /pair/start endpoint. The pending list
# is a human's attention surface; filling it with plausible-looking codes is a
# social-engineering primitive, not just noise.
#
# The per-source cap is a *rolling* window rather than a rejection: a device
# that reboots four times during installation starts four pairings, and
# refusing the fourth would brick the very setup this feature exists to make
# easy. So the oldest pending request from that source is dropped instead,
# which is what the operator means anyway — the code on the screen right now
# is the live one. The global cap does reject, because past it the list is no
# longer usable by the human it is for; it self-heals within
# PAIRING_TTL_SECONDS and an admin can deny codes outright.
MAX_PENDING_PAIRINGS = 10
MAX_PENDING_PAIRINGS_PER_IP = 5

# Cap on the free-form hardware blob a device may store, serialized. Stops an
# agent (or something wearing its token) turning the stations table into a
# data dump.
MAX_HARDWARE_STATUS_BYTES = 4096

# Unambiguous code alphabet: no 0/O, no 1/I/L, no U. 8 characters over 30
# symbols ≈ 39 bits — far more than needed, since the code is not the secret,
# but enough that two codes are never confusable when read aloud.
_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
_CODE_GROUP_LEN = 4
_CODE_GROUPS = 2


# ---------------------------------------------------------------------------
# Primitives
# ---------------------------------------------------------------------------


def _hash_token(raw: str) -> str:
    """sha256 hex of a raw credential. The only form we ever persist."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _mint_user_code() -> str:
    """``WXYZ-4821``-shaped code from a CSPRNG (``secrets``, never ``random``)."""
    groups = [
        "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_GROUP_LEN))
        for _ in range(_CODE_GROUPS)
    ]
    return "-".join(groups)


def _normalize_user_code(raw: str | None) -> str | None:
    """Accept what a human actually types: lowercase, spaces, missing dash."""
    if raw is None:
        return None
    cleaned = "".join(ch for ch in raw.strip().upper() if ch.isalnum())
    if not cleaned:
        return None
    if len(cleaned) == _CODE_GROUP_LEN * _CODE_GROUPS:
        return "-".join(
            cleaned[i : i + _CODE_GROUP_LEN]
            for i in range(0, len(cleaned), _CODE_GROUP_LEN)
        )
    return cleaned


def _client_ip(request: Request) -> str | None:
    """Best-effort source IP, mirroring the reverse-proxy handling in main.py.

    Advisory only — it is displayed to the approving admin and used for a
    soft per-source cap, never for authorisation, so a spoofed header buys
    nothing but a smaller flood allowance for the spoofer.
    """
    real_ip = (request.headers.get("x-real-ip") or "").strip()
    if real_ip:
        return real_ip[:64]
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",", 1)[0].strip()
        if first:
            return first[:64]
    return request.client.host[:64] if request.client else None


# A station row is created the moment an admin approves, so the approval is
# visible immediately — but its token does not exist yet. Until the device
# collects it, ``token_hash`` holds this sentinel, which no sha256 digest can
# ever equal (a digest is 64 hex characters; this is not). That keeps the
# "never store a plaintext token" rule absolute without deferring the row.
_UNCLAIMED_HASH_PREFIX = "unclaimed:"


def _unclaimed_hash() -> str:
    return f"{_UNCLAIMED_HASH_PREFIX}{secrets.token_hex(16)}"


def _is_claimed(station: Station) -> bool:
    return not station.token_hash.startswith(_UNCLAIMED_HASH_PREFIX)


def _is_active(station: Station, now: datetime | None = None) -> bool:
    now = now or utcnow()
    if station.revoked_at is not None:
        return False
    if station.expires_at is not None and station.expires_at <= now:
        return False
    return _is_claimed(station)


def _station_out(station: Station) -> StationOut:
    return StationOut(
        id=station.id,
        name=station.name,
        prefix=station.prefix,
        created_at=station.created_at,
        created_by=station.created_by,
        paired_from_ip=station.paired_from_ip,
        agent_version=station.agent_version,
        last_seen_at=station.last_seen_at,
        hardware_status=station.hardware_status or {},
        expires_at=station.expires_at,
        revoked_at=station.revoked_at,
        revoked_by=station.revoked_by,
        active=_is_active(station),
    )


def _pairing_out(pairing: StationPairing, now: datetime) -> StationPairingOut:
    return StationPairingOut(
        id=pairing.id,
        user_code=pairing.user_code,
        status=pairing.status,
        device_hint=pairing.device_hint,
        agent_version=pairing.agent_version,
        requested_ip=pairing.requested_ip,
        created_at=pairing.created_at,
        expires_at=pairing.expires_at,
        expires_in=max(0, int((pairing.expires_at - now).total_seconds())),
        poll_count=pairing.poll_count,
        last_polled_at=pairing.last_polled_at,
    )


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
        select(Station).where(Station.token_hash == _hash_token(token))
    ).first()
    if station is None or station.revoked_at is not None or not _is_claimed(station):
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
# 1. Device asks to be paired (unauthenticated)
# ---------------------------------------------------------------------------


def _prune_stale_pairings(db: Session, now: datetime) -> None:
    """Drop pending rows that expired more than a day ago.

    Approved, claimed and denied rows are kept — they are the audit trail for
    "who let this device in?". Only the never-answered ones are noise.
    """
    stale_before = now - timedelta(days=1)
    rows = db.scalars(
        select(StationPairing).where(
            StationPairing.status == PAIRING_PENDING,
            StationPairing.expires_at < stale_before,
        )
    ).all()
    for row in rows:
        db.delete(row)
    if rows:
        db.commit()


@router.post("/pair/start", response_model=StationPairStartOut, status_code=201)
def pair_start(
    payload: StationPairStartRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """Begin a pairing. Unauthenticated by necessity — the device has no
    credential yet; that is the entire point of the grant.

    What the caller gets is deliberately worthless on its own: a code to show
    a human, and a handle to poll with. Neither reads any data, and no station
    exists until an administrator says so.
    """
    now = utcnow()
    _prune_stale_pairings(db, now)

    ip = _client_ip(request)
    pending_filter = (
        StationPairing.status == PAIRING_PENDING,
        StationPairing.expires_at > now,
    )

    # Roll the per-source window forward: the newest request from a source is
    # the one the operator is looking at, so older ones from the same source
    # make way for it. A device polling an evicted pairing is told ``expired``,
    # so it starts over — which is the correct thing for it to do.
    if ip:
        from_ip = db.scalars(
            select(StationPairing)
            .where(*pending_filter, StationPairing.requested_ip == ip)
            .order_by(StationPairing.created_at.asc())
        ).all()
        surplus = len(from_ip) - (MAX_PENDING_PAIRINGS_PER_IP - 1)
        if surplus > 0:
            for row in from_ip[:surplus]:
                db.delete(row)
            db.commit()

    total_pending = db.scalar(
        select(func.count()).select_from(StationPairing).where(*pending_filter)
    )
    if total_pending is not None and total_pending >= MAX_PENDING_PAIRINGS:
        raise HTTPException(
            status_code=http_status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many pairing requests are already waiting for approval. Try again shortly.",
            headers={"Retry-After": str(PAIRING_TTL_SECONDS)},
        )

    device_token = f"{DEVICE_TOKEN_PREFIX}{secrets.token_urlsafe(_TOKEN_RANDOM_BYTES)}"
    expires_at = now + timedelta(seconds=PAIRING_TTL_SECONDS)

    # Retry on the (astronomically unlikely) code collision rather than
    # handing the caller a 500. The unique constraint is the arbiter, so two
    # concurrent starts can never share a code.
    last_error: IntegrityError | None = None
    for _ in range(8):
        pairing = StationPairing(
            user_code=_mint_user_code(),
            device_token_hash=_hash_token(device_token),
            status=PAIRING_PENDING,
            device_hint=(payload.device_hint or "").strip()[:128] or None,
            agent_version=(payload.agent_version or "").strip()[:64] or None,
            requested_ip=ip,
            created_at=now,
            expires_at=expires_at,
            poll_count=0,
        )
        db.add(pairing)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            last_error = exc
            continue
        db.refresh(pairing)
        return StationPairStartOut(
            user_code=pairing.user_code,
            device_token=device_token,
            device_code=device_token,
            expires_at=pairing.expires_at,
            expires_in=PAIRING_TTL_SECONDS,
            poll_interval=POLL_MIN_INTERVAL_SECONDS,
            interval=POLL_MIN_INTERVAL_SECONDS,
        )

    raise HTTPException(
        status_code=http_status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Could not allocate a pairing code. Try again.",
    ) from last_error


# ---------------------------------------------------------------------------
# 2./3. Administrator reviews and approves (system:manage)
# ---------------------------------------------------------------------------


@router.get("/pair/pending", response_model=list[StationPairingOut])
def pair_pending(
    _: User = Depends(require_permission("system:manage")),
    db: Session = Depends(get_db),
):
    """Codes currently waiting for a decision, newest first.

    Expired rows are filtered by clock rather than by a sweep, so a code can
    never linger in this list past its lifetime because a cleanup job did not
    run.
    """
    now = utcnow()
    rows = db.scalars(
        select(StationPairing)
        .where(StationPairing.status == PAIRING_PENDING, StationPairing.expires_at > now)
        .order_by(StationPairing.created_at.desc())
    ).all()
    return [_pairing_out(row, now) for row in rows]


def _resolve_pairing(
    db: Session, *, user_code: str | None, pairing_id: int | None
) -> StationPairing:
    """Find the pairing an admin means, by typed code or by list click."""
    normalized = _normalize_user_code(user_code)
    if not normalized and pairing_id is None:
        raise HTTPException(status_code=400, detail="Provide either user_code or pairing_id")

    stmt = select(StationPairing)
    if pairing_id is not None:
        stmt = stmt.where(StationPairing.id == pairing_id)
    else:
        stmt = stmt.where(StationPairing.user_code == normalized)
    pairing = db.scalars(stmt).first()
    if pairing is None:
        raise HTTPException(status_code=404, detail="Pairing code not found")
    return pairing


def _assert_pairing_actionable(pairing: StationPairing, now: datetime) -> None:
    if pairing.status != PAIRING_PENDING:
        raise HTTPException(
            status_code=409,
            detail=f"This pairing code was already {pairing.status}",
        )
    if pairing.expires_at <= now:
        raise HTTPException(status_code=410, detail="This pairing code has expired")


@router.post("/pair/approve", response_model=StationPairApproveOut)
def pair_approve(
    payload: StationPairApproveRequest,
    current_user: User = Depends(require_permission("system:manage")),
    db: Session = Depends(get_db),
):
    """Approve a pairing and name the station.

    This is the step that replaces typing a password on the Pi, so it is a
    deliberate act by a named administrator and it is audit-logged with who,
    when, and which code.

    The station row is created here so the admin sees the result immediately,
    but its token is *not* minted here: it comes into existence only in the
    poll response that hands it to the device, and only ever as a hash
    afterwards. The approving admin's browser therefore never holds a
    credential it has no use for.
    """
    now = utcnow()
    pairing = _resolve_pairing(db, user_code=payload.user_code, pairing_id=payload.pairing_id)
    _assert_pairing_actionable(pairing, now)

    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Station name is required")

    expires_at = None
    if payload.expires_in_days is not None:
        expires_at = now + timedelta(days=payload.expires_in_days)

    station = Station(
        name=name,
        token_hash=_unclaimed_hash(),
        prefix="",
        created_at=now,
        created_by=current_user.id,
        paired_from_ip=pairing.requested_ip,
        agent_version=pairing.agent_version,
        hardware_status={},
        expires_at=expires_at,
    )
    db.add(station)
    db.flush()

    pairing.status = PAIRING_APPROVED
    pairing.approved_at = now
    pairing.approved_by = current_user.id
    pairing.station_id = station.id
    # Reopen the clock so a device approved in the last second of the original
    # window still has a full, unhurried window to collect.
    pairing.expires_at = now + timedelta(seconds=PAIRING_CLAIM_TTL_SECONDS)
    db.add(pairing)
    db.commit()
    db.refresh(station)

    log_admin_action(
        db,
        current_user,
        "station.approve",
        "station",
        str(station.id),
        details={
            "name": station.name,
            "user_code": pairing.user_code,
            "requested_ip": pairing.requested_ip,
            "device_hint": pairing.device_hint,
            "expires_at": str(expires_at) if expires_at else None,
        },
        category="system",
    )

    return StationPairApproveOut(user_code=pairing.user_code, station=_station_out(station))


@router.post("/pair/deny", response_model=StationPairDenyOut)
def pair_deny(
    payload: StationPairDenyRequest,
    current_user: User = Depends(require_permission("system:manage")),
    db: Session = Depends(get_db),
):
    """Reject a pairing. The device is told ``denied`` on its next poll and
    stops — better than letting it hammer a code that will never be approved."""
    now = utcnow()
    pairing = _resolve_pairing(db, user_code=payload.user_code, pairing_id=payload.pairing_id)
    _assert_pairing_actionable(pairing, now)

    pairing.status = PAIRING_DENIED
    pairing.denied_at = now
    pairing.denied_by = current_user.id
    db.add(pairing)
    db.commit()

    log_admin_action(
        db,
        current_user,
        "station.deny",
        "station_pairing",
        str(pairing.id),
        details={"user_code": pairing.user_code, "requested_ip": pairing.requested_ip},
        category="system",
    )
    return StationPairDenyOut(user_code=pairing.user_code)


# ---------------------------------------------------------------------------
# 4. Device polls for the verdict (unauthenticated, device token = proof)
# ---------------------------------------------------------------------------


@router.post("/pair/poll", response_model=StationPairPollOut)
def pair_poll(
    payload: StationPairPollRequest,
    db: Session = Depends(get_db),
):
    """Poll a pairing with the device token issued at ``/pair/start``.

    A token we cannot find is answered exactly like one that ran out of time:
    a device that mistyped its token, one whose row was pruned, and one that
    simply waited too long are indistinguishable from outside, and all three
    should do the same thing — start over. (It is also the answer that keeps a
    device from mistaking "unknown handle" for "this server has no pairing
    endpoint" and giving up on the feature entirely.)

    A known token gets one of five verdicts, and in exactly one of them (the
    first ``approved`` poll after an approval) the station token crosses the
    wire. That response is the only place it will ever exist; a second poll
    returns ``claimed`` with no token.
    """
    now = utcnow()
    token = payload.device_token.strip()
    pairing = db.scalars(
        select(StationPairing).where(StationPairing.device_token_hash == _hash_token(token))
    ).first()
    if pairing is None:
        return StationPairPollOut(
            status="expired",
            poll_interval=POLL_MIN_INTERVAL_SECONDS,
            message="This pairing is no longer valid. Start a new pairing.",
        )

    if pairing.status == PAIRING_DENIED:
        return StationPairPollOut(
            status="denied",
            poll_interval=POLL_MIN_INTERVAL_SECONDS,
            message="An administrator rejected this pairing request.",
        )

    if pairing.status == PAIRING_CLAIMED:
        return StationPairPollOut(
            status="claimed",
            poll_interval=POLL_MIN_INTERVAL_SECONDS,
            message="The station token was already issued and is never reissued.",
        )

    expired = pairing.expires_at <= now

    if pairing.status == PAIRING_APPROVED and not expired:
        return _issue_station_token(db, pairing, now)

    if expired:
        # An approval that was never collected leaves a station row that can
        # never authenticate (its hash is the unclaimed sentinel). Mark it
        # revoked so it reads as dead in the admin list rather than as a
        # station that merely never phoned home.
        if pairing.status == PAIRING_APPROVED and pairing.station_id is not None:
            station = db.get(Station, pairing.station_id)
            if station is not None and station.revoked_at is None and not _is_claimed(station):
                station.revoked_at = now
                db.add(station)
                db.commit()
        return StationPairPollOut(
            status="expired",
            poll_interval=POLL_MIN_INTERVAL_SECONDS,
            message="This pairing code expired. Start a new pairing.",
        )

    # Still pending. Throttle here and only here: the wait is the only state a
    # device can sit in indefinitely, and it is the state worth rate-limiting.
    # An approved verdict is always delivered immediately.
    if (
        pairing.last_polled_at is not None
        and (now - pairing.last_polled_at).total_seconds() < POLL_MIN_INTERVAL_SECONDS
    ):
        raise HTTPException(
            status_code=http_status.HTTP_429_TOO_MANY_REQUESTS,
            detail="slow_down",
            headers={"Retry-After": str(POLL_MIN_INTERVAL_SECONDS)},
        )

    pairing.last_polled_at = now
    pairing.poll_count = (pairing.poll_count or 0) + 1
    db.add(pairing)
    db.commit()
    return StationPairPollOut(
        status="pending",
        poll_interval=POLL_MIN_INTERVAL_SECONDS,
        message="Waiting for an administrator to approve this code.",
    )


def _issue_station_token(
    db: Session, pairing: StationPairing, now: datetime
) -> StationPairPollOut:
    """Mint the long-lived token, hash it into the station row, hand it over.

    The raw value lives in this function's frame and in the response body.
    It is never written to the database, never logged (the audit entry records
    the prefix stub only), and never recoverable afterwards.
    """
    station = db.get(Station, pairing.station_id) if pairing.station_id else None
    if station is None:
        # Approved but the station row vanished (an admin deleting rows by
        # hand, a failed transaction). Fail closed rather than inventing one.
        raise HTTPException(status_code=409, detail="Pairing is no longer valid")
    if station.revoked_at is not None:
        return StationPairPollOut(
            status="denied",
            poll_interval=POLL_MIN_INTERVAL_SECONDS,
            message="This station was revoked before the token was collected.",
        )
    if _is_claimed(station):  # pragma: no cover — status guard above already covers it
        return StationPairPollOut(
            status="claimed",
            poll_interval=POLL_MIN_INTERVAL_SECONDS,
            message="The station token was already issued and is never reissued.",
        )

    raw_token = f"{STATION_TOKEN_PREFIX}{secrets.token_urlsafe(_TOKEN_RANDOM_BYTES)}"
    station.token_hash = _hash_token(raw_token)
    station.prefix = raw_token[:20]
    db.add(station)

    pairing.status = PAIRING_CLAIMED
    pairing.claimed_at = now
    db.add(pairing)
    db.commit()
    db.refresh(station)

    log_admin_action(
        db,
        None,  # the actor is a device, not a user
        "station.claim",
        "station",
        str(station.id),
        details={"name": station.name, "prefix": station.prefix, "user_code": pairing.user_code},
        category="system",
    )

    return StationPairPollOut(
        status="approved",
        token=raw_token,
        station=_station_out(station),
        poll_interval=POLL_MIN_INTERVAL_SECONDS,
        message="Store this token now. It is not shown again.",
    )


# ---------------------------------------------------------------------------
# 5. Station-authenticated endpoints
# ---------------------------------------------------------------------------


def _assemble_hardware_status(payload: StationHeartbeatRequest) -> dict:
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

    serialized = json.dumps(blob, default=str)
    if len(serialized.encode("utf-8")) > MAX_HARDWARE_STATUS_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Hardware status must serialise to at most {MAX_HARDWARE_STATUS_BYTES} bytes",
        )
    return blob


@router.post("/heartbeat", response_model=StationHeartbeatOut)
def station_heartbeat(
    payload: StationHeartbeatRequest,
    station: Station = Depends(get_current_station),
    db: Session = Depends(get_db),
):
    """Liveness plus self-reported hardware state.

    The station calls this on a timer, so it doubles as the "is the Pi alive?"
    signal in the admin list. ``last_seen_at`` is written unconditionally here
    (unlike the throttled stamp in the auth dependency) because that is the
    entire purpose of the call.
    """
    now = utcnow()
    station.last_seen_at = now
    if payload.agent_version is not None:
        station.agent_version = payload.agent_version.strip()[:64] or None
    station.hardware_status = _assemble_hardware_status(payload)
    db.add(station)
    db.commit()
    db.refresh(station)
    return StationHeartbeatOut(station=_station_out(station), server_time=now)


@router.get("/me", response_model=StationOut)
def station_me(station: Station = Depends(get_current_station)):
    """Who am I? Lets the agent confirm its token still works and show the
    admin-chosen name on its own screen."""
    return _station_out(station)


# ---------------------------------------------------------------------------
# 6. Administrator manages paired stations (system:manage)
# ---------------------------------------------------------------------------


@router.get("/stations", response_model=list[StationOut])
def list_stations(
    _: User = Depends(require_permission("system:manage")),
    db: Session = Depends(get_db),
):
    """Every station ever paired, newest first — revoked and expired ones
    included, because "when did we retire that Pi?" is an audit question."""
    rows = db.scalars(select(Station).order_by(Station.created_at.desc())).all()
    return [_station_out(row) for row in rows]


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
    return _station_out(_revoke(db, station_id, current_user))


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
