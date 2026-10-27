"""The Stromlaufplan sheets on the canvas (docs/SCHALTPLAN_STROMLAUF.md §5.4).

``draw_stromlauf_sheets`` maps the layout of ``schaltplan_stromlauf_layout``
to the canvas and nothing else: every position, every text and every hop
comes from the layout. Conductors are stroked in their colours (PE and PEN
twice: the base, then a 3/3 dashed overlay); a vertical wire is interrupted
at each hop and bridged by a semicircle (r 2.2 pt); junctions are filled dots.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from reportlab.lib import colors
from reportlab.pdfgen import canvas as pdfcanvas

from app.models.schaltplan import PanelPlan
from app.services.schaltplan_pdf_style import (
    FONT,
    FONT_BOLD,
    OVERLAY_DASH,
    draw_conductor_key,
    draw_drawing_furniture,
    draw_text,
    stroke_conductor,
    text_width,
    title_strip_for,
)
from app.services.schaltplan_stromlauf_layout import STROMLAUF_TITLE
from app.services.schaltplan_stromlauf_symbols import (
    draw_control_terminal,
    draw_luester,
    draw_pole,
    draw_rcd_ring,
    draw_rj45,
    draw_terminal,
    pole_symbol,
)

HOP_R = 2.2
DOT_R = 2.0
WIRE_W = 1.3
THIN_W = 0.7
DOT_COLOUR = colors.HexColor("#1c2024")
BOX_STROKE = colors.HexColor("#14293d")
WARN_STROKE = colors.HexColor("#b45309")
PART_FILL = colors.HexColor("#8b929b")
_POLE_SYMBOL = {"rcd": "contact", "mcb": "mcb", "rcbo": "mcb", "fuse": "fuse", "sls": "sls", "switch": "contact",
                "contact": "contact", "distribution": "through", "device": "through", "sabo": "fuse",
                "hlak": "through", "infeed": "through", "joint": "through", "placeholder": "through", "spd": "spd"}


def _stroke_segment(c: pdfcanvas.Canvas, conductor: str, x0: float, y0: float, x1: float, y1: float) -> None:
    style = stroke_conductor(c, conductor)
    c.line(x0, y0, x1, y1)
    if style.overlay:
        c.setStrokeColor(colors.HexColor(style.overlay))
        c.setDash(*OVERLAY_DASH)
        c.line(x0, y0, x1, y1)
        c.setDash()


def _stroke_hop(c: pdfcanvas.Canvas, conductor: str, x: float, y: float) -> None:
    style = stroke_conductor(c, conductor)
    c.arc(x - HOP_R, y - HOP_R, x + HOP_R, y + HOP_R, -90, 180)
    if style.overlay:
        c.setStrokeColor(colors.HexColor(style.overlay))
        c.setDash(*OVERLAY_DASH)
        c.arc(x - HOP_R, y - HOP_R, x + HOP_R, y + HOP_R, -90, 180)
        c.setDash()


def _draw_wire(c: pdfcanvas.Canvas, wire: Mapping[str, Any], hops_at: Mapping[float, list[float]]) -> None:
    conductor = wire["conductor"]
    points = wire["points"]
    c.setLineWidth(THIN_W if wire.get("thin") else WIRE_W)
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 != x1:
            _stroke_segment(c, conductor, x0, y0, x1, y1)
            continue
        low, high = min(y0, y1), max(y0, y1)
        cuts = sorted(y for y in hops_at.get(x0, []) if low < y < high)
        start = low
        for y in cuts:
            _stroke_segment(c, conductor, x0, start, x0, y - HOP_R)
            _stroke_hop(c, conductor, x0, y)
            start = y + HOP_R
        _stroke_segment(c, conductor, x0, start, x0, high)


def _draw_part(c: pdfcanvas.Canvas, box: Mapping[str, Any]) -> bool:
    """The cabinet sheet's small parts that are no device box; True when drawn."""
    x, y, w, h = box["x"], box["y"], box["w"], box["h"]
    kind = box["kind"]
    if kind == "terminal":
        stroke_conductor(c, box.get("conductor", "L?"))
        c.setDash()  # a terminal circle is solid, also on a dashed control wire
        draw_terminal(c, x + w / 2, y + h / 2)
        return True
    if kind in ("end_stop", "plate"):
        c.setStrokeColor(BOX_STROKE)
        c.setLineWidth(0.5)
        c.setFillColor(PART_FILL)
        c.rect(x, y, w, h, stroke=1, fill=1)
        return True
    if kind == "luester":
        draw_luester(c, x, y, w, h, [pole["x"] for pole in box["poles"]])
        return True
    if kind == "rj45":
        draw_rj45(c, x, y, w, h)
        return True
    return False


def _draw_box(c: pdfcanvas.Canvas, box: Mapping[str, Any]) -> None:
    x, y, w, h = box["x"], box["y"], box["w"], box["h"]
    if _draw_part(c, box):
        return
    placeholder = box["kind"] == "placeholder"
    c.setStrokeColor(WARN_STROKE if placeholder else BOX_STROKE)
    c.setLineWidth(0.7)
    c.setDash(*((2.0, 1.5) if placeholder else ()))
    c.setFillColor(colors.white)
    c.rect(x, y, w, h, stroke=1, fill=1)
    c.setDash()
    if box["kind"] == "control_terminal":
        draw_control_terminal(c, x, y, w, h, box.get("colour"))
    symbol = _POLE_SYMBOL.get(box["kind"], pole_symbol(str(box.get("device", ""))))
    c.setLineWidth(WIRE_W)
    for pole in box["poles"]:
        if "y" in pole:  # a series device on the horizontal bus: the pole drawn turned
            c.saveState()
            c.translate(x + w / 2, pole["y"])
            c.rotate(90)
            stroke_conductor(c, pole["conductor"])
            draw_pole(c, pole.get("symbol", symbol), 0, -w / 2, w / 2)
            c.restoreState()
            continue
        stroke_conductor(c, pole["conductor"])
        draw_pole(c, pole.get("symbol", symbol), pole["x"], y, y + h)
    c.setDash()
    if box["kind"] in ("rcd", "rcbo") and box["poles"]:
        xs = [pole["x"] for pole in box["poles"]]
        draw_rcd_ring(c, min(xs), max(xs), y + h * 0.28)


def _draw_texts(c: pdfcanvas.Canvas, texts: Sequence[Mapping[str, Any]]) -> None:
    for text in texts:
        font = FONT_BOLD if text.get("bold") else FONT
        c.setFillColor(colors.HexColor(text.get("colour") or "#14293d"))
        if text.get("chip"):
            width = text_width(text["text"], font, text["size"])
            c.saveState()
            c.setFillColor(colors.HexColor("#2f70b7"))
            c.roundRect(text["x"] - 2.5, text["y"] - 2.6, width + 5, text["size"] + 3.4, 2.5, stroke=0, fill=1)
            c.restoreState()
            c.setFillColor(colors.white)
        if text.get("angle"):
            c.saveState()
            c.translate(text["x"], text["y"])
            c.rotate(text["angle"])
            draw_text(c, 0, 0, text["text"], font=font, size=text["size"], anchor=text["anchor"])
            c.restoreState()
            continue
        draw_text(c, text["x"], text["y"], text["text"], font=font, size=text["size"], anchor=text["anchor"])


def draw_stromlauf_sheet_content(c: pdfcanvas.Canvas, sheet: Mapping[str, Any]) -> None:
    """One sheet's drawing area: wires (with hops), boxes, dots, texts."""
    hops_at: dict[float, list[float]] = {}
    for hop in sheet["hops"]:
        hops_at.setdefault(hop["x"], []).append(hop["y"])
    c.saveState()
    c.setLineWidth(WIRE_W)
    c.setLineCap(0)
    for wire in sheet["wires"]:
        _draw_wire(c, wire, hops_at)
    for box in sheet["boxes"]:
        _draw_box(c, box)
    c.setFillColor(DOT_COLOUR)
    for x, y in sheet["dots"]:
        c.circle(x, y, DOT_R, stroke=0, fill=1)
    _draw_texts(c, sheet["texts"])
    c.restoreState()


def draw_stromlauf_sheets(
    c: pdfcanvas.Canvas,
    sheets: Sequence[Mapping[str, Any]],
    *,
    plan: PanelPlan,
    customer_name: str | None,
    project_label: str | None,
    fed_from: str | None,
    author: str | None,
    company: str,
    first_sheet: int,
    total: int,
) -> None:
    """Every Stromlauf sheet with its furniture; "Blatt i/n" from ``first_sheet``.
    ``author`` is accepted for the contract's signature; the title strip has no cell for it."""
    strip = title_strip_for(plan, customer_name=customer_name, project_label=project_label, fed_from=fed_from,
                            company=company, title=STROMLAUF_TITLE)
    for index, sheet in enumerate(sheets):
        number = sheet.get("number", first_sheet + index)
        draw_drawing_furniture(c, title=sheet.get("title", STROMLAUF_TITLE), company=company, strip=strip,
                               sheet=number, sheets=total)
        draw_conductor_key(c, note=sheet.get("note", ""))
        draw_stromlauf_sheet_content(c, sheet)
        c.showPage()
