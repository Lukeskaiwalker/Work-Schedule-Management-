"""Packliste — the printable packing list for one task.

A task that pulls its material from a Baustellenkiste already knows what has
to go out of the door (services/task_materials.py). The screen shows that
list; the van does not have the screen. This renders it as an A4 sheet with
a tick box per line so the person loading up can work through it.

Pure layout, no database: the router resolves the task, its lines and the
display strings, this module only draws. That keeps the renderer testable
with plain data and keeps access rules where they belong.

Fonts: the standard-14 Helvetica pair, same as schaltplan_pdf.py and
construction_report_pdf.py. ReportLab writes them WinAnsi-encoded, so
ä/ö/ü/ß render without registering a TrueType face. Glyphs outside Latin-1
(☐, →) do not exist in those faces — which is why the tick box is drawn with
canvas primitives rather than typed as a character.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from html import escape
from io import BytesIO
from typing import Any, Callable, Sequence

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    Flowable,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

_FONT = "Helvetica"
_FONT_BOLD = "Helvetica-Bold"

# Brand palette shared with the Baustellenbericht and the Schaltplan.
_BLUE = colors.HexColor("#2f70b7")
_INK = colors.HexColor("#14293d")
_MUTED = colors.HexColor("#6b7280")
_GRID = colors.HexColor("#d8dce0")
_HEADER_BG = colors.HexColor("#eef3fa")

_MARGIN = 14 * mm
_FOOTER_HEIGHT = 8 * mm
_CHECKBOX_SIZE = 3.6 * mm
_PRODUCT_LABEL = "SMPL"
_DATE_FMT = "%d.%m.%Y"
_DATETIME_FMT = "%d.%m.%Y %H:%M"

_TITLE = "Packliste"
# Checkbox, Menge, Einheit, Artikel, Art.-Nr., Notiz — fractions of the
# usable width. Artikel gets the room because names are the long column.
_HEADERS = ("", "Menge", "Einheit", "Artikel", "Art.-Nr.", "Notiz")
_COLUMN_FRACTIONS = (0.05, 0.08, 0.09, 0.40, 0.16, 0.22)
_QUANTITY_COLUMN = 1

_TITLE_STYLE = ParagraphStyle(
    name="PackTitle", fontName=_FONT_BOLD, fontSize=19, leading=23, textColor=_BLUE
)
_TASK_STYLE = ParagraphStyle(
    name="PackTask", fontName=_FONT_BOLD, fontSize=12.5, leading=16, textColor=_INK,
    spaceBefore=2,
)
_META_STYLE = ParagraphStyle(
    name="PackMeta", fontName=_FONT, fontSize=9, leading=12, textColor=_INK
)
_CELL_STYLE = ParagraphStyle(
    name="PackCell", fontName=_FONT, fontSize=9, leading=11, textColor=_INK
)
_CELL_RIGHT_STYLE = ParagraphStyle(name="PackCellRight", parent=_CELL_STYLE, alignment=TA_RIGHT)
_CELL_BOLD_STYLE = ParagraphStyle(name="PackCellBold", parent=_CELL_STYLE, fontName=_FONT_BOLD)


@dataclass(frozen=True)
class PackingLine:
    """One row of the list, detached from any ORM object.

    ``TaskMaterial`` rows are accepted by the renderer as they are (same
    attribute names). This is the shape for rows that have no database line
    behind them — the free-text ``materials_required`` fallback.
    """

    item_name: str
    quantity: int | None = None
    unit: str | None = None
    article_no: str | None = None
    notes: str | None = None
    quantity_used: int | None = None


_BULLET_CHARS = "-*•·"


def lines_from_free_text(text: str | None) -> list[PackingLine]:
    """One line per non-empty line of ``Task.materials_required``.

    Quantity stays blank on purpose. The note may well say "3x Wago", but
    parsing that is a guess, and a wrong number on a packing list is worse
    than no number — the person packing reads the text anyway.
    """
    if not text:
        return []
    cleaned = (raw.strip().lstrip(_BULLET_CHARS).strip() for raw in text.splitlines())
    return [PackingLine(item_name=line) for line in cleaned if line]


def render_packing_list(
    *,
    task: Any,
    materials: Sequence[Any],
    customer_name: str | None,
    project_label: str | None,
    box_label: str | None,
    generated_at: datetime,
) -> bytes:
    """Render the A4 portrait Packliste and return the PDF bytes.

    ``materials`` are ``TaskMaterial`` rows or :class:`PackingLine` values;
    ``box_label`` is the full box line ("Baustellenkiste Nr. … — …") or None.
    Built twice: the first pass only counts pages so the footer can say
    "Seite n von m" — a two-line list costs nothing, and a long one is
    exactly the case where the total matters.
    """
    if not materials:
        raise ValueError("Packliste ohne Zeilen kann nicht erzeugt werden")
    if not isinstance(generated_at, datetime):
        raise TypeError("generated_at muss ein datetime sein")

    footer_text = f"Erstellt am {generated_at.strftime(_DATETIME_FMT)} · {_PRODUCT_LABEL}"

    def build(total_pages: int) -> tuple[bytes, int]:
        buffer = BytesIO()
        doc = SimpleDocTemplate(
            buffer,
            pagesize=A4,
            topMargin=_MARGIN,
            bottomMargin=_MARGIN + _FOOTER_HEIGHT,
            leftMargin=_MARGIN,
            rightMargin=_MARGIN,
            title=f"{_TITLE} – {_task_title(task)}",
            author=_PRODUCT_LABEL,
        )
        on_page = _page_footer(footer_text, total_pages)
        doc.build(
            _story(task, materials, customer_name, project_label, box_label, doc.width),
            onFirstPage=on_page,
            onLaterPages=on_page,
        )
        return buffer.getvalue(), doc.page

    _, page_count = build(total_pages=0)
    pdf, _ = build(total_pages=page_count)
    return pdf


# ── Story ────────────────────────────────────────────────────────────────────


def _story(
    task: Any,
    materials: Sequence[Any],
    customer_name: str | None,
    project_label: str | None,
    box_label: str | None,
    width: float,
) -> list[Flowable]:
    """Fresh flowables per build: platypus consumes them while laying out."""
    return [
        *_heading(task, customer_name, project_label, box_label),
        Spacer(0, 5 * mm),
        _materials_table(materials, width),
    ]


def _heading(
    task: Any, customer_name: str | None, project_label: str | None, box_label: str | None
) -> list[Flowable]:
    out: list[Flowable] = [
        Paragraph(_TITLE, _TITLE_STYLE),
        Paragraph(escape(_task_title(task)), _TASK_STYLE),
        Spacer(0, 2 * mm),
    ]
    for label, value in _meta_rows(task, customer_name, project_label):
        out.append(Paragraph(f"<b>{escape(label)}:</b> {escape(value)}", _META_STYLE))
    if box_label:
        out.append(Paragraph(escape(box_label), _META_STYLE))
    return out


def _meta_rows(
    task: Any, customer_name: str | None, project_label: str | None
) -> list[tuple[str, str]]:
    candidates = (
        ("Termin", _task_schedule(task)),
        ("Kunde", customer_name),
        ("Projekt", project_label),
    )
    return [(label, value) for label, value in candidates if value]


def _task_title(task: Any) -> str:
    return (getattr(task, "title", None) or "").strip() or "Aufgabe"


def _task_schedule(task: Any) -> str | None:
    """The task's date(s) as one line: due date (or the Von – Bis window of a
    multi-day task) with the daily time and duration, then the planning week
    when the task is pinned to one."""
    parts: list[str] = []
    due_date = getattr(task, "due_date", None)
    if due_date is not None:
        text = due_date.strftime(_DATE_FMT)
        end_date = getattr(task, "end_date", None)
        if end_date is not None and end_date > due_date:
            text += f" – {end_date.strftime(_DATE_FMT)}"
        start_time = getattr(task, "start_time", None)
        if start_time is not None:
            text += f", {start_time.strftime('%H:%M')} Uhr"
        hours = getattr(task, "estimated_hours", None)
        if hours is not None:
            text += f" (ca. {_format_hours(hours)} h)"
        parts.append(text)
    week_start = getattr(task, "week_start", None)
    if week_start is not None:
        parts.append(f"KW {week_start.isocalendar()[1]} ab {week_start.strftime(_DATE_FMT)}")
    return " · ".join(parts) or None


def _format_hours(hours: float) -> str:
    value = float(hours)
    if value.is_integer():
        return str(int(value))
    return f"{value:.1f}".replace(".", ",")


# ── Table ────────────────────────────────────────────────────────────────────


class _CheckboxSquare(Flowable):
    """An empty tick box drawn with canvas primitives (see module docstring)."""

    def __init__(self, size: float) -> None:
        super().__init__()
        self.width = size
        self.height = size

    def draw(self) -> None:
        canvas = self.canv
        canvas.setStrokeColor(_INK)
        canvas.setFillColor(colors.white)
        canvas.setLineWidth(0.8)
        canvas.rect(0, 0, self.width, self.height, stroke=1, fill=1)


def _materials_table(materials: Sequence[Any], width: float) -> Table:
    header = [""] + [_cell(text, style=_CELL_BOLD_STYLE) for text in _HEADERS[1:]]
    data = [header] + [_table_row(row) for row in materials]
    table = Table(
        data,
        colWidths=[width * fraction for fraction in _COLUMN_FRACTIONS],
        repeatRows=1,
    )
    table.setStyle(_table_style())
    return table


def _table_row(row: Any) -> list[Any]:
    quantity = getattr(row, "quantity", None)
    return [
        _CheckboxSquare(_CHECKBOX_SIZE),
        _cell("" if quantity is None else str(quantity), style=_CELL_RIGHT_STYLE),
        _cell(getattr(row, "unit", None) or ""),
        _cell(getattr(row, "item_name", None) or ""),
        _cell(getattr(row, "article_no", None) or ""),
        _cell(_notes_text(row)),
    ]


def _notes_text(row: Any) -> str:
    """The Notiz cell: the line's note, plus what has been reported as used
    when a report already came back for it."""
    notes = (getattr(row, "notes", None) or "").strip()
    used = getattr(row, "quantity_used", None)
    if used is None:
        return notes
    return " ".join(part for part in (notes, f"(gemeldet: {used})") if part)


def _cell(text: str, *, style: ParagraphStyle = _CELL_STYLE) -> Paragraph:
    return Paragraph(escape((text or "").strip()).replace("\n", "<br/>"), style)


def _table_style() -> TableStyle:
    return TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), _HEADER_BG),
            ("LINEBELOW", (0, 0), (-1, 0), 0.8, _BLUE),
            ("GRID", (0, 0), (-1, -1), 0.25, _GRID),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("ALIGN", (0, 0), (0, -1), "CENTER"),
            ("ALIGN", (_QUANTITY_COLUMN, 0), (_QUANTITY_COLUMN, -1), "RIGHT"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("LEFTPADDING", (0, 0), (-1, -1), 4),
            ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ]
    )


# ── Footer ───────────────────────────────────────────────────────────────────


def _page_footer(footer_text: str, total_pages: int) -> Callable[[Any, Any], None]:
    def draw(canvas: Any, doc: Any) -> None:
        canvas.saveState()
        canvas.setFont(_FONT, 8)
        canvas.setFillColor(_MUTED)
        y = _MARGIN * 0.6
        canvas.drawString(doc.leftMargin, y, footer_text)
        page_label = f"Seite {doc.page} von {total_pages}" if total_pages else f"Seite {doc.page}"
        canvas.drawRightString(doc.pagesize[0] - doc.rightMargin, y, page_label)
        canvas.restoreState()

    return draw
