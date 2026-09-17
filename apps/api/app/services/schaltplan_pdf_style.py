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
    """Greedy word wrap. Overlong single words are hard-cut, never dropped.

    An un-wrappable token (a cable spec like ``NYM-J5x2,5mm²``) would
    otherwise silently vanish from the drawing — worse than a mid-word break
    on a document someone wires a building from.
    """

    if not text:
        return []
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if stringWidth(candidate, font, size) <= max_width or not current:
            if stringWidth(candidate, font, size) > max_width and not current:
                # single word too long — hard cut
                cut = word
                while cut and stringWidth(cut + "…", font, size) > max_width:
                    cut = cut[:-1]
                lines.append(cut + "…" if cut != word else word)
                current = ""
                continue
            current = candidate
        else:
            lines.append(current)
            current = word
        if len(lines) == max_lines:
            break
    if current and len(lines) < max_lines:
        lines.append(current)
    if len(lines) == max_lines and current and lines[-1] != current:
        # Signal the truncation rather than pretending the text ended.
        lines[-1] = lines[-1][: max(0, len(lines[-1]) - 1)] + "…"
    return lines[:max_lines]


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
