"""Render a Verteilerplan as a company-styled technical drawing PDF.

Two sheet kinds in one document:

  * **Blatt 1..n — Übersichtsschaltplan** (A4 landscape). A single-line
    diagram: supply block → main busbar → protection groups → circuits, with
    a Schriftfeld (title block) bottom-right carrying customer, project,
    board, revision, date and author. That title block is what makes the
    sheet look like the rest of the company's technical paperwork rather
    than a screenshot, and it uses the same brand blue as the
    Baustellenbericht (``construction_report_pdf._COLOR_BADGE``).
  * **Legende** (A4 portrait). The Stromkreisliste that gets glued inside
    the panel door.

Written directly on a ``canvas.Canvas`` rather than through platypus. A
schematic is absolute-positioned geometry; flowables buy nothing here and
would fight every line drawn. The trade-off is that text wrapping is manual
— hence ``_wrap``.

Sheet splitting, not shrinking
------------------------------
When a board has more circuits than fit across one sheet, the drawing is
split over several landscape sheets at full size instead of being scaled
down to fit. A Schaltplan that has been shrunk to 40 % is unreadable in a
cellar with a headlamp, which is exactly where it gets read. Groups are kept
whole on a sheet whenever they fit; a single group wider than the frame is
the only case that scales.

The geometry mirrors ``apps/web/src/components/schaltplan/PanelDiagram.tsx``
so the printed sheet and the on-screen drawing are recognisably the same
picture. They are separate implementations on purpose (one is interactive,
one is print) but the band heights and column widths are kept in step.
"""

from __future__ import annotations

from datetime import datetime
from io import BytesIO
from typing import Any, Sequence

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdfcanvas

from app.models.schaltplan import PanelPlan
from app.services.schaltplan_layout import (
    DEVICE_CATALOG,
    PANEL_TYPE_LABELS,
    build_legend,
    build_topology,
)

# Palette, fonts and the text primitives are shared with the Reihenklemmen
# sheet through schaltplan_pdf_style.py; the house names below keep the
# drawing code reading as it always has.
from app.services.schaltplan_pdf_style import (
    BLUE as _BLUE,
    BLUE_DEEP as _BLUE_DEEP,
    BLUE_TINT as _BLUE_TINT,
    FONT as _FONT,
    FONT_BOLD as _FONT_BOLD,
    GRID as _GRID,
    INK as _INK,
    LINE as _LINE,
    MUTED as _MUTED,
    WARN as _WARN,
    header_bar as _header_bar,
    text_of as _text,
    wrap as _wrap,
)
from app.services.schaltplan_pdf_terminals import draw_terminal_sheets
from app.services.schaltplan_terminals import derive_terminals

# ── Diagram geometry (points) ───────────────────────────────────────────────
_COL_W = 78.0          # one circuit column
_GROUP_GAP = 24.0      # horizontal gap between protection groups
_GROUP_MIN_W = 150.0   # a group box never narrower than its own caption
_FRAME_L = 34.0
_FRAME_R = 808.0
_Y_SUPPLY_TOP = 512.0
_Y_SUPPLY_BOT = 452.0
_Y_BUS = 434.0
_Y_GROUP_TOP = 416.0
_Y_GROUP_BOT = 378.0
_Y_SUBBUS = 362.0
_Y_DEV_TOP = 342.0
_Y_DEV_BOT = 302.0
_Y_CHIP = 288.0
_Y_TEXT = 274.0
_TITLE_BLOCK_W = 300.0
_TITLE_BLOCK_H = 116.0

# A sheet holds two bands of groups stacked vertically — the second one is a
# continuation busbar dropped from the first, the way a real drawing continues
# rather than starting a new sheet. Without it a board with four FI groups
# printed on three near-empty sheets.
#
# The drop is what band 0's deepest text needs: a circuit's stack (two label
# lines, room, cable, phase) ends at _Y_TEXT - 8.5 - 3 × 8 = 241.5, and the
# lower busbar's caption sits 11.5 pt above the bar, so the bar must be at or
# below 222 (owner's print of 2026-09-24: with 190 the caption ran through
# the cable text). 212 leaves band 1's own deepest line at 29.5, above the
# frame at 24.
_BAND_DY = 212.0
_BAND0_X0 = _FRAME_L + 240      # right of the supply block
_BAND0_X1 = _FRAME_R
_BAND1_X0 = _FRAME_L + 20
# Band 1 stops short of the Schriftfeld, which owns the bottom-right corner.
_BAND1_X1 = 496.0


def _short(kind: str) -> str:
    return str(DEVICE_CATALOG.get(kind, {}).get("short", "?"))


def _poles(device: dict[str, Any]) -> int:
    """The device's pole count, the catalog default when the document has none."""
    try:
        poles = int(device.get("poles") or 0)
    except (TypeError, ValueError):
        poles = 0
    if poles > 0:
        return poles
    return int(DEVICE_CATALOG.get(str(device.get("kind", "")), {}).get("poles", 1))


def _group_width(group: dict[str, Any]) -> float:
    children = group.get("children") or []
    return max(_GROUP_MIN_W, _COL_W * max(1, len(children)))


# ── Symbols ─────────────────────────────────────────────────────────────────


def _draw_symbol(c: pdfcanvas.Canvas, kind: str, cx: float, cy: float, poles: int = 1) -> None:
    """A 22×18 pt glyph centred on ``(cx, cy)``.

    Deliberately schematic rather than DIN-exact: at this size a strict
    EN 60617 symbol turns into a blob, and the device kind is always spelled
    out beside it anyway. The shapes only need to be distinguishable at a
    glance. A multi-pole breaker carries the EN 60617 pole mark — the short
    stroke across the lead with the count beside it — because a 1-pole and a
    3-pole LS read identically otherwise (owner's print of 2026-09-24).
    """

    symbol = str(DEVICE_CATALOG.get(kind, {}).get("symbol", "blank"))
    c.saveState()
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.1)

    if symbol in {"mcb", "rcbo", "fuse", "sls"}:
        # Breaker: a hinged contact over a break line.
        c.line(cx, cy + 9, cx, cy + 4)
        c.line(cx, cy - 9, cx, cy - 4)
        c.line(cx, cy - 4, cx + 7, cy + 4)
        if poles >= 2:
            c.setLineWidth(0.9)
            c.line(cx - 3, cy + 5.5, cx + 3, cy + 8.5)
            c.setFont(_FONT_BOLD, 5.5)
            c.setFillColor(_BLUE_DEEP)
            c.drawRightString(cx - 3.5, cy + 4.5, str(poles))
        if symbol == "fuse":
            c.rect(cx - 4, cy - 5, 8, 10, stroke=1, fill=0)
        if symbol == "sls":
            c.line(cx - 6, cy + 1, cx - 2, cy + 5)
        if symbol == "rcbo":
            c.circle(cx - 6, cy, 3.4, stroke=1, fill=0)
    elif symbol == "rcd":
        # Residual-current device: the summation transformer as a ring.
        c.circle(cx, cy, 7.0, stroke=1, fill=0)
        c.line(cx - 9, cy + 9, cx + 9, cy - 9)
    elif symbol == "switch":
        c.line(cx, cy + 9, cx, cy + 3)
        c.line(cx, cy - 9, cx, cy - 3)
        c.line(cx - 1, cy - 3, cx + 8, cy + 5)
    elif symbol == "spd":
        c.line(cx, cy + 9, cx, cy + 3)
        c.line(cx, cy - 9, cx, cy - 3)
        c.rect(cx - 5, cy - 3, 10, 6, stroke=1, fill=0)
        c.line(cx - 3, cy + 6, cx + 3, cy + 6)
    elif symbol == "meter":
        c.circle(cx, cy, 8.0, stroke=1, fill=0)
        c.setFont(_FONT_BOLD, 6)
        c.setFillColor(_BLUE_DEEP)
        c.drawCentredString(cx, cy - 2.2, "kWh")
    elif symbol == "contactor":
        c.line(cx, cy + 9, cx, cy + 3)
        c.line(cx, cy - 9, cx, cy - 3)
        c.rect(cx - 6, cy - 3, 12, 6, stroke=1, fill=0)
    elif symbol == "relay":
        c.rect(cx - 7, cy - 6, 14, 12, stroke=1, fill=0)
        c.line(cx - 7, cy + 6, cx + 7, cy - 6)
    elif symbol == "transformer":
        c.circle(cx - 3.5, cy, 5.0, stroke=1, fill=0)
        c.circle(cx + 3.5, cy, 5.0, stroke=1, fill=0)
    elif symbol == "bus":
        c.rect(cx - 8, cy - 6, 16, 12, stroke=1, fill=0)
        c.line(cx - 8, cy, cx + 8, cy)
        c.circle(cx, cy, 2.0, stroke=1, fill=1)
    elif symbol == "wallbox":
        c.rect(cx - 6, cy - 8, 12, 16, stroke=1, fill=0)
        c.line(cx - 2, cy + 2, cx + 2, cy + 2)
        c.line(cx, cy + 2, cx, cy - 4)
    elif symbol == "pv":
        c.rect(cx - 8, cy - 6, 16, 12, stroke=1, fill=0)
        c.line(cx, cy - 6, cx, cy + 6)
        c.line(cx - 8, cy, cx + 8, cy)
    elif symbol == "subfeed":
        c.line(cx - 8, cy, cx + 5, cy)
        c.line(cx + 5, cy, cx + 1, cy + 4)
        c.line(cx + 5, cy, cx + 1, cy - 4)
        c.rect(cx + 5, cy - 7, 4, 14, stroke=1, fill=0)
    elif symbol == "terminal":
        c.circle(cx - 4, cy, 2.6, stroke=1, fill=0)
        c.circle(cx + 4, cy, 2.6, stroke=1, fill=0)
        c.line(cx - 1.4, cy, cx + 1.4, cy)
    else:  # blank
        c.setStrokeColor(_GRID)
        c.rect(cx - 7, cy - 7, 14, 14, stroke=1, fill=0)

    c.restoreState()


# ── Sheet furniture ─────────────────────────────────────────────────────────


def _title_block(
    c: pdfcanvas.Canvas,
    x: float,
    y: float,
    *,
    plan: PanelPlan,
    customer_name: str | None,
    project_label: str | None,
    fed_from: str | None,
    author: str | None,
    sheet: int,
    sheets: int,
) -> None:
    """The Schriftfeld — the block every technical drawing is identified by."""

    w, h = _TITLE_BLOCK_W, _TITLE_BLOCK_H
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.0)
    c.setFillColor(colors.white)
    c.rect(x, y, w, h, stroke=1, fill=1)

    c.setFillColor(_BLUE)
    c.rect(x, y + h - 16, w, 16, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont(_FONT_BOLD, 8)
    c.drawString(x + 6, y + h - 11.5, "VERTEILER — ÜBERSICHTSSCHALTPLAN")
    c.drawRightString(x + w - 6, y + h - 11.5, f"Blatt {sheet}/{sheets}")

    rows: list[tuple[str, str]] = [
        ("Kunde", _text(customer_name) or "—"),
        ("Projekt", _text(project_label) or "—"),
        (
            "Verteiler",
            f"{plan.designation} · {plan.name}"[:52],
        ),
        (
            "Art / Ort",
            f"{PANEL_TYPE_LABELS.get(plan.panel_type, plan.panel_type)}"
            + (f" · {plan.location}" if plan.location else ""),
        ),
        ("Einspeisung von", _text(fed_from) or "Netz / HAK"),
    ]
    line_y = y + h - 28
    for label, value in rows:
        c.setFont(_FONT, 6.5)
        c.setFillColor(_MUTED)
        c.drawString(x + 6, line_y, label.upper())
        c.setFont(_FONT_BOLD, 8)
        c.setFillColor(_INK)
        c.drawString(x + 82, line_y - 0.5, _wrap(value, _FONT_BOLD, 8, w - 90, 1)[0] if value else "—")
        line_y -= 13

    c.setStrokeColor(_LINE)
    c.setLineWidth(0.5)
    c.line(x + 4, y + 20, x + w - 4, y + 20)
    c.setFont(_FONT, 6.5)
    c.setFillColor(_MUTED)
    c.drawString(x + 6, y + 11, "DATUM")
    c.drawString(x + 92, y + 11, "ERSTELLT")
    c.drawString(x + 200, y + 11, "STAND")
    c.setFont(_FONT_BOLD, 8)
    c.setFillColor(_INK)
    c.drawString(x + 6, y + 4, datetime.now().strftime("%d.%m.%Y"))
    c.drawString(x + 92, y + 4, _wrap(_text(author) or "—", _FONT_BOLD, 8, 100, 1)[0])
    status_label = "Bestand" if plan.status == "final" else "Entwurf"
    c.setFillColor(_INK if plan.status == "final" else _WARN)
    c.drawString(x + 200, y + 4, f"{status_label} · Rev. {plan.revision}")


def _supply_block(c: pdfcanvas.Canvas, plan: PanelPlan, fed_from: str | None) -> None:
    supply = (plan.document or {}).get("supply") or {}
    x, y0, y1 = _FRAME_L, _Y_SUPPLY_BOT, _Y_SUPPLY_TOP
    w = 210.0
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.0)
    c.setFillColor(_BLUE_TINT)
    c.rect(x, y0, w, y1 - y0, stroke=1, fill=1)

    c.setFillColor(_BLUE_DEEP)
    c.setFont(_FONT_BOLD, 8)
    c.drawString(x + 8, y1 - 13, "EINSPEISUNG")
    c.setFillColor(_INK)
    c.setFont(_FONT, 8)
    lines = [
        f"Netzform {_text(supply.get('system')) or '—'}   {_text(supply.get('voltage'))}",
        f"Zuleitung: {_text(supply.get('incoming')) or '—'}",
        f"Vorsicherung: {_text(supply.get('fuse')) or '—'}",
        f"Von: {_text(fed_from) or 'Hausanschluss / Netz'}",
    ]
    line_y = y1 - 26
    for line in lines:
        c.drawString(x + 8, line_y, _wrap(line, _FONT, 8, w - 16, 1)[0])
        line_y -= 10.5

    # Drop into the busbar.
    c.setLineWidth(1.6)
    c.setStrokeColor(_BLUE_DEEP)
    c.line(x + w / 2, y0, x + w / 2, _Y_BUS)


def _busbar(c: pdfcanvas.Canvas, x_start: float, x_end: float, dy: float) -> None:
    y = _Y_BUS - dy
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(2.6)
    c.line(x_start, y, max(x_end, x_start + 160), y)
    c.setFont(_FONT, 6.5)
    c.setFillColor(_MUTED)
    # Right-aligned: the supply block's drop line lands on the left end of the
    # bar, and a left-aligned caption printed straight through it.
    c.drawRightString(max(x_end, x_start + 160), y + 5, "SAMMELSCHIENE  L1 · L2 · L3 · N · PE")


def _draw_group(c: pdfcanvas.Canvas, group: dict[str, Any], x: float, dy: float = 0.0) -> float:
    """Draw one protection group and its circuits. Returns the width used."""

    device = group.get("device")
    children: Sequence[dict[str, Any]] = group.get("children") or []
    width = _group_width(group)
    y_bus = _Y_BUS - dy
    y_group_top = _Y_GROUP_TOP - dy
    y_group_bot = _Y_GROUP_BOT - dy
    y_subbus = _Y_SUBBUS - dy

    # Drop from the busbar into the group box.
    cx = x + width / 2
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.4)
    c.line(cx, y_bus, cx, y_group_top)
    # The Vorsicherung sits where it physically is: between the busbar and
    # the FI, on the drop line. Small, with a cleared background so the wire
    # does not strike through the text.
    pre_fuse = group.get("pre_fuse")
    if pre_fuse and (y_bus - y_group_top) >= 18:
        text = " ".join(p for p in (_text(pre_fuse.get("designation")), _text(pre_fuse.get("rating"))) if p) or "Si"
        c.setFont(_FONT_BOLD, 6.5)
        tw = c.stringWidth(text, _FONT_BOLD, 6.5) + 6
        ym = (y_bus + y_group_top) / 2
        c.setFillColor(colors.white)
        c.setStrokeColor(_BLUE_DEEP)
        c.setLineWidth(0.6)
        c.rect(cx - tw / 2, ym - 5, tw, 10, stroke=1, fill=1)
        c.setFillColor(_INK)
        c.drawCentredString(cx, ym - 2.5, text)

    # Group box — dashed when there is no protective device at all, because
    # "these circuits hang straight off the busbar" is a finding, not a style.
    c.setLineWidth(1.0)
    if device is None:
        c.setDash(3, 2)
        c.setStrokeColor(_WARN)
        c.setFillColor(colors.white)
    else:
        c.setDash()
        c.setStrokeColor(_BLUE_DEEP)
        c.setFillColor(_BLUE_TINT)
    c.rect(x, y_group_bot, width, y_group_top - y_group_bot, stroke=1, fill=1)
    c.setDash()

    if device is None:
        c.setFillColor(_WARN)
        c.setFont(_FONT_BOLD, 8)
        c.drawCentredString(cx, y_group_top - 15, "OHNE FI-SCHUTZ")
        c.setFont(_FONT, 7)
        c.drawCentredString(cx, y_group_top - 26, "direkt von der Sammelschiene")
    else:
        _draw_symbol(c, str(device.get("kind", "")), x + 18, (y_group_top + y_group_bot) / 2, _poles(device))
        c.setFillColor(_INK)
        c.setFont(_FONT_BOLD, 8.5)
        head = f"{_text(device.get('designation'))} {_short(str(device.get('kind','')))}".strip()
        c.drawString(x + 34, y_group_top - 15, _wrap(head, _FONT_BOLD, 8.5, width - 40, 1)[0])
        c.setFont(_FONT, 7.5)
        c.setFillColor(_MUTED)
        detail = " · ".join(
            part
            for part in (
                _text(device.get("rating")),
                f"{_poles(device)}P",
                _text(device.get("residual_current")),
                (f"Typ {_text(device.get('rcd_type'))}" if _text(device.get("rcd_type")) else ""),
            )
            if part
        )
        c.drawString(x + 34, y_group_top - 26, _wrap(detail or "—", _FONT, 7.5, width - 40, 1)[0])

    if not children:
        return width

    # Sub-busbar spanning the children.
    first_cx = x + _COL_W / 2
    last_cx = x + _COL_W * (len(children) - 0.5)
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.4)
    c.line(cx, y_group_bot, cx, y_subbus)
    c.setLineWidth(1.8)
    c.line(min(first_cx, cx), y_subbus, max(last_cx, cx), y_subbus)

    for index, child in enumerate(children):
        _draw_circuit(c, child, x + _COL_W * index, dy)

    return width


def _draw_circuit(c: pdfcanvas.Canvas, device: dict[str, Any], x: float, dy: float = 0.0) -> None:
    cx = x + _COL_W / 2
    y_subbus = _Y_SUBBUS - dy
    y_dev_top = _Y_DEV_TOP - dy
    y_dev_bot = _Y_DEV_BOT - dy
    y_chip = _Y_CHIP - dy
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.2)
    c.line(cx, y_subbus, cx, y_dev_top)

    box_w = _COL_W - 14
    c.setFillColor(colors.white)
    c.setLineWidth(0.9)
    c.rect(cx - box_w / 2, y_dev_bot, box_w, y_dev_top - y_dev_bot, stroke=1, fill=1)
    _draw_symbol(c, str(device.get("kind", "")), cx - 14, (y_dev_top + y_dev_bot) / 2, _poles(device))

    c.setFillColor(_INK)
    c.setFont(_FONT_BOLD, 7.5)
    c.drawString(cx - 2, (y_dev_top + y_dev_bot) / 2 + 3, _text(device.get("designation"))[:6] or "—")
    c.setFont(_FONT, 7)
    c.setFillColor(_MUTED)
    # "B16 · 3P": the pole count is spelled out beside the rating as well as
    # marked on the symbol — it is the one thing a 1-pole and a 3-pole LS
    # differ in, and the box is too small for the symbol alone to carry it.
    c.drawString(cx - 2, (y_dev_top + y_dev_bot) / 2 - 7, f"{_text(device.get('rating'))[:6]} · {_poles(device)}P".strip(" ·"))

    # Circuit-number chip — the one thing read first when tracing a fault.
    circuit = _text(device.get("circuit"))
    if circuit:
        chip_w = max(20.0, stringWidth(circuit, _FONT_BOLD, 8) + 12)
        c.setFillColor(_BLUE)
        c.setStrokeColor(_BLUE)
        c.roundRect(cx - chip_w / 2, y_chip - 2, chip_w, 13, 3, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont(_FONT_BOLD, 8)
        c.drawCentredString(cx, y_chip + 2, circuit)

    # Descriptive stack under the chip.
    line_y = _Y_TEXT - dy
    c.setFillColor(_INK)
    c.setFont(_FONT_BOLD, 7)
    for line in _wrap(_text(device.get("label")) or "—", _FONT_BOLD, 7, _COL_W - 8, 2):
        c.drawCentredString(cx, line_y, line)
        line_y -= 8.5

    c.setFont(_FONT, 6.5)
    c.setFillColor(_MUTED)
    for value in (_text(device.get("room")), _text(device.get("cable")), _text(device.get("phase"))):
        if not value or value == "-":
            continue
        for line in _wrap(value, _FONT, 6.5, _COL_W - 6, 1):
            c.drawCentredString(cx, line_y, line)
            line_y -= 8.0


# A laid-out sheet: two bands, each a list of groups. Band 0 sits beside the
# supply block; band 1 is the continuation below it.
Sheet = tuple[list[dict[str, Any]], list[dict[str, Any]]]


def _paginate_groups(groups: Sequence[dict[str, Any]]) -> list[Sheet]:
    """Pack groups into bands and sheets, keeping each group whole.

    Fills band 0 (full sheet width), then band 1 (narrower — it has to clear
    the Schriftfeld), then starts a new sheet. Groups are never split and
    never scaled: a group wider than a band gets its own band and simply runs
    to the frame edge, which is still readable, whereas shrinking the sheet to
    fit is not.
    """

    band0_usable = _BAND0_X1 - _BAND0_X0
    band1_usable = _BAND1_X1 - _BAND1_X0

    sheets: list[Sheet] = []
    band0: list[dict[str, Any]] = []
    band1: list[dict[str, Any]] = []
    used0 = 0.0
    used1 = 0.0

    def flush() -> None:
        nonlocal band0, band1, used0, used1
        if band0 or band1:
            sheets.append((band0, band1))
        band0, band1, used0, used1 = [], [], 0.0, 0.0

    for group in groups:
        width = _group_width(group)
        needed0 = width + (_GROUP_GAP if band0 else 0.0)
        if not band1 and (not band0 or used0 + needed0 <= band0_usable):
            band0.append(group)
            used0 += needed0
            continue
        needed1 = width + (_GROUP_GAP if band1 else 0.0)
        # Band 1 shares the sheet with the Schriftfeld, so it takes a group
        # only when the whole group fits left of it — a six-circuit FI ran its
        # last breaker under the title block (owner's print of 2026-09-24).
        # Band 0 has no such neighbour and may run to the frame edge.
        if used1 + needed1 <= band1_usable:
            band1.append(group)
            used1 += needed1
            continue
        flush()
        band0 = [group]
        used0 = width

    flush()
    return sheets or [([], [])]


def _draw_diagram_sheet(
    c: pdfcanvas.Canvas,
    *,
    plan: PanelPlan,
    sheet_groups: Sheet,
    customer_name: str | None,
    project_label: str | None,
    fed_from: str | None,
    author: str | None,
    company: str,
    sheet: int,
    sheets: int,
) -> None:
    width, height = landscape(A4)
    c.setPageSize((width, height))
    _header_bar(c, width, height, "Übersichtsschaltplan", company)

    # Drawing frame.
    c.setStrokeColor(_LINE)
    c.setLineWidth(0.8)
    c.rect(24, 24, width - 48, height - 24 - 44, stroke=1, fill=0)

    _supply_block(c, plan, fed_from)

    band0, band1 = sheet_groups

    def band_extent(band: Sequence[dict[str, Any]], x0: float) -> float:
        if not band:
            return x0
        return x0 + sum(_group_width(g) for g in band) + _GROUP_GAP * (len(band) - 1)

    _busbar(c, _FRAME_L, band_extent(band0, _BAND0_X0), 0.0)
    x = _BAND0_X0
    for group in band0:
        x += _draw_group(c, group, x, 0.0) + _GROUP_GAP

    if band1:
        # Continuation: drop from the main busbar down the left margin into a
        # second busbar, then carry on. Same convention as a "weiter Blatt"
        # arrow, but without leaving the sheet.
        c.setStrokeColor(_BLUE_DEEP)
        c.setLineWidth(1.6)
        c.line(_FRAME_L + 6, _Y_BUS, _FRAME_L + 6, _Y_BUS - _BAND_DY)
        _busbar(c, _FRAME_L + 6, band_extent(band1, _BAND1_X0), _BAND_DY)
        x = _BAND1_X0
        for group in band1:
            x += _draw_group(c, group, x, _BAND_DY) + _GROUP_GAP

    if not band0 and not band1:
        c.setFont(_FONT, 10)
        c.setFillColor(_MUTED)
        c.drawString(_BAND0_X0 + 10, _Y_GROUP_TOP - 20, "Noch keine Stromkreise erfasst.")

    _title_block(
        c,
        width - 24 - _TITLE_BLOCK_W - 10,
        34,
        plan=plan,
        customer_name=customer_name,
        project_label=project_label,
        fed_from=fed_from,
        author=author,
        sheet=sheet,
        sheets=sheets,
    )
    c.showPage()


# ── Legend sheet ────────────────────────────────────────────────────────────

_LEGEND_COLUMNS: list[tuple[str, str, float]] = [
    ("circuit", "Nr.", 26),
    ("designation", "BMK", 34),
    ("label", "Verbraucher / Bezeichnung", 84),
    ("room", "Raum", 60),
    ("device", "Gerät", 52),
    ("rating", "Absicherung", 52),
    ("rcd", "FI / RCD", 60),
    # Same total width as before: the Klemmen column took 20 from the
    # description and 30 from the cable column, so the sheet that gets glued
    # in the door keeps its layout.
    ("pre_fuse", "Vorsich.", 40),
    ("cable", "Leitung", 50),
    ("phase", "Ph.", 26),
    ("terminals", "Klemmen", 50),
]


def _legend_header(c: pdfcanvas.Canvas, y: float, x0: float) -> None:
    c.setFillColor(_BLUE_TINT)
    c.setStrokeColor(_LINE)
    c.setLineWidth(0.5)
    total = sum(col[2] for col in _LEGEND_COLUMNS)
    c.rect(x0, y - 4, total, 16, stroke=1, fill=1)
    c.setFillColor(_BLUE_DEEP)
    c.setFont(_FONT_BOLD, 7)
    x = x0
    for _key, title, w in _LEGEND_COLUMNS:
        c.drawString(x + 3, y + 2, title)
        x += w


def _draw_legend_sheets(
    c: pdfcanvas.Canvas,
    *,
    plan: PanelPlan,
    rows: Sequence[dict[str, str]],
    customer_name: str | None,
    project_label: str | None,
    company: str,
) -> None:
    width, height = A4
    total = sum(col[2] for col in _LEGEND_COLUMNS)
    x0 = (width - total) / 2

    def start_page(page_no: int) -> float:
        c.setPageSize((width, height))
        _header_bar(c, width, height, "Stromkreisliste / Legende", company)
        c.setFillColor(_INK)
        c.setFont(_FONT_BOLD, 11)
        c.drawString(x0, height - 58, f"{plan.designation} — {plan.name}")
        c.setFont(_FONT, 8)
        c.setFillColor(_MUTED)
        meta = " · ".join(
            part
            for part in (
                _text(customer_name),
                _text(project_label),
                _text(plan.location),
                f"Rev. {plan.revision}",
                datetime.now().strftime("%d.%m.%Y"),
            )
            if part
        )
        c.drawString(x0, height - 70, _wrap(meta, _FONT, 8, total, 1)[0] if meta else "")
        if page_no > 1:
            c.drawRightString(x0 + total, height - 70, f"Seite {page_no}")
        header_y = height - 92
        _legend_header(c, header_y, x0)
        return header_y - 16

    page_no = 1
    y = start_page(page_no)

    if not rows:
        c.setFont(_FONT, 9)
        c.setFillColor(_MUTED)
        c.drawString(x0 + 3, y - 4, "Noch keine Stromkreise erfasst.")
        c.showPage()
        return

    for index, row in enumerate(rows):
        # Row height grows with the tallest wrapped cell so nothing is clipped.
        cell_lines: list[list[str]] = []
        for key, _title, w in _LEGEND_COLUMNS:
            value = _text(row.get(key))
            if key == "device" and _text(row.get("poles")):
                # "LS · 3P": the pole count is the one thing two breakers of
                # the same rating differ in, so the legend says it too.
                value = f"{value} · {_text(row.get('poles'))}P".strip(" ·")
            cell_lines.append(_wrap(value, _FONT, 7.5, w - 6, 3))
        row_h = max(13.0, 4 + 9.0 * max((len(lines) for lines in cell_lines), default=1))

        if y - row_h < 56:
            c.showPage()
            page_no += 1
            y = start_page(page_no)

        if index % 2 == 1:
            c.setFillColor(colors.HexColor("#f6f9fd"))
            c.rect(x0, y - row_h + 9, total, row_h, stroke=0, fill=1)

        c.setStrokeColor(_GRID)
        c.setLineWidth(0.4)
        c.line(x0, y - row_h + 9, x0 + total, y - row_h + 9)

        x = x0
        for (key, _title, w), lines in zip(_LEGEND_COLUMNS, cell_lines):
            c.setFillColor(_INK if key in {"circuit", "label"} else _MUTED)
            c.setFont(_FONT_BOLD if key == "circuit" else _FONT, 7.5)
            text_y = y
            for line in lines or ["—"]:
                c.drawString(x + 3, text_y, line)
                text_y -= 9.0
            x += w
        y -= row_h

    # Column separators are drawn once per page bottom-up would need tracking;
    # the horizontal rules plus alternating fills already carry the grid, and
    # a light vertical set here would land on the last page only. Left out on
    # purpose rather than drawn wrong.
    c.setFillColor(_MUTED)
    c.setFont(_FONT, 7)
    c.drawString(x0, 44, f"{len(rows)} Stromkreise · erstellt mit der SMPL Workflow-App")
    c.showPage()


# ── Entry point ─────────────────────────────────────────────────────────────


def build_panel_plan_pdf(
    *,
    plan: PanelPlan,
    customer_name: str | None = None,
    project_label: str | None = None,
    fed_from: str | None = None,
    author: str | None = None,
    company_name: str | None = None,
    legend_only: bool = False,
    terminals_only: bool = False,
) -> bytes:
    """Render the plan. Returns PDF bytes; never writes to disk.

    The full document is diagram sheets, the legend, and — only when the
    board has at least one Reihenklemme — the terminal sheet. ``legend_only``
    and ``terminals_only`` each print just their sheet; ``terminals_only``
    wins when both are set, because the Klemmen tab is the only caller that
    sets it and it wants exactly that page.
    """

    document = plan.document or {}
    company = (company_name or "SMPL").strip() or "SMPL"
    terminal_groups = derive_terminals(document)

    buffer = BytesIO()
    c = pdfcanvas.Canvas(buffer, pagesize=landscape(A4))
    c.setTitle(f"Schaltplan {plan.designation} — {plan.name}")
    c.setAuthor(company)

    def terminal_sheet() -> None:
        draw_terminal_sheets(
            c,
            plan=plan,
            document=document,
            groups=terminal_groups,
            customer_name=customer_name,
            project_label=project_label,
            company=company,
        )

    if terminals_only:
        terminal_sheet()
        c.save()
        return buffer.getvalue()

    if not legend_only:
        pages = _paginate_groups(build_topology(document)["groups"])
        for index, page_groups in enumerate(pages, start=1):
            _draw_diagram_sheet(
                c,
                plan=plan,
                sheet_groups=page_groups,
                customer_name=customer_name,
                project_label=project_label,
                fed_from=fed_from,
                author=author,
                company=company,
                sheet=index,
                sheets=len(pages),
            )

    _draw_legend_sheets(
        c,
        plan=plan,
        rows=build_legend(document),
        customer_name=customer_name,
        project_label=project_label,
        company=company,
    )

    # Never behind the door sheet: legend_only is the one-sided Stromkreisliste
    # glued inside the panel door, and a terminal list behind it would be
    # printed and thrown away.
    if terminal_groups and not legend_only:
        terminal_sheet()

    c.save()
    return buffer.getvalue()
