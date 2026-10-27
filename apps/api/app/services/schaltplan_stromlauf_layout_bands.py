"""One band of a Stromlauf distribution sheet as primitives (docs/SCHALTPLAN_STROMLAUF.md §5.3).

A band holds bus segments left → right, one per source. A segment starts
with the tags (L1 L2 L3 N PE), its origin ("Zuleitung …", "von Blatt i") and,
in the source's first segment, the feeder heads in series on the bus; then
its PE feed into the PE rail, then its groups. A group is a head (stubs off
the bus taps, the device box, a sub-bus of what it switches) and columns:
taps with dots, the device, the outgoing cores in colour with the cable
rotated beside them, the terminal, chip and labels.

All offsets are measured down from the band's top (``Band.y(off)`` turns
them into page y, y up). Wires end at device boxes; the renderer draws the
poles inside. Pure: the builder is local to one call.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

from app.services.schaltplan_conductors import PHASES, UNKNOWN_PHASE
from app.services.schaltplan_pdf_style import FONT, FONT_BOLD, fit_text, text_width, wrap
from app.services.schaltplan_stromlauf_layout_routes import rounded_points
from app.services.schaltplan_stromlauf_model import Circuit, LoadGroup, Source, Supply, Unit
from app.services.panel_enclosure_geometry import round1

INK, MUTED, WARN, BLUE = "#14293d", "#6b7280", "#b45309", "#225a96"
# Offsets below the band top.
CAPTION = 7.0
BUS = {"L1": 14.0, "L2": 21.0, "L3": 28.0, "N": 35.0, "PE": 42.0}
PREFUSE = (46.0, 55.0)
HEAD = (58.0, 74.0)
SUB = {"L1": 81.0, "L2": 87.0, "L3": 93.0, "N": 99.0}
DEV = (105.0, 119.0)
UNKNOWN_TOP = 77.0  # an "L?" core starts above the sub-bus (L1 at 81)
UNKNOWN_PAST = 3.0  # and the head's phase lines run this far past it
CORE_END = 175.0
PE_RAIL = 183.0
LABELS = (193.0, 201.5, 209.5)
# The head's text column: only the first line may be 7.5 pt (the BMK); the rest are 6.5 pt.
HEAD_LINES = (49.6, 56.5, 63.4, 70.3, 77.2)
BAND_H = 212.0
# Widths.
TAG_W = 18.0
SPLIT_W = 12.0
SERIES_W = 40.0
FEED_W = 8.0
CONT_W = 14.0
GROUP_GAP = 8.0
LANE = 8.0       # the cable text's lane left of the cores
PITCH = 6.0      # core pitch in a column, stub pitch at a head
ORDER = ("L1", "L2", "L3", UNKNOWN_PHASE, "N", "PE")
SIZE = 6.5


def head_conductors(group: LoadGroup) -> tuple[str, ...]:
    """What the head switches; a group without a head takes L1 L2 L3 N straight off the bus."""
    if group.head.unit is None:
        return (*PHASES, "N")
    return group.head.unit.conductors


def head_width(group: LoadGroup) -> float:
    return PITCH * len(head_conductors(group)) + 10.0


def _resolve(conductor: str, phases: Sequence[str]) -> str:
    """Under a one-phase head every phase is that head's phase."""
    if len(phases) == 1 and conductor in (*PHASES, UNKNOWN_PHASE):
        return phases[0]
    return conductor


def head_phases(group: LoadGroup) -> tuple[str, ...]:
    return tuple(c for c in head_conductors(group) if c not in ("N", "PE"))


def column_conductors(circuit: Circuit, phases: Sequence[str]) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...]]:
    """(device conductors, outgoing conductors, column positions) with phases resolved."""
    device = tuple(_resolve(c, phases) for c in circuit.unit.conductors)
    outgoing = tuple(_resolve(c, phases) for c in circuit.outgoing.conductors)
    positions = tuple(c for c in ORDER if c in device or c in outgoing)
    return device, outgoing, positions


def column_width(circuit: Circuit, phases: Sequence[str]) -> float:
    """≤ 3 cores 48 pt, more 64 pt (§5.3)."""
    return 48.0 if len(column_conductors(circuit, phases)[2]) <= 3 else 64.0


@dataclass(frozen=True)
class Chunk:
    """Columns ``start..stop`` of a group placed at ``x``."""

    group: LoadGroup
    start: int
    stop: int
    x: float
    head_w: float
    widths: tuple[float, ...]
    prev_sheet: int | None = None
    next_sheet: int | None = None

    @property
    def width(self) -> float:
        total = self.head_w
        for width in self.widths:
            total += width
        return total if self.widths else self.head_w + 48.0


@dataclass(frozen=True)
class SegmentPlan:
    source: Source
    x0: float
    start_w: float
    chunks: tuple[Chunk, ...]
    first: bool                     # the source's first segment: series devices, its origin
    origin: str                     # text at the left of the caption line
    prev_sheet: int | None = None   # the source came from this sheet
    next_sheet: int | None = None   # the source continues on this sheet
    min_w: float = 0.0              # what the caption line needs: origin and caption side by side

    @property
    def caption(self) -> str:
        """"hinter Q1", and "→ Blatt k" when the source continues."""
        caption = self.source.caption
        if self.next_sheet is not None:
            caption = " · ".join(p for p in (caption, f"→ Blatt {self.next_sheet}") if p)
        return caption

    @property
    def x1(self) -> float:
        end = self.chunks[-1].x + self.chunks[-1].width if self.chunks else self.x0 + self.start_w
        return max(end, self.x0 + self.min_w)


@dataclass
class Builder:
    """Primitives of one sheet, in drawing order."""

    wires: list[dict[str, Any]] = field(default_factory=list)
    dots: list[list[float]] = field(default_factory=list)
    boxes: list[dict[str, Any]] = field(default_factory=list)
    texts: list[dict[str, Any]] = field(default_factory=list)
    unknown: set[str] = field(default_factory=set)

    def wire(self, conductor: str, source: str, *points: tuple[float, float], thin: bool = False) -> None:
        """An axis-aligned polyline; ``thin`` for a lead (the SABO's L1/N), stroked lighter."""
        wire: dict[str, Any] = {"conductor": conductor, "points": rounded_points(points), "source": source}
        if thin:
            wire["thin"] = True
        self.wires.append(wire)

    def dot(self, x: float, y: float) -> None:
        point = [round1(x), round1(y)]
        if point not in self.dots:
            self.dots.append(point)

    def text(self, x: float, y: float, value: str, *, w: float, size: float = SIZE, bold: bool = False,
             anchor: str = "start", colour: str = INK, angle: int = 0, chip: bool = False) -> None:
        if not value:
            return
        fitted, fitted_size = fit_text(value, FONT_BOLD if bold else FONT, w, size, min(size, SIZE))
        item = {"x": round1(x), "y": round1(y), "size": fitted_size, "text": fitted, "anchor": anchor,
                "bold": bold, "colour": colour, "angle": angle, "w": round1(w) + 0.05}
        if chip:
            item["chip"] = True
        self.texts.append(item)

    def box(self, kind: str, x0: float, y_top: float, x1: float, y_bot: float,
            poles: Sequence[Mapping[str, Any]], **extra: Any) -> None:
        self.boxes.append({"kind": kind, "x": round1(x0), "y": round1(y_bot), "w": round1(x1 - x0),
                           "h": round1(y_top - y_bot), "poles": [dict(p) for p in poles], "texts": [], **extra})


@dataclass(frozen=True)
class Band:
    top: float

    def y(self, offset: float) -> float:
        return self.top - offset


BOX_KINDS = {"rcd": "rcd", "mcb": "mcb", "rcbo": "rcbo", "fuse": "fuse", "sls": "sls", "hauptschalter": "switch",
             "contactor": "contact", "impulse": "contact", "timer": "contact", "knx_actuator": "contact",
             "wallbox": "mcb", "pv": "mcb", "sub_feed": "mcb", "distribution_block": "distribution", "spd": "spd"}


def box_kind(unit: Unit) -> str:
    return BOX_KINDS.get(unit.kind, "device")


# ── Segment start ───────────────────────────────────────────────────────────


def bus_conductors(supply: Supply) -> tuple[str, ...]:
    """The 5-line bus after the supply: L1 L2 L3 [N] PE (IT without N has no N line)."""
    incoming = supply.conductors.conductors
    has_n = "N" in incoming or "PEN" in incoming
    return (*PHASES, *(("N",) if has_n else ()), "PE")


def supply_labels(supply: Supply) -> list[tuple[str, str]]:
    """(text, colour) under the tags of the supply's first segment."""
    labels = [(supply.conductors.label, MUTED), (supply.conductors.pe_from, MUTED), (supply.conductors.warn, WARN)]
    return [(text, colour) for text, colour in labels if text]


def start_width(segment_source: Source, supply: Supply, *, first: bool, opens_supply: bool) -> float:
    width = TAG_W + FEED_W
    if opens_supply and "PEN" in supply.conductors.conductors:
        width += SPLIT_W
    if first:
        width += SERIES_W * len(segment_source.series)
    if opens_supply:  # the PE feed runs right of the labels under the tags
        width = max(width, _labels_width(supply) + 6 + FEED_W)
    return width


def _labels_width(supply: Supply) -> float:
    width = 0.0
    for text, _ in supply_labels(supply):
        width = max(width, text_width(text, FONT, SIZE))
    return width


def draw_segment_start(b: Builder, band: Band, plan: SegmentPlan, supply: Supply, x1: float) -> float:
    """Tags, origin, PEN split, series devices and the PE feed; returns the PE feed x."""
    key = plan.source.key
    x = plan.x0
    opens_supply = plan.first and plan.source.origin == "supply"
    conductors = bus_conductors(supply)
    split = opens_supply and "PEN" in supply.conductors.conductors
    tags = [c for c in conductors if not (split and c in ("N", "PE"))] + (["PEN"] if split else [])
    for conductor in tags:
        row = BUS["PE"] if conductor == "PEN" else BUS[conductor]
        b.text(x + TAG_W - 3, band.y(row) - 2.3, conductor, w=TAG_W - 2, anchor="end", colour=MUTED)
    x += TAG_W
    line_start = {c: x for c in conductors}
    if split:
        xs = x + SPLIT_W - 2
        b.wire("PEN", key, (x, band.y(BUS["PE"])), (xs, band.y(BUS["PE"])))
        b.wire("N", key, (xs, band.y(BUS["PE"])), (xs, band.y(BUS["N"])), (x1, band.y(BUS["N"])))
        b.dot(xs, band.y(BUS["PE"]))
        line_start = {**line_start, "PE": xs}
        line_start.pop("N", None)
        x += SPLIT_W
    if opens_supply:
        for index, (text, colour) in enumerate(supply_labels(supply)):
            b.text(plan.x0, band.y(66.0 + 7.4 * index), text, w=_labels_width(supply) + 0.1, colour=colour)
    if plan.first:
        x = _draw_series(b, band, plan.source, x, line_start, conductors)
    for conductor, start in line_start.items():
        b.wire(conductor, key, (start, band.y(BUS[conductor])), (x1, band.y(BUS[conductor])))
    return max(x + 4, plan.x0 + _labels_width(supply) + 6) if opens_supply else x + 4


def _draw_series(b: Builder, band: Band, source: Source, x: float, line_start: dict[str, float],
                 conductors: Sequence[str]) -> float:
    """The feeder heads without circuits in series on the bus (SLS → HS → VB)."""
    for unit in source.series:
        switched = [c for c in unit.conductors if c in conductors and c != "PE"] or list(PHASES)
        bx0, bx1 = x + SERIES_W / 2 - 8, x + SERIES_W / 2 + 8
        top, bottom = BUS[switched[0]] - 4, BUS[switched[-1]] + 4
        for conductor in switched:
            b.wire(conductor, source.key, (line_start[conductor], band.y(BUS[conductor])), (bx0, band.y(BUS[conductor])))
            line_start[conductor] = bx1
        poles = [{"y": round1(band.y(BUS[c])), "conductor": c, "symbol": "contact"} for c in switched]
        b.box(box_kind(unit), bx0, band.y(top), bx1, band.y(bottom), poles, series=True, label=unit.short)
        b.text(x + SERIES_W / 2, band.y(HEAD_LINES[0]), unit.name, w=SERIES_W - 2, bold=True, size=7.5,
               anchor="middle")
        b.text(x + SERIES_W / 2, band.y(HEAD_LINES[1]), unit.rating, w=SERIES_W - 2, anchor="middle", colour=MUTED)
        x += SERIES_W
    return x


# ── Groups ──────────────────────────────────────────────────────────────────


def _row(conductor: str) -> float:
    return SUB.get(conductor, SUB["L1"])


def _sub_rows(group: LoadGroup, bus: Sequence[str]) -> tuple[str, ...]:
    """The sub-bus lines under a head: what it switches, plus N from the main N when it does not."""
    switched = head_conductors(group)
    return (*switched, *(("N",) if "N" not in switched and "N" in bus else ()))


def _positions(circuit: Circuit, x: float, phases: Sequence[str]) -> dict[str, float]:
    return {c: x + LANE + PITCH * i for i, c in enumerate(column_conductors(circuit, phases)[2])}


def _taps(circuit: Circuit, x: float, phases: Sequence[str], rows: Sequence[str]) -> dict[str, float]:
    """The sub-bus lines a column taps, with the tap x."""
    device, outgoing, _ = column_conductors(circuit, phases)
    return {c: px for c, px in _positions(circuit, x, phases).items()
            if c in rows and (c in device or (c == "N" and c in outgoing))}


def draw_chunk(b: Builder, band: Band, chunk: Chunk, bus: Sequence[str], pe_taps: list[float]) -> None:
    """A group (or its continuation) and its columns; appends every PE tap x to ``pe_taps``."""
    group = chunk.group
    phases = head_phases(group)
    rows = _sub_rows(group, bus)
    columns: list[tuple[Circuit, float, float]] = []
    x = chunk.x + chunk.head_w
    for circuit, width in zip(group.circuits[chunk.start:chunk.stop], chunk.widths):
        columns.append((circuit, x, width))
        x += width
    right: dict[str, float] = {}
    for circuit, cx, _width in columns:
        for conductor, px in _taps(circuit, cx, phases, rows).items():
            right[conductor] = max(right.get(conductor, px), px)
        # An "L?" core takes one of the head's phases, nobody said which: every phase line runs on
        # just past it, so the core crosses them (hops) instead of ending a T on one of them.
        unknown = _positions(circuit, cx, phases).get(UNKNOWN_PHASE)
        if unknown is not None:
            for conductor in (c for c in rows if c in PHASES):
                right[conductor] = max(right.get(conductor, unknown + UNKNOWN_PAST), unknown + UNKNOWN_PAST)
    if chunk.next_sheet is not None:  # every line a later chunk still taps runs to the edge
        later = {c for circuit in group.circuits[chunk.stop:] for c in _taps(circuit, 0.0, phases, rows)}
        right = {**right, **{c: chunk.x + chunk.width for c in later}}
    if chunk.start == 0:
        _draw_head(b, band, chunk, bus, rows, right)
    else:
        for conductor in (c for c in rows if c in right):
            b.wire(conductor, group.source, (chunk.x + 2, band.y(_row(conductor))),
                   (right[conductor], band.y(_row(conductor))))
    for circuit, cx, width in columns:
        _draw_column(b, band, circuit, cx, width, phases, rows, group.source, pe_taps)
    _head_texts(b, band, chunk)


def _draw_head(b: Builder, band: Band, chunk: Chunk, bus: Sequence[str], rows: Sequence[str],
               right: Mapping[str, float]) -> None:
    """Stubs off the bus taps through the (pre-fuse and) head box into the sub-bus.
    ``right``: how far each sub-bus line runs; a pole nothing uses ends under the box."""
    group, hx = chunk.group, chunk.x
    unit, source = group.head.unit, group.source
    switched = head_conductors(group)
    xs = {c: hx + 8 + PITCH * i for i, c in enumerate(switched)}
    top = PREFUSE[0] if group.head.pre_fuse is not None else HEAD[0]
    for conductor, sx in xs.items():
        used = conductor in right
        if unit is None and not used:
            continue
        tapped = conductor in bus
        start = band.y(BUS[conductor]) if tapped else band.y(PREFUSE[0] - 2)
        if tapped:
            b.dot(sx, start)
        row = band.y(_row(conductor))
        if unit is None:
            b.wire(conductor, source, (sx, start), (sx, row), (right[conductor], row))
            continue
        b.wire(conductor, source, (sx, start), (sx, band.y(top)))
        if group.head.pre_fuse is not None:
            b.wire(conductor, source, (sx, band.y(PREFUSE[1])), (sx, band.y(HEAD[0])))
        if used:
            b.wire(conductor, source, (sx, band.y(HEAD[1])), (sx, row), (right[conductor], row))
        else:
            b.wire(conductor, source, (sx, band.y(HEAD[1])), (sx, band.y(HEAD[1] + 3)))
    if "N" in rows and "N" not in switched and "N" in right:
        nx = hx + 3
        b.dot(nx, band.y(BUS["N"]))
        b.wire("N", source, (nx, band.y(BUS["N"])), (nx, band.y(SUB["N"])), (right["N"], band.y(SUB["N"])))
    if unit is None:
        return
    x0, x1 = hx + 5, hx + 8 + PITCH * (len(switched) - 1) + 3
    poles = [{"x": round1(sx), "conductor": c} for c, sx in xs.items()]
    if group.head.pre_fuse is not None:
        b.box("fuse", x0, band.y(PREFUSE[0]), x1, band.y(PREFUSE[1]), poles)
    b.box(box_kind(unit), x0, band.y(HEAD[0]), x1, band.y(HEAD[1]), poles)


def _draw_spd_column(b: Builder, band: Band, circuit: Circuit, x: float, width: float, phases: Sequence[str],
                     rows: Sequence[str], source: str, pe_taps: list[float]) -> None:
    """An SPD: taps the group's lines, its box spans them and PE; PE drops to the PE rail, no cable."""
    device, _outgoing, _ = column_conductors(circuit, phases)
    at = _positions(circuit, x, phases)
    for conductor in device:
        px = at[conductor]
        if conductor in rows:
            b.dot(px, band.y(_row(conductor)))
            b.wire(conductor, source, (px, band.y(_row(conductor))), (px, band.y(DEV[0])))
        else:
            b.unknown.add(circuit.unit.id)
            b.wire(conductor, source, (px, band.y(DEV[0] - 4)), (px, band.y(DEV[0])))
    pe = at["PE"]
    b.dot(pe, band.y(PE_RAIL))
    pe_taps.append(pe)
    b.wire("PE", source, (pe, band.y(DEV[1])), (pe, band.y(PE_RAIL)))
    poles = [{"x": round1(at[c]), "conductor": c} for c in device]
    b.box("spd", min(at[c] for c in device) - 3, band.y(DEV[0]), pe + 3, band.y(DEV[1]), poles, device="spd")
    _column_texts(b, band, circuit, x, width, max(at.values()))


def _draw_column(b: Builder, band: Band, circuit: Circuit, x: float, width: float, phases: Sequence[str],
                 rows: Sequence[str], source: str, pe_taps: list[float]) -> None:
    if circuit.unit.kind == "spd":
        _draw_spd_column(b, band, circuit, x, width, phases, rows, source, pe_taps)
        return
    device, outgoing, _ = column_conductors(circuit, phases)
    at = _positions(circuit, x, phases)
    for conductor in device:
        px = at[conductor]
        if conductor in rows:
            b.dot(px, band.y(_row(conductor)))
            b.wire(conductor, source, (px, band.y(_row(conductor))), (px, band.y(DEV[0])))
        else:  # "L?": down from above the sub-bus, crossing it (hops, no dot): the path shows, no phase is claimed
            b.unknown.add(circuit.unit.id)
            b.wire(conductor, source, (px, band.y(UNKNOWN_TOP)), (px, band.y(DEV[0])))
        if conductor in outgoing:
            b.wire(conductor, source, (px, band.y(DEV[1])), (px, band.y(CORE_END)))
    for conductor in (c for c in outgoing if c not in device):
        px = at[conductor]
        if conductor == "PE":
            b.dot(px, band.y(PE_RAIL))
            pe_taps.append(px)
            b.wire("PE", source, (px, band.y(PE_RAIL)), (px, band.y(CORE_END)))
        elif conductor == "N" and "N" in rows:
            b.dot(px, band.y(SUB["N"]))
            b.wire("N", source, (px, band.y(SUB["N"])), (px, band.y(CORE_END)))
        else:  # a core the device does not feed: a spare end
            b.wire(conductor, source, (px, band.y(CORE_END - 10)), (px, band.y(CORE_END)))
    if UNKNOWN_PHASE in device or UNKNOWN_PHASE in outgoing:
        b.unknown.add(circuit.unit.id)
    xs = [at[c] for c in device]
    poles = [{"x": round1(at[c]), "conductor": c} for c in device]
    b.box(box_kind(circuit.unit), min(xs) - 3, band.y(DEV[0]), max(xs) + 3, band.y(DEV[1]), poles,
          device=circuit.unit.kind)
    if circuit.terminal:
        for conductor in outgoing:
            b.box("terminal", at[conductor] - 1.8, band.y(CORE_END - 1.8), at[conductor] + 1.8,
                  band.y(CORE_END + 1.8), [], conductor=conductor)
    _column_texts(b, band, circuit, x, width, max(at.values()))


def _label_lines(label: str, width: float) -> tuple[list[str], float]:
    """The circuit label in two lines at 7 pt — or at 6.5 pt when 7 pt has to cut a
    word ("Wärmepumpe" in a 48 pt column); what does not fit 6.5 pt either is cut."""
    lines = wrap(label, FONT_BOLD, 7.0, width, 2)
    if not any(line.endswith("…") for line in lines):
        return lines, 7.0
    return wrap(label, FONT_BOLD, SIZE, width, 2), SIZE


def _column_texts(b: Builder, band: Band, circuit: Circuit, x: float, width: float, last_core: float) -> None:
    xr = last_core + 5
    wr = x + width - 1.5 - xr
    unit = circuit.unit
    b.text(xr, band.y(111.0), unit.designation or "—", w=wr, bold=True, size=7.5)
    b.text(xr, band.y(118.5), unit.rating or unit.short, w=wr, colour=MUTED)
    b.text(xr + 2.5, band.y(129.0), circuit.circuit, w=wr - 5, bold=True, size=7.0, colour="#ffffff", chip=True)
    note_y = 141.0
    if circuit.rcd:  # an RCBO's own IΔn and type, two short lines: one fitted line would be cut
        residual, _, kind = circuit.rcd.partition(" · ")
        b.text(xr, band.y(141.0), residual.removeprefix("IΔn "), w=wr, colour=MUTED)
        b.text(xr, band.y(148.0), kind, w=wr, colour=MUTED)
        note_y = 155.0
    b.text(xr, band.y(note_y), circuit.outgoing.note, w=wr, colour=MUTED)
    b.text(xr, band.y(172.5), circuit.terminal, w=wr, bold=True)
    b.text(x + 5.5, band.y(173.5), circuit.outgoing.text, w=CORE_END - DEV[1] - 1.5,
           colour=MUTED if circuit.outgoing.text != "Leitung —" else WARN, angle=90)
    cx = x + width / 2
    lines, size = _label_lines(circuit.label or "—", width - 4)
    for offset, line in zip(LABELS, lines):
        b.text(cx, band.y(offset), line, w=width - 4, bold=True, size=size, anchor="middle")
    # On a cabinet board a circuit above the meter says where it sits ("AAR Feld 1"), first: a cut drops the room.
    place = " · ".join(p for p in (circuit.location, circuit.room) if p)
    b.text(cx, band.y(LABELS[2]), place, w=width - 4, anchor="middle", colour=MUTED)


def _head_lines(chunk: Chunk, w: float) -> list[tuple[str, bool, str]]:
    """(text, bold, colour) of the head's text column, top → bottom; a bold first
    line is the BMK at 7.5 pt, every other line 6.5 pt."""
    head, unit = chunk.group.head, chunk.group.head.unit
    unprotected = [c.unit.bmk for c in chunk.group.circuits if not c.protected and c.unit.kind != "spd"]
    if chunk.start > 0:
        if unit is not None:
            return [(f"{unit.designation or unit.short} (Forts.)", True, INK),
                    (f"Forts. von Blatt {chunk.prev_sheet}", True, BLUE)]
        name = "OHNE FI-SCHUTZ (Forts.)" if unprotected else "FI/LS je Stromkreis (Forts.)"
        return [(name, True, WARN if unprotected else INK), (f"Forts. von Blatt {chunk.prev_sheet}", True, BLUE)]
    if unit is None:
        return _headless_lines(chunk, unprotected, w)
    lines: list[tuple[str, bool, str]] = [(unit.name, True, INK)]
    lines.append((" · ".join(p for p in (unit.rating, f"{unit.poles}P") if p), False, MUTED))
    if head.rcd_text:
        if text_width(head.rcd_text, FONT, SIZE) <= w:
            lines.append((head.rcd_text, False, MUTED))
        else:
            lines += [(part, False, MUTED) for part in head.rcd_text.split(" · ")]
    if head.pre_fuse is not None:
        lines.append((" ".join(p for p in (head.pre_fuse.designation, head.pre_fuse.rating) if p) or "Si", False, MUTED))
    if head.feeds:
        lines.append((head.feeds, False, BLUE))
    return lines


def _headless_lines(chunk: Chunk, unprotected: Sequence[str], w: float) -> list[tuple[str, bool, str]]:
    """No head: RCBOs only → "FI/LS je Stromkreis"; any other circuit → the warning, naming
    those circuits when some RCBOs have their own RCD."""
    loads = [c for c in chunk.group.circuits if c.unit.kind != "spd"]
    if not loads:
        return [("Überspannungsschutz", True, INK), ("direkt von der Sammelschiene", False, MUTED)]
    if not unprotected:
        return [("FI/LS je Stromkreis", True, INK), ("direkt von der Sammelschiene", False, MUTED)]
    named = [("ohne FI: " + ", ".join(unprotected), False, WARN)] if len(unprotected) < len(loads) else []
    if text_width("OHNE FI-SCHUTZ", FONT_BOLD, 7.5) <= w:
        return [("OHNE FI-SCHUTZ", True, WARN), ("direkt von der Sammelschiene", False, WARN), *named]
    return [("", True, WARN), ("OHNE", True, WARN), ("FI-SCHUTZ", True, WARN), *named]


def _head_texts(b: Builder, band: Band, chunk: Chunk) -> None:
    x = chunk.x + (2.0 if chunk.start > 0 else chunk.head_w + 2)
    w = chunk.x + chunk.width - 2 - x
    lines = _head_lines(chunk, w)[: 4 if chunk.next_sheet is not None else 5]
    for index, (offset, (text, bold, colour)) in enumerate(zip(HEAD_LINES, lines)):
        b.text(x, band.y(offset), text, w=w, bold=bold, size=7.5 if index == 0 else SIZE, colour=colour)
    if chunk.next_sheet is not None:
        b.text(chunk.x + chunk.width - 2, band.y(HEAD_LINES[4]), f"→ Forts. Blatt {chunk.next_sheet}",
               w=chunk.width - 4 - (chunk.head_w if chunk.start == 0 else 0), bold=True, anchor="end", colour=BLUE)
