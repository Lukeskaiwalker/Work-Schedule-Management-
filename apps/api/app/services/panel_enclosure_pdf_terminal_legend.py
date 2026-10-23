"""The legend pages behind a WAGO close-up page (docs/PANEL_ENCLOSURE_R2.md §7.3).

When a terminal's marker, conductors, part, "für" text or cable had to be cut
on the close-up, the field's terminals follow as a table with every text in
full (wrapped over up to four lines in its column): X, Beschriftung, Teil,
Ebenen, für, Kabel, rail 1 then rail 2, left → right. The table runs over as
many pages as it needs up to ``MAX_PAGES``; only when even those are full does
its last line say "… und {n} weitere" (as the Aufbau column does, C§13).
"""

from __future__ import annotations

from typing import Any, Iterator, Mapping

from app.services.panel_enclosure_pdf_terminal_sheet import (
    BOTTOM,
    MARGIN,
    MM,
    TOP,
    USABLE_W,
    LayoutPage,
    Sheet,
    page_header,
)
from app.services.schaltplan_pdf_style import FONT, FONT_BOLD, LINE, MUTED, ZEBRA, wrap

LEGEND_TITLE = "Reihenklemmen · Feld {n} · Legende"
CONTINUED = " (Fortsetzung)"
MORE = "… und {n} weitere"
MAX_PAGES = 4
MAX_LINES = 4
SIZE = 7.0
LINE_H = 8.5
PAD = 2.0
#: (key, heading, width in mm): 273 mm, the usable width.
COLUMNS: tuple[tuple[str, str, float], ...] = (
    ("x", "X", 16), ("marker", "Beschriftung", 24), ("part", "Teil", 30), ("levels", "Ebenen", 24),
    ("for", "für", 105), ("cable", "Kabel", 74),
)


def _rows(field: Mapping[str, Any]) -> Iterator[dict[str, str]]:
    for rail in field["rails"]:
        for item in rail["items"]:
            if item["kind"] == "end_plate":
                continue
            yield {
                "x": str(item["xLabel"]) or "—", "marker": str(item["marker"]) or "—", "part": str(item["partNo"]),
                "levels": " / ".join(item["levels"]) or "—", "for": str(item["forText"]) or "—",
                "cable": str(item["cable"]) or "—",
            }


def _cells(row: Mapping[str, str]) -> list[list[str]]:
    return [wrap(row[key], FONT, SIZE, width * MM - 2 * PAD, MAX_LINES) or [""] for key, _, width in COLUMNS]


def _table_row(sheet: Sheet, cells: list[list[str]], y: float, *, font: str = FONT, zebra: bool = False) -> float:
    """Draw one row with its top at ``y``; returns the next row's top."""
    height = max(len(lines) for lines in cells) * LINE_H + 3
    if zebra:
        sheet.rect(MARGIN, y - height, USABLE_W, height, fill=ZEBRA)
    x = MARGIN
    for (_, _, width), lines in zip(COLUMNS, cells):
        for index, text in enumerate(lines):
            if text:
                sheet.line(text, x + PAD, y - 1.5 - (index + 1) * LINE_H, width * MM - 2 * PAD, LINE_H, font=font,
                           size=SIZE)
        x += width * MM
    sheet.rect(MARGIN, y - height, USABLE_W, 0.4, fill=LINE)
    return y - height


def _start(field: Mapping[str, Any], company: str, page_no: int) -> tuple[Sheet, float]:
    sheet = Sheet()
    page_header(sheet, company)
    title = LEGEND_TITLE.format(n=int(field["field"]) + 1) + (CONTINUED if page_no > 1 else "")
    sheet.line(title, MARGIN, TOP - 14, USABLE_W, 14, font=FONT_BOLD, size=11)
    head = [[heading] for _, heading, _ in COLUMNS]
    return sheet, _table_row(sheet, head, TOP - 22, font=FONT_BOLD)


def legend_pages(field: Mapping[str, Any], company: str) -> list[LayoutPage]:
    """The legend pages of one field's close-up; [] when it has no terminal."""
    rows = [_cells(row) for row in _rows(field)]
    pages: list[LayoutPage] = []
    index = 0
    while index < len(rows) and len(pages) < MAX_PAGES:
        sheet, y = _start(field, company, len(pages) + 1)
        last_page = len(pages) == MAX_PAGES - 1
        first = index
        while index < len(rows):
            height = max(len(lines) for lines in rows[index]) * LINE_H + 3
            reserve = LINE_H + 3 if last_page and index < len(rows) - 1 else 0
            if y - height - reserve < BOTTOM:
                break
            y = _table_row(sheet, rows[index], y, zebra=index % 2 == 1)
            index += 1
        if index < len(rows) and (last_page or index == first):
            sheet.line(MORE.format(n=len(rows) - index), MARGIN + PAD, y - LINE_H - 1.5, USABLE_W, LINE_H, size=SIZE,
                       color=MUTED)
            index = len(rows)  # nothing more fits: the count says what is left
        pages.append(sheet.page(int(field["field"]), legend=True))
    return pages
