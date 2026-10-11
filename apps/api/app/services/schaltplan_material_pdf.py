"""The Materialliste of a Verteiler as an A4 PDF (owner, 2026-10-09: "export
that list as a PDF").

The same list the Material tab shows, in the same order — device types,
WAGO terminal parts, the lines added by hand, then what was booked without
being planned — with planned and booked quantities and the stock article
each line is ticked off against. One table, portrait, the plan PDF's header
bar and fonts (``schaltplan_pdf_style``) so it reads as the same company's
paperwork; ``wrap`` keeps every cell inside its column.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from io import BytesIO

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

_KIND_TEXT = {"device": "Gerät", "terminal": "Reihenklemme", "manual": "manuell", "extra": "zusätzlich entnommen"}
_STATUS_TEXT = {"open": "offen", "done": "vollständig", "over": "zu viel", "unplanned": "nicht geplant"}
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


def _cells(index: int, line: PanelMaterialLineOut) -> dict[str, list[_Text]]:
    kind = _KIND_TEXT.get(line.kind, line.kind)
    # "manuell · für Reihe 2" / "Reihenklemme · Sammelschienenträger mit
    # Endklammerfunktion" — the detail says where the line comes from and,
    # for a WAGO part, what it is: two lines, or a printed list cuts the
    # very words that identify the part.
    detail = text_of(line.detail)
    second = kind if not detail or detail in {kind, "nicht geplant"} else f"{kind} · {detail}"
    article = "—"
    if line.article is not None:
        number = text_of(line.article.article_number)
        article = f"{text_of(line.article.item_name)} ({number})" if number else text_of(line.article.item_name)
    if not counts_toward_picking(line):
        # A free text: nothing to scan, so no "0" that never moves and no
        # "offen" that never closes — the footer says it is not counted.
        scanned = [_Text("—")]
        status = _lines("Freitext", "status", 1, color=MUTED)
    else:
        scanned = [_Text(str(line.scanned))]
        status = _lines(_STATUS_TEXT.get(line.status, line.status), "status", 2, color=_STATUS_COLOR.get(line.status, INK))
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


def build_material_pdf(*, material: PanelMaterialOut, company_name: str | None) -> bytes:
    buffer = BytesIO()
    c = pdfcanvas.Canvas(buffer, pagesize=A4)
    width, height = A4
    total = sum(column[2] for column in _COLUMNS)
    x0 = (width - total) / 2
    panel = material.panel
    company = text_of(company_name) or "SMPL"
    project = " · ".join(part for part in (text_of(panel.project_number), text_of(panel.project_name)) if part)
    meta = " · ".join(
        part
        for part in (text_of(panel.customer_name), project, f"Stand {datetime.now():%d.%m.%Y}")
        if part
    )

    def start_page(page_no: int) -> float:
        header_bar(c, width, height, "Materialliste", company)
        c.setFillColor(INK)
        c.setFont(FONT_BOLD, 12)
        title = f"{panel.panel_number} · {text_of(panel.designation)} — {text_of(panel.name)}"
        c.drawString(x0, height - 60, wrap(title, FONT_BOLD, 12, total, 1)[0])
        c.setFont(FONT, 8.5)
        c.setFillColor(MUTED)
        c.drawString(x0, height - 74, wrap(meta, FONT, 8.5, total - 50, 1)[0] if meta else "")
        if page_no > 1:
            c.drawRightString(x0 + total, height - 74, f"Seite {page_no}")
        y = height - 96
        c.setFillColor(BLUE_TINT)
        c.setStrokeColor(LINE)
        c.setLineWidth(0.5)
        c.rect(x0, y - 4, total, 16, stroke=1, fill=1)
        c.setFillColor(BLUE_DEEP)
        c.setFont(FONT_BOLD, 7.5)
        x = x0
        for key, title_text, column_width in _COLUMNS:
            if key in _NUMERIC:
                c.drawRightString(x + column_width - 6, y + 2, title_text)
            else:
                c.drawString(x + 3, y + 2, title_text)
            x += column_width
        return y - 16

    page_no = 1
    y = start_page(page_no)
    if not material.lines:
        c.setFont(FONT, 9)
        c.setFillColor(MUTED)
        c.drawString(x0 + 3, y - 4, "Noch kein Material geplant oder entnommen.")
    for index, line in enumerate(material.lines, start=1):
        cells = _cells(index, line)
        row_h = max(14.0, 4 + _LINE_H * max(len(lines) for lines in cells.values()))
        if y - row_h < _BOTTOM:
            c.showPage()
            page_no += 1
            y = start_page(page_no)
        if index % 2 == 0:
            c.setFillColor(ZEBRA)
            c.rect(x0, y - row_h + 9, total, row_h, stroke=0, fill=1)
        c.setStrokeColor(GRID)
        c.setLineWidth(0.4)
        c.line(x0, y - row_h + 9, x0 + total, y - row_h + 9)
        x = x0
        for key, _title, column_width in _COLUMNS:
            text_y = y
            for part in cells[key]:
                c.setFillColor(part.color)
                c.setFont(part.font, part.size)
                if key in _NUMERIC:
                    c.drawRightString(x + column_width - 6, text_y, part.text)
                else:
                    c.drawString(x + 3, text_y, part.text)
                text_y -= _LINE_H
            x += column_width
        y -= row_h

    free_text = sum(1 for line in material.lines if not counts_toward_picking(line))
    summary = (
        f"{len(material.lines)} Positionen · Soll {material.planned_total} · entnommen {material.scanned_total} · "
        f"offen {material.open_lines}"
    )
    if free_text:
        positions = "Freitext-Position" if free_text == 1 else "Freitext-Positionen"
        summary += f" · {free_text} {positions} ohne Lagerartikel (nicht gezählt)"
    c.setFillColor(MUTED)
    c.setFont(FONT, 7.5)
    c.drawString(x0, 44, f"{summary} · erstellt mit der SMPL Workflow-App")
    c.showPage()
    c.save()
    return buffer.getvalue()
