"""Wire models for the scan-station device-pairing flow.

These are the contract the Raspberry Pi agent (``tools/label_agent``) and the
admin web UI both code against, so every field is plain JSON — no enums that
serialise to objects, no datetimes without a timezone convention (all
timestamps are naive UTC, as everywhere else in this API).

Two of these models carry a secret exactly once and never again:

* ``StationPairStartOut.device_token`` — the opaque handle the device polls
  with. It identifies an *unapproved* pairing attempt and grants nothing.
* ``StationPairPollOut.token`` — the long-lived station token, present in the
  single response that transitions a pairing to ``claimed``. Every later read
  of that station returns ``prefix`` only.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

# The five states a polling device can be told about. ``expired`` and
# ``claimed`` are derived at read time rather than stored, so they can never
# disagree with the row they describe.
PairStatus = Literal["pending", "approved", "denied", "expired", "claimed"]


class StationPairStartRequest(BaseModel):
    """Body for POST /api/station/pair/start (unauthenticated).

    Both fields are self-reported by an unauthenticated caller, so they are
    treated as display hints for the approving admin — never as identity.
    ``device_hint`` is typically the hostname; ``agent_version`` the label
    agent's own version string.

    ``device_name`` and ``hostname`` are accepted as spellings of
    ``device_hint``: the device end of this handshake is a small stdlib client
    that has to guess at the field names, and a dropped hint means the admin
    approves a code with nothing next to it. Unknown extra keys (``client_id``,
    ``scope``, ``device_id`` …) are ignored rather than rejected, for the same
    reason — a 422 here would abort a pairing over a field nobody reads.
    """

    device_hint: str | None = Field(
        default=None,
        max_length=128,
        validation_alias=AliasChoices("device_hint", "device_name", "hostname"),
    )
    agent_version: str | None = Field(default=None, max_length=64)


class StationPairStartOut(BaseModel):
    """The pairing handle. ``user_code`` goes on the device's screen for a
    human to read out; ``device_token`` stays inside the device and is what it
    polls with. ``poll_interval`` is the minimum seconds between polls — poll
    faster and the server answers 429.

    ``device_code`` and ``interval`` are the RFC 8628 spellings of
    ``device_token`` and ``poll_interval``, carrying identical values. They
    are emitted so a client written against the standard (or against a guess
    at our field names) works unmodified; neither is a second credential.
    """

    user_code: str
    device_token: str
    device_code: str
    expires_at: datetime
    expires_in: int
    poll_interval: int
    interval: int


class StationPairingOut(BaseModel):
    """One pending pairing, as an administrator sees it in the approval list."""

    id: int
    user_code: str
    status: str
    device_hint: str | None = None
    agent_version: str | None = None
    requested_ip: str | None = None
    created_at: datetime
    expires_at: datetime
    expires_in: int
    poll_count: int
    last_polled_at: datetime | None = None


class StationPairApproveRequest(BaseModel):
    """Body for POST /api/station/pair/approve (requires ``system:manage``).

    Identify the pairing by ``user_code`` (what the admin reads off the
    device) or by ``pairing_id`` (what a click in the pending list has to
    hand) — exactly one is required.

    ``name`` is mandatory: an unnamed station is unidentifiable in the list
    later, and this is the one moment somebody is actually looking at the
    device.

    ``expires_in_days`` defaults to 365. Pass ``null`` explicitly for a
    never-expiring token.
    """

    name: str = Field(min_length=1, max_length=128)
    user_code: str | None = Field(default=None, max_length=16)
    pairing_id: int | None = None
    expires_in_days: int | None = Field(default=365, ge=1, le=3650)


class StationPairDenyRequest(BaseModel):
    """Body for POST /api/station/pair/deny. Same identification rules as approve."""

    user_code: str | None = Field(default=None, max_length=16)
    pairing_id: int | None = None


class StationOut(BaseModel):
    """Public view of a paired station. Never carries the token — only its
    ``prefix`` stub, which is not usable as a credential."""

    id: int
    name: str
    prefix: str
    created_at: datetime
    created_by: int | None = None
    paired_from_ip: str | None = None
    agent_version: str | None = None
    last_seen_at: datetime | None = None
    hardware_status: dict[str, Any] = Field(default_factory=dict)
    expires_at: datetime | None = None
    revoked_at: datetime | None = None
    revoked_by: int | None = None
    # Convenience for the UI: true when the token would authenticate right
    # now (not revoked, not expired).
    active: bool

    model_config = ConfigDict(from_attributes=True)


class StationPairApproveOut(BaseModel):
    """Approval result. Deliberately does NOT contain the station token — the
    admin's browser has no business holding it; only the device that started
    the pairing can collect it, by polling."""

    status: Literal["approved"] = "approved"
    user_code: str
    station: StationOut


class StationPairDenyOut(BaseModel):
    status: Literal["denied"] = "denied"
    user_code: str


class StationPairPollRequest(BaseModel):
    """Body for POST /api/station/pair/poll (unauthenticated, but the device
    token is a 256-bit secret, so possession is the proof)."""

    device_token: str = Field(
        min_length=8,
        max_length=256,
        validation_alias=AliasChoices("device_token", "device_code"),
    )


class StationPairPollOut(BaseModel):
    """Poll result.

    * ``pending``  — nobody has approved it yet; keep polling.
    * ``approved`` — ``token`` and ``station`` are populated. This response is
      the only time the raw token exists on the wire; store it now.
    * ``denied``   — an administrator rejected the request. Stop.
    * ``expired``  — the code timed out unapproved. Start a new pairing.
    * ``claimed``  — the token was already collected once. It is not reissued.
    """

    status: PairStatus
    token: str | None = None
    station: StationOut | None = None
    poll_interval: int = 5
    message: str | None = None


class StationHeartbeatRequest(BaseModel):
    """Body for POST /api/station/heartbeat (station token required).

    The named fields mirror the label agent's own ``/health`` payload so the
    device can forward what it already computes. ``status`` carries anything
    else it wants recorded; the whole assembled blob is capped server-side.
    """

    agent_version: str | None = Field(default=None, max_length=64)
    printer_connected: bool | None = None
    media_width_mm: float | None = Field(default=None, ge=0, le=1000)
    error: str | None = Field(default=None, max_length=500)
    status: dict[str, Any] | None = None


class StationHeartbeatOut(BaseModel):
    ok: bool = True
    station: StationOut
    server_time: datetime
