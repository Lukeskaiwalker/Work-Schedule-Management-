"""The §14a block on the printer: the strip with vertical text and the wire labels.

docs/PANEL_ENCLOSURE_R4.md §9.1–§9.2. Twin of the size rule and the
predicates in ``apps/web/src/utils/schaltplanStrip.ts`` (fixture table
``control_strip_size``); the geometry is the printer's alone.

**The block strip** (``control:block``) goes onto the same solid WAGO
2009-110 as the other markers: one 5,2 mm segment per 2002-1671, the 3 mm
lead, cut marks and end marks of every strip. A 5,2 mm segment cannot hold
"UNSM" along the feed even at the 24-dot minimum, so the labels are written
across the strip, reading **bottom → top** (owner, 2026-10-26). A blank label
prints an empty segment. A label that does not fit at 24 dots is never
printed: the dialog disables the strip, the server answers 400.

**The wire labels** (``control:wires``) are the existing rail strip on the
block's own heat-shrink tube: every named terminal twice (one sleeve at each
end of the wire), ``WIRE_LABEL_PIECE_MM`` each.

The geometry is laid out in the reading frame and converted once. Which AT
rotation digit makes the text read bottom → top is a hypothesis
(``VERTICAL_ROTATION``, ungeprüft) until the test print T-V1; only that
constant changes, both candidate anchors print into the same em box.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from app.services.panel_enclosure_control_block import (
    CONTROL_LABEL_MAX,
    CONTROL_PARTS,
    DEFAULT_CONTROL_LABELS,
    PART_TERMINAL,
    WIRE_LABEL_MAX_DOTS,
    WIRE_LABEL_PIECE_MM,
    default_control_block,
    stored_block,
)
from app.services.schaltplan_layout import (
    GLYPH_ADVANCE_EM,
    GLYPH_ADVANCE_FALLBACK_EM,
    STRIP_MIN_SIZE_DOTS,
    STRIP_SEG_PAD_DOTS,
    font_size_for_fits,
    text_width_em,
)
from app.services.werkstatt_label_frame import _clean, _Frame, _frame, _sheet, at_line
from app.services.werkstatt_label_profile import PHYSICAL_DOTS_PER_MM, MaterialProfile, mm_to_dots
from app.services.werkstatt_label_strips import (
    _STRIP_END_LINE,
    _STRIP_LEAD_MM,
    _STRIP_LINE,
    _STRIP_TEXT_GUARD,
    CAP_HEIGHT_RATIO,
    CAP_TOP_RATIO,
    MARKING_STRIP_MATERIAL_ID,
    _render_rail_strip,
    _solid,
)

CONTROL_STRIP_ID = "control:block"
WIRE_STRIP_ID = "control:wires"
CONTROL_STRIP_LABEL = "§14a-Klemmleiste"
WIRE_STRIP_LABEL = "Aderbeschriftung"
CONTROL_STRIP_MATERIAL_ID = MARKING_STRIP_MATERIAL_ID

CONTROL_SEGMENT_MM = CONTROL_PARTS[PART_TERMINAL].width_mm  # one 2002-1671
CONTROL_STRIP_HEIGHT_MM = 11  # the 2009-110 across the head: the text's run
CONTROL_STRIP_MAX_DOTS = 48
# The em box lies along the feed inside the 5,2 mm segment, clear of its cut marks.
CONTROL_STRIP_CAP_DOTS = min(CONTROL_STRIP_MAX_DOTS, mm_to_dots(CONTROL_SEGMENT_MM) - 2 * _STRIP_TEXT_GUARD)
CONTROL_LABEL_MIN_DOTS = STRIP_MIN_SIZE_DOTS  # 2 mm capitals, as on every strip

CONTROL_STALE_DETAIL = (
    "Die §14a-Klemmleiste wurde geändert oder entfernt — nichts gedruckt. "
    "Bitte die Seite neu laden und erneut drucken."
)
NO_WIRE_LABELS_DETAIL = "Keine Aderbeschriftung — erst Klemmen benennen."


def label_too_long_detail(label: str) -> str:
    return f"„{label}“ ist zu lang für die Klemme — in der §14a-Klemmleiste kürzen."


def _round1(value: float) -> float:
    return math.floor(value * 10 + 0.5) / 10


# ── The predicate ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ControlStrip:
    """The block strip of a board: every terminal's label, left → right."""

    labels: tuple[str, ...]
    size: int  # dots, ``control_strip_size(labels)``
    strip_id: str = CONTROL_STRIP_ID

    @property
    def part_count(self) -> int:
        return len(self.labels)

    @property
    def blank_count(self) -> int:
        return sum(1 for label in self.labels if not label)

    @property
    def length_mm(self) -> float:
        total = 0.0
        for _ in self.labels:
            total += CONTROL_SEGMENT_MM
        return _round1(total)


def printed_label(label: str) -> str:
    """A label as the printer prints it (``_clean``): ``~``/``^`` and controls blanked.

    Twin: ``printedLabel`` in schaltplanControlStrip.ts. Counts, sizes and the
    preview all read this, so "A^B" is measured and shown as "A B" and a label
    of only "~" is blank.
    """
    return _clean(label, CONTROL_LABEL_MAX)


def control_strip(document: Any) -> ControlStrip | None:
    """The strip exists iff the parsed block exists, is not off and has a terminal.

    Read only through ``parse_control_block`` (``stored_block``); no
    catalogue is needed — the strip is printed whether the block sits yet.
    The labels are the printed ones (``printed_label``).
    """
    block = stored_block(document)
    if block is None or block["off"] or not block["terminals"]:
        return None
    labels = tuple(printed_label(terminal["label"]) for terminal in block["terminals"])
    return ControlStrip(labels=labels, size=control_strip_size(labels))


# ── Size (twinned: controlStripSize, controlLabelFits) ─────────────────────


def control_strip_em(text: str) -> float:
    """The advance in em, summed left → right (the twin's loop, not ``sum()``)."""
    total = 0.0
    for ch in text:
        total += GLYPH_ADVANCE_EM.get(ch, GLYPH_ADVANCE_FALLBACK_EM)
    return total


def control_strip_budget_dots() -> float:
    """The run across the strip: 11 mm less the BMK pad at both edges."""
    return CONTROL_STRIP_HEIGHT_MM * PHYSICAL_DOTS_PER_MM - 2 * STRIP_SEG_PAD_DOTS


def control_strip_size(labels: Iterable[str]) -> int:
    """ONE size for the strip: the tightest label's fit, at most 48 and the segment."""
    budget = control_strip_budget_dots()
    tightest: float | None = None
    for label in labels:
        if not label:
            continue
        fit = budget / control_strip_em(label)
        tightest = fit if tightest is None or fit < tightest else tightest
    if tightest is None:
        return CONTROL_STRIP_MAX_DOTS
    return min(math.floor(tightest), CONTROL_STRIP_CAP_DOTS)


def control_label_fits(label: str) -> bool:
    """A blank label always fits (it prints an empty segment)."""
    if not label:
        return True
    return math.floor(control_strip_budget_dots() / control_strip_em(label)) >= CONTROL_LABEL_MIN_DOTS


def first_too_long(labels: Iterable[str]) -> str | None:
    return next((label for label in labels if not control_label_fits(label)), None)


# ── Geometry (the printer's) ───────────────────────────────────────────────


@dataclass(frozen=True)
class _VerticalText:
    """One label in the reading frame: the advance from ``y0`` up to ``y0 − w``,
    the em box from ``em_left`` to ``em_left + size`` along the feed."""

    text: str
    size: int
    y0: int
    w: float
    em_left: int

    @property
    def advance(self) -> int:
        return math.ceil(self.w)


def _round_half_up(value: float) -> int:
    return math.floor(value + 0.5)


def _vertical_text(h_px: int, centre_mm: float, size: int, text: str) -> _VerticalText:
    """The cap band centred on the segment, the advance centred across the strip."""
    w = size * text_width_em(text)
    cx = mm_to_dots(centre_mm)
    return _VerticalText(
        text=text,
        size=size,
        y0=_round_half_up(h_px / 2 + w / 2),
        w=w,
        em_left=_round_half_up(cx - size * (CAP_TOP_RATIO + CAP_HEIGHT_RATIO / 2)),
    )


# The AT anchor per rotation digit, in machine dots. "0" is the machine's own
# direction: the advance runs +x from the reading bottom (x_machine = h −
# y_reading). "2" is the half turn: it starts at the reading top. Both put
# the em box at machine x [xm(y0), xm(y0) + ceil(w)], y [ym(em_left), + size].
VERTICAL_ANCHORS: dict[str, Callable[[_Frame, _VerticalText], tuple[int, int]]] = {
    "0": lambda frame, t: (frame.xm(t.y0), frame.ym(t.em_left)),
    "2": lambda frame, t: (frame.xm(t.y0 - t.advance), frame.ym(t.em_left + t.size)),
}
# ungeprüft: bottom → top is a machine advance of +x if the validated
# x_machine = h − y_reading holds for rotation "0" too. Test print T-V1.
VERTICAL_ROTATION = "0"


def _vertical_at(frame: _Frame, text: _VerticalText) -> str:
    x, y = VERTICAL_ANCHORS[VERTICAL_ROTATION](frame, text)
    return at_line(x, y, text.size, text.text, rotation=VERTICAL_ROTATION)


def render_control_strip(profile: MaterialProfile, labels: Iterable[str], *, size: int) -> list[str]:
    """The block strip: one segment per terminal, every label across it."""
    labels = tuple(labels)
    if not labels:
        raise ValueError("a strip needs at least one segment")
    if size < 1:
        raise ValueError("font size must be positive")
    total_mm = 0.0
    for _ in labels:
        total_mm += CONTROL_SEGMENT_MM
    h_px = mm_to_dots(profile.width_mm)
    w_px = mm_to_dots(_STRIP_LEAD_MM + total_mm + _STRIP_LEAD_MM)
    frame = _frame(profile, w_px=w_px)
    edge_mm = float(_STRIP_LEAD_MM)
    lines: list[str] = [_solid(frame, mm_to_dots(edge_mm), half=_STRIP_END_LINE)]
    for index, label in enumerate(labels):
        text = _clean(label, CONTROL_LABEL_MAX)
        if text:
            lines.append(_vertical_at(frame, _vertical_text(h_px, edge_mm + CONTROL_SEGMENT_MM / 2, size, text)))
        edge_mm += CONTROL_SEGMENT_MM
        if index < len(labels) - 1:
            lines.append(_solid(frame, mm_to_dots(edge_mm), half=_STRIP_LINE))
    lines.append(_solid(frame, mm_to_dots(edge_mm), half=_STRIP_END_LINE))
    return _sheet(profile, lines, length_dots=w_px + frame.x_offset_px)


def control_strip_sample(profile: MaterialProfile) -> list[str]:
    """The default block (``dry_render_samples``, golden ``control_strip_default``)."""
    return render_control_strip(profile, DEFAULT_CONTROL_LABELS, size=control_strip_size(DEFAULT_CONTROL_LABELS))


# ── Aderbeschriftung (§9.2) ────────────────────────────────────────────────


def wire_label_segments(document: Any) -> list[tuple[str, float]] | None:
    """Every named terminal twice, left → right, one sleeve each; None = nothing to print."""
    block = stored_block(document)
    if block is None or block["off"]:
        return None
    segments: list[tuple[str, float]] = []
    for terminal in block["terminals"]:
        label = printed_label(terminal["label"])
        if label:
            segments += [(label, WIRE_LABEL_PIECE_MM), (label, WIRE_LABEL_PIECE_MM)]
    return segments or None


def wire_label_size(segments: list[tuple[str, float]], profile: MaterialProfile) -> tuple[int, list[str]]:
    """The rail strip's fit on the tube, at most ``WIRE_LABEL_MAX_DOTS``; and what overflows."""
    size, overflowing = font_size_for_fits(segments, profile.width_mm, pad_dots=STRIP_SEG_PAD_DOTS)
    return min(size, WIRE_LABEL_MAX_DOTS), overflowing


def wire_labels_sample(profile: MaterialProfile) -> list[str]:
    """The default block's wire labels (``dry_render_samples`` on a tube, golden ``wire_labels_default``)."""
    segments = wire_label_segments({"enclosure": {"control_block": default_control_block()}}) or []
    return _render_rail_strip(profile, segments, size=wire_label_size(segments, profile)[0])
