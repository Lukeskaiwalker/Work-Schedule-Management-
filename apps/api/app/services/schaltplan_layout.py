"""Verteilerplan — device catalogue, topology derivation and legend building.

This module is the single source of truth for what a panel document *means*.
The React editor mirrors the catalogue in ``apps/web/src/utils/schaltplanDevices.ts``
and the topology rules in ``apps/web/src/utils/schaltplanTopology.ts`` so the
on-screen diagram and the printed PDF agree; both files carry a pointer back
here. When a device kind is added, add it in both places.

The document shape
------------------
::

    {
      "version": 1,
      "supply": {
        "system": "TN-S",              # TN-S | TN-C-S | TT | IT
        "voltage": "400/230 V",
        "incoming": "NYY-J 5x16 mm²",  # the feeding cable
        "fuse": "NH 63 A",             # the upstream backup fuse
        "meter_number": "1ESY...",
        "note": ""
      },
      "rows": [
        {"id": "r1", "label": "Reihe 1", "slots": 12, "devices": [Device, ...]}
      ]
    }

    Device = {
      "id": "d3",
      "kind": "mcb",                # key into DEVICE_CATALOG
      "te": 1,                      # width in Teilungseinheiten (18 mm modules)
      "poles": 1,
      "designation": "F3",          # Betriebsmittelkennzeichen
      "circuit": "3",               # Stromkreis-Nr. printed in the legend
      "label": "Steckdosen Küche",
      "room": "Küche",
      "rating": "B16",
      "residual_current": "30 mA",  # RCD only
      "rcd_type": "A",              # RCD only
      "cable": "NYM-J 3x1,5 mm²",
      "phase": "L1",
      "parent_id": null,            # explicit feed override; see below
      "feeds_following": false,     # fuse only: opens a group like an FI
      "terminal_block": false,      # outgoing ends on a WAGO Reihenklemme;
                                    # see schaltplan_terminal_rules.py
      "note": ""
    }

Topology without drawing a single wire
--------------------------------------
Real boards are wired by position: everything on the rail after an FI hangs
off that FI, until the next FI. The editor takes that convention literally, so
a worker never draws connections — the tree is derived from device order:

  * a device whose kind is ``group=True`` (Hauptschalter, SLS, FI) opens a new
    protection group and becomes the parent of everything after it;
  * a device whose kind is ``circuit=True`` becomes a child of the currently
    open group — or of the panel's supply when no group is open yet;
  * ``parent_id`` overrides the derivation for the exception case (a circuit
    physically sitting in row 3 but fed from the FI in row 1). An unknown or
    self-referential ``parent_id`` is ignored rather than raising: a stale id
    left behind by a deleted FI must degrade to "unprotected" on the drawing,
    which is visible and fixable, not 500 the request.

A fuse as a feeder
------------------
A Neozed/NH block is a circuit by catalogue — most of them feed one consumer.
But an RCBO cannot hang off one through the pre-fuse rule (that rule is for
FI/SLS/Hauptschalter only), and a row of LS that needs no FI at all could not
be fed by one either. So a fuse OPENS A GROUP — behaves like an FI in the
tree — when either

  * it is flagged ``feeds_following``: everything placed after it on the rail
    hangs off it until the next group opener, exactly like an FI; or
  * at least one circuit names it via ``parent_id``. Then only those circuits
    belong to it — a Neozed sitting in a row must not silently steal the
    row's LS just because one RCBO elsewhere points at it.

``opens_group`` / ``feeder_fuse_ids`` are the single definition of that rule;
``is_group_device`` stays catalogue-based. A fuse that an FI names as its
pre-fuse and that ALSO opens a group is drawn twice on purpose: as the plate
above the FI and as its own group. Only a pre-fuse that opens no group leaves
the circuit walk. A fuse-headed group never carries a plate of its own, and
a group head's own ``parent_id`` is ignored — the drawing has two levels.

Rows are the *physical* layout (which rail, which slot). The tree is the
*electrical* layout. Both come out of the same array, which is why the two
never drift apart.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Iterator

# ── Device catalogue ────────────────────────────────────────────────────────
#
# ``te``      default width in Teilungseinheiten (1 TE = 18 mm)
# ``poles``   default pole count
# ``group``   opens a protection group — children hang beneath it
# ``circuit`` occupies a Stromkreis line in the legend
# ``symbol``  which glyph the renderers draw (shared vocabulary, not a 1:1 map
#             to kind, so several kinds can reuse one symbol)

DEVICE_CATALOG: dict[str, dict[str, Any]] = {
    "hauptschalter": {
        "label": "Hauptschalter",
        "short": "HS",
        "te": 3, "poles": 3, "group": True, "circuit": False, "symbol": "switch",
        "rating_hint": "63 A",
    },
    "sls": {
        "label": "SLS-Schalter (selektiv)",
        "short": "SLS",
        "te": 3, "poles": 3, "group": True, "circuit": False, "symbol": "sls",
        "rating_hint": "E35",
    },
    "rcd": {
        "label": "FI-Schutzschalter (RCD)",
        "short": "FI",
        "te": 4, "poles": 4, "group": True, "circuit": False, "symbol": "rcd",
        "rating_hint": "40 A",
    },
    "rcbo": {
        # Combined RCD+MCB: it protects itself only, so it is a circuit, not a
        # group. Marking it group=True would silently adopt every following
        # LS as its children and print a wrong FI column in the legend.
        "label": "FI/LS kombiniert (RCBO)",
        "short": "FI/LS",
        "te": 2, "poles": 2, "group": False, "circuit": True, "symbol": "rcbo",
        "rating_hint": "B16",
    },
    "mcb": {
        "label": "Leitungsschutzschalter (LS)",
        "short": "LS",
        "te": 1, "poles": 1, "group": False, "circuit": True, "symbol": "mcb",
        "rating_hint": "B16",
    },
    "fuse": {
        "label": "Sicherung (NH / Neozed)",
        "short": "Si",
        "te": 3, "poles": 3, "group": False, "circuit": True, "symbol": "fuse",
        "rating_hint": "35 A",
    },
    "spd": {
        "label": "Überspannungsschutz (SPD)",
        "short": "SPD",
        "te": 4, "poles": 4, "group": False, "circuit": False, "symbol": "spd",
        "rating_hint": "Typ 2",
    },
    "meter": {
        "label": "Zähler / eHZ",
        "short": "kWh",
        "te": 6, "poles": 3, "group": False, "circuit": False, "symbol": "meter",
        "rating_hint": "",
    },
    "contactor": {
        "label": "Installationsschütz",
        "short": "Schütz",
        "te": 2, "poles": 4, "group": False, "circuit": True, "symbol": "contactor",
        "rating_hint": "20 A",
    },
    "impulse": {
        "label": "Stromstoßschalter",
        "short": "Stromstoß",
        "te": 1, "poles": 1, "group": False, "circuit": True, "symbol": "relay",
        "rating_hint": "16 A",
    },
    "timer": {
        "label": "Treppenlicht-/Zeitrelais",
        "short": "Zeit",
        "te": 1, "poles": 1, "group": False, "circuit": True, "symbol": "relay",
        "rating_hint": "16 A",
    },
    "bell_transformer": {
        "label": "Klingeltrafo",
        "short": "Trafo",
        "te": 2, "poles": 1, "group": False, "circuit": True, "symbol": "transformer",
        "rating_hint": "8 V",
    },
    "power_supply": {
        "label": "Netzteil / Spannungsversorgung",
        "short": "NT",
        "te": 4, "poles": 1, "group": False, "circuit": True, "symbol": "transformer",
        "rating_hint": "24 V DC",
    },
    "knx_actuator": {
        "label": "KNX-Aktor",
        "short": "KNX",
        "te": 4, "poles": 1, "group": False, "circuit": True, "symbol": "bus",
        "rating_hint": "8-fach",
    },
    "wallbox": {
        "label": "Wallbox-Abgang",
        "short": "Wallbox",
        "te": 3, "poles": 3, "group": False, "circuit": True, "symbol": "wallbox",
        "rating_hint": "B32",
    },
    "pv": {
        "label": "PV-Einspeisung / Wechselrichter",
        "short": "PV",
        "te": 3, "poles": 3, "group": False, "circuit": True, "symbol": "pv",
        "rating_hint": "B25",
    },
    "sub_feed": {
        "label": "Abgang Unterverteiler",
        "short": "→ UV",
        "te": 3, "poles": 3, "group": False, "circuit": True, "symbol": "subfeed",
        "rating_hint": "B40",
    },
    "terminal": {
        "label": "Reihenklemme N/PE",
        "short": "Klemme",
        "te": 1, "poles": 1, "group": False, "circuit": False, "symbol": "terminal",
        "rating_hint": "",
    },
    "blank": {
        "label": "Blindabdeckung",
        "short": "—",
        "te": 1, "poles": 1, "group": False, "circuit": False, "symbol": "blank",
        "rating_hint": "",
    },
}

# Kinds a client may send. Anything else is rejected at the schema boundary
# rather than silently stored and later rendered as an empty box.
DEVICE_KINDS: frozenset[str] = frozenset(DEVICE_CATALOG)

SUPPLY_SYSTEMS: tuple[str, ...] = ("TN-S", "TN-C-S", "TT", "IT")
PANEL_TYPES: tuple[str, ...] = ("main", "sub", "meter")
PANEL_STATUSES: tuple[str, ...] = ("draft", "final")

PANEL_TYPE_LABELS: dict[str, str] = {
    "main": "Hauptverteiler",
    "sub": "Unterverteiler",
    "meter": "Zählerplatz",
}

# A standard Hager/ABB rail takes 12 modules. Kept as a constant because both
# the slot-usage warning and the empty-document factory need it.
DEFAULT_SLOTS_PER_ROW = 12


def empty_document() -> dict[str, Any]:
    """A new board: one empty rail and an unfilled supply block.

    Deliberately not "one board pre-filled with a Hauptschalter and two FIs".
    A guessed starting point reads as fact once it is on the drawing, and a
    wrong FI type on as-built documentation is worse than an empty rail.
    """

    return {
        "version": 1,
        "supply": {
            "system": "TN-S",
            "voltage": "400/230 V",
            "incoming": "",
            "fuse": "",
            "meter_number": "",
            "note": "",
        },
        "rows": [{"id": "row-1", "label": "Reihe 1", "slots": DEFAULT_SLOTS_PER_ROW, "devices": []}],
    }


# Real modular devices are 17.5 mm per module (DIN 43880 leaves 18 mm of rail
# per module; the devices themselves are made 17.5 so a full row still fits).
# Sit twelve breakers side by side and they span 210 mm, not 216 — a strip cut
# at 18 mm per device drifts half a module by the end of the rail.
MODULE_WIDTH_MM = 17.5


def device_width_mm(device: dict[str, Any]) -> float:
    """The width a device takes on the rail: its override, else te × 17.5 mm."""
    override = device.get("width_mm")
    if isinstance(override, (int, float)) and not isinstance(override, bool) and override > 0:
        return float(override)
    try:
        te = int(device.get("te") or 1)
    except (TypeError, ValueError):
        te = 1
    return max(1, te) * MODULE_WIDTH_MM


@dataclass(frozen=True)
class StripSegment:
    """One labelled device's share of a rail's marking strip."""

    device_id: str
    kind: str
    text: str  # the BMK — never empty: an unlabelled device gets no segment
    width_mm: float
    start_mm: float


# What is trimmed off a BMK before it counts as text. Spelled out (rather than
# str.strip) because the editor's TypeScript twin trims with the same pattern:
# JS trim() and Python strip() disagree on U+FEFF and the C0 controls, and a
# designation made only of those must be "ohne BMK" on both sides.
BMK_EDGE_JUNK = re.compile(r"^[\s\ufeff\x00-\x1f\x7f]+|[\s\ufeff\x00-\x1f\x7f]+$")


def segment_text(device: dict[str, Any]) -> str:
    """What a device's segment says: its BMK, or "" for a blank cover / no BMK.

    A Blindabdeckung is not a Betriebsmittel, whatever someone typed on it.
    """
    if str(device.get("kind") or "") == "blank":
        return ""
    return BMK_EDGE_JUNK.sub("", str(device.get("designation") or ""))


def unlabelled_device_count(row: dict[str, Any]) -> int:
    """Betriebsmittel on the rail that carry no BMK yet. Blank covers never count."""
    return sum(
        1
        for device in row.get("devices") or []
        if isinstance(device, dict)
        and str(device.get("kind") or "") != "blank"
        and not segment_text(device)
    )


def strip_segments(row: dict[str, Any]) -> list[StripSegment]:
    """The rail as a marking strip: every LABELLED device, in order, at its real width.

    A blank cover or a device without a BMK gets no segment and no width — the
    strip simply continues with the next labelled device, and its length is
    the sum of the segments actually emitted. Reserving an empty segment for
    them (as the first version did) produced runs of blank stubs on the board
    that had to be cut away by hand; a strip is a row of labels, not a ruler.
    """
    segments: list[StripSegment] = []
    position = 0.0
    for device in row.get("devices") or []:
        if not isinstance(device, dict):
            continue
        text = segment_text(device)
        if not text:
            continue
        width = device_width_mm(device)
        segments.append(
            StripSegment(
                device_id=str(device.get("id") or ""),
                kind=str(device.get("kind") or ""),
                text=text,
                width_mm=width,
                start_mm=position,
            )
        )
        position += width
    return segments


# ── Marking-strip typography ───────────────────────────────────────────────
#
# The WAGO 258-5101 prints BMK strips with its built-in TrueType face, whose
# metrics are Arial's. GLYPH_ADVANCE_EM is Arial's advance width per glyph as
# a fraction of the em (hmtx advance / 2048 unitsPerEm, rounded to three
# places): printable ASCII plus the German umlauts, ß, ° and µ — 104 entries.
# A glyph outside the table falls back to GLYPH_ADVANCE_FALLBACK_EM, the flat
# average the strip used before it had per-glyph metrics (0.58 × len, which
# over-estimated "F1.1" by a sixth and under-estimated "WM" badly). The React
# preview embeds the same table in apps/web/src/utils/schaltplanStrip.ts —
# keep the two identical, or the preview will centre text the printer does not.
GLYPH_ADVANCE_EM: dict[str, float] = {
    ' ': 0.278, '!': 0.278, '"': 0.355, '#': 0.556, '$': 0.556, '%': 0.889,
    '&': 0.667, "'": 0.191, '(': 0.333, ')': 0.333, '*': 0.389, '+': 0.584,
    ',': 0.278, '-': 0.333, '.': 0.278, '/': 0.278, '0': 0.556, '1': 0.556,
    '2': 0.556, '3': 0.556, '4': 0.556, '5': 0.556, '6': 0.556, '7': 0.556,
    '8': 0.556, '9': 0.556, ':': 0.278, ';': 0.278, '<': 0.584, '=': 0.584,
    '>': 0.584, '?': 0.556, '@': 1.015, 'A': 0.667, 'B': 0.667, 'C': 0.722,
    'D': 0.722, 'E': 0.667, 'F': 0.611, 'G': 0.778, 'H': 0.722, 'I': 0.278,
    'J': 0.500, 'K': 0.667, 'L': 0.556, 'M': 0.833, 'N': 0.722, 'O': 0.778,
    'P': 0.667, 'Q': 0.778, 'R': 0.722, 'S': 0.667, 'T': 0.611, 'U': 0.722,
    'V': 0.667, 'W': 0.944, 'X': 0.667, 'Y': 0.667, 'Z': 0.611, '[': 0.278,
    '\\': 0.278, ']': 0.278, '^': 0.469, '_': 0.556, '`': 0.333, 'a': 0.556,
    'b': 0.556, 'c': 0.500, 'd': 0.556, 'e': 0.556, 'f': 0.278, 'g': 0.556,
    'h': 0.556, 'i': 0.222, 'j': 0.222, 'k': 0.500, 'l': 0.222, 'm': 0.833,
    'n': 0.556, 'o': 0.556, 'p': 0.556, 'q': 0.556, 'r': 0.333, 's': 0.500,
    't': 0.278, 'u': 0.556, 'v': 0.500, 'w': 0.722, 'x': 0.500, 'y': 0.500,
    'z': 0.500, '{': 0.334, '|': 0.260, '}': 0.334, '~': 0.584, 'Ä': 0.667,
    'Ö': 0.778, 'Ü': 0.722, 'ä': 0.556, 'ö': 0.556, 'ü': 0.556, 'ß': 0.611,
    '°': 0.400, 'µ': 0.576,
}
GLYPH_ADVANCE_FALLBACK_EM = 0.58

# The 258-5101's 300 dpi head; the same number as werkstatt_labels._DOTS_PER_MM.
STRIP_DOTS_PER_MM = 12
# 1 mm between a segment's cut line and its text, on each side.
STRIP_SEG_PAD_DOTS = 12
# 2 mm capitals: below this a BMK is unreadable on a board, so a text that
# needs less is printed at this size and reported as overflowing instead.
STRIP_MIN_SIZE_DOTS = 24
# The ceiling comes from the strip's height: 72 % of it, never closer than
# 1 mm to the edge, and at least 16 dots on absurdly narrow stock.
STRIP_MAX_SIZE_RATIO = 0.72
STRIP_MAX_SIZE_MARGIN_DOTS = 12
STRIP_MAX_SIZE_FLOOR_DOTS = 16


def text_width_em(text: str) -> float:
    """Advance width of ``text`` in em: the sum of its glyphs' advances."""
    return sum(GLYPH_ADVANCE_EM.get(ch, GLYPH_ADVANCE_FALLBACK_EM) for ch in text)


def strip_max_font_size(strip_width_mm: float) -> int:
    """The largest size the strip's height allows: 11 mm (132 dots) → 95."""
    # Whole millimetres first, then dots — the renderer builds its frame as
    # _mm(width) * 12, and the two must never size against different heights.
    h_px = int(round(strip_width_mm)) * STRIP_DOTS_PER_MM
    return max(
        STRIP_MAX_SIZE_FLOOR_DOTS,
        min(h_px - STRIP_MAX_SIZE_MARGIN_DOTS, int(h_px * STRIP_MAX_SIZE_RATIO)),
    )


def font_size_for_fits(
    segments: list[tuple[str, float]],
    strip_width_mm: float,
    *,
    pad_dots: int = STRIP_SEG_PAD_DOTS,
) -> tuple[int, list[str]]:
    """ONE font size for a list of ``(text, width_mm)`` segments, and the texts that overflow.

    For each segment the size at which its text exactly fills the width
    minus the pads is ``(width_mm × 12 − 2 × pad) / em``. The result is the
    floor of the smallest such fit, clamped to [STRIP_MIN_SIZE_DOTS,
    strip_max_font_size]. ``pad_dots`` is what stays free between a cut mark
    and the text on either side — 1 mm on the BMK strip, 0.5 mm on a
    Reihenklemme (``schaltplan_terminals.TERMINAL_SEG_PAD_DOTS``). An empty
    list (or one of empty texts) gets the maximum.

    ``overflowing`` lists the texts whose own fit is below the minimum: at
    the clamped size they run past their cut marks. That is for the caller
    to say out loud — shrinking them further would just make them unreadable.
    Twin of ``fontSizeForSegments`` in the editor.
    """
    max_size = strip_max_font_size(strip_width_mm)
    fits: list[tuple[str, float]] = []
    for text, width_mm in segments:
        if not text:
            continue
        budget = width_mm * STRIP_DOTS_PER_MM - 2 * pad_dots
        fits.append((text, budget / text_width_em(text)))
    if not fits:
        return max_size, []
    tightest = math.floor(min(fit for _, fit in fits))
    # The strip's ceiling wins over the readability floor (only matters on
    # stock under 3 mm, and the twin clamps the same way).
    size = min(max_size, max(STRIP_MIN_SIZE_DOTS, tightest))
    overflowing = [text for text, fit in fits if fit < STRIP_MIN_SIZE_DOTS]
    return size, overflowing


def board_font_size(document: dict[str, Any], strip_width_mm: float) -> tuple[int, list[str]]:
    """ONE font size for every BMK on the board, and the texts that still overflow.

    Every labelled device of every row, fitted with the BMK pad by
    ``font_size_for_fits``. Over the whole document, not over the rails being
    printed: a rail printed next week has to match the ones printed today,
    and a board with two text sizes on it looks like two boards.
    """
    segments = [
        (segment_text(device), device_width_mm(device))
        for _row, device in iter_devices(document)
        if segment_text(device)
    ]
    return font_size_for_fits(segments, strip_width_mm, pad_dots=STRIP_SEG_PAD_DOTS)


def iter_devices(document: dict[str, Any]) -> Iterator[tuple[dict[str, Any], dict[str, Any]]]:
    """Yield ``(row, device)`` in physical order: row by row, left to right.

    Tolerant of partial documents — a row without ``devices`` or a device that
    is not a dict is skipped rather than raising. These documents are written
    by a tablet that may be several app versions behind.
    """

    for row in document.get("rows") or []:
        if not isinstance(row, dict):
            continue
        for device in row.get("devices") or []:
            if isinstance(device, dict):
                yield row, device


def _catalog(kind: str) -> dict[str, Any]:
    return DEVICE_CATALOG.get(kind, DEVICE_CATALOG["blank"])


def is_group_device(device: dict[str, Any]) -> bool:
    return bool(_catalog(str(device.get("kind", ""))).get("group"))


def is_circuit_device(device: dict[str, Any]) -> bool:
    return bool(_catalog(str(device.get("kind", ""))).get("circuit"))


def is_fuse(device: dict[str, Any]) -> bool:
    return str(device.get("kind", "")) == "fuse"


def feeder_fuse_ids(document: dict[str, Any]) -> set[str]:
    """Ids of every fuse that at least one circuit names as its parent.

    "Circuit" here is the catalogue meaning — ``circuit=True, group=False`` —
    so an RCBO, an LS or a Schütz counts; an FI naming a fuse does not (that
    is the pre-fuse rule, not this one), and neither does ANOTHER FUSE: a
    fuse's own parent_id is never read by the topology, so letting it promote
    the fuse it names would conjure an empty group out of the ordinary
    NH → Neozed → FI board and drop the NH's own legend row. Self-references
    are ignored like everywhere in this module.
    """

    by_id: dict[str, dict[str, Any]] = {}
    for _row, device in iter_devices(document):
        device_id = str(device.get("id") or "")
        if device_id:
            by_id[device_id] = device

    ids: set[str] = set()
    for _row, device in iter_devices(document):
        if is_group_device(device) or not is_circuit_device(device) or is_fuse(device):
            continue
        parent = str(device.get("parent_id") or "")
        if not parent or parent == str(device.get("id") or ""):
            continue
        candidate = by_id.get(parent)
        if candidate is not None and is_fuse(candidate):
            ids.add(parent)
    return ids


def feeds_following(device: dict[str, Any]) -> bool:
    """The positional half of ``opens_group``: a FLAGGED fuse takes the rail after it."""

    return is_fuse(device) and bool(device.get("feeds_following"))


def opens_group(
    device: dict[str, Any],
    document: dict[str, Any],
    feeder_ids: set[str] | None = None,
) -> bool:
    """Does this fuse head a group of its own? (Never true for any other kind.)

    True when the fuse is flagged ``feeds_following`` or when a circuit names
    it (see ``feeder_fuse_ids``). ``feeder_ids`` lets a caller that already
    computed the set pass it in instead of rescanning the document per device.
    """

    if not is_fuse(device):
        return False
    if feeds_following(device):
        return True
    ids = feeder_fuse_ids(document) if feeder_ids is None else feeder_ids
    return str(device.get("id") or "") in ids


def device_te(device: dict[str, Any]) -> int:
    """Module width, falling back to the catalogue default.

    Clamped to 1..24: a hand-edited ``te`` of 0 would make a device invisible
    on the rail, and a huge one would push every sibling off the drawing.
    """

    raw = device.get("te")
    try:
        value = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        value = int(_catalog(str(device.get("kind", ""))).get("te", 1))
    return max(1, min(24, value))


def row_used_slots(row: dict[str, Any]) -> int:
    return sum(device_te(device) for device in (row.get("devices") or []) if isinstance(device, dict))


# ── Topology ────────────────────────────────────────────────────────────────


def build_topology(document: dict[str, Any]) -> dict[str, Any]:
    """Derive the electrical tree from physical device order.

    Returns::

        {
          "groups": [{"device": <group device or None>,
                      "row_label": "Reihe 1",
                      "children": [<circuit device>, ...]}],
          "orphans": [<circuit device explicitly parented to a missing id>],
        }

    The first group may have ``device: None`` — that is the implicit "direkt
    von der Einspeisung" group holding circuits placed before any FI. It is
    only emitted when it actually has children, so a normally-built board
    shows no phantom group.

    A group's ``device`` is a catalogue group (FI, SLS, Hauptschalter) or a
    fuse that ``opens_group`` — the input dicts are referenced, never copied
    or mutated.
    """

    by_id: dict[str, dict[str, Any]] = {}
    for _row, device in iter_devices(document):
        device_id = str(device.get("id") or "")
        if device_id:
            by_id[device_id] = device

    feeder_ids = feeder_fuse_ids(document)

    def is_head(device: dict[str, Any]) -> bool:
        return is_group_device(device) or opens_group(device, document, feeder_ids)

    # Two passes on purpose. Placement order is physical; ``parent_id`` is
    # electrical, and the two are allowed to disagree — a circuit may name a
    # group device that sits to its RIGHT on the rail. A single walk that
    # indexes a group only on reaching it raised KeyError for exactly that
    # (an RCBO parented to a Hauptschalter one slot later), and every load of
    # the panel then failed. Register every group first; then no explicit
    # reference can be ahead of the index.
    #
    # The index doubles as the set of valid explicit parents: catalogue groups
    # plus every fuse a circuit names (which is what makes it a head). A
    # circuit pointing at an LS, or at an id that is gone, finds nothing here
    # and is treated as dangling below.
    groups: list[dict[str, Any]] = []
    index_by_group_id: dict[str, int] = {}
    for row, device in iter_devices(document):
        if not is_head(device):
            continue
        groups.append({
            "device": device,
            "row_label": str(row.get("label") or ""),
            "children": [],
            "pre_fuse": None,
        })
        device_id = str(device.get("id") or "")
        if device_id:
            index_by_group_id[device_id] = len(groups) - 1

    # A catalogue group device naming a parent means one thing: the Neozed/NH
    # block feeding it. That fuse is a FEEDER of the group, not one of its
    # loads; on the legend it shows as the upstream protection of every
    # circuit under that FI. It leaves the circuit walk ("consumed") unless
    # it opens a group of its own — then it is drawn as the plate AND as its
    # own group, because it really does feed both. Only kind "fuse"
    # qualifies: a dangling or wrong-kind parent degrades to "none" and is
    # reported by validate_document, never raised. A fuse-headed group never
    # has a plate: its own parent_id is not a pre-fuse reference.
    consumed_fuses: set[str] = set()
    for group in groups:
        if not is_group_device(group["device"]):
            continue
        parent = str(group["device"].get("parent_id") or "")
        candidate = by_id.get(parent)
        if candidate is not None and is_fuse(candidate):
            group["pre_fuse"] = candidate
            if not opens_group(candidate, document, feeder_ids):
                consumed_fuses.add(parent)

    supply_group: dict[str, Any] = {
        "device": None, "row_label": "", "children": [], "pre_fuse": None
    }
    current: dict[str, Any] = supply_group
    orphans: list[dict[str, Any]] = []

    for _row, device in iter_devices(document):
        device_id = str(device.get("id") or "")
        if device_id in consumed_fuses:
            continue
        if is_head(device):
            # Implicit parenting still follows physical order: what comes
            # after a catalogue group or a FLAGGED fuse, without a parent_id
            # of its own, is fed by it. A fuse that is a head only because a
            # circuit names it leaves the rail's derivation alone.
            if (is_group_device(device) or feeds_following(device)) and device_id in index_by_group_id:
                current = groups[index_by_group_id[device_id]]
            continue

        if not is_circuit_device(device):
            # SPDs, terminals, blanks and the meter occupy rail space but are
            # not circuits: they belong on the rail view, never in the legend
            # or as a branch on the diagram.
            continue

        explicit = str(device.get("parent_id") or "")
        if explicit:
            target = index_by_group_id.get(explicit)
            if target is not None:
                groups[target]["children"].append(device)
            else:
                # Dangling reference (the FI it named was deleted, or it names
                # something that cannot feed a circuit). Show it as unprotected
                # so the mistake is on the drawing, not hidden — and never let
                # a lookup miss become a failed page load.
                orphans.append(device)
                supply_group["children"].append(device)
            continue

        current["children"].append(device)

    if supply_group["children"]:
        groups.insert(0, supply_group)

    return {"groups": groups, "orphans": orphans}


def _text(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _pre_fuse_summary(fuse: dict[str, Any] | None) -> str:
    """The legend's Vorsicherung column: "F0 35 A" or "—"."""

    if fuse is None:
        return "—"
    parts = [p for p in (_text(fuse.get("designation")), _text(fuse.get("rating"))) if p]
    return " ".join(parts) or "Si"


def _rcd_summary(group_device: dict[str, Any] | None) -> str:
    """The legend's FI column: "30 mA / Typ A" for an RCD, "—" without one."""

    if group_device is None:
        return "—"
    kind = str(group_device.get("kind", ""))
    if kind != "rcd":
        # A Hauptschalter or SLS group offers no residual-current protection;
        # saying "—" here is the honest answer and is what an inspector needs
        # to see. The group is still drawn on the diagram.
        return "—"
    parts = [p for p in (_text(group_device.get("residual_current")), _text(group_device.get("rcd_type"))) if p]
    if not parts:
        return "FI"
    if len(parts) == 2:
        return f"{parts[0]} / Typ {parts[1]}"
    return parts[0]


def _device_poles(device: dict[str, Any], catalog: dict[str, Any]) -> int:
    try:
        poles = int(device.get("poles") or 0)
    except (TypeError, ValueError):
        poles = 0
    return poles if poles > 0 else int(catalog.get("poles", 1))


def build_legend(document: dict[str, Any]) -> list[dict[str, str]]:
    """The Stromkreisliste: one row per circuit, in physical device order.

    This is the artefact that gets glued inside the panel door, so the column
    set matches what an electrician reads off it in the dark: which breaker,
    what it feeds, which room, how it is protected, what cable runs to it.
    """

    # Local import: the terminal derivation needs build_topology from here.
    from app.services.schaltplan_terminals import derive_terminals, device_terminal_labels

    topology = build_topology(document)
    terminal_labels = device_terminal_labels(derive_terminals(document))
    rows: list[dict[str, str]] = []

    for group in topology["groups"]:
        group_device = group["device"]
        # A Neozed offers no residual-current protection: "—" unless the
        # circuit is an RCBO, which then carries its own (below).
        rcd = _rcd_summary(group_device)
        # Under a fuse-headed group the Vorsicherung IS the group head.
        fuse_head = group_device is not None and is_fuse(group_device)
        pre_fuse_label = _pre_fuse_summary(group_device if fuse_head else group.get("pre_fuse"))
        group_label = (
            f"{_text(group_device.get('designation'))} {_text(group_device.get('label'))}".strip()
            if group_device
            else "Direkt von Einspeisung"
        )
        for device in group["children"]:
            catalog = _catalog(str(device.get("kind", "")))
            # An RCBO carries its own residual-current data; it is its own FI.
            own_rcd = rcd
            if str(device.get("kind")) == "rcbo":
                parts = [
                    p
                    for p in (
                        _text(device.get("residual_current")),
                        _text(device.get("rcd_type")),
                    )
                    if p
                ]
                own_rcd = (
                    f"{parts[0]} / Typ {parts[1]}" if len(parts) == 2 else (parts[0] if parts else "FI/LS")
                )
            rows.append(
                {
                    "circuit": _text(device.get("circuit")),
                    "designation": _text(device.get("designation")),
                    "label": _text(device.get("label")),
                    "room": _text(device.get("room")),
                    "device": str(catalog.get("short", "")),
                    # "1" / "3" — the PDF legend prints "LS · 3P" from it; the
                    # web legend keeps its own column set.
                    "poles": str(_device_poles(device, catalog)),
                    "rating": _text(device.get("rating")),
                    "rcd": own_rcd,
                    "cable": _text(device.get("cable")),
                    "phase": _text(device.get("phase")),
                    "group": group_label,
                    "pre_fuse": pre_fuse_label,
                    "note": _text(device.get("note")),
                    # "X1.1, X1.2" — the Reihenklemmen this circuit ends on.
                    "terminals": ", ".join(terminal_labels.get(str(device.get("id") or ""), [])),
                }
            )

    return rows


def document_stats(document: dict[str, Any]) -> dict[str, int]:
    """Counts for the panel cards in the list view — cheap, no layout needed."""

    circuits = 0
    feeder_ids = feeder_fuse_ids(document)
    devices = 0
    rcds = 0
    used = 0
    slots = 0
    for row, device in iter_devices(document):
        devices += 1
        used += device_te(device)
        if is_circuit_device(device) and not opens_group(device, document, feeder_ids):
            circuits += 1
        if str(device.get("kind")) in {"rcd", "rcbo"}:
            rcds += 1
    for row in document.get("rows") or []:
        if isinstance(row, dict):
            try:
                slots += int(row.get("slots") or DEFAULT_SLOTS_PER_ROW)
            except (TypeError, ValueError):
                slots += DEFAULT_SLOTS_PER_ROW
    return {
        "device_count": devices,
        "circuit_count": circuits,
        "rcd_count": rcds,
        "used_slots": used,
        "total_slots": slots,
        "row_count": len(document.get("rows") or []),
    }


def validate_document(document: dict[str, Any]) -> list[dict[str, str]]:
    """Non-blocking plausibility findings shown as warnings in the editor.

    Deliberately advisory, never an error: a board captured mid-refurbishment
    is legitimately inconsistent, and refusing to save it would push the crew
    back to taking photos of the rail with their phone. Each finding names the
    row or device so the UI can point at it.
    """

    findings: list[dict[str, str]] = []

    for row in document.get("rows") or []:
        if not isinstance(row, dict):
            continue
        try:
            slots = int(row.get("slots") or DEFAULT_SLOTS_PER_ROW)
        except (TypeError, ValueError):
            slots = DEFAULT_SLOTS_PER_ROW
        used = row_used_slots(row)
        if used > slots:
            findings.append(
                {
                    "level": "warn",
                    "scope": str(row.get("id") or ""),
                    "message": f"{row.get('label') or 'Reihe'}: {used} TE belegt, aber nur {slots} TE vorhanden.",
                }
            )

    # A fuse that heads a group is protection, not a load: it has no legend
    # row where a Stromkreis-Nr. or a cable could appear, so it is neither
    # nagged for them nor part of the duplicate count.
    feeder_ids = feeder_fuse_ids(document)
    seen_circuits: dict[str, int] = {}
    for _row, device in iter_devices(document):
        if opens_group(device, document, feeder_ids):
            continue
        circuit = _text(device.get("circuit"))
        if is_circuit_device(device):
            if not circuit:
                findings.append(
                    {
                        "level": "info",
                        "scope": str(device.get("id") or ""),
                        "message": f"{_text(device.get('label')) or 'Stromkreis'}: keine Stromkreis-Nr. vergeben.",
                    }
                )
            else:
                seen_circuits[circuit] = seen_circuits.get(circuit, 0) + 1
            if not _text(device.get("cable")):
                findings.append(
                    {
                        "level": "info",
                        "scope": str(device.get("id") or ""),
                        "message": f"Stromkreis {circuit or '?'}: keine Leitung angegeben.",
                    }
                )

    for circuit, count in seen_circuits.items():
        if count > 1:
            findings.append(
                {
                    "level": "warn",
                    "scope": "",
                    "message": f"Stromkreis-Nr. {circuit} ist {count}× vergeben.",
                }
            )

    topology = build_topology(document)
    for group in topology["groups"]:
        device = group["device"]
        if (
            device is not None
            and is_group_device(device)
            and str(device.get("parent_id") or "")
            and group.get("pre_fuse") is None
        ):
            findings.append(
                {
                    "level": "info",
                    "scope": str(device.get("id") or ""),
                    "message": (
                        f"{_text(device.get('designation')) or 'FI'}: Vorsicherung nicht gefunden "
                        "(die angegebene Sicherung fehlt oder ist keine Sicherung)."
                    ),
                }
            )
        # The flag claims the rail after the fuse. A circuit naming the fuse from
        # elsewhere is fed by it anyway, so only positional children (those
        # without a parent_id of their own) show the flag doing any work.
        positional = [child for child in group["children"] if not child.get("parent_id")]
        if device is not None and feeds_following(device) and not positional:
            # The flag was set and nothing is placed after the fuse before
            # the next group opener (and nothing names it): the flag is doing
            # no work, which usually means the LS were meant to follow it.
            findings.append(
                {
                    "level": "info",
                    "scope": str(device.get("id") or ""),
                    "message": (
                        f"{_text(device.get('designation')) or 'Sicherung'}: "
                        "Vorsicherung speist keine Abgänge"
                    ),
                }
            )
        if group["device"] is None and group["children"]:
            findings.append(
                {
                    "level": "warn",
                    "scope": "",
                    "message": (
                        f"{len(group['children'])} Stromkreis(e) ohne vorgeschalteten "
                        "FI-Schutzschalter."
                    ),
                }
            )

    # Reihenklemmen: a group without an FI that still wants terminals, and
    # pole counts the Etagenklemmen round. Imported here, not at the top:
    # the rules module reads DEVICE_CATALOG from this one.
    from app.services.schaltplan_terminal_rules import terminal_findings

    findings.extend(terminal_findings(topology["groups"]))

    return findings
