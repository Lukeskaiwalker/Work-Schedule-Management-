"""Cabinet preparation: what every Zählerschrank needs besides its modules (docs/PANEL_ENCLOSURE_R4.md §3.3–§3.5).

Twin of ``apps/web/src/utils/enclosurePrep.ts``; both are pinned on
``enclosureFixtures.json`` (key ``prep`` per board, tables ``prep_parse``,
``infeed_parse``, ``fuse_parse``). The Materialliste reads ``cabinet_prep``
server-side only (``panel_enclosure_prep_material``).

Everything here is **derived** from the board (R4-4) and appears on built
boards too; each group can be overridden per board (``enclosure.prep``,
§2.2). In this fixed order:

(a) Spannungsversorgung RfZ/APZ (Hager ZY…), (b) Einspeisung (K96ESA5 or
Sammelschienenklemmen), (b2) PEN-Aufteilung, (c) Sammelschienenverbinder
ZZ55SAVE, (d) Netzwerkleitung ZZ45WAN…, (e) the §14a block, its wires and
the Lüsterklemme. An item an override switches ``off`` is still returned,
with ``qty`` 0 and ``suppressed`` true, so the editor can strike it through.

Busbar zones have a **role** (R4-11): ``main`` (unmetered: every NAR, the SAS
of a communication field, a SAS that holds an SLS) or ``customer`` (every
other SAS, after the meter). Joints and the infeed never cross roles: a
connector between them would bridge around the meter. A customer zone also
knows the meter(s) feeding its module (``panel_enclosure_busbar_meters``):
two customer zones of different meters are never joined, and a joint where
a side's meter is unknown is planned unverified ("Zähler prüfen").

Runs are measured in scene millimetres, vertical first then horizontal, on
the unrounded points; ``lengthMm`` is rounded once and everything downstream
(wire metres, the network fallback) uses that rounded value.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.services.cable_section_parse import parse_cable_section
from app.services.panel_enclosure_busbar_meters import different_meters, feed_index, meter_unknown, module_meters
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_control_block import (
    CONTROL_PARTS,
    DERIVE,
    NETWORK_LEADS,
    NETWORK_RESERVE_MM,
    PART_END_STOP,
    PART_PLATE,
    PART_TERMINAL,
    WIRE_RESERVE_DM,
    BlockLayout,
    Carrier,
    Grid,
    control_block_layout,
    control_carrier,
    first_meter_zone,
    first_rail,
    parse_prep,
    resolve_block,
)
from app.services.panel_enclosure_geometry import mm_text
from app.services.panel_enclosure_layout import (
    as_int,
    default_rail_label,
    dicts,
    enclosure_of,
    ident,
    linked_rows,
    module_rails,
    module_spec,
    modules_of,
    row_devices,
    rows_of,
    spec_rails,
    text,
    zone_field,
)
from app.services.panel_enclosure_terminals import round1
from app.services.schaltplan_layout import DEVICE_CATALOG

ROLE_MAIN, ROLE_CUSTOMER = "main", "customer"
GROUP_SUPPLY, GROUP_BUSBAR, GROUP_NETWORK, GROUP_CONTROL = "supply", "busbar", "network", "control"
DEFAULT_PREP: dict[str, Any] = {"supply": "auto", "infeed": "auto", "joints": "auto", "network": "auto", "network_m": None}
SMALL_TAP_A = 10.0  # an LS up to 10 A may tap the NAR / sit on the RfZ (Spannungsabgriff)
SABO_OFFSET_MM = 30.0  # the SABO sits this far right of the NAR busbar's left end
K96ESA5_MAX_MM2 = 25.0
K96ESA5_MAX_FUSE_A = 100
_HEIGHT_DIGITS = {1100: "3", 1400: "5"}
#: ASCII digits only, as JS ``\d`` (``float`` would read "B１０" as 10 here, null in TS).
_NUMBER = re.compile(r"[0-9]+(?:[.,][0-9]+)?", re.ASCII)
#: Hager Bestellhilfe 20DE0173: (carrier family, cabinet height, APZ top/bottom) →
#: the lead for 0, 1, 2, 3 fields between the APZ and the meter field.
HAGER_NETWORK_TABLE: dict[tuple[str, int, str], tuple[str, str, str, str]] = {
    ("meter_ehz", 1100, "bottom"): ("ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200"),
    ("meter_ehz", 1100, "top"): ("ZZ45WAN040", "ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150"),
    ("meter_3p", 1100, "bottom"): ("ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200"),
    ("meter_3p", 1100, "top"): ("ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN150", "ZZ45WAN200"),
    ("meter_3p", 1400, "bottom"): ("ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200", "ZZ45WAN200"),
    ("meter_3p", 1400, "top"): ("ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN150", "ZZ45WAN200"),
}
_LEAD_MM = {code: length for length, code in NETWORK_LEADS}
#: (min mm², max mm², article, label) on a 12×5 mm busbar, first fit wins (hager.com, 2026-10-26:
#: K96H takes 25–95 mm² on 12×5 mm; K96C 2,5–35 mm² Cu is only reached below 25 mm²).
_CLAMPS_CU = ((25.0, 70.0, "K96F", "Sammelschienenklemme 25–70 mm² für 12×5 mm"),
              (25.0, 95.0, "K96H", "Sammelschienenklemme 25–95 mm² für 12×5 mm"),
              (50.0, 150.0, "K96K", "Sammelschienenklemme 50–150 mm² für 12×5 mm"),
              (50.0, 185.0, "KS18D", "Sammelschienenklemme 50–185 mm², Al/Cu, für 12×5 mm"),
              (2.5, 35.0, "K96C", "Sammelschienenklemme 2,5–35 mm² für 12×5 mm"))
_CLAMPS_AL = ((10.0, 50.0, "K96N", "Sammelschienenklemme 10–50 mm², Al/Cu"),
              (50.0, 185.0, "KS18D", "Sammelschienenklemme 50–185 mm², Al/Cu, für 12×5 mm"))
CLAMP_MAX_MM2 = 185.0
_SUPPLY_DEVICE = {"SA": "SABO 1,6 A", "LS": "LS 6 A", "SI": "Sicherungsbox 1 A"}
_SUPPLY_PART = {"SA": "SABO 1,6 A", "LS": "Sammelschienen-LS 6 A", "SI": "Sicherungsbox 1 A im RfZ"}

Point = tuple[float, float]


# ── Small readers, shared with the rules ─────────────────────────────────────


def rating(device: Mapping[str, Any]) -> float | None:
    """The last number in the rating ("B16" → 16, "E35" → 35); None if none."""
    numbers = _NUMBER.findall(text(device.get("rating")))
    return float(numbers[-1].replace(",", ".")) if numbers else None


def is_small_tap(device: Mapping[str, Any]) -> bool:
    """An LS up to 10 A: the Spannungsabgriff the NAR and the RfZ allow."""
    amps = rating(device)
    return str(device.get("kind") or "") == "mcb" and amps is not None and amps <= SMALL_TAP_A


def device_bmk(device: Mapping[str, Any]) -> str:
    entry = DEVICE_CATALOG.get(str(device.get("kind") or ""))
    return text(device.get("designation")) or (str(entry["short"]) if entry is not None else "?")


def prep_overrides(document: Any) -> dict[str, Any]:
    """``enclosure.prep`` parsed; absent ≡ every group ``auto``."""
    enclosure = enclosure_of(document)
    parsed = parse_prep(enclosure.get("prep")) if enclosure is not None else None
    return dict(parsed) if parsed is not None else dict(DEFAULT_PREP)


# ── Zones of the board ───────────────────────────────────────────────────────


@dataclass(frozen=True)
class PlacedZone:
    module: dict[str, Any]
    spec: dict[str, Any]
    index: int
    zone: dict[str, Any]

    @property
    def module_id(self) -> str:
        return ident(self.module.get("id"))

    @property
    def field(self) -> int:
        return zone_field(self.module, self.zone)

    @property
    def start(self) -> int:
        return as_int(self.module.get("unit")) + as_int(self.zone.get("unit"))

    @property
    def end(self) -> int:
        return self.start + as_int(self.zone.get("units"), 1)


def placed_zones(document: Any, catalog: EnclosureCatalog, zone_type: str) -> list[PlacedZone]:
    """Zones of one type on the board, by (field, start unit, module index, spec order)."""
    found: list[tuple[tuple[int, int, int, int], PlacedZone]] = []
    for index, module in enumerate(modules_of(document)):
        spec = module_spec(module, catalog)
        for order, zone in enumerate(dicts(spec.get("zones")) if spec is not None else ()):
            if zone.get("type") == zone_type:
                placed = PlacedZone(module, spec, index, zone)
                found.append(((placed.field, placed.start, index, order), placed))
    return [placed for _, placed in sorted(found, key=lambda pair: pair[0])]


def first_apz(document: Any, catalog: EnclosureCatalog) -> PlacedZone | None:
    """The first APZ zone (by field, unit) that has a rail to measure from."""
    return next((z for z in placed_zones(document, catalog, "APZ") if first_rail(z.zone) is not None), None)


# ── Busbar zones, roles, joints and runs ─────────────────────────────────────


@dataclass(frozen=True)
class BusbarZone:
    placed: PlacedZone
    role: str
    #: Customer zones: the meter modules feeding the module (empty = unknown); main zones: empty.
    meters: frozenset[str] = frozenset()

    @property
    def field(self) -> int:
        return self.placed.field


def _holds_sls(document: Any, catalog: EnclosureCatalog, placed: PlacedZone, rail: Mapping[str, Any]) -> bool:
    key = str(rail.get("key"))
    row_id = module_rails(placed.module).get(key)
    if row_id is None or linked_rows(document, catalog).get(row_id) != (placed.module_id, key):
        return False
    row = next((r for r in rows_of(document) if r["id"] == row_id), None)
    return any(str(device.get("kind") or "") == "sls" for device in row_devices(row))


def busbar_zones(document: Any, catalog: EnclosureCatalog) -> list[BusbarZone]:
    """Every NAR/SAS zone with a busbar rail, with its role (R4-11) and, for a customer zone, its meters."""
    out: list[BusbarZone] = []
    feeds = None
    for zone_type in ("NAR", "SAS"):
        for placed in placed_zones(document, catalog, zone_type):
            busbar = next((r for r in dicts(placed.zone.get("rails")) if r.get("mount") == "busbar"), None)
            if busbar is None:
                continue
            main = zone_type == "NAR" or placed.spec.get("family") == "communication" or _holds_sls(
                document, catalog, placed, busbar)
            if main:
                out.append(BusbarZone(placed, ROLE_MAIN))
                continue
            feeds = feeds if feeds is not None else feed_index(document, catalog)
            out.append(BusbarZone(placed, ROLE_CUSTOMER, module_meters(placed.module, feeds)))
    return sorted(out, key=lambda z: (z.field, z.placed.start, z.placed.index))


def _overlap(a: BusbarZone, b: BusbarZone) -> bool:
    return a.placed.start < b.placed.end and b.placed.start < a.placed.end


def other_meters(a: BusbarZone, b: BusbarZone) -> bool:
    """Two customer zones fed through different meters."""
    return a.role == b.role == ROLE_CUSTOMER and different_meters(a.meters, b.meters)


def unchecked_meter(a: BusbarZone, b: BusbarZone) -> bool:
    """Two customer zones where a side's meter is unknown."""
    return a.role == b.role == ROLE_CUSTOMER and meter_unknown(a.meters, b.meters)


def joined(a: BusbarZone, b: BusbarZone) -> bool:
    """Neighbouring fields, different modules, same role, spans overlapping — and, for customer zones, not of different meters."""
    return (abs(a.field - b.field) == 1 and a.placed.module_id != b.placed.module_id
            and a.role == b.role and _overlap(a, b) and not other_meters(a, b))


def unchecked_pairs(zones: list[BusbarZone]) -> list[tuple[int, int]]:
    """(left, right) fields of every joined customer pair with a meter unknown, once each."""
    pairs = {(a.field, b.field) for a in zones for b in zones
             if b.field == a.field + 1 and joined(a, b) and unchecked_meter(a, b)}
    return sorted(pairs)


def joint_pairs(zones: list[BusbarZone]) -> list[tuple[str, int, int]]:
    """(role, left field, right field) of every joined field pair, once each."""
    pairs = {(a.role, a.field, b.field) for a in zones for b in zones if b.field == a.field + 1 and joined(a, b)}
    return sorted(pairs, key=lambda pair: (pair[1], pair[2], pair[0] != ROLE_MAIN))


def busbar_runs(zones: list[BusbarZone], role: str) -> list[list[BusbarZone]]:
    """Connected components of one role's zones under ``joined``, by first field."""
    members = [zone for zone in zones if zone.role == role]
    runs: list[list[BusbarZone]] = []
    seen: set[int] = set()
    for start, zone in enumerate(members):
        if start in seen:
            continue
        component, queue = [], [start]
        seen.add(start)
        while queue:
            current = queue.pop(0)
            component.append(current)
            for other, candidate in enumerate(members):
                if other not in seen and joined(members[current], candidate):
                    seen.add(other)
                    queue.append(other)
        runs.append([members[i] for i in sorted(component)])
    return sorted(runs, key=lambda run: (min(z.field for z in run), run[0].placed.start))


# ── Runs (§3.4) ──────────────────────────────────────────────────────────────


def make_run(kind: str, start: Point, end: Point, label: str) -> dict[str, Any]:
    a, b = (round1(start[0]), round1(start[1])), (round1(end[0]), round1(end[1]))
    points: list[tuple[float, float]] = []
    for point in (a, (a[0], b[1]), b):
        if not points or points[-1] != point:
            points.append(point)
    length = abs(end[0] - start[0])
    length += abs(end[1] - start[1])
    return {"kind": kind, "from": list(a), "to": list(b), "points": [list(p) for p in points], "label": label,
            "lengthMm": round1(length)}


@dataclass(frozen=True)
class End:
    """Where a lead ends: a point and what the reason calls it."""

    point: Point
    name: str  # "RfZ" | "Zählerplatz" | "APZ"
    field: int  # 0-based


def _zone_end(grid: Grid, placed: PlacedZone, name: str) -> End | None:
    rail = first_rail(placed.zone)
    if rail is None:
        return None
    return End(grid.rail_centre(placed.module, placed.zone, rail), name, placed.field)


def _meter_place_end(grid: Grid, carrier: Carrier) -> End | None:
    zone = first_meter_zone(carrier.spec)
    if zone is None:
        return None
    return End(grid.meter_place(carrier.module, zone, 0), "Zählerplatz", zone_field(carrier.module, zone))


def _carrier_rfz(document: Any, catalog: EnclosureCatalog, grid: Grid, carrier: Carrier) -> End | None:
    for placed in placed_zones(document, catalog, "RFZ"):
        if placed.module_id == carrier.id and first_rail(placed.zone) is not None:
            return _zone_end(grid, placed, "RfZ")
    return None


def control_target(document: Any, catalog: EnclosureCatalog, carrier: Carrier | None) -> End | None:
    """eHZ: the carrier's first RfZ rail; 3-Punkt: the first APZ of the cabinet (§3.4)."""
    if carrier is None:
        return None
    grid = Grid.of(document, catalog)
    if carrier.family == "meter_ehz":
        return _carrier_rfz(document, catalog, grid, carrier)
    apz = first_apz(document, catalog)
    return _zone_end(grid, apz, "APZ") if apz is not None else None


def supply_rfz_end(document: Any, catalog: EnclosureCatalog, grid: Grid, carrier: Carrier) -> End | None:
    """§3.3 (a): eHZ → its RfZ; 3-Punkt → the first RfZ of a non-meter module, else meter place 0."""
    if carrier.family == "meter_ehz":
        return _carrier_rfz(document, catalog, grid, carrier) or _meter_place_end(grid, carrier)
    for placed in placed_zones(document, catalog, "RFZ"):
        if placed.spec.get("family") not in ("meter_ehz", "meter_3p") and first_rail(placed.zone) is not None:
            return _zone_end(grid, placed, "RfZ")
    return _meter_place_end(grid, carrier)


def sabo_point(document: Any, catalog: EnclosureCatalog, grid: Grid, carrier: Carrier) -> Point | None:
    for zone, rail, _ in spec_rails(carrier.spec):
        if zone.get("type") == "NAR" and rail.get("mount") == "busbar":
            return grid.rail_left(carrier.module, zone, rail) + SABO_OFFSET_MM, grid.rail_y(carrier.module, zone, rail)
    return None


# ── Items ────────────────────────────────────────────────────────────────────


def item(key: str, article: str | None, label: str, qty: int, reason: str, *, group: str, verified: bool,
         unit: str = "Stk", override: str | None = None, suppressed: bool = False) -> dict[str, Any]:
    return {"key": key, "articleNo": article, "label": label, "qty": 0 if suppressed else qty, "unit": unit,
            "reason": reason, "verified": verified, "group": group, "override": override, "suppressed": suppressed}


@dataclass(frozen=True)
class _Part:
    """What one builder adds: items, runs and the facts its findings read."""

    items: tuple[dict[str, Any], ...] = ()
    runs: tuple[dict[str, Any], ...] = ()
    facts: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class _Board:
    document: Any
    catalog: EnclosureCatalog
    grid: Grid
    overrides: Mapping[str, Any]
    carrier: Carrier | None
    apz: PlacedZone | None
    zones: tuple[BusbarZone, ...]
    supply: Mapping[str, Any]


def _ends_text(ends: list[End]) -> str:
    names = [f"{end.name} Feld {end.field + 1}" for end in ends]
    return f", Leitungen zum {' und '.join(names)}" if names else ""


def _existing_tap(board: _Board, carrier: Carrier) -> tuple[str, str] | None:
    """(BMK, rail title) of an LS ≤ 10 A on the carrier's NAR or on any RfZ/APZ rail."""
    places: list[tuple[dict[str, Any], dict[str, Any], dict[str, Any], int]] = [
        (carrier.module, zone, rail, position) for zone, rail, position in spec_rails(carrier.spec)
        if zone.get("type") == "NAR"]
    supply_zones = placed_zones(board.document, board.catalog, "RFZ") + placed_zones(board.document, board.catalog, "APZ")
    for placed in sorted(supply_zones, key=lambda z: (z.field, z.start, z.index)):
        places += [(placed.module, placed.zone, rail, position)
                   for position, rail in enumerate(dicts(placed.zone.get("rails")), start=1)]
    linked = linked_rows(board.document, board.catalog)
    rows = {row["id"]: row for row in rows_of(board.document)}
    for module, zone, rail, position in places:
        key = str(rail.get("key"))
        row_id = module_rails(module).get(key)
        if row_id is None or linked.get(row_id) != (ident(module.get("id")), key):
            continue
        for device in row_devices(rows.get(row_id)):
            if is_small_tap(device):
                return device_bmk(device), default_rail_label(module, zone, position)
    return None


def _supply(board: _Board) -> _Part:
    """(a) Spannungsversorgung RfZ/APZ (O6)."""
    carrier = board.carrier
    if carrier is None:
        return _Part()
    height = board.grid.height_mm
    digit = _HEIGHT_DIGITS.get(height)
    if digit is None:
        return _Part(facts={"supply_height": height})
    leads = "2" if placed_zones(board.document, board.catalog, "APZ") else "1"
    choice = str(board.overrides["supply"])
    variant = choice if choice in ("LS", "SI") else "SA"
    article = f"ZY{digit}R{leads}SI" if variant == "SI" else f"ZY{digit}N{leads}{variant}"
    label = (f"Bestückungspaket Spannungsversorgung {'APZ/RfZ' if leads == '2' else 'RfZ'}, "
             f"{_SUPPLY_PART[variant]}, Bauhöhe {height} mm")
    rfz = supply_rfz_end(board.document, board.catalog, board.grid, carrier)
    apz = _zone_end(board.grid, board.apz, "APZ") if board.apz is not None else None
    ends = [end for end in (rfz, apz) if end is not None]
    where = "im RfZ, Abgriff im NAR" if variant == "SI" else "im NAR"
    reason = f"Spannungsversorgung SMGW/Steuerbox: {_SUPPLY_DEVICE[variant]} {where} von Feld {carrier.field + 1}"
    reason += _ends_text(ends)
    if variant == "SA":
        reason += f" · VNB muss die SABO zulassen (sonst ZY{digit}N{leads}LS / ZY{digit}R{leads}SI)"
    tap = _existing_tap(board, carrier) if choice == "auto" else None
    if tap is not None:
        reason = f"Spannungsabgriff bereits geplant ({tap[0]}, {tap[1]})"
    suppressed = choice == "off" or tap is not None
    verified = not (digit == "5" and carrier.family == "meter_ehz")
    kit = item(f"accessory:{article}", article, label, 1, reason, group=GROUP_SUPPLY, verified=verified,
               override=choice, suppressed=suppressed)
    sabo = sabo_point(board.document, board.catalog, board.grid, carrier)
    runs = () if suppressed or sabo is None else tuple(
        make_run("supply", sabo, end.point, f"{article} · {_SUPPLY_DEVICE[variant]} → {end.name}") for end in ends)
    return _Part(items=(kit,), runs=runs, facts={"supply_existing": tap})


def _clamp(mm2: float | None, aluminium: bool) -> tuple[str, str] | None:
    """The first clamp whose range holds the conductor; the table's first for an unknown section."""
    table = _CLAMPS_AL if aluminium else _CLAMPS_CU
    if mm2 is None:
        return table[0][2], table[0][3]
    for low, high, article, label in table:
        if low <= mm2 <= high:
            return article, label
    return None


def _section_text(mm2: float | None, aluminium: bool) -> str:
    return f"Zuleitung {mm_text(mm2)} mm²{' Al' if aluminium else ''}" if mm2 is not None else ""


def _adapter_reason(effective: str, mm2: float | None, aluminium: bool) -> str:
    if effective == "K96ESA5":
        section = _section_text(mm2, aluminium)
        return "Einspeiseadapter manuell gewählt" + (f" · {section}" if section else "")
    if mm2 is None:
        return "Querschnitt unbekannt — angenommen"
    return f"Zuleitung {mm_text(mm2)} mm² ≤ 25 mm²"


def _clamp_reason(mm2: float | None, aluminium: bool) -> str:
    if mm2 is None:
        return f"{'Zuleitung Al, ' if aluminium else ''}Querschnitt unbekannt: eine Klemme je Leiter"
    over = " > 25 mm²" if mm2 > K96ESA5_MAX_MM2 else ""
    return f"{_section_text(mm2, aluminium)}{over}: eine Klemme je Leiter"


def _infeed(board: _Board) -> _Part:
    """(b) Einspeisung (O8) and (b2) the PEN split."""
    runs = busbar_runs(list(board.zones), ROLE_MAIN)
    if not runs:
        return _Part()
    parsed = parse_infeed(board.supply.get("incoming"))
    mm2, cores, aluminium = parsed["mm2"], parsed["cores"], parsed["aluminium"]
    choice = str(board.overrides["infeed"])
    effective = "auto" if choice == "off" else choice
    adapter = effective == "K96ESA5" or (
        effective == "auto" and (mm2 is None or mm2 <= K96ESA5_MAX_MM2) and not aluminium)
    extra = "".join(f" · Feld {min(z.field for z in run) + 1}: eigene Einspeisung" for run in runs[1:])
    facts: dict[str, Any] = {"infeed_size": mm2 if mm2 is not None and mm2 > CLAMP_MAX_MM2 else None}
    items: list[dict[str, Any]] = []
    article: str | None = None
    if adapter:
        article = "K96ESA5"
        items.append(item("accessory:K96ESA5", article, "Einspeiseadapter univers Z, 1–25 mm², 5-polig", len(runs),
                          _adapter_reason(effective, mm2, aluminium) + extra, group=GROUP_BUSBAR, verified=True,
                          override=choice, suppressed=choice == "off"))
    elif (clamp := _clamp(mm2, aluminium)) is not None:
        article = clamp[0]
        qty = (cores if cores in (4, 5) else 5) * len(runs)
        items.append(item(f"accessory:{article}", article, clamp[1], qty, _clamp_reason(mm2, aluminium) + extra,
                          group=GROUP_BUSBAR, verified=False, override=choice, suppressed=choice == "off"))
    elif mm2 is not None and mm2 <= CLAMP_MAX_MM2:
        facts["infeed_small"] = {"mm2": mm2, "aluminium": aluminium}
    facts["infeed"] = {"mm2": mm2, "cores": cores, "aluminium": aluminium, "article": article,
                       "assumed": adapter and choice == "auto" and mm2 is None}
    if board.supply.get("system") == "TN-C-S" and cores == 4:
        field_no = min(z.field for z in runs[0])
        facts["pen_field"] = field_no
        items.append(item("prep:pen_split", None, "PEN-Aufteilung im NAR (z. B. Hager N75B / ZM35PE)", 1,
                          f"Zuleitung 4-adrig im TN-C-S-System · PEN im NAR von Feld {field_no + 1} aufteilen",
                          group=GROUP_BUSBAR, verified=False))
    return _Part(items=tuple(items), facts=facts)


def _joints(board: _Board) -> _Part:
    """(c) Sammelschienenverbinder ZZ55SAVE (O7), one per joined field pair."""
    pairs = joint_pairs(list(board.zones))
    if not pairs:
        return _Part()
    count = len(pairs)
    spans = ", ".join(f"Feld {a + 1}–{b + 1}" for _, a, b in pairs)
    reason = f"1 Feldübergang: {spans}" if count == 1 else f"{count} Feldübergänge: {spans}"
    unchecked = unchecked_pairs(list(board.zones))
    reason += "".join(f" · Feld {a + 1}–{b + 1}: Zähler prüfen" for a, b in unchecked)
    choice = str(board.overrides["joints"])
    return _Part(items=(item("accessory:ZZ55SAVE", "ZZ55SAVE", "Sammelschienenverbinder Feld/Feld, 5-polig, 12×5 mm, 250 A",
                             count, reason, group=GROUP_BUSBAR, verified=not unchecked, override=choice,
                             suppressed=choice == "off"),))


def _lead_for(length_mm: float) -> str | None:
    return next((code for length, code in NETWORK_LEADS if length >= length_mm), None)


def _hager_lead(board: _Board, carrier: Carrier, apz: PlacedZone) -> str | None:
    position = "top" if apz.start < board.grid.units_per_field / 2 else "bottom"
    row = HAGER_NETWORK_TABLE.get((carrier.family, board.grid.height_mm, position))
    between = abs(apz.field - carrier.field) - 1
    return row[between] if row is not None and 0 <= between <= 3 else None


def _network(board: _Board) -> _Part:
    """(d) Netzwerkleitung APZ → RfZ / Zählerplatz (O5)."""
    carrier, apz = board.carrier, board.apz
    if carrier is None or apz is None:
        return _Part()
    ehz = carrier.family == "meter_ehz"
    target = (_carrier_rfz(board.document, board.catalog, board.grid, carrier) if ehz
              else _meter_place_end(board.grid, carrier))
    start = _zone_end(board.grid, apz, "APZ")
    if target is None or start is None:
        return _Part()
    run = make_run("network", start.point, target.point, "")
    reach = "RfZ über dem Zähler" if ehz else "Zählerplatz"
    reason = f"APZ (Feld {apz.field + 1}) → {reach} (Feld {target.field + 1})"
    metres = board.overrides["network_m"]
    code = _hager_lead(board, carrier, apz) if metres is None else None
    verified = True
    if metres is not None:
        code = _lead_for(metres * 1000)
        reason += f" · Länge {mm_text(metres)} m vorgegeben"
    elif code is not None:
        reason += " · Länge nach Hager-Bestelltabelle"
    else:
        code = _lead_for(run["lengthMm"] + (0 if ehz else NETWORK_RESERVE_MM))
        verified = False
        reason += f" · ≈ {mm_text(run['lengthMm'] / 1000)} m gemessen"
    if code is None:
        code = NETWORK_LEADS[-1][1]
        reason += " · länger als 5 m"
    choice = str(board.overrides["network"])
    label = f"Patch-Leitung RJ45 Cat 5e, spannungsfest, {mm_text(_LEAD_MM[code] / 1000)} m"
    lead = item(f"accessory:{code}", code, label, 1, reason, group=GROUP_NETWORK, verified=verified,
                override=choice, suppressed=choice == "off")
    runs = () if choice == "off" else ({**run, "label": f"{code} · RJ45"},)
    return _Part(items=(lead,), runs=runs)


def wire_dm(length_m: float | None, length_mm: float) -> int:
    """Decimetres per wire: the stored length, else the run + reserve in 0,5 m steps (§3.3 e)."""
    if length_m is not None:
        return math.floor(length_m * 10 + 0.5)
    run_dm = math.ceil(length_mm / 100)
    return (run_dm + WIRE_RESERVE_DM + 4) // 5 * 5


def _control(board: _Board, layout: BlockLayout | None, block: Mapping[str, Any] | None) -> _Part:
    """(e) the §14a block (O2–O4): its parts, then — with a target — wires and Lüsterklemme."""
    if layout is None or block is None:
        return _Part()
    count = len(layout.terminals)
    reason = f"§14a-Steuersignal-Klemmleiste, Feld {layout.field + 1} · {layout.rail_title}"
    items = [item(f"part:{part}", part, CONTROL_PARTS[part].label, qty, reason, group=GROUP_CONTROL, verified=True)
             for part, qty in ((PART_END_STOP, 2), (PART_TERMINAL, count), (PART_PLATE, 1))]
    target = control_target(board.document, board.catalog, board.carrier)
    if target is None:
        return _Part(items=tuple(items))
    mm2 = float(block["wire_mm2"])
    run = make_run("control", layout.point, target.point, f"{count} × H07V-K {mm_text(mm2)} mm²")
    dm = wire_dm(block.get("wire_length_m"), run["lengthMm"])
    colours: dict[str, list[str]] = {}
    for position, terminal in enumerate(layout.terminals, start=1):
        colours.setdefault(str(terminal["color"]), []).append(terminal["label"] or f"Klemme {position}")
    size = "1.5" if mm2 == 1.5 else "2.5"
    for colour, names in colours.items():
        items.append(item(f"wire:h07vk:{size}:{colour}", None, f"Aderleitung H07V-K 1 × {mm_text(mm2)} mm² {colour}",
                          (dm * len(names) + 9) // 10,
                          f"{', '.join(names)} · Klemmleiste → {target.name} · ≈ {mm_text(dm / 10)} m je Ader",
                          group=GROUP_CONTROL, verified=False, unit="m"))
    items.append(item("prep:luesterklemme", None, f"Lüsterklemme {count}-polig (von 12-poliger Leiste)", 1,
                      f"Gegenstück am {target.name} Feld {target.field + 1}", group=GROUP_CONTROL, verified=False))
    return _Part(items=tuple(items), runs=(run,))


# ── The analysis both outputs read ───────────────────────────────────────────


@dataclass(frozen=True)
class PrepState:
    """What ``cabinet_prep`` returns, plus the facts the prep findings need."""

    overrides: Mapping[str, Any]
    carrier: Carrier | None
    layout: BlockLayout | None
    items: tuple[dict[str, Any], ...]
    runs: tuple[dict[str, Any], ...]
    facts: Mapping[str, Any]

    @property
    def infeed(self) -> dict[str, Any] | None:
        return self.facts.get("infeed")

    def as_dict(self) -> dict[str, Any]:
        return {"items": list(self.items), "runs": list(self.runs), "infeed": self.infeed,
                "overrides": dict(self.overrides)}


def analyse_prep(document: Any, catalog: EnclosureCatalog, *, block: Any = DERIVE) -> PrepState | None:
    """The whole §3.3 derivation; None when the cabinet is unknown."""
    enclosure = enclosure_of(document)
    code = enclosure.get("code") if enclosure is not None else None
    if not isinstance(code, str) or catalog.enclosure(code) is None:
        return None
    parsed = resolve_block(document, block)
    supply = document.get("supply") if isinstance(document.get("supply"), dict) else {}
    board = _Board(document=document, catalog=catalog, grid=Grid.of(document, catalog),
                   overrides=prep_overrides(document), carrier=control_carrier(document, catalog),
                   apz=first_apz(document, catalog), zones=tuple(busbar_zones(document, catalog)), supply=supply)
    layout = control_block_layout(document, catalog, block=parsed)
    parts = (_supply(board), _infeed(board), _joints(board), _network(board), _control(board, layout, parsed))
    facts: dict[str, Any] = {}
    for part in parts:
        facts.update(part.facts)
    return PrepState(overrides=board.overrides, carrier=board.carrier, layout=layout,
                     items=tuple(entry for part in parts for entry in part.items),
                     runs=tuple(run for part in parts for run in part.runs), facts=facts)


def cabinet_prep(document: Any, catalog: EnclosureCatalog, *, block: Any = DERIVE) -> dict[str, Any] | None:
    """``{"items", "runs", "infeed", "overrides"}`` (§3.3); None when the cabinet is unknown."""
    state = analyse_prep(document, catalog, block=block)
    return state.as_dict() if state is not None else None


def parse_infeed(text_value: Any) -> dict[str, Any]:
    """§3.5's infeed parser: an alias of ``parse_cable_section``."""
    return parse_cable_section(text_value)
