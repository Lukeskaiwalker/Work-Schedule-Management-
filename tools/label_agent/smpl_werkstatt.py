"""The station's client for crates, resolves, stock lines and movements.

``server.py`` already has an :class:`~server.Upstream` for the one call the
scan-and-print path needs. This is the other half: everything the two kiosk
screens need from SMPL, spoken over the station's *paired* credential — the
one an admin can revoke centrally without anybody walking to the Pi.

The token is not captured at construction. It is asked for per request through
the same ``token_provider`` callable that ``Upstream``, ``Heartbeat`` and
``ImportUploader`` use, so a station that is re-paired while it is running
starts working again without a restart, and a station that is revoked reports
it (``on_auth``) instead of silently doing nothing.

One rule governs the whole module: **nothing here may raise into a request
handler.** Reads answer ``None`` or a stale snapshot; writes answer a
:class:`Result` whose ``error`` is a sentence somebody can act on. A crate
screen rendering a ten-second-old box list while the switch reboots is doing
its job. A crate screen showing a traceback is not.

The box snapshot is cached with a short TTL for exactly that reason, and it
says so: ``stale`` is part of the contract, not an implementation detail, so
the screen can grey itself out rather than quietly lie.
"""

from __future__ import annotations

import copy
import json
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import dispense_codes

__all__ = [
    "WerkstattClient",
    "Result",
    "PATHS",
    "items_path",
    "remove_path",
    "handover_path",
    "panel_path",
    "panel_scan_path",
    "panel_undo_path",
    "article_id_of",
    "machine_of",
    "kind_of",
    "scan_kind",
    "is_outdated",
    "MOVEMENT_TYPES",
    "SMPL_OUTDATED",
]

BASE = "/api/station/werkstatt"

PATHS = {
    "boxes": BASE + "/boxes",
    "resolve": BASE + "/resolve",
    "movements": BASE + "/movements",
    "crew": BASE + "/crew",
    "from_catalog": BASE + "/articles/from-catalog",
    # The wider cascade: `resolve` answers "which of SMPL's rows is this" and
    # never leaves the building; `lookup` may also ask the public webshop, so
    # the screen only reaches for it at the moment a Wareneingang has already
    # found nothing. `from_lookup` is the write that follows.
    "lookup": BASE + "/lookup",
    "from_lookup": BASE + "/articles/from-lookup",
    # A Verteiler's material list, by its printed number, and the two writes
    # under it (`/{id}/scan`, `/{id}/undo`). These are the only station
    # routes that write `consumption` rows: the movements route above keeps
    # refusing that kind.
    "panels": BASE + "/panels",
    # A person's own badge. SMPL decides what the scan means (identify, clock
    # onto the open board, off it, switch) so two stations always agree.
    "badge": BASE + "/badge",
    # The rack's Ausgabe of consumables: each crew member's current and recent
    # projects (the tiles after a name), and the two writes. A consumable
    # leaves stock as `consumption` for a person and maybe a project, and
    # comes back as `consumption_undo` -- never through `movements`, which
    # keeps its three types so an older agent keeps working unchanged.
    "crew_projects": BASE + "/crew-projects",
    "consumptions": BASE + "/consumptions",
    "consumptions_undo": BASE + "/consumptions/undo",
}

#: What a panel number may look like on its way into a URL. The router has
#: already normalised the scan; this is the last check before a code becomes
#: a path segment, so it is strict rather than clever.
_PANEL_CODE_RE = re.compile(r"^[A-Z0-9-]{1,32}$")

#: The movement vocabulary SMPL accepts. Checked here so a typo in a screen
#: costs a 400 from our own process rather than a round trip and a 422.
#:
#: These three and no more: it is a copy of ``STATION_MOVEMENT_TYPES`` in
#: apps/api/app/schemas/station.py, and ``tests/test_smpl_werkstatt.py`` reads
#: that file so the two cannot drift. ``inventory_plus``/``inventory_minus``
#: used to be here and are refused by the API — a stock-take correction is the
#: one movement the server cannot sanity-check against a counter, so it needs
#: a typed reason from a named person and a wall screen with no keyboard
#: cannot supply one. Offering them here only bought a round trip and a 400.
MOVEMENT_TYPES = frozenset(("checkout", "return", "intake"))

DEFAULT_TIMEOUT_S = 4.0
#: What the two calls that may reach the public internet are allowed to take.
#:
#: Everything else here is a local database read and four seconds is generous.
#: `lookup` and `from_lookup` are not: the server may ask a webshop, bounded by
#: its own `EAN_LOOKUP_TIMEOUT_SECONDS` (6 s by default) plus the handler
#: around it. A client timeout SHORTER than the server's budget is the worst
#: of both worlds — the request runs to completion on the server while this
#: end reports a failure, so the wall says "Nicht angelegt" for a delivery that
#: was booked and the operator's natural retry books it a second time. Twenty
#: seconds is comfortably past any answer the server is willing to give; if
#: nothing has come back by then, nothing is coming.
DEFAULT_LOOKUP_TIMEOUT_S = 20.0
DEFAULT_BOX_TTL_S = 15.0
# The crew changes when somebody is hired, not while a crate is packed, so it
# is cached far longer than the boxes are.
DEFAULT_CREW_TTL_S = 300.0
# A person's projects move when somebody plans the week, which happens during
# the working day -- shorter than the crew, still nowhere near per poll.
DEFAULT_CREW_PROJECTS_TTL_S = 120.0
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_QTY = 100000
# The name list is a screen full of buttons, not a directory dump.
MAX_CREW = 200

NOT_CONFIGURED = (
    "Keine Verbindung zu SMPL eingerichtet (SMPL_API_URL fehlt)."
)
#: A new station against an SMPL that has never heard of the route: it books
#: nothing, and the wall says what fixes it.
SMPL_OUTDATED = "SMPL muss aktualisiert werden."
#: FastAPI's own answers for a route (or verb) it does not have. A 404 that the
#: route itself sends -- an unknown article -- carries a German sentence.
_ROUTE_MISSING = {404: "Not Found", 405: "Method Not Allowed"}
#: What a booking's idempotency token may be (the API column is 64 wide).
MAX_REQUEST_ID = 64


def items_path(box_id: int) -> str:
    return "%s/boxes/%d/items" % (BASE, int(box_id))


def remove_path(box_id: int) -> str:
    return "%s/boxes/%d/items/remove" % (BASE, int(box_id))


def handover_path(box_id: int) -> str:
    return "%s/boxes/%d/handover" % (BASE, int(box_id))


def panel_path(code: str) -> str:
    return "%s/panels/%s" % (BASE, urllib.parse.quote(str(code), safe=""))


def panel_scan_path(panel_id: int) -> str:
    return "%s/panels/%d/scan" % (BASE, int(panel_id))


def panel_undo_path(panel_id: int) -> str:
    return "%s/panels/%d/undo" % (BASE, int(panel_id))


@dataclass(frozen=True)
class Result:
    """The outcome of one call: never an exception, always renderable."""

    ok: bool
    data: Any = None
    error: Optional[str] = None
    status: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {"ok": self.ok, "data": self.data, "error": self.error, "status": self.status}


# --------------------------------------------------------------------------
# Reading SMPL's answers defensively
# --------------------------------------------------------------------------


def kind_of(payload: Any) -> Optional[str]:
    """The resolver's ``kind``, or None if the payload is not one."""
    if not isinstance(payload, dict):
        return None
    kind = payload.get("kind")
    return str(kind) if isinstance(kind, str) and kind else None


def scan_kind(payload: Any) -> Optional[str]:
    """What the rack router needs to know about a resolved code.

    A stocked article is a **consumable** or a **tool**, read off
    ``article.is_serialized`` -- the Maschinen tab lists exactly the
    serialized ones, and the owner's rule is that everything else is used up
    at a site. An article that does not say (a real bool, nothing else counts)
    keeps SMPL's own kind, and with it today's rule: lent out. Every other
    answer -- ``machine`` for a unit label, a catalogue hit, nothing -- is
    passed through as SMPL named it.
    """
    kind = kind_of(payload)
    if kind != "werkstatt_article":
        return kind
    article = payload.get("article")
    flag = article.get("is_serialized") if isinstance(article, dict) else None
    if flag is True:
        return dispense_codes.KIND_TOOL
    if flag is False:
        return dispense_codes.KIND_CONSUMABLE
    return kind


def is_outdated(result: "Result") -> bool:
    """True for the answer of an SMPL too old to know a route this station uses."""
    return (not result.ok) and result.error == SMPL_OUTDATED


def unanswered(result: "Result") -> bool:
    """True when a write failed without SMPL saying whether it booked.

    No connection at all (status 0: a timeout, a refused or reset socket) or a
    5xx -- the proxy in front of SMPL answers 502/504 while the API may still
    be committing. A booking that failed like this may have landed, so its
    ``request_id`` has to outlive the attempt: a re-scan of the same thing
    then replays it instead of booking it again. Every 4xx is SMPL's own
    answer, and so is the 404 of an SMPL too old to know the route.
    """
    if result.ok:
        return False
    return result.status == 0 or result.status >= 500


def _route_missing(result: "Result") -> bool:
    return (not result.ok) and _ROUTE_MISSING.get(result.status) == result.error


def _request_id(value: Any) -> str:
    """The caller's token, capped -- or a fresh one for a fresh attempt."""
    text = str(value).strip() if value not in (None, "") else ""
    return text[:MAX_REQUEST_ID] if text else uuid.uuid4().hex


def _int_field(source: Any, key: str) -> Optional[int]:
    """A plain integer field, with ``True`` firmly not counting as ``1``."""
    if not isinstance(source, dict):
        return None
    value = source.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return int(value)


def article_id_of(payload: Any) -> Optional[int]:
    """The article id inside any member of the resolve union, if there is one.

    ``MachineOut`` carries a **flat** ``article_id`` (see
    ``apps/api/app/schemas/werkstatt_machines.py``); a nested
    ``machine["article"]["id"]`` is accepted too, but only because a future
    shape might grow one — the flat field is the one that exists.
    """
    if not isinstance(payload, dict):
        return None
    article = payload.get("article")
    found = _int_field(article, "id")
    if found is not None:
        return found
    machine = payload.get("machine")
    if isinstance(machine, dict):
        found = _int_field(machine, "article_id")
        if found is not None:
            return found
        found = _int_field(machine.get("article"), "id")
        if found is not None:
            return found
    items = payload.get("catalog_items")
    if isinstance(items, list):
        for item in items:
            found = _int_field(item, "article_id")
            if found is not None:
                return found
    return _int_field(payload, "article_id")


def machine_of(payload: Any) -> Optional[Dict[str, Any]]:
    """The five machine facts the rack screen renders, or None.

    A tool is not stock: it has a unit number, a state and — the point of the
    whole exercise — a name attached to whoever is holding it. Projecting one
    into an article row shows a dash and three zeroes for a drill somebody is
    standing in front of.
    """
    if not isinstance(payload, dict):
        return None
    machine = payload.get("machine")
    if not isinstance(machine, dict):
        return None
    return {
        "unit_number": _str_field(machine, "unit_number"),
        "article_name": _str_field(machine, "article_name"),
        "status": _str_field(machine, "status"),
        "holder_name": _str_field(machine, "holder_name"),
        # A real bool, never None: kiosk_rack.html renders the "überfällig"
        # badge on ``is_overdue === true``, and dropping the field here meant
        # a tool that is weeks late looked exactly like one that is not.
        "is_overdue": machine.get("is_overdue") is True,
    }


def _str_field(source: Dict[str, Any], key: str) -> Optional[str]:
    value = source.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def crew_from(payload: Any) -> List[Dict[str, Any]]:
    """``[{"id", "name"}]`` out of whatever the crew route answered.

    Never raises and never half-renders: a row without a usable id or name is
    a button nobody can press, so it is dropped.
    """
    rows: Any = payload
    if isinstance(payload, dict):
        rows = payload.get("crew") or payload.get("users") or payload.get("items")
    if not isinstance(rows, list):
        return []
    people: List[Dict[str, Any]] = []
    for row in rows[:MAX_CREW]:
        if not isinstance(row, dict):
            continue
        user_id = _int_field(row, "id")
        name = _str_field(row, "name") or _str_field(row, "full_name")
        if user_id is None or user_id <= 0 or not name:
            continue
        people.append({"id": user_id, "name": name})
    return people


def _clean_box(raw: Any) -> Optional[Dict[str, Any]]:
    """One box, with the fields the screen contract promises always present."""
    if not isinstance(raw, dict):
        return None
    items = [item for item in (raw.get("items") or []) if isinstance(item, dict)]
    box = dict(raw)
    box["items"] = items
    box["item_count"] = len(items)
    return box


def _boxes_from(payload: Any) -> Optional[List[Dict[str, Any]]]:
    """Accept both a bare list and a ``{"boxes": [...]}`` envelope."""
    rows: Any = payload
    if isinstance(payload, dict):
        rows = payload.get("boxes")
    if not isinstance(rows, list):
        return None
    return [box for box in (_clean_box(row) for row in rows) if box is not None]


def _message_from(payload: Any, fallback: str) -> str:
    """SMPL's own words if it gave any — they are usually German and useful."""
    if isinstance(payload, dict):
        for key in ("detail", "message", "error"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
            if isinstance(value, list) and value:
                first = value[0]
                if isinstance(first, dict) and isinstance(first.get("msg"), str):
                    return first["msg"]
    return fallback


# --------------------------------------------------------------------------
# The client
# --------------------------------------------------------------------------


class WerkstattClient:
    """Boxes, resolves, crate lines and movements — all of them optional."""

    def __init__(self, base_url: str, *, token_provider: Optional[Callable[[], str]] = None,
                 timeout: float = DEFAULT_TIMEOUT_S,
                 lookup_timeout: float = DEFAULT_LOOKUP_TIMEOUT_S,
                 box_ttl_s: float = DEFAULT_BOX_TTL_S,
                 crew_ttl_s: float = DEFAULT_CREW_TTL_S,
                 crew_projects_ttl_s: float = DEFAULT_CREW_PROJECTS_TTL_S,
                 user_agent: str = "smpl-label-agent",
                 clock: Callable[[], float] = time.time,
                 on_auth: Optional[Callable[[int], None]] = None) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self._token_provider = token_provider
        self.timeout = float(timeout)
        # Never below the ordinary timeout: a caller lowering this would
        # re-open the double-booking window the token exists to close.
        self.lookup_timeout = max(float(lookup_timeout), float(timeout))
        self.box_ttl_s = float(box_ttl_s)
        self.crew_ttl_s = float(crew_ttl_s)
        self.crew_projects_ttl_s = float(crew_projects_ttl_s)
        self.user_agent = user_agent
        self._clock = clock
        self._on_auth = on_auth

        self._lock = threading.Lock()
        self._boxes: Optional[List[Dict[str, Any]]] = None
        self._boxes_at = 0.0
        self._boxes_dirty = False
        self._boxes_error: Optional[str] = None
        self._crew: List[Dict[str, Any]] = []
        self._crew_at = 0.0
        self._crew_error: Optional[str] = None
        self._crew_projects: Optional[Dict[int, tuple]] = None
        self._crew_projects_at = 0.0
        self._crew_projects_error: Optional[str] = None
        self._last_ok: Optional[bool] = None
        self._last_error = ""

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def bearer(self) -> str:
        if self._token_provider is None:
            return ""
        try:
            return self._token_provider() or ""
        except Exception:  # noqa: BLE001 - a broken token store is a missing token
            return ""

    # -- boxes ------------------------------------------------------------

    def boxes(self, *, force: bool = False) -> Dict[str, Any]:
        """The crate list, from cache when it is fresh enough.

        Always returns the contract shape. ``stale`` is true whenever the
        rows on screen are older than the last attempt to refresh them —
        including the first attempt, when there is nothing to be stale about.
        """
        now = self._clock()
        with self._lock:
            cached = self._boxes
            age = now - self._boxes_at
            error = self._boxes_error
            dirty = self._boxes_dirty
        if (cached is not None and not force and not dirty
                and age < self.box_ttl_s and error is None):
            return self._snapshot(cached, self._boxes_at, None)

        if not self.configured:
            return self._snapshot(cached, self._boxes_at, NOT_CONFIGURED)

        result = self._request("GET", PATHS["boxes"])
        if not result.ok:
            with self._lock:
                self._boxes_error = result.error
                kept, kept_at = self._boxes, self._boxes_at
            return self._snapshot(kept, kept_at, result.error)

        rows = _boxes_from(result.data)
        if rows is None:
            message = "SMPL antwortete nicht mit einer Kistenliste."
            with self._lock:
                self._boxes_error = message
                kept, kept_at = self._boxes, self._boxes_at
            return self._snapshot(kept, kept_at, message)

        with self._lock:
            self._boxes = rows
            self._boxes_at = now
            self._boxes_error = None
            self._boxes_dirty = False
        return self._snapshot(rows, now, None)

    def invalidate_boxes(self) -> None:
        """Force the next read to go to SMPL — used after a write lands.

        A flag rather than a zeroed timestamp: ``_boxes_at`` is the answer to
        "when was this list last true", which the screens render, and zeroing
        it to trigger a refetch made a crate list that had just been fetched
        claim it never had been.
        """
        with self._lock:
            self._boxes_dirty = True

    def _snapshot(self, rows: Optional[List[Dict[str, Any]]], fetched_at: float,
                  error: Optional[str]) -> Dict[str, Any]:
        # A deep copy so a caller that edits the rows it rendered cannot edit
        # the cache underneath the next caller.
        return {
            "boxes": copy.deepcopy(rows) if rows else [],
            # Keyed on the fetch, not on the row count. A workshop with no
            # crate open is a successful fetch of zero rows; reporting "never
            # fetched" for it meant the box screen said "SMPL wurde noch nie
            # erreicht" the moment the network went down after a quiet day.
            "fetched_at": fetched_at or None,
            "stale": bool(error) or rows is None,
            "error": error,
        }

    def box(self, box_id: int) -> Optional[Dict[str, Any]]:
        """One crate out of the cached snapshot, or None."""
        for candidate in self.boxes()["boxes"]:
            if candidate.get("id") == box_id:
                return candidate
        return None

    # -- crew -------------------------------------------------------------

    def crew(self, *, force: bool = False) -> List[Dict[str, Any]]:
        """Who may be tapped on the rack screen. ``[]`` when SMPL is silent.

        An empty list is a perfectly good answer: the screen shows no name
        buttons, the "aus" rule refuses the scan, and nothing is written on a
        guess about who took the drill. The last good list is kept and served
        while SMPL is unreachable, because the crew does not change during an
        outage.
        """
        now = self._clock()
        with self._lock:
            cached = list(self._crew)
            fresh = cached and (now - self._crew_at) < self.crew_ttl_s
        if fresh and not force:
            return cached
        if not self.configured:
            return cached

        result = self._request("GET", PATHS["crew"])
        if not result.ok:
            with self._lock:
                self._crew_error = result.error
                return list(self._crew)

        people = crew_from(result.data)
        with self._lock:
            # An empty answer from a reachable SMPL is the truth, and replaces
            # the cache; an unreachable SMPL (above) never does.
            self._crew = people
            self._crew_at = now
            self._crew_error = None
            return list(people)

    def crew_projects(self, *, force: bool = False) -> Dict[int, List[Dict[str, Any]]]:
        """Each crew member's current and recent projects, ``{user_id: [...]}``.

        The tiles the rack shows after a name, and the only projects a scanned
        project code may pick. Cached like the crew and refreshed by the
        kiosk tick, never on a tap. An outage serves the last good list. An
        SMPL that has no such route (404 "Not Found") is an answer too: no
        projects, the picker shows nothing, and the status says SMPL needs
        updating -- and it is not asked again until the TTL runs out.
        """
        now = self._clock()
        with self._lock:
            cached = self._crew_projects
            fresh = cached is not None and (now - self._crew_projects_at) < self.crew_projects_ttl_s
            if (fresh and not force) or not self.configured:
                return _projects_copy(cached)

        result = self._request("GET", PATHS["crew_projects"])
        people = dispense_codes.clean_crew_projects(result.data) if result.ok else None
        with self._lock:
            if _route_missing(result):
                self._crew_projects, self._crew_projects_at = {}, now
                self._crew_projects_error = SMPL_OUTDATED
            elif people is None:
                self._crew_projects_error = (
                    result.error or "SMPL antwortete nicht mit einer Projektliste.")
            else:
                self._crew_projects, self._crew_projects_at = people, now
                self._crew_projects_error = None
            return _projects_copy(self._crew_projects)

    # -- resolve ----------------------------------------------------------

    def resolve(self, code: str) -> Optional[Dict[str, Any]]:
        """SMPL's scan cascade, or None for unknown / unreachable."""
        if not self.configured or not (code or "").strip():
            return None
        result = self._request("GET", PATHS["resolve"], query={"code": code})
        if not result.ok or not isinstance(result.data, dict):
            return None
        return result.data

    # -- writes -----------------------------------------------------------

    def add_item(self, box_id: Any, *, code: str = "", article_id: Optional[int] = None,
                 quantity: int = 1) -> Result:
        """Put a line into a crate. One of ``code`` or ``article_id``."""
        box = _as_id(box_id)
        if box is None:
            return Result(False, error="Ungültige Kisten-Nummer.")
        qty = _as_qty(quantity)
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        payload: Dict[str, Any] = {}
        if article_id is not None:
            article = _as_id(article_id)
            if article is None:
                return Result(False, error="Ungültige Artikel-Nummer.")
            payload["article_id"] = article
        elif (code or "").strip():
            payload["code"] = code.strip()
        else:
            return Result(False, error="Weder Code noch Artikel angegeben.")
        payload["quantity"] = qty
        return self._write(items_path(box), payload)

    def remove_item(self, box_id: Any, item_id: Any, quantity: int = 1) -> Result:
        box = _as_id(box_id)
        item = _as_id(item_id)
        qty = _as_qty(quantity)
        if box is None or item is None:
            return Result(False, error="Ungültige Kisten- oder Positions-Nummer.")
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        return self._write(remove_path(box), {"item_id": item, "quantity": qty})

    def handover(self, box_id: Any) -> Result:
        """Book "Mitnehmen": the packed crate leaves, its contents leave stock.

        No body beyond the crate: the customer and the project were decided
        when it was packed, and a wall screen must not be able to change
        either. SMPL refuses anything that is not ``gepackt`` with a German
        sentence the screen shows verbatim.
        """
        box = _as_id(box_id)
        if box is None:
            return Result(False, error="Ungültige Kisten-Nummer.")
        return self._write(handover_path(box), {})

    def movement(self, article_id: Any, movement_type: str, quantity: int = 1, *,
                 assignee_user_id: Optional[int] = None, notes: str = "") -> Result:
        article = _as_id(article_id)
        qty = _as_qty(quantity)
        if article is None:
            return Result(False, error="Ungültige Artikel-Nummer.")
        if movement_type not in MOVEMENT_TYPES:
            return Result(False, error="Unbekannte Bewegungsart '%s'." % movement_type)
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        payload: Dict[str, Any] = {
            "article_id": article, "movement_type": movement_type, "quantity": qty,
        }
        if assignee_user_id is not None:
            assignee = _as_id(assignee_user_id)
            if assignee is None:
                return Result(False, error="Ungültige Benutzer-Nummer.")
            payload["assignee_user_id"] = assignee
        if notes:
            payload["notes"] = str(notes)[:500]
        return self._write(PATHS["movements"], payload)

    def stock_from_catalog(self, catalog_item_id: Any, quantity: int = 1, *,
                           notes: str = "") -> Result:
        """Create the article a catalogue hit describes and book the delivery.

        Only ever called with an id that came back from ``/resolve`` moments
        earlier: the station names a wholesaler's row and the server copies
        every field off it, so nothing this box sends can invent a product.
        The server answers with the same ``{article, movement_id}`` shape a
        movement does — plus ``created``, which is how the screen knows whether
        to say "angelegt und eingebucht" or just "eingebucht".
        """
        item = _as_id(catalog_item_id)
        qty = _as_qty(quantity)
        if item is None:
            return Result(False, error="Ungültiger Katalog-Eintrag.")
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        payload: Dict[str, Any] = {"catalog_item_id": item, "quantity": qty}
        if notes:
            payload["notes"] = str(notes)[:500]
        return self._write(PATHS["from_catalog"], payload)

    def lookup(self, code: str) -> Optional[Dict[str, Any]]:
        """The wider cascade, including the webshop. None if unreachable.

        Separate from :meth:`resolve` because the two cost different things.
        ``resolve`` runs on every scan and touches only SMPL's own tables;
        this one may make the server fetch a product page, so the screen asks
        it once, after a Wareneingang scan has already come back empty.
        """
        if not self.configured or not (code or "").strip():
            return None
        result = self._request("GET", PATHS["lookup"], query={"code": code},
                               timeout=self.lookup_timeout)
        if not result.ok or not isinstance(result.data, dict):
            return None
        return result.data

    def stock_from_lookup(self, code: str, quantity: int = 1, *,
                          item_name: str = "", unit: str = "",
                          notes: str = "", request_id: str = "") -> Result:
        """Book a delivery for a code nothing here has ever stocked.

        The station sends the CODE and lets the server do the looking: it never
        picks a source, never sees a URL, and cannot be talked into creating an
        article for something no source describes. The server answers with the
        same ``{article, movement_id, created}`` shape a catalogue intake does,
        plus ``origin`` — "existing", "catalog", "external" or "manual" — which
        is how the screen knows which sentence to say.

        ``item_name`` is the last resort and only the rack panel has it: that
        screen has a keyboard, and a name somebody typed while holding the box
        is a far better record than a placeholder called "Unbekannt (…)" that
        nobody ever goes back to fix. The server ignores it whenever the
        lookup resolved.

        ``request_id`` identifies one ATTEMPT and is reused verbatim on its
        retries. Booking a delivery is not idempotent, and the two ends of this
        call can disagree about whether it happened: a slow answer times out
        here while the server commits. With the token, the retry replays the
        first answer instead of booking the pallet twice.
        """
        token = (code or "").strip()
        if not token:
            return Result(False, error="Kein Code angegeben.")
        qty = _as_qty(quantity)
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        payload: Dict[str, Any] = {"code": token[:64], "quantity": qty}
        if (item_name or "").strip():
            payload["item_name"] = str(item_name).strip()[:200]
        if (unit or "").strip():
            payload["unit"] = str(unit).strip()[:32]
        if notes:
            payload["notes"] = str(notes)[:500]
        if (request_id or "").strip():
            payload["request_id"] = str(request_id).strip()[:64]
        return self._write(PATHS["from_lookup"], payload,
                           timeout=self.lookup_timeout)

    # -- panels -----------------------------------------------------------

    def panel(self, code: Any) -> Result:
        """The material list of one Verteiler, by its printed number.

        A read that answers a :class:`Result` rather than None, unlike
        :meth:`resolve`: "SMPL does not know this number" (a 404 carrying the
        server's sentence) and "SMPL could not be reached" are different
        things to say on the wall, and only the first may close the session
        that was just opened for it.
        """
        number = _as_panel_code(code)
        if number is None:
            return Result(False, error="Ungültige Verteiler-Nummer.")
        if not self.configured:
            return Result(False, error=NOT_CONFIGURED)
        result = self._request("GET", panel_path(number))
        if result.ok and not isinstance(result.data, dict):
            return Result(False, status=result.status,
                          error="SMPL antwortete nicht mit einer Materialliste.")
        return result

    def panel_scan(self, panel_id: Any, *, code: Optional[str] = None,
                   article_id: Optional[int] = None, quantity: int = 1,
                   notes: Optional[str] = None) -> Result:
        """Book one part as consumption for a Verteiler.

        One of ``code`` / ``article_id``; with both, the id wins, because it
        came back from ``/resolve`` a moment ago and is unambiguous where a
        printed code can carry two articles. The body always carries all four
        contract fields, nulls included — it is the shape the server declares,
        not a shape inferred from what happened to be set.

        The crate cache is deliberately NOT invalidated: a part picked for a
        panel changes no crate, and the box screen has no reason to refetch.
        """
        panel = _as_id(panel_id)
        if panel is None:
            return Result(False, error="Ungültige Verteiler-Nummer.")
        qty = _as_qty(quantity)
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        article: Optional[int] = None
        if article_id is not None:
            article = _as_id(article_id)
            if article is None:
                return Result(False, error="Ungültige Artikel-Nummer.")
        text = code.strip() if isinstance(code, str) else ""
        if article is None and not text:
            return Result(False, error="Weder Code noch Artikel angegeben.")
        payload: Dict[str, Any] = {
            "code": text[:64] if article is None else None,
            "article_id": article,
            "quantity": qty,
            "notes": str(notes)[:500] if notes else None,
        }
        return self._write(panel_scan_path(panel), payload, invalidate=False)

    def panel_undo(self, panel_id: Any, article_id: Any, quantity: int = 1) -> Result:
        """Take back consumption booked for a Verteiler: the inverse row.

        The server refuses more than the net quantity scanned for that article
        on that panel, in a sentence the screen shows verbatim.
        """
        panel = _as_id(panel_id)
        article = _as_id(article_id)
        qty = _as_qty(quantity)
        if panel is None or article is None:
            return Result(False, error="Ungültige Verteiler- oder Artikel-Nummer.")
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        return self._write(panel_undo_path(panel), {"article_id": article, "quantity": qty},
                           invalidate=False)

    def badge_scan(self, code: str, panel_id: Any = None, *,
                   identify_only: bool = False) -> Result:
        """Hand SMPL a scanned badge and the board open here, if any.

        The code goes in the BODY, never the URL: a badge is a bearer
        identifier, and a query string ends up in access logs. Length is
        checked here so a garbled read costs nothing on the network. No crate
        changes, so the crate cache is left alone.

        ``identify_only`` -- the badge answers a refused Ausgabe and is the name
        only -- is sent only when set, and never together with a board: the
        two mean opposite things, and SMPL refuses the pair.
        """
        text = str(code or "").strip().upper()
        if not text or len(text) > 64:
            return Result(False, error="Ungültiger Ausweis.")
        if identify_only and panel_id is not None:
            return Result(False, error="Ausweis: Name oder Verteiler, nicht beides.")
        payload: Dict[str, Any] = {"code": text}
        if identify_only:
            payload["identify_only"] = True
        if panel_id is not None:
            panel = _as_id(panel_id)
            if panel is None:
                return Result(False, error="Ungültiger Verteiler.")
            payload["panel_id"] = panel
        return self._write(PATHS["badge"], payload, invalidate=False)

    # -- consumables at the rack -------------------------------------------

    def consumption(self, article_id: Any, quantity: int = 1, *, assignee_user_id: Any,
                    project_id: Any = None, notes: Optional[str] = None,
                    request_id: Optional[str] = None) -> Result:
        """Book a consumable as used up, for a person and maybe a project.

        The person is required -- here as on the server: "who took it" is the
        one question the row has to answer. ``request_id`` identifies one
        booking attempt; one is minted when the caller has none, and it is
        reused verbatim on the single retry after a dead connection, so an
        answer lost on the way back replays the booking instead of consuming
        the parts twice. A refusal is never retried.
        """
        article = _as_id(article_id)
        qty = _as_qty(quantity)
        assignee = _as_id(assignee_user_id)
        if article is None:
            return Result(False, error="Ungültige Artikel-Nummer.")
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        if assignee is None:
            return Result(False, error="Verbrauch nur mit Namen.")
        project, error = _optional_id(project_id, "Ungültiges Projekt.")
        if error:
            return Result(False, error=error)
        payload: Dict[str, Any] = {
            "article_id": article, "quantity": qty, "assignee_user_id": assignee,
            "project_id": project, "request_id": _request_id(request_id),
            "notes": str(notes)[:500] if notes else None,
        }
        return self._booking(PATHS["consumptions"], payload)

    def consumption_undo(self, article_id: Any, quantity: int = 1, *,
                         assignee_user_id: Any = None, project_id: Any = None,
                         pick_project: bool = False,
                         request_id: Optional[str] = None,
                         undo_of_movement_id: Any = None) -> Result:
        """Take consumed pieces back into stock: an ABBRUCH, or leftovers.

        ``project_id`` names the bucket (None: the one without a project), or
        ``pick_project`` lets SMPL take the bucket the article was last
        consumed into -- the person's own first. Never both: they mean two
        different things, and the server would have to guess which. SMPL
        refuses more than is still consumed there, in a sentence the wall
        shows verbatim.

        With ``pick_project`` SMPL may close an old loan of the article
        instead and answer ``booked_as: "return"`` -- whatever it booked is
        in the answer, and the caller records that, not what it asked for.

        ``undo_of_movement_id`` is for an ABBRUCH only: the ``consumption``
        row being taken back, so SMPL also reverses the stock top-up it
        booked for a short shelf with it. Sent only when given (an SMPL from
        before the field reads the body it always read), and never with
        ``pick_project`` -- leftovers carried back never reverse a top-up.
        """
        article = _as_id(article_id)
        qty = _as_qty(quantity)
        if article is None:
            return Result(False, error="Ungültige Artikel-Nummer.")
        if qty is None:
            return Result(False, error="Ungültige Menge.")
        project, error = _optional_id(project_id, "Ungültiges Projekt.")
        assignee, person_error = _optional_id(assignee_user_id, "Ungültige Benutzer-Nummer.")
        undo_of, undo_error = _optional_id(undo_of_movement_id, "Ungültige Buchungs-Nummer.")
        if error or person_error or undo_error:
            return Result(False, error=error or person_error or undo_error)
        if pick_project and project is not None:
            return Result(False, error="Projekt oder Auswahl durch SMPL, nicht beides.")
        if pick_project and undo_of is not None:
            return Result(False, error="Eine Rückgabe nimmt keine Buchung zurück.")
        payload: Dict[str, Any] = {
            "article_id": article, "quantity": qty, "assignee_user_id": assignee,
            "project_id": project, "pick_project": bool(pick_project),
            "request_id": _request_id(request_id),
        }
        if undo_of is not None:
            payload["undo_of_movement_id"] = undo_of
        return self._booking(PATHS["consumptions_undo"], payload)

    def _booking(self, path: str, payload: Dict[str, Any]) -> Result:
        """POST one booking, retrying a dead connection once under its token."""
        result = self._write(path, payload, invalidate=False)
        if not result.ok and result.status == 0 and self.configured:
            result = self._write(path, payload, invalidate=False)
        if _route_missing(result):
            return Result(False, status=result.status, error=SMPL_OUTDATED)
        return result

    def _write(self, path: str, payload: Dict[str, Any],
               *, timeout: Optional[float] = None, invalidate: bool = True) -> Result:
        if not self.configured:
            return Result(False, error=NOT_CONFIGURED)
        result = self._request("POST", path, payload=payload, timeout=timeout)
        if result.ok and invalidate:
            self.invalidate_boxes()
        return result

    # -- transport --------------------------------------------------------

    def _request(self, method: str, path: str, *, query: Optional[Dict[str, str]] = None,
                 payload: Optional[Dict[str, Any]] = None,
                 timeout: Optional[float] = None) -> Result:
        url = self.base_url + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = urllib.request.Request(url, data=body, method=method)
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", self.user_agent)
        if body is not None:
            request.add_header("Content-Type", "application/json")
        bearer = self.bearer()
        if bearer:
            request.add_header("Authorization", "Bearer %s" % bearer)

        try:
            wait = float(timeout) if timeout else self.timeout
            with urllib.request.urlopen(request, timeout=wait) as handle:  # noqa: S310
                raw = handle.read(MAX_RESPONSE_BYTES)
                status = handle.status
        except urllib.error.HTTPError as exc:
            try:
                raw = exc.read(MAX_RESPONSE_BYTES)
            except Exception:  # noqa: BLE001 - the body is a nicety
                raw = b""
            self._note_auth(exc.code)
            # What the chip on the wall is scored from. A revoked or expired
            # station answers 401 (403: the token is real but not for this
            # route) — every crate request fails and both screens used to stay
            # green, because "below 500" called it a healthy server. It is a
            # healthy server; it is not a working station, and the chip says
            # whether the screens can talk to SMPL.
            #
            # 404 stays green on purpose: on /resolve it means "unknown code",
            # which is an answer, not an outage.
            ok = exc.code not in (401, 403) and exc.code < 500
            self._note(ok, "HTTP %d" % exc.code)
            return Result(False, status=exc.code,
                          error=_message_from(_decode(raw), "SMPL antwortete mit HTTP %d."
                                              % exc.code))
        except Exception as exc:  # noqa: BLE001 - DNS, TLS, timeout, refused
            message = "SMPL ist nicht erreichbar (%s)." % type(exc).__name__
            self._note(False, "%s: %s" % (type(exc).__name__, exc))
            return Result(False, error=message)

        self._note_auth(status)
        self._note(True)
        data = _decode(raw)
        if data is None:
            return Result(False, status=status,
                          error="SMPL antwortete nicht mit JSON.")
        # A list is a perfectly good answer (/boxes returns one), so the
        # payload is carried as-is rather than forced into an envelope.
        return Result(True, data=data, status=status)

    def _note(self, ok: bool, error: str = "") -> None:
        with self._lock:
            self._last_ok = ok
            self._last_error = error

    def _note_auth(self, status: int) -> None:
        if self._on_auth is None:
            return
        try:
            self._on_auth(status)
        except Exception:  # noqa: BLE001 - reporting must not break the request
            pass

    # -- reporting --------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "configured": self.configured,
                "base": self.base_url or None,
                "last_ok": self._last_ok,
                "last_error": self._last_error or None,
                "boxes_cached": self._boxes is not None,
                "boxes_fetched_at": self._boxes_at or None,
                "boxes_error": self._boxes_error,
                "crew_cached": len(self._crew),
                "crew_fetched_at": self._crew_at or None,
                "crew_error": self._crew_error,
                "crew_projects_cached": len(self._crew_projects or {}),
                "crew_projects_fetched_at": self._crew_projects_at or None,
                "crew_projects_error": self._crew_projects_error,
                "token": bool(self.bearer()),
            }


def _decode(raw: bytes) -> Any:
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


def _as_id(value: Any) -> Optional[int]:
    """A positive integer id, or None. Never a string that reaches a URL."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _optional_id(value: Any, message: str):
    """``(id or None, error or None)`` for a field that may be null."""
    if value is None:
        return None, None
    parsed = _as_id(value)
    return (parsed, None) if parsed is not None else (None, message)


def _projects_copy(people: Optional[Dict[int, tuple]]) -> Dict[int, List[Dict[str, Any]]]:
    """A copy a caller may edit without editing the cache."""
    return {user: [dict(project) for project in projects]
            for user, projects in (people or {}).items()}


def _as_panel_code(value: Any) -> Optional[str]:
    """An upper-cased panel number that is safe as a path segment, or None."""
    if not isinstance(value, str):
        return None
    text = value.strip().upper()
    return text if _PANEL_CODE_RE.match(text) else None


def _as_qty(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if 0 < parsed <= MAX_QTY else None
