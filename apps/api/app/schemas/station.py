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

from app.schemas.werkstatt import WerkstattArticleOut

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


# Freshness of the last heartbeat, judged server-side so the page and the api
# can never disagree about what "online" means. ``stale`` exists because
# "offline" is too strong for a Pi that missed one beat — the agent may simply
# be feeding tape. The thresholds live in ``services/station_view.py``.
StationStatus = Literal["online", "stale", "offline", "unknown"]


class StationHardwareOut(BaseModel):
    """The station's hardware, normalised from the agent's free-form blob.

    The agent describes itself in whatever keys its version knows; this is the
    fixed shape the admin page renders, so a printer row can never read "nicht
    verbunden" while the heartbeat underneath says the printer is fine.
    """

    printer_connected: bool = False
    printer_model: str | None = None
    media_width_mm: float | None = None
    # Why the printer is unusable, in the agent's words ("printer not found on
    # USB …"). Truthful, not an outage: the rest of the station keeps working.
    printer_error: str | None = None
    scanner_present: bool = False
    scanner_name: str | None = None
    # True when the agent runs with --no-printer: labels render, nothing feeds.
    simulated: bool = False


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

    # -- what the Scan-Station page renders (computed, never stored as-is) --
    status: StationStatus = "unknown"
    location: str | None = None
    # The agent's LAN address as the Pi reported it, validated private. The
    # admin override (``agent_url_override``) wins over the pair when set.
    host: str | None = None
    port: int | None = None
    agent_url_override: str | None = None
    uptime_seconds: int | None = None
    paired_at: datetime | None = None
    paired_by_name: str | None = None
    # Sessions the Pi holds, and how many of them SMPL has never imported.
    session_count: int = 0
    pending_count: int = 0
    # The api's own reason the last call to the agent failed, cleared by the
    # next heartbeat or successful refresh. Distinct from the printer's error,
    # which lives in ``hardware.printer_error``.
    agent_error: str | None = None
    hardware: StationHardwareOut = Field(default_factory=StationHardwareOut)

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

    # Where the agent listens, as seen from the Pi's own NIC. The router is
    # what the request IP shows (hairpin NAT), so the device has to say. The
    # router validates ``host`` to a private address before storing it; an
    # agent that reports something else keeps its heartbeat but loses its
    # address. Older agents send none of these and are unaffected.
    host: str | None = Field(default=None, max_length=64)
    port: int | None = Field(default=None, ge=1, le=65535)
    uptime_seconds: int | None = Field(default=None, ge=0)
    session_count: int | None = Field(default=None, ge=0, le=100_000)
    # {printer_model, scanner_present, scanner_name, simulated} — the keys
    # ``StationHardwareOut`` normalises. Kept as a dict so a newer agent can
    # add a field without a schema change on this side.
    hardware: dict[str, Any] | None = None


class StationHeartbeatOut(BaseModel):
    ok: bool = True
    station: StationOut
    server_time: datetime


# ---------------------------------------------------------------------------
# Admin operations on a paired station (routers/workflow_station_admin.py)
# ---------------------------------------------------------------------------


class StationPatchRequest(BaseModel):
    """Body for PATCH /api/station/stations/{id}. Every field optional; a
    field that is absent is left alone, ``null`` clears the optional ones.

    ``agent_url`` is the admin override for where the api reaches the agent:
    ``http://<private ip or *.local>:<port>``. Anything public is refused —
    see ``services/station_agent_client.validate_agent_url``.
    """

    # No ``min_length`` here on purpose: an empty name is answered by the
    # router as a 400 with a German sentence, not as a 422 listing constraints.
    name: str | None = Field(default=None, max_length=128)
    location: str | None = Field(default=None, max_length=128)
    agent_url: str | None = Field(default=None, max_length=200)


class StationTestPrintRequest(BaseModel):
    """Body for POST …/test-print. ``text`` is the label's title line."""

    text: str | None = Field(default=None, max_length=120)


class StationRestartRequest(BaseModel):
    """Body for POST …/restart. The api refuses without ``confirm: true`` so
    a stray POST can never bounce the agent mid-inventory."""

    confirm: bool = False


class StationActionOut(BaseModel):
    """Outcome of a one-shot action. ``ok=False`` with a ``detail`` is the
    agent saying "I could not" (printer unplugged); a transport failure is a
    502 instead, because those are different things to a person at the page."""

    ok: bool
    detail: str
    # Round trip in milliseconds — the agent's own figure when it measured one.
    ms: int | None = None


class StationSessionOut(BaseModel):
    """One count session as the Pi holds it, plus what only SMPL knows: when it
    was last imported and into which Werkstatt inventory."""

    name: str
    # The agent's own ISO stamps, passed through untouched.
    started_at: str | None = None
    status: str = "open"
    articles: int = 0
    total_qty: int = 0
    total_scans: int = 0
    last_counted_at: str | None = None
    imported_at: datetime | None = None
    imported_session_id: int | None = None


class StationSessionListOut(BaseModel):
    """``ok=False`` + ``error`` is a statement ("the Pi is off"), not a 5xx:
    the card renders it with a reload button."""

    sessions: list[StationSessionOut] = Field(default_factory=list)
    ok: bool = True
    error: str | None = None


class StationImportRequest(BaseModel):
    """Body for POST …/sessions/{name}/import.

    ``target_session_id`` appends into an existing OPEN inventory; without it
    the newest open inventory this same Pi session was imported into before
    is reused (a re-import is SET-idempotent), else one is created and named
    ``create_session_name`` or after the station.
    """

    target_session_id: int | None = None
    create_session_name: str | None = Field(default=None, max_length=200)


class StationImportOut(BaseModel):
    ok: bool = True
    session_id: int
    session_name: str
    # Count rows written for the first time / already present and updated.
    imported: int
    updated: int
    # Zero-quantity rows the agent sent ("scanned, then undone").
    skipped: int
    # Codes that matched nothing and had no barcode — a person has to look.
    unmatched: list[str] = Field(default_factory=list)
    detail: str


class StationSetupOut(BaseModel):
    """The copy-pasteable install block for a fresh Pi, with the SMPL URL it
    bakes in. The documented path — install-pi.sh, then --pair."""

    script: str
    base_url: str


# ---------------------------------------------------------------------------
# Station-scoped Werkstatt API (the wall-mounted scan station)
# ---------------------------------------------------------------------------

# What a station may write into the movement ledger — the three directions the
# rack screen offers and nothing else: Ausgabe, Rückgabe, Wareneingang.
#
# A strict subset of ``services/werkstatt_movements.ALLOWED_MOVEMENT_TYPES``.
# ``correction``, ``repair_out`` and ``repair_back`` are write-offs and repair
# bookkeeping — decisions with a person and a reason behind them, not
# something a barcode on a wall screen should be able to trigger.
#
# ``inventory_plus``/``inventory_minus`` are deliberately absent too, and for a
# sharper reason than "a station should not". A stock-take correction is the
# one movement ``apply_movement`` cannot sanity-check: checkout, return and
# repair_* are each bounded by a counter, but an inventory correction is by
# definition allowed to disagree with the snapshot, so nothing stops it going
# arbitrarily negative. The recompute then clamps the *snapshot* at 0 while the
# ledger keeps the hole, and every later delivery disappears into it — the
# article reads 0 forever until somebody edits the ledger by hand. That is a
# decision that needs a typed reason, and a wall screen with no keyboard cannot
# supply one. Corrections belong in the inventory-session flow
# (``services/werkstatt_inventory.py``), where a named person signs for them.
STATION_MOVEMENT_TYPES: tuple[str, ...] = (
    "checkout",
    "return",
    "intake",
)


# Upper bound on every quantity a station may put on the wire. See the note on
# ``StationMovementRequest.quantity``: the point is not plausibility, it is that
# an integer wider than the column must never reach ``db.flush()``.
STATION_MAX_QUANTITY = 10_000


class StationMovementRequest(BaseModel):
    """Body for POST /api/station/werkstatt/movements.

    ``movement_type`` is a plain string rather than a ``Literal``, and carries
    no ``min_length``, on purpose: the whitelist is enforced in the router so
    that *every* rejected value — unknown, empty, or hostile — comes back as
    the same 400 with a German sentence a workshop can read, rather than some
    as a 422 listing the permitted enum members.
    """

    article_id: int
    movement_type: str = Field(default="", max_length=32)
    # Bounded at both ends. ``ge=1`` is the obvious half; ``le`` is the half
    # that was missing: ``intake`` has no counter to fast-fail against, so an
    # unbounded value reached ``db.flush()`` and came back as an
    # OverflowError/DataError — past the ``except MovementError`` handler, with
    # no rollback, as an unhandled 500. 10 000 is far past anything a hand
    # scanner in front of a rack can mean and far short of a 64-bit column.
    quantity: int = Field(default=1, ge=1, le=STATION_MAX_QUANTITY)
    # Who *receives* the tool. Distinct from the ledger's ``user_id``, which
    # stays the station's owner: conflating "who booked it" with "who has it"
    # is how a tool becomes unfindable.
    assignee_user_id: int | None = None
    # Free text from the device. It never *replaces* the station marker on the
    # ledger row — see the note-prefix rule in the router — because a caller
    # that can erase the marker can make a device's booking read like a
    # person's.
    notes: str | None = Field(default=None, max_length=500)


class StationMovementOut(BaseModel):
    """The article as it now stands, plus the ledger row that moved it.

    The screen re-renders from ``article`` rather than from its own arithmetic:
    the counters are recomputed from the whole ledger server-side, so anything
    the Pi calculated locally would be a guess at what the server just did.
    """

    article: WerkstattArticleOut
    movement_id: int


class StationCrewMemberOut(BaseModel):
    """One tappable name on the rack screen.

    A worker taps their name before taking a tool out, so the ledger can answer
    "who has the drill". Two fields only: the screen renders a grid of buttons
    and has no room — or use — for a role, an avatar or a nickname.

    The rows come from ``_list_active_assignable_users`` — the same selection
    and the same ordering behind ``GET /api/users/assignable``, so the wall
    cannot offer somebody the app does not (or hide somebody it does).
    ``name`` is that helper's ``display_name``: the string every other screen
    in SMPL already calls this person.
    """

    id: int
    name: str


class StationArticleFromCatalogRequest(BaseModel):
    """A delivery arriving for something the workshop has never stocked.

    The rack screen sends this only after ``/resolve`` answered
    ``catalog_match``: the wholesaler's Datanorm row is the identity, so the
    device names the row rather than describing the product. It cannot invent
    an item_name, an EAN or a manufacturer — everything that ends up on the
    article comes from the catalogue, which is what keeps an unattended screen
    from writing a product into the stock list that no supplier sells.
    """

    catalog_item_id: int
    # Same cap and the same reason as StationMovementRequest.quantity: intake
    # has no counter to fast-fail against, so an unbounded value reaches
    # db.flush() and returns as an unhandled 500.
    quantity: int = Field(default=1, ge=1, le=STATION_MAX_QUANTITY)
    notes: str | None = Field(default=None, max_length=500)


class StationArticleFromCatalogOut(StationMovementOut):
    """The stocked article, the ledger row, and which of the two just happened.

    ``created`` exists because the screen's sentence differs: "Artikel angelegt
    und eingebucht" is a bigger claim than "eingebucht", and an operator who
    scans the same pallet twice should be able to see that the second scan
    topped up rather than duplicated.
    """

    created: bool


class StationBoxHandoverRequest(BaseModel):
    """"Mitnehmen" at the wall. The crate is named by the URL, so the body is
    empty — a station may not choose a customer, a project or a quantity here;
    all three are already on the packed crate and the screen only confirms that
    somebody is carrying it out."""

    notes: str | None = Field(default=None, max_length=500)


class StationArticleFromLookupRequest(BaseModel):
    """A delivery for something neither SMPL nor its Datanorm has ever seen.

    The rack screen sends the raw code and the server does the looking — the
    device never chooses a source and never sees a URL, which is what keeps
    the station's power the same size it was: it books a delivery, and the
    identity of what it booked comes from somewhere accountable.

    ``item_name`` and ``unit`` are the one exception, and a narrow one. When
    the lookup finds nothing at all the operator is standing at a screen that
    HAS a keyboard (the rack panel does; the crate screen does not) with a box
    in their hands, and the alternative is a placeholder article called
    "Unbekannt (4006381333931)" that nobody ever goes back to fix. A typed name
    is only accepted when every other source came up empty; if the lookup
    resolves, what it found wins.
    """

    code: str = Field(min_length=1, max_length=64)
    # Same cap and the same reason as StationMovementRequest.quantity: intake
    # has no counter to fast-fail against, so an unbounded value reaches
    # db.flush() and returns as an unhandled 500.
    quantity: int = Field(default=1, ge=1, le=STATION_MAX_QUANTITY)
    item_name: str | None = Field(default=None, max_length=200)
    unit: str | None = Field(default=None, max_length=32)
    notes: str | None = Field(default=None, max_length=500)
    # One attempt's idempotency token, minted by the station and reused
    # verbatim on its retries. This endpoint can spend several seconds asking
    # the outside world, which is long enough for the Pi's own HTTP timeout to
    # fire while the server goes on to create the article and commit the
    # intake. The wall then says "nicht angelegt" for a delivery that WAS
    # booked, and the operator scans again — so a repeat carrying the same
    # token replays the first answer instead of booking twice. Omitted, the
    # endpoint behaves exactly as before.
    request_id: str | None = Field(default=None, min_length=8, max_length=64)


class StationArticleFromLookupOut(StationArticleFromCatalogOut):
    """The stocked article, the ledger row, and where its identity came from.

    ``origin`` drives one sentence on the wall: "Artikel angelegt (Unielektro)"
    reads differently from "eingebucht", and an operator who scans the same
    pallet twice should be able to see that the second scan topped up rather
    than duplicated.

    ``internal_code`` is carried because a freshly created article usually has
    no barcode of its own on the box — the api, not the Pi, mints and prints
    those, so the response hands the station the code a later label job needs
    instead of making it ask again.
    """

    origin: Literal["existing", "catalog", "external", "manual"]
    source: str | None = None
    internal_code: str | None = None
