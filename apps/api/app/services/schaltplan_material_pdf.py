"""The Materialliste of a Verteiler as an A4 PDF (owner, 2026-10-09: "export
that list as a PDF").

The same list the Material tab shows, in the same order — the cabinet and its
modules, device types, WAGO terminal parts, the lines added by hand, then what
was booked without being planned — with planned and booked quantities and the
stock article each line is ticked off against. One table, portrait, the plan
PDF's header bar and fonts (``schaltplan_pdf_style``) so it reads as the same
company's paperwork; ``wrap`` keeps every cell inside its column.

Parts taken out of a cabinet module on their way back to the shelf
(docs/PANEL_ENCLOSURE.md §6, kind ``removed``) are returns, not picks: they
print in their own block "Aus Modulen entfernt → ins Lager" after every other
line, with "eingelagert" instead of "vollständig".

``draw_material_pages`` draws onto a canvas it is handed, so the Aufbau PDF
(``panel_enclosure_pdf``) can put these pages behind its landscape sheet;
``build_material_pdf`` is the standalone document.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
from typing import Sequence

from reportlab.lib import colors
from reportlab.lib.colors import Color
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as pdfcanvas

from app.schemas.schaltplan import PanelMaterialLineOut, PanelMaterialOut
from app.services.schaltplan_material import counts_toward_picking
from app.services.schaltplan_pdf_style import (
    BLUE_DEEP,
    BLUE_TINT,
    FONT,
    FONT_BOLD,
    GRID,
    INK,
    LINE,
    MUTED,
    WARN,
    ZEBRA,
    header_bar,
    text_of,
    wrap,
)

# (key, title, width in pt) — 514 pt, the A4 width minus the margins.
_COLUMNS: list[tuple[str, str, float]] = [
    ("pos", "Pos.", 26),
    ("label", "Bezeichnung", 196),
    ("article", "Lagerartikel", 150),
    ("planned", "Soll", 38),
    ("scanned", "Entn.", 38),
    ("status", "Status", 66),
]
_TOTAL_W = sum(width for _key, _title, width in _COLUMNS)

LINE_REMOVED = "removed"
RETURNS_TITLE = "Aus Modulen entfernt → ins Lager"

_KIND_TEXT = {
    "device": "Gerät", "terminal": "Reihenklemme", "manual": "manuell", "extra": "zusätzlich entnommen",
    "enclosure": "Schrank/Modul", LINE_REMOVED: "aus Modul entfernt → ins Lager",
}
_STATUS_TEXT = {"open": "offen", "done": "vollständig", "over": "zu viel", "unplanned": "nicht geplant"}
# A return is done when it is back on the shelf; more than was taken out is the anomaly.
_RETURN_STATUS_TEXT = {"open": "offen", "done": "eingelagert", "over": "zu viel eingelagert",
                       "unplanned": "zu viel eingelagert"}
# A printed list is read for what is wrong: "zu viel" and "nicht geplant"
# stand out, "vollständig" reads as settled, "offen" stays plain ink.
_STATUS_COLOR = {"done": colors.HexColor("#15803d"), "over": WARN, "unplanned": WARN}
_NUMERIC = {"planned", "scanned"}
# Space between a cell's text and the next column.
_GAP = 10
_SIZE = 8.0
_LINE_H = 9.5
_BOTTOM = 60.0


@dataclass(frozen=True)
class _Text:
    """One printed line of a cell, with its own look — so a label that wraps
    and a detail that wraps each keep theirs, whatever the line count."""

    text: str
    font: str = FONT
    size: float = _SIZE
    color: Color = INK


def _lines(text: str, column: str, max_lines: int, *, font: str = FONT, size: float = _SIZE, color: Color = INK) -> list[_Text]:
    return [_Text(part, font, size, color) for part in wrap(text, font, size, _width(column) - _GAP, max_lines)]


def _is_free_text(line: PanelMaterialLineOut) -> bool:
    """A line added by hand without an article: listed, never counted.
    (A return is not counted as a pick either, but it is booked — it keeps its numbers.)"""
    return not counts_toward_picking(line) and line.kind != LINE_REMOVED


def _status_cell(line: PanelMaterialLineOut) -> list[_Text]:
    texts = _RETURN_STATUS_TEXT if line.kind == LINE_REMOVED else _STATUS_TEXT
    return _lines(texts.get(line.status, line.status), "status", 2, color=_STATUS_COLOR.get(line.status, INK))


def _cells(index: int, line: PanelMaterialLineOut) -> dict[str, list[_Text]]:
    kind = _KIND_TEXT.get(line.kind, line.kind)
    # "manuell · für Reihe 2" / "Reihenklemme · Sammelschienenträger mit
    # Endklammerfunktion" — the detail says where the line comes from and,
    # for a WAGO part, what it is: two lines, or a printed list cuts the
    # very words that identify the part. A detail that already says it all
    # ("aus Modul entfernt → ins Lager · ZH3EH16") stands alone.
    detail = text_of(line.detail)
    if not detail or detail in {kind, "nicht geplant"}:
        second = kind
    elif line.kind == LINE_REMOVED and detail.startswith(kind):
        second = detail
    else:
        second = f"{kind} · {detail}"
    article = "—"
    if line.article is not None:
        number = text_of(line.article.article_number)
        article = f"{text_of(line.article.item_name)} ({number})" if number else text_of(line.article.item_name)
    if _is_free_text(line):
        # A free text: nothing to scan, so no "0" that never moves and no
        # "offen" that never closes — the footer says it is not counted.
        scanned = [_Text("—")]
        status = _lines("Freitext", "status", 1, color=MUTED)
    else:
        scanned = [_Text(str(line.scanned))]
        status = _status_cell(line)
    return {
        "pos": [_Text(str(index))],
        "label": _lines(text_of(line.label) or "—", "label", 2, font=FONT_BOLD)
        + _lines(second, "label", 2, size=_SIZE - 1, color=MUTED),
        "article": _lines(article, "article", 3, color=MUTED),
        "planned": [_Text(str(line.planned) if line.planned else "—")],
        "scanned": scanned,
        "status": status,
    }


def _width(key: str) -> float:
    return next(width for column, _title, width in _COLUMNS if column == key)


class _Pages:
    """The page state of one run of Materialliste pages on a shared canvas."""

    def __init__(self, c: pdfcanvas.Canvas, material: PanelMaterialOut, company_name: str | None) -> None:
        self.c = c
        self.width, self.height = A4
        self.x0 = (self.width - _TOTAL_W) / 2
        self.page_no = 0
        self.y = 0.0
        panel = material.panel
        self.company = text_of(company_name) or "SMPL"
        self.title = f"{panel.panel_number} · {text_of(panel.designation)} — {text_of(panel.name)}"
        project = " · ".join(part for part in (text_of(panel.project_number), text_of(panel.project_name)) if part)
        self.meta = " · ".join(
            part for part in (text_of(panel.customer_name), project, f"Stand {datetime.now():%d.%m.%Y}") if part
        )

    def new_page(self) -> None:
        if self.page_no:
            self.c.showPage()
        self.c.setPageSize(A4)
        self.page_no += 1
        c, width, height, x0 = self.c, self.width, self.height, self.x0
        header_bar(c, width, height, "Materialliste", self.company)
        c.setFillColor(INK)
        c.setFont(FONT_BOLD, 12)
        c.drawString(x0, height - 60, wrap(self.title, FONT_BOLD, 12, _TOTAL_W, 1)[0])
        c.setFont(FONT, 8.5)
        c.setFillColor(MUTED)
        c.drawString(x0, height - 74, wrap(self.meta, FONT, 8.5, _TOTAL_W - 50, 1)[0] if self.meta else "")
        if self.page_no > 1:
            c.drawRightString(x0 + _TOTAL_W, height - 74, f"Seite {self.page_no}")
        self._column_heads(height - 96)

    def _column_heads(self, y: float) -> None:
        c = self.c
        c.setFillColor(BLUE_TINT)
        c.setStrokeColor(LINE)
        c.setLineWidth(0.5)
        c.rect(self.x0, y - 4, _TOTAL_W, 16, stroke=1, fill=1)
        c.setFillColor(BLUE_DEEP)
        c.setFont(FONT_BOLD, 7.5)
        x = self.x0
        for key, title_text, column_width in _COLUMNS:
            if key in _NUMERIC:
                c.drawRightString(x + column_width - 6, y + 2, title_text)
            else:
                c.drawString(x + 3, y + 2, title_text)
            x += column_width
        self.y = y - 16

    def room_for(self, height: float) -> None:
        if self.y - height < _BOTTOM:
            self.new_page()

    def row(self, index: int, line: PanelMaterialLineOut) -> None:
        cells = _cells(index, line)
        row_h = max(14.0, 4 + _LINE_H * max(len(lines) for lines in cells.values()))
        self.room_for(row_h)
        c = self.c
        if index % 2 == 0:
            c.setFillColor(ZEBRA)
            c.rect(self.x0, self.y - row_h + 9, _TOTAL_W, row_h, stroke=0, fill=1)
        c.setStrokeColor(GRID)
        c.setLineWidth(0.4)
        c.line(self.x0, self.y - row_h + 9, self.x0 + _TOTAL_W, self.y - row_h + 9)
        x = self.x0
        for key, _title, column_width in _COLUMNS:
            text_y = self.y
            for part in cells[key]:
                c.setFillColor(part.color)
                c.setFont(part.font, part.size)
                if key in _NUMERIC:
                    c.drawRightString(x + column_width - 6, text_y, part.text)
                else:
                    c.drawString(x + 3, text_y, part.text)
                text_y -= _LINE_H
            x += column_width
        self.y -= row_h

    def section(self, title: str) -> None:
        self.room_for(32)
        self.y -= 8
        self.c.setFillColor(BLUE_DEEP)
        self.c.setFont(FONT_BOLD, 9)
        self.c.drawString(self.x0 + 3, self.y, wrap(title, FONT_BOLD, 9, _TOTAL_W - 6, 1)[0])
        self.y -= 14

    def note_lines(self, title: str, notes: Sequence[str]) -> None:
        self.section(title)
        for note in notes:
            for part in wrap(text_of(note), FONT, _SIZE, _TOTAL_W - 6, 3):
                self.room_for(_LINE_H)
                self.c.setFillColor(INK)
                self.c.setFont(FONT, _SIZE)
                self.c.drawString(self.x0 + 3, self.y, part)
                self.y -= _LINE_H


def _summary(material: PanelMaterialOut) -> str:
    free_text = sum(1 for line in material.lines if _is_free_text(line))
    summary = (
        f"{len(material.lines)} Positionen · Soll {material.planned_total} · entnommen {material.scanned_total} · "
        f"offen {material.open_lines}"
    )
    if material.returns_open:
        summary += f" · {material.returns_open} × ins Lager offen"
    if free_text:
        positions = "Freitext-Position" if free_text == 1 else "Freitext-Positionen"
        summary += f" · {free_text} {positions} ohne Lagerartikel (nicht gezählt)"
    return summary


def draw_material_pages(
    c: pdfcanvas.Canvas,
    *,
    material: PanelMaterialOut,
    company_name: str | None,
    notes_title: str = "",
    notes: Sequence[str] = (),
) -> None:
    """The Materialliste as portrait pages on ``c``, starting a new page.

    The last page is left open (the caller shows and saves it). ``notes``
    print under the list on its last page(s), under ``notes_title`` — the
    Aufbau PDF puts its full list of hints there.
    """
    pages = _Pages(c, material, company_name)
    pages.new_page()
    if not material.lines:
        c.setFont(FONT, 9)
        c.setFillColor(MUTED)
        c.drawString(pages.x0 + 3, pages.y - 4, "Noch kein Material geplant oder entnommen.")
        pages.y -= 18
    planned = [line for line in material.lines if line.kind != LINE_REMOVED]
    returns = [line for line in material.lines if line.kind == LINE_REMOVED]
    for index, line in enumerate(planned, start=1):
        pages.row(index, line)
    if returns:
        pages.section(RETURNS_TITLE)
        for index, line in enumerate(returns, start=len(planned) + 1):
            pages.row(index, line)
    if notes:
        pages.note_lines(notes_title, notes)
    c.setFillColor(MUTED)
    c.setFont(FONT, 7.5)
    c.drawString(pages.x0, 44, f"{_summary(material)} · erstellt mit der SMPL Workflow-App")


def build_material_pdf(*, material: PanelMaterialOut, company_name: str | None) -> bytes:
    buffer = BytesIO()
    c = pdfcanvas.Canvas(buffer, pagesize=A4)
    draw_material_pages(c, material=material, company_name=company_name)
    c.showPage()
    c.save()
    return buffer.getvalue()
