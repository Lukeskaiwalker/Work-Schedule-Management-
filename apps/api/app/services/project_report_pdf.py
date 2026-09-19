"""Projektbericht PDF rendering: one sheet with everything about the project.

Takes the snapshot ``project_report_data.collect_project_report_data`` made
and lays it out in the Baustellenbericht's dress — same fonts, colours,
margins and numbered section badges — so the two read as one family of
documents. The building blocks are imported from there rather than copied:
they ARE the house style, and a second copy would drift the moment the
next operator request lands on one of them.

One layout rule of its own: sections are flat, not boxed. The construction
report wraps each section in a bordered Table, and a Table cell cannot break
across pages — fine for a one-page site report, fatal for a project with
forty notes and a dozen site reports. Here every section is a heading
followed by free-flowing paragraphs and row-splittable tables, so the
document grows to whatever length the project has.
"""

from __future__ import annotations

from datetime import date, datetime
from html import escape
from io import BytesIO
from typing import Any

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.services.construction_report_pdf import (
    _COLOR_BADGE,
    _COLOR_BOX_BORDER,
    _COLOR_GRID,
    _COLOR_HEADER_BG,
    _COLOR_MUTED,
    _COLOR_TEXT,
    _build_styles,
    _cell,
    _scaled_image_from_path,
    sanitize_filename,
)
from app.services.project_report_data import (
    ProjectReportData,
    ReportConstructionReport,
    ReportMaterialLine,
)

TITLE = "Projektbericht"
# Printed where a section has nothing to show, so the reader knows the
# section was considered rather than dropped.
EMPTY = "keine"

_PAGE_MARGIN = 14 * mm
_FOOTER_Y = 8 * mm

_BODY_STYLE = ParagraphStyle(name="ReportBody", fontName="Helvetica", fontSize=8.5, leading=11, textColor=_COLOR_TEXT)
_MUTED_STYLE = ParagraphStyle(name="ReportMuted", fontName="Helvetica", fontSize=8, leading=10, textColor=_COLOR_MUTED)
_ENTRY_HEAD_STYLE = ParagraphStyle(
    name="ReportEntryHead", fontName="Helvetica-Bold", fontSize=8.5, leading=11, textColor=_COLOR_TEXT, spaceBefore=3
)
_SUBLABEL_STYLE = ParagraphStyle(
    name="ReportSublabel", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=_COLOR_MUTED, spaceBefore=2
)
_BULLET_STYLE = ParagraphStyle(
    name="ReportBulletItem", fontName="Helvetica", fontSize=8.5, leading=11, leftIndent=12, firstLineIndent=-10,
    textColor=_COLOR_TEXT,
)


# ── Public entry points ──────────────────────────────────────────────────────


def build_project_report_filename(project_number: str, when: datetime | date) -> str:
    """``Projektbericht_<number>_<date>.pdf`` — sorts by project, then by
    finalization date, which is what a Berichte folder with two of them needs."""
    stamp = when.date().isoformat() if isinstance(when, datetime) else when.isoformat()
    return f"Projektbericht_{sanitize_filename(project_number or 'projekt')}_{stamp}.pdf"


def render_project_report_pdf(
    data: ProjectReportData,
    *,
    final: bool,
    generated_at: datetime,
    logo_path: str | None = None,
    company_name: str | None = None,
) -> bytes:
    """The report as PDF bytes. ``final`` only changes the footer's wording:
    a preview says so on every page, the stored copy names its date."""
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        topMargin=_PAGE_MARGIN,
        bottomMargin=_PAGE_MARGIN + 4 * mm,
        leftMargin=_PAGE_MARGIN,
        rightMargin=_PAGE_MARGIN,
        title=f"{TITLE} {data.project_number}",
        author=company_name or "",
    )
    styles = _build_styles()
    width = doc.width
    footer_text = _footer_text(data.project_number, final=final, generated_at=generated_at)

    elements: list[Any] = []
    elements.extend(_header(styles, data, width, logo_path=logo_path, generated_at=generated_at))
    elements.extend(_section_kopf(styles, data, width))
    elements.extend(_section_team(styles, data, width))
    elements.extend(_section_aufgaben(styles, data, width))
    elements.extend(_section_notizen(styles, data))
    elements.extend(_section_baustellenberichte(styles, data, width))
    elements.extend(_section_material(styles, data, width))
    elements.extend(_section_dateien(styles, data, width))
    elements.extend(_section_verlauf(styles, data, width))

    def draw_footer(canvas, document) -> None:
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(_COLOR_MUTED)
        canvas.drawString(document.leftMargin, _FOOTER_Y, footer_text)
        canvas.drawRightString(document.pagesize[0] - document.rightMargin, _FOOTER_Y, f"Seite {document.page}")
        canvas.restoreState()

    doc.build(elements, onFirstPage=draw_footer, onLaterPages=draw_footer)
    return buffer.getvalue()


def _footer_text(project_number: str, *, final: bool, generated_at: datetime) -> str:
    stamp = _fmt_datetime(generated_at)
    if final:
        return f"{TITLE} {project_number} — Abschlussbericht, finalisiert am {stamp}"
    return f"{TITLE} {project_number} — Vorschau, Stand {stamp}"


# ── Formatting ───────────────────────────────────────────────────────────────


def _fmt_date(value: date | datetime | None) -> str:
    if value is None:
        return "—"
    return value.strftime("%d.%m.%Y")


def _fmt_datetime(value: datetime | None) -> str:
    if value is None:
        return "—"
    return value.strftime("%d.%m.%Y %H:%M")


def _fmt_hours(hours: float | None) -> str:
    if hours is None:
        return "—"
    return f"{hours:.2f} h".replace(".", ",")


def _fmt_range(start: date | None, end: date | None) -> str:
    if start is None:
        return "—"
    if end is None or end == start:
        return _fmt_date(start)
    return f"{_fmt_date(start)} – {_fmt_date(end)}"


def _or_dash(value: str) -> str:
    return value.strip() or "—"


def _para(text: str, style: ParagraphStyle = _BODY_STYLE) -> Paragraph:
    return Paragraph(escape(text).replace("\n", "<br/>"), style)


def _bullets(items: tuple[str, ...] | list[str]) -> list[Any]:
    if not items:
        return [_para(EMPTY, _MUTED_STYLE)]
    return [Paragraph(f"•   {escape(item)}", _BULLET_STYLE) for item in items]


# ── Building blocks ──────────────────────────────────────────────────────────


def _header(styles, data: ProjectReportData, width: float, *, logo_path: str | None, generated_at: datetime) -> list[Any]:
    """Logo, title, and the project's identity on the right — the
    Baustellenbericht's three columns without its Bericht-Nr. row."""
    logo_cell: Any = _scaled_image_from_path(logo_path, max_width=60 * mm, max_height=28 * mm) or ""
    title = Paragraph(escape(TITLE), styles["DocTitle"])
    meta = Table(
        [
            [_meta_label("Projekt-Nr.:"), _meta_value(data.project_number)],
            [_meta_label("Status:"), _meta_value(data.status_label)],
            [_meta_label("Stand:"), _meta_value(_fmt_datetime(generated_at))],
        ],
        colWidths=[24 * mm, 30 * mm],
    )
    meta.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    left, right = 65 * mm, 54 * mm
    header = Table([[logo_cell, title, meta]], colWidths=[left, width - left - right, right])
    header.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    name = Paragraph(
        f"<b>{escape(data.name)}</b>"
        + (' <font color="#DC2626" size="8"><b>· KRITISCH</b></font>' if data.is_critical else ""),
        ParagraphStyle(name="ReportProjectName", fontName="Helvetica", fontSize=11, leading=14, textColor=_COLOR_TEXT),
    )
    return [header, Spacer(0, 6), name, Spacer(0, 6)]


def _meta_label(text: str) -> Paragraph:
    return Paragraph(escape(text), ParagraphStyle(name="_rl", fontName="Helvetica", fontSize=8, leading=10, textColor=_COLOR_MUTED, alignment=2))


def _meta_value(text: str) -> Paragraph:
    return Paragraph(escape(text), ParagraphStyle(name="_rv", fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=_COLOR_TEXT, alignment=2))


def _section_heading(styles, number: int, title: str, width: float) -> Any:
    """The numbered badge and title of the construction report, on a rule
    instead of in a box, so what follows can flow across pages."""
    badge = Table([[Paragraph(f"<b>{number}</b>", styles["SectionBadge"])]], colWidths=[8 * mm], rowHeights=[6 * mm])
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _COLOR_BADGE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    row = Table([[badge, Paragraph(f"<b>{escape(title)}</b>", styles["SectionTitle"])]], colWidths=[10 * mm, width - 10 * mm])
    row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.6, _COLOR_BOX_BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return row


def _key_value(rows: list[tuple[str, str]], width: float) -> Table:
    table = Table([[_cell(k, bold=True), _cell(v or "—")] for k, v in rows], colWidths=[width * 0.28, width * 0.72])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), _COLOR_HEADER_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, _COLOR_GRID),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def _grid(headers: list[str], rows: list[list[str]], widths: list[float]) -> Table:
    """A header row that repeats on every page the table spills onto."""
    data = [[_cell(h, bold=True) for h in headers]] + [[_cell(v) for v in row] for row in rows]
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _COLOR_HEADER_BG),
        ("GRID", (0, 0), (-1, -1), 0.25, _COLOR_GRID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _section(styles, number: int, title: str, width: float, body: list[Any]) -> list[Any]:
    # The heading travels with the first line of its body, never alone at a
    # page's foot.
    first, rest = (body[0], body[1:]) if body else (_para(EMPTY, _MUTED_STYLE), [])
    return [KeepTogether([_section_heading(styles, number, title, width), Spacer(0, 3), first]), *rest, Spacer(0, 4)]


# ── Sections ─────────────────────────────────────────────────────────────────


def _section_kopf(styles, data: ProjectReportData, width: float) -> list[Any]:
    customer = data.customer
    contact_bits = [bit for bit in (customer.contact, customer.email, customer.phone) if bit]
    rows = [
        ("Projektnummer", data.project_number),
        ("Name", data.name),
        ("Status", data.status_label),
        ("Kunde", _or_dash(customer.name)),
        ("Kundenadresse", _or_dash(customer.address)),
        ("Ansprechpartner", " / ".join(contact_bits) or "—"),
        ("Baustellenadresse", _or_dash(data.site_address or customer.address)),
        ("Zugang", _or_dash(data.site_access)),
        ("Angelegt am", _fmt_datetime(data.created_at)),
        ("Letzte Änderung", _fmt_datetime(data.last_updated_at)),
        ("Kritisch", f"ja, seit {_fmt_datetime(data.critical_since)}" if data.is_critical else "nein"),
        ("Projektklassen", ", ".join(data.classes) or "—"),
    ]
    rows.extend(data.extra_attributes)
    return _section(styles, 1, "PROJEKT & KUNDE", width, [_key_value(rows, width)])


def _section_team(styles, data: ProjectReportData, width: float) -> list[Any]:
    if not data.members:
        return _section(styles, 2, "TEAM", width, [_para(EMPTY, _MUTED_STYLE)])
    rows = [[member.display_name, "Projektleitung" if member.can_manage else "Mitarbeiter"] for member in data.members]
    return _section(styles, 2, "TEAM", width, [_grid(["Name", "Rolle"], rows, [width * 0.6, width * 0.4])])


def _section_aufgaben(styles, data: ProjectReportData, width: float) -> list[Any]:
    summary = _para(f"{data.open_task_count} offen · {data.done_task_count} erledigt", _MUTED_STYLE)
    if not data.tasks:
        return _section(styles, 3, "AUFGABEN", width, [summary, _para(EMPTY, _MUTED_STYLE)])
    rows = [
        [task.title, task.status_label, _fmt_range(task.due_date, task.end_date), ", ".join(task.assignees) or "—", task.box or "—"]
        for task in data.tasks
    ]
    widths = [width * share for share in (0.32, 0.12, 0.19, 0.19, 0.18)]
    return _section(styles, 3, "AUFGABEN", width, [summary, Spacer(0, 2), _grid(["Aufgabe", "Status", "Von – Bis", "Mitarbeiter", "Kiste"], rows, widths)])


def _section_notizen(styles, data: ProjectReportData) -> list[Any]:
    width_hint = A4[0] - 2 * _PAGE_MARGIN
    if not data.notes:
        return _section(styles, 4, "INTERNE NOTIZEN", width_hint, [_para(EMPTY, _MUTED_STYLE)])
    # Head and body of a note stay on one page together; a note longer than
    # a page still splits, KeepTogether only refuses to strand the head.
    body = [
        KeepTogether([_para(f"{_fmt_datetime(note.created_at)} · {note.author}", _ENTRY_HEAD_STYLE), _para(note.body)])
        for note in data.notes
    ]
    return _section(styles, 4, "INTERNE NOTIZEN", width_hint, body)


def _section_baustellenberichte(styles, data: ProjectReportData, width: float) -> list[Any]:
    if not data.construction_reports:
        return _section(styles, 5, "BAUSTELLENBERICHTE", width, [_para(EMPTY, _MUTED_STYLE)])
    body: list[Any] = []
    for index, report in enumerate(data.construction_reports):
        if index:
            body.append(Spacer(0, 4))
        body.extend(_construction_report_block(report, width))
    return _section(styles, 5, "BAUSTELLENBERICHTE", width, body)


def _construction_report_block(report: ReportConstructionReport, width: float) -> list[Any]:
    number = f"#{report.number}" if report.number is not None else "#—"
    head = Paragraph(
        f"<b>{escape(number)} · {_fmt_date(report.report_date)} · {escape(report.author)}</b>",
        ParagraphStyle(name="ReportSiteHead", parent=_ENTRY_HEAD_STYLE, fontSize=9, leading=12, textColor=_COLOR_BADGE),
    )
    blocks: list[Any] = [head, _para("Mitarbeiter & Stunden", _SUBLABEL_STYLE)]
    if report.workers:
        rows = [[w.name, w.start_time or "—", w.end_time or "—", _fmt_hours(w.hours)] for w in report.workers]
        rows.append(["Gesamt", "", "", _fmt_hours(report.total_hours)])
        blocks.append(_grid(["Mitarbeiter", "Start", "Ende", "Stunden"], rows, [width * s for s in (0.46, 0.18, 0.18, 0.18)]))
    else:
        blocks.append(_para(EMPTY, _MUTED_STYLE))
    blocks.append(_para("Ausgeführte Arbeiten", _SUBLABEL_STYLE))
    blocks.append(_para(report.work_done if report.work_done != "-" else EMPTY, _BODY_STYLE if report.work_done != "-" else _MUTED_STYLE))
    blocks.append(_para("Verbrauchtes Material", _SUBLABEL_STYLE))
    blocks.extend(_material_lines(report.materials_consumed, width))
    blocks.append(_para("Benötigtes Material", _SUBLABEL_STYLE))
    blocks.extend(_material_lines(report.materials_needed, width))
    blocks.append(_para("Offene Punkte / nächste Schritte", _SUBLABEL_STYLE))
    blocks.extend(_bullets(report.open_points))
    blocks.append(_para("Büro-Nacharbeit", _SUBLABEL_STYLE))
    blocks.extend(_bullets(report.office_rework))
    if report.incidents:
        blocks.append(_para("Hinweise / Bemerkungen", _SUBLABEL_STYLE))
        blocks.extend(_bullets(report.incidents))
    photos = f"{report.photo_count} Fotos (siehe Bericht {number})" if report.photo_count else "keine Fotos"
    blocks.append(_para(photos, _MUTED_STYLE))
    # The head and the first sub-label stay together; the rest may break.
    return [KeepTogether(blocks[:3]), *blocks[3:]]


def _material_lines(lines: tuple[ReportMaterialLine, ...], width: float) -> list[Any]:
    if not lines:
        return [_para(EMPTY, _MUTED_STYLE)]
    rows = [[line.item, line.qty or "—", line.unit or "—", line.note or "—"] for line in lines]
    return [_grid(["Material", "Menge", "Einheit", "Bemerkung"], rows, [width * s for s in (0.44, 0.14, 0.14, 0.28)])]


def _section_material(styles, data: ProjectReportData, width: float) -> list[Any]:
    if not data.material_needs:
        return _section(styles, 6, "MATERIAL (BEDARFE)", width, [_para(EMPTY, _MUTED_STYLE)])
    rows = [
        [need.item, need.article_no or "—", f"{need.quantity} {need.unit}".strip() or "—", need.status_label, _fmt_date(need.ordered_at)]
        for need in data.material_needs
    ]
    widths = [width * s for s in (0.40, 0.16, 0.14, 0.14, 0.16)]
    return _section(styles, 6, "MATERIAL (BEDARFE)", width, [_grid(["Artikel", "Art.-Nr.", "Menge", "Status", "Bestellt am"], rows, widths)])


def _section_dateien(styles, data: ProjectReportData, width: float) -> list[Any]:
    if not data.files:
        return _section(styles, 7, "DATEIEN", width, [_para(EMPTY, _MUTED_STYLE)])
    rows = [[f.folder or "—", f.file_name, _fmt_datetime(f.created_at)] for f in data.files]
    return _section(styles, 7, "DATEIEN", width, [_grid(["Ordner", "Datei", "Hochgeladen"], rows, [width * s for s in (0.22, 0.56, 0.22)])])


def _section_verlauf(styles, data: ProjectReportData, width: float) -> list[Any]:
    if not data.activities:
        return _section(styles, 8, "VERLAUF", width, [_para(EMPTY, _MUTED_STYLE)])
    rows = [[_fmt_datetime(a.created_at), a.label, a.message or "—", a.actor] for a in data.activities]
    widths = [width * s for s in (0.20, 0.26, 0.34, 0.20)]
    body = [_grid(["Zeitpunkt", "Ereignis", "Details", "Von"], rows, widths), Spacer(0, 6), _para("Finanzen: siehe Finanzen-Tab.", _MUTED_STYLE)]
    return _section(styles, 8, "VERLAUF", width, body)
