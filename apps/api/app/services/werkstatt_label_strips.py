"""Marking strips on continuous stock — rail BMK strips and terminal Block labels.

Moved out of ``werkstatt_labels`` unchanged (docs/PANEL_ENCLOSURE_R4.md §9,
the 800-line cap); ``werkstatt_labels`` re-exports every name, so callers and
tests keep ``wl._render_rail_strip``, ``wl.print_marking_strips`` and
``wl.MARKING_STRIP_MATERIAL_ID``. The §14a strip with vertical text lives in
``werkstatt_label_control_strip`` and goes out through ``print_marking_strips``
as the last job of the same connection.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from sqlalchemy.orm import Session

from app.services.schaltplan_layout import text_width_em
from app.services.werkstatt_label_errors import LabelFormatUnsupported
from app.services.werkstatt_label_frame import _ENCODING, _at, _clean, _Frame, _frame, _sheet
from app.services.werkstatt_label_materials import material_by_id
from app.services.werkstatt_label_profile import PHYSICAL_DOTS_PER_MM, MaterialProfile, dots_to_mm, mm_to_dots

if TYPE_CHECKING:  # the control strip imports this module
    from app.services.werkstatt_label_control_strip import ControlStrip

MARKING_STRIP_MATERIAL_ID = "wago-2009-110"


_STRIP_LEAD_MM = 3  # unprintable-ish lead before the start line and after the end line
_STRIP_LINE = 1  # divider half-thickness in dots (2 dots total)
_STRIP_END_LINE = 2  # start/end half-thickness (4 dots total): the rail cut
_STRIP_TEXT_GUARD = 2  # a text never starts closer than this to its segment's cut line

# Where the capitals sit inside the built-in TTF's em box, as fractions of the
# font size: the cap band begins CAP_TOP_RATIO below the em top and is
# CAP_HEIGHT_RATIO tall (Arial: cap height 1467/2048 = 0.716). A BMK is all
# capitals and digits, so centring that BAND across the strip — not the em
# box, which carries descender room the text never uses — is what puts "F1.1"
# visually in the middle of an 11 mm strip. CAP_TOP_RATIO is a calibration
# constant: if a physical print sits a hair high or low, this is the number
# to adjust, not the formula.
CAP_TOP_RATIO = 0.19
CAP_HEIGHT_RATIO = 0.716


def _solid(frame: _Frame, reading_x: int, *, half: int) -> str:
    """A solid vertical cut mark across the whole strip at reading x."""
    return f"Lo,{frame.xm(frame.h_px)},{frame.ym(reading_x) - half},{frame.xm(0)},{frame.ym(reading_x) + half}"


def _strip_text_w(text: str, size: int) -> float:
    """Width of a strip text in dots, from the per-glyph advance table."""
    return size * text_width_em(text)


def _strip_text_top(h_px: int, size: int) -> int:
    """Reading-frame top edge that centres the text's cap band across the strip."""
    return max(0, int(round(h_px / 2 - size * (CAP_TOP_RATIO + CAP_HEIGHT_RATIO / 2))))


def _render_rail_strip(
    profile: MaterialProfile, segments: list[tuple[str, float]], *, size: int
) -> list[str]:
    """One rail on continuous stock: every labelled device's BMK inside its real width.

    The strip is laid along the rail and cut at the marks, so geometry is the
    whole point: segment widths are the devices' mounted widths in mm, a
    divider sits on every boundary, and the rail's start and end carry a
    heavier line. Every segment carries text — a blank cover or a device
    without a BMK gets no segment at all (``schaltplan_layout.strip_segments``
    drops them), so the strip continues with the next labelled device.

    ``size`` is the board-wide font size from ``schaltplan_layout.board_font_size``.
    Nothing is fitted here: every rail of a board prints at the same size, and
    each text is centred in its segment both ways — horizontally on its real
    glyph width, vertically on the capitals' band.

    Three millimetres of lead on either side keep the end marks inside the
    printable area. The label length includes the material's x-offset as
    well: the print origin sits that far before the label's edge, so without
    it the trailing lead shrank by the offset and the end line landed on the
    tear edge.
    """
    if not segments:
        raise ValueError("a strip needs at least one segment")
    if size < 1:
        raise ValueError("font size must be positive")
    h_px = mm_to_dots(profile.width_mm)
    total_mm = sum(width for _, width in segments)
    w_px = mm_to_dots(_STRIP_LEAD_MM + total_mm + _STRIP_LEAD_MM)
    frame = _frame(profile, w_px=w_px)
    top = _strip_text_top(h_px, size)

    # Millimetres accumulate; every mark is converted on its own — never a
    # sum of rounded segment widths, which drifts along a long rail.
    edge_mm = float(_STRIP_LEAD_MM)
    lines: list[str] = [_solid(frame, mm_to_dots(edge_mm), half=_STRIP_END_LINE)]
    for index, (text, width_mm) in enumerate(segments):
        if text:
            centred = mm_to_dots(edge_mm + (width_mm - dots_to_mm(_strip_text_w(text, size))) / 2)
            left = max(mm_to_dots(edge_mm) + _STRIP_TEXT_GUARD, centred)
            lines.append(_at(frame, left, top, size, text))
        edge_mm += width_mm
        if index < len(segments) - 1:
            lines.append(_solid(frame, mm_to_dots(edge_mm), half=_STRIP_LINE))
    lines.append(_solid(frame, mm_to_dots(edge_mm), half=_STRIP_END_LINE))
    return _sheet(profile, lines, length_dots=w_px + frame.x_offset_px)


# ── Block label (the owner's "PV Block" blueprint on the 2009-110) ──────────
#
# One piece the width of a 16 mm² terminal block (5 × 12 mm), three rows on
# the 11 mm strip: the consumer's name, the X number, one cell per terminal
# (N L1 L2 L3 PE). Rows are the blueprint's thirds; each row's text is
# centred on its cap band within its third, the cells additionally divided
# by short marks in the bottom third only, so the two text rows read across
# the whole block.
_BLOCK_ROW_SIZE_MAX = 34
_BLOCK_ROW_SIZE_MIN = 18
_BLOCK_ROWS = 3
TERMINAL_BLOCK_PAD_DOTS = mm_to_dots(0.5)  # 6 dots
# The block's own rules — between the rows and between the cells — are a
# shade heavier than the strip's dividers (owner, on the first print). Its
# text is the regular weight like every other strip text: both an
# overprinted fake bold and the font engine's own bold (style "B" in the AT
# command, EZPL manual p. 40) smeared on the 11 mm strip (2026-09-23).
_BLOCK_LINE = 2  # half-thickness in dots (4 dots total)


def _vline(frame: _Frame, reading_x: int, reading_y0: int, reading_y1: int, *, half: int) -> str:
    """A vertical mark between two reading-frame heights at reading x."""
    return f"Lo,{frame.xm(reading_y1)},{frame.ym(reading_x) - half},{frame.xm(reading_y0)},{frame.ym(reading_x) + half}"


def _hline(frame: _Frame, reading_x0: int, reading_x1: int, reading_y: int, *, half: int) -> str:
    """A horizontal rule from reading x0 to x1 at reading y."""
    return f"Lo,{frame.xm(reading_y + half)},{frame.ym(reading_x0)},{frame.xm(reading_y - half)},{frame.ym(reading_x1)}"


def _block_text(frame: _Frame, reading_x: int, reading_y: int, size: int, text: str) -> list[str]:
    """One block text, regular weight — see the note on _BLOCK_LINE."""
    return [_at(frame, reading_x, reading_y, size, text)]


def _fit_strip_text(text: str, budget_px: float, size_max: int, size_min: int) -> int:
    em = text_width_em(text) or 0.6
    return max(size_min, min(size_max, int(budget_px / em)))


def _row_top(row: int, row_h: int, size: int) -> int:
    """Reading-frame top edge that centres the cap band in the row's band."""
    return max(0, int(round(row * row_h + row_h / 2 - size * (CAP_TOP_RATIO + CAP_HEIGHT_RATIO / 2))))


def _render_block_label(
    profile: MaterialProfile, *, name: str, x_label: str, cells: list[tuple[str, float]]
) -> list[str]:
    """The block label: end marks, three rows, cell marks in the bottom row."""
    if not cells:
        raise ValueError("a block needs at least one cell")
    h_px = mm_to_dots(profile.width_mm)
    total_mm = sum(width for _, width in cells)
    start, end = mm_to_dots(_STRIP_LEAD_MM), mm_to_dots(_STRIP_LEAD_MM + total_mm)
    w_px = mm_to_dots(_STRIP_LEAD_MM + total_mm + _STRIP_LEAD_MM)
    frame = _frame(profile, w_px=w_px)
    row_h = h_px // _BLOCK_ROWS
    # The text rows fit the block's length as one number of dots — the
    # editor's twin (blockRowSizeDots) sizes against the same one.
    budget = mm_to_dots(total_mm) - 2 * _STRIP_TEXT_GUARD - 2 * TERMINAL_BLOCK_PAD_DOTS

    lines: list[str] = [_solid(frame, start, half=_STRIP_END_LINE)]
    for row, text in enumerate((name, x_label)):
        text = _clean(text, 40)
        if not text:
            continue
        size = _fit_strip_text(text, budget, _BLOCK_ROW_SIZE_MAX, _BLOCK_ROW_SIZE_MIN)
        left = mm_to_dots(_STRIP_LEAD_MM + (total_mm - dots_to_mm(_strip_text_w(text, size))) / 2)
        lines.extend(_block_text(frame, left, _row_top(row, row_h, size), size, text))
    # Two rules between the three rows, the width of the block.
    for row in (1, 2):
        lines.append(_hline(frame, start, end, row * row_h, half=_BLOCK_LINE))
    edge_mm = float(_STRIP_LEAD_MM)
    cell_row_y0 = 2 * row_h
    for index, (text, width_mm) in enumerate(cells):
        text = _clean(text, 12)
        if text:
            cell_dots = width_mm * PHYSICAL_DOTS_PER_MM
            size = _fit_strip_text(text, cell_dots - 2 * TERMINAL_BLOCK_PAD_DOTS, _BLOCK_ROW_SIZE_MAX, _BLOCK_ROW_SIZE_MIN)
            centred = mm_to_dots(edge_mm + (width_mm - dots_to_mm(_strip_text_w(text, size))) / 2)
            left = max(mm_to_dots(edge_mm) + _STRIP_TEXT_GUARD, centred)
            lines.extend(_block_text(frame, left, _row_top(2, row_h, size), size, text))
        edge_mm += width_mm
        if index < len(cells) - 1:
            lines.append(_vline(frame, mm_to_dots(edge_mm), cell_row_y0, h_px, half=_BLOCK_LINE))
    lines.append(_solid(frame, end, half=_STRIP_END_LINE))
    return _sheet(profile, lines, length_dots=w_px + frame.x_offset_px)


def print_marking_strips(
    db: Session,
    *,
    strips: list[list[tuple[str, float]]],
    material_id: str = MARKING_STRIP_MATERIAL_ID,
    size: int,
    blocks: list[dict[str, Any]] | None = None,
    control: ControlStrip | None = None,
) -> tuple[int, str]:
    """Print the BMK of rails, in ONE connection, on the named material.

    Each inner list is one rail: ``(text, width_mm)`` per labelled device in
    physical order. A segment whose text cleans to nothing is dropped, the
    same way the layout drops blank covers and unnamed devices. On continuous
    stock every rail becomes one strip with cut marks and every text prints
    at the board-wide ``size`` (dots); on die-cut stock (the 210-805) every
    BMK becomes one label fitted on its own, and the widths and ``size`` are
    irrelevant. Either way the output comes off the printer in the order it
    goes onto the board. ``control`` is the §14a block strip, always the
    last job; its named labels count as printed. Returns (labels_printed, "host:port").
    """
    # werkstatt_labels re-exports this module and the control strip imports
    # it, so both are read at call time.
    from app.services import werkstatt_labels as wl
    from app.services.werkstatt_label_control_strip import render_control_strip

    profile = material_by_id(db, material_id)
    jobs: list[list[str]] = []
    printed = 0
    for rail in strips:
        cleaned = [(_clean(text, 40), float(width)) for text, width in rail]
        labelled = [(text, width) for text, width in cleaned if text]
        if not labelled:
            continue
        printed += len(labelled)
        if profile.continuous:
            jobs.append(_render_rail_strip(profile, labelled, size=size))
        else:
            jobs.extend(wl._render_mini(profile, text) for text, _ in labelled)
    # The terminal Block labels — continuous stock only, after the strips.
    for block in blocks or []:
        if not profile.continuous:
            raise LabelFormatUnsupported("Klemmenblock-Etiketten werden nur auf Endlosstreifen gedruckt.")
        cells = [(str(text), float(width)) for text, width in block.get("cells") or []]
        if not cells:
            continue
        printed += len(cells)
        jobs.append(_render_block_label(profile, name=str(block.get("name") or ""), x_label=str(block.get("x_label") or ""), cells=cells))
    # The §14a block strip — continuous stock only, the very last piece.
    if control is not None:
        if not profile.continuous:
            raise LabelFormatUnsupported("Die §14a-Klemmleiste wird nur auf Endlosstreifen gedruckt.")
        printed += sum(1 for label in control.labels if _clean(label, 40))
        jobs.append(render_control_strip(profile, control.labels, size=control.size))
    if not jobs:
        raise ValueError("nothing to print")
    payload = b"".join(("\r\n".join(job) + "\r\n").encode(_ENCODING) for job in jobs)
    printer = wl._ship(db, payload)
    wl.logger.info(
        "Marking strips sent to %s — %d job(s), %d label(s), %d bytes",
        printer, len(jobs), printed, len(payload),
    )
    return printed, printer
