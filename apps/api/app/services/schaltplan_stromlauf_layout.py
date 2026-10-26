"""The Stromlaufplan's layout: model → sheets of primitives (docs/SCHALTPLAN_STROMLAUF.md §5.3).

``layout_stromlauf(model, frame)`` returns one dict per sheet::

    {"kind": "distribution", "title": "Stromlaufplan allpolig", "number": n,
     "wires": [{"conductor", "points", "source"}], "dots": [[x, y]],
     "hops": [{"x", "y"}], "boxes": [{"kind", "x", "y", "w", "h", "poles", "texts"}],
     "texts": [{"x", "y", "size", "text", "anchor", "bold", "colour", "angle", "w"}],
     "xrefs": [{"text", "sheet"}], "note": "L? = …"}

Points in pt, y up, ``round1``; deterministic order. Two bands per sheet.
``paginate_columns`` packs the groups greedily, one bus segment per source:
a new source starts a new segment ≥ 16 pt after the last one, with its own
tags and caption; a group wider than the rest of a band is split into column
chunks with paired markers "→ Forts. Blatt k" / "Forts. von Blatt i".
``crossings`` (in ``_routes``) gives every crossing that is not a junction;
each is a hop.

On a cabinet board the "Einspeisung & Zählerplatz" sheets
(``schaltplan_stromlauf_layout_cabinet``) come first: the three
``_cabinet_*`` hooks below number the distribution sheets after them, give a
source behind a lane its origin ("von Blatt 1") and hand the cabinet sheets
the sheet each source's bus starts on (their "→ Sammelschiene Blatt k").
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Mapping, Sequence

from app.services.schaltplan_conductors import unknown_phase_note
from app.services.schaltplan_pdf_style import DRAW_X0, DRAW_X1, DRAW_Y0, DRAW_Y1, FONT, FONT_BOLD, text_width
from app.services.schaltplan_stromlauf_layout_bands import (
    BAND_H,
    BLUE,
    CAPTION,
    GROUP_GAP,
    MUTED,
    PE_RAIL,
    SIZE,
    BUS,
    CONT_W,
    Band,
    Builder,
    Chunk,
    SegmentPlan,
    bus_conductors,
    column_width,
    draw_chunk,
    draw_segment_start,
    head_phases,
    head_width,
    start_width,
)
from app.services.schaltplan_stromlauf_layout_cabinet import cabinet_origins, cabinet_sheet_count, cabinet_sheets
from app.services.schaltplan_stromlauf_layout_routes import crossings
from app.services.schaltplan_stromlauf_model import LoadGroup, Source, StromlaufModel

STROMLAUF_TITLE = "Stromlaufplan allpolig"
SEGMENT_GAP = 20.0
BAND_GAP = 8.0

__all__ = ["STROMLAUF_TITLE", "Frame", "crossings", "layout_stromlauf", "paginate_columns"]


@dataclass(frozen=True)
class Frame:
    """The drawing area and the number of the first Stromlauf sheet."""

    x0: float = DRAW_X0
    x1: float = DRAW_X1
    y0: float = DRAW_Y0
    y1: float = DRAW_Y1
    first_sheet: int = 1

    def band(self, index: int) -> Band:
        return Band(self.y1 - 2.0 - index * (BAND_H + BAND_GAP))


# ── The cabinet sheets ──────────────────────────────────────────────────────


def _cabinet_sheet_count(model: StromlaufModel, frame: Frame) -> int:
    """How many "Einspeisung & Zählerplatz" sheets the cabinet needs (0 without one)."""
    return cabinet_sheet_count(model, frame)


def _cabinet_origins(model: StromlaufModel, frame: Frame) -> Mapping[str, str]:
    """Source key → the origin its first bus segment shows ("von Blatt 1")."""
    return cabinet_origins(model, frame)


def _cabinet_sheets(model: StromlaufModel, frame: Frame, source_sheets: Mapping[str, int]) -> list[dict[str, Any]]:
    """The cabinet sheets, given the sheet each source's bus starts on."""
    return cabinet_sheets(model, frame, source_sheets)


# ── Pagination ──────────────────────────────────────────────────────────────


def _widths(group: LoadGroup) -> tuple[float, ...]:
    phases = head_phases(group)
    return tuple(column_width(circuit, phases) for circuit in group.circuits)


def _origin(source: Source, origins: Mapping[str, str]) -> str:
    """The first segment's origin text; a continuation gets "von Blatt i" when linked."""
    if source.key in origins:
        return origins[source.key]
    return {"supply": "", "parallel": "von Einspeisung"}.get(source.origin, source.origin)


class _Packer:
    """Greedy placement of chunks into bands; one instance per layout call."""

    def __init__(self, model: StromlaufModel, frame: Frame, origins: Mapping[str, str]) -> None:
        self.model, self.frame, self.origins = model, frame, origins
        self.sheets: list[list[list[SegmentPlan]]] = [[[], []]]
        self.band = 0

    def _band(self) -> list[SegmentPlan]:
        return self.sheets[-1][self.band]

    def _advance(self) -> None:
        if self.band == 0:
            self.band = 1
        else:
            self.sheets.append([[], []])
            self.band = 0

    def _open(self, source: Source, first: bool) -> None:
        """A new segment for ``source``: in the current band if a two-column chunk still fits."""
        while True:
            band = self._band()
            x0 = band[-1].x1 + SEGMENT_GAP if band else self.frame.x0
            opens_supply = first and source.origin == "supply"
            start = start_width(source, self.model.supply, first=first, opens_supply=opens_supply)
            if x0 + start + CONT_W + 96.0 <= self.frame.x1 or not band:
                origin = self._origin_text(source) if first else "von Blatt 00"
                plan = SegmentPlan(source, x0, start, (), first, origin if first else "")
                caption_w = text_width(plan.caption + " · → Blatt 00", FONT_BOLD, SIZE)
                min_w = min(text_width(origin, FONT, SIZE) + caption_w + 12, self.frame.x1 - x0)
                band.append(replace(plan, min_w=min_w))
                return
            self._advance()

    def _origin_text(self, source: Source) -> str:
        origin = _origin(source, self.origins)
        return self.model.supply.caption if not origin and source.origin == "supply" else origin

    def _add(self, chunk: Chunk) -> None:
        band = self._band()
        band[-1] = replace(band[-1], chunks=(*band[-1].chunks, chunk))

    def place(self, source: Source, groups: Sequence[LoadGroup]) -> None:
        first = True
        self._open(source, first)
        for group in groups:
            widths, start = _widths(group), 0
            while True:
                segment = self._band()[-1]
                x = segment.chunks[-1].x + segment.chunks[-1].width + GROUP_GAP if segment.chunks \
                    else segment.x0 + segment.start_w
                head = head_width(group) if start == 0 else CONT_W
                whole = Chunk(group, start, len(widths), x, head, widths[start:])
                if x + whole.width <= self.frame.x1:
                    self._add(whole)
                    break
                fit = self._fit(x + head, widths[start:])
                if fit >= 2:  # a chunk that continues is at least two columns wide
                    self._add(Chunk(group, start, start + fit, x, head, widths[start:start + fit]))
                    start += fit
                if self._band()[-1].chunks:
                    first = False
                else:
                    self._band().pop()
                self._advance()
                self._open(source, first)

    def _fit(self, x: float, widths: Sequence[float]) -> int:
        count = 0
        for width in widths:
            if x + width > self.frame.x1:
                break
            x += width
            count += 1
        return count


def _link(sheets: list[list[list[SegmentPlan]]], first_sheet: int) -> list[list[list[SegmentPlan]]]:
    """Sheet numbers on split chunks and on sources that continue."""
    placed = [(number, b, i) for number, sheet in enumerate(sheets, start=first_sheet)
              for b, band in enumerate(sheet) for i, _ in enumerate(band)]
    out = [[list(band) for band in sheet] for sheet in sheets]

    def at(ref: tuple[int, int, int]) -> SegmentPlan:
        return out[ref[0] - first_sheet][ref[1]][ref[2]]

    def put(ref: tuple[int, int, int], plan: SegmentPlan) -> None:
        out[ref[0] - first_sheet][ref[1]][ref[2]] = plan

    for ref, nxt in zip(placed, placed[1:]):
        current, follower = at(ref), at(nxt)
        if follower.first or follower.source.key != current.source.key:
            continue
        put(ref, replace(current, next_sheet=nxt[0]))
        put(nxt, replace(follower, prev_sheet=ref[0], origin=f"von Blatt {ref[0]}"))
        last, head = at(ref).chunks[-1], at(nxt).chunks[0] if at(nxt).chunks else None
        if head is not None and head.group is last.group and head.start == last.stop:
            put(ref, replace(at(ref), chunks=(*at(ref).chunks[:-1], replace(last, next_sheet=nxt[0]))))
            put(nxt, replace(at(nxt), chunks=(replace(head, prev_sheet=ref[0]), *at(nxt).chunks[1:])))
    return out


def paginate_columns(model: StromlaufModel, frame: Frame,
                     origins: Mapping[str, str] | None = None) -> list[list[list[SegmentPlan]]]:
    """Sheets → bands → bus segments, each segment one source's chunks (§5.3)."""
    packer = _Packer(model, frame, origins or {})
    for source in model.sources:
        groups = [group for group in model.groups if group.source == source.key]
        if groups:
            packer.place(source, groups)
    first = frame.first_sheet + _cabinet_sheet_count(model, frame)
    sheets = [sheet for sheet in packer.sheets if sheet[0] or sheet[1]]
    return _link(sheets, first)


# ── Sheets ──────────────────────────────────────────────────────────────────


def _draw_segment(b: Builder, band: Band, plan: SegmentPlan, model: StromlaufModel) -> None:
    feed_x = draw_segment_start(b, band, plan, model.supply, plan.x1)
    pe_taps: list[float] = []
    for chunk in plan.chunks:
        draw_chunk(b, band, chunk, bus_conductors(model.supply), pe_taps)
    if pe_taps:
        b.dot(feed_x, band.y(BUS["PE"]))
        b.wire("PE", plan.source.key, (feed_x, band.y(BUS["PE"])), (feed_x, band.y(PE_RAIL)),
               (max(pe_taps), band.y(PE_RAIL)))
    width = plan.x1 - plan.x0
    caption = plan.caption
    # The caption gets what the origin leaves (min_w reserved both side by side):
    # "hinter Q1 HS (Zähler 1, Feld 1)" on a cabinet board is longer than half a short segment.
    origin_w = text_width(plan.origin, FONT, SIZE) + 8 if plan.origin else 0.0
    caption_w = min(text_width(caption, FONT_BOLD, SIZE) + 0.1, max(width / 2, width - origin_w)) if caption else 0.0
    b.text(plan.x1, band.y(CAPTION), caption, w=caption_w, anchor="end", colour=BLUE, bold=True)
    b.text(plan.x0, band.y(CAPTION), plan.origin, w=width - caption_w - 8, colour=MUTED)


def _sheet(plan: Sequence[Sequence[SegmentPlan]], model: StromlaufModel, frame: Frame, number: int) -> dict[str, Any]:
    b = Builder()
    for index, segments in enumerate(plan):
        for segment in segments:
            _draw_segment(b, frame.band(index), segment, model)
    hops = [{"x": x, "y": y} for x, y in crossings(b.wires)]
    xrefs = [{"text": t["text"], "sheet": int(t["text"].rsplit(" ", 1)[1])} for t in b.texts
             if t["text"].startswith(("→ Forts. Blatt ", "Forts. von Blatt ", "von Blatt ", "→ Blatt "))
             and t["text"].rsplit(" ", 1)[1].isdigit()]
    return {"kind": "distribution", "title": STROMLAUF_TITLE, "number": number, "wires": b.wires,
            "dots": sorted(b.dots), "hops": hops, "boxes": b.boxes, "texts": b.texts, "xrefs": xrefs,
            "note": unknown_phase_note(len(b.unknown))}


def layout_stromlauf(model: StromlaufModel, frame: Frame) -> list[dict[str, Any]]:
    """Every Stromlauf sheet: the cabinet sheets, then the distribution sheets."""
    origins = _cabinet_origins(model, frame)
    plans = paginate_columns(model, frame, origins)
    first = frame.first_sheet + _cabinet_sheet_count(model, frame)
    source_sheets: dict[str, int] = {}
    for number, sheet in enumerate(plans, start=first):
        for band in sheet:
            for segment in band:
                source_sheets.setdefault(segment.source.key, number)
    distribution = [_sheet(sheet, model, frame, number) for number, sheet in enumerate(plans, start=first)]
    return [*_cabinet_sheets(model, frame, source_sheets), *distribution]
