"""Render an Ausbildungsnachweis as a PDF in the IHK form layout.

The IHK weekly form ("Ausbildungsnachweis, wöchentlich") is a fixed shape and
the exam admission depends on these sheets, so the layout mirrors it rather
than inventing one:

    Ausbildungsnachweis Nr. …      Name: …    Ausbildungsjahr: …
    Ausbildungswoche vom … bis …
    ┌───────┬───────────────────────────────────────────────┬───────┐
    │ Tag   │ Ausgeführte Arbeiten, Unterweisungen,          │ Std.  │
    │       │ betrieblicher Unterricht, Berufsschule          │       │
    ├───────┼───────────────────────────────────────────────┼───────┤
    │ Mo …  │ …                                             │ …     │
    └───────┴───────────────────────────────────────────────┴───────┘
                                            Gesamtstunden: …
    Bemerkungen: …
    Datum, Unterschrift Auszubildende/r   Datum, Unterschrift Ausbilder/in

Built synchronously in memory (the timesheet-export pattern), not through the
report-job pipeline — nothing here needs Telegram or project-file persistence.
Signature images reuse the construction report's base64 embedding helper so
both features accept exactly the same pad output.

One row per *entry*, not per day
--------------------------------
The obvious layout — one table row per weekday, activities joined with <br/> —
cannot be printed. ReportLab splits a table between rows but never inside one,
so a single day carrying more text than fits on a page raises ``LayoutError``
and the whole request 500s. The schema allows 20 entries x 500 chars per day,
so that was reachable with a diligent week's writing. Giving every entry its
own row keeps each row small enough to place, lets the table flow across pages
on its own, and as a bonus puts the per-entry hours in the Std. column the way
the HWK Vordruck asks for (Einzelstunden beside Gesamtstunden).
"""

from __future__ import annotations

from datetime import date, timedelta
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.models.training import TrainingWeekReport
from app.services.construction_report_pdf import _scaled_image_from_base64

_INK = colors.HexColor("#14293d")
_LINE = colors.HexColor("#9fb2c4")

_DAY_LABELS = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]

_CATEGORY_LABELS = {
    "betrieb": "",  # the normal case carries no prefix, like on the paper form
    "unterweisung": "Unterweisung: ",
    "schule": "Berufsschule: ",
}

# Printed on the Heft index. German because the sheet is a German document.
_STATUS_LABELS = {
    "draft": "Entwurf",
    "submitted": "Eingereicht",
    "signed": "Gegengezeichnet",
}


def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle("base", fontName="Helvetica", fontSize=9, leading=12, textColor=_INK)
    return {
        "base": base,
        "title": ParagraphStyle("title", parent=base, fontName="Helvetica-Bold", fontSize=14, leading=17),
        "cover_title": ParagraphStyle(
            "cover_title", parent=base, fontName="Helvetica-Bold", fontSize=24, leading=28
        ),
        "meta": ParagraphStyle("meta", parent=base, fontSize=9.5),
        "head": ParagraphStyle("head", parent=base, fontName="Helvetica-Bold", fontSize=9),
        "day": ParagraphStyle("day", parent=base, fontName="Helvetica-Bold"),
        "muted": ParagraphStyle("muted", parent=base, textColor=colors.HexColor("#5c7895")),
        "sig": ParagraphStyle("sig", parent=base, fontSize=8, textColor=colors.HexColor("#5c7895")),
    }


def _fmt(d: date) -> str:
    return d.strftime("%d.%m.%Y")


def _hours(value: float) -> str:
    # "8" not "8.0", "7,5" not "7.5" — the sheet is a German document.
    text = f"{value:g}"
    return text.replace(".", ",")


def _signature_cell(styles: dict, *, label: str, image_b64: str | None, signed_on: str | None):
    """One of the two signature boxes. Always rendered — an unsigned report
    prints with an empty line to sign on paper, which is a legitimate way to
    use the sheet."""

    parts: list = []
    if image_b64:
        image = _scaled_image_from_base64(image_b64, max_width=70 * mm, max_height=16 * mm)
        if image is not None:
            parts.append(image)
    if not parts:
        parts.append(Spacer(1, 16 * mm))
    caption = label if not signed_on else f"{label} — {signed_on}"
    parts.append(Paragraph(caption, styles["sig"]))
    return parts


def _entry_lines(entries: object) -> list[tuple[str, float]]:
    """Normalize one day's stored entries into ``(display_text, hours)`` pairs.

    Skips anything without text — the same rule the editor applies — so a
    half-filled row never reaches the printed sheet.
    """

    result: list[tuple[str, float]] = []
    for entry in entries if isinstance(entries, list) else []:
        if not isinstance(entry, dict):
            continue
        text = str(entry.get("text") or "").strip()
        if not text:
            continue
        prefix = _CATEGORY_LABELS.get(str(entry.get("category") or "betrieb"), "")
        try:
            hours = float(entry.get("hours") or 0)
        except (TypeError, ValueError):
            hours = 0.0
        # User text goes through Paragraph, which interprets mini-HTML —
        # "Kabel <3mm" would otherwise be swallowed as a bogus tag (or worse,
        # inject markup into a legal document). Escape everything user-typed.
        result.append((f"{prefix}{escape(text)}", hours))
    return result


def _report_flowables(
    report: TrainingWeekReport,
    *,
    apprentice_name: str,
    ausbilder_name: str | None,
    styles: dict[str, ParagraphStyle],
) -> list:
    """The flowables for one weekly sheet, without the document wrapper.

    Shared by the single-sheet PDF and the Heft, so a sheet looks identical
    whether it is downloaded on its own or bound into the collection.
    """

    monday = report.week_start
    saturday = monday + timedelta(days=5)

    elements: list = []

    # ── Header block ────────────────────────────────────────────────────
    elements.append(
        Table(
            [
                [
                    Paragraph(f"Ausbildungsnachweis Nr. {report.report_number}", styles["title"]),
                    Paragraph(
                        f"<b>Name:</b> {escape(apprentice_name)}<br/>"
                        f"<b>Ausbildungsjahr:</b> {report.ausbildungsjahr}",
                        styles["meta"],
                    ),
                ],
                [
                    Paragraph(
                        f"Ausbildungswoche vom {_fmt(monday)} bis {_fmt(saturday)}",
                        styles["meta"],
                    ),
                    Paragraph("", styles["meta"]),
                ],
            ],
            colWidths=[110 * mm, 72 * mm],
            style=TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("BOTTOMPADDING", (0, 0), (-1, 0), 4),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ]
            ),
        )
    )
    elements.append(Spacer(1, 4 * mm))

    # ── Day table ───────────────────────────────────────────────────────
    day_rows: dict = {}
    for entry_day in report.days if isinstance(report.days, list) else []:
        if isinstance(entry_day, dict) and entry_day.get("day"):
            day_rows[str(entry_day["day"])] = entry_day.get("entries") or []

    rows: list = [
        [
            Paragraph("Tag", styles["head"]),
            Paragraph(
                "Ausgeführte Arbeiten, Unterweisungen, betrieblicher Unterricht, Berufsschule",
                styles["head"],
            ),
            Paragraph("Std.", styles["head"]),
        ]
    ]
    # Row index of the last row of each weekday, so the rule under a day is
    # drawn there rather than between two entries of the same day.
    day_end_rows: list[int] = []
    total = 0.0
    for offset in range(6):  # Mo..Sa — the IHK sheet's working week
        day = monday + timedelta(days=offset)
        lines = _entry_lines(day_rows.get(day.isoformat(), []))
        day_hours = sum(hours for _, hours in lines)
        total += day_hours
        label = f"{_DAY_LABELS[day.weekday()]}<br/>{day.strftime('%d.%m.')}"
        if day_hours:
            label += f"<br/><font size='7.5' color='#5c7895'>{_hours(day_hours)} Std.</font>"
        day_cell = Paragraph(label, styles["day"])

        if not lines:
            rows.append([day_cell, Paragraph("—", styles["base"]), Paragraph("", styles["base"])])
        else:
            for index, (text, hours) in enumerate(lines):
                rows.append(
                    [
                        # The day cell rides on the first entry row only; a real
                        # SPAN would pin the block to one page again.
                        day_cell if index == 0 else Paragraph("", styles["base"]),
                        Paragraph(text, styles["base"]),
                        Paragraph(_hours(hours) if hours else "", styles["base"]),
                    ]
                )
        day_end_rows.append(len(rows) - 1)

    rows.append(
        [
            Paragraph("", styles["base"]),
            Paragraph("<b>Gesamtstunden</b>", styles["head"]),
            Paragraph(f"<b>{_hours(total)}</b>", styles["head"]),
        ]
    )

    table_style: list = [
        ("BOX", (0, 0), (-1, -1), 0.6, _LINE),
        ("LINEAFTER", (0, 0), (0, -1), 0.6, _LINE),
        ("LINEAFTER", (1, 0), (1, -1), 0.6, _LINE),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, _LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef4fa")),
        ("ALIGN", (2, 0), (2, -1), "RIGHT"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]
    # One rule per weekday boundary — the entry rows inside a day stay open so
    # a day still reads as a single block of the form.
    for row_index in day_end_rows:
        table_style.append(("LINEBELOW", (0, row_index), (-1, row_index), 0.6, _LINE))

    elements.append(
        Table(
            rows,
            colWidths=[26 * mm, 138 * mm, 18 * mm],
            style=TableStyle(table_style),
            # Continuation pages repeat the column headings, so a sheet that
            # runs long stays readable as a form.
            repeatRows=1,
        )
    )

    # ── Remarks ─────────────────────────────────────────────────────────
    if report.remarks:
        elements.append(Spacer(1, 4 * mm))
        elements.append(Paragraph(f"<b>Bemerkungen:</b> {escape(report.remarks)}", styles["base"]))

    # ── Signatures ──────────────────────────────────────────────────────
    elements.append(Spacer(1, 10 * mm))
    azubi_date = _fmt(report.azubi_signed_at.date()) if report.azubi_signed_at else None
    ausbilder_date = _fmt(report.ausbilder_signed_at.date()) if report.ausbilder_signed_at else None
    ausbilder_caption = "Datum, Unterschrift Ausbilder/in"
    if ausbilder_name:
        ausbilder_caption = f"Datum, Unterschrift Ausbilder/in ({escape(ausbilder_name)})"
    elements.append(
        Table(
            [
                [
                    _signature_cell(
                        styles,
                        label="Datum, Unterschrift Auszubildende/r",
                        image_b64=report.azubi_signature,
                        signed_on=azubi_date,
                    ),
                    _signature_cell(
                        styles,
                        label=ausbilder_caption,
                        image_b64=report.ausbilder_signature,
                        signed_on=ausbilder_date,
                    ),
                ]
            ],
            colWidths=[91 * mm, 91 * mm],
            style=TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
                    ("LINEABOVE", (0, 0), (0, 0), 0.6, _INK),
                    ("LINEABOVE", (1, 0), (1, 0), 0.6, _INK),
                    ("LEFTPADDING", (0, 0), (-1, -1), 2),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                ]
            ),
        )
    )

    return elements


def _document(buffer: BytesIO, *, title: str) -> SimpleDocTemplate:
    return SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=title,
    )


def build_training_report_pdf(
    report: TrainingWeekReport,
    *,
    apprentice_name: str,
    ausbilder_name: str | None,
) -> bytes:
    """One weekly sheet as a standalone PDF."""

    styles = _styles()
    buffer = BytesIO()
    _document(buffer, title=f"Ausbildungsnachweis Nr. {report.report_number}").build(
        _report_flowables(
            report,
            apprentice_name=apprentice_name,
            ausbilder_name=ausbilder_name,
            styles=styles,
        )
    )
    return buffer.getvalue()


def _cover_flowables(
    reports: list[TrainingWeekReport],
    *,
    apprentice_name: str,
    training_started_on: date | None,
    company_name: str | None,
    missing_weeks: list[date],
    ausbilder_names: dict[int, str],
    styles: dict[str, ParagraphStyle],
) -> list:
    """The Deckblatt: who the Heft belongs to, what it covers, and an index.

    The Kammer inspects the collection, not individual sheets, so the cover
    carries the two things a reviewer checks first — the period covered and
    whether anything is missing from it.
    """

    elements: list = [Spacer(1, 8 * mm)]
    if company_name:
        elements.append(Paragraph(escape(company_name), styles["meta"]))
        elements.append(Spacer(1, 2 * mm))
    elements.append(Paragraph("Ausbildungsnachweise", styles["cover_title"]))
    elements.append(Spacer(1, 6 * mm))

    facts: list[tuple[str, str]] = [("Auszubildende/r", apprentice_name)]
    if training_started_on:
        facts.append(("Ausbildungsbeginn", _fmt(training_started_on)))
    if reports:
        first, last = reports[0], reports[-1]
        facts.append(
            ("Berichtszeitraum", f"{_fmt(first.week_start)} – {_fmt(last.week_start + timedelta(days=5))}")
        )
    facts.append(("Anzahl Nachweise", str(len(reports))))
    signed = sum(1 for report in reports if report.status == "signed")
    facts.append(("Davon gegengezeichnet", str(signed)))
    if missing_weeks:
        facts.append(
            (
                "Fehlende Wochen",
                f"{len(missing_weeks)} — " + ", ".join(_fmt(week) for week in missing_weeks[:12])
                + ("…" if len(missing_weeks) > 12 else ""),
            )
        )

    elements.append(
        Table(
            [[Paragraph(f"<b>{label}</b>", styles["base"]), Paragraph(escape(value), styles["base"])] for label, value in facts],
            colWidths=[45 * mm, 137 * mm],
            style=TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            ),
        )
    )

    if reports:
        elements.append(Spacer(1, 8 * mm))
        elements.append(Paragraph("<b>Inhalt</b>", styles["head"]))
        elements.append(Spacer(1, 2 * mm))
        index_rows: list = [
            [
                Paragraph("Nr.", styles["head"]),
                Paragraph("Woche", styles["head"]),
                Paragraph("Jahr", styles["head"]),
                Paragraph("Std.", styles["head"]),
                Paragraph("Status", styles["head"]),
                Paragraph("Gegengezeichnet von", styles["head"]),
            ]
        ]
        for report in reports:
            hours = sum(
                hours
                for day in (report.days if isinstance(report.days, list) else [])
                for _, hours in _entry_lines((day or {}).get("entries") if isinstance(day, dict) else [])
            )
            index_rows.append(
                [
                    Paragraph(str(report.report_number), styles["base"]),
                    Paragraph(
                        f"{_fmt(report.week_start)} – {_fmt(report.week_start + timedelta(days=5))}",
                        styles["base"],
                    ),
                    Paragraph(str(report.ausbildungsjahr), styles["base"]),
                    Paragraph(_hours(hours), styles["base"]),
                    Paragraph(_STATUS_LABELS.get(report.status, report.status), styles["base"]),
                    Paragraph(
                        escape(ausbilder_names.get(report.id, "") or ""),
                        styles["base"],
                    ),
                ]
            )
        elements.append(
            Table(
                index_rows,
                colWidths=[12 * mm, 46 * mm, 12 * mm, 16 * mm, 34 * mm, 62 * mm],
                style=TableStyle(
                    [
                        ("BOX", (0, 0), (-1, -1), 0.6, _LINE),
                        ("LINEBELOW", (0, 0), (-1, 0), 0.6, _LINE),
                        ("INNERGRID", (0, 0), (-1, -1), 0.25, _LINE),
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eef4fa")),
                        ("VALIGN", (0, 0), (-1, -1), "TOP"),
                        ("TOPPADDING", (0, 0), (-1, -1), 3),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                    ]
                ),
                repeatRows=1,
            )
        )

    return elements


def build_training_heft_pdf(
    reports: list[TrainingWeekReport],
    *,
    apprentice_name: str,
    training_started_on: date | None = None,
    company_name: str | None = None,
    missing_weeks: list[date] | None = None,
    ausbilder_names: dict[int, str] | None = None,
) -> bytes:
    """The whole Ausbildungsheft: a Deckblatt with an index, then every sheet.

    ``reports`` must already be ordered oldest-first — the Heft is a bound
    collection and the Kammer expects it in order.
    """

    styles = _styles()
    elements = _cover_flowables(
        reports,
        apprentice_name=apprentice_name,
        training_started_on=training_started_on,
        company_name=company_name,
        missing_weeks=missing_weeks or [],
        ausbilder_names=ausbilder_names or {},
        styles=styles,
    )
    for report in reports:
        elements.append(PageBreak())
        elements.extend(
            _report_flowables(
                report,
                apprentice_name=apprentice_name,
                ausbilder_name=(ausbilder_names or {}).get(report.id),
                styles=styles,
            )
        )

    buffer = BytesIO()
    _document(buffer, title=f"Ausbildungsnachweise — {apprentice_name}").build(elements)
    return buffer.getvalue()
