"""The Übersichtsschaltplan — the single-line sheets of the Verteilerplan PDF.

A single-line diagram: the supply block and the feeder chain at the left,
busbar segments, protection groups and their circuits; the title strip at the
bottom. Moved out of ``schaltplan_pdf.py`` (docs/SCHALTPLAN_STROMLAUF.md §4)
and fixed so it fits the sheet.

Sheet splitting, not shrinking
------------------------------
A board with more circuits than fit across one sheet is split over several
landscape sheets at full size, never scaled: a Schaltplan shrunk to 40 % is
unreadable in a cellar with a headlamp, which is exactly where it gets read.
``paginate_overview`` packs groups greedily, several per band. A group wider
than the rest of a band is split into column chunks of at least two columns
(the owner's 11 FIs printed on 12 sheets before); the continuation repeats
the head as "F1 (Forts.)" with paired markers "→ Forts. Blatt k" /
"Forts. von Blatt i". Nothing is drawn past x 802.

One busbar line per source
--------------------------
Groups share a busbar line only when they share their source (the root of
their ``fed_by`` chain, or the supply). Otherwise the line is broken and each
segment is captioned "hinter {bmk}". Feeder heads without circuits (SLS,
Hauptschalter, Verteilerblock) are not drawn as empty boxes; they form the
compact chain under the supply block ("Q0 SLS → Q1 HS → Sammelschiene").

The geometry mirrors ``apps/web/src/components/schaltplan/PanelDiagram.tsx``
so the printed sheet and the on-screen drawing are recognisably the same
picture; they are separate implementations on purpose.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Mapping, Sequence

from reportlab.lib import colors
from reportlab.pdfgen import canvas as pdfcanvas

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.schaltplan_layout import DEVICE_CATALOG, FEEDER_KINDS, build_topology
from app.services.schaltplan_pdf_style import (
    BLUE as _BLUE,
    BLUE_DEEP as _BLUE_DEEP,
    BLUE_TINT as _BLUE_TINT,
    DRAW_X0,
    DRAW_X1,
    FONT as _FONT,
    FONT_BOLD as _FONT_BOLD,
    INK as _INK,
    MUTED as _MUTED,
    WARN as _WARN,
    fit_text,
    text_of as _text,
    wrap as _wrap,
)
from app.services.schaltplan_stromlauf_cabinet import meter_side_ids
from app.services.schaltplan_stromlauf_model import feeder_path as model_feeder_path
from app.services.schaltplan_stromlauf_symbols import draw_glyph

# ── Geometry (points, y up) ─────────────────────────────────────────────────
_COL_W = 78.0          # one circuit column
_GROUP_GAP = 24.0      # horizontal gap between groups (≥ 16: a broken busbar reads as broken)
_GROUP_MIN_W = 150.0   # a group box never narrower than its own caption
_Y_BUS = 488.0
_Y_GROUP_TOP = 470.0
_Y_GROUP_BOT = 432.0
_Y_SUBBUS = 416.0
_Y_DEV_TOP = 396.0
_Y_DEV_BOT = 356.0
_Y_CHIP = 342.0
_Y_TEXT = 328.0
# A circuit's text stack: two label lines, then room, cable and phase.
_LABEL_PITCH = 8.5
_DETAIL_PITCH = 7.6
# Band 1 is band 0 dropped by what band 0's deepest text needs: a circuit's
# stack ends at _Y_TEXT − 2 × 8.5 − 2 × 7.6 = 295.8 and the lower busbar's
# caption sits 11.5 pt above the bar, so the bar must be at or below 278; 212
# puts band 1's own deepest line at 83.8, inside the drawing area (≥ 82).
_BAND_DY = 212.0
# The supply block sits beside the groups (not above the bus); the feeder
# chain hangs under it. Band 0's groups start right of it, band 1 at the frame.
_SUPPLY_X0, _SUPPLY_X1 = DRAW_X0, 190.0
_CHAIN_TOP, _CHAIN_BOTTOM = 424.0, 292.0
BAND_X0: tuple[float, float] = (200.0, DRAW_X0)
OVERVIEW_TITLE = "Übersichtsschaltplan"
_BUS_CAPTION = "SAMMELSCHIENE  L1 · L2 · L3 · N · PE"
METER_SIDE_TEXT = "Messsystem (ungezählt, vor SLS)"


def _short(kind: str) -> str:
    return str(DEVICE_CATALOG.get(kind, {}).get("short", "?"))


def _poles(device: Mapping[str, Any]) -> int:
    """The device's pole count, the catalog default when the document has none."""
    try:
        poles = int(device.get("poles") or 0)
    except (TypeError, ValueError):
        poles = 0
    if poles > 0:
        return poles
    return int(DEVICE_CATALOG.get(str(device.get("kind", "")), {}).get("poles", 1))


def _name(device: Mapping[str, Any]) -> str:
    """"Q1 HS": designation and short kind."""
    return " ".join(p for p in (_text(device.get("designation")), _short(str(device.get("kind", "")))) if p)


def _ident(device: Mapping[str, Any] | None) -> str:
    return str(device.get("id") or "") if device is not None else ""


# ── Sources and the feeder chain ────────────────────────────────────────────


def feeder_path(group: Mapping[str, Any], groups: Sequence[Mapping[str, Any]]) -> tuple[dict[str, Any], ...]:
    """The feeders above a group, root first: (Q0 SLS, Q1 HS, X1 VB)."""
    return model_feeder_path(group, {_ident(g["device"]): g for g in groups if g.get("device") is not None})


def source_of(group: Mapping[str, Any], groups: Sequence[Mapping[str, Any]]) -> str:
    """The id of the root of the group's ``fed_by`` chain; "" = the supply."""
    path = feeder_path(group, groups)
    return _ident(path[0]) if path else ""


def _is_chain_feeder(group: Mapping[str, Any]) -> bool:
    device = group.get("device")
    return device is not None and str(device.get("kind") or "") in FEEDER_KINDS and not group.get("children")


@dataclass(frozen=True)
class ChainLink:
    """One feeder head without circuits: its group and its depth in the chain."""

    device: Mapping[str, Any]
    group: Mapping[str, Any]
    depth: int


def feeder_chains(groups: Sequence[Mapping[str, Any]]) -> list[list[ChainLink]]:
    """The feeder heads without circuits, one list per source root, in topology order."""
    chains: dict[str, list[ChainLink]] = {}
    for group in groups:
        if not _is_chain_feeder(group):
            continue
        path = feeder_path(group, groups)
        root = _ident(path[0]) if path else _ident(group["device"])
        chains.setdefault(root, []).append(ChainLink(group["device"], group, len(path)))
    return list(chains.values())


def _common_feeder(paths: Sequence[tuple[dict[str, Any], ...]]) -> dict[str, Any] | None:
    """The deepest feeder every path passes through."""
    common: dict[str, Any] | None = None
    for depth in range(min(len(path) for path in paths)):
        ids = {_ident(path[depth]) for path in paths}
        if len(ids) != 1:
            break
        common = paths[0][depth]
    return common


# ── The supply group on a cabinet board (§4) ────────────────────────────────


def overview_groups(document: Any, catalog: EnclosureCatalog | None = None) -> list[dict[str, Any]]:
    """``build_topology``'s groups as the Übersicht draws them.

    Every group is a shallow copy with ``box``: "device", "warn" (the supply
    group, OHNE FI-SCHUTZ) or "meter" (supply-group members on RFZ/APZ rails
    or the NAR tap of a readable cabinet board: "Messsystem (ungezählt, vor
    SLS)"). The topology's dicts are never mutated.
    """
    groups = build_topology(document if isinstance(document, dict) else {})["groups"]
    meter_ids = meter_side_ids(document, catalog) if catalog is not None else frozenset()
    out: list[dict[str, Any]] = []
    for group in groups:
        if group["device"] is not None:
            out.append({**group, "box": "device"})
            continue
        meter = [child for child in group["children"] if _ident(child) in meter_ids]
        other = [child for child in group["children"] if _ident(child) not in meter_ids]
        if meter:
            out.append({**group, "children": meter, "box": "meter"})
        if other:
            out.append({**group, "children": other, "box": "warn"})
    return out


# ── Pagination ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Chunk:
    """Columns ``start..stop`` of one group, placed at ``x`` in a band."""

    group: Mapping[str, Any]
    start: int
    stop: int
    x: float
    width: float
    source: str
    prev_sheet: int | None = None   # "Forts. von Blatt {i}"
    next_sheet: int | None = None   # "→ Forts. Blatt {k}"


@dataclass(frozen=True)
class Segment:
    """One busbar line: the consecutive chunks of one source in a band."""

    source: str
    caption: str
    x0: float
    x1: float
    supply: bool  # drawn from the supply block (the supply's segment in band 0)


@dataclass(frozen=True)
class OverviewSheet:
    bands: tuple[tuple[Chunk, ...], tuple[Chunk, ...]]
    segments: tuple[tuple[Segment, ...], tuple[Segment, ...]]


def _width(columns: int) -> float:
    return max(_GROUP_MIN_W, _COL_W * max(1, columns))


def _ordered_loads(groups: Sequence[Mapping[str, Any]]) -> list[tuple[Mapping[str, Any], str]]:
    """Load groups (no chain feeders) by source in order of first appearance, then topology order."""
    loads = [(group, source_of(group, groups)) for group in groups if not _is_chain_feeder(group)]
    order: dict[str, int] = {}
    for _group, source in loads:
        order.setdefault(source, len(order))
    return sorted(loads, key=lambda pair: order[pair[1]])


def _pack(loads: Sequence[tuple[Mapping[str, Any], str]]) -> list[list[list[Chunk]]]:
    """Chunks per band per sheet (sheet numbers not yet linked)."""
    sheets: list[list[list[Chunk]]] = [[[], []]]
    band = 0

    def end(index: int) -> float:
        chunks = sheets[-1][index]
        return chunks[-1].x + chunks[-1].width + _GROUP_GAP if chunks else BAND_X0[index]

    def advance() -> None:
        nonlocal band
        if band == 0:
            band = 1
        else:
            sheets.append([[], []])
            band = 0

    for group, source in loads:
        total = len(group.get("children") or [])
        start = 0
        while True:
            x = end(band)
            columns = total - start
            whole = _width(columns)
            if x + whole <= DRAW_X1:
                sheets[-1][band].append(Chunk(group, start, total, x, whole, source))
                break
            fit = int((DRAW_X1 - x) // _COL_W)
            if fit < 2:  # a chunk is at least two columns, or its head has no room
                advance()
                continue
            sheets[-1][band].append(Chunk(group, start, start + fit, x, _COL_W * fit, source))
            start += fit
            advance()
    return sheets


def _link(sheets: list[list[list[Chunk]]]) -> list[list[list[Chunk]]]:
    """Fill prev_sheet / next_sheet between the chunks of one split group."""
    placed = [(number, b, i, chunk) for number, sheet in enumerate(sheets, start=1)
              for b, band in enumerate(sheet) for i, chunk in enumerate(band)]
    out = [[list(band) for band in sheet] for sheet in sheets]
    for (number, b, i, chunk), (next_number, nb, ni, follower) in zip(placed, placed[1:]):
        if follower.group is chunk.group and follower.start == chunk.stop:
            out[number - 1][b][i] = replace(out[number - 1][b][i], next_sheet=next_number)
            out[next_number - 1][nb][ni] = replace(out[next_number - 1][nb][ni], prev_sheet=number)
    return out


def _caption(chunks: Sequence[Chunk], groups: Sequence[Mapping[str, Any]], source: str) -> str:
    if not source:
        return _BUS_CAPTION
    common = _common_feeder([feeder_path(chunk.group, groups) for chunk in chunks])
    if common is None:
        return ""
    return f"hinter {_text(common.get('designation')) or _short(str(common.get('kind', '')))}"


def _segments(band: Sequence[Chunk], band_index: int, groups: Sequence[Mapping[str, Any]]) -> tuple[Segment, ...]:
    runs: list[list[Chunk]] = []
    for chunk in band:
        if runs and runs[-1][-1].source == chunk.source:
            runs[-1].append(chunk)
        else:
            runs.append([chunk])
    out: list[Segment] = []
    for index, run in enumerate(runs):
        supply = band_index == 0 and index == 0 and run[0].source == ""
        x0 = _SUPPLY_X1 if supply else run[0].x
        out.append(Segment(run[0].source, _caption(run, groups, run[0].source), x0,
                           run[-1].x + run[-1].width, supply))
    return tuple(out)


def paginate_overview(groups: Sequence[Mapping[str, Any]]) -> list[OverviewSheet]:
    """Pack the load groups into two bands per sheet; split what does not fit (§4)."""
    sheets = _link(_pack(_ordered_loads(groups)))
    return [
        OverviewSheet(
            bands=(tuple(sheet[0]), tuple(sheet[1])),
            segments=(_segments(sheet[0], 0, groups), _segments(sheet[1], 1, groups)),
        )
        for sheet in sheets
    ]


# ── Drawing ─────────────────────────────────────────────────────────────────


def _supply_block(c: pdfcanvas.Canvas, supply: Mapping[str, Any], fed_from: str | None) -> None:
    x, y0, y1 = _SUPPLY_X0, _Y_GROUP_BOT, _Y_BUS
    w = _SUPPLY_X1 - _SUPPLY_X0
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.0)
    c.setFillColor(_BLUE_TINT)
    c.rect(x, y0, w, y1 - y0, stroke=1, fill=1)
    c.setFillColor(_BLUE_DEEP)
    c.setFont(_FONT_BOLD, 7.5)
    c.drawString(x + 6, y1 - 10, "EINSPEISUNG")
    c.setFillColor(_INK)
    c.setFont(_FONT, 7)
    lines = [
        f"Netzform {_text(supply.get('system')) or '—'}   {_text(supply.get('voltage'))}",
        f"Zuleitung: {_text(supply.get('incoming')) or '—'}",
        f"Vorsicherung: {_text(supply.get('fuse')) or '—'}",
        f"Von: {_text(fed_from) or 'Hausanschluss / Netz'}",
    ]
    line_y = y1 - 20
    for line in lines:
        c.drawString(x + 6, line_y, _wrap(line, _FONT, 7, w - 12, 1)[0])
        line_y -= 8.6


def _chain_rows(chains: Sequence[Sequence[ChainLink]]) -> list[tuple[str, ChainLink | None]]:
    rows: list[tuple[str, ChainLink | None]] = []
    for chain in chains:
        rows += [("link", link) for link in chain]
        rows.append(("tail", None))
    return rows


def _chain_detail(link: ChainLink) -> str:
    parts = []
    if link.group.get("fed_by") is not None:
        parts.append("über " + _name(link.group["fed_by"]))
    feeds = link.group.get("feeds") or []
    if feeds:
        parts.append("speist " + ", ".join(_text(d.get("designation")) or _short(str(d.get("kind", ""))) for d in feeds))
    return " · ".join(parts)


_CHAIN_ROW = 9.0


def _draw_chain_rows(c: pdfcanvas.Canvas, chains: Sequence[Sequence[ChainLink]]) -> None:
    """Too many chains for plates (a cabinet with many meter places): one fitted
    row each, "Q0 SLS → Q1 HS → Sammelschiene"; what does not fit is counted."""
    width = _SUPPLY_X1 - _SUPPLY_X0
    capacity = int((_CHAIN_TOP - _CHAIN_BOTTOM) // _CHAIN_ROW)
    shown = chains if len(chains) <= capacity else chains[:capacity - 1]
    lines = [" → ".join([*(_name(link.device) for link in chain), "Sammelschiene"]) for chain in shown]
    if len(shown) < len(chains):
        lines.append(f"… {len(chains) - len(shown)} weitere Ketten: Stromlaufplan")
    c.setFillColor(_BLUE_DEEP)
    for index, line in enumerate(lines):
        text, size = fit_text(line, _FONT, width, 6.5, 6.5)
        c.setFont(_FONT, size)
        c.drawString(_SUPPLY_X0, _CHAIN_TOP - 7 - index * _CHAIN_ROW, text)


def _fits_two_columns(rows: Sequence[tuple[str, ChainLink | None]], plate_h: float, tail_h: float, gap: float) -> bool:
    """Do the plates fill at most two columns, wrapping as ``_draw_chain`` wraps?"""
    column, y = 1, _CHAIN_TOP
    for kind, _ in rows:
        needed = plate_h if kind == "link" else tail_h
        if y - needed < _CHAIN_BOTTOM:
            column, y = column + 1, _CHAIN_TOP
        y -= needed + gap
    return column <= 2


def _draw_chain(c: pdfcanvas.Canvas, chains: Sequence[Sequence[ChainLink]]) -> None:
    """The feeder heads without circuits under the supply block, top → bottom:
    as plates in up to two columns, else one row per chain (a plate in a third
    column is too narrow for "→ Sammelschiene")."""
    rows = _chain_rows(chains)
    if not rows:
        return
    plate_h, tail_h, gap = 21.0, 9.0, 5.0
    height = 0.0
    for kind, _ in rows:
        height += plate_h + gap if kind == "link" else tail_h + gap
    columns = 1 if height <= _CHAIN_TOP - _CHAIN_BOTTOM else 2
    if columns == 2 and not _fits_two_columns(rows, plate_h, tail_h, gap):
        _draw_chain_rows(c, chains)
        return
    width = (_SUPPLY_X1 - _SUPPLY_X0 - 6 * (columns - 1)) / columns
    x, y = _SUPPLY_X0, _CHAIN_TOP
    for kind, link in rows:
        needed = plate_h if kind == "link" else tail_h
        if y - needed < _CHAIN_BOTTOM:
            x, y = x + width + 6, _CHAIN_TOP
        if link is None:
            c.setFillColor(_BLUE_DEEP)
            c.setFont(_FONT, 6.5)
            c.drawString(x + 4, y - 7, "→ Sammelschiene")
            y -= tail_h + gap
            continue
        c.setStrokeColor(_BLUE_DEEP)
        c.setLineWidth(0.8)
        c.setFillColor(colors.white)
        c.rect(x, y - plate_h, width, plate_h, stroke=1, fill=1)
        head = " ".join(p for p in (_name(link.device), _text(link.device.get("rating"))) if p)
        c.setFillColor(_INK)
        c.setFont(_FONT_BOLD, 7.5)
        c.drawString(x + 4, y - 9, _wrap(head, _FONT_BOLD, 7.5, width - 8, 1)[0])
        detail = _chain_detail(link)
        if detail:
            c.setFillColor(_BLUE_DEEP)
            c.setFont(_FONT, 6.5)
            c.drawString(x + 4, y - 17.5, _wrap(detail, _FONT, 6.5, width - 8, 1)[0])
        y -= plate_h + gap


def _busbar(c: pdfcanvas.Canvas, segment: Segment, dy: float) -> None:
    y = _Y_BUS - dy
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(2.6)
    c.line(segment.x0, y, segment.x1, y)
    if segment.caption:
        c.setFont(_FONT, 6.5)
        c.setFillColor(_MUTED)
        # Right-aligned: a group's drop lands on the left part of the bar.
        c.drawRightString(segment.x1, y + 5, _wrap(segment.caption, _FONT, 6.5, segment.x1 - segment.x0, 1)[0])


def _plate(group: Mapping[str, Any]) -> str:
    pre_fuse = group.get("pre_fuse")
    if pre_fuse:
        return " ".join(p for p in (_text(pre_fuse.get("designation")), _text(pre_fuse.get("rating"))) if p) or "Si"
    if group.get("fed_by"):
        return "über " + _name(group["fed_by"])
    return ""


def _draw_plate(c: pdfcanvas.Canvas, text: str, cx: float, y_bus: float, y_top: float) -> None:
    """The Vorsicherung or the feeder on the drop line ("F0 35 A", "über Q1 HS")."""
    c.setFont(_FONT_BOLD, 6.5)
    tw = c.stringWidth(text, _FONT_BOLD, 6.5) + 6
    ym = (y_bus + y_top) / 2
    c.setFillColor(colors.white)
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(0.6)
    c.rect(cx - tw / 2, ym - 5, tw, 10, stroke=1, fill=1)
    c.setFillColor(_INK)
    c.drawCentredString(cx, ym - 2.5, text)


def _draw_head_box(c: pdfcanvas.Canvas, chunk: Chunk, dy: float) -> None:
    group, x, width = chunk.group, chunk.x, chunk.width
    top, bot = _Y_GROUP_TOP - dy, _Y_GROUP_BOT - dy
    box = group.get("box", "device" if group.get("device") is not None else "warn")
    c.setLineWidth(1.0)
    if box == "warn":
        c.setDash(3, 2)
        c.setStrokeColor(_WARN)
        c.setFillColor(colors.white)
    else:
        c.setDash()
        c.setStrokeColor(_MUTED if box == "meter" else _BLUE_DEEP)
        c.setFillColor(colors.white if box == "meter" else _BLUE_TINT)
    c.rect(x, bot, width, top - bot, stroke=1, fill=1)
    c.setDash()
    cx = x + width / 2
    forts = " (Forts.)" if chunk.start > 0 else ""
    if box in ("warn", "meter"):
        title = "OHNE FI-SCHUTZ" if box == "warn" else METER_SIDE_TEXT
        c.setFillColor(_WARN if box == "warn" else _INK)
        c.setFont(_FONT_BOLD, 7.5)
        c.drawCentredString(cx, top - 15, _wrap(title + forts, _FONT_BOLD, 7.5, width - 8, 1)[0])
        c.setFont(_FONT, 7)
        c.setFillColor(_WARN if box == "warn" else _MUTED)
        c.drawCentredString(cx, top - 26, "direkt von der Sammelschiene")
        return
    _draw_device_head(c, chunk, top, bot, forts)


def _draw_device_head(c: pdfcanvas.Canvas, chunk: Chunk, top: float, bot: float, forts: str) -> None:
    group, x, width = chunk.group, chunk.x, chunk.width
    device = group["device"]
    feeds = group.get("feeds") or []
    feeds_text = ("speist " + ", ".join(_text(d.get("designation")) or _short(str(d.get("kind", ""))) for d in feeds)
                  if feeds else "")
    head_y, detail_y = (top - 12, top - 22) if feeds_text else (top - 15, top - 26)
    draw_glyph(c, str(device.get("kind", "")), x + 18, (top + bot) / 2, _poles(device))
    c.setFillColor(_INK)
    c.setFont(_FONT_BOLD, 8)
    head = (f"{_text(device.get('designation')) or _short(str(device.get('kind', '')))}{forts}" if forts
            else _name(device))
    c.drawString(x + 34, head_y, _wrap(head, _FONT_BOLD, 8, width - 40, 1)[0])
    if feeds_text:
        c.setFont(_FONT, 6.5)
        c.setFillColor(_BLUE_DEEP)
        c.drawString(x + 34, top - 32, _wrap(feeds_text, _FONT, 6.5, width - 40, 1)[0])
    c.setFont(_FONT, 7)
    c.setFillColor(_MUTED)
    detail = " · ".join(part for part in (
        _text(device.get("rating")), f"{_poles(device)}P", _text(device.get("residual_current")),
        (f"Typ {_text(device.get('rcd_type'))}" if _text(device.get("rcd_type")) else ""),
    ) if part)
    c.drawString(x + 34, detail_y, _wrap(detail or "—", _FONT, 7, width - 40, 1)[0])


def _draw_markers(c: pdfcanvas.Canvas, chunk: Chunk, y_subbus: float) -> None:
    c.setFont(_FONT_BOLD, 6.5)
    c.setFillColor(_BLUE_DEEP)
    if chunk.prev_sheet is not None:
        c.drawString(chunk.x, y_subbus + 4, f"Forts. von Blatt {chunk.prev_sheet}")
    if chunk.next_sheet is not None:
        c.drawRightString(chunk.x + chunk.width, y_subbus + 4, f"→ Forts. Blatt {chunk.next_sheet}")


def _draw_chunk(c: pdfcanvas.Canvas, chunk: Chunk, dy: float) -> None:
    """One group (or its chunk ``start..stop``) under the busbar."""
    children: Sequence[Mapping[str, Any]] = (chunk.group.get("children") or [])[chunk.start:chunk.stop]
    y_bus, y_top, y_bot, y_sub = _Y_BUS - dy, _Y_GROUP_TOP - dy, _Y_GROUP_BOT - dy, _Y_SUBBUS - dy
    cx = chunk.x + chunk.width / 2
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.4)
    c.line(cx, y_bus, cx, y_top)
    plate = _plate(chunk.group)
    if plate:
        _draw_plate(c, plate, cx, y_bus, y_top)
    _draw_head_box(c, chunk, dy)
    if not children:
        return
    first_cx = chunk.x + _COL_W / 2
    last_cx = chunk.x + _COL_W * (len(children) - 0.5)
    left = chunk.x if chunk.prev_sheet is not None else min(first_cx, cx)
    right = chunk.x + chunk.width if chunk.next_sheet is not None else max(last_cx, cx)
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.4)
    c.line(cx, y_bot, cx, y_sub)
    c.setLineWidth(1.8)
    c.line(left, y_sub, right, y_sub)
    _draw_markers(c, chunk, y_sub)
    for index, child in enumerate(children):
        _draw_circuit(c, child, chunk.x + _COL_W * index, dy)


def _draw_circuit(c: pdfcanvas.Canvas, device: Mapping[str, Any], x: float, dy: float = 0.0) -> None:
    cx = x + _COL_W / 2
    y_dev_top, y_dev_bot, y_chip = _Y_DEV_TOP - dy, _Y_DEV_BOT - dy, _Y_CHIP - dy
    c.setStrokeColor(_BLUE_DEEP)
    c.setLineWidth(1.2)
    c.line(cx, _Y_SUBBUS - dy, cx, y_dev_top)
    box_w = _COL_W - 14
    c.setFillColor(colors.white)
    c.setLineWidth(0.9)
    c.rect(cx - box_w / 2, y_dev_bot, box_w, y_dev_top - y_dev_bot, stroke=1, fill=1)
    draw_glyph(c, str(device.get("kind", "")), cx - 14, (y_dev_top + y_dev_bot) / 2, _poles(device))
    c.setFillColor(_INK)
    c.setFont(_FONT_BOLD, 7.5)
    c.drawString(cx - 2, (y_dev_top + y_dev_bot) / 2 + 3, _text(device.get("designation"))[:6] or "—")
    c.setFont(_FONT, 7)
    c.setFillColor(_MUTED)
    # "B16 · 3P": the pole count is spelled out beside the rating as well as
    # marked on the symbol — it is the one thing a 1-pole and a 3-pole LS
    # differ in, and the box is too small for the symbol alone to carry it.
    c.drawString(cx - 2, (y_dev_top + y_dev_bot) / 2 - 7,
                 f"{_text(device.get('rating'))[:6]} · {_poles(device)}P".strip(" ·"))
    circuit = _text(device.get("circuit"))
    if circuit:
        chip_text = _wrap(circuit, _FONT_BOLD, 8, _COL_W - 20, 1)[0]
        chip_w = max(20.0, c.stringWidth(chip_text, _FONT_BOLD, 8) + 12)
        c.setFillColor(_BLUE)
        c.setStrokeColor(_BLUE)
        c.roundRect(cx - chip_w / 2, y_chip - 2, chip_w, 13, 3, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont(_FONT_BOLD, 8)
        c.drawCentredString(cx, y_chip + 2, chip_text)
    _draw_circuit_text(c, device, cx, _Y_TEXT - dy)


def _draw_circuit_text(c: pdfcanvas.Canvas, device: Mapping[str, Any], cx: float, line_y: float) -> None:
    c.setFillColor(_INK)
    c.setFont(_FONT_BOLD, 7)
    for line in _wrap(_text(device.get("label")) or "—", _FONT_BOLD, 7, _COL_W - 8, 2):
        c.drawCentredString(cx, line_y, line)
        line_y -= _LABEL_PITCH
    c.setFont(_FONT, 6.5)
    c.setFillColor(_MUTED)
    for value in (_text(device.get("room")), _text(device.get("cable")), _text(device.get("phase"))):
        if not value or value == "-":
            continue
        for line in _wrap(value, _FONT, 6.5, _COL_W - 6, 1):
            c.drawCentredString(cx, line_y, line)
            line_y -= _DETAIL_PITCH


def draw_overview_content(
    c: pdfcanvas.Canvas,
    sheet: OverviewSheet,
    *,
    supply: Mapping[str, Any],
    fed_from: str | None,
    chains: Sequence[Sequence[ChainLink]],
) -> None:
    """Everything of one Übersicht sheet inside the drawing area (no furniture)."""
    _supply_block(c, supply, fed_from)
    _draw_chain(c, chains)
    for band_index, (band, segments) in enumerate(zip(sheet.bands, sheet.segments)):
        dy = _BAND_DY * band_index
        for segment in segments:
            _busbar(c, segment, dy)
        for chunk in band:
            _draw_chunk(c, chunk, dy)
    if not sheet.bands[0] and not sheet.bands[1]:
        c.setFont(_FONT, 10)
        c.setFillColor(_MUTED)
        c.drawString(BAND_X0[0] + 10, _Y_GROUP_TOP - 20, "Noch keine Stromkreise erfasst.")
