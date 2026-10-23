"""How a text fits a cell: the one rule of the WAGO close-up (R2 §7.1).

Twin of ``apps/web/src/utils/labelFit.ts``; both run the table of cases in
``enclosureFixtures.json`` (``label_fit``). The app sheet and the Aufbau PDF
draw every marker, level and "für" text through it, so nothing is fitted
twice in two ways:

1. horizontal at ``size_max`` when it fits;
2. horizontal, shrunk to the largest size ≥ ``size_min`` that fits;
3. rotated 90° (the cell's height is then the length), ``size_max`` …
   ``size_min`` the same way;
4. cut with "…" at ``size_min``, in whichever orientation keeps more
   characters (a tie stays horizontal); trailing spaces before the "…" go.

A size fits when the text's width is at most the cell's length and the size
itself at most the cell's other side. A shrunk size is floored to 0.1.

The width is the sum of Helvetica's AFM advance widths (the PDF's font; the
table below equals reportlab's metrics, a test pins it), 556/1000 em for a
character the table lacks, × size × ``scale``. The PDF uses ``scale = 1``;
the app uses 1.1, because its UI font is not Helvetica and needs a margin.
Characters are code points (TS: ``Array.from(text)``).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

ELLIPSIS = "…"
FALLBACK_UNITS = 556
_EPS = 1e-9

# Helvetica advance widths in 1/1000 em (WinAnsiEncoding, as reportlab draws it).
_ASCII_UNITS = (  # U+0020 … U+007E
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
)
_LATIN1_UNITS = (  # U+00A0 … U+00FF
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
)
_PUNCTUATION_UNITS = {
    "–": 556, "—": 1000, "…": 1000, "€": 556, "„": 333, "“": 333, "”": 333, "‚": 222, "‘": 222, "’": 222, "•": 350,
}
#: character → advance width in 1/1000 em.
HELVETICA_UNITS: dict[str, int] = {
    **{chr(0x20 + i): units for i, units in enumerate(_ASCII_UNITS)},
    **{chr(0xA0 + i): units for i, units in enumerate(_LATIN1_UNITS)},
    **_PUNCTUATION_UNITS,
}


@dataclass(frozen=True)
class LabelFit:
    text: str        # what to draw: the text, or its prefix and "…"
    size: float      # font size, in the cell's unit
    rotated: bool    # drawn 90°, along the cell's height
    truncated: bool  # the text was cut (or nothing fitted at all)

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def text_units(text: str) -> int:
    """The text's advance width in 1/1000 em (integers: exact in both languages)."""
    total = 0
    for char in text:
        total += HELVETICA_UNITS.get(char, FALLBACK_UNITS)
    return total


def text_width(text: str, size: float, scale: float = 1.0) -> float:
    return text_units(text) / 1000 * size * scale


def _fits(units: int, size: float, length: float, cross: float, scale: float) -> bool:
    return units / 1000 * size * scale <= length + _EPS and size <= cross + _EPS


def _largest_size(units: int, length: float, cross: float, size_max: float, scale: float) -> float:
    """The largest size ≤ size_max (and ≤ cross) at which the text fits, floored to 0.1."""
    size = min(size_max, cross)
    if units > 0:
        size = min(size, length / (units / 1000 * scale))
    return math.floor(size * 10 + _EPS) / 10


def _sized(units: int, length: float, cross: float, size_max: float, size_min: float, scale: float) -> float | None:
    if _fits(units, size_max, length, cross, scale):
        return size_max
    size = _largest_size(units, length, cross, size_max, scale)
    return size if size >= size_min - _EPS and _fits(units, size, length, cross, scale) else None


def _kept(text: str, length: float, cross: float, size: float, scale: float) -> tuple[int, str]:
    """(characters kept, the cut text) at ``size``; (-1, "") when not even "…" fits.

    The count is the prefix length k before its trailing spaces are cut.
    Only U+0020 is cut (TS: ``replace(/ +$/, "")``, not ``trimEnd``, whose
    whitespace set differs from Python's), so both twins cut alike.
    """
    chars = list(text)
    for k in range(len(chars) - 1, -1, -1):
        candidate = "".join(chars[:k]).rstrip(" ") + ELLIPSIS
        if _fits(text_units(candidate), size, length, cross, scale):
            return k, candidate
    return -1, ""


def fit_label(text: str, cell_w: float, cell_h: float, size_max: float, size_min: float, scale: float = 1.0) -> LabelFit:
    """How ``text`` is drawn in a ``cell_w`` × ``cell_h`` cell (see the module doc)."""
    size_min = min(size_min, size_max)
    if not text:
        return LabelFit("", size_max, False, False)
    units = text_units(text)
    horizontal = _sized(units, cell_w, cell_h, size_max, size_min, scale)
    if horizontal is not None:
        return LabelFit(text, horizontal, False, False)
    rotated = _sized(units, cell_h, cell_w, size_max, size_min, scale)
    if rotated is not None:
        return LabelFit(text, rotated, True, False)
    flat_k, flat = _kept(text, cell_w, cell_h, size_min, scale)
    turned_k, turned = _kept(text, cell_h, cell_w, size_min, scale)
    if flat_k < 0 and turned_k < 0:
        return LabelFit("", size_min, False, True)
    if turned_k > flat_k:
        return LabelFit(turned, size_min, True, True)
    return LabelFit(flat, size_min, False, True)
