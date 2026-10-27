"""One meter place of the cabinet sheet as a horizontal lane (docs/SCHALTPLAN_STROMLAUF.md §5.3).

Fixed columns (pt right of the frame's left edge), so lanes line up:

    bus 20..48 | kit 56..176 | SLS 176..232 | Zähler 232..328 | Trennvorrichtung 328..384 | HLAK 384..432 | xref 432..

Tap dots on the NAR segment → (carrier lane only) the supply-kit tap: a SABO
(or the existing tap) hanging under the lane off L1 and N, its thin leads
"→ RfZ Feld n" / "→ APZ Feld m" with the meter-side devices that hang off
them, labelled "{ZY…} · SABO 1,6 A" → the SLS over L1–L3 → the meter box
(eHZ / 3-Punkt over L1–L3 and N; number, label or "frei") → the
Trennvorrichtung → the HLAK (junction dots at its outputs) → "→ Sammelschiene
Blatt k" and "→ Feld …". A missing SLS or Trennvorrichtung is a dashed
placeholder with the lines through it and a WARN text — never a guess. PE
runs straight to the HLAK and never through a switching device.

Offsets are measured down from the lane's top (y up on the page). Pure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence

from app.services.panel_enclosure_geometry import round1
from app.services.schaltplan_conductors import PHASES
from app.services.schaltplan_stromlauf_cabinet import CabinetSection, Lane
from app.services.schaltplan_pdf_style import FONT_BOLD, text_width
from app.services.schaltplan_stromlauf_layout_bands import BLUE, INK, MUTED, SIZE, WARN, Builder
from app.services.schaltplan_stromlauf_types import Unit

SOURCE = "cabinet"
BUS_DX: Mapping[str, float] = {"L1": 20.0, "L2": 27.0, "L3": 34.0, "N": 41.0, "PE": 48.0, "PEN": 48.0}
ROWS: Mapping[str, float] = {"L1": 18.0, "L2": 25.0, "L3": 32.0, "N": 39.0, "PE": 46.0}
KIT, SLS, METER, SWITCH, HLAK = (56.0, 120.0), (176.0, 56.0), (232.0, 96.0), (328.0, 56.0), (384.0, 48.0)
LINE_END, XREF = 426.0, 432.0
TEXT_LINES = (58.0, 65.5, 73.0)
NOTE_LINE = 88.0
SPD_LINE = 80.5  # the module's SPDs (NAR/AAR), between the column texts and the notes
# The supply kit: its box under the lane, the tap x of L1 and N, and per lead end (N row, L1 row).
KIT_BOX = (60.0, 72.0, 52.0, 62.0)          # x0, x1, top offset, bottom offset
KIT_TAP = {"L1": 63.0, "N": 69.0}
KIT_BRANCH = {"L1": 80.0, "N": 86.0}
KIT_ROWS = ({"N": 68.0, "L1": 72.0}, {"N": 80.0, "L1": 84.0})
KIT_LEAD_END = 100.0


@dataclass(frozen=True)
class _Element:
    """A box on the lane: the conductors that end at its left edge and go on from its right."""

    x0: float
    x1: float
    conductors: tuple[str, ...]


def _column(x0: float, column: tuple[float, float]) -> tuple[float, float]:
    return x0 + column[0], x0 + column[0] + column[1]


def _series_box(b: Builder, kind: str, x0: float, column: tuple[float, float], conductors: Sequence[str],
                top: float, *, width: float = 16.0, poles: bool = True) -> _Element:
    left, right = _column(x0, column)
    centre = (left + right) / 2
    ys = [top - ROWS[c] for c in conductors]
    marks = [{"y": round1(y), "conductor": c} for y, c in zip(ys, conductors)] if poles else []
    b.box(kind, centre - width / 2, max(ys) + 4, centre + width / 2, min(ys) - 4, marks)
    return _Element(centre - width / 2, centre + width / 2, tuple(conductors))


def _column_texts(b: Builder, x0: float, column: tuple[float, float], top: float,
                  lines: Sequence[tuple[str, bool, str]]) -> None:
    left, right = _column(x0, column)
    for offset, (text, bold, colour) in zip(TEXT_LINES, lines):
        b.text((left + right) / 2, top - offset, text, w=right - left - 4, bold=bold, size=7.5 if bold else SIZE,
               anchor="middle", colour=colour)


def _switched(unit: Unit | None, conductors: Sequence[str]) -> list[str]:
    phases = [c for c in PHASES if c in conductors]
    own = [c for c in unit.conductors if c in conductors and c != "PE"] if unit is not None else []
    return own if any(c in PHASES for c in own) else phases


def _missing_lines(text: str, column: tuple[float, float], colour: str) -> list[tuple[str, bool, str]]:
    """One bold line when it fits the column, else the first word bold over the rest
    ("keine" / "Trennvorrichtung"), so the placeholder is never cut to "…"."""
    if text_width(text, FONT_BOLD, 7.5) <= column[1] - 4:
        return [(text, True, colour)]
    head, _, tail = text.partition(" ")
    return [(head, True, colour), (tail, False, colour)]


def _device(b: Builder, x0: float, top: float, column: tuple[float, float], kind: str, unit: Unit | None,
            conductors: Sequence[str], missing: str, note: str = "", warn: bool = True) -> _Element:
    """An SLS or Trennvorrichtung, or its dashed placeholder."""
    switched = _switched(unit, conductors)
    if unit is None:
        element = _series_box(b, "placeholder", x0, column, switched, top)
        _column_texts(b, x0, column, top, _missing_lines(missing, column, WARN if warn else MUTED))
        return element
    element = _series_box(b, kind, x0, column, switched, top)
    _column_texts(b, x0, column, top, [(unit.name, True, INK), (unit.rating, False, MUTED), (note, False, MUTED)])
    return element


def _meter(b: Builder, x0: float, top: float, lane: Lane, conductors: Sequence[str]) -> _Element:
    metered = [c for c in (*PHASES, "N") if c in conductors]
    element = _series_box(b, "meter", x0, METER, metered, top, width=48.0, poles=False)
    middle = (2 * top - ROWS[metered[0]] - ROWS[metered[-1]]) / 2
    b.text((element.x0 + element.x1) / 2, middle - 2.5, lane.meter_kind, w=44.0, bold=True, size=7.0, anchor="middle")
    number = (lane.meter_number, True, INK) if lane.meter_number else ("frei" if lane.free else "ohne Nummer", False, MUTED)
    _column_texts(b, x0, METER, top, [number, (lane.meter_label, False, MUTED)])
    return element


def _hlak(b: Builder, x0: float, top: float, unit: Unit, conductors: Sequence[str]) -> _Element:
    element = _series_box(b, "hlak", x0, HLAK, conductors, top, width=10.0)
    for c in conductors:
        b.dot(element.x1 + 6, top - ROWS[c])
    _column_texts(b, x0, HLAK, top, [(unit.name, True, INK)])
    return element


def _kit_leads(b: Builder, x0: float, top: float, ends: Sequence[str], feeds: Sequence[str],
               devices: Mapping[str, Sequence[str]]) -> None:
    """Thin leads from the kit box: the first end straight, the second branched off it (dots)."""
    lead_end = x0 + KIT_LEAD_END
    for number, end in enumerate(ends[:2]):
        rows = KIT_ROWS[number]
        for c in feeds:
            y = top - rows[c]
            if number == 0:
                b.wire(c, SOURCE, (x0 + KIT_TAP[c], top - KIT_BOX[3]), (x0 + KIT_TAP[c], y), (lead_end, y), thin=True)
                continue
            start = top - KIT_ROWS[0][c]
            b.wire(c, SOURCE, (x0 + KIT_BRANCH[c], start), (x0 + KIT_BRANCH[c], y), (lead_end, y), thin=True)
            b.dot(x0 + KIT_BRANCH[c], start)
        text = " · ".join((f"→ {end}", *devices.get(end, ())))
        b.text(lead_end + 4, top - rows["L1"], text, w=x0 + KIT[0] + KIT[1] - lead_end - 6)


def _kit(b: Builder, x0: float, top: float, section: CabinetSection, conductors: Sequence[str]) -> None:
    """The supply-kit tap of the carrier lane (or the existing tap; or what lacks one)."""
    kit = section.kit
    if kit is None:
        if section.kit_devices:
            names = " · ".join(name for _end, found in section.kit_devices for name in found)
            b.text(x0 + KIT[0] + 2, top - 66.0, "RfZ/APZ ohne Spannungsversorgung", w=KIT[1] - 4, colour=WARN)
            b.text(x0 + KIT[0] + 2, top - 74.0, names, w=KIT[1] - 4, colour=WARN)
        return
    feeds = [c for c in ("L1", "N") if c in conductors]
    box_x0, box_x1, box_top, box_bottom = KIT_BOX
    for c in feeds:
        b.dot(x0 + KIT_TAP[c], top - ROWS[c])
        b.wire(c, SOURCE, (x0 + KIT_TAP[c], top - ROWS[c]), (x0 + KIT_TAP[c], top - box_top))
    poles = [{"x": round1(x0 + KIT_TAP[c]), "conductor": c, "symbol": "fuse" if c == "L1" else "through"} for c in feeds]
    if not kit.article:
        poles = [{**pole, "symbol": "mcb"} for pole in poles if pole["conductor"] == "L1"]
    b.box("sabo" if kit.article else "mcb", x0 + box_x0, top - box_top, x0 + box_x1, top - box_bottom, poles)
    _kit_leads(b, x0, top, kit.ends, feeds, dict(section.kit_devices))
    b.text(x0 + KIT[0] + 2, top - 92.0, kit.label, w=KIT[1] - 4, colour=MUTED)


def _wires(b: Builder, x0: float, top: float, elements: Sequence[_Element], conductors: Sequence[str]) -> None:
    """Each conductor from its bus tap through the elements it passes to the lane's end."""
    for c in conductors:
        x = x0 + BUS_DX[c]
        for element in elements:
            if c in element.conductors:
                b.wire(c, SOURCE, (x, top - ROWS[c]), (element.x0, top - ROWS[c]))
                x = element.x1
        b.wire(c, SOURCE, (x, top - ROWS[c]), (x0 + LINE_END, top - ROWS[c]))


def draw_lane(b: Builder, x0: float, lane: Lane, top: float, conductors: Sequence[str],
              corners: set[tuple[float, float]], link: tuple[str, str], section: CabinetSection, *,
              unlinked: bool = False) -> None:
    """The lane below ``top``: title, taps, kit, SLS, meter, Trennvorrichtung, HLAK, xref, notes.

    ``unlinked``: the board has a distribution fed straight off the NAR (an FI without
    "Eingespeist von"); a lane with nothing behind it then says so instead of "keine Stromkreise".
    """
    b.text(x0 + KIT[0], top - 9.0, lane.title, w=XREF - KIT[0] - 6, bold=True, size=7.0, colour=BLUE)
    for c in conductors:
        point = (round1(x0 + BUS_DX[c]), round1(top - ROWS[c]))
        if point not in corners:
            b.dot(*point)
    if lane.carrier:
        _kit(b, x0, top, section, conductors)
    elements = [
        _device(b, x0, top, SLS, "sls", lane.sls, conductors, "kein SLS", lane.sls_note,
                warn=not lane.free or lane.switch is not None),
        _meter(b, x0, top, lane, conductors),
        _device(b, x0, top, SWITCH, "switch", lane.switch, conductors, "keine Trennvorrichtung"),
    ]
    if lane.hlak is not None:
        elements.append(_hlak(b, x0, top, lane.hlak, conductors))
    _wires(b, x0, top, elements, conductors)
    xref, fields = link
    if xref:
        b.text(x0 + XREF, top - 27.0, xref, w=150.0, bold=True, colour=BLUE)
        b.text(x0 + XREF, top - 36.0, fields, w=150.0, colour=MUTED)
    elif unlinked:
        b.text(x0 + XREF, top - 27.0, "Verteilung nicht verknüpft", w=150.0, bold=True, colour=WARN)
        b.text(x0 + XREF, top - 36.0, "„Eingespeist von“ am FI setzen", w=150.0, colour=WARN)
    else:
        b.text(x0 + XREF, top - 27.0, "keine Stromkreise geplant", w=150.0, colour=MUTED)
    b.text(x0 + SLS[0], top - SPD_LINE, " · ".join(lane.spds), w=XREF - SLS[0] - 6, colour=MUTED)
    b.text(x0 + SLS[0], top - NOTE_LINE, " · ".join(lane.notes), w=XREF - SLS[0] - 6, colour=WARN)
