"""The "Aufbau" PDF of a cabinet board (docs/PANEL_ENCLOSURE.md §13).

Page 1, A4 landscape: the open front view in a 180 × 180 mm box on the left,
at the largest of 1:5, 1:8, 1:10, 1:15, 1:20 that fits — a standard scale,
never an arbitrary shrink, because a fitter measures off this paper (every
shipped cabinet lands on 1:8). The right column (85 mm) carries the title
block, the modules per field, the pre-fitted parts, the parts taken out on
their way to the shelf, and the warn findings as a Prüfhilfe. Each list
stops at the column bottom with "… und {n} weitere"; when the hints did not
all fit, the full list follows on the Materialliste's last page.

Then the Materialliste pages, portrait, drawn by the same function as their
own PDF (``schaltplan_material_pdf.draw_material_pages``).

Every position comes from ``build_enclosure_scene`` — this module only maps
millimetres to points and draws boxes, so the sheet is the picture the
editor shows. Text only through ``drawString`` (never Paragraph markup: a
BMK is user input).
"""

from __future__ import annotations

from datetime import datetime
from io import BytesIO
from typing import Any, Iterable, Mapping, Sequence

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdfcanvas

from app.models.schaltplan import PanelPlan
from app.schemas.schaltplan import PanelMaterialOut
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_geometry import build_enclosure_scene
from app.services.panel_enclosure_layout import (
    as_int,
    enclosure_of,
    ident,
    module_fittings,
    module_spec,
    modules_of,
    supplied_claims,
    text,
)
from app.services.schaltplan_material_pdf import LINE_REMOVED, RETURNS_TITLE, draw_material_pages
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
    header_bar,
    text_of,
    wrap,
)

MM = 72 / 25.4  # points per millimetre
SCALES: tuple[int, ...] = (5, 8, 10, 15, 20)
HINTS_TITLE = "Hinweise (VDE-AR-N 4100) — Prüfhilfe, ersetzt keine Abnahme"

_MARGIN = 12 * MM
_BOX = 180 * MM
_COLUMN_X = _MARGIN + _BOX + 8 * MM
_COLUMN_W = 85 * MM
_MIN_LABEL_W = 2 * MM  # a box narrower than this on paper keeps its label to itself (§4)
_LABEL_SIZE = 5.0
_ITEM_SIZE = 7.5
_ITEM_H = 9.0
_HEAD_H = 30.0  # a heading: gap, up to two lines, rule

_FILL: Mapping[str, Any] = {
    "shell": colors.HexColor("#f3f4f6"), "rail": colors.HexColor("#9ca3af"), "busbar": colors.HexColor("#d97706"),
    "device": colors.white, "meter": colors.HexColor("#dbeafe"), "module": colors.white,
}
_ZONE_FILL: Mapping[str, Any] = {
    "NAR": colors.HexColor("#fef3c7"), "SAS": colors.HexColor("#fef3c7"), "ZF": colors.HexColor("#e0f2fe"),
    "AAR": colors.HexColor("#fff7ed"), "RFZ": colors.HexColor("#ede9fe"), "APZ": colors.HexColor("#ede9fe"),
    "VF": colors.HexColor("#f8fafc"), "VT": colors.HexColor("#f8fafc"), "MM": colors.HexColor("#ecfeff"),
    "COVER": colors.HexColor("#e5e7eb"),
}


def pick_scale(width_mm: float, height_mm: float, box_w_pt: float, box_h_pt: float) -> int:
    """The largest standard scale (smallest n of 1:n) at which the cabinet fits; else 1:20."""
    for scale in SCALES:
        if width_mm / scale * MM <= box_w_pt + 1e-6 and height_mm / scale * MM <= box_h_pt + 1e-6:
            return scale
    return SCALES[-1]


def build_aufbau_pdf(
    *,
    plan: PanelPlan,
    catalog: EnclosureCatalog,
    material: PanelMaterialOut,
    findings: list[dict[str, str]],
    customer_name: str | None,
    project_label: str | None,
    company_name: str | None,
) -> bytes:
    buffer = BytesIO()
    c = pdfcanvas.Canvas(buffer, pagesize=landscape(A4))
    width, height = landscape(A4)
    header_bar(c, width, height, "Aufbau", text_of(company_name) or "SMPL")
    document = plan.document or {}
    _draw_front(c, document, catalog)
    warnings = [text_of(f.get("message")) for f in findings if f.get("level") == "warn"]
    column = _Column(c, top=_MARGIN + _BOX, bottom=_MARGIN)
    _title_block(column, plan, document, catalog, customer_name, project_label)
    sections = _sections(document, catalog, material, warnings)
    complete = column.lists(sections)
    c.showPage()
    hints_cut = not complete.get(HINTS_TITLE, True)
    draw_material_pages(c, material=material, company_name=company_name,
                        notes_title=HINTS_TITLE if hints_cut else "", notes=warnings if hints_cut else ())
    c.showPage()
    c.save()
    return buffer.getvalue()


# ── The drawing ──────────────────────────────────────────────────────────────


def _draw_front(c: pdfcanvas.Canvas, document: Any, catalog: EnclosureCatalog) -> None:
    box_top = _MARGIN + _BOX
    scene = build_enclosure_scene(document, catalog, view="open")
    if scene is None:
        enclosure = enclosure_of(document) or {}
        c.setStrokeColor(GRID)
        c.rect(_MARGIN, _MARGIN, _BOX, _BOX, stroke=1, fill=0)
        c.setFillColor(WARN)
        c.setFont(FONT_BOLD, 10)
        note = f"Schrank {text(enclosure.get('code')) or '?'} ist im Katalog unbekannt — keine Zeichnung."
        c.drawString(_MARGIN + 6, box_top - 20, wrap(note, FONT_BOLD, 10, _BOX - 12, 1)[0])
        return
    scale = pick_scale(scene["width"], scene["height"], _BOX, _BOX)
    factor = MM / scale
    origin_x = _MARGIN + (_BOX - scene["width"] * factor) / 2
    origin_top = box_top - (_BOX - scene["height"] * factor) / 2
    c.setFillColor(MUTED)
    c.setFont(FONT, 7.5)
    c.drawString(_MARGIN, box_top + 6, f"Maßstab 1:{scale} · Vorderansicht offen · Maße in mm, Zeichnung angenähert")
    drawn = [item for item in scene["boxes"] if item["kind"] not in ("door", "handle")]  # 2D open skips the door (§4)
    rects = [(origin_x + item["x"] * factor, origin_top - (item["y"] + item["h"]) * factor,
              item["w"] * factor, item["h"] * factor) for item in drawn]
    for item, rect in zip(drawn, rects):
        _draw_box(c, item, rect)
    # Labels last: a zone's fill (z 15) would cover its module's (z 12) otherwise.
    for item, rect in zip(drawn, rects):
        _draw_label(c, item, rect)


def _fill(kind: str, flags: set[str], zone_type: str | None) -> Any:
    if kind == "device" and "supplied" in flags:
        return BLUE_TINT  # pre-fitted: came with the module
    if kind == "module" and "unknown_code" in flags:
        return colors.HexColor("#fef2f2")
    return _ZONE_FILL.get(zone_type or "") if kind == "zone" else _FILL.get(kind)


def _stroke(kind: str, flags: set[str]) -> Any:
    if "overflow" in flags or "unknown_code" in flags:
        return WARN
    if kind == "module":
        return BLUE_DEEP
    return INK if kind in ("device", "meter") else GRID


def _draw_box(c: pdfcanvas.Canvas, item: Mapping[str, Any], rect: tuple[float, float, float, float]) -> None:
    kind, flags = item["kind"], set(item["flags"])
    x, y, w, h = rect
    fill = _fill(kind, flags, item["zoneType"])
    c.setStrokeColor(_stroke(kind, flags))
    c.setLineWidth(0.6 if kind in ("module", "shell") else 0.35)
    if kind in ("field", "meter_place") or "unknown_code" in flags:
        c.setDash(2, 1.5)  # outlines of what is not a part: the raster, a free place, a placeholder
    if fill is not None:
        c.setFillColor(fill)
    c.rect(x, y, w, h, stroke=0 if kind in ("zone", "rail", "busbar") else 1, fill=1 if fill is not None else 0)
    c.setDash()


def _draw_label(c: pdfcanvas.Canvas, item: Mapping[str, Any], rect: tuple[float, float, float, float]) -> None:
    kind = item["kind"]
    if kind in ("device", "meter", "meter_place"):
        _centre_label(c, item["label"], *rect)
    elif kind in ("module", "field"):
        _corner_label(c, item["label"], *rect, below=kind == "field")


def _centre_label(c: pdfcanvas.Canvas, label: str, x: float, y: float, w: float, h: float) -> None:
    """Horizontal when it fits, else turned 90° inside the box; hidden below 2 mm (§4)."""
    if not label or w < _MIN_LABEL_W:
        return
    c.setFillColor(INK)
    c.setFont(FONT, _LABEL_SIZE)
    if stringWidth(label, FONT, _LABEL_SIZE) <= w - 1:
        c.drawCentredString(x + w / 2, y + h / 2 - _LABEL_SIZE / 3, label)
        return
    fitted = wrap(label, FONT, _LABEL_SIZE, h - 2, 1)
    if not fitted:
        return
    c.saveState()
    c.translate(x + w / 2 + _LABEL_SIZE / 3, y + h / 2)
    c.rotate(90)
    c.drawCentredString(0, 0, fitted[0])
    c.restoreState()


def _corner_label(c: pdfcanvas.Canvas, label: str, x: float, y: float, w: float, h: float, *, below: bool) -> None:
    if not label or w < 8 * MM:
        return
    font = FONT if below else FONT_BOLD
    c.setFillColor(MUTED if below else BLUE_DEEP)
    c.setFont(font, _LABEL_SIZE)
    fitted = wrap(label, font, _LABEL_SIZE, w - 4, 1)
    if fitted:
        c.drawString(x + 2, (y - _LABEL_SIZE - 1) if below else (y + h - _LABEL_SIZE - 1), fitted[0])


# ── The right column ─────────────────────────────────────────────────────────


class _Column:
    """A text column filled top to bottom; lists stop at the bottom with a count."""

    def __init__(self, c: pdfcanvas.Canvas, *, top: float, bottom: float) -> None:
        self.c = c
        self.y = top
        self.bottom = bottom

    def line(self, value: str, *, font: str = FONT, size: float = _ITEM_SIZE, color: Any = INK, gap: float = _ITEM_H,
             max_lines: int = 1) -> None:
        self.c.setFillColor(color)
        self.c.setFont(font, size)
        for part in wrap(value, font, size, _COLUMN_W, max_lines) or [""]:
            self.c.drawString(_COLUMN_X, self.y - size, part)
            self.y -= gap

    def lists(self, sections: Sequence[tuple[str, list[str]]]) -> dict[str, bool]:
        """Each section gets at least its heading and one line; returns title → complete."""
        complete: dict[str, bool] = {}
        for index, (title, items) in enumerate(sections):
            reserve = sum(_HEAD_H + 2 * _ITEM_H for _ in sections[index + 1:])
            complete[title] = self._section(title, items, floor=self.bottom + reserve)
        return complete

    def _section(self, title: str, items: list[str], *, floor: float) -> bool:
        self.y -= 5
        self.line(title, font=FONT_BOLD, size=8.5, color=BLUE_DEEP, gap=10.5, max_lines=2)
        self.c.setStrokeColor(LINE)
        self.c.setLineWidth(0.4)
        self.c.line(_COLUMN_X, self.y + 0.5, _COLUMN_X + _COLUMN_W, self.y + 0.5)
        self.y -= 3
        if not items:
            self.line("—", color=MUTED)
            return True
        for index, item in enumerate(items):
            lines = wrap(item, FONT, _ITEM_SIZE, _COLUMN_W, 2)
            rest = len(items) - index
            needed = len(lines) * _ITEM_H + (_ITEM_H if rest > 1 else 0)
            if self.y - needed < floor:
                self.line(f"… und {rest} weitere", color=MUTED)
                return False
            for part in lines:
                self.line(part)
        return True


def _title_block(column: _Column, plan: PanelPlan, document: Any, catalog: EnclosureCatalog,
                 customer_name: str | None, project_label: str | None) -> None:
    enclosure = enclosure_of(document) or {}
    code = text(enclosure.get("code"))
    cabinet = catalog.enclosure(code) if code else None
    cabinet_text = f"{cabinet['article_no']} · {cabinet['name']}" if cabinet else f"{code or '—'} (unbekannt)"
    status = "Bestand" if plan.status == "final" else "Entwurf"
    column.line(f"{plan.panel_number} · {text_of(plan.designation)}", font=FONT_BOLD, size=11, gap=14)
    column.line(text_of(plan.name), size=8.5, gap=12)
    for caption, value in (
        ("Kunde", customer_name), ("Projekt", project_label), ("Schrank", cabinet_text),
        ("Stand", f"{datetime.now():%d.%m.%Y} · {status} · Rev. {plan.revision}"),
    ):
        column.line(f"{caption}: {text_of(value) or '—'}", color=INK if value else MUTED, max_lines=2)


def _sections(document: Any, catalog: EnclosureCatalog, material: PanelMaterialOut,
              warnings: list[str]) -> list[tuple[str, list[str]]]:
    return [
        ("Module je Feld", list(_module_lines(document, catalog))),
        ("Vorbestückt", list(_fitted_lines(document, catalog))),
        (RETURNS_TITLE, [
            f"{line.planned} × {text_of(line.label)}" if line.planned
            else f"{text_of(line.label)} — eingelagert, nicht mehr geplant"
            for line in material.lines if line.kind == LINE_REMOVED
        ]),
        (HINTS_TITLE, warnings),
    ]


def _module_art(module: Mapping[str, Any], catalog: EnclosureCatalog) -> str:
    spec = module_spec(module, catalog)
    return str(spec["article_no"]) if spec is not None else f"{text(module.get('code'))} (unbekannt)"


def _module_lines(document: Any, catalog: EnclosureCatalog) -> Iterable[str]:
    modules = sorted(enumerate(modules_of(document)),
                     key=lambda pair: (as_int(pair[1].get("field")), as_int(pair[1].get("unit")), pair[0]))
    for _, module in modules:
        spec = module_spec(module, catalog)
        label = text(module.get("label"))
        parts = [f"Feld {as_int(module.get('field')) + 1}", _module_art(module, catalog)]
        parts += [label] if label else []
        parts += [str(spec["name"])] if spec is not None else []
        yield " · ".join(parts)


def _fitted_lines(document: Any, catalog: EnclosureCatalog) -> Iterable[str]:
    """Fittings still in place: a device fitting with its claimant, a fixed
    part not listed as removed (only removable parts can be)."""
    claimed = set(supplied_claims(document, catalog).values())
    for module in modules_of(document):
        removed = {key for key in module.get("removed_fittings") or [] if isinstance(key, str)}
        art = _module_art(module, catalog)
        for fitting in module_fittings(module, catalog):
            key = str(fitting.get("key"))
            if fitting.get("device_kind"):
                in_place = (ident(module.get("id")), key) in claimed
            else:
                in_place = not (fitting.get("removable") and key in removed)
            if in_place:
                yield f"{art}: {text_of(fitting.get('label'))}"
