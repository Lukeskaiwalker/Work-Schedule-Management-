"""Scan-station pairing — the two tables behind the device authorization grant.

A *station* is a fixed, unattended device (the office Raspberry Pi running
``tools/label_agent``: barcode scanner, Brother label printer, test-instrument
SD imports). It has no keyboard worth typing a password on and no browser
worth running a login form in, so it authenticates with a long-lived bearer
token of its own rather than with somebody's user session.

The token is not typed into the device. It is *granted* to it, using the shape
of OAuth 2.0's device authorization grant (RFC 8628), which exists for exactly
this class of hardware:

  1. the device asks for a pairing (``StationPairing`` row) and gets back a
     short human-typable ``user_code`` it can show on its screen, plus an
     opaque high-entropy device token only it holds;
  2. an administrator sees the code in the SMPL web UI and approves it,
     naming the station. That approval — not a password on the device — is
     the authorising act;
  3. the device polls with its device token and collects the station token
     exactly once.

Both credentials are stored as sha256 hashes, never in plaintext, the same way
``ApiToken`` handles personal access tokens: a database dump cannot be
replayed against the API. The raw station token exists in memory for the
duration of one response and is never persisted, logged, or returned again.

An "active" station is one where ``revoked_at IS NULL`` AND (``expires_at IS
NULL OR expires_at > now()``). Both conditions are checked at the request
boundary, so a revoke takes effect on the device's very next call without any
cache to invalidate.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow

# Pairing lifecycle. Kept in the app layer like every other status in this
# schema. ``expired`` is deliberately NOT one of them — expiry is a function
# of ``expires_at`` and the current clock, so it can never go stale by a
# missed sweep.
PAIRING_PENDING = "pending"
PAIRING_APPROVED = "approved"
PAIRING_DENIED = "denied"
PAIRING_CLAIMED = "claimed"


class Station(Base):
    """A paired device and its (hashed) long-lived token."""

    __tablename__ = "stations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # Human label chosen by the approving admin — "Werkstatt Scan-Station",
    # "Büro Pi". Required, because "which of these three tokens is the one in
    # the workshop?" is unanswerable six months later without it.
    name: Mapped[str] = mapped_column(String(128), nullable=False)

    # sha256(raw_token) hex — never the raw token itself.
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    # First 20 chars of the raw token (``smpl_station_`` + 7 random chars) for
    # UI display only. The remaining 36 random characters are what
    # authenticates, so showing the stub leaks nothing usable.
    prefix: Mapped[str] = mapped_column(String(24), nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    # Where the pairing request came from, captured at approval time. Useful
    # when an admin is looking at two pending codes and needs to tell which
    # one is the Pi on the bench.
    paired_from_ip: Mapped[str | None] = mapped_column(String(64))

    # Reported by the device on every heartbeat.
    agent_version: Mapped[str | None] = mapped_column(String(64))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)
    # Free-form hardware status from the agent's own /health: printer
    # connected, media width, last error. Free-form on purpose — the station
    # agent's hardware surface will change faster than this schema should.
    hardware_status: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    # NULL means "never expires". The approve endpoint sets a bounded default
    # instead; see routers/workflow_station.py for the reasoning.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoked_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )


class StationPairing(Base):
    """One in-flight pairing attempt: a code on a screen waiting for a human.

    Rows are short-lived by construction (``expires_at``), single-use
    (``status`` moves pending → approved → claimed and never back), and
    retained after the fact so the audit trail can answer "who approved the
    device that printed this?".
    """

    __tablename__ = "station_pairings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # The short code shown on the device and typed/clicked by the admin, e.g.
    # ``WXYZ-4821``. Unique so an admin approving a code can never hit two
    # rows; generated from a CSPRNG over an unambiguous alphabet.
    user_code: Mapped[str] = mapped_column(String(16), unique=True, index=True, nullable=False)

    # sha256 of the opaque token only the device holds. This — not the short
    # code — is what proves "I am the device that started this pairing".
    device_token_hash: Mapped[str] = mapped_column(
        String(128), unique=True, index=True, nullable=False
    )

    status: Mapped[str] = mapped_column(
        String(16), default=PAIRING_PENDING, nullable=False, index=True
    )

    # Self-reported by the device at start. Advisory only: it is unauthenticated
    # input, so it is shown to the admin as a hint and never trusted as identity.
    device_hint: Mapped[str | None] = mapped_column(String(128))
    agent_version: Mapped[str | None] = mapped_column(String(64))
    requested_ip: Mapped[str | None] = mapped_column(String(64))

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    # Poll bookkeeping — drives the RFC 8628 ``slow_down`` throttle and gives
    # an admin a way to see whether the device is actually still waiting.
    last_polled_at: Mapped[datetime | None] = mapped_column(DateTime)
    poll_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    denied_at: Mapped[datetime | None] = mapped_column(DateTime)
    denied_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    # Set the moment the device collects its token. The token is issued once;
    # this timestamp is what makes a second collection impossible.
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime)

    station_id: Mapped[int | None] = mapped_column(
        ForeignKey("stations.id", ondelete="SET NULL"), index=True
    )
