"""Wires as data: crossings, junctions and the rounded output of a Stromlauf sheet.

A wire is ``{"conductor", "points", "source"}``: an axis-aligned polyline in
points (y up). Two wires are connected where an end of one lies on the other
(a tap, drawn with a junction dot) or where they share an end; anywhere else
a horizontal and a vertical segment meet is a crossing without connection,
drawn as a hop (docs/SCHALTPLAN_STROMLAUF.md §5.3). Pure; deterministic order.
"""

from __future__ import annotations

from typing import Any, Iterator, Mapping, Sequence

from app.services.panel_enclosure_geometry import round1

Point = tuple[float, float]
Segment = tuple[Point, Point]
_EPS = 0.05


def segments(points: Sequence[Sequence[float]]) -> Iterator[Segment]:
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        yield (float(x0), float(y0)), (float(x1), float(y1))


def _horizontal(segment: Segment) -> bool:
    return abs(segment[0][1] - segment[1][1]) < _EPS and abs(segment[0][0] - segment[1][0]) >= _EPS


def _vertical(segment: Segment) -> bool:
    return abs(segment[0][0] - segment[1][0]) < _EPS and abs(segment[0][1] - segment[1][1]) >= _EPS


def _strictly_inside(value: float, a: float, b: float) -> bool:
    low, high = (a, b) if a <= b else (b, a)
    return low + _EPS < value < high - _EPS


def on_segment(point: Point, segment: Segment, *, interior: bool = True) -> bool:
    """Does ``point`` lie on the segment (its interior only, by default)?"""
    (x0, y0), (x1, y1) = segment
    x, y = point
    if _horizontal(segment) and abs(y - y0) < _EPS:
        return _strictly_inside(x, x0, x1) if interior else min(x0, x1) - _EPS <= x <= max(x0, x1) + _EPS
    if _vertical(segment) and abs(x - x0) < _EPS:
        return _strictly_inside(y, y0, y1) if interior else min(y0, y1) - _EPS <= y <= max(y0, y1) + _EPS
    return False


def crossings(wires: Sequence[Mapping[str, Any]]) -> list[tuple[float, float]]:
    """Every point where a horizontal and a vertical segment cross in both
    interiors — a crossing without connection — sorted by (x, y)."""
    horizontals = [s for wire in wires for s in segments(wire["points"]) if _horizontal(s)]
    verticals = [s for wire in wires for s in segments(wire["points"]) if _vertical(s)]
    found: set[tuple[float, float]] = set()
    for h in horizontals:
        y = h[0][1]
        for v in verticals:
            x = v[0][0]
            if _strictly_inside(x, h[0][0], h[1][0]) and _strictly_inside(y, v[0][1], v[1][1]):
                found.add((round1(x), round1(y)))
    return sorted(found)


def taps(wires: Sequence[Mapping[str, Any]]) -> list[tuple[float, float]]:
    """Every wire end that lies in the interior of another wire: the junctions
    a dot must mark. Sorted by (x, y)."""
    ends = [(tuple(map(float, wire["points"][0])), i) for i, wire in enumerate(wires)]
    ends += [(tuple(map(float, wire["points"][-1])), i) for i, wire in enumerate(wires)]
    found: set[tuple[float, float]] = set()
    for point, owner in ends:
        for j, wire in enumerate(wires):
            if j != owner and any(on_segment(point, s) for s in segments(wire["points"])):
                found.add((round1(point[0]), round1(point[1])))
    return sorted(found)


def rounded_points(points: Sequence[Sequence[float]]) -> list[list[float]]:
    """round1 on output, consecutive equal points dropped."""
    out: list[list[float]] = []
    for x, y in points:
        point = [round1(x), round1(y)]
        if not out or out[-1] != point:
            out.append(point)
    return out
