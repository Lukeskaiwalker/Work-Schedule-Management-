"""The cabinet section of the Stromlaufplan, "Einspeisung & Zählerplatz" (docs/SCHALTPLAN_STROMLAUF.md §5.2).

On a readable cabinet board (a known cabinet code and at least one meter
place) the supply, the NAR busbar and the meter places get a sheet of their
own. This module says *what* that sheet shows; the layout
(``schaltplan_stromlauf_layout_cabinet``) says where.

* **Lanes**, one per meter place, in module field order, then place index:
  place k takes the k-th SLS on the module's NAR rails left → right (missing
  ones from a SAS SLS in the same or an adjacent field, in ``vde.nar_sls``
  credit order, noted "auf SAS Feld m"); the Trennvorrichtung whose
  ``supplied_by`` part is ``hs``/``trenn`` (place 0) or ``hs2``/``trenn2``
  (place 1), else the next Hauptschalter on the AAR left → right; the HLAK the
  same way; the meter entry ("frei" without one). The physical pairing wins:
  a plan that feeds the switch from another SLS gets the WARN note
  "Einspeisung laut Plan: {bmk}". An empty place of a reserve field (R4-12)
  draws no lane; its NAR still shows as a segment.
* **NAR segments**, one per ``main`` busbar zone in run order (R4-11): joined
  ones carry the ZZ55SAVE between them, every further run its own infeed.
* From the cabinet preparation (``analyse_prep``, R4 §3.3) — read, never
  re-derived: the infeed part, the supply kit (or the existing tap) with its
  leads to RfZ/APZ, the network lead, the PEN split and the §14a block.
* **Meter side** (``schaltplan_stromlauf_cabinet_parts``): RfZ/APZ devices
  and the NAR tap hang off the supply lead, never under a customer RCD.

Pure: reads the document, the catalogue and ``build_topology``'s groups; mutates nothing.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any, Iterator, Mapping, Sequence

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_control_block import Carrier, control_carrier, meter_candidates
from app.services.panel_enclosure_layout import (
    as_int,
    meter_place_count,
    meter_zones,
    occupied_meters,
    supplied_claims,
    text,
    zone_field,
)
from app.services.panel_enclosure_prep import analyse_prep
from app.services.schaltplan_stromlauf_cabinet_parts import (  # noqa: F401  (re-exported)
    ControlBand,
    NarSegment,
    NetworkLead,
    Placed,
    SupplyKit,
    control_band,
    infeed_text,
    is_meter_side,
    kit_devices,
    meter_side_ids,
    nar_segments,
    network_lead,
    placed_devices,
    prep_item,
    supply_kit,
)
from app.services.schaltplan_stromlauf_types import Unit, ident, make_unit

_SWITCH_PARTS: Mapping[int, tuple[str, ...]] = {0: ("hs", "trenn"), 1: ("hs2", "trenn2")}
_HLAK_PARTS: Mapping[int, tuple[str, ...]] = {0: ("hlak",), 1: ("hlak2",)}
_METER_KIND: Mapping[str, str] = {"ehz": "eHZ", "3punkt": "3-Punkt"}


# ── What the sheet shows ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class Lane:
    """One meter place: NAR tap → SLS → meter → Trennvorrichtung → HLAK."""

    key: str                # "{module id}:{place}"
    number: int             # "Zähler {number}", 1-based over the drawn lanes
    module_id: str
    code: str
    module_label: str
    field: int              # 0-based cabinet field of the meter place
    place: int
    meter_kind: str         # "eHZ" | "3-Punkt"
    meter_number: str
    meter_label: str
    free: bool              # no meter entry: "frei"
    sls: Unit | None
    sls_note: str           # "auf SAS Feld 3"
    switch: Unit | None
    hlak: Unit | None
    notes: tuple[str, ...]  # WARN: "Einspeisung laut Plan: Q5"
    carrier: bool           # the first lane of the §14a block's carrier: the kit and the band hang here
    tap: tuple[str, str]    # (module id, zone type) of the busbar zone it taps
    segment: int = 0        # index into ``CabinetSection.segments``

    @property
    def title(self) -> str:
        """"Zähler 1 · Feld 1 · ZH3EH16 · Allgemein"."""
        parts = [f"Zähler {self.number}", f"Feld {self.field + 1}", self.code, self.module_label]
        return " · ".join(p for p in parts if p)

    @property
    def units(self) -> tuple[Unit, ...]:
        return tuple(u for u in (self.sls, self.switch, self.hlak) if u is not None)


@dataclass(frozen=True)
class CabinetSection:
    lanes: tuple[Lane, ...]
    segments: tuple[NarSegment, ...]
    infeed: str
    joint_label: str
    pen_split: bool
    kit: SupplyKit | None
    kit_devices: tuple[tuple[str, tuple[str, ...]], ...]  # (end, device names) hanging off the supply lead
    network: NetworkLead | None
    control: ControlBand | None
    device_ids: frozenset[str]       # SLS, Trennvorrichtung and HLAK of every lane
    meter_side_ids: frozenset[str]
    locations: Mapping[str, str]     # device id → "AAR Feld 1"
    fields: Mapping[str, int]        # device id → its 0-based cabinet field (devices on cabinet rails)

    def lane_of(self, device_id: str) -> Lane | None:
        return next((lane for lane in self.lanes if device_id in {u.id for u in lane.units}), None)



# ── Lanes ────────────────────────────────────────────────────────────────────


def _sas_pool(placed: Sequence[Placed]) -> list[Placed]:
    """SLS on SAS rails in the order ``vde.nar_sls`` hands out credit."""
    sas = [p for p in placed if p.zone_type == "SAS" and p.kind == "sls"]
    return sorted(sas, key=lambda p: (p.field, as_int(p.module.get("unit")), p.module_id, as_int(p.zone.get("unit")),
                                      as_int(p.rail.get("unit")), p.slot))


def _module_sls(candidate: Carrier, own: Sequence[Placed], pool: Sequence[Placed],
                used: set[int]) -> list[tuple[Placed, str]]:
    """The module's NAR SLS, then credited SAS SLS up to its need (``_nar_sls``)."""
    out = [(p, "") for p in own if p.zone_type == "NAR" and p.kind == "sls"]
    need = max(1, len(occupied_meters(candidate.module)))
    for index, placed in enumerate(pool):
        if len(out) >= need:
            break
        if index not in used and abs(placed.field - candidate.field) <= 1:
            used.add(index)
            out.append((placed, f"auf SAS Feld {placed.field + 1}"))
    return out


def _by_place(candidate: Carrier, own: Sequence[Placed], kind: str, parts: Mapping[int, tuple[str, ...]],
              claims: Mapping[str, tuple[str, str]], places: int) -> list[Placed | None]:
    """Per place: the device of ``kind`` claimed for it, else the next unclaimed one on the AAR."""
    claimed: dict[int, Placed] = {}
    for placed in own:
        claim = claims.get(placed.id)
        if placed.kind != kind or claim is None or claim[0] != candidate.id:
            continue
        place = next((p for p, names in parts.items() if claim[1] in names and p < places), None)
        if place is not None and place not in claimed:
            claimed[place] = placed
    taken = {p.id for p in claimed.values()}
    rest: Iterator[Placed] = iter([p for p in own if p.zone_type == "AAR" and p.kind == kind and p.id not in taken])
    return [claimed[place] if place in claimed else next(rest, None) for place in range(places)]


def _meter_zone(spec: Mapping[str, Any], place: int) -> dict[str, Any] | None:
    for zone, first in meter_zones(spec):
        if first <= place < first + as_int(zone.get("meter_places")):
            return zone
    return None


def _plan_notes(switch: Placed | None, sls: Placed | None, by_head: Mapping[str, Mapping[str, Any]]) -> tuple[str, ...]:
    group = by_head.get(switch.id) if switch is not None else None
    fed = group.get("fed_by") if group is not None else None
    if fed is None or (sls is not None and ident(fed) == sls.id):
        return ()
    return (f"Einspeisung laut Plan: {make_unit(fed).bmk}",)


@dataclass(frozen=True)
class _ModuleParts:
    sls: list[tuple[Placed, str]]
    switches: list[Placed | None]
    hlaks: list[Placed | None]


def _module_lanes(candidate: Carrier, parts: _ModuleParts, carrier: Carrier | None,
                  by_head: Mapping[str, Mapping[str, Any]]) -> list[Lane]:
    lanes: list[Lane] = []
    meters = occupied_meters(candidate.module)
    for place in range(meter_place_count(candidate.spec)):
        sls, note = parts.sls[place] if place < len(parts.sls) else (None, "")
        switch, hlak, entry = parts.switches[place], parts.hlaks[place], meters.get(place)
        if candidate.reserve and entry is None and sls is None and switch is None and hlak is None:
            continue  # an empty reserve place: no lane (its NAR stays a segment)
        zone = _meter_zone(candidate.spec, place) or {}
        lanes.append(Lane(
            key=f"{candidate.id}:{place}", number=0, module_id=candidate.id, code=text(candidate.module.get("code")),
            module_label=text(candidate.module.get("label")), field=zone_field(candidate.module, zone), place=place,
            meter_kind=_METER_KIND.get(str(zone.get("meter_type")), "Zähler"),
            meter_number=text(entry.get("number")) if entry else "", meter_label=text(entry.get("label")) if entry else "",
            free=entry is None, sls=make_unit(sls.device) if sls else None, sls_note=note,
            switch=make_unit(switch.device) if switch else None, hlak=make_unit(hlak.device) if hlak else None,
            notes=_plan_notes(switch, sls, by_head),
            carrier=carrier is not None and carrier.id == candidate.id and not lanes,  # its first lane only
            tap=(sls.module_id, sls.zone_type) if sls is not None else (candidate.id, "NAR"),
        ))
    return lanes


def _lanes(document: Any, catalog: EnclosureCatalog, topology: Mapping[str, Any],
           placed: Sequence[Placed]) -> list[Lane]:
    claims = supplied_claims(document, catalog)
    carrier = control_carrier(document, catalog)
    by_head = {ident(g["device"]): g for g in topology["groups"] if g.get("device") is not None}
    pool = _sas_pool(placed)
    used: set[int] = set()
    lanes: list[Lane] = []
    for candidate in meter_candidates(document, catalog):
        own = [p for p in placed if p.module_id == candidate.id]
        places = meter_place_count(candidate.spec)
        parts = _ModuleParts(_module_sls(candidate, own, pool, used),
                             _by_place(candidate, own, "hauptschalter", _SWITCH_PARTS, claims, places),
                             _by_place(candidate, own, "hlak", _HLAK_PARTS, claims, places))
        lanes += _module_lanes(candidate, parts, carrier, by_head)
    return [replace(lane, number=index) for index, lane in enumerate(lanes, start=1)]



# ── The section ──────────────────────────────────────────────────────────────


def _tap_segment(lane: Lane, segments: Sequence[NarSegment]) -> int:
    """The segment of the zone the lane's SLS sits on; else its own NAR; else the nearest field."""
    for index, segment in enumerate(segments):
        if segment.key == lane.tap:
            return index
    for index, segment in enumerate(segments):
        if segment.key == (lane.module_id, "NAR"):
            return index
    return min(range(len(segments)), key=lambda i: (abs(segments[i].field - lane.field), i)) if segments else 0



def cabinet_section(document: Any, catalog: EnclosureCatalog | None, topology: Mapping[str, Any]) -> CabinetSection | None:
    """The cabinet sheet's content; None without a catalogue, a known cabinet or a meter place."""
    if catalog is None:
        return None
    state = analyse_prep(document, catalog)
    if state is None:
        return None
    placed = placed_devices(document, catalog)
    lanes = _lanes(document, catalog, topology, placed)
    if not lanes:
        return None
    segments = nar_segments(document, catalog, state)
    lanes = [replace(lane, segment=_tap_segment(lane, segments)) for lane in lanes]
    side = [p for p in placed if is_meter_side(p)]
    kit = supply_kit(document, catalog, state, side)
    drawn = frozenset(unit.id for lane in lanes for unit in lane.units)
    joints = prep_item(state, "busbar", "accessory:ZZ55SAVE")
    return CabinetSection(
        lanes=tuple(lanes), segments=tuple(segments), infeed=infeed_text(state, len({s.run for s in segments})),
        joint_label="ZZ55SAVE" if joints is not None and not joints["suppressed"] else "Feldverbinder",
        pen_split=prep_item(state, "busbar", "prep:pen_split") is not None, kit=kit, kit_devices=kit_devices(kit, side),
        network=network_lead(document, catalog, state), control=control_band(document, catalog, state), device_ids=drawn,
        meter_side_ids=frozenset(p.id for p in side),
        locations={p.id: f"AAR Feld {p.field + 1}" for p in placed if p.zone_type == "AAR" and p.id not in drawn},
        fields={p.id: p.field for p in placed},
    )
