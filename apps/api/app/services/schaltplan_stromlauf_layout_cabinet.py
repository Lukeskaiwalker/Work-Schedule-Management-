"""The Stromlaufplan's cabinet sheet "Einspeisung & Zählerplatz" (docs/SCHALTPLAN_STROMLAUF.md §5.3).

* The **NAR bus** is vertical at the left (x 60..88, L1 L2 L3 N PE at 7 pt,
  L1 L2 L3 PEN above a 4-core TN-C-S split), the supply caption above it and
  the infeed part in a box at its top. One segment per ``main`` busbar zone:
  joined ones meet at a ZZ55SAVE box, every further run is broken off and
  starts at an infeed box of its own. Part tags read bottom → top left of
  the bus; a segment without a lane is a 48 pt stub with its name.
* Each **meter place** is a 96 pt horizontal lane (``_lane``) in fixed
  columns, so lanes line up. The bus ends at each conductor's last tap (a
  corner, no dot) unless it goes on.
* ≤ 4 lanes per sheet; more continue on the next sheet with the paired
  markers "→ Forts. Blatt k" / "Forts. von Blatt i". The "Steuerung &
  Kommunikation" band (``_control``) sits under the last lane of the
  carrier's sheet.

Pure; the layout's ``_cabinet_*`` hooks call ``cabinet_sheet_count``,
``cabinet_origins`` and ``cabinet_sheets``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from app.services.panel_enclosure_geometry import round1
from app.services.schaltplan_pdf_style import FONT, text_width
from app.services.schaltplan_stromlauf_cabinet import CabinetSection, Lane, NarSegment
from app.services.schaltplan_pdf_style import FONT_BOLD
from app.services.schaltplan_stromlauf_layout_bands import BLUE, MUTED, SIZE, WARN, Builder, bus_conductors, supply_labels
from app.services.schaltplan_stromlauf_layout_cabinet_lane import (
    BUS_DX,
    KIT,
    ROWS,
    SLS,
    SOURCE,
    draw_lane,
)
from app.services.schaltplan_stromlauf_layout_control import BAND_H, band_needed, draw_control_band
from app.services.schaltplan_stromlauf_layout_routes import crossings
from app.services.schaltplan_stromlauf_types import StromlaufModel

CABINET_TITLE = "Stromlaufplan allpolig · Einspeisung & Zählerplatz"
LANE_H, STUB_H, MARKER_H = 96.0, 48.0, 12.0
HEAD_H = 42.0                     # caption, labels and tags above the first item
BOX_LOW, BOX_HIGH = 12.0, 20.0    # an infeed/joint box, this far above the top of the item it opens
SPLIT = 6.0                       # the PEN split, above the first item's top
BLOCK_X = 392.0                   # the §14a block: right of the Trennvorrichtung column
#: The NAR's own distribution: circuits whose FI names no feeder ("Eingespeist von" not set).
NAR_XREF = "→ Verteilung ohne Zähler Blatt "
XREF_PREFIXES = ("→ Forts. Blatt ", "Forts. von Blatt ", "→ Sammelschiene Blatt ", NAR_XREF)


@dataclass(frozen=True)
class Item:
    index: int                    # place in the whole cabinet, top → bottom
    kind: str                     # "lane" | "stub"
    segment: int
    first: bool                   # the segment's first item
    last: bool                    # the segment's last item
    lane: Lane | None = None

    @property
    def height(self) -> float:
        return LANE_H if self.kind == "lane" else STUB_H


def cabinet_items(section: CabinetSection) -> list[Item]:
    """Segments top → bottom; per segment its lanes, or a stub when it has none."""
    items: list[Item] = []
    for segment in range(max(1, len(section.segments))):
        lanes: list[Lane | None] = [lane for lane in section.lanes if lane.segment == segment]
        members = lanes or [None]
        for position, lane in enumerate(members):
            items.append(Item(len(items), "lane" if lane is not None else "stub", segment, position == 0,
                              position == len(members) - 1, lane))
    return items


def _band_index(items: Sequence[Item], section: CabinetSection) -> int | None:
    """The item whose sheet carries the band: the carrier lane, else the last item."""
    if not band_needed(section):
        return None
    found = next((item.index for item in items if item.lane is not None and item.lane.carrier), None)
    return found if found is not None else len(items) - 1


def paginate_cabinet(section: CabinetSection, y0: float, y1: float) -> list[tuple[Item, ...]]:
    """Greedy: an item joins the sheet while it, the band (on the carrier's
    sheet) and a continuation marker (unless it is the last) still fit."""
    items = cabinet_items(section)
    band_at = _band_index(items, section)
    avail = y1 - HEAD_H - y0
    pages: list[tuple[Item, ...]] = []
    current: list[Item] = []
    used, has_band = 0.0, False
    for item in items:
        band = has_band or item.index == band_at
        marker = MARKER_H if item.index < len(items) - 1 else 0.0
        if current and used + item.height + (BAND_H if band else 0.0) + marker > avail:
            pages.append(tuple(current))
            current, used, band = [], 0.0, item.index == band_at
        current.append(item)
        used += item.height
        has_band = band
    pages.append(tuple(current))
    return pages


# ── Cross-references ────────────────────────────────────────────────────────


def origins_for(model: StromlaufModel, pages: Sequence[Sequence[Item]], first: int) -> dict[str, str]:
    """Source key → "von Blatt c" (its lane's sheet) or "von Einspeisung · Blatt c" (the NAR)."""
    sheets = {item.lane.key: first + n for n, page in enumerate(pages) for item in page if item.lane is not None}
    out: dict[str, str] = {}
    for source in model.sources:
        if source.origin.startswith("cabinet:"):
            lane = source.origin.removeprefix("cabinet:")
            out[source.key] = f"von Blatt {sheets[lane]}" if lane in sheets else f"von Einspeisung · Blatt {first}"
    return out


def fields_text(fields: Sequence[int]) -> str:
    """0-based fields → "Feld 2", "Feld 2–3", "Feld 1, 3"."""
    numbers = sorted({f + 1 for f in fields})
    if len(numbers) > 1 and numbers == list(range(numbers[0], numbers[-1] + 1)):
        return f"Feld {numbers[0]}–{numbers[-1]}"
    return "Feld " + ", ".join(str(n) for n in numbers) if numbers else ""


def nar_sheet(model: StromlaufModel, source_sheets: Mapping[str, int]) -> int | None:
    """The first sheet of a distribution fed straight off the NAR (origin ``cabinet:``), or None."""
    sheets = sorted(source_sheets[s.key] for s in model.sources if s.origin == "cabinet:" and s.key in source_sheets)
    return sheets[0] if sheets else None


def lane_links(model: StromlaufModel, source_sheets: Mapping[str, int]) -> dict[str, tuple[str, str]]:
    """Lane key → ("→ Sammelschiene Blatt k", "→ Feld …"), from the sources behind the lane."""
    cabinet: CabinetSection = model.cabinet
    out: dict[str, tuple[str, str]] = {}
    for lane in cabinet.lanes:
        keys = {s.key for s in model.sources if s.origin == f"cabinet:{lane.key}"}
        sheets = sorted(source_sheets[k] for k in keys if k in source_sheets)
        ids = [g.head.unit.id for g in model.groups if g.source in keys and g.head.unit is not None]
        ids += [c.unit.id for g in model.groups if g.source in keys for c in g.circuits]
        fields = fields_text([cabinet.fields[i] for i in ids if i in cabinet.fields])
        out[lane.key] = (f"→ Sammelschiene Blatt {sheets[0]}" if sheets else "", f"→ {fields}" if fields else "")
    return out


# ── The bus ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Page:
    x0: float
    x1: float
    top: float                     # the frame's top
    number: int                    # the sheet number
    index: int                     # 0-based among the cabinet sheets
    last: bool
    items: tuple[Item, ...]
    tops: tuple[float, ...]

    @property
    def bus_top(self) -> float:
        """The tags' foot: a segment that goes on from the last sheet starts here."""
        return self.top - HEAD_H + BOX_HIGH

    @property
    def bottom(self) -> float:
        return self.tops[-1] - self.items[-1].height

    def bx(self, conductor: str) -> float:
        return self.x0 + BUS_DX[conductor]


def _part_box(b: Builder, page: _Page, kind: str, conductors: Sequence[str], top: float, label: str) -> None:
    """An infeed/joint box across the bus above ``top``; its tag left of the bus, bottom → top."""
    xs = [page.bx(c) for c in conductors]
    poles = [{"x": round1(x), "conductor": c} for x, c in zip(xs, conductors)]
    b.box(kind, min(xs) - 4, top + BOX_HIGH, max(xs) + 4, top + BOX_LOW, poles)
    width = text_width(label, FONT, SIZE)
    b.text(page.x0 + 12.5, top + (BOX_LOW + BOX_HIGH) / 2 - width / 2, label, w=width + 0.1, angle=90)


def _segment_top(b: Builder, page: _Page, section: CabinetSection, model: StromlaufModel, item: Item,
                 top: float) -> dict[str, float]:
    """Where each conductor of a segment starts; draws its infeed or joint box (and the PEN split)."""
    conductors = bus_conductors(model.supply)
    if not item.first:
        return {c: page.bus_top for c in conductors}
    segment = section.segments[item.segment] if item.segment < len(section.segments) else None
    if segment is not None and segment.joint:
        _part_box(b, page, "joint", conductors, top, section.joint_label)
        return {c: top + BOX_LOW for c in conductors}
    incoming = model.supply.conductors.conductors
    pen = item.index == 0 and section.pen_split and "PEN" in incoming
    fed = list(incoming) if pen else [c for c in conductors if c in incoming] or list(conductors)
    infeed = segment.infeed if segment is not None else ""
    if infeed:
        _part_box(b, page, "infeed", fed, top, infeed)
    if top + BOX_HIGH < page.bus_top - 0.05:  # a further run: its own short feed into the box
        for c in fed:
            b.wire(c, SOURCE, (page.bx(c), top + BOX_HIGH + 8), (page.bx(c), top + BOX_HIGH))
    below = top + (BOX_LOW if infeed else BOX_HIGH)
    starts = {c: (below if c in fed else top + BOX_HIGH) for c in conductors}
    if pen:
        split = top + SPLIT
        b.wire("PEN", SOURCE, (page.bx("PEN"), below), (page.bx("PEN"), split), (page.bx("N"), split))
        b.dot(page.bx("PE"), split)
        b.text(page.x0 + KIT[0], split - 2.3, "PEN-Aufteilung im NAR", w=KIT[1] + SLS[1], colour=MUTED)
        starts = {**starts, "N": split, "PE": split}
    return starts


def _segment_bottom(page: _Page, section: CabinetSection, model: StromlaufModel, local: int) -> dict[str, float]:
    """To the next joint box; to the sheet's foot when the bus goes on below it; else to each conductor's last tap."""
    conductors = bus_conductors(model.supply)
    item = page.items[local]
    bottom = page.tops[local] - item.height
    following = page.items[local + 1] if local + 1 < len(page.items) else None
    later = section.segments[item.segment + 1] if item.last and item.segment + 1 < len(section.segments) else None
    joined_below = later is not None and later.joint
    if following is not None and joined_below:
        return {c: page.tops[local + 1] + BOX_HIGH for c in conductors}
    if following is None and not page.last and (not item.last or joined_below):
        return {c: bottom for c in conductors}
    if item.lane is None:
        return {c: page.tops[local] - STUB_H / 2 - 4 for c in conductors}
    return {c: page.tops[local] - ROWS[c] for c in conductors}


def _draw_bus(b: Builder, page: _Page, section: CabinetSection, model: StromlaufModel) -> set[tuple[float, float]]:
    """Every segment on the page; returns the corners (where the bus ends at a lane's tap: no dot)."""
    corners: set[tuple[float, float]] = set()
    start_local = 0
    for local, item in enumerate(page.items):
        following = page.items[local + 1] if local + 1 < len(page.items) else None
        if following is not None and following.segment == item.segment:
            continue
        starts = _segment_top(b, page, section, model, page.items[start_local], page.tops[start_local])
        ends = _segment_bottom(page, section, model, local)
        for c, start in starts.items():
            if start - ends[c] > 0.05:
                b.wire(c, SOURCE, (page.bx(c), start), (page.bx(c), ends[c]))
                corners.add((round1(page.bx(c)), round1(ends[c])))
        start_local = local + 1
    return corners


def _draw_header(b: Builder, page: _Page, section: CabinetSection, model: StromlaufModel, nar: int | None) -> None:
    x = page.x0 + KIT[0]
    if page.index == 0:
        xref = f"{NAR_XREF}{nar}" if nar is not None else ""
        xref_w = text_width(xref, FONT_BOLD, SIZE) + 0.1 if xref else 0.0
        b.text(x, page.top - 7.0, model.supply.caption, w=page.x1 - x - (xref_w + 12 if xref else 0), bold=True, size=7.5)
        # Paired with the distribution's "von Einspeisung · Blatt {this}": an FI without feeder hangs off the NAR.
        b.text(page.x1, page.top - 7.0, xref, w=xref_w, bold=True, anchor="end", colour=WARN)
        for text, colour in supply_labels(model.supply):
            if text != "PEN-Aufteilung im NAR":
                width = text_width(text, FONT, SIZE)
                b.text(x, page.top - 17.0, text, w=width + 0.1, colour=colour)
                x += width + 10
    else:
        b.text(x, page.top - 7.0, f"Forts. von Blatt {page.number - 1}", w=page.x1 - x, bold=True, colour=BLUE)
    tags = list(bus_conductors(model.supply))
    if page.index == 0 and section.pen_split and "PEN" in model.supply.conductors.conductors:
        tags = [c for c in tags if c not in ("N", "PE")] + ["PEN"]
    for c in tags:
        b.text(page.bx(c) + 1.75, page.bus_top + 1.5, c, w=14.0, angle=90, colour=MUTED)


def _stub(b: Builder, page: _Page, segment: NarSegment | None, top: float) -> None:
    label = segment.label if segment is not None else "Hauptleitung"
    b.text(page.x0 + KIT[0], top - 20.0, label, w=page.x0 + BLOCK_X - page.x0 - KIT[0], colour=MUTED)


def _sheet(model: StromlaufModel, frame: Any, pages: Sequence[Sequence[Item]], index: int,
           links: Mapping[str, tuple[str, str]], nar: int | None) -> dict[str, Any]:
    items = tuple(pages[index])
    top = frame.y1 - HEAD_H
    tops: list[float] = []
    for item in items:
        tops.append(top)
        top -= item.height
    section: CabinetSection = model.cabinet
    page = _Page(frame.x0, frame.x1, frame.y1, frame.first_sheet + index, index, index == len(pages) - 1, items,
                 tuple(tops))
    b = Builder()
    _draw_header(b, page, section, model, nar)
    corners = _draw_bus(b, page, section, model)
    for item, item_top in zip(items, tops):
        if item.lane is not None:
            draw_lane(b, page.x0, item.lane, item_top, bus_conductors(model.supply), corners, links[item.lane.key],
                      section, unlinked=nar is not None)
        else:
            _stub(b, page, section.segments[item.segment] if item.segment < len(section.segments) else None, item_top)
    band_at = _band_index(cabinet_items(section), section)
    if band_at is not None and any(item.index == band_at for item in items):
        draw_control_band(b, section, page.bottom, page.x0, page.x0 + BLOCK_X, page.x1)
    if not page.last:
        b.text(page.x0, page.bottom - 9.0, f"→ Forts. Blatt {page.number + 1}", w=54.0, bold=True, colour=BLUE)
    xrefs = [{"text": t["text"], "sheet": int(t["text"].rsplit(" ", 1)[1])} for t in b.texts
             if t["text"].startswith(XREF_PREFIXES) and t["text"].rsplit(" ", 1)[1].isdigit()]
    return {"kind": "cabinet", "title": CABINET_TITLE, "number": page.number, "wires": b.wires,
            "dots": sorted(b.dots), "hops": [{"x": x, "y": y} for x, y in crossings(b.wires)], "boxes": b.boxes,
            "texts": b.texts, "xrefs": xrefs, "note": ""}


# ── The hooks ───────────────────────────────────────────────────────────────


def cabinet_pages(model: StromlaufModel, frame: Any) -> list[tuple[Item, ...]]:
    return paginate_cabinet(model.cabinet, frame.y0, frame.y1) if model.cabinet is not None else []


def cabinet_sheet_count(model: StromlaufModel, frame: Any) -> int:
    return len(cabinet_pages(model, frame))


def cabinet_origins(model: StromlaufModel, frame: Any) -> dict[str, str]:
    pages = cabinet_pages(model, frame)
    return origins_for(model, pages, frame.first_sheet) if pages else {}


def cabinet_sheets(model: StromlaufModel, frame: Any, source_sheets: Mapping[str, int]) -> list[dict[str, Any]]:
    """The "Einspeisung & Zählerplatz" sheets, numbered from ``frame.first_sheet``."""
    pages = cabinet_pages(model, frame)
    if not pages:
        return []
    links = lane_links(model, source_sheets)
    nar = nar_sheet(model, source_sheets)
    return [_sheet(model, frame, pages, index, links, nar) for index in range(len(pages))]
