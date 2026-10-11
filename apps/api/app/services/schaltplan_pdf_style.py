"""Palette and text primitives shared by the Verteilerplan PDF sheets.

``schaltplan_pdf.py`` (diagram + legend) and ``schaltplan_pdf_terminals.py``
(Reihenklemmen) draw on the same canvas and must look like one document, so
the brand colours, the two fonts, the header bar and the word-wrapper live
here rather than in either sheet module. The palette is kept identical to
the Baustellenbericht (``construction_report_pdf``) on purpose: a customer
receiving both documents sees one company, not two.
"""

from __future__ import annotations

from typing import Any

from reportlab.lib import colors
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdfcanvas

BLUE = colors.HexColor("#2f70b7")
BLUE_DEEP = colors.HexColor("#225a96")
BLUE_TINT = colors.HexColor("#eef3fa")
INK = colors.HexColor("#14293d")
MUTED = colors.HexColor("#6b7280")
LINE = colors.HexColor("#c9d9ea")
GRID = colors.HexColor("#d8dce0")
WARN = colors.HexColor("#b45309")
# Every second table row, on the legend and the terminal list alike.
ZEBRA = colors.HexColor("#f6f9fd")

FONT = "Helvetica"
FONT_BOLD = "Helvetica-Bold"


def wrap(text: str, font: str, size: float, max_width: float, max_lines: int) -> list[str]:
    """Greedy word wrap into at most ``max_lines`` lines, none wider than ``max_width``.

    A word wider than the column on its own is hard-cut and marked "…" —
    wherever it stands, not only first (review 2026-10-09: "UG
    Hauswirtschaftsraum" printed its second word into "Gerät"). It is never
    dropped: an un-wrappable token like a cable spec ``NYM-J5x2,5mm²``
    silently vanishing is worse, on a document someone wires a building
    from, than a mid-word break. Text left over when the lines run out ends
    the last line in "…", inside the column.
    """

    if not text or max_lines <= 0:
        return []

    def fits(value: str) -> bool:
        return stringWidth(value, font, size) <= max_width

    def with_ellipsis(value: str) -> str:
        # "…" is wider than most letters: give way character by character
        # until the mark fits too (it ran 1–2 pt into "Raum" before).
        cut = value.rstrip()
        while cut and not fits(cut + "…"):
            cut = cut[:-1].rstrip()
        return cut + "…"

    lines: list[str] = []
    current = ""
    for word in text.split():
        candidate = f"{current} {word}" if current else word
        if fits(candidate):
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
            if len(lines) == max_lines:
                lines[-1] = with_ellipsis(lines[-1])
                return lines
        if fits(word):
            current = word
            continue
        lines.append(with_ellipsis(word))
        if len(lines) == max_lines:
            return lines
    if current:
        lines.append(current)
    return lines


def text_of(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def header_bar(c: pdfcanvas.Canvas, width: float, height: float, title: str, company: str) -> None:
    c.setFillColor(BLUE)
    c.rect(0, height - 34, width, 34, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont(FONT_BOLD, 13)
    c.drawString(34, height - 23, title)
    c.setFont(FONT, 9)
    c.drawRightString(width - 34, height - 22, company)
