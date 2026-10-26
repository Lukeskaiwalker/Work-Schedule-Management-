"""The Stromlaufplan's model: what the all-conductor sheets show (docs/SCHALTPLAN_STROMLAUF.md §5.2).

Read from ``build_topology`` only — the one source of electrical truth; its
dicts are referenced, never mutated or re-derived. Pure and deterministic.

* **Supply**: system, Zuleitung, Vorsicherung and the incoming conductors.
* **Sources**: a head chain — the ``fed_by`` root plus the feeder path down to
  the group — or the supply itself (""). A source's load groups share one bus
  segment on the drawing; two sources never do, so a group is never drawn on a
  bus it is not fed from. ``series`` are the feeder heads without circuits on
  the chain that no earlier source drew (SLS → HS → VB), drawn in series on
  the segment's bus; a chain that starts behind something already drawn says
  so in ``origin`` ("von Q1 HS"); ``caption`` names the feeder ("hinter Q1").
* **Groups**: the load groups — a head (FI, Hauptschalter with circuits, a
  fuse that opens a group, or none for the supply group) and its circuits,
  ordered by (source in source order, then topology order).

On a readable cabinet board ``cabinet`` is the "Einspeisung & Zählerplatz"
section (``schaltplan_stromlauf_cabinet``), and the distribution changes so
that no device is drawn twice: a lane's SLS, Trennvorrichtung and HLAK leave
the series and the heads (a lane switch with circuits of its own becomes a
headless group behind it); a chain that starts in a lane is captioned
"hinter Q1 HS (Zähler 1, Feld 1)" with the origin ``cabinet:{lane}`` (the
layout turns it into "von Blatt i"), one that starts at the supply gets
``cabinet:`` (the NAR); sources follow the lanes; the meter-side devices
(RfZ/APZ, NAR tap) hang off the supply lead on the cabinet sheet, never
under a customer RCD; circuits on an AAR carry "AAR Feld n".
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Mapping, Sequence

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.schaltplan_conductors import UNKNOWN_PHASE, outgoing_conductors, supply_conductors
from app.services.schaltplan_layout import FEEDER_KINDS, build_topology
from app.services.schaltplan_pdf_style import text_of as _text
from app.services.schaltplan_stromlauf_cabinet import CabinetSection, cabinet_section
from app.services.schaltplan_stromlauf_types import (  # noqa: F401  (re-exported for the layout)
    Circuit,
    Head,
    LoadGroup,
    Source,
    StromlaufModel,
    Supply,
    Unit,
    feeder_path,
    ident,
    make_unit,
    source_key,
)

_ident = ident
_unit = make_unit


def rcd_text(device: Mapping[str, Any]) -> str:
    """"IΔn {residual_current} · Typ {rcd_type}", "—" for an empty value (§5.3)."""
    return f"IΔn {_text(device.get('residual_current')) or '—'} · Typ {_text(device.get('rcd_type')) or '—'}"


def _is_series(group: Mapping[str, Any]) -> bool:
    device = group.get("device")
    return device is not None and str(device.get("kind") or "") in FEEDER_KINDS and not group.get("children")


def _circuit(device: Mapping[str, Any], terminal_labels: Mapping[str, Sequence[str]],
             locations: Mapping[str, str]) -> Circuit:
    labels = terminal_labels.get(_ident(device)) or ()
    return Circuit(_unit(device), _text(device.get("circuit")), _text(device.get("label")),
                   _text(device.get("room")), outgoing_conductors(device, device.get("cable")),
                   ", ".join(labels), locations.get(_ident(device), ""))


def _head(group: Mapping[str, Any]) -> Head:
    device = group.get("device")
    if device is None:
        return Head(None)
    feeds = group.get("feeds") or []
    feeds_text = ("speist " + ", ".join(_text(d.get("designation")) or _unit(d).short for d in feeds)) if feeds else ""
    pre_fuse = group.get("pre_fuse")
    return Head(_unit(device), rcd_text(device) if device.get("kind") == "rcd" else "",
                _unit(pre_fuse) if pre_fuse is not None else None, feeds_text)


def _sources(paths: Sequence[tuple[dict[str, Any], ...]], by_head: Mapping[str, Mapping[str, Any]]) -> tuple[Source, ...]:
    """One source per distinct feeder path, in order of first appearance.

    The segment draws in series the trailing feeder heads of its chain that
    have no circuits and no earlier segment drew; what feeds the first of
    them (or the bus itself, when there are none) is its origin: "von Q1 HS",
    or the supply."""
    drawn: set[str] = set()
    out: list[Source] = []
    for index, path in enumerate(paths):
        if not path:
            out.append(Source("", "", (), "supply" if index == 0 else "parallel"))
            continue
        count = 0
        for device in reversed(path):
            if _ident(device) in drawn or not _is_series(by_head.get(_ident(device), {})):
                break
            count += 1
        series = tuple(_unit(device) for device in path[len(path) - count:])
        upstream = path[len(path) - count - 1] if count < len(path) else None
        origin = f"von {_unit(upstream).name}" if upstream is not None else ("supply" if index == 0 else "parallel")
        drawn.update(unit.id for unit in series)
        last = path[-1]
        out.append(Source(source_key(path), f"hinter {_text(last.get('designation')) or _unit(last).short}",
                          series, origin))
    return tuple(out)


@dataclass(frozen=True)
class _Load:
    """A group as drawn: its feeder path (the head too when the head is drawn
    on the cabinet sheet and its circuits hang straight off its bus)."""

    group: Mapping[str, Any]
    path: tuple[dict[str, Any], ...]
    children: tuple[dict[str, Any], ...]
    headless: bool = False


def _loads(groups: Sequence[Mapping[str, Any]], by_head: Mapping[str, Mapping[str, Any]]) -> list[_Load]:
    """The groups drawn as heads: every group but a feeder head without circuits
    that feeds on. One that feeds nothing is on no chain, so it is drawn as a
    head of its own — never guessed into a bus."""
    return [_Load(g, feeder_path(g, by_head), tuple(g["children"]))
            for g in groups if not _is_series(g) or not g.get("feeds")]


def _cabinet_loads(loads: Sequence[_Load], cabinet: CabinetSection) -> list[_Load]:
    """Lane heads leave (with circuits: headless behind them); meter-side devices leave every group."""
    out: list[_Load] = []
    for load in loads:
        device = load.group.get("device")
        children = tuple(c for c in load.children if _ident(c) not in cabinet.meter_side_ids)
        if device is not None and _ident(device) in cabinet.device_ids:
            if children:
                out.append(_Load(load.group, (*load.path, device), children, True))
            continue
        if device is None and not children:
            continue
        out.append(replace(load, children=children))
    return out


def _cabinet_source(source: Source, path: Sequence[Mapping[str, Any]], cabinet: CabinetSection) -> Source:
    """A chain that starts in a lane continues behind it; one from the supply starts at the NAR."""
    cut = max((i for i, device in enumerate(path) if _ident(device) in cabinet.device_ids), default=None)
    if cut is None:
        return replace(source, origin="cabinet:") if source.origin in ("supply", "parallel") else source
    lane = cabinet.lane_of(_ident(path[cut]))
    inside = {_ident(device) for device in path[:cut + 1]}
    series = tuple(unit for unit in source.series if unit.id not in inside)
    if len(path) - len(series) - 1 > cut:  # it starts behind a head the distribution draws
        return replace(source, series=series)
    caption = source.caption
    if cut == len(path) - 1 and lane is not None:
        caption = f"hinter {_unit(path[cut]).name} (Zähler {lane.number}, Feld {lane.field + 1})"
    return replace(source, series=series, origin=f"cabinet:{lane.key if lane is not None else ''}", caption=caption)


def _lane_rank(source: Source, cabinet: CabinetSection) -> int:
    key = source.origin.removeprefix("cabinet:") if source.origin.startswith("cabinet:") else None
    return next((lane.number for lane in cabinet.lanes if lane.key == key), len(cabinet.lanes) + 1)


def build_stromlauf_model(document: Any, catalog: EnclosureCatalog | None = None, *,
                          terminal_labels: Mapping[str, Sequence[str]] | None = None) -> StromlaufModel:
    """The all-conductor drawing's content for one board (§5.2)."""
    document = document if isinstance(document, Mapping) else {}
    raw_supply = document.get("supply") if isinstance(document.get("supply"), Mapping) else {}
    supply = Supply(_text(raw_supply.get("system")), _text(raw_supply.get("voltage")),
                    _text(raw_supply.get("incoming")), _text(raw_supply.get("fuse")),
                    supply_conductors(raw_supply.get("system"), raw_supply.get("incoming")))
    topology = build_topology(dict(document))
    groups = topology["groups"]
    by_head = {_ident(g["device"]): g for g in groups if g.get("device") is not None}
    cabinet = cabinet_section(document, catalog, topology)
    loads = _loads(groups, by_head)
    if cabinet is not None:
        loads = _cabinet_loads(loads, cabinet)
    paths: dict[str, tuple[dict[str, Any], ...]] = {}
    for load in loads:
        paths.setdefault(source_key(load.path), load.path)
    sources = _sources(list(paths.values()), by_head)
    if cabinet is not None:
        sources = tuple(_cabinet_source(s, paths[s.key], cabinet) for s in sources)
        sources = tuple(sorted(sources, key=lambda s: _lane_rank(s, cabinet)))
    order = [source.key for source in sources]
    labels = terminal_labels or {}
    locations = cabinet.locations if cabinet is not None else {}
    ordered = sorted(loads, key=lambda load: order.index(source_key(load.path)))
    out = tuple(
        LoadGroup(_ident(load.group["device"]) or "supply", source_key(load.path),
                  Head(None) if load.headless else _head(load.group),
                  tuple(_circuit(child, labels, locations) for child in load.children),
                  "warn" if load.group["device"] is None or load.headless else "device")
        for load in ordered
    )
    unknown = sum(1 for g in out for c in g.circuits if UNKNOWN_PHASE in c.unit.conductors)
    return StromlaufModel(supply, sources, out, unknown, cabinet)
