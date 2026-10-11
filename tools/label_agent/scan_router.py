"""Which screen consumes a scan, and what it should do with it.

The Werkstatt station has two screens and one scanner. The rack screen faces
the storage shelves; the box screen faces the construction crates. There is no
keyboard, no mouse and nobody free to press "OK" — the scanner is the entire
user interface, so *where a scan lands* has to be decided from the scan alone.

This module is that decision and nothing else. It performs no I/O, opens no
sockets, starts no threads and never asks the wall clock what time it is: the
time function is passed in. That is not fastidiousness. "The session closes
itself after ten minutes" is the rule most likely to be wrong and least likely
to be exercised by hand, and injecting the clock is what turns it into a test
that runs in microseconds.

The rules, in the order they are applied:

1. **A command is a command.** ``SMPL-CMD-…`` codes are interpreted before
   anything is looked up, because looking a command up would be a wasted
   network round trip on the one path that must stay under five seconds.
2. **A ``KISTE-`` code opens or switches the box session.** Switching is
   normal — an electrician packing three crates walks between them — and is
   never reported as an error.
3. **A session decides everything else.** With a session open an article
   belongs in the crate; with no session it belongs to the rack.
4. **The session closes itself** after an idle timeout, so a crate left open
   at 17:00 is not still open at 07:00 collecting somebody else's parts.
5. **A machine is not stock.** Scanning a tool during a crate session is
   almost always a wrong-screen mistake, so it is refused in German and
   mirrored to the rack, where it would have been meaningful.
6. **"Mitnehmen" needs an open crate.** It is the one box-screen command that
   books stock, and the codes hang on a wall where anybody can scan one in
   passing, so it names the crate that is open and refuses when none is.
7. **A ``VT-`` code opens a panel session on the rack.** The number off a
   Schrank-Etikett means "the next parts are for this Verteiler": every
   article scanned under it is booked as consumption for that panel, with no
   name and no direction. A panel session and a crate session are mutually
   exclusive — opening one closes the other — and they share the idle rule.
8. **A person and a project are picked by their on-screen codes.** With no
   session open, an Ausgabe of a *consumable* (anything the Maschinen tab
   does not list) is consumption for the person and, when one was picked,
   the project; a tool is still lent out. The codes, and why they are what
   they are, live in ``dispense_codes``. A person code only names somebody in
   the crew the screen offered, a project code only one of that person's
   offered projects -- the router is handed both lists, it never fetches.

The de-duplication window exists because two readers deliver the same scan:
the evdev reader owns the device, but a browser wedge can still be focused
mid-handover, and one physical trigger pull must not count twice. The window
is measured against the moment a scan *arrived*, which is why every entry
point takes an optional ``at``: the caller resolves the code over the network
before it routes, and a 150 ms window judged after a 4 s round trip is not a
window at all.

Three threads drive this object — the kiosk tick, the scanner thread and the
HTTP handlers — and every transition here is a read-modify-write. The module
still imports no threading (see ``tests/test_scan_router.py``: purity is what
keeps the timeout rules testable in microseconds); instead the caller injects
a lock, which ``server.py`` does. The lock must be re-entrant, because a
public read may call another public read.
"""

from __future__ import annotations

import contextlib
import re
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional, Tuple

import dispense_codes as _dc
import kept_requests as _kept
from dispense_codes import (
    CMD_OHNE_PROJEKT,
    KIND_CONSUMABLE,
    KIND_TOOL,
    PARAMETRIC_PREFIXES,
    PERSON_PREFIX,
    PROJECT_PREFIX,
)

__all__ = [
    "ScanRouter",
    "Decision",
    "SessionState",
    "RouterState",
    "COMMAND_CODES",
    "CMD_MITNEHMEN",
    "CODE_ALPHABET",
    "CODE_PREFIX",
    "CODE_LENGTH",
    "BOX_PREFIX",
    "BADGE_PREFIX",
    "CMD_WARENEINGANG",
    "PANEL_PREFIX",
    "PanelSession",
    "EXPIRED_BOX",
    "EXPIRED_PANEL",
    "DIRECTIONS",
    "MSG_NEEDS_ASSIGNEE",
    "MSG_UNKNOWN_PERSON",
    "MSG_PROJECT_NEEDS_PERSON",
    "MSG_PROJECT_NOT_OFFERED",
    "MOVEMENT_REQUIRING_ASSIGNEE",
    "MOVEMENTS_REQUIRING_ASSIGNEE",
    "CMD_OHNE_PROJEKT",
    "KIND_CONSUMABLE",
    "KIND_TOOL",
    "PARAMETRIC_PREFIXES",
    "PERSON_PREFIX",
    "PROJECT_PREFIX",
    "is_internal_article_code",
    "is_box_code",
    "is_badge_code",
    "is_panel_code",
    "normalise_panel_code",
    "movement_needs_assignee",
    "command_for",
]

# --------------------------------------------------------------------------
# The vocabulary
# --------------------------------------------------------------------------

# Transcribed from apps/api/app/services/werkstatt_internal_codes.py. I and O
# are absent on purpose (they read back as 1 and 0 from a 4pt label), and so
# is the hyphen — which is the whole reason a command code can never be
# mistaken for an article: every command has a hyphen after the prefix.
CODE_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"
CODE_PREFIX = "SMPL-"
CODE_LENGTH = 6

_INTERNAL_RE = re.compile(r"^SMPL-[%s]{%d}$" % (CODE_ALPHABET, CODE_LENGTH))

BOX_PREFIX = "KISTE-"

# A person's own badge: ``SMPL-P-`` and ten characters, minted by SMPL
# (apps/api/app/services/station_badges.py). Recognised by its prefix, like a
# crate or a panel, and for the same reason: the hyphen after ``P`` means no
# article code (``SMPL-`` + six, no hyphen) and no command (``SMPL-CMD-...``)
# can ever look like one, so it is classified before anything goes over the
# network -- and never sent to /resolve, which answers for things, not people.
BADGE_PREFIX = "SMPL-P-"

# A Verteiler's number as printed on its Schrank-Etikett: ``VT-0007``. The
# station recognises the prefix itself — SMPL's /resolve answers not_found for
# it, exactly as for a crate code — and asks for the panel's material list
# instead. A scanned or typed number is normalised the way the server does it
# (``VT-7`` → ``VT-0007``, ``vt0007`` → ``VT-0007``) so a rescan of the same
# panel in another spelling is a rescan and not a switch.
PANEL_PREFIX = "VT-"
PANEL_NUMBER_WIDTH = 4
_PANEL_RE = re.compile(r"^VT-?(\d+)$")

#: What :meth:`ScanRouter.tick` answers when it closed something.
EXPIRED_BOX = "box"
EXPIRED_PANEL = "panel"

CMD_FERTIG = "SMPL-CMD-FERTIG"
CMD_ABBRUCH = "SMPL-CMD-ABBRUCH"
CMD_MENGE_5 = "SMPL-CMD-MENGE-5"
CMD_MENGE_10 = "SMPL-CMD-MENGE-10"
CMD_MENGE_50 = "SMPL-CMD-MENGE-50"
CMD_EIN = "SMPL-CMD-EIN"
CMD_AUS = "SMPL-CMD-AUS"
# The third direction, which had no code: Ausgabe and Rückgabe could be
# scanned off the wall, Wareneingang only clicked. The rack screen now shows
# all three, so the mouse is not needed to change direction at all.
CMD_WARENEINGANG = "SMPL-CMD-WARENEINGANG"
CMD_ENTNAHME = "SMPL-CMD-ENTNAHME"
# "Mitnehmen": the packed crate on the screen is being carried out now. The one
# command that books stock from the box screen, which is why it needs an open
# session and is refused without one rather than guessing which crate is meant.
CMD_MITNEHMEN = "SMPL-CMD-MITNEHMEN"

COMMAND_CODES: Tuple[str, ...] = (
    CMD_FERTIG,
    CMD_ABBRUCH,
    CMD_MENGE_5,
    CMD_MENGE_10,
    CMD_MENGE_50,
    CMD_EIN,
    CMD_AUS,
    CMD_WARENEINGANG,
    CMD_ENTNAHME,
    CMD_MITNEHMEN,
    # The one static code of the Ausgabe picker: "no project, please". The
    # person and project codes carry a number and are matched by prefix
    # (PARAMETRIC_PREFIXES), so they are deliberately not in this tuple.
    CMD_OHNE_PROJEKT,
)

_MENGE = {CMD_MENGE_5: 5, CMD_MENGE_10: 10, CMD_MENGE_50: 50}

RACK = "regal"
BOXES = "kisten"

DEFAULT_IDLE_TIMEOUT_S = 600.0
DEFAULT_DEDUPE_WINDOW_S = 0.150
# A name tapped on the rack screen is a claim about who is standing there, and
# that claim goes stale fast. Two minutes is long enough to fetch three items
# off the shelf and short enough that the next person does not book onto it.
DEFAULT_ASSIGNEE_TIMEOUT_S = 120.0

#: How long after the rack refused an Ausgabe for want of a name a badge scan
#: counts as the answer -- the name, and nothing else. Without that window a
#: person clocked onto a Verteiler who answers "who is this for?" with their
#: badge would be clocked OUT, because a badge with no board open means
#: "I am done" to SMPL. A minute covers fishing the badge out of a pocket.
NAME_WAIT_S = 60.0

#: See kept_requests: how long, and how many, tokens of unanswered bookings
#: are held for a re-scan of the same thing.
KEEP_REQUEST_ID_S = _kept.KEEP_REQUEST_ID_S
MAX_KEPT_REQUEST_IDS = _kept.MAX_KEPT_REQUEST_IDS

# Which movement a rack scan means, given the direction the operator set.
# Three directions, not two: taking something out, bringing a borrowed thing
# back, and new stock arriving from a supplier are three different ledger
# entries, and the workshop books all three at the same shelf.
_DIRECTION_MOVEMENT = {"aus": "checkout", "ein": "return", "wareneingang": "intake"}

#: The directions ``set_direction`` and ``/screen/action`` accept.
DIRECTIONS: Tuple[str, ...] = tuple(_DIRECTION_MOVEMENT)

#: Directions whose booking may name the person it is booked onto. A
#: Wareneingang belongs to the warehouse, never to a worker.
_DIRECTIONS_WITH_ASSIGNEE = ("aus", "ein")

#: The one direction that *requires* one: "who has the drill" is unanswerable
#: if a checkout may be anonymous.
_DIRECTION_REQUIRING_ASSIGNEE = "aus"

#: The movement that may never be anonymous, derived from the direction rule
#: rather than spelled twice. Published because the rack scan is not the only
#: door onto the ledger — ``POST /rack/movement`` is another, and an undo can
#: produce a checkout nobody scanned — and a rule with two copies is a rule
#: with two behaviours.
MOVEMENT_REQUIRING_ASSIGNEE = _DIRECTION_MOVEMENT[_DIRECTION_REQUIRING_ASSIGNEE]

#: Every movement that may never be anonymous: the loan above, and a
#: consumable used up -- SMPL books it onto the person who took it, and so does
#: the consumption an ABBRUCH re-creates when it takes back a Rückgabe.
_CONSUMPTION = "consumption"
_CONSUMPTION_UNDO = "consumption_undo"
MOVEMENTS_REQUIRING_ASSIGNEE: Tuple[str, ...] = (MOVEMENT_REQUIRING_ASSIGNEE, _CONSUMPTION)
_INVERSE_CONSUMPTION = {_CONSUMPTION: _CONSUMPTION_UNDO, _CONSUMPTION_UNDO: _CONSUMPTION}

# Undoing a movement means posting its opposite; SMPL has no "delete a
# movement" and should not grow one, because a ledger you can delete from is
# not a ledger. An intake has no opposite that is not a lie about where the
# stock went, so it is refused rather than guessed.
# The inventory_* pair used to be here. SMPL does not accept either from a
# station (STATION_MOVEMENT_TYPES: checkout, return, intake), so describing an
# inverse we cannot post only turned "Abbruch nicht möglich" into "Abbruch
# fehlgeschlagen" one round trip later.
_INVERSE_MOVEMENT = {
    "checkout": "return",
    "return": "checkout",
}

#: Movements that close somebody's loan, and therefore want the name the
#: original booking carried.
_RETURNS_A_LOAN = ("return",)

MSG_MACHINE_IN_SESSION = (
    "Maschinen gehören nicht in eine Kiste. Der Scan wurde ans Regal "
    "geschickt — Kiste bleibt offen."
)
MSG_MACHINE_IN_PANEL = (
    "Maschinen gehören nicht in einen Verteiler. Nichts gebucht — "
    "Verteiler bleibt offen."
)
MSG_NO_INVERSE = (
    "Ein Wareneingang lässt sich nicht per Abbruch zurücknehmen. Bitte in "
    "SMPL korrigieren."
)
#: Shown, in these words, when somebody scans a checkout with no name tapped.
#: It is a refusal, not a warning: nothing is written.
MSG_NEEDS_ASSIGNEE = "Bitte Namen antippen oder Ausweis scannen"
#: A person code for somebody the screen never offered (or a garbled one).
MSG_UNKNOWN_PERSON = "Diese Person steht nicht in der Namensliste."
#: A project code with nobody picked: a project is chosen FOR somebody.
MSG_PROJECT_NEEDS_PERSON = "Erst den Namen wählen, dann das Projekt."
#: A project that is not one of the tiles offered for the person picked.
MSG_PROJECT_NOT_OFFERED = "Dieses Projekt steht für diese Person nicht zur Auswahl."


def is_internal_article_code(code: str) -> bool:
    """True for a code SMPL itself minted for an article.

    Deliberately strict: prefix, then exactly six characters from an alphabet
    with no hyphen in it. Every command code fails this test on the hyphen
    alone, which is what makes the two namespaces safe to share a prefix.
    """
    return bool(_INTERNAL_RE.match((code or "").strip().upper()))


def movement_needs_assignee(movement_type: str, assignee_user_id: Any) -> bool:
    """True when this booking would be an Ausgabe with nobody's name on it.

    The one rule, in one place, for every door onto the ledger: the rack scan,
    ``POST /rack/movement``, and the checkout (or consumption) an ABBRUCH
    re-creates when it takes back a Rückgabe.
    """
    return (movement_type in MOVEMENTS_REQUIRING_ASSIGNEE
            and _as_user_id({"id": assignee_user_id}) is None)


def command_for(code: str) -> Optional[str]:
    """The canonical command name for a scan, or None if it is not a command."""
    normalised = (code or "").strip().upper()
    return normalised if normalised in COMMAND_CODES else None


def is_badge_code(code: str) -> bool:
    """A person's badge, by prefix. What follows is SMPL's to judge."""
    return (code or "").strip().upper().startswith(BADGE_PREFIX)


def is_box_code(code: str) -> bool:
    return (code or "").strip().upper().startswith(BOX_PREFIX)


def is_panel_code(code: str) -> bool:
    """True for a Verteiler number: ``VT-`` plus anything, or ``VT`` plus digits.

    The loose second form exists because a scanner in the wrong keyboard
    layout can lose the hyphen. What follows the prefix is not judged here:
    ``VT-ABC`` is a panel code the server refuses with a sentence, which is a
    better answer than sending it through /resolve and calling it an article.
    """
    upper = (code or "").strip().upper()
    return upper.startswith(PANEL_PREFIX) or _PANEL_RE.match(upper) is not None


def normalise_panel_code(code: str) -> Optional[str]:
    """``VT-7`` → ``VT-0007``; None for something that is not a panel code."""
    upper = (code or "").strip().upper()
    if not is_panel_code(upper):
        return None
    match = _PANEL_RE.match(upper)
    if match is None:
        return upper
    return PANEL_PREFIX + str(int(match.group(1))).zfill(PANEL_NUMBER_WIDTH)


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionState:
    """An open box-filling session. Frozen; a change makes a new one."""

    code: str
    box_number: str
    opened_at: float
    last_at: float

    def as_dict(self, *, idle_timeout_s: float) -> Dict[str, Any]:
        return {
            "code": self.code,
            "box_number": self.box_number,
            "opened_at": self.opened_at,
            "expires_at": self.last_at + idle_timeout_s,
        }


@dataclass(frozen=True)
class PanelSession:
    """An open picking session for one Verteiler. Frozen; a change makes a new one.

    ``panel_id`` and ``number`` are what the server answered when the list was
    fetched; until then the id is None and the number is the scanned code.
    """

    code: str
    panel_id: Optional[int]
    number: str
    opened_at: float
    last_at: float

    def as_dict(self, *, idle_timeout_s: float) -> Dict[str, Any]:
        return {
            "code": self.code,
            "panel_id": self.panel_id,
            "number": self.number,
            "opened_at": self.opened_at,
            "expires_at": self.last_at + idle_timeout_s,
        }


@dataclass(frozen=True)
class LastAction:
    """What the last commit did, so ``ABBRUCH`` knows what to take back.

    ``box_code`` is the crate that was open when the line was written. Without
    it an undo after a crate switch takes a line out of the *wrong* crate —
    the operator sees "zurückgenommen" and the parts silently move between two
    jobs.
    """

    screen: str
    action: str
    box_id: Optional[int] = None
    item_id: Optional[int] = None
    article_id: Optional[int] = None
    movement_type: str = ""
    qty: int = 1
    box_code: Optional[str] = None
    assignee_user_id: Optional[int] = None
    #: The panel a ``panel_item`` was booked for — same reasoning as
    #: ``box_code``: a booking is only undone into the panel it was made in.
    panel_code: Optional[str] = None
    panel_id: Optional[int] = None
    #: The project bucket a rack ``consumption`` went into (None = without
    #: one) -- the one its ABBRUCH takes it back out of, whatever project is
    #: picked by the time somebody scans it.
    project_id: Optional[int] = None
    #: The idempotency token the undo of this booking is posted with, minted
    #: by the caller once per booking: a second ABBRUCH after an answer was
    #: lost replays the first undo instead of taking the parts back twice.
    undo_request_id: Optional[str] = None
    #: The ledger row SMPL answered the booking with (on a replay too). The
    #: ABBRUCH of a rack ``consumption`` names it, so SMPL can also reverse
    #: the top-up it booked for a short shelf with exactly that consumption.
    movement_id: Optional[int] = None


@dataclass(frozen=True)
class RouterState:
    """Everything the router remembers, as one immutable value."""

    session: Optional[SessionState] = None
    # The open Verteiler, if any. Never set at the same time as ``session``.
    panel: Optional[PanelSession] = None
    mode: str = "add"
    direction: str = "aus"
    pending_qty: int = 1
    pending_article: Optional[Dict[str, Any]] = None
    pending_article_qty: int = 1
    last_code: str = ""
    last_at: float = 0.0
    last_actions: Dict[str, LastAction] = field(default_factory=dict)
    # Who tapped their name on the rack screen, as ``{"id", "name"}``, and
    # when the tap (or the last scan under it) happened.
    assignee: Optional[Dict[str, Any]] = None
    assignee_at: float = 0.0
    # When the rack last refused an Ausgabe (or the undo of a Rückgabe) for
    # want of a name; 0.0 when no such question is open. See NAME_WAIT_S.
    name_wanted_at: float = 0.0
    # The project picked for the Ausgabe, as ``{"id", "project_number",
    # "name"}``. ``project_chosen`` with ``project`` None is the explicit
    # "ohne Projekt"; both unset means nobody has chosen yet. Goes with the
    # name: a different person, an expired name or FERTIG clears it.
    project: Optional[Dict[str, Any]] = None
    project_chosen: bool = False
    # What the screen offered, as the agent last fetched it: the crew (the
    # only people a scanned person code may name) and each person's projects
    # (the only projects a project code may pick). Handed in, never fetched.
    crew: Tuple[Dict[str, Any], ...] = ()
    crew_projects: Dict[int, Tuple[Dict[str, Any], ...]] = field(default_factory=dict)
    # Tokens of bookings that got no answer, oldest first. Not staged state:
    # routing the re-scan clears the staged article, never these.
    kept_request_ids: Tuple[_kept.KeptRequestId, ...] = ()


@dataclass(frozen=True)
class Decision:
    """What one scan means. Purely descriptive — the caller does the work."""

    code: str
    screen: Optional[str] = None
    action: str = "ignored"
    ok: bool = True
    error: Optional[str] = None
    source: str = "wedge"
    kind: Optional[str] = None
    duplicate: bool = False
    qty: int = 1
    movement_type: Optional[str] = None
    box_code: Optional[str] = None
    box_number: Optional[str] = None
    previous_code: Optional[str] = None
    session_expired: bool = False
    undo: Optional[Dict[str, Any]] = None
    #: Who the booking is for. Set for "aus" and "ein", never for a
    #: Wareneingang, and never guessed by the caller.
    assignee_user_id: Optional[int] = None
    #: The Verteiler this decision is about (normalised, ``VT-0007``).
    panel_code: Optional[str] = None
    #: For a badge scan: the board open at the rack, as SMPL numbered it, or
    #: None. Carried on the decision rather than read back from the router at
    #: apply time, because three threads reach the router in between.
    panel_id: Optional[int] = None
    #: Opening a panel closed a crate session, or the other way round. Said
    #: here so the caller can tell the other screen what just happened to it.
    closed_box: bool = False
    closed_panel: bool = False
    #: Like ``session_expired``, for the panel: it timed out just before this
    #: scan, and the scan was routed as if it had never been open.
    panel_expired: bool = False
    #: For a badge scan: it answers a refused Ausgabe, so SMPL is asked for the
    #: name only and must not clock anybody in or out (see NAME_WAIT_S).
    identify_only: bool = False
    #: The project a consumption is booked to, or taken back from (None =
    #: without one). For ``select_project``, what was picked.
    project_id: Optional[int] = None
    #: A Rückgabe of a consumable with no project picked: SMPL takes it back
    #: from the bucket it was most recently consumed into.
    pick_project: bool = False

    def as_dict(self) -> Dict[str, Any]:
        return {
            "code": self.code,
            "screen": self.screen,
            "action": self.action,
            "ok": self.ok,
            "error": self.error,
            "source": self.source,
            "kind": self.kind,
            "duplicate": self.duplicate,
            "qty": self.qty,
            "movement_type": self.movement_type,
            "box_code": self.box_code,
            "box_number": self.box_number,
            "previous_code": self.previous_code,
            "session_expired": self.session_expired,
            "undo": dict(self.undo) if self.undo else None,
            "assignee_user_id": self.assignee_user_id,
            "panel_code": self.panel_code,
            "panel_id": self.panel_id,
            "closed_box": self.closed_box,
            "closed_panel": self.closed_panel,
            "panel_expired": self.panel_expired,
            "identify_only": self.identify_only,
            "project_id": self.project_id,
            "pick_project": self.pick_project,
        }


# --------------------------------------------------------------------------
# The router
# --------------------------------------------------------------------------


class ScanRouter:
    """The scan-routing state machine.

    Drive it with :meth:`route`; ask it what it knows with :meth:`snapshot`.
    Every transition replaces :attr:`state` with a new frozen value rather
    than editing the old one, so a caller holding a snapshot keeps holding
    exactly what it read.

    Every public method takes ``lock`` for the whole of its transition. The
    default is a no-op, which is correct for a single-threaded caller and for
    every test in this file; ``server.py`` passes a real ``threading.RLock``
    because three of its threads reach this object. It must be *re-entrant*:
    :meth:`snapshot` is a public read that calls other public reads.
    """

    def __init__(self, *, clock: Callable[[], float],
                 idle_timeout_s: float = DEFAULT_IDLE_TIMEOUT_S,
                 dedupe_window_s: float = DEFAULT_DEDUPE_WINDOW_S,
                 assignee_timeout_s: float = DEFAULT_ASSIGNEE_TIMEOUT_S,
                 lock: Optional[Any] = None) -> None:
        if clock is None:
            raise ValueError("scan_router needs an explicit time function")
        self._clock = clock
        self.idle_timeout_s = float(idle_timeout_s)
        self.dedupe_window_s = float(dedupe_window_s)
        self.assignee_timeout_s = float(assignee_timeout_s)
        self._lock = contextlib.nullcontext() if lock is None else lock
        self._state = RouterState()

    # -- read-only views --------------------------------------------------

    @property
    def state(self) -> RouterState:
        with self._lock:
            return self._state

    @property
    def session(self) -> Optional[SessionState]:
        with self._lock:
            return self._state.session

    @property
    def panel(self) -> Optional[PanelSession]:
        with self._lock:
            return self._state.panel

    @property
    def mode(self) -> str:
        with self._lock:
            return self._state.mode

    @property
    def direction(self) -> str:
        with self._lock:
            return self._state.direction

    @property
    def pending_qty(self) -> int:
        with self._lock:
            return self._state.pending_qty

    @property
    def pending_article(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._state.pending_article

    @property
    def assignee(self) -> Optional[Dict[str, Any]]:
        """Who is standing at the rack, as ``{"id", "name"}``, or None."""
        with self._lock:
            assignee = self._state.assignee
            return dict(assignee) if assignee else None

    @property
    def assignee_id(self) -> Optional[int]:
        with self._lock:
            return _as_user_id(self._state.assignee)

    @property
    def project(self) -> Optional[Dict[str, Any]]:
        """The project picked for the Ausgabe, or None (see project_chosen)."""
        with self._lock:
            project = self._state.project
            return dict(project) if project else None

    @property
    def project_chosen(self) -> bool:
        """True once a project -- or "ohne Projekt" -- has been picked."""
        with self._lock:
            return self._state.project_chosen

    @property
    def crew(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [dict(person) for person in self._state.crew]

    def offered_projects(self, user_id: Optional[int] = None) -> List[Dict[str, Any]]:
        """The project tiles for this person (default: the one picked), or []."""
        with self._lock:
            ident = user_id if user_id is not None else _as_user_id(self._state.assignee)
            if ident is None:
                return []
            return [dict(project) for project in self._state.crew_projects.get(ident, ())]

    def selection(self) -> Dict[str, Any]:
        """The Ausgabe picker's part of the rack screen's state."""
        with self._lock:
            state = self._state
            person = _as_user_id(state.assignee)
            offered = state.crew_projects.get(person, ()) if person is not None else ()
            return {
                "projects": [dict(project) for project in offered],
                "project": dict(state.project) if state.project else None,
                "project_chosen": state.project_chosen,
            }

    @property
    def active_screen(self) -> str:
        with self._lock:
            return BOXES if self._state.session is not None else RACK

    def seconds_remaining(self) -> Optional[int]:
        """Whole seconds until the session closes itself, for the countdown."""
        with self._lock:
            session = self._state.session
            if session is None:
                return None
            left = (session.last_at + self.idle_timeout_s) - self._clock()
            return max(0, int(left))

    def needs_resolution(self, code: str) -> bool:
        """True when the caller must ask SMPL what this code is.

        Commands, crate codes and panel numbers are self-describing, and
        asking about them would put a network round trip in front of "close
        the session" — or, for a panel, in front of the one request that
        actually answers (``GET /panels/{code}``).
        """
        text = (code or "").strip()
        if not text:
            return False
        return (command_for(text) is None and not is_box_code(text)
                and not is_panel_code(text) and not is_badge_code(text)
                and not _dc.is_selection_code(text))

    def snapshot(self) -> Dict[str, Any]:
        """A JSON-shaped view for /health and the screen state."""
        with self._lock:
            state = self._state
            return {
                "session": (state.session.as_dict(idle_timeout_s=self.idle_timeout_s)
                            if state.session else None),
                "panel": (state.panel.as_dict(idle_timeout_s=self.idle_timeout_s)
                          if state.panel else None),
                "seconds_remaining": self.seconds_remaining() or 0,
                "mode": state.mode,
                "direction": state.direction,
                "pending_qty": state.pending_qty,
                "pending_article": state.pending_article,
                "pending_article_qty": state.pending_article_qty,
                "active_screen": self.active_screen,
                "idle_timeout_s": self.idle_timeout_s,
                "assignee": dict(state.assignee) if state.assignee else None,
                "assignee_timeout_s": self.assignee_timeout_s,
                "project": dict(state.project) if state.project else None,
                "project_chosen": state.project_chosen,
            }

    def pending(self) -> Optional[Dict[str, Any]]:
        """The contract's ``pending`` object: an article, a quantity, or null."""
        with self._lock:
            state = self._state
            if state.pending_article is not None:
                return {"article": state.pending_article, "qty": state.pending_article_qty}
            if state.pending_qty != 1:
                return {"article": None, "qty": state.pending_qty}
            return None

    def is_duplicate(self, code: str, at: Optional[float] = None) -> bool:
        """True when this scan is the echo of the one before it.

        Public so the caller can drop an echo *before* it pays for a network
        resolve — the window is 150 ms and a resolve is allowed four seconds.
        """
        with self._lock:
            text = (code or "").strip()
            if not text:
                return False
            now = self._clock() if at is None else float(at)
            return self._is_duplicate(text.upper(), now)

    # -- state the caller reports back ------------------------------------

    def note_pending(self, article: Optional[Dict[str, Any]], qty: int = 1) -> None:
        """Remember an article that was staged but not accepted by SMPL."""
        with self._lock:
            self._state = replace(
                self._state,
                pending_article=dict(article) if article else None,
                pending_article_qty=max(1, int(qty)),
            )

    def note_commit(self, *, screen: str, action: str, box_id: Optional[int] = None,
                    item_id: Optional[int] = None, article_id: Optional[int] = None,
                    movement_type: str = "", qty: int = 1,
                    box_code: Optional[str] = None,
                    assignee_user_id: Optional[int] = None,
                    panel_code: Optional[str] = None,
                    panel_id: Optional[int] = None,
                    project_id: Optional[int] = None,
                    undo_request_id: Optional[str] = None,
                    movement_id: Optional[int] = None) -> None:
        """Record a commit SMPL accepted, so ``ABBRUCH`` can take it back.

        The crate is stamped from the open session unless the caller names
        one, so a line written into crate A can never be undone out of crate B.
        A ``panel_item`` is stamped with its Verteiler the same way, and a rack
        ``consumption`` with the project bucket SMPL booked it into and the
        row SMPL answered with.
        """
        with self._lock:
            state = self._state
            actions = dict(state.last_actions)
            if box_code is None and state.session is not None:
                box_code = state.session.code
            if panel_code is None and state.panel is not None:
                panel_code = state.panel.code
                if panel_id is None:
                    panel_id = state.panel.panel_id
            actions[screen] = LastAction(
                screen=screen, action=action, box_id=box_id, item_id=item_id,
                article_id=article_id, movement_type=movement_type,
                qty=max(1, int(qty)), box_code=box_code,
                assignee_user_id=assignee_user_id,
                panel_code=panel_code, panel_id=panel_id,
                project_id=_as_user_id({"id": project_id}),
                undo_request_id=undo_request_id or None,
                movement_id=_as_user_id({"id": movement_id}),
            )
            self._state = replace(state, last_actions=actions,
                                  pending_article=None, pending_article_qty=1)

    def confirm_undo(self, screen: str) -> None:
        """Forget the undo record — only once SMPL accepted the inverse.

        A failed undo keeps its record: one ABBRUCH during a network blip must
        not cost the operator the ability to undo at all.
        """
        with self._lock:
            actions = dict(self._state.last_actions)
            if actions.pop(screen, None) is not None:
                self._state = replace(self._state, last_actions=actions)

    def keep_request_id(self, key: Tuple[Any, ...], request_id: str,
                        at: Optional[float] = None) -> None:
        """Hold the token of a booking SMPL never answered (see kept_requests).

        A re-scan of the same thing gets it back from :meth:`kept_request_id`,
        so SMPL replays the booking if it landed instead of booking it twice.
        """
        with self._lock:
            now = self._clock() if at is None else float(at)
            self._state = replace(self._state, kept_request_ids=_kept.keep(
                self._state.kept_request_ids, key, request_id, now))

    def kept_request_id(self, key: Tuple[Any, ...],
                        at: Optional[float] = None) -> Optional[str]:
        """The held token for exactly this booking, or None."""
        with self._lock:
            now = self._clock() if at is None else float(at)
            return _kept.kept(self._state.kept_request_ids, key, now)

    def drop_request_id(self, key: Tuple[Any, ...]) -> None:
        """SMPL answered this booking -- booked, replayed or refused it."""
        with self._lock:
            held = self._state.kept_request_ids
            kept = _kept.drop(held, key)
            if kept != held:
                self._state = replace(self._state, kept_request_ids=kept)

    def close_session(self) -> None:
        """Close the session from outside — the screen's own close button."""
        with self._lock:
            self._state = replace(self._state, session=None, mode="add")

    def open_session(self, code: str) -> None:
        """Open or switch a session from outside — the screen's box picker."""
        with self._lock:
            self._decide_box(self._normalise(code), "wedge", self._clock())

    def close_panel(self) -> None:
        """Close the panel session from outside — the Fertig button, or a
        server that does not know the number."""
        with self._lock:
            self._state = replace(self._state, panel=None)

    def note_panel(self, panel_id: Optional[int], number: Optional[str] = None) -> None:
        """Record what SMPL said the open panel is. No-op with none open."""
        with self._lock:
            panel = self._state.panel
            if panel is None:
                return
            self._state = replace(self._state, panel=replace(
                panel, panel_id=_as_user_id({"id": panel_id}),
                number=(number or "").strip().upper() or panel.number,
            ))

    def set_direction(self, direction: str) -> None:
        with self._lock:
            if direction in _DIRECTION_MOVEMENT:
                self._state = replace(self._state, direction=direction, name_wanted_at=0.0)

    def set_assignee(self, person: Optional[Dict[str, Any]], at: Optional[float] = None) -> None:
        """Tap a name, or clear it. ``person`` is ``{"id", "name"}`` or None.

        A different person -- or none -- takes the picked project with it: it
        was picked for the one standing here before.
        """
        with self._lock:
            now = self._clock() if at is None else float(at)
            self._state = self._with_assignee(self._state, person, now)

    @staticmethod
    def _with_assignee(state: RouterState, person: Optional[Dict[str, Any]],
                       now: float) -> RouterState:
        ident = _as_user_id(person) if person is not None else None
        if ident is None:
            return replace(state, assignee=None, assignee_at=0.0,
                           project=None, project_chosen=False)
        keep = _as_user_id(state.assignee) == ident
        return replace(
            state,
            assignee={"id": ident, "name": person.get("name")},
            assignee_at=now,
            name_wanted_at=0.0,
            project=state.project if keep else None,
            project_chosen=state.project_chosen if keep else False,
        )

    def set_crew(self, people: Any) -> None:
        """The names the screen offers -- the only ones a person code may pick."""
        with self._lock:
            self._state = replace(self._state, crew=_dc.clean_crew(people))

    def set_crew_projects(self, people_projects: Any) -> bool:
        """Each person's project tiles, ``{user_id: [project, ...]}``.

        True when anything changed, so the caller wakes the screen only then.
        A project already picked stays picked even if the new list no longer
        offers it: it was valid when the person chose it, and it goes with
        their name.
        """
        with self._lock:
            cleaned = _dc.clean_project_mapping(people_projects)
            if cleaned == self._state.crew_projects:
                return False
            self._state = replace(self._state, crew_projects=cleaned)
            return True

    def select_project(self, project_id: Optional[int],
                       at: Optional[float] = None) -> Optional[str]:
        """Tap a project tile (None: "ohne Projekt"). The refusal, or None."""
        with self._lock:
            now = self._clock() if at is None else float(at)
            state, error = self._picked_project(self._state, project_id, now)
            self._state = state
            return error

    def clear_project(self) -> None:
        """Back to the project tiles -- "Projekt ändern"."""
        with self._lock:
            self._state = replace(self._state, project=None, project_chosen=False)

    def _picked_project(self, state: RouterState, project_id: Optional[int],
                        now: float) -> Tuple[RouterState, Optional[str]]:
        """The one rule for a project pick, tapped or scanned."""
        person = _as_user_id(state.assignee)
        if person is None:
            return state, MSG_PROJECT_NEEDS_PERSON
        if project_id is None:
            return replace(state, project=None, project_chosen=True, assignee_at=now), None
        project = _dc.offered(state.crew_projects.get(person, ()), project_id)
        if project is None:
            return state, MSG_PROJECT_NOT_OFFERED
        return replace(state, project=_dc.project_ref(project), project_chosen=True,
                       assignee_at=now), None

    def set_mode(self, mode: str) -> None:
        with self._lock:
            if mode in ("add", "remove"):
                self._state = replace(self._state, mode=mode)

    def set_qty(self, qty: int) -> None:
        with self._lock:
            self._state = replace(self._state, pending_qty=max(1, min(9999, int(qty))))

    def clear_pending(self) -> None:
        with self._lock:
            self._state = replace(self._state, pending_article=None, pending_article_qty=1)

    # -- the clock --------------------------------------------------------

    def tick(self) -> Optional[str]:
        """Expire an idle session. Names what it closed — :data:`EXPIRED_BOX`
        or :data:`EXPIRED_PANEL` — and None when nothing was due. Truthy
        exactly when something closed, so ``if router.tick():`` still reads.
        """
        with self._lock:
            return self._expire(self._clock())

    def expire_assignee(self) -> bool:
        """Drop a name nobody has scanned under. True when this call did."""
        with self._lock:
            state = self._state
            if state.assignee is None:
                return False
            if self._clock() - state.assignee_at <= self.assignee_timeout_s:
                return False
            self._state = replace(state, assignee=None, assignee_at=0.0,
                                  project=None, project_chosen=False)
            return True

    def _expire(self, now: float) -> Optional[str]:
        state = self._state
        session = state.session
        if session is not None and now - session.last_at > self.idle_timeout_s:
            self._state = replace(state, session=None, mode="add")
            return EXPIRED_BOX
        panel = state.panel
        if panel is not None and now - panel.last_at > self.idle_timeout_s:
            self._state = replace(state, panel=None)
            return EXPIRED_PANEL
        return None

    @staticmethod
    def _expiry_fields(expired: Optional[str]) -> Dict[str, bool]:
        """The two ``Decision`` flags one expiry answer turns into."""
        return {"session_expired": expired == EXPIRED_BOX,
                "panel_expired": expired == EXPIRED_PANEL}

    # -- routing ----------------------------------------------------------

    def route(self, code: str, *, source: str = "wedge",
              kind: Optional[str] = None, at: Optional[float] = None) -> Decision:
        """Decide what one scan means, and advance the state machine.

        ``at`` is when the scan *arrived*. The caller resolves an unknown code
        over the network before it routes, so judging the de-dupe window at
        the moment ``route`` is finally called would measure the round trip
        instead of the scanner, and one trigger pull would book stock twice.
        """
        with self._lock:
            text = (code or "").strip()
            if not text:
                return Decision(code="", action="ignored", source=source,
                                screen=self.active_screen)

            now = self._clock() if at is None else float(at)
            upper = text.upper()

            # One trigger pull, two readers. Dropping the echo changes nothing
            # at all — not the idle countdown, not the session, not the qty.
            if self._is_duplicate(upper, now):
                return Decision(code=text, action="ignored", source=source, kind=kind,
                                duplicate=True, screen=self.active_screen)

            expired = self._expire(now)
            self._state = replace(self._state, last_code=upper, last_at=now)
            # Every accepted scan is proof somebody is standing here — a
            # command as much as an article. Refreshing the idle clocks per
            # branch used to close a crate under an operator who was
            # demonstrably still scanning, and book the next part to the rack.
            self._touch(now)

            command = command_for(upper)
            if command is not None:
                return self._decide_command(command, text, source, now, expired)

            selection = _dc.selection_of(upper)
            if selection is not None:
                decision = self._decide_selection(selection, upper, source, now)
                return replace(decision, **self._expiry_fields(expired))

            if is_badge_code(upper):
                decision = self._decide_badge(text, source, now)
                return replace(decision, **self._expiry_fields(expired))

            if is_box_code(upper):
                decision = self._decide_box(upper, source, now)
                return replace(decision, **self._expiry_fields(expired))

            if is_panel_code(upper):
                decision = self._decide_panel(upper, source, now)
                return replace(decision, **self._expiry_fields(expired))

            return self._decide_article(text, kind, source, now, expired)

    def _touch(self, now: float) -> None:
        """Push the idle deadlines out; the scan itself is the activity."""
        state = self._state
        session = state.session
        if session is not None:
            state = replace(state, session=replace(session, last_at=now))
        if state.panel is not None:
            state = replace(state, panel=replace(state.panel, last_at=now))
        if state.assignee is not None:
            state = replace(state, assignee_at=now)
        self._state = state

    # -- the three kinds of scan ------------------------------------------

    def _decide_command(self, command: str, text: str, source: str, now: float,
                        expired: Optional[str]) -> Decision:
        state = self._state
        base = dict(code=text, source=source, **self._expiry_fields(expired))

        if command == CMD_FERTIG:
            if state.panel is not None:
                # The two sessions are exclusive, so "fertig" can only mean
                # the one that is open — and this one is on the rack.
                previous = state.panel.code
                self._state = replace(state, panel=None)
                return Decision(screen=RACK, action="close_panel",
                                panel_code=previous, previous_code=previous, **base)
            if state.assignee is not None or state.project_chosen:
                # Next in line: the Ausgabe somebody is in the middle of at
                # the rack. "Fertig" ends it -- name and project go -- so the
                # next person to walk up starts from the name tiles. A crate
                # open behind it needs a second FERTIG.
                person = _as_user_id(state.assignee)
                self._state = self._with_assignee(state, None, now)
                return Decision(screen=RACK, action="close_selection",
                                assignee_user_id=person, **base)
            previous = state.session.code if state.session else None
            self._state = replace(state, session=None, mode="add")
            return Decision(screen=BOXES, action="close_session",
                            previous_code=previous, **base)

        if command == CMD_ABBRUCH:
            return self._decide_undo(text, source, now, expired)

        if command in _MENGE:
            qty = _MENGE[command]
            self._state = replace(state, pending_qty=qty)
            return Decision(screen=self.active_screen, action="qty", qty=qty, **base)

        if command == CMD_MITNEHMEN:
            session = state.session
            if session is None:
                # Nothing is open, so there is no crate this could mean. Said
                # plainly rather than picking one: the codes hang on the wall
                # where anybody can scan them by accident.
                return Decision(screen=BOXES, action="nothing_to_handover", ok=False,
                                error="Erst die Kiste scannen, dann »Mitnehmen«.", **base)
            # Whether the crate is actually packed is the server's rule (and
            # the agent checks the cached list before it calls); the router's
            # job is only to say which crate is meant.
            return Decision(screen=BOXES, action="handover",
                            box_code=session.code, box_number=session.box_number, **base)

        if command == CMD_OHNE_PROJEKT:
            decision = self._decide_selection((_dc.SELECT_NO_PROJECT, None), command,
                                              source, now)
            return replace(decision, **self._expiry_fields(expired))

        if command in (CMD_EIN, CMD_AUS, CMD_WARENEINGANG):
            direction = {CMD_EIN: "ein", CMD_AUS: "aus", CMD_WARENEINGANG: "wareneingang"}[command]
            self._state = replace(state, direction=direction)
            return Decision(screen=RACK, action="direction",
                            movement_type=_DIRECTION_MOVEMENT[direction], **base)

        # CMD_ENTNAHME
        mode = "remove" if state.mode == "add" else "add"
        self._state = replace(state, mode=mode)
        return Decision(screen=BOXES, action="mode", **base)

    def _decide_undo(self, text: str, source: str, now: float,
                     expired: Optional[str]) -> Decision:
        """Describe the inverse. Nothing is forgotten here — see confirm_undo.

        One rule survives the trip through here: **a checkout names somebody.**
        Taking back a Rückgabe re-creates a checkout, so an undo is a door onto
        the ledger like any other and is held to the same rule — it books onto
        the name tapped at the rack, and refuses (in the same German sentence a
        scanned Ausgabe is refused with) when nobody is tapped. See the comment
        on the movement branch for why it falls back rather than refusing flat.
        """
        state = self._state
        base = dict(code=text, source=source, **self._expiry_fields(expired))
        screen = self.active_screen

        # An article that never reached SMPL is the cheapest thing to take
        # back, and the one the operator most likely means.
        if state.pending_article is not None:
            self._state = replace(state, pending_article=None, pending_article_qty=1)
            return Decision(screen=screen, action="clear_pending", **base)

        last = state.last_actions.get(screen)

        if state.panel is not None:
            # Inside a panel session an ABBRUCH can only mean the last part
            # picked for THIS Verteiler. A rack movement from before the
            # session opened, or a part picked for another panel, is not
            # undone into it — and the record is kept, so switching back
            # makes it undoable again, exactly as for a crate.
            if (last is None or last.action != "panel_item"
                    or last.panel_code != state.panel.code):
                return Decision(screen=RACK, action="nothing_to_undo",
                                panel_code=state.panel.code, **base)
            return Decision(screen=RACK, action="undo_panel_item", qty=last.qty,
                            panel_code=state.panel.code,
                            undo={"panel_id": last.panel_id,
                                  "article_id": last.article_id, "qty": last.qty},
                            **base)

        if last is None or last.action == "panel_item":
            # A part picked for a Verteiler is undone under that Verteiler
            # (scan its number again), never as an anonymous rack movement.
            return Decision(screen=screen, action="nothing_to_undo", **base)

        if screen == BOXES:
            # The record belongs to the crate it was written into. After a
            # switch there is nothing to undo *here*, and the record is kept
            # so switching back makes it undoable again.
            open_code = state.session.code if state.session is not None else None
            if last.box_code != open_code:
                return Decision(screen=BOXES, action="nothing_to_undo", **base)

        if last.action == "add_item":
            return Decision(screen=BOXES, action="undo_item",
                            qty=last.qty,
                            undo={"box_id": last.box_id, "item_id": last.item_id,
                                  "qty": last.qty}, **base)

        if last.action == "remove_item":
            return Decision(screen=BOXES, action="undo_remove",
                            qty=last.qty,
                            undo={"box_id": last.box_id, "article_id": last.article_id,
                                  "qty": last.qty}, **base)

        if last.action == _CONSUMPTION:
            return self._decide_undo_consumption(last, now, base)

        inverse = _INVERSE_MOVEMENT.get(last.movement_type)
        if inverse is None:
            return Decision(screen=RACK, action="cannot_undo", ok=False,
                            error=MSG_NO_INVERSE, **base)

        # Undoing a Rückgabe writes a checkout, and a checkout names somebody.
        # A Rückgabe carries a name only when one was tapped, so the recorded
        # action often has none — and the inverse used to be booked with
        # assignee_user_id null, walking straight through the "an Ausgabe
        # needs a name" rule by the back door and leaving a tool out with
        # nobody on it.
        #
        # The name it falls back to is the one tapped *now*, not a refusal.
        # Refusing outright would be a dead end: the recorded action can never
        # grow a name, so every later ABBRUCH would be refused too and the
        # booking would stay wrong forever. The tapped name is also the honest
        # answer — whoever is standing at the rack undoing a return is the
        # person the tool is going back out with — and it is still a deliberate
        # human act, not a guess. With nobody tapped there is nothing to guess
        # from, so that is the case the rule refuses, in the same words as a
        # scanned Ausgabe, and tapping a name makes the undo work.
        assignee = last.assignee_user_id
        if movement_needs_assignee(inverse, assignee):
            assignee = _as_user_id(state.assignee)
            if assignee is None:
                self._state = replace(self._state, name_wanted_at=now)
                return Decision(screen=RACK, action="needs_assignee", ok=False,
                                error=MSG_NEEDS_ASSIGNEE, qty=last.qty, **base)

        # A Rückgabe closes the loan the name is on; a checkout opens one in
        # it. Either way the inverse carries the name, and a Wareneingang —
        # which has no inverse at all — never gets this far.
        names_somebody = (inverse in _RETURNS_A_LOAN
                          or inverse == MOVEMENT_REQUIRING_ASSIGNEE)
        return Decision(screen=RACK, action="undo_movement", qty=last.qty,
                        movement_type=inverse,
                        assignee_user_id=assignee if names_somebody else None,
                        undo={"article_id": last.article_id, "movement_type": inverse,
                              "qty": last.qty,
                              "assignee_user_id": assignee}, **base)

    def _decide_selection(self, selection: Tuple[str, Optional[int]], code: str,
                          source: str, now: float) -> Decision:
        """A person or project code off the rack screen's picker.

        Only what the screen offered is accepted: a person in the crew it
        drew, a project among the tiles drawn for the person picked. Anything
        else is refused and changes nothing -- in particular an unknown person
        code never replaces the person who is standing there.
        """
        state = self._state
        kind, ident = selection
        base = dict(code=code, source=source, screen=RACK)

        if kind == _dc.SELECT_PERSON:
            person = next((row for row in state.crew if row["id"] == ident), None)
            if person is None:
                return Decision(action="unknown_person", ok=False,
                                error=MSG_UNKNOWN_PERSON, **base)
            self._state = self._with_assignee(state, person, now)
            return Decision(action="select_person", assignee_user_id=person["id"], **base)

        project_id = ident if kind == _dc.SELECT_PROJECT else None
        if kind == _dc.SELECT_PROJECT and ident is None:
            # A garbled project code is a project nobody offered.
            new_state, error = state, (MSG_PROJECT_NEEDS_PERSON
                                       if state.assignee is None else MSG_PROJECT_NOT_OFFERED)
        else:
            new_state, error = self._picked_project(state, project_id, now)
        if error is not None:
            return Decision(action="selection_refused", ok=False, error=error,
                            assignee_user_id=_as_user_id(state.assignee), **base)
        self._state = new_state
        return Decision(action="select_project", project_id=project_id,
                        assignee_user_id=_as_user_id(new_state.assignee), **base)

    def _decide_undo_consumption(self, last: LastAction, now: float,
                                 base: Dict[str, Any]) -> Decision:
        """Take a rack consumption back -- out of exactly the bucket it went into.

        The bucket is the project SMPL booked (stamped by note_commit), not the
        project picked now: an ABBRUCH after switching projects must not move
        parts between two jobs. Undoing a Rückgabe consumes the parts again,
        and a consumption names somebody: the recorded name, else the one
        picked now, else the same refusal as a scanned Ausgabe.

        Taking a consumption back names its row (``undo_of_movement_id``):
        when the shelf was short SMPL booked a top-up with it, and only an
        undo that names the consumption reverses that too. Re-consuming a
        Rückgabe has no top-up to reverse.
        """
        inverse = _INVERSE_CONSUMPTION.get(last.movement_type)
        if inverse is None:
            return Decision(screen=RACK, action="cannot_undo", ok=False,
                            error=MSG_NO_INVERSE, **base)
        undo_of = last.movement_id if inverse == _CONSUMPTION_UNDO else None
        assignee = last.assignee_user_id
        if movement_needs_assignee(inverse, assignee):
            assignee = _as_user_id(self._state.assignee)
            if assignee is None:
                self._state = replace(self._state, name_wanted_at=now)
                return Decision(screen=RACK, action="needs_assignee", ok=False,
                                error=MSG_NEEDS_ASSIGNEE, qty=last.qty, **base)
        return Decision(screen=RACK, action="undo_consumption", qty=last.qty,
                        movement_type=inverse, assignee_user_id=assignee,
                        project_id=last.project_id,
                        undo={"article_id": last.article_id, "movement_type": inverse,
                              "qty": last.qty, "assignee_user_id": assignee,
                              "project_id": last.project_id,
                              "request_id": last.undo_request_id,
                              "undo_of_movement_id": undo_of}, **base)

    def _decide_box(self, upper: str, source: str, now: float) -> Decision:
        state = self._state
        box_number = upper[len(BOX_PREFIX):].strip()
        session = SessionState(code=upper, box_number=box_number,
                               opened_at=now, last_at=now)
        base = dict(code=upper, source=source, box_code=upper, box_number=box_number)

        previous = state.session
        if previous is not None and previous.code == upper:
            # A rescan of the open crate: keep the session, reset the clock.
            self._state = replace(state, session=replace(previous, last_at=now))
            return Decision(screen=BOXES, action="keep_session", **base)

        # A crate and a Verteiler cannot both be open: the next article scan
        # has to mean exactly one thing.
        closed_panel = state.panel is not None
        self._state = replace(state, session=session, mode="add", panel=None)
        if previous is None:
            return Decision(screen=BOXES, action="open_session",
                            closed_panel=closed_panel, **base)
        # Switching crates is what packing three jobs at once looks like.
        return Decision(screen=BOXES, action="switch_session",
                        previous_code=previous.code, closed_panel=closed_panel, **base)

    def _decide_badge(self, text: str, source: str, now: float) -> Decision:
        """A person scanned their own badge. Always the rack's business.

        The router does not decide what it MEANS -- identify, clock onto the
        open board, clock off, switch boards. SMPL does
        (``POST /station/werkstatt/badge``), so two stations scanning the same
        badge agree. All the router contributes is which board, if any, is open
        here right now -- and whether the screen has just asked for a name,
        in which case the badge is that name and nothing more (NAME_WAIT_S).
        """
        state = self._state
        panel = state.panel
        if panel is None and self._waiting_for_name(state, now):
            return Decision(screen=RACK, action="badge", code=text.strip().upper(),
                            source=source, identify_only=True)
        return Decision(
            screen=RACK,
            action="badge",
            code=text.strip().upper(),
            source=source,
            panel_code=panel.code if panel is not None else None,
            panel_id=panel.panel_id if panel is not None else None,
        )

    @staticmethod
    def _waiting_for_name(state: RouterState, now: float) -> bool:
        """An Ausgabe was refused for want of a name moments ago, and nothing
        has answered or overtaken that question since."""
        return (state.session is None
                and state.direction == _DIRECTION_REQUIRING_ASSIGNEE
                and state.assignee is None
                and state.name_wanted_at > 0.0
                and now - state.name_wanted_at <= NAME_WAIT_S)

    def _decide_panel(self, upper: str, source: str, now: float) -> Decision:
        state = self._state
        code = normalise_panel_code(upper) or upper
        base = dict(code=code, source=source, panel_code=code)

        previous = state.panel
        if previous is not None and previous.code == code:
            # A rescan of the open Verteiler: keep the session, reset the
            # clock. The server's answer (id, number) is kept too.
            self._state = replace(state, panel=replace(previous, last_at=now))
            return Decision(screen=RACK, action="keep_panel", **base)

        panel = PanelSession(code=code, panel_id=None, number=code,
                             opened_at=now, last_at=now)
        closed_box = state.session is not None
        # A new subject: a part that failed to book at the rack a minute ago
        # must not be what the next ABBRUCH takes back.
        self._state = replace(state, panel=panel, session=None, mode="add",
                              pending_article=None, pending_article_qty=1)
        if previous is None:
            return Decision(screen=RACK, action="open_panel",
                            closed_box=closed_box, **base)
        return Decision(screen=RACK, action="switch_panel",
                        previous_code=previous.code, closed_box=closed_box, **base)

    def _decide_article(self, text: str, kind: Optional[str], source: str,
                        now: float, expired: Optional[str]) -> Decision:
        state = self._state
        base = dict(code=text, source=source, kind=kind, **self._expiry_fields(expired))
        session = state.session
        panel = state.panel

        if kind == "machine":
            if panel is not None:
                # A tool is not a part of a Verteiler any more than of a
                # crate. Refused on the rack, where the operator stands, and
                # the panel stays open for the part they meant.
                return Decision(screen=RACK, action="refused", ok=False,
                                error=MSG_MACHINE_IN_PANEL, panel_code=panel.code,
                                **base)
            if session is not None:
                # Refused, but mirrored where it would have meant something —
                # and the crate stays open, because the operator's next scan
                # is almost certainly the part they meant to grab.
                return Decision(screen=RACK, action="refused", ok=False,
                                error=MSG_MACHINE_IN_SESSION, **base)
            return Decision(screen=RACK, action="machine", **base)

        if panel is not None:
            # Consumption for the open Verteiler: no name — the panel is the
            # subject, not a person — and no direction, because parts only
            # ever go INTO a panel from the rack.
            qty = state.pending_qty
            self._state = replace(state, pending_qty=1, pending_article=None,
                                  pending_article_qty=1)
            return Decision(screen=RACK, action="panel_item", qty=qty,
                            panel_code=panel.code, **base)

        # An Ausgabe with nobody's name on it cannot answer "who has the
        # drill", so it is refused before anything is consumed: the quantity
        # survives, and the operator taps a name and scans again.
        if (session is None and state.direction == _DIRECTION_REQUIRING_ASSIGNEE
                and state.assignee is None):
            self._state = replace(state, name_wanted_at=now)
            return Decision(screen=RACK, action="needs_assignee", ok=False,
                            error=MSG_NEEDS_ASSIGNEE, qty=state.pending_qty, **base)

        qty = state.pending_qty
        self._state = replace(state, pending_qty=1, pending_article=None,
                              pending_article_qty=1)

        if session is not None:
            action = "remove_item" if state.mode == "remove" else "add_item"
            return Decision(screen=BOXES, action=action, qty=qty,
                            box_code=session.code, box_number=session.box_number, **base)

        direction = state.direction
        assignee = (_as_user_id(state.assignee)
                    if direction in _DIRECTIONS_WITH_ASSIGNEE else None)
        if kind == KIND_CONSUMABLE and direction in _DIRECTIONS_WITH_ASSIGNEE:
            return self._decide_consumable(direction, qty, assignee, base)
        return Decision(screen=RACK, action="movement", qty=qty,
                        movement_type=_DIRECTION_MOVEMENT[direction],
                        assignee_user_id=assignee, **base)

    def _decide_consumable(self, direction: str, qty: int, assignee: Optional[int],
                           base: Dict[str, Any]) -> Decision:
        """A consumable at the rack is used up, never lent.

        Ausgabe: consumption for the person (the name rule above has already
        refused a nameless one) and the project picked, if any. Rückgabe:
        leftovers carried back, taken back out of the project picked -- or, with
        none picked, out of the bucket SMPL finds it was last consumed into.
        A Wareneingang never gets here: a delivery is an intake whatever it is.
        """
        state = self._state
        project_id = _as_user_id(state.project) if state.project_chosen else None
        if direction == _DIRECTION_REQUIRING_ASSIGNEE:
            return Decision(screen=RACK, action="consumption", qty=qty,
                            movement_type=_CONSUMPTION, assignee_user_id=assignee,
                            project_id=project_id, **base)
        return Decision(screen=RACK, action="consumption_return", qty=qty,
                        movement_type=_CONSUMPTION_UNDO, assignee_user_id=assignee,
                        project_id=project_id, pick_project=not state.project_chosen,
                        **base)

    # -- helpers ----------------------------------------------------------

    def _is_duplicate(self, upper: str, now: float) -> bool:
        if self.dedupe_window_s <= 0:
            return False
        state = self._state
        if not state.last_code or state.last_code != upper:
            return False
        return (now - state.last_at) <= self.dedupe_window_s

    @staticmethod
    def _normalise(code: str) -> str:
        return (code or "").strip().upper()


def _as_user_id(person: Optional[Dict[str, Any]]) -> Optional[int]:
    """A positive integer user id out of a ``{"id", "name"}``, or None."""
    if not isinstance(person, dict):
        return None
    value = person.get("id")
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None
