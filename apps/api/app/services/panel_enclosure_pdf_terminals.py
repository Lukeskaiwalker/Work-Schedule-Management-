"""The WAGO close-up pages of the Aufbau PDF (docs/PANEL_ENCLOSURE_R2.md §7.3).

One A4 landscape page per field whose terminal rails hold a strip, between
the front view and the Materialliste. Each rail is drawn **1:1 across**: its
outline is ``capacityMm`` × 72/25.4 pt wide, and every part sits at its true
offset and width, so a fitter can hold the sheet against the rail. A
**Kontrollmaß 100 mm** bar shows whether the printer scaled the page (an
iPad's AirPrint "fit to page" does). Per rail, top → bottom: the heading
(length used, U84T state, end plate), a 10 mm marker strip, a 30 mm terminal
band with the conductors inside it and the part number, and a 40 mm column
of the rotated "für" text and cable. A custom rail longer than the sheet is
the one case drawn smaller, and then the page says so.

Every text goes through ``label_fit.fit_label`` (the rule the app shares) or,
for running text, ``wrap``: never wider than its cell. When a terminal's text
had to be cut, a legend page follows with every terminal in full.

The page is laid out first as plain data (``closeup_layout``: rectangles and
texts with their cells) and only then drawn, so a test can hold each drawn
string against its cell. Text only through ``drawString`` and friends, never
Paragraph markup: markers, labels and cables are user input.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas as pdfcanvas

from app.models.schaltplan import PanelPlan
from app.services.panel_enclosure_geometry import mm_text
from app.services.panel_enclosure_pdf_terminal_legend import legend_pages
from app.services.panel_enclosure_pdf_terminal_sheet import (
    BOTTOM,
    MARGIN,
    MM,
    TOP,
    USABLE_W,
    LayoutPage,
    PageShape,
    PageText,
    Sheet,
    page_header,
)
from app.services.schaltplan_pdf_style import FONT_BOLD, GRID, INK, MUTED, WARN, text_of

__all__ = ["LayoutPage", "PageShape", "PageText", "closeup_layout", "draw_terminal_closeup_pages"]

TITLE = "Reihenklemmen · Feld {n} · {vt} {name}"
SCALE_NOTE = "Maßstab 1:1 (Breite) — zum Anlegen an die Hutschiene"
SHRUNK_NOTE = "Verkleinert: die Hutschiene ist länger als das Blatt — nicht zum Anlegen"
CONVENTION_NOTE = "Beschriftung oben gezeichnet (WAGO: Mitte/seitlich) · Abschlussplatte rechts angenommen"
L2_L3_NOTE = " · Ebenen der 2003-7642 (L2, L3) angenommen"
CONTROL = "Kontrollmaß 100 mm"
RAIL_HEADING = "Hutschiene {r} · {title} · {used} von {cap} mm"
U84T_FACTORY, U84T_SET = "U84T ab Werk", "U84T: 1 Satz"
PLATE = "Abschlussplatte {part}"
UNPLACED = "Ohne Platz: "
MORE = " … und {n} weitere"

CONTROL_MM = 100.0
HEAD_H = 12 * MM
BLOCK_H = 84 * MM
HEADING_H = 4 * MM
MARKER_H = 10 * MM
BAND_H = 30 * MM
LEVELS_H = 18 * MM  # the band's upper part; the part number below it
COLUMN_H = 40 * MM
COLUMN_PAD = 1 * MM  # the column's texts keep clear of the band above and the next heading below
FOOT_H = 6 * MM

_RAIL_FILL = colors.HexColor("#f8fafc")
_DEVICE_FILL = colors.HexColor("#e5e7eb")
_GREY, _BLUE = colors.HexColor("#d1d5db"), colors.HexColor("#93c5fd")
#: WAGO's housing colours: grey terminals, blue N parts, green-yellow PE, orange/grey plates.
_PART_FILL: Mapping[str, Any] = {
    "2003-7641": _GREY, "2003-7642": _GREY, "2016-7601": _GREY,
    "2016-7714": _BLUE, "2016-7604": _BLUE, "2009-305": _BLUE,
    "2016-7607": colors.HexColor("#bef264"),
    "2003-7692": colors.HexColor("#fb923c"), "2016-7691": colors.HexColor("#9ca3af"),
}


def _placed(field: Mapping[str, Any]) -> bool:
    return any(item.get("stripId") for rail in field.get("rails") or [] for item in rail.get("items") or [])


def _scale(rails: Sequence[Mapping[str, Any]]) -> float:
    """1 (1:1), unless a rail or what sits on it is longer than the sheet."""
    extent = 0.0
    for rail in rails:
        extent = max(extent, float(rail["capacityMm"]))
        for part in [*rail.get("devices", []), *rail.get("items", [])]:
            extent = max(extent, float(part["offsetMm"]) + float(part["widthMm"]))
    return min(1.0, USABLE_W / (extent * MM)) if extent > 0 else 1.0


def _title_block(sheet: Sheet, field: Mapping[str, Any], plan: PanelPlan, scale: float) -> None:
    name = text_of(plan.name) or text_of(plan.designation)
    title = TITLE.format(n=int(field["field"]) + 1, vt=text_of(plan.panel_number), name=name).strip()
    width = USABLE_W - (CONTROL_MM + 8) * MM
    sheet.line(title, MARGIN, TOP - 14, width, 14, font=FONT_BOLD, size=11)
    sheet.line(SCALE_NOTE if scale >= 1.0 else SHRUNK_NOTE, MARGIN, TOP - 24, width, 10, size=7.5,
               color=MUTED if scale >= 1.0 else WARN)
    l2_l3 = any(item["partId"] == "2003-7642" for rail in field["rails"] for item in rail["items"])
    sheet.line(CONVENTION_NOTE + (L2_L3_NOTE if l2_l3 else ""), MARGIN, TOP - 33, width, 9, size=6.5, color=MUTED)
    left = MARGIN + USABLE_W - CONTROL_MM * MM
    sheet.line(CONTROL, left, TOP - 14, CONTROL_MM * MM, 14, size=7.5, align="right")
    sheet.rect(left, TOP - 22, CONTROL_MM * MM, 1.2 * MM, fill=INK)
    for tick in (0.0, 50.0, 100.0):  # end and middle marks, so the bar is read at its ends
        sheet.rect(left + tick * MM - 0.2, TOP - 26, 0.4, 4 * MM, fill=INK)


def _heading(rail: Mapping[str, Any]) -> str:
    text = RAIL_HEADING.format(r=int(rail["position"]) + 1, title=rail["title"], used=mm_text(rail["usedMm"]),
                               cap=mm_text(rail["capacityMm"]))
    holds = any(item.get("stripId") for item in rail["items"])
    if rail["insulated"]:
        text += f" · {U84T_FACTORY}"
    elif holds:
        text += f" · {U84T_SET}"
    plates = [item["partId"] for item in rail["items"] if item["kind"] == "end_plate"]
    return text + "".join(f" · {PLATE.format(part=part)}" for part in plates)


def _item(sheet: Sheet, item: Mapping[str, Any], x: float, w: float, band_y: float) -> None:
    sheet.rect(x, band_y, w, BAND_H, fill=_PART_FILL.get(str(item["partId"]), _DEVICE_FILL), stroke=INK, width=0.25)
    if item["kind"] == "end_plate":
        return  # 0.8–1 mm: its colour says it; the heading names it
    sheet.fit(str(item["marker"]), x, band_y + BAND_H, w, MARKER_H, 6.0, 5.0, item=True)
    levels = list(item["levels"])
    for index, level in enumerate(levels):
        cell_h = LEVELS_H / len(levels)
        sheet.fit(str(level), x, band_y + BAND_H - (index + 1) * cell_h, w, cell_h, 6.0, 5.0, item=True)
    sheet.fit(str(item["partId"]), x, band_y, w, BAND_H - LEVELS_H, 5.0, 4.0, item=True)
    column_y, column_h = band_y - COLUMN_H + COLUMN_PAD, COLUMN_H - 2 * COLUMN_PAD
    for index, value in enumerate((str(item["forText"]), str(item["cable"]))):
        sheet.fit(value, x + index * w / 2, column_y, w / 2, column_h, 5.5, 5.0, item=True, along=True)


def _rail_block(sheet: Sheet, rail: Mapping[str, Any], top: float, scale: float) -> None:
    sheet.line(_heading(rail), MARGIN, top - HEADING_H, USABLE_W, HEADING_H, font=FONT_BOLD, size=7)
    band_y = top - HEADING_H - MARKER_H - BAND_H
    factor = MM * scale
    sheet.rect(MARGIN, band_y, float(rail["capacityMm"]) * factor, BAND_H, fill=_RAIL_FILL, stroke=GRID, width=0.6)
    for device in rail["devices"]:  # back-compat: still on a reserved rail, drawn grey before the strips
        x, w = MARGIN + float(device["offsetMm"]) * factor, float(device["widthMm"]) * factor
        sheet.rect(x, band_y, w, BAND_H, fill=_DEVICE_FILL, stroke=GRID)
        sheet.fit(str(device["label"]), x, band_y, w, BAND_H, 6.0, 5.0)
    for item in rail["items"]:
        _item(sheet, item, MARGIN + float(item["offsetMm"]) * factor, float(item["widthMm"]) * factor, band_y)


def _unplaced_name(entry: Mapping[str, Any]) -> str:
    """"X7 (FI F7)": the strip's X label and its group from the strip title."""
    label, title = str(entry["xLabel"]), str(entry.get("title") or "")
    rest = title[len(label) + 3:] if title.startswith(f"{label} · ") else title
    name = rest.split(" · ")[0].strip()
    return f"{label} ({name})" if name and name != label else label


def _footer(sheet: Sheet, unplaced: Sequence[Mapping[str, Any]]) -> None:
    """The strips without place, cut off with "… und {n} weitere" at the sheet's width."""
    if not unplaced:
        return
    names = [_unplaced_name(entry) for entry in unplaced]
    for shown in range(len(names), -1, -1):
        more = MORE.format(n=len(names) - shown) if shown < len(names) else ""
        text = (UNPLACED + ", ".join(names[:shown]) + more).replace(":  …", ": …")
        if sheet.fits(text, USABLE_W, size=7.5) or shown == 0:
            sheet.line(text, MARGIN, BOTTOM, USABLE_W, FOOT_H, size=7.5, color=WARN)
            return


def _field_page(field: Mapping[str, Any], plan: PanelPlan, company: str) -> LayoutPage:
    sheet = Sheet()
    page_header(sheet, company)
    rails = list(field["rails"])[:2]
    scale = _scale(rails)
    _title_block(sheet, field, plan, scale)
    for index, rail in enumerate(rails):
        _rail_block(sheet, rail, TOP - HEAD_H - index * BLOCK_H, scale)
    _footer(sheet, field.get("unplaced") or [])
    return sheet.page(int(field["field"]), legend=False)


def closeup_layout(closeup: Sequence[Mapping[str, Any]], *, plan: PanelPlan,
                   company_name: str | None = None) -> list[LayoutPage]:
    """The close-up pages, laid out: per field with a placed strip its page, then its legend pages if a text was cut."""
    company = text_of(company_name) or "SMPL"
    pages: list[LayoutPage] = []
    for field in closeup:
        if not _placed(field):
            continue
        page = _field_page(field, plan, company)
        pages.append(page)
        if page.shortened:
            pages.extend(legend_pages(field, company))
    return pages


def draw_terminal_closeup_pages(c: pdfcanvas.Canvas, *, plan: PanelPlan, closeup: Sequence[Mapping[str, Any]],
                                company_name: str | None = None) -> int:
    """Draw the close-up pages (each ended with ``showPage``); returns how many, legends included."""
    pages = closeup_layout(closeup, plan=plan, company_name=company_name)
    for page in pages:
        c.setPageSize(landscape(A4))
        _render(c, page)
        c.showPage()
    return len(pages)


def _render(c: pdfcanvas.Canvas, page: LayoutPage) -> None:
    for shape in page.shapes:
        c.setLineWidth(shape.width)
        if shape.fill is not None:
            c.setFillColor(shape.fill)
        if shape.stroke is not None:
            c.setStrokeColor(shape.stroke)
        stroke, fill = int(shape.stroke is not None), int(shape.fill is not None)
        c.rect(shape.x, shape.y, shape.w, shape.h, stroke=stroke, fill=fill)
    for text in page.texts:
        c.setFillColor(text.color)
        c.setFont(text.font, text.size)
        if text.rotated:
            c.saveState()
            c.translate(text.x + text.w / 2 + text.size * 0.35, text.y + text.h / 2)
            c.rotate(90)
            c.drawCentredString(0, 0, text.text)
            c.restoreState()
            continue
        baseline = text.y + (text.h - text.size * 0.7) / 2
        if text.align == "left":
            c.drawString(text.x, baseline, text.text)
        elif text.align == "right":
            c.drawRightString(text.x + text.w, baseline, text.text)
        else:
            c.drawCentredString(text.x + text.w / 2, baseline, text.text)

