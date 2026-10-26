"""Palette and text primitives shared by the Verteilerplan PDF sheets.

``schaltplan_pdf.py`` (diagram + legend) and ``schaltplan_pdf_terminals.py``
(Reihenklemmen) draw on the same canvas and must look like one document, so
the brand colours, the two fonts, the header bar and the word-wrapper live
here rather than in either sheet module. The palette is kept identical to
the Baustellenbericht (``construction_report_pdf``) on purpose: a customer
receiving both documents sees one company, not two.

The drawing sheets (Übersichtsschaltplan, Stromlaufplan allpolig) also share
their furniture here: the drawing area, the full-width title strip, the
conductor colours and their key (docs/SCHALTPLAN_STROMLAUF.md §3).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from types import MappingProxyType
from typing import Any, Mapping

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdfcanvas

from app.services.schaltplan_layout import PANEL_TYPE_LABELS

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


# ── Drawing sheets: frame, title strip, conductor key (SCHALTPLAN_STROMLAUF.md §3) ─

#: The drawing area of every landscape drawing sheet (pt, y up). Everything a
#: sheet draws lies inside it; the header bar is above, the title strip and the
#: conductor key below.
DRAW_X0, DRAW_X1, DRAW_Y0, DRAW_Y1 = 40.0, 802.0, 82.0, 520.0
STRIP_Y0, STRIP_Y1 = 24.0, 70.0
KEY_Y = 73.5
FIT_SIZE, FIT_MIN_SIZE = 7.5, 6.5

#: The title strip's cells, left → right: (label, width). They sum to 762 pt,
#: x 40..802. The first cell carries the company and the sheet title.
TITLE_STRIP_CELLS: tuple[tuple[str, float], ...] = (
    ("", 150.0), ("Kunde", 110.0), ("Projekt", 110.0), ("Verteiler", 132.0), ("Art / Ort", 90.0),
    ("Einspeisung von", 60.0), ("Datum", 40.0), ("Stand", 40.0), ("Blatt", 30.0),
)
_CELL_PAD = 3.0


@dataclass(frozen=True)
class ConductorStyle:
    """How one conductor is stroked: a base colour, optionally a 3/3 dashed
    overlay in a second colour (PE, PEN) or a dash pattern of its own."""

    colour: str
    overlay: str | None = None
    dash: tuple[float, float] | None = None


CONDUCTOR_COLOURS: Mapping[str, ConductorStyle] = MappingProxyType({
    "L1": ConductorStyle("#8a5527"),
    "L2": ConductorStyle("#1c2024"),
    "L3": ConductorStyle("#8b929b"),
    "N": ConductorStyle("#2867d1"),
    "PE": ConductorStyle("#2f8f3a", overlay="#e2bf12"),
    "PEN": ConductorStyle("#2f8f3a", overlay="#2867d1"),
    "CTRL": ConductorStyle("#7547c9", dash=(4.0, 3.0)),
    "DATA": ConductorStyle("#0f8b8d", dash=(2.0, 2.0)),
    "L?": ConductorStyle("#b45309"),
})
OVERLAY_DASH = (3.0, 3.0)

#: The key under every Stromlauf sheet: (conductor, words).
CONDUCTOR_KEY: tuple[tuple[str, str], ...] = (
    ("L1", "L1 braun"), ("L2", "L2 schwarz"), ("L3", "L3 grau"), ("N", "N blau"),
    ("PE", "PE grün-gelb"), ("PEN", "PEN grün-gelb/blau"),
)
CROSSING_KEY = "Punkt = Verbindung · Bogen = Kreuzung ohne Verbindung"


_DELTA = "Δ"
_DELTA_EM = 0.612  # Helvetica's advance for Δ


def _segments(text: str) -> list[str]:
    """``text`` cut into runs with every "Δ" a run of its own."""
    runs: list[str] = []
    for index, piece in enumerate(text.split(_DELTA)):
        if index:
            runs.append(_DELTA)
        if piece:
            runs.append(piece)
    return runs


def text_width(text: str, font: str, size: float) -> float:
    """``stringWidth`` that knows the Δ of "IΔn"; an explicit left → right sum."""
    width = 0.0
    for piece in _segments(text):
        width += _DELTA_EM * size if piece == _DELTA else stringWidth(piece, font, size)
    return width


def _draw_delta(c: pdfcanvas.Canvas, left: float, y: float, size: float, bold: bool) -> None:
    """Δ as an outline triangle: the standard fonts (WinAnsi) have no Δ, and the
    Symbol font is not embedded — PDF viewers without it print a black box."""
    width, height = _DELTA_EM * size, 0.70 * size
    c.saveState()
    c.setStrokeColor(c._fillColorObj)  # the text colour
    c.setLineWidth(size * (0.11 if bold else 0.075))
    c.setLineJoin(0)
    path = c.beginPath()
    path.moveTo(left + 0.06 * size, y + 0.04 * size)
    path.lineTo(left + width - 0.06 * size, y + 0.04 * size)
    path.lineTo(left + width / 2, y + height)
    path.close()
    c.drawPath(path, stroke=1, fill=0)
    c.restoreState()


def draw_text(c: pdfcanvas.Canvas, x: float, y: float, text: str, *, font: str, size: float,
              anchor: str = "start") -> None:
    """``drawString`` with an anchor ("start" | "middle" | "end") and the Δ fix."""
    width = text_width(text, font, size)
    left = x - width / 2 if anchor == "middle" else (x - width if anchor == "end" else x)
    c.setFont(font, size)
    for piece in _segments(text):
        if piece == _DELTA:
            _draw_delta(c, left, y, size, font == FONT_BOLD)
            left += _DELTA_EM * size
            continue
        c.drawString(left, y, piece)
        left += stringWidth(piece, font, size)


def fit_text(text: str, font: str, max_width: float, size: float = FIT_SIZE,
             min_size: float = FIT_MIN_SIZE) -> tuple[str, float]:
    """The size (``size`` down to ``min_size`` in 0.25 pt steps) at which
    ``text`` fits ``max_width``; below that, cut and ended in "…"."""
    current = size
    while text_width(text, font, current) > max_width and current - 0.25 >= min_size - 1e-9:
        current = round(current - 0.25, 2)
    if text_width(text, font, current) <= max_width:
        return text, current
    cut = text.rstrip()
    while cut and text_width(cut + "…", font, current) > max_width:
        cut = cut[:-1].rstrip()
    return (cut + "…" if cut else "…"), current


@dataclass(frozen=True)
class TitleStrip:
    """What the title strip says; the same on every drawing sheet but Blatt."""

    company: str
    sheet_title: str
    customer: str
    project: str
    board: str
    kind_place: str
    fed_from: str
    date: str
    status: str
    revision: str


def title_strip_for(plan: Any, *, customer_name: str | None, project_label: str | None, fed_from: str | None,
                    company: str, title: str) -> TitleStrip:
    """The title strip of a drawing sheet from the board (``PanelPlan``) and the route's names."""
    kind = PANEL_TYPE_LABELS.get(plan.panel_type, plan.panel_type)
    return TitleStrip(
        company=company, sheet_title=title, customer=text_of(customer_name), project=text_of(project_label),
        board=" · ".join(p for p in (text_of(plan.designation), text_of(plan.name)) if p),
        kind_place=f"{kind}" + (f" · {plan.location}" if plan.location else ""),
        fed_from=text_of(fed_from), date=datetime.now().strftime("%d.%m.%Y"),
        status="Bestand" if plan.status == "final" else "Entwurf", revision=str(plan.revision),
    )


def _strip_values(strip: TitleStrip, sheet: int, sheets: int) -> list[tuple[list[str], bool]]:
    """Per cell: its value lines and whether the first is the company line."""
    return [
        ([strip.company, strip.sheet_title], True),
        ([strip.customer or "—"], False),
        ([strip.project or "—"], False),
        ([strip.board or "—"], False),
        ([strip.kind_place or "—"], False),
        ([strip.fed_from or "Netz / HAK"], False),
        ([strip.date], False),
        ([strip.status, f"Rev. {strip.revision}"], False),
        ([f"{sheet}/{sheets}"], False),
    ]


def draw_title_strip(c: pdfcanvas.Canvas, strip: TitleStrip, *, sheet: int, sheets: int) -> None:
    """The full-width title strip at the bottom of a drawing sheet (§3)."""
    x = DRAW_X0
    height = STRIP_Y1 - STRIP_Y0
    c.saveState()
    for (label, width), (values, company_cell) in zip(TITLE_STRIP_CELLS, _strip_values(strip, sheet, sheets)):
        c.setStrokeColor(BLUE_DEEP if company_cell else LINE)
        c.setLineWidth(0.8)
        c.setFillColor(BLUE_TINT if company_cell else colors.white)
        c.rect(x, STRIP_Y0, width, height, stroke=1, fill=1)
        inner = width - 2 * _CELL_PAD
        line_y = STRIP_Y1 - 10.0
        if label:
            text, size = fit_text(label, FONT, inner, FIT_MIN_SIZE)
            c.setFillColor(MUTED)
            draw_text(c, x + _CELL_PAD, line_y, text, font=FONT, size=size)
            line_y -= 13.0
        for index, value in enumerate(values):
            font = FONT_BOLD if index == 0 else FONT
            text, size = fit_text(value, font, inner)
            c.setFillColor(BLUE_DEEP if company_cell and index == 0 else (WARN if value == "Entwurf" else INK))
            draw_text(c, x + _CELL_PAD, line_y, text, font=font, size=size)
            line_y -= 10.0
        x += width
    c.restoreState()


def stroke_conductor(c: pdfcanvas.Canvas, conductor: str) -> ConductorStyle:
    """Set the stroke colour and dash of ``conductor``'s base line; returns its style."""
    style = CONDUCTOR_COLOURS.get(conductor, CONDUCTOR_COLOURS["L?"])
    c.setStrokeColor(colors.HexColor(style.colour))
    if style.dash:
        c.setDash(*style.dash)
    else:
        c.setDash()
    return style


def draw_conductor_key(c: pdfcanvas.Canvas, note: str = "") -> None:
    """The colour key and the crossing convention above the title strip (§3);
    ``note``: the sheet's "L? = …" line, right-aligned in WARN."""
    c.saveState()
    x = DRAW_X0
    size = FIT_MIN_SIZE
    for conductor, words in CONDUCTOR_KEY:
        style = stroke_conductor(c, conductor)
        c.setLineWidth(1.6)
        c.line(x, KEY_Y + 2.2, x + 12, KEY_Y + 2.2)
        if style.overlay:
            c.setStrokeColor(colors.HexColor(style.overlay))
            c.setDash(*OVERLAY_DASH)
            c.line(x, KEY_Y + 2.2, x + 12, KEY_Y + 2.2)
            c.setDash()
        c.setFillColor(INK)
        draw_text(c, x + 15, KEY_Y, words, font=FONT, size=size)
        x += 15 + text_width(words, FONT, size) + 9
    c.setFillColor(MUTED)
    draw_text(c, x + 6, KEY_Y, CROSSING_KEY, font=FONT, size=size)
    if note:
        c.setFillColor(WARN)
        draw_text(c, DRAW_X1, KEY_Y, note, font=FONT_BOLD, size=size, anchor="end")
    c.restoreState()


def draw_drawing_furniture(c: pdfcanvas.Canvas, *, title: str, company: str, strip: TitleStrip,
                           sheet: int, sheets: int) -> None:
    """A landscape drawing sheet's furniture: header bar, frame, title strip."""
    width, height = landscape(A4)
    c.setPageSize((width, height))
    header_bar(c, width, height, title, company)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.8)
    c.rect(24, 20, width - 48, height - 20 - 44, stroke=1, fill=0)
    draw_title_strip(c, strip, sheet=sheet, sheets=sheets)
