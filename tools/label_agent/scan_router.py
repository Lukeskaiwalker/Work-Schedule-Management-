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
from typing import Any, Callable, Dict, Optional, Tuple

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
    "DIRECTIONS",
    "MSG_NEEDS_ASSIGNEE",
    "MOVEMENT_REQUIRING_ASSIGNEE",
    "is_internal_article_code",
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

CMD_FERTIG = "SMPL-CMD-FERTIG"
CMD_ABBRUCH = "SMPL-CMD-ABBRUCH"
CMD_MENGE_5 = "SMPL-CMD-MENGE-5"
CMD_MENGE_10 = "SMPL-CMD-MENGE-10"
CMD_MENGE_50 = "SMPL-CMD-MENGE-50"
CMD_EIN = "SMPL-CMD-EIN"
CMD_AUS = "SMPL-CMD-AUS"
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
    CMD_ENTNAHME,
    CMD_MITNEHMEN,
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
MSG_NO_INVERSE = (
    "Ein Wareneingang lässt sich nicht per Abbruch zurücknehmen. Bitte in "
    "SMPL korrigieren."
)
#: Shown, in these words, when somebody scans a checkout with no name tapped.
#: It is a refusal, not a warning: nothing is written.
MSG_NEEDS_ASSIGNEE = "Bitte zuerst Namen antippen"


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
    ``POST /rack/movement``, and the checkout an ABBRUCH re-creates when it
    takes back a Rückgabe.
    """
    return (movement_type == MOVEMENT_REQUIRING_ASSIGNEE
            and _as_user_id({"id": assignee_user_id}) is None)


def command_for(code: str) -> Optional[str]:
    """The canonical command name for a scan, or None if it is not a command."""
    normalised = (code or "").strip().upper()
    return normalised if normalised in COMMAND_CODES else None


def is_box_code(code: str) -> bool:
    return (code or "").strip().upper().startswith(BOX_PREFIX)


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


@dataclass(frozen=True)
class RouterState:
    """Everything the router remembers, as one immutable value."""

    session: Optional[SessionState] = None
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

        Commands and crate codes are self-describing, and asking about them
        would put a network round trip in front of "close the session".
        """
        text = (code or "").strip()
        if not text:
            return False
        return command_for(text) is None and not is_box_code(text)

    def snapshot(self) -> Dict[str, Any]:
        """A JSON-shaped view for /health and the screen state."""
        with self._lock:
            state = self._state
            return {
                "session": (state.session.as_dict(idle_timeout_s=self.idle_timeout_s)
                            if state.session else None),
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
                    assignee_user_id: Optional[int] = None) -> None:
        """Record a commit SMPL accepted, so ``ABBRUCH`` can take it back.

        The crate is stamped from the open session unless the caller names
        one, so a line written into crate A can never be undone out of crate B.
        """
        with self._lock:
            state = self._state
            actions = dict(state.last_actions)
            if box_code is None and state.session is not None:
                box_code = state.session.code
            actions[screen] = LastAction(
                screen=screen, action=action, box_id=box_id, item_id=item_id,
                article_id=article_id, movement_type=movement_type,
                qty=max(1, int(qty)), box_code=box_code,
                assignee_user_id=assignee_user_id,
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

    def close_session(self) -> None:
        """Close the session from outside — the screen's own close button."""
        with self._lock:
            self._state = replace(self._state, session=None, mode="add")

    def open_session(self, code: str) -> None:
        """Open or switch a session from outside — the screen's box picker."""
        with self._lock:
            self._decide_box(self._normalise(code), "wedge", self._clock())

    def set_direction(self, direction: str) -> None:
        with self._lock:
            if direction in _DIRECTION_MOVEMENT:
                self._state = replace(self._state, direction=direction)

    def set_assignee(self, person: Optional[Dict[str, Any]], at: Optional[float] = None) -> None:
        """Tap a name, or clear it. ``person`` is ``{"id", "name"}`` or None."""
        with self._lock:
            now = self._clock() if at is None else float(at)
            if person is None or _as_user_id(person) is None:
                self._state = replace(self._state, assignee=None, assignee_at=0.0)
                return
            self._state = replace(
                self._state,
                assignee={"id": _as_user_id(person), "name": person.get("name")},
                assignee_at=now,
            )

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

    def tick(self) -> bool:
        """Expire an idle session. True when this call closed one."""
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
            self._state = replace(state, assignee=None, assignee_at=0.0)
            return True

    def _expire(self, now: float) -> bool:
        session = self._state.session
        if session is None:
            return False
        if now - session.last_at <= self.idle_timeout_s:
            return False
        self._state = replace(self._state, session=None, mode="add")
        return True

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

            if is_box_code(upper):
                decision = self._decide_box(upper, source, now)
                return replace(decision, session_expired=expired)

            return self._decide_article(text, kind, source, now, expired)

    def _touch(self, now: float) -> None:
        """Push the idle deadlines out; the scan itself is the activity."""
        state = self._state
        session = state.session
        if session is not None:
            state = replace(state, session=replace(session, last_at=now))
        if state.assignee is not None:
            state = replace(state, assignee_at=now)
        self._state = state

    # -- the three kinds of scan ------------------------------------------

    def _decide_command(self, command: str, text: str, source: str, now: float,
                        expired: bool) -> Decision:
        state = self._state
        base = dict(code=text, source=source, session_expired=expired)

        if command == CMD_FERTIG:
            previous = state.session.code if state.session else None
            self._state = replace(state, session=None, mode="add")
            return Decision(screen=BOXES, action="close_session",
                            previous_code=previous, **base)

        if command == CMD_ABBRUCH:
            return self._decide_undo(text, source, expired)

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

        if command in (CMD_EIN, CMD_AUS):
            direction = "ein" if command == CMD_EIN else "aus"
            self._state = replace(state, direction=direction)
            return Decision(screen=RACK, action="direction",
                            movement_type=_DIRECTION_MOVEMENT[direction], **base)

        # CMD_ENTNAHME
        mode = "remove" if state.mode == "add" else "add"
        self._state = replace(state, mode=mode)
        return Decision(screen=BOXES, action="mode", **base)

    def _decide_undo(self, text: str, source: str, expired: bool) -> Decision:
        """Describe the inverse. Nothing is forgotten here — see confirm_undo.

        One rule survives the trip through here: **a checkout names somebody.**
        Taking back a Rückgabe re-creates a checkout, so an undo is a door onto
        the ledger like any other and is held to the same rule — it books onto
        the name tapped at the rack, and refuses (in the same German sentence a
        scanned Ausgabe is refused with) when nobody is tapped. See the comment
        on the movement branch for why it falls back rather than refusing flat.
        """
        state = self._state
        base = dict(code=text, source=source, session_expired=expired)
        screen = self.active_screen

        # An article that never reached SMPL is the cheapest thing to take
        # back, and the one the operator most likely means.
        if state.pending_article is not None:
            self._state = replace(state, pending_article=None, pending_article_qty=1)
            return Decision(screen=screen, action="clear_pending", **base)

        last = state.last_actions.get(screen)
        if last is None:
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

        self._state = replace(state, session=session, mode="add")
        if previous is None:
            return Decision(screen=BOXES, action="open_session", **base)
        # Switching crates is what packing three jobs at once looks like.
        return Decision(screen=BOXES, action="switch_session",
                        previous_code=previous.code, **base)

    def _decide_article(self, text: str, kind: Optional[str], source: str,
                        now: float, expired: bool) -> Decision:
        state = self._state
        base = dict(code=text, source=source, kind=kind, session_expired=expired)
        session = state.session

        if kind == "machine":
            if session is not None:
                # Refused, but mirrored where it would have meant something —
                # and the crate stays open, because the operator's next scan
                # is almost certainly the part they meant to grab.
                return Decision(screen=RACK, action="refused", ok=False,
                                error=MSG_MACHINE_IN_SESSION, **base)
            return Decision(screen=RACK, action="machine", **base)

        # An Ausgabe with nobody's name on it cannot answer "who has the
        # drill", so it is refused before anything is consumed: the quantity
        # survives, and the operator taps a name and scans again.
        if (session is None and state.direction == _DIRECTION_REQUIRING_ASSIGNEE
                and state.assignee is None):
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
        return Decision(screen=RACK, action="movement", qty=qty,
                        movement_type=_DIRECTION_MOVEMENT[direction],
                        assignee_user_id=assignee, **base)

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
