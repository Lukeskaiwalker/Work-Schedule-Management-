"""Device symbols of the Verteilerplan drawing sheets.

Two vocabularies, one module:

* ``draw_glyph`` — the 22×18 pt single-line glyph of the Übersichtsschaltplan
  (moved from ``schaltplan_pdf.py`` unchanged): one glyph per device, the
  pole count as an EN 60617 mark beside it.
* ``draw_pole`` / ``draw_rcd_ring`` / the small shapes — the all-conductor
  symbols of the Stromlaufplan (docs/SCHALTPLAN_STROMLAUF.md §5.4): one
  symbol per pole on that pole's wire, in the conductor's colour, between the
  top and the bottom edge of the device box the layout gave it.

Deliberately schematic rather than DIN-exact: at this size a strict EN 60617
symbol turns into a blob, and the device is always named beside it anyway.
"""

from __future__ import annotations

from reportlab.lib import colors
from reportlab.pdfgen import canvas as pdfcanvas

from app.services.schaltplan_layout import DEVICE_CATALOG
from app.services.schaltplan_pdf_style import (
    BLUE_DEEP,
    FONT,
    FONT_BOLD,
    GRID,
    INK,
    draw_text,
)

#: Device kind → the per-pole symbol of the Stromlaufplan.
POLE_SYMBOLS: dict[str, str] = {
    "mcb": "mcb", "rcbo": "mcb", "sls": "sls", "fuse": "fuse", "hauptschalter": "contact",
    "rcd": "contact", "contactor": "contact", "impulse": "contact", "timer": "contact",
    "knx_actuator": "contact", "wallbox": "mcb", "pv": "mcb", "sub_feed": "mcb",
    "distribution_block": "through", "hlak": "through", "terminal": "through",
    "bell_transformer": "through", "power_supply": "through", "meter": "through", "spd": "through",
}


def pole_symbol(kind: str) -> str:
    return POLE_SYMBOLS.get(kind, "through")


# ── Übersicht: one glyph per device ─────────────────────────────────────────


def draw_glyph(c: pdfcanvas.Canvas, kind: str, cx: float, cy: float, poles: int = 1) -> None:
    """A 22×18 pt glyph centred on ``(cx, cy)``.

    A multi-pole breaker carries the EN 60617 pole mark — the short stroke
    across the lead with the count beside it — because a 1-pole and a 3-pole
    LS read identically otherwise (owner's print of 2026-09-24).
    """
    symbol = str(DEVICE_CATALOG.get(kind, {}).get("symbol", "blank"))
    c.saveState()
    c.setStrokeColor(BLUE_DEEP)
    c.setLineWidth(1.1)
    _GLYPHS.get(symbol, _glyph_blank)(c, symbol, cx, cy, poles)
    c.restoreState()


def _glyph_breaker(c: pdfcanvas.Canvas, symbol: str, cx: float, cy: float, poles: int) -> None:
    c.line(cx, cy + 9, cx, cy + 4)
    c.line(cx, cy - 9, cx, cy - 4)
    c.line(cx, cy - 4, cx + 7, cy + 4)
    if poles >= 2:
        c.setLineWidth(0.9)
        c.line(cx - 3, cy + 5.5, cx + 3, cy + 8.5)
        c.setFont(FONT_BOLD, 6.5)
        c.setFillColor(BLUE_DEEP)
        c.drawRightString(cx - 4.5, cy + 2.5, str(poles))
    if symbol == "fuse":
        c.rect(cx - 4, cy - 5, 8, 10, stroke=1, fill=0)
    if symbol == "sls":
        c.line(cx - 6, cy + 1, cx - 2, cy + 5)
    if symbol == "rcbo":
        c.circle(cx - 6, cy, 3.4, stroke=1, fill=0)


def _glyph_rcd(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    # Residual-current device: the summation transformer as a ring.
    c.circle(cx, cy, 7.0, stroke=1, fill=0)
    c.line(cx - 9, cy + 9, cx + 9, cy - 9)


def _glyph_switch(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.line(cx, cy + 9, cx, cy + 3)
    c.line(cx, cy - 9, cx, cy - 3)
    c.line(cx - 1, cy - 3, cx + 8, cy + 5)


def _glyph_spd(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.line(cx, cy + 9, cx, cy + 3)
    c.line(cx, cy - 9, cx, cy - 3)
    c.rect(cx - 5, cy - 3, 10, 6, stroke=1, fill=0)
    c.line(cx - 3, cy + 6, cx + 3, cy + 6)


def _glyph_meter(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.circle(cx, cy, 8.0, stroke=1, fill=0)
    c.setFont(FONT_BOLD, 6)
    c.setFillColor(BLUE_DEEP)
    c.drawCentredString(cx, cy - 2.2, "kWh")


def _glyph_contactor(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.line(cx, cy + 9, cx, cy + 3)
    c.line(cx, cy - 9, cx, cy - 3)
    c.rect(cx - 6, cy - 3, 12, 6, stroke=1, fill=0)


def _glyph_relay(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.rect(cx - 7, cy - 6, 14, 12, stroke=1, fill=0)
    c.line(cx - 7, cy + 6, cx + 7, cy - 6)


def _glyph_transformer(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.circle(cx - 3.5, cy, 5.0, stroke=1, fill=0)
    c.circle(cx + 3.5, cy, 5.0, stroke=1, fill=0)


def _glyph_bus(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.rect(cx - 8, cy - 6, 16, 12, stroke=1, fill=0)
    c.line(cx - 8, cy, cx + 8, cy)
    c.circle(cx, cy, 2.0, stroke=1, fill=1)


def _glyph_wallbox(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.rect(cx - 6, cy - 8, 12, 16, stroke=1, fill=0)
    c.line(cx - 2, cy + 2, cx + 2, cy + 2)
    c.line(cx, cy + 2, cx, cy - 4)


def _glyph_pv(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.rect(cx - 8, cy - 6, 16, 12, stroke=1, fill=0)
    c.line(cx, cy - 6, cx, cy + 6)
    c.line(cx - 8, cy, cx + 8, cy)


def _glyph_subfeed(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.line(cx - 8, cy, cx + 5, cy)
    c.line(cx + 5, cy, cx + 1, cy + 4)
    c.line(cx + 5, cy, cx + 1, cy - 4)
    c.rect(cx + 5, cy - 7, 4, 14, stroke=1, fill=0)


def _glyph_distribution(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    # Verteilerblock: one feed in, a bar, three taps out.
    c.line(cx, cy + 9, cx, cy + 3)
    c.setLineWidth(2.0)
    c.line(cx - 8, cy + 3, cx + 8, cy + 3)
    c.setLineWidth(1.1)
    for dx in (-6.0, 0.0, 6.0):
        c.line(cx + dx, cy + 3, cx + dx, cy - 7)


def _glyph_terminal(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.circle(cx - 4, cy, 2.6, stroke=1, fill=0)
    c.circle(cx + 4, cy, 2.6, stroke=1, fill=0)
    c.line(cx - 1.4, cy, cx + 1.4, cy)


def _glyph_blank(c: pdfcanvas.Canvas, _symbol: str, cx: float, cy: float, _poles: int) -> None:
    c.setStrokeColor(GRID)
    c.rect(cx - 7, cy - 7, 14, 14, stroke=1, fill=0)


_GLYPHS = {
    "mcb": _glyph_breaker, "rcbo": _glyph_breaker, "fuse": _glyph_breaker, "sls": _glyph_breaker,
    "rcd": _glyph_rcd, "switch": _glyph_switch, "spd": _glyph_spd, "meter": _glyph_meter,
    "contactor": _glyph_contactor, "relay": _glyph_relay, "transformer": _glyph_transformer,
    "bus": _glyph_bus, "wallbox": _glyph_wallbox, "pv": _glyph_pv, "subfeed": _glyph_subfeed,
    "distribution": _glyph_distribution, "terminal": _glyph_terminal,
}


# ── Stromlaufplan: one symbol per pole ──────────────────────────────────────


def draw_pole(c: pdfcanvas.Canvas, symbol: str, x: float, y_bot: float, y_top: float) -> None:
    """The pole's symbol on its wire from ``y_top`` down to ``y_bot``; the
    caller has set the conductor's stroke colour and width."""
    mid = (y_top + y_bot) / 2
    if symbol == "spd":  # a varistor on the pole: the lead into a small block
        half = min(2.6, (y_top - y_bot) / 4)
        c.line(x, y_top, x, mid + half)
        c.line(x, y_bot, x, mid - half)
        c.rect(x - 1.3, mid - half, 2.6, 2 * half, stroke=1, fill=0)
        return
    if symbol in ("mcb", "sls", "contact"):
        gap = min(3.2, (y_top - y_bot) / 4)
        c.line(x, y_top, x, mid + gap)
        c.line(x, y_bot, x, mid - gap)
        c.line(x, mid - gap, x + 3.2, mid + gap + 0.6)
        if symbol in ("mcb", "sls"):
            c.line(x - 1.3, mid + gap - 1.3, x + 1.3, mid + gap + 1.3)
            c.line(x - 1.3, mid + gap + 1.3, x + 1.3, mid + gap - 1.3)
        if symbol == "sls":
            c.line(x - 2.6, mid - 1.0, x - 0.6, mid + 1.0)
        return
    if symbol == "fuse":
        c.line(x, y_top, x, y_bot)
        c.saveState()
        c.setFillColor(colors.white)
        c.rect(x - 1.8, mid - 3.2, 3.6, 6.4, stroke=1, fill=1)
        c.restoreState()
        return
    c.line(x, y_top, x, y_bot)


def draw_rcd_ring(c: pdfcanvas.Canvas, x0: float, x1: float, cy: float) -> None:
    """The summation transformer: one flat ring around every pole of the RCD."""
    c.saveState()
    c.setStrokeColor(INK)
    c.setLineWidth(0.7)
    c.ellipse(x0 - 2.6, cy - 2.4, x1 + 2.6, cy + 2.4, stroke=1, fill=0)
    c.restoreState()


def draw_terminal(c: pdfcanvas.Canvas, x: float, y: float) -> None:
    """A terminal point: an open circle on the wire end."""
    c.saveState()
    c.setFillColor(colors.white)
    c.setLineWidth(0.7)
    c.circle(x, y, 1.8, stroke=1, fill=1)
    c.restoreState()


def draw_badge(c: pdfcanvas.Canvas, x: float, y: float, w: float, h: float, label: str) -> None:
    """A small labelled block (meter, SPD, Lüsterklemme, RJ45, SABO): a box with its short name."""
    c.saveState()
    c.setStrokeColor(INK)
    c.setLineWidth(0.8)
    c.setFillColor(colors.white)
    c.rect(x, y, w, h, stroke=1, fill=1)
    c.setFillColor(INK)
    draw_text(c, x + w / 2, y + h / 2 - 2.3, label, font=FONT, size=6.5, anchor="middle")
    c.restoreState()


# ── The cabinet sheet's parts ───────────────────────────────────────────────

#: The §14a wire colours (docs/PANEL_ENCLOSURE_R4.md §2.3); weiß and rosa get an outline.
_WIRE_SWATCH = {"braun": "#8a5527", "schwarz": "#1c2024", "grau": "#8b929b", "rot": "#d0312d",
                "violett": "#7547c9", "weiß": "#ffffff", "orange": "#f08a24", "rosa": "#f2a7c3"}


def draw_control_terminal(c: pdfcanvas.Canvas, x: float, y: float, w: float, h: float, colour: str | None) -> None:
    """A 2002-1671 of the §14a block (the box is drawn): its wire colour as a
    small swatch in the top-left corner, clear of the vertical name."""
    fill = _WIRE_SWATCH.get(colour or "")
    if fill is None:
        return
    c.saveState()
    c.setFillColor(colors.HexColor(fill))
    c.setStrokeColor(colors.HexColor("#6b7a8c"))
    c.setLineWidth(0.4)
    c.rect(x + 1.0, y + h - 4.0, 3.0, 3.0, stroke=1, fill=1)
    c.restoreState()


def draw_luester(c: pdfcanvas.Canvas, x: float, y: float, w: float, h: float, poles: list[float]) -> None:
    """A Lüsterklemme cut to length: one strip, a screw per pole."""
    c.saveState()
    c.setStrokeColor(INK)
    c.setLineWidth(0.7)
    c.setFillColor(colors.white)
    c.rect(x, y, w, h, stroke=1, fill=1)
    for px in poles:
        c.circle(px, y + h / 2, min(2.0, h / 2 - 1.0), stroke=1, fill=0)
    c.restoreState()


def draw_rj45(c: pdfcanvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    """An RJ45 jack: the body and its opening."""
    c.saveState()
    c.setStrokeColor(INK)
    c.setLineWidth(0.7)
    c.setFillColor(colors.white)
    c.rect(x, y, w, h, stroke=1, fill=1)
    c.rect(x + w * 0.25, y + h * 0.3, w * 0.5, h * 0.45, stroke=1, fill=0)
    c.restoreState()
