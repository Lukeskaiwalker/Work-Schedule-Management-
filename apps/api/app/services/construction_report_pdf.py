"""Baustellenbericht PDF rendering.

v2.5.13 rewrite: previously this module produced a plain top-to-bottom
stack of section headers + tables that operators found "boring and hard
to read". The new layout matches the design mockup at
docs/baustellenbericht-mockup.jpg — numbered amber section badges,
bordered boxes per section, a horizontal status row with checkboxes,
and a two-column signatures block at the bottom.

Two entry points:

  - ``build_report_pdf_bytes`` produces the main Baustellenbericht.
  - ``build_material_sheet_pdf_bytes`` produces the standalone
    "Materialschein" used as an overflow page when either material
    table has more than ``MATERIAL_OVERFLOW_THRESHOLD`` rows. The
    main PDF still renders the first ``MATERIAL_OVERFLOW_THRESHOLD``
    rows so the report stays self-contained for the common short case.

Both functions accept the report payload dict directly so they can be
called from ``report_jobs.py`` without coupling to the SQLAlchemy
model layer. They are also tolerant of partial payloads: a legacy
report stored before v2.5.13 (no ``status``, no ``signature_*``, no
``distance``, only ``materials`` instead of split lists) still renders
cleanly with sensible placeholders.
"""
from __future__ import annotations

import base64
import re
from datetime import date, datetime
from html import escape
from io import BytesIO
from pathlib import Path
from typing import Any

try:
    from PIL import Image as PILImage
    from PIL import ImageOps
except Exception:  # pragma: no cover - fallback when Pillow is unavailable
    PILImage = None
    ImageOps = None

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import Flowable, Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


class _Checkbox(Flowable):
    """A small drawn checkbox flowable. Renders as either:

      - An outlined empty square (``checked=False``), OR
      - A filled green square with a thick white check stroke inside
        (``checked=True``).

    v2.5.14 replacement for the Unicode ``☑`` / ``☐`` characters used in
    v2.5.13. Helvetica (ReportLab's default font) lacks glyphs for those
    codepoints, so both ended up rendering as the same fallback filled
    square — visually indistinguishable except by colour. Drawing the
    boxes with canvas primitives sidesteps the font-glyph dependency
    entirely.
    """

    def __init__(self, checked: bool, size: float = 8.0) -> None:
        super().__init__()
        self.checked = bool(checked)
        self.size = float(size)
        self.width = float(size)
        self.height = float(size)

    def draw(self) -> None:
        canvas = self.canv
        if self.checked:
            canvas.setFillColor(_COLOR_CHECK)
            canvas.setStrokeColor(_COLOR_CHECK)
            canvas.setLineWidth(0.6)
            canvas.rect(0, 0, self.size, self.size, fill=1, stroke=1)
            # White check stroke. Three points: upper-left, lower-middle,
            # upper-right (with Y growing upwards, so "lower" = smaller Y).
            canvas.setStrokeColor(colors.white)
            canvas.setLineWidth(max(1.0, self.size * 0.16))
            canvas.line(
                self.size * 0.20, self.size * 0.50,
                self.size * 0.42, self.size * 0.25,
            )
            canvas.line(
                self.size * 0.42, self.size * 0.25,
                self.size * 0.82, self.size * 0.72,
            )
        else:
            canvas.setFillColor(colors.white)
            canvas.setStrokeColor(_COLOR_MUTED)
            canvas.setLineWidth(0.7)
            canvas.rect(0, 0, self.size, self.size, fill=1, stroke=1)


# ── Layout constants ────────────────────────────────────────────────────────

# Material tables overflow to a separate Materialschein PDF when they exceed
# this many rows. Picked to fit the visual budget of the main PDF: at 7+ rows
# the section starts crowding the bottom of page 1 and pushes signatures to
# page 2, which looks worse than having a clean second-document Materialschein.
MATERIAL_OVERFLOW_THRESHOLD = 6

# Brand colours pulled from the mockup. Amber for section number badges,
# muted brand blue for the logo accent. Greys for table grid lines.
_COLOR_BADGE = colors.HexColor("#D4A933")   # amber section-number badge
_COLOR_TEXT = colors.HexColor("#222222")    # body text
_COLOR_MUTED = colors.HexColor("#6B7280")   # secondary text (Bemerkung labels)
_COLOR_GRID = colors.HexColor("#D8DCE0")    # table grid lines
_COLOR_HEADER_BG = colors.HexColor("#F1F2F4")  # table header strip
_COLOR_BOX_BORDER = colors.HexColor("#CBD0D6")  # outer box around each section
_COLOR_CHECK = colors.HexColor("#16A34A")   # green check on status
_COLOR_DANGER = colors.HexColor("#DC2626")  # red for "noch nicht unterschrieben"


# ── Public helpers ───────────────────────────────────────────────────────────


def sanitize_filename(value: str) -> str:
    cleaned = value.strip()
    cleaned = cleaned.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned or "report"


def build_report_filename(
    payload: dict[str, Any], report_date: date, *, report_number: int | None = None
) -> str:
    customer = sanitize_filename(str(payload.get("customer") or "construction-report"))
    project_number = payload.get("project_number")
    parts = [customer]
    if project_number:
        parts.append(sanitize_filename(str(project_number)))
    if report_number and report_number > 0:
        parts.append(f"report-{int(report_number):04d}")
    parts.append(report_date.isoformat())
    return "_".join(parts) + ".pdf"


def build_material_sheet_filename(
    payload: dict[str, Any],
    report_date: date,
    *,
    report_number: int | None = None,
    kind: str = "verbrauch",
) -> str:
    """Filename for the overflow Materialschein. ``kind`` is "verbrauch" for
    Verbrauchtes Material or "bedarf" for Materialbedarf — both end up in the
    same Berichte folder alongside the main PDF."""
    customer = sanitize_filename(str(payload.get("customer") or "construction-report"))
    project_number = payload.get("project_number")
    parts = [customer, "materialschein", kind]
    if project_number:
        parts.append(sanitize_filename(str(project_number)))
    if report_number and report_number > 0:
        parts.append(f"report-{int(report_number):04d}")
    parts.append(report_date.isoformat())
    return "_".join(parts) + ".pdf"


def materials_overflow_kind(payload: dict[str, Any]) -> str | None:
    """Returns 'verbrauch', 'bedarf', or None depending on which (if any)
    material list overflows the inline threshold. If BOTH overflow, the
    consumed list wins (signed-off-on-site material has higher operational
    priority than to-order material). Callers that want both Materialscheine
    can branch on each list independently."""
    consumed = _consumed_materials(payload)
    needed = list(payload.get("materials_needed") or [])
    if len(consumed) > MATERIAL_OVERFLOW_THRESHOLD:
        return "verbrauch"
    if len(needed) > MATERIAL_OVERFLOW_THRESHOLD:
        return "bedarf"
    return None


def build_report_pdf_bytes(
    payload: dict[str, Any],
    report_date: date,
    submitted_by: str,
    project_name: str | None = None,
    logo_path: str | None = None,
    company_name: str | None = None,
    photos: list[tuple[str, bytes]] | None = None,
    *,
    report_number: int | None = None,
    has_material_overflow: bool = False,
) -> bytes:
    """Render the main Baustellenbericht PDF.

    ``has_material_overflow`` controls section 8's "Mehrverbrauch an Material
    lt. beiliegendem Materialschein" hint: when True (a separate Materialschein
    PDF was generated for this report), the PDF mentions the attached sheet
    so the reader knows to look for it.
    """
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
    )
    styles = _build_styles()
    width = doc.width

    elements: list[Any] = []
    elements.extend(_doc_header(
        styles,
        report_date,
        logo_path,
        width,
        company_name=company_name,
        submitted_by=submitted_by,
        report_number=report_number,
        project_number=str(payload.get("project_number") or ""),
        title="Baustellenbericht",
    ))

    # ── Section 1: Projekt & Kunde ──────────────────────────────────────────
    elements.append(_section_box(
        styles,
        number=1,
        title="PROJEKT & KUNDE",
        body=_key_value_table(
            [
                ("Kunde", str(payload.get("customer") or "-")),
                ("Projektname", str(payload.get("project_name") or project_name or "-")),
                ("Projektadresse", str(payload.get("customer_address") or "-")),
                ("Ansprechpartner", str(payload.get("customer_contact") or "-")),
                ("Telefon / E-Mail", _format_contact_line(payload)),
            ],
            width,
        ),
        width=width,
    ))

    # ── Section 2: Mitarbeiter & Arbeitszeiten ──────────────────────────────
    elements.append(_section_box(
        styles,
        number=2,
        title="MITARBEITER & ARBEITSZEITEN",
        body=_workers_table(payload.get("workers") or [], width, styles),
        width=width,
    ))

    # ── Section 3: Ausgeführte Arbeiten ─────────────────────────────────────
    elements.append(_section_box(
        styles,
        number=3,
        title="AUSGEFÜHRTE ARBEITEN",
        body=_bullet_list(
            _bullets_from_text(payload.get("work_done"))
            + [str(x) for x in (payload.get("completed_subtasks") or []) if str(x).strip()],
            styles,
        ),
        width=width,
    ))

    # ── Section 4: Offene Arbeiten / Weitere Maßnahmen ──────────────────────
    elements.append(_section_box(
        styles,
        number=4,
        title="OFFENE ARBEITEN / WEITERE MASSNAHMEN",
        body=_bullet_list(_bullets_for_open_tasks(payload), styles),
        width=width,
    ))

    # ── Section 5 + 6: side-by-side Verbrauchtes Material + Materialbedarf ─
    # Two boxes side-by-side. ReportLab doesn't have native column layout,
    # so we put both boxes into a 2-cell outer Table with even columns.
    consumed_rows = _consumed_materials(payload)
    needed_rows = list(payload.get("materials_needed") or [])
    consumed_overflow = len(consumed_rows) > MATERIAL_OVERFLOW_THRESHOLD
    needed_overflow = len(needed_rows) > MATERIAL_OVERFLOW_THRESHOLD
    consumed_inline = consumed_rows[:MATERIAL_OVERFLOW_THRESHOLD]
    needed_inline = needed_rows[:MATERIAL_OVERFLOW_THRESHOLD]

    section_5 = _section_box(
        styles,
        number=5,
        title="VERBRAUCHTES MATERIAL",
        body=_consumed_materials_table(consumed_inline, width / 2 - 6, styles),
        width=width / 2 - 4,
        footer=("siehe Materialschein" if consumed_overflow else None),
    )
    section_6 = _section_box(
        styles,
        number=6,
        title="MATERIALBEDARF",
        title_suffix=" (bitte bestellen)",
        body=_needed_materials_table(needed_inline, width / 2 - 6, styles),
        width=width / 2 - 4,
        footer=("siehe Materialschein" if needed_overflow else None),
    )
    materials_row = Table(
        [[section_5, section_6]],
        colWidths=[width / 2, width / 2],
    )
    materials_row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    elements.append(materials_row)

    # ── Section 7: Hinweise / Bemerkungen ───────────────────────────────────
    elements.append(_section_box(
        styles,
        number=7,
        title="HINWEISE / BEMERKUNGEN",
        body=_bullet_list(_bullets_from_text(payload.get("incidents")), styles),
        width=width,
    ))

    # ── Section 8: STATUS ───────────────────────────────────────────────────
    elements.append(_status_box(
        styles,
        payload,
        width=width,
        has_material_overflow=has_material_overflow or consumed_overflow or needed_overflow,
    ))

    # ── Section 9: Unterschriften ───────────────────────────────────────────
    elements.append(_signatures_box(
        styles,
        payload,
        report_date,
        width=width,
        company_name=company_name,
    ))

    # Photos (legacy) — render on overflow pages if present. Not part of the
    # mockup, but we still want to preserve images uploaded with reports.
    if photos:
        elements.append(Spacer(0, 8))
        elements.append(_section_box(
            styles,
            number=10,
            title="FOTOS",
            body=_photos_table(photos, width - 8 * mm, styles),
            width=width,
        ))

    doc.build(elements)
    return buffer.getvalue()


def build_material_sheet_pdf_bytes(
    payload: dict[str, Any],
    report_date: date,
    *,
    kind: str,
    project_name: str | None = None,
    logo_path: str | None = None,
    company_name: str | None = None,
    report_number: int | None = None,
) -> bytes:
    """Render a standalone Materialschein PDF.

    ``kind`` is "verbrauch" (Verbrauchtes Material) or "bedarf" (Materialbedarf).
    The layout is a single full-width table over the entire page with worker
    + customer signature blocks at the bottom — see the second page of the
    design mockup.
    """
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
    )
    styles = _build_styles()
    width = doc.width

    title_label = (
        "Materialschein – Verbrauchtes Material"
        if kind == "verbrauch"
        else "Materialschein – Benötigtes Material"
    )

    elements: list[Any] = []
    elements.extend(_doc_header(
        styles,
        report_date,
        logo_path,
        width,
        company_name=company_name,
        submitted_by=None,
        report_number=report_number,
        project_number=str(payload.get("project_number") or ""),
        title=title_label,
        compact=True,
    ))

    # Project / customer header strip
    elements.append(_material_sheet_meta_strip(
        styles,
        payload,
        report_date,
        project_name=project_name,
        width=width,
    ))
    elements.append(Spacer(0, 6))

    if kind == "verbrauch":
        rows = _consumed_materials(payload)
    else:
        rows = list(payload.get("materials_needed") or [])
    elements.append(_material_sheet_table(rows, width, styles, kind=kind))

    elements.append(Spacer(0, 16))
    elements.append(_material_sheet_signatures(
        styles,
        payload,
        report_date,
        width=width,
        kind=kind,
    ))

    doc.build(elements)
    return buffer.getvalue()


def build_report_summary_text(
    project_id: int | None,
    report_date: date,
    payload: dict[str, Any],
    submitted_by: str,
) -> str:
    """Plaintext summary string for the Telegram notification payload."""
    workers = payload.get("workers") or []
    materials_consumed = _consumed_materials(payload)
    materials_needed = list(payload.get("materials_needed") or [])
    return (
        "Construction Report\n"
        f"Project ID: {project_id if project_id is not None else 'GENERAL'}\n"
        f"Date: {report_date.isoformat()}\n"
        f"Submitted by: {submitted_by}\n"
        f"Customer: {payload.get('customer') or '-'}\n"
        f"Project: {payload.get('project_name') or '-'}\n"
        f"Project Number: {payload.get('project_number') or '-'}\n"
        f"Workers: {len(workers)} | Verbrauch: {len(materials_consumed)} | Bedarf: {len(materials_needed)}"
    )


def format_work_done_for_report(payload: dict[str, Any]) -> str:
    """Legacy helper still used by callers outside this module. Kept here so
    the import path doesn't break."""
    work_done = str(payload.get("work_done") or "").strip()
    completed_subtasks = _normalize_completed_subtasks(payload.get("completed_subtasks"))
    if not completed_subtasks:
        return work_done or "-"
    lines: list[str] = []
    if work_done:
        lines.append(work_done)
        lines.append("")
    lines.append("Erledigte Teilaufgaben:")
    lines.extend([f"- {entry}" for entry in completed_subtasks])
    return "\n".join(lines).strip() or "-"


def compact_photo_for_pdf(photo_bytes: bytes) -> bytes:
    """Re-encode an uploaded image as a JPEG at quality=72 with a max edge of
    1920px. Unchanged from the pre-v2.5.13 implementation."""
    if not photo_bytes or PILImage is None or ImageOps is None:
        return photo_bytes
    try:
        with PILImage.open(BytesIO(photo_bytes)) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode in {"RGBA", "LA"} or (image.mode == "P" and "transparency" in image.info):
                alpha = image.convert("RGBA")
                flattened = PILImage.new("RGB", alpha.size, (255, 255, 255))
                flattened.paste(alpha, mask=alpha.split()[-1])
                image = flattened
            elif image.mode != "RGB":
                image = image.convert("RGB")
            width, height = image.size
            max_edge = 1920
            if max(width, height) > max_edge:
                scale = max_edge / float(max(width, height))
                resized = (max(1, int(width * scale)), max(1, int(height * scale)))
                resampling = getattr(PILImage, "Resampling", PILImage)
                image = image.resize(resized, resampling.LANCZOS)
            output = BytesIO()
            image.save(output, format="JPEG", quality=72, optimize=True, progressive=True)
            compacted = output.getvalue()
            if len(compacted) >= len(photo_bytes):
                return photo_bytes
            return compacted
    except Exception:
        return photo_bytes


# ── Styles ───────────────────────────────────────────────────────────────────


def _build_styles():
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name="DocTitle",
        fontName="Helvetica-Bold",
        fontSize=22,
        leading=26,
        textColor=_COLOR_TEXT,
        alignment=1,  # centre
    ))
    styles.add(ParagraphStyle(
        name="DocMetaLabel",
        fontName="Helvetica",
        fontSize=8,
        leading=10,
        textColor=_COLOR_MUTED,
        alignment=2,  # right
    ))
    styles.add(ParagraphStyle(
        name="DocMetaValue",
        fontName="Helvetica-Bold",
        fontSize=8,
        leading=10,
        textColor=_COLOR_TEXT,
        alignment=2,
    ))
    styles.add(ParagraphStyle(
        name="SectionBadge",
        fontName="Helvetica-Bold",
        fontSize=10,
        leading=12,
        textColor=colors.white,
        backColor=_COLOR_BADGE,
        alignment=1,
    ))
    styles.add(ParagraphStyle(
        name="SectionTitle",
        fontName="Helvetica-Bold",
        fontSize=10,
        leading=12,
        textColor=_COLOR_TEXT,
    ))
    styles.add(ParagraphStyle(
        name="SectionTitleSuffix",
        fontName="Helvetica",
        fontSize=9,
        leading=11,
        textColor=_COLOR_MUTED,
    ))
    # ReportLab's default sample sheet already defines "Bullet" / "Code" /
    # "Italic" — use prefixed names to avoid the "Style 'X' already defined"
    # KeyError that getSampleStyleSheet().add() raises on collisions.
    styles.add(ParagraphStyle(name="ReportBullet", fontSize=9, leading=12, leftIndent=10, bulletIndent=2))
    styles.add(ParagraphStyle(name="ReportSmall", fontSize=8, leading=10, textColor=_COLOR_MUTED))
    return styles


# ── Document-level header ────────────────────────────────────────────────────


def _doc_header(
    styles,
    report_date: date,
    logo_path: str | None,
    width: float,
    *,
    company_name: str | None,
    submitted_by: str | None,
    report_number: int | None,
    project_number: str,
    title: str,
    compact: bool = False,
) -> list[Any]:
    """Three-column header: logo (left), centered title (middle), metadata (right).

    The mockup's metadata column has Bericht-Nr., Datum, Erstellt von, Projekt-Nr.
    For the Materialschein page the 'Erstellt von' row is dropped (``submitted_by
    is None``).

    ``compact=True`` shrinks the title font (v2.5.14 — the default 22pt
    'Baustellenbericht' size makes the longer 'Materialschein – Verbrauchtes
    Material' wrap to 3 lines in the centre column, which looks terrible)."""
    logo_cell: Any = ""
    if logo_path:
        logo = _scaled_image_from_path(logo_path, max_width=36 * mm, max_height=20 * mm)
        if logo:
            logo_cell = logo

    # Compact mode renders the title at 14pt so the longer Materialschein
    # title fits on a single line. Main report stays at the original 22pt.
    if compact:
        compact_title_style = ParagraphStyle(
            name="_DocTitleCompact",
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=18,
            textColor=_COLOR_TEXT,
            alignment=1,
        )
        title_para = Paragraph(escape(title), compact_title_style)
    else:
        title_para = Paragraph(escape(title), styles["DocTitle"])

    meta_rows: list[list[Any]] = []
    bericht_label = f"{int(report_date.strftime('%Y%m%d')):08d}-{int(report_number or 0):03d}" if report_number else "—"
    meta_rows.append([_meta_label("Bericht-Nr.:"), _meta_value(bericht_label)])
    meta_rows.append([_meta_label("Datum:"), _meta_value(report_date.strftime("%d.%m.%Y"))])
    if submitted_by:
        meta_rows.append([_meta_label("Erstellt von:"), _meta_value(submitted_by)])
    meta_rows.append([_meta_label("Projekt-Nr.:"), _meta_value(project_number or "—")])
    meta_table = Table(meta_rows, colWidths=[24 * mm, 30 * mm])
    meta_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))

    left_width = 50 * mm
    right_width = 54 * mm
    middle_width = width - left_width - right_width
    header_table = Table(
        [[logo_cell, title_para, meta_table]],
        colWidths=[left_width, middle_width, right_width],
    )
    header_table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    spacer_height = 4 if compact else 8
    return [header_table, Spacer(0, spacer_height)]


def _meta_label(text: str) -> Paragraph:
    style = ParagraphStyle(
        name="_m_label", fontName="Helvetica", fontSize=8, leading=10,
        textColor=_COLOR_MUTED, alignment=2,
    )
    return Paragraph(escape(text), style)


def _meta_value(text: str) -> Paragraph:
    style = ParagraphStyle(
        name="_m_value", fontName="Helvetica-Bold", fontSize=8, leading=10,
        textColor=_COLOR_TEXT, alignment=2,
    )
    return Paragraph(escape(text), style)


# ── Section box (numbered amber badge + bordered container) ─────────────────


def _section_box(
    styles,
    *,
    number: int,
    title: str,
    body: Any,
    width: float,
    title_suffix: str = "",
    footer: str | None = None,
) -> Table:
    """Single section: amber numbered badge, title, then body wrapped in a
    bordered box. Used by sections 1-7."""
    badge = Table(
        [[Paragraph(f"<b>{number}</b>", styles["SectionBadge"])]],
        colWidths=[8 * mm],
        rowHeights=[6 * mm],
    )
    badge.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _COLOR_BADGE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))

    title_text = f"<b>{escape(title)}</b>"
    if title_suffix:
        title_text += f' <font color="#6B7280" size=8>{escape(title_suffix)}</font>'
    title_para = Paragraph(title_text, styles["SectionTitle"])

    header_row = Table(
        [[badge, title_para]],
        colWidths=[10 * mm, width - 10 * mm],
    )
    header_row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 1),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))

    inner_rows = [[header_row], [body]]
    if footer:
        inner_rows.append([Paragraph(
            f'<font color="#6B7280" size=8><i>{escape(footer)}</i></font>',
            styles["Normal"],
        )])
    outer = Table(inner_rows, colWidths=[width])
    outer.setStyle(TableStyle([
        ("BOX", (0, 0), (-1, -1), 0.6, _COLOR_BOX_BORDER),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    wrapper = Table([[outer]], colWidths=[width])
    wrapper.setStyle(TableStyle([
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return wrapper


# ── Section 1 helpers ───────────────────────────────────────────────────────


def _format_contact_line(payload: dict[str, Any]) -> str:
    phone = str(payload.get("customer_phone") or "").strip()
    email = str(payload.get("customer_email") or "").strip()
    parts = [p for p in (phone, email) if p]
    return " / ".join(parts) if parts else "-"


def _key_value_table(rows: list[tuple[str, str]], width: float) -> Table:
    data = [[_cell(k, bold=True), _cell(v or "-")] for k, v in rows]
    table = Table(data, colWidths=[(width - 8) * 0.28, (width - 8) * 0.72])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), _COLOR_HEADER_BG),
        ("TEXTCOLOR", (0, 0), (-1, -1), _COLOR_TEXT),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, _COLOR_GRID),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


# ── Section 2 helpers (workers + total) ─────────────────────────────────────


def _workers_table(workers: list[dict[str, Any]], width: float, styles) -> Table:
    headers = ["Mitarbeiter", "Start", "Ende", "Stunden"]
    data: list[list[Any]] = [[_cell(h, bold=True) for h in headers]]
    total_hours = 0.0
    for worker in workers:
        hours = _worker_hours(worker)
        if hours is not None:
            total_hours += hours
        data.append([
            _cell(str(worker.get("name") or "-")),
            _cell(str(worker.get("start_time") or "-")),
            _cell(str(worker.get("end_time") or "-")),
            _cell(_format_hours(hours)),
        ])
    if not workers:
        data.append([_cell("-"), _cell(""), _cell(""), _cell("")])
    # Footer row: Gesamtstunden
    data.append([
        _cell("Gesamtstunden", bold=True), _cell(""), _cell(""),
        _cell(_format_hours(total_hours), bold=True),
    ])
    col_widths = [(width - 8) * x for x in (0.46, 0.18, 0.18, 0.18)]
    table = Table(data, colWidths=col_widths)
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), _COLOR_HEADER_BG),
        ("GRID", (0, 0), (-1, -1), 0.25, _COLOR_GRID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        # Footer styling
        ("BACKGROUND", (0, -1), (-1, -1), _COLOR_HEADER_BG),
        ("LINEABOVE", (0, -1), (-1, -1), 0.6, _COLOR_BOX_BORDER),
    ]
    table.setStyle(TableStyle(style_cmds))
    return table


def _worker_hours(worker: dict[str, Any]) -> float | None:
    start = _parse_time(str(worker.get("start_time") or ""))
    end = _parse_time(str(worker.get("end_time") or ""))
    if start is None or end is None:
        return None
    minutes = (end[0] * 60 + end[1]) - (start[0] * 60 + start[1])
    if minutes < 0:
        # Crossed midnight or operator typo — treat as zero rather than negative.
        return 0.0
    return minutes / 60.0


def _parse_time(raw: str) -> tuple[int, int] | None:
    text = raw.strip()
    if not text:
        return None
    # Accept HH:MM, HH.MM, HHMM and HHh
    m = re.fullmatch(r"(\d{1,2})[:.h](\d{0,2})", text)
    if not m:
        m = re.fullmatch(r"(\d{1,2})(\d{2})", text)
    if not m:
        return None
    try:
        h = int(m.group(1))
        mins = int(m.group(2) or "0")
    except ValueError:
        return None
    if 0 <= h < 24 and 0 <= mins < 60:
        return (h, mins)
    return None


def _format_hours(hours: float | None) -> str:
    if hours is None:
        return "-"
    return f"{hours:.2f} h".replace(".", ",")


# ── Bullet list helpers (sections 3, 4, 7) ──────────────────────────────────


def _bullets_from_text(text: Any) -> list[str]:
    """Split a free-text field into bullet points by newline. Empty lines are
    dropped; leading '-' / '*' / '•' / digits are stripped (operators have
    historically pre-bulleted these fields with various conventions)."""
    if not text:
        return []
    raw = str(text)
    items: list[str] = []
    for line in raw.splitlines():
        cleaned = line.strip()
        if not cleaned:
            continue
        cleaned = re.sub(r"^[-*•]\s*", "", cleaned)
        cleaned = re.sub(r"^\d+[.)]\s*", "", cleaned)
        if cleaned:
            items.append(cleaned)
    return items


def _bullets_for_open_tasks(payload: dict[str, Any]) -> list[str]:
    """Section 4 bullets: legacy 'office_rework' + 'office_next_steps' free-
    text fields, plus any 'extras' rows (description ± reason)."""
    items: list[str] = []
    items.extend(_bullets_from_text(payload.get("office_rework")))
    items.extend(_bullets_from_text(payload.get("office_next_steps")))
    for extra in payload.get("extras") or []:
        desc = str(extra.get("description") or "").strip()
        reason = str(extra.get("reason") or "").strip()
        if desc and reason:
            items.append(f"{desc} ({reason})")
        elif desc:
            items.append(desc)
    return items


def _bullet_list(items: list[str], styles) -> Any:
    """Wrap a list of strings as a Paragraph stream with '•' bullets. When
    empty, renders a single muted dash."""
    if not items:
        return Paragraph('<font color="#9CA3AF">—</font>', styles["Normal"])
    body_lines: list[str] = []
    for item in items:
        body_lines.append(f'• {escape(item)}')
    return Paragraph("<br/>".join(body_lines), styles["ReportBullet"])


# ── Material tables (sections 5 + 6) ─────────────────────────────────────────


def _consumed_materials(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Resolve consumed-materials list with legacy fallback. Pre-v2.5.13
    reports stored everything under 'materials'; new ones use
    'materials_consumed'. Either is rendered as section 5."""
    new = list(payload.get("materials_consumed") or [])
    if new:
        return new
    return list(payload.get("materials") or [])


def _consumed_materials_table(rows: list[dict[str, Any]], width: float, styles) -> Table:
    headers = ["Material", "Menge", "Einheit"]
    data: list[list[Any]] = [[_cell(h, bold=True) for h in headers]]
    for row in rows:
        data.append([
            _cell(str(row.get("item") or "-")),
            _cell(str(row.get("qty") or "-")),
            _cell(str(row.get("unit") or "-")),
        ])
    while len(data) < 5:
        data.append([_cell(""), _cell(""), _cell("")])
    col_widths = [width * x for x in (0.55, 0.20, 0.25)]
    table = Table(data, colWidths=col_widths)
    table.setStyle(_compact_table_style())
    return table


def _needed_materials_table(rows: list[dict[str, Any]], width: float, styles) -> Table:
    headers = ["Material", "Menge", "Einheit", "Bemerkung"]
    data: list[list[Any]] = [[_cell(h, bold=True) for h in headers]]
    for row in rows:
        data.append([
            _cell(str(row.get("item") or "-")),
            _cell(str(row.get("qty") or "-")),
            _cell(str(row.get("unit") or "-")),
            _cell(str(row.get("note") or "-")),
        ])
    while len(data) < 5:
        data.append([_cell(""), _cell(""), _cell(""), _cell("")])
    # v2.5.14: widen 'Menge' from 0.15 → 0.20 so the word "passend" (which
    # operators commonly write when the quantity depends on cable length)
    # stops wrapping to two lines. Compensates by trimming Material slightly.
    col_widths = [width * x for x in (0.35, 0.20, 0.18, 0.27)]
    table = Table(data, colWidths=col_widths)
    table.setStyle(_compact_table_style())
    return table


def _compact_table_style() -> TableStyle:
    return TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _COLOR_HEADER_BG),
        ("GRID", (0, 0), (-1, -1), 0.25, _COLOR_GRID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ])


# ── Section 8: STATUS row ───────────────────────────────────────────────────


def _status_box(
    styles,
    payload: dict[str, Any],
    *,
    width: float,
    has_material_overflow: bool,
) -> Table:
    status = dict(payload.get("status") or {})
    distance = dict(payload.get("distance") or {})

    options: list[tuple[bool, str]] = [
        (bool(status.get("arrival_completed")), "An- und Abfahrt erfolgt"),
        (bool(status.get("work_finished")), "Arbeiten abgeschlossen"),
        (bool(status.get("handed_over_clean")), "Anlage störungsfrei dem Kunden übergeben"),
        (bool(status.get("further_work_needed")), "Weitere Arbeiten notwendig"),
        (
            bool(status.get("extra_material_used")) or has_material_overflow,
            "Mehrverbrauch an Material lt. beiliegendem Materialschein",
        ),
    ]

    # Two-column grid of checkboxes plus a km row spanning both. The mockup
    # arranges these horizontally; we approximate with a 3-row × 2-col table.
    grid_rows: list[list[Any]] = []
    pairs = list(_pairs(options))
    for left, right in pairs:
        grid_rows.append([
            _checkbox_cell(left, styles),
            _checkbox_cell(right, styles) if right is not None else _cell(""),
        ])

    # Kilometer row
    km_value = distance.get("kilometers")
    km_source = str(distance.get("source") or "unset")
    km_text = (
        f"<b>Kilometer (gesamt):</b> {int(km_value)} km"
        if isinstance(km_value, (int, float)) and km_value
        else "<b>Kilometer (gesamt):</b> —"
    )
    if km_source == "auto":
        km_text += ' <font color="#6B7280" size=7>(automatisch berechnet)</font>'
    elif km_source == "manual":
        km_text += ' <font color="#6B7280" size=7>(manuell eingegeben)</font>'
    km_row = Paragraph(km_text, styles["Normal"])

    note = str(status.get("note") or "").strip()
    note_row = Paragraph(
        f"<b>Bemerkung (optional):</b> {escape(note) if note else '—'}",
        styles["Normal"],
    )

    inner = Table(
        grid_rows + [[km_row, ""], [note_row, ""]],
        colWidths=[width * 0.55, width * 0.45],
    )
    inner.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("SPAN", (0, -2), (-1, -2)),
        ("SPAN", (0, -1), (-1, -1)),
    ]))

    return _section_box(
        styles,
        number=8,
        title="STATUS",
        title_suffix=" (bitte ankreuzen)",
        body=inner,
        width=width,
    )


def _checkbox_cell(option: tuple[bool, str], styles) -> Table:
    """Render a status checkbox row: drawn box + label, side-by-side.

    Returns a Table flowable so the outer 2-column status grid can place
    it directly. The inner table is a 2-column layout: a fixed-width
    cell for the checkbox flowable, a flexible cell for the label
    Paragraph (so long labels like 'Mehrverbrauch an Material lt.
    beiliegendem Materialschein' still wrap correctly inside the
    available column width)."""
    checked, label = option
    box = _Checkbox(checked, size=8)
    label_para = Paragraph(escape(label), styles["Normal"])
    cell = Table(
        [[box, label_para]],
        # Fixed 12pt gutter for the checkbox + small spacing; label takes
        # the rest. The colWidth=None tells ReportLab to use whatever is
        # available in the parent column.
        colWidths=[12, None],
    )
    cell.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    return cell


def _pairs(items: list) -> Any:
    """Iterate items in pairs (left, right) so the status section can render
    a two-column grid. Last item paired with None when count is odd."""
    it = iter(items)
    for a in it:
        try:
            b = next(it)
        except StopIteration:
            b = None
        yield (a, b)


# ── Section 9: Unterschriften ───────────────────────────────────────────────


def _signatures_box(
    styles,
    payload: dict[str, Any],
    report_date: date,
    *,
    width: float,
    company_name: str | None,
) -> Table:
    smpl_block = _signature_block(
        styles,
        payload.get("signature_smpl") or {},
        report_date,
        heading=f"Für {company_name or 'SMPL Energy'}",
        column_width=(width - 12) / 2,
    )
    cust_block = _signature_block(
        styles,
        payload.get("signature_customer") or {},
        report_date,
        heading="Für den Kunden",
        column_width=(width - 12) / 2,
    )
    inner = Table(
        [[smpl_block, cust_block]],
        colWidths=[(width - 12) / 2, (width - 12) / 2],
    )
    inner.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return _section_box(
        styles,
        number=9,
        title="UNTERSCHRIFTEN",
        body=inner,
        width=width,
        footer="Arbeiten ordnungsgemäß ausgeführt, Zeit und Materialverbrauch sind durch den Kunden anerkannt.",
    )


def _signature_block(
    styles,
    signature: dict[str, Any],
    report_date: date,
    *,
    heading: str,
    column_width: float,
) -> Any:
    """One signature column: heading, signature image (or placeholder line),
    underscored Name + Datum row."""
    image_data = str(signature.get("image_base64") or "").strip()
    name = str(signature.get("name") or "").strip()
    signed_at = signature.get("signed_at")

    sig_image: Any
    if image_data:
        sig_image = _scaled_image_from_base64(image_data, max_width=column_width - 8, max_height=18 * mm)
        if sig_image is None:
            sig_image = Paragraph(
                f'<font color="{_COLOR_DANGER.hexval()}"><i>Signaturbild konnte nicht geladen werden</i></font>',
                styles["Normal"],
            )
    else:
        sig_image = Paragraph(
            f'<font color="{_COLOR_DANGER.hexval()}"><i>noch nicht unterschrieben</i></font>',
            styles["Normal"],
        )

    date_str = _signature_date_str(signed_at, report_date)

    block = Table(
        [
            [Paragraph(f"<b>{escape(heading)}</b>", styles["Normal"])],
            [sig_image],
            [Table(
                [
                    [Paragraph(f"Name: <b>{escape(name) if name else '—'}</b>", styles["Normal"]),
                     Paragraph(f"Datum: <b>{escape(date_str)}</b>", styles["Normal"])],
                ],
                colWidths=[column_width * 0.6, column_width * 0.4],
            )],
        ],
        colWidths=[column_width],
        rowHeights=[None, 20 * mm, None],
    )
    block.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LINEBELOW", (0, 1), (0, 1), 0.6, _COLOR_BOX_BORDER),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return block


def _signature_date_str(signed_at: Any, report_date: date) -> str:
    if isinstance(signed_at, str) and signed_at.strip():
        try:
            return datetime.fromisoformat(signed_at.replace("Z", "+00:00")).strftime("%d.%m.%Y")
        except ValueError:
            pass
    if isinstance(signed_at, datetime):
        return signed_at.strftime("%d.%m.%Y")
    return report_date.strftime("%d.%m.%Y")


# ── Materialschein helpers ──────────────────────────────────────────────────


def _material_sheet_meta_strip(
    styles,
    payload: dict[str, Any],
    report_date: date,
    *,
    project_name: str | None,
    width: float,
) -> Table:
    """Header strip on the Materialschein page: 'Projekt / Kunde' on the left,
    'Einsatzdatum' on the right."""
    project_label = (
        f"{payload.get('project_name') or project_name or '-'} / "
        f"{payload.get('customer') or '-'}"
    )
    table = Table(
        [[
            _cell("Projekt / Kunde:", bold=True),
            _cell(project_label),
            _cell("Einsatzdatum:", bold=True),
            _cell(report_date.strftime("%d.%m.%Y")),
        ]],
        colWidths=[width * 0.16, width * 0.50, width * 0.14, width * 0.20],
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), _COLOR_HEADER_BG),
        ("GRID", (0, 0), (-1, -1), 0.25, _COLOR_GRID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    return table


def _material_sheet_table(
    rows: list[dict[str, Any]],
    width: float,
    styles,
    *,
    kind: str,
) -> Table:
    """Materialschein table: 7 columns matching the mockup's second page.

    Source-field mapping (v2.5.14 — distinct ``usage`` vs ``note`` columns,
    no longer falling back from one to the other):

      ``item``       → "Material / Artikel"
      ``article_no`` → "Beschreibung / Größe"
      ``qty``        → "Menge"
      ``unit``       → "Einheit"
      ``usage``      → "Verwendet für / Einsatzort"  (or "Benötigt für" for bedarf)
      ``note``       → "Bemerkung"

    Each column reads from its own dedicated field; when the field is
    missing on a row, the cell renders "-" rather than borrowing from
    another column. That prevents the v2.5.13 bug where the renderer
    fell back from ``usage`` to ``note`` and duplicated the same value
    into two adjacent columns.
    """
    headers = [
        # v2.5.14: "Pos." stays (clearer than "Nr."), but "Einheit" becomes
        # "EH" to match the abbreviation used throughout the rest of the app
        # (line-item table, time-tracking table, etc.) and to avoid the
        # header wrapping to "Einhei\nt" in a 13mm-wide column.
        "Pos.", "Material / Artikel", "Beschreibung / Größe",
        "Menge", "EH",
        "Verwendet für / Einsatzort" if kind == "verbrauch" else "Benötigt für",
        "Bemerkung",
    ]
    data: list[list[Any]] = [[_cell(h, bold=True) for h in headers]]
    for idx, row in enumerate(rows, start=1):
        data.append([
            _cell(str(idx), bold=True),
            _cell(str(row.get("item") or "-")),
            _cell(str(row.get("article_no") or "-")),
            _cell(str(row.get("qty") or "-")),
            _cell(str(row.get("unit") or "-")),
            _cell(str(row.get("usage") or "-")),
            _cell(str(row.get("note") or "-")),
        ])
    # Pad to a minimum number of rows so the page looks structured even with
    # only a handful of entries.
    while len(data) < 8:
        data.append([_cell(""), _cell(""), _cell(""), _cell(""), _cell(""), _cell(""), _cell("")])
    # v2.5.14: rebalanced widths — Pos. 0.06 (was 0.05) so the period
    # doesn't wrap, Menge 0.09 so longer quantities like "passend" stay on
    # one line, EH stays narrow because the new "EH" header fits in 0.06.
    # Description columns reabsorb the remaining space.
    col_widths = [width * x for x in (0.06, 0.18, 0.21, 0.09, 0.06, 0.21, 0.19)]
    table = Table(data, colWidths=col_widths)
    table.setStyle(_compact_table_style())
    return table


def _material_sheet_signatures(
    styles,
    payload: dict[str, Any],
    report_date: date,
    *,
    width: float,
    kind: str,
) -> Table:
    left = _signature_block(
        styles,
        payload.get("signature_smpl") or {},
        report_date,
        heading="Entnommen / verwendet von (Monteur)" if kind == "verbrauch" else "Bestellt durch (Monteur)",
        column_width=(width - 12) / 2,
    )
    right = _signature_block(
        styles,
        payload.get("signature_customer") or {},
        report_date,
        heading="Gesehen / geprüft von (Bauleiter / Kunde)",
        column_width=(width - 12) / 2,
    )
    table = Table(
        [[left, right]],
        colWidths=[(width - 12) / 2, (width - 12) / 2],
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


# ── Low-level helpers (shared) ──────────────────────────────────────────────


_CELL_STYLE = ParagraphStyle(name="TableCell", fontName="Helvetica", fontSize=8.5, leading=10.5, textColor=_COLOR_TEXT)
_CELL_BOLD_STYLE = ParagraphStyle(name="TableCellBold", fontName="Helvetica-Bold", fontSize=8.5, leading=10.5, textColor=_COLOR_TEXT)


def _cell(text: str, *, bold: bool = False) -> Paragraph:
    value = (text or "").strip()
    if not value:
        value = ""
    style = _CELL_BOLD_STYLE if bold else _CELL_STYLE
    return Paragraph(escape(value).replace("\n", "<br/>"), style)


def _normalize_completed_subtasks(raw_subtasks: Any) -> list[str]:
    if not isinstance(raw_subtasks, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for row in raw_subtasks:
        label = str(row or "").strip()
        if not label:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        result.append(label)
    return result


def _scaled_image_from_path(path: str | None, max_width: float, max_height: float) -> Image | None:
    if not path:
        return None
    candidate = Path(path)
    if not candidate.exists():
        return None
    try:
        width, height = ImageReader(str(candidate)).getSize()
    except Exception:
        return None
    scale = min(max_width / width, max_height / height)
    return Image(str(candidate), width=width * scale, height=height * scale)


def _scaled_image_from_bytes(data: bytes, max_width: float, max_height: float) -> Image | None:
    if not data:
        return None
    bio = BytesIO(data)
    try:
        width, height = ImageReader(bio).getSize()
    except Exception:
        return None
    scale = min(max_width / width, max_height / height)
    bio.seek(0)
    image = Image(bio, width=width * scale, height=height * scale)
    image.hAlign = "LEFT"
    return image


def _scaled_image_from_base64(data: str, max_width: float, max_height: float) -> Image | None:
    """Decode a base64-encoded image (with or without ``data:`` prefix) and
    return a ReportLab Image, sized to fit within the given bounds."""
    if not data:
        return None
    cleaned = data.strip()
    if cleaned.startswith("data:"):
        try:
            cleaned = cleaned.split(",", 1)[1]
        except IndexError:
            return None
    try:
        raw = base64.b64decode(cleaned)
    except Exception:
        return None
    return _scaled_image_from_bytes(raw, max_width=max_width, max_height=max_height)


def _photos_table(photos: list[tuple[str, bytes]], width: float, styles) -> Table:
    max_width = (width - 12) / 2
    max_height = 60 * mm
    rows: list[list[Any]] = []
    row: list[Any] = []
    for filename, photo_bytes in photos:
        preview = _scaled_image_from_bytes(photo_bytes, max_width=max_width, max_height=max_height)
        if preview is None:
            row.append(Paragraph(f"{filename}: kein Vorschauformat", styles["Normal"]))
        else:
            row.append(preview)
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        row.append(Spacer(1, 1))
        rows.append(row)
    table = Table(rows, colWidths=[max_width, max_width], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table
