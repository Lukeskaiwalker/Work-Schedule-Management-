"""The §14a page of the Aufbau PDF (docs/PANEL_ENCLOSURE_R4.md §9.4).

One A4 landscape page when the block is placed (``control_block_layout``),
after the close-up page of its field (and that page's legend), else right
after page 1 (``with_control_page``). It carries the round-2 furniture: the
title, **Maßstab 1:1 (Breite)** and the **Kontrollmaß 100 mm**, so a fitter
can hold the sheet against the AAR rail.

The rail is drawn **1:1 across**: its usable length, the devices already on
it as one grey band, and the block right-aligned where the placement puts
it — 249-116, one 2002-1671 per terminal, 2002-1692, 249-116, each at its
true offset and width. Above every 2002-1671 its marker on the 11 mm strip,
turned to read bottom → top (as it is printed, §9.1), 6 pt down to 5 pt and
cut with "…" (``label_fit``); below it a 6 mm stub in the wire's colour and
the terminal number. Then a table: Klemme · Bezeichnung · Aderfarbe · Ziel ·
Lüsterklemme, and the footer naming the heat-shrink tube.

Laid out as plain data on the close-up pages' ``Sheet`` before anything is
drawn, so a test can hold every string against its cell. Labels are user
input: text only through ``drawString`` and friends.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Mapping

from reportlab.lib import colors

from app.models.schaltplan import PanelPlan
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_control_block import (
    PART_PLATE,
    PART_TERMINAL,
    WIRE_COLOUR_STYLE,
    BlockLayout,
    control_block_layout,
    stored_block,
)
from app.services.panel_enclosure_geometry import mm_text
from app.services.panel_enclosure_pdf_terminal_sheet import (
    BOTTOM,
    MARGIN,
    MM,
    TOP,
    USABLE_W,
    LayoutPage,
    Sheet,
    control_measure,
    page_header,
    sheet_scale,
)
from app.services.panel_enclosure_pdf_terminals import SCALE_NOTE, SHRUNK_NOTE
from app.services.panel_enclosure_prep import End, control_target
from app.services.schaltplan_pdf_style import FONT, FONT_BOLD, GRID, INK, LINE, MUTED, WARN, ZEBRA, text_of

__all__ = ["control_page", "with_control_page"]

TITLE = "§14a-Klemmleiste · Feld {n} · {vt} {name}"
RAIL_HEADING = "{title} · Klemmleiste {width} mm ab {offset} mm · Geräte {devices} mm · Hutschiene {cap} mm"
OVERFLOW_NOTE = " · passt nicht auf die Hutschiene"
DEVICES = "Geräte {mm} mm"
FOOTER = "Aderbeschriftung: WAGO {tube}, jede Bezeichnung zweimal"
TUBES = {"wago-211-502": "211-502 (Ø 4,8 mm)", "wago-211-501": "211-501 (Ø 3,2 mm)"}
POLE = "Pol {i}"
NONE = "—"
#: (heading, width in mm) of the table.
COLUMNS: tuple[tuple[str, float], ...] = (
    ("Klemme", 22.0), ("Bezeichnung", 46.0), ("Aderfarbe", 40.0), ("Ziel", 46.0), ("Lüsterklemme", 36.0),
)
TABLE_W = 190 * MM
COLOUR_COLUMN = 2

HEAD_H = 12 * MM
HEADING_H = 4 * MM
MARKER_H = 11 * MM  # the 2009-110 strip
BAND_H = 30 * MM
PART_NO_H = 12 * MM  # the band's lower part: the part number, along the terminal
STUB_H = 6 * MM
STUB_W = 1.6 * MM
NUMBER_H = 4 * MM
GAP_H = 6 * MM
ROW_H = 6 * MM
FOOT_H = 6 * MM
PAD = 2.0
SWATCH = 3 * MM
TEXT_SIZE = 7.0

_GREY, _ORANGE = colors.HexColor("#d1d5db"), colors.HexColor("#fb923c")
_DEVICE_FILL, _RAIL_FILL = colors.HexColor("#e5e7eb"), colors.HexColor("#f8fafc")
#: WAGO's housings: grey end stops and terminals (orange knife holder), the orange plate.
_PART_FILL: Mapping[str, Any] = {"249-116": _GREY, PART_TERMINAL: _GREY, PART_PLATE: _ORANGE}
#: weiß and rosa wires need an outline to show on white paper (§2.3).
_WIRE_OUTLINE = colors.HexColor("#6b7a8c")


def control_page(document: Any, catalog: EnclosureCatalog, *, plan: PanelPlan,
                 company_name: str | None = None) -> LayoutPage | None:
    """The §14a page, laid out; None when the block is not placed (absent, off, empty, no carrier or rail)."""
    layout = control_block_layout(document, catalog)
    block = stored_block(document)
    if layout is None or block is None:
        return None
    target = control_target(document, catalog, layout.carrier)
    placed = layout.as_dict()
    scale = sheet_scale(max(float(placed["capacityMm"]), float(placed["offsetMm"]) + float(placed["widthMm"])))
    sheet = Sheet()
    page_header(sheet, text_of(company_name) or "SMPL")
    _title(sheet, layout, plan, scale)
    band_y = TOP - HEAD_H - HEADING_H - MARKER_H - BAND_H
    _heading(sheet, placed, TOP - HEAD_H)
    _rail(sheet, placed, band_y, MM * scale)
    for part in placed["parts"]:
        _part(sheet, part, MARGIN + (float(placed["offsetMm"]) + float(part["offsetMm"])) * MM * scale,
              float(part["widthMm"]) * MM * scale, band_y)
    _table(sheet, placed["parts"], target, band_y - STUB_H - NUMBER_H - GAP_H)
    tube = TUBES.get(str(block["label_material"]), TUBES["wago-211-502"])
    sheet.line(FOOTER.format(tube=tube), MARGIN, BOTTOM, USABLE_W, FOOT_H, size=7.5)
    return sheet.page(layout.field, legend=False)


def with_control_page(pages: Sequence[LayoutPage], page: LayoutPage | None) -> list[LayoutPage]:
    """The close-up pages with the §14a page after its field's close-up (and legend), else first."""
    if page is None:
        return list(pages)
    after = max((index for index, entry in enumerate(pages) if entry.field == page.field), default=-1)
    return [*pages[:after + 1], page, *pages[after + 1:]]


# ── The parts of the page ────────────────────────────────────────────────────


def _title(sheet: Sheet, layout: BlockLayout, plan: PanelPlan, scale: float) -> None:
    name = text_of(plan.name) or text_of(plan.designation)
    title = TITLE.format(n=layout.field + 1, vt=text_of(plan.panel_number), name=name).strip()
    width = USABLE_W - 108 * MM  # clear of the Kontrollmaß
    sheet.line(title, MARGIN, TOP - 14, width, 14, font=FONT_BOLD, size=11)
    sheet.line(SCALE_NOTE if scale >= 1.0 else SHRUNK_NOTE, MARGIN, TOP - 24, width, 10, size=7.5,
               color=MUTED if scale >= 1.0 else WARN)
    control_measure(sheet)


def _heading(sheet: Sheet, placed: Mapping[str, Any], top: float) -> None:
    text = RAIL_HEADING.format(title=placed["railTitle"], width=mm_text(placed["widthMm"]),
                               offset=mm_text(placed["offsetMm"]), devices=mm_text(placed["devicesMm"]),
                               cap=mm_text(placed["capacityMm"]))
    overflow = bool(placed["overflow"])
    sheet.line(text + (OVERFLOW_NOTE if overflow else ""), MARGIN, top - HEADING_H, USABLE_W, HEADING_H,
               font=FONT_BOLD, size=7, color=WARN if overflow else INK)


def _rail(sheet: Sheet, placed: Mapping[str, Any], band_y: float, factor: float) -> None:
    """The rail's usable length, and the devices on it as one grey band from its left end."""
    sheet.rect(MARGIN, band_y, float(placed["capacityMm"]) * factor, BAND_H, fill=_RAIL_FILL, stroke=GRID, width=0.6)
    devices = float(placed["devicesMm"])
    if devices > 0:
        sheet.rect(MARGIN, band_y, devices * factor, BAND_H, fill=_DEVICE_FILL, stroke=GRID)
        sheet.fit(DEVICES.format(mm=mm_text(devices)), MARGIN, band_y, devices * factor, BAND_H, 6.0, 5.0)


def _part(sheet: Sheet, part: Mapping[str, Any], x: float, w: float, band_y: float) -> None:
    part_id = str(part["partId"])
    sheet.rect(x, band_y, w, BAND_H, fill=_PART_FILL.get(part_id, _GREY), stroke=INK, width=0.25)
    if part_id == PART_PLATE:
        return  # 1 mm: its colour says it, the table and the Materialliste name it
    sheet.fit(part_id, x, band_y, w, PART_NO_H, 5.0, 4.0, along=True)
    if part_id != PART_TERMINAL:
        return
    sheet.rect(x + w / 4, band_y + BAND_H * 0.55, w / 2, 3 * MM, fill=_ORANGE)  # the knife holder
    sheet.rect(x, band_y + BAND_H, w, MARKER_H, fill=colors.white, stroke=GRID)
    sheet.fit(str(part["label"] or ""), x, band_y + BAND_H, w, MARKER_H, 6.0, 5.0, along=True)
    colour = str(part["color"])
    outline = _WIRE_OUTLINE if colour in ("weiß", "rosa") else None
    sheet.rect(x + (w - STUB_W) / 2, band_y - STUB_H, STUB_W, STUB_H,
               fill=colors.HexColor(WIRE_COLOUR_STYLE.get(colour, "#8b929b")), stroke=outline, width=0.5)
    sheet.fit(str(part["position"]), x, band_y - STUB_H - NUMBER_H, w, NUMBER_H, 6.0, 5.0)


def _row_cells(part: Mapping[str, Any], target: End | None) -> list[str]:
    where = f"{target.name} Feld {target.field + 1}" if target is not None else NONE
    pole = POLE.format(i=part["position"]) if target is not None else NONE
    return [str(part["position"]), str(part["label"] or "") or NONE, str(part["color"]).capitalize(), where, pole]


def _table_row(sheet: Sheet, cells: Sequence[str], y: float, *, bold: bool = False, zebra: bool = False,
               colour: str | None = None) -> float:
    """One row with its top at ``y``; returns the next row's top. ``colour``: a swatch in the colour column."""
    if zebra:
        sheet.rect(MARGIN, y - ROW_H, TABLE_W, ROW_H, fill=ZEBRA)
    x = MARGIN
    for index, ((_, width), text) in enumerate(zip(COLUMNS, cells)):
        left = x + PAD
        if index == COLOUR_COLUMN and colour is not None:
            sheet.rect(left, y - (ROW_H + SWATCH) / 2, SWATCH, SWATCH,
                       fill=colors.HexColor(WIRE_COLOUR_STYLE.get(colour, "#8b929b")), stroke=_WIRE_OUTLINE, width=0.4)
            left += SWATCH + PAD
        sheet.line(text, left, y - ROW_H, x + width * MM - PAD - left, ROW_H, font=FONT_BOLD if bold else FONT,
                   size=TEXT_SIZE)
        x += width * MM
    sheet.rect(MARGIN, y - ROW_H, TABLE_W, 0.4, fill=LINE)
    return y - ROW_H


def _table(sheet: Sheet, parts: Sequence[Mapping[str, Any]], target: End | None, top: float) -> None:
    y = _table_row(sheet, [heading for heading, _ in COLUMNS], top, bold=True)
    terminals = [part for part in parts if part["partId"] == PART_TERMINAL]
    for index, part in enumerate(terminals):
        y = _table_row(sheet, _row_cells(part, target), y, zebra=index % 2 == 1, colour=str(part["color"]))
