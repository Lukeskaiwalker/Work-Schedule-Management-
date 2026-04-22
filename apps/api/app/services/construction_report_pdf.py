from __future__ import annotations

import re
from datetime import date
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
from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def sanitize_filename(value: str) -> str:
    cleaned = value.strip()
    cleaned = cleaned.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned or "report"


def build_report_filename(payload: dict[str, Any], report_date: date, *, report_number: int | None = None) -> str:
    customer = sanitize_filename(str(payload.get("customer") or "construction-report"))
    project_number = payload.get("project_number")
    parts = [customer]
    if project_number:
        parts.append(sanitize_filename(str(project_number)))
    if report_number and report_number > 0:
        parts.append(f"report-{int(report_number):04d}")
    parts.append(report_date.isoformat())
    return "_".join(parts) + ".pdf"


def build_report_pdf_bytes(
    payload: dict[str, Any],
    report_date: date,
    submitted_by: str,
    project_name: str | None = None,
    logo_path: str | None = None,
    company_name: str | None = None,
    photos: list[tuple[str, bytes]] | None = None,
) -> bytes:
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
    )
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="SectionHeader",
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#333333"),
            spaceBefore=8,
            spaceAfter=4,
        )
    )
    styles.add(ParagraphStyle(name="NormalSmall", fontSize=9, leading=11))

    elements: list[Any] = []
    elements.extend(_build_header(styles, report_date, logo_path, doc.width, company_name=company_name))
    elements.append(Paragraph(f"Submitted by: {submitted_by}", styles["Normal"]))
    elements.append(Spacer(0, 4))

    elements.append(_section_title("Project", styles))
    elements.append(
        _key_value_table(
            [
                ("Kunde", str(payload.get("customer") or "-")),
                ("Projektname", str(payload.get("project_name") or project_name or "-")),
                ("Projektnummer", str(payload.get("project_number") or "-")),
            ],
            doc.width,
        )
    )

    elements.append(_section_title("Mitarbeiter", styles))
    elements.append(_workers_table(payload.get("workers") or [], doc.width))

    elements.append(_section_title("Ausgefuehrte Arbeiten", styles))
    elements.append(_paragraph(format_work_done_for_report(payload), styles))

    elements.append(_section_title("Material", styles))
    elements.append(_materials_table(payload.get("materials") or [], doc.width))

    elements.append(_section_title("Zusatzarbeiten", styles))
    elements.append(_extras_table(payload.get("extras") or [], doc.width))

    elements.append(_section_title("Vorkommnisse / Absprachen", styles))
    elements.append(_paragraph(str(payload.get("incidents") or "-"), styles))

    elements.append(_section_title("Buerohinweise", styles))
    elements.append(
        _key_value_table(
            [
                ("Materialbedarf", str(payload.get("office_material_need") or "-")),
                ("Nacharbeiten", str(payload.get("office_rework") or "-")),
                ("Naechste Schritte", str(payload.get("office_next_steps") or "-")),
            ],
            doc.width,
        )
    )

    if photos:
        elements.append(_section_title("Fotos", styles))
        elements.append(_photos_table(photos, doc.width, styles))

    doc.build(elements)
    return buffer.getvalue()


def build_report_summary_text(
    project_id: int | None,
    report_date: date,
    payload: dict[str, Any],
    submitted_by: str,
) -> str:
    workers = payload.get("workers") or []
    materials = payload.get("materials") or []
    extras = payload.get("extras") or []
    return (
        "Construction Report\n"
        f"Project ID: {project_id if project_id is not None else 'GENERAL'}\n"
        f"Date: {report_date.isoformat()}\n"
        f"Submitted by: {submitted_by}\n"
        f"Customer: {payload.get('customer') or '-'}\n"
        f"Project: {payload.get('project_name') or '-'}\n"
        f"Project Number: {payload.get('project_number') or '-'}\n"
        f"Workers: {len(workers)} | Materials: {len(materials)} | Extras: {len(extras)}"
    )


def format_work_done_for_report(payload: dict[str, Any]) -> str:
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
                resized = (
                    max(1, int(width * scale)),
                    max(1, int(height * scale)),
                )
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


def _section_title(title: str, styles) -> Paragraph:
    return Paragraph(title, styles["SectionHeader"])


def _build_header(styles, report_date: date, logo_path: str | None, width: float, *, company_name: str | None = None) -> list[Any]:
    company_label = (company_name or "").strip() or "SMPL"
    title = Paragraph("<b>Baustellenbericht</b>", styles["Title"])
    company = Paragraph(company_label, styles["Heading3"])
    subtitle = Paragraph(f"Datum: {report_date.isoformat()}", styles["Normal"])
    right = [company, title, subtitle]
    logo = _scaled_image_from_path(logo_path, max_width=40 * mm, max_height=20 * mm) if logo_path else None
    if logo:
        table = Table([[logo, right]], colWidths=[50 * mm, width - 50 * mm])
    else:
        table = Table([[right]], colWidths=[width])
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return [table, Spacer(0, 4)]


def _paragraph(text: str, styles) -> Paragraph:
    value = (text or "").strip()
    if not value:
        return Paragraph("-", styles["NormalSmall"])
    rendered = escape(value).replace("\n", "<br/>")
    return Paragraph(rendered, styles["NormalSmall"])


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


_CELL_STYLE = ParagraphStyle(name="TableCell", fontName="Helvetica", fontSize=9, leading=11)
_CELL_BOLD_STYLE = ParagraphStyle(name="TableCellBold", fontName="Helvetica-Bold", fontSize=9, leading=11)


def _cell(text: str, *, bold: bool = False) -> Paragraph:
    """Wrap a table cell value in a Paragraph so long text wraps within the column width."""
    value = (text or "").strip() or "-"
    style = _CELL_BOLD_STYLE if bold else _CELL_STYLE
    return Paragraph(escape(value).replace("\n", "<br/>"), style)


def _key_value_table(rows: list[tuple[str, str]], width: float) -> Table:
    data = [[_cell(k, bold=True), _cell(v or "-")] for k, v in rows]
    table = Table(data, colWidths=[width * 0.30, width * 0.70])
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F2F2F2")),
                ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#222222")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#DDDDDD")),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    return table


def _workers_table(workers: list[dict[str, Any]], width: float) -> Table:
    data = [[_cell(h, bold=True) for h in ["Name", "Start", "Ende"]]]
    for worker in workers:
        data.append(
            [
                _cell(str(worker.get("name") or "-")),
                _cell(str(worker.get("start_time") or "-")),
                _cell(str(worker.get("end_time") or "-")),
            ]
        )
    if len(data) == 1:
        data.append([_cell("-"), _cell(""), _cell("")])
    table = Table(data, colWidths=[width * 0.5, width * 0.25, width * 0.25])
    table.setStyle(_table_style())
    return table


def _materials_table(materials: list[dict[str, Any]], width: float) -> Table:
    data = [[_cell(h, bold=True) for h in ["Position", "Menge", "Einheit", "Artikel"]]]
    for material in materials:
        data.append(
            [
                _cell(str(material.get("item") or "-")),
                _cell(str(material.get("qty") or "-")),
                _cell(str(material.get("unit") or "-")),
                _cell(str(material.get("article_no") or "-")),
            ]
        )
    if len(data) == 1:
        data.append([_cell("-"), _cell(""), _cell(""), _cell("")])
    table = Table(data, colWidths=[width * 0.45, width * 0.15, width * 0.15, width * 0.25])
    table.setStyle(_table_style())
    return table


def _extras_table(extras: list[dict[str, Any]], width: float) -> Table:
    data = [[_cell(h, bold=True) for h in ["Beschreibung", "Grund"]]]
    for extra in extras:
        data.append([_cell(str(extra.get("description") or "-")), _cell(str(extra.get("reason") or "-"))])
    if len(data) == 1:
        data.append([_cell("-"), _cell("")])
    table = Table(data, colWidths=[width * 0.6, width * 0.4])
    table.setStyle(_table_style())
    return table


def _table_style() -> TableStyle:
    return TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E6E6E6")),
            ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#DDDDDD")),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ]
    )


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


def _photos_table(photos: list[tuple[str, bytes]], width: float, styles) -> Table:
    max_width = (width - 12) / 2
    max_height = 60 * mm
    rows: list[list[Any]] = []
    row: list[Any] = []
    for filename, photo_bytes in photos:
        preview = _scaled_image_from_bytes(photo_bytes, max_width=max_width, max_height=max_height)
        if preview is None:
            row.append(Paragraph(f"{filename}: kein Vorschauformat", styles["NormalSmall"]))
        else:
            row.append(preview)
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        row.append(Spacer(1, 1))
        rows.append(row)
    table = Table(rows, colWidths=[max_width, max_width], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return table
