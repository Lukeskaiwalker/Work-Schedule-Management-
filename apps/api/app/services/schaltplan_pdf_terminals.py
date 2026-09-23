"""The Reihenklemmen sheet of the Verteilerplan PDF (A4 portrait).

Per strip a heading ("X1 · FI F1 · Reihe 1 · Standard · 30 mA / Typ A" for
a Leiste, "X2 · Block F1.4 Wallbox · Wallbox" for a Block) and the terminal
sequence as Pos. | Klemme | Beschriftung | für, then the board's Stückliste
(Artikel | Bezeichnung | Anzahl | Breite). This is the sheet the workshop
builds the terminal row from and orders the parts off, so it lists the
exact WAGO article numbers the derivation resolved
(``services/schaltplan_terminals.py``) — the same sequence the marking
strip prints — and flags a part whose width could not be confirmed.

The Beschriftung column is what the marker says — the X numbering with the
document's overrides applied, "—" where the marker says nothing — never a
fallback the print would not produce. Same columns as the Klemmen tab
(``components/schaltplan/TerminalGroupCard.tsx``) — keep the twins alike.

Drawn directly on the canvas like the other sheets; palette and text
primitives come from ``schaltplan_pdf_style.py`` so the page looks like
the legend it follows.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas as pdfcanvas

from app.models.schaltplan import PanelPlan
from app.services.schaltplan_layout import iter_devices
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
from app.services.schaltplan_terminal_rules import (
    END_PART_IDS,
    FEED_PART_IDS,
    VARIANT_NO_RCD,
    VARIANT_STANDARD,
)
from app.services.schaltplan_terminals import (
    STRIP_KIND_BLOCK,
    terminal_bom,
    terminal_counts,
    unverified_terminal_parts,
)

VARIANT_LABELS: dict[str, str] = {
    VARIANT_STANDARD: "Standard",
    VARIANT_NO_RCD: "ohne FI",
}

# (key, title, width in points); both tables are 508 pt wide. The text
# column is what the marker says — the X numbering, overrides applied.
_COLUMNS: list[tuple[str, str, float]] = [
    ("position", "Pos.", 30),
    ("part", "Klemme", 150),
    ("label", "Beschriftung", 90),
    ("for", "für", 238),
]
_TEXT_KEYS = frozenset({"label"})
_BOM_COLUMNS: list[tuple[str, str, float]] = [
    ("part_no", "Artikel", 100),
    ("name", "Bezeichnung", 308),
    ("count", "Anzahl", 50),
    ("width", "Breite", 50),
]

_ROW_H = 13.0
_FOOT_Y = 56.0
_FONT_SIZE = 7.5


def _rcd_detail(head: dict[str, Any] | None) -> str:
    """"30 mA / Typ A" for an FI head, "" for anything else."""
    if head is None or str(head.get("kind") or "") != "rcd":
        return ""
    parts = [p for p in (text_of(head.get("residual_current")), text_of(head.get("rcd_type"))) if p]
    if len(parts) == 2:
        return f"{parts[0]} / Typ {parts[1]}"
    return parts[0] if parts else ""


def _for_text(terminal: dict[str, Any], device_by_id: dict[str, dict[str, Any]], head: dict[str, Any] | None) -> str:
    part_id = str(terminal["part_id"])
    if part_id in END_PART_IDS:
        return "—"
    if part_id in FEED_PART_IDS:
        parts = [f"FI {text_of(head.get('designation')) or '?'}" if head else "", _rcd_detail(head)]
        return " · ".join(p for p in parts if p) or "—"
    device = device_by_id.get(str(terminal.get("device_id") or ""))
    if device is None:
        return "—"
    circuit = text_of(device.get("circuit"))
    parts = [text_of(device.get("designation")), text_of(device.get("label")), f"Nr. {circuit}" if circuit else ""]
    return " · ".join(p for p in parts if p) or "—"


def _strip_heading_text(group: dict[str, Any], strip: dict[str, Any]) -> str:
    """"X1 · FI F1 · Reihe 1 · Standard · 30 mA / Typ A" for a Leiste,
    "X2 · Block F1.4 Wallbox · Wallbox" for a Block."""
    if strip["kind"] == STRIP_KIND_BLOCK:
        parts = [str(strip["title"]), str(strip.get("name") or "")]
    else:
        parts = [
            str(strip["title"]),
            VARIANT_LABELS.get(str(group.get("variant") or ""), ""),
            _rcd_detail(group.get("head_device")),
        ]
    return " · ".join(p for p in parts if p)


def row_values(
    terminal: dict[str, Any], device_by_id: dict[str, dict[str, Any]], head: dict[str, Any] | None
) -> dict[str, str]:
    """One terminal as the sheet's cells, keyed like ``_COLUMNS``.

    Public so the test can pin the columns without parsing content streams:
    the Beschriftung cell is exactly the terminal's ``label`` (overrides
    applied), "—" where the marker says nothing.
    """
    return {
        "position": str(terminal["position"]),
        "part": str(terminal["part_no"]),
        "label": str(terminal.get("label") or "") or "—",
        "for": _for_text(terminal, device_by_id, head),
    }


def column_titles() -> list[str]:
    """The sheet's column headings, in order — pinned against the Klemmen tab's."""
    return [title for _key, title, _width in _COLUMNS]


def _table_header(c: pdfcanvas.Canvas, x0: float, y: float, columns: list[tuple[str, str, float]]) -> float:
    total = sum(col[2] for col in columns)
    c.setFillColor(BLUE_TINT)
    c.setStrokeColor(LINE)
    c.setLineWidth(0.5)
    c.rect(x0, y - 4, total, 16, stroke=1, fill=1)
    c.setFillColor(BLUE_DEEP)
    c.setFont(FONT_BOLD, 7)
    x = x0
    for _key, title, w in columns:
        c.drawString(x + 3, y + 2, title)
        x += w
    return y - 16


def _table_row(
    c: pdfcanvas.Canvas,
    x0: float,
    y: float,
    columns: list[tuple[str, str, float]],
    values: dict[str, str],
    *,
    index: int,
    bold_keys: frozenset[str],
    ink_keys: frozenset[str],
) -> float:
    """One zebra row; the height grows with the tallest wrapped cell."""
    total = sum(col[2] for col in columns)
    cell_lines = [wrap(values.get(key, ""), FONT, _FONT_SIZE, w - 6, 3) for key, _title, w in columns]
    row_h = max(_ROW_H, 4 + 9.0 * max((len(lines) for lines in cell_lines), default=1))
    if index % 2 == 1:
        c.setFillColor(ZEBRA)
        c.rect(x0, y - row_h + 9, total, row_h, stroke=0, fill=1)
    c.setStrokeColor(GRID)
    c.setLineWidth(0.4)
    c.line(x0, y - row_h + 9, x0 + total, y - row_h + 9)
    x = x0
    for (key, _title, w), lines in zip(columns, cell_lines):
        c.setFillColor(INK if key in ink_keys else MUTED)
        c.setFont(FONT_BOLD if key in bold_keys else FONT, _FONT_SIZE)
        text_y = y
        for line in lines or ["—"]:
            c.drawString(x + 3, text_y, line)
            text_y -= 9.0
        x += w
    return y - row_h


def draw_terminal_sheets(
    c: pdfcanvas.Canvas,
    *,
    plan: PanelPlan,
    document: dict[str, Any],
    groups: list[dict[str, Any]],
    customer_name: str | None,
    project_label: str | None,
    company: str,
) -> None:
    """Append the Reihenklemmen sheet(s) to the canvas and end the page."""
    width, height = A4
    total = sum(col[2] for col in _COLUMNS)
    x0 = (width - total) / 2
    device_by_id = {str(device.get("id") or ""): device for _row, device in iter_devices(document)}
    page_no = 0

    def start_page() -> float:
        nonlocal page_no
        page_no += 1
        c.setPageSize((width, height))
        header_bar(c, width, height, "Reihenklemmen", company)
        c.setFillColor(INK)
        c.setFont(FONT_BOLD, 11)
        c.drawString(x0, height - 58, f"{plan.designation} — {plan.name}")
        c.setFont(FONT, 8)
        c.setFillColor(MUTED)
        meta = " · ".join(
            part
            for part in (
                text_of(customer_name),
                text_of(project_label),
                text_of(plan.location),
                f"Rev. {plan.revision}",
                datetime.now().strftime("%d.%m.%Y"),
            )
            if part
        )
        c.drawString(x0, height - 70, wrap(meta, FONT, 8, total, 1)[0] if meta else "")
        if page_no > 1:
            c.drawRightString(x0 + total, height - 70, f"Seite {page_no}")
        return height - 92

    def ensure_room(y: float, needed: float) -> float:
        if y - needed < _FOOT_Y:
            c.showPage()
            return start_page()
        return y

    y = start_page()

    if not groups:
        c.setFont(FONT, 9)
        c.setFillColor(MUTED)
        c.drawString(x0 + 3, y - 4, "Noch keine Reihenklemmen abgeleitet.")
        c.showPage()
        return

    for group, strip in ((group, strip) for group in groups for strip in group["strips"]):
        # Keep the heading with at least its header row and two terminals.
        y = ensure_room(y, 20 + 16 + 2 * _ROW_H)
        c.setFillColor(INK)
        c.setFont(FONT_BOLD, 9)
        c.drawString(x0, y, wrap(_strip_heading_text(group, strip), FONT_BOLD, 9, total, 1)[0])
        y -= 14
        y = _table_header(c, x0, y, _COLUMNS)
        for index, terminal in enumerate(strip["terminals"]):
            if y - _ROW_H < _FOOT_Y:
                c.showPage()
                y = start_page()
                y = _table_header(c, x0, y, _COLUMNS)
            y = _table_row(
                c, x0, y, _COLUMNS, row_values(terminal, device_by_id, group.get("head_device")),
                index=index,
                bold_keys=frozenset({"position"}) | _TEXT_KEYS,
                ink_keys=frozenset({"position", "part"}) | _TEXT_KEYS,
            )
        y -= 12

    # ── Stückliste ──────────────────────────────────────────────────────────
    bom = terminal_bom(groups)
    y = ensure_room(y, 20 + 16 + _ROW_H * (len(bom) + 1))
    c.setFillColor(INK)
    c.setFont(FONT_BOLD, 9)
    c.drawString(x0, y, "Stückliste Reihenklemmen")
    y -= 14
    y = _table_header(c, x0, y, _BOM_COLUMNS)
    for index, row in enumerate(bom):
        if y - _ROW_H < _FOOT_Y:
            c.showPage()
            y = start_page()
            y = _table_header(c, x0, y, _BOM_COLUMNS)
        width_text = f"{row['width_mm']:g} mm".replace(".", ",") if row["width_mm"] else "—"
        if not row["verified"]:
            width_text = "nicht bestätigt"
        values = {
            "part_no": str(row["part_no"]),
            "name": str(row["name"]),
            "count": str(row["count"]),
            "width": width_text,
        }
        y = _table_row(
            c, x0, y, _BOM_COLUMNS, values,
            index=index, bold_keys=frozenset({"part_no", "count"}), ink_keys=frozenset({"part_no", "name", "count"}),
        )

    unverified = unverified_terminal_parts(groups)
    if unverified:
        y -= 10
        c.setFillColor(WARN)
        c.setFont(FONT, 7.5)
        names = ", ".join(part.part_no for part in unverified)
        c.drawString(x0, y, wrap(f"Breite nicht bestätigt: {names} — vor dem ersten Druck am Träger messen.", FONT, 7.5, total, 1)[0])

    counts = terminal_counts(groups)
    c.setFillColor(MUTED)
    c.setFont(FONT, 7)
    c.drawString(
        x0, 44,
        f"{counts['terminals']} Klemmen · {len(bom)} Artikel · {counts['groups']} Gruppe(n) · erstellt mit der SMPL Workflow-App",
    )
    c.showPage()
