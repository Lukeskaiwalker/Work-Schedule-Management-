"""Render a Verteilerplan as a company-styled technical drawing PDF.

The sheets of one document, in order (docs/SCHALTPLAN_STROMLAUF.md §2):

  * **Übersichtsschaltplan** (A4 landscape, ``schaltplan_pdf_overview``): the
    single-line diagram, supply → busbar segments → groups → circuits.
  * **Stromlaufplan allpolig** (A4 landscape, ``schaltplan_stromlauf_*``):
    every conductor in its colour, junction dots, hops at crossings.
  * **Legende** (A4 portrait): the Stromkreisliste glued inside the door.
  * **Reihenklemmen** (A4 portrait): only when the board has terminals.

Every drawing sheet carries the same full-width title strip (customer,
project, board, revision, date) and "Blatt i/n" counts all drawing sheets,
so the whole drawing is laid out before anything is drawn. Written directly
on a ``canvas.Canvas`` rather than through platypus: a schematic is
absolute-positioned geometry, and flowables would fight every line drawn.
This module is the entry point and the legend; it must not grow.
"""

from __future__ import annotations

from datetime import datetime
from io import BytesIO
from typing import Any, Mapping, Sequence

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdfcanvas

from app.models.schaltplan import PanelPlan
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_readable import readable_blocks
from app.services.schaltplan_layout import build_legend
from app.services.schaltplan_pdf_overview import (
    OVERVIEW_TITLE,
    draw_overview_content,
    feeder_chains,
    overview_groups,
    paginate_overview,
)

# Palette, fonts and the text primitives are shared with the Reihenklemmen
# sheet through schaltplan_pdf_style.py; the house names below keep the
# drawing code reading as it always has.
from app.services.schaltplan_pdf_style import (
    BLUE_DEEP as _BLUE_DEEP,
    BLUE_TINT as _BLUE_TINT,
    FONT as _FONT,
    FONT_BOLD as _FONT_BOLD,
    GRID as _GRID,
    INK as _INK,
    LINE as _LINE,
    MUTED as _MUTED,
    draw_drawing_furniture,
    header_bar as _header_bar,
    text_of as _text,
    title_strip_for,
    wrap as _wrap,
)
from app.services.schaltplan_pdf_terminals import draw_terminal_sheets
from app.services.schaltplan_stromlauf_layout import Frame, layout_stromlauf
from app.services.schaltplan_stromlauf_model import build_stromlauf_model
from app.services.schaltplan_stromlauf_pdf import draw_stromlauf_sheets
from app.services.schaltplan_terminals import derive_terminals, device_terminal_labels


def _draw_drawing_sheets(c: pdfcanvas.Canvas, *, plan: PanelPlan, document: Mapping[str, Any],
                         catalog: EnclosureCatalog | None, terminal_labels: Mapping[str, list[str]],
                         customer_name: str | None, project_label: str | None, fed_from: str | None,
                         author: str | None, company: str) -> None:
    """Übersicht then Stromlauf: both laid out first, so "Blatt i/n" counts every sheet."""
    groups = overview_groups(document, catalog)
    chains = feeder_chains(groups)
    overview = paginate_overview(groups)
    model = build_stromlauf_model(document, catalog, terminal_labels=terminal_labels)
    stromlauf = layout_stromlauf(model, Frame(first_sheet=len(overview) + 1))
    total = len(overview) + len(stromlauf)
    strip = title_strip_for(plan, customer_name=customer_name, project_label=project_label, fed_from=fed_from,
                            company=company, title=OVERVIEW_TITLE)
    for number, sheet in enumerate(overview, start=1):
        draw_drawing_furniture(c, title=OVERVIEW_TITLE, company=company, sheet=number, sheets=total, strip=strip)
        draw_overview_content(c, sheet, supply=document.get("supply") or {}, fed_from=fed_from, chains=chains)
        c.showPage()
    draw_stromlauf_sheets(c, stromlauf, plan=plan, customer_name=customer_name, project_label=project_label,
                          fed_from=fed_from, author=author, company=company, first_sheet=len(overview) + 1,
                          total=total)


# ── Legend sheet ────────────────────────────────────────────────────────────

_LEGEND_COLUMNS: list[tuple[str, str, float]] = [
    ("circuit", "Nr.", 26),
    ("designation", "BMK", 34),
    # 98 so the header itself fits: at 84 "Verbraucher / Bezeichnung" ran
    # into "Raum" (owner's print of 2026-10-09). The 14 came from the four
    # columns whose content is shortest (room, device, rating, FI), so the
    # total — the sheet glued into the door — is unchanged.
    ("label", "Verbraucher / Bezeichnung", 98),
    ("room", "Raum", 56),
    ("device", "Gerät", 49),
    ("rating", "Absicherung", 49),
    ("rcd", "FI / RCD", 56),
    # Same total width as before: the Klemmen column took 20 from the
    # description and 30 from the cable column, so the sheet that gets glued
    # in the door keeps its layout.
    ("pre_fuse", "Vorsich.", 40),
    ("cable", "Leitung", 50),
    ("phase", "Ph.", 26),
    ("terminals", "Klemmen", 50),
]

_LEGEND_HEADER_SIZE = 7.0
_LEGEND_HEADER_MIN_SIZE = 6.5


def _legend_header_size(title: str, width: float) -> float:
    """The header's font size: 7 pt, or as much smaller as the title needs to
    stay inside its column (never below 6.5 pt). A title wider than that is
    a column set to fix, which the layout test catches."""
    size = _LEGEND_HEADER_SIZE
    while size > _LEGEND_HEADER_MIN_SIZE and stringWidth(title, _FONT_BOLD, size) > width - 6:
        size = round(size - 0.25, 2)
    return size


def _legend_header(c: pdfcanvas.Canvas, y: float, x0: float) -> None:
    c.setFillColor(_BLUE_TINT)
    c.setStrokeColor(_LINE)
    c.setLineWidth(0.5)
    total = sum(col[2] for col in _LEGEND_COLUMNS)
    c.rect(x0, y - 4, total, 16, stroke=1, fill=1)
    c.setFillColor(_BLUE_DEEP)
    x = x0
    for _key, title, w in _LEGEND_COLUMNS:
        c.setFont(_FONT_BOLD, _legend_header_size(title, w))
        c.drawString(x + 3, y + 2, title)
        x += w


def _draw_legend_sheets(
    c: pdfcanvas.Canvas,
    *,
    plan: PanelPlan,
    rows: Sequence[dict[str, str]],
    customer_name: str | None,
    project_label: str | None,
    company: str,
) -> None:
    width, height = A4
    total = sum(col[2] for col in _LEGEND_COLUMNS)
    x0 = (width - total) / 2

    def start_page(page_no: int) -> float:
        c.setPageSize((width, height))
        _header_bar(c, width, height, "Stromkreisliste / Legende", company)
        c.setFillColor(_INK)
        c.setFont(_FONT_BOLD, 11)
        c.drawString(x0, height - 58, f"{plan.designation} — {plan.name}")
        c.setFont(_FONT, 8)
        c.setFillColor(_MUTED)
        meta = " · ".join(
            part
            for part in (
                _text(customer_name),
                _text(project_label),
                _text(plan.location),
                f"Rev. {plan.revision}",
                datetime.now().strftime("%d.%m.%Y"),
            )
            if part
        )
        c.drawString(x0, height - 70, _wrap(meta, _FONT, 8, total, 1)[0] if meta else "")
        if page_no > 1:
            c.drawRightString(x0 + total, height - 70, f"Seite {page_no}")
        header_y = height - 92
        _legend_header(c, header_y, x0)
        return header_y - 16

    page_no = 1
    y = start_page(page_no)

    if not rows:
        c.setFont(_FONT, 9)
        c.setFillColor(_MUTED)
        c.drawString(x0 + 3, y - 4, "Noch keine Stromkreise erfasst.")
        c.showPage()
        return

    for index, row in enumerate(rows):
        # Row height grows with the tallest wrapped cell so nothing is clipped.
        cell_lines: list[list[str]] = []
        for key, _title, w in _LEGEND_COLUMNS:
            value = _text(row.get(key))
            if key == "device" and _text(row.get("poles")):
                # "LS · 3P": the pole count is the one thing two breakers of
                # the same rating differ in, so the legend says it too.
                value = f"{value} · {_text(row.get('poles'))}P".strip(" ·")
            cell_lines.append(_wrap(value, _FONT, 7.5, w - 6, 3))
        row_h = max(13.0, 4 + 9.0 * max((len(lines) for lines in cell_lines), default=1))

        if y - row_h < 56:
            c.showPage()
            page_no += 1
            y = start_page(page_no)

        if index % 2 == 1:
            c.setFillColor(colors.HexColor("#f6f9fd"))
            c.rect(x0, y - row_h + 9, total, row_h, stroke=0, fill=1)

        c.setStrokeColor(_GRID)
        c.setLineWidth(0.4)
        c.line(x0, y - row_h + 9, x0 + total, y - row_h + 9)

        x = x0
        for (key, _title, w), lines in zip(_LEGEND_COLUMNS, cell_lines):
            c.setFillColor(_INK if key in {"circuit", "label"} else _MUTED)
            c.setFont(_FONT_BOLD if key == "circuit" else _FONT, 7.5)
            text_y = y
            for line in lines or ["—"]:
                c.drawString(x + 3, text_y, line)
                text_y -= 9.0
            x += w
        y -= row_h

    # Column separators are drawn once per page bottom-up would need tracking;
    # the horizontal rules plus alternating fills already carry the grid, and
    # a light vertical set here would land on the last page only. Left out on
    # purpose rather than drawn wrong.
    c.setFillColor(_MUTED)
    c.setFont(_FONT, 7)
    c.drawString(x0, 44, f"{len(rows)} Stromkreise · erstellt mit der SMPL Workflow-App")
    c.showPage()


# ── Entry point ─────────────────────────────────────────────────────────────


def build_panel_plan_pdf(
    *,
    plan: PanelPlan,
    customer_name: str | None = None,
    project_label: str | None = None,
    fed_from: str | None = None,
    author: str | None = None,
    company_name: str | None = None,
    legend_only: bool = False,
    terminals_only: bool = False,
    terminal_skip: frozenset[str] = frozenset(), rail_parts: Mapping[str, int] | None = None,
    catalog: EnclosureCatalog | None = None,
) -> bytes:
    """Render the plan. Returns PDF bytes; never writes to disk.

    The full document is diagram sheets, the legend, and — only when the
    board has at least one Reihenklemme — the terminal sheet. ``legend_only``
    and ``terminals_only`` each print just their sheet; ``terminals_only``
    wins when both are set, because the Klemmen tab is the only caller that
    sets it and it wants exactly that page. ``terminal_skip``/``rail_parts``:
    a cabinet board's skip set and end plates (docs/PANEL_ENCLOSURE_R2.md §5.1).
    ``catalog``: the enclosure catalogue on a readable cabinet board, else None.
    """

    document = plan.document or {}
    company = (company_name or "SMPL").strip() or "SMPL"
    terminal_groups = derive_terminals(document, skip=terminal_skip)

    buffer = BytesIO()
    c = pdfcanvas.Canvas(buffer, pagesize=landscape(A4))
    c.setTitle(f"Schaltplan {plan.designation} — {plan.name}")
    c.setAuthor(company)

    def terminal_sheet() -> None:
        draw_terminal_sheets(
            c, plan=plan, document=document, groups=terminal_groups, rail_parts=rail_parts,
            customer_name=customer_name,
            project_label=project_label,
            company=company,
        )

    if terminals_only:
        terminal_sheet()
        c.save()
        return buffer.getvalue()

    if not legend_only:
        _draw_drawing_sheets(
            c, plan=plan, document=readable_blocks(document) if catalog is not None else document,
            catalog=catalog, terminal_labels=device_terminal_labels(terminal_groups),
            customer_name=customer_name, project_label=project_label, fed_from=fed_from, author=author,
            company=company,
        )

    _draw_legend_sheets(
        c,
        plan=plan,
        rows=build_legend(document, terminal_skip=terminal_skip),
        customer_name=customer_name,
        project_label=project_label,
        company=company,
    )

    # Never behind the door sheet: legend_only is the one-sided Stromkreisliste
    # glued inside the panel door, and a terminal list behind it would be
    # printed and thrown away.
    if terminal_groups and not legend_only:
        terminal_sheet()

    c.save()
    return buffer.getvalue()
