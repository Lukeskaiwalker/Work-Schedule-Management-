"""The §14a Steuersignal-Klemmleiste of a Zählerschrank (docs/PANEL_ENCLOSURE_R4.md §2, §3.1, §3.2, §3.4).

Twin of ``apps/web/src/utils/enclosureControlBlock.ts``; both are pinned on
``enclosureFixtures.json`` (key ``control_block`` per board, table
``control_block_parse``).

The block is **stored** (``enclosure.control_block``: labels, colours, wire,
tube — user data only the editor seeds, R4-2) and read only through the
lenient ``parse_control_block`` of the schema. Where it sits is **derived**:

* the **carrier** is the first meter module from the left that is in use —
  a reserve field (R4-12) only when there is nothing else;
* the **rail** is an AAR rail of the carrier (BDEW Anwendungshilfe §3.5.2):
  the stored one when it is a candidate, else the first with room, else the
  first; the block is right-aligned and never drawn over the devices.

The block has its own part table (``CONTROL_PARTS``, disjoint from the
circuit terminals' ``TERMINAL_PARTS``) and never goes through
``place_terminals``, so every round-2 invariant ("no WAGO on AAR", "no
249-116") still holds for circuit terminals (R4-3).

Also here: the scene points the cabinet preparation measures runs between
(§3.4). This module never imports ``panel_enclosure_geometry`` — the
geometry imports it for the ``control_block`` box. Millimetres are computed
unrounded, sums run left → right in explicit loops, ``round1`` on the way out.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

# The §2.1 parsers and the constants they need live with the schema, which
# validates the stored block with them; re-exported here for the derivations.
from app.schemas.panel_enclosure import (  # noqa: F401  (re-exported)
    CONTROL_LABEL_MAX,
    DEFAULT_LABEL_MATERIAL,
    DEFAULT_WIRE_MM2,
    MAX_CONTROL_TERMINALS,
    METER_FAMILIES,
    TUBE_MATERIAL_IDS,
    WIRE_COLOURS,
    parse_control_block,
    parse_prep,
)
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_layout import (
    PLE_MM,
    as_int,
    default_rail_label,
    dicts,
    enclosure_device_width_mm,
    enclosure_of,
    ident,
    linked_rows,
    meter_zones,
    module_rails,
    module_spec,
    modules_of,
    row_devices,
    rows_of,
    spec_rails,
    zone_field,
)
from app.services.panel_enclosure_terminals import TOLERANCE_MM, round1


class _Derive:
    """``fn(..., block=DERIVE)`` reads the stored block; ``None`` means "no block"."""

    def __repr__(self) -> str:
        return "DERIVE"


DERIVE: Any = _Derive()


@dataclass(frozen=True)
class ControlPart:
    label: str
    width_mm: float
    marker: bool


PART_END_STOP, PART_TERMINAL, PART_PLATE = "249-116", "2002-1671", "2002-1692"
CONTROL_PARTS: dict[str, ControlPart] = {
    PART_END_STOP: ControlPart("WAGO 249-116 Endklammer", 6.0, False),
    PART_TERMINAL: ControlPart("WAGO 2002-1671 2-Leiter-Trenn- und Messklemme", 5.2, True),
    PART_PLATE: ControlPart("WAGO 2002-1692 Abschluss- und Zwischenplatte", 1.0, False),
}
DEFAULT_CONTROL_LABELS: tuple[str, ...] = ("UNSM", "60%", "30%", "0%", "UStve", "Stve")
#: Never grün-gelb (PE), hellblau/blau (N), single grün/gelb.
WIRE_COLOUR_STYLE: dict[str, str] = {
    "braun": "#8a5527", "schwarz": "#1c2024", "grau": "#8b929b", "rot": "#d0312d",
    "violett": "#7547c9", "weiß": "#ffffff", "orange": "#f08a24", "rosa": "#f2a7c3",
}
WIRE_RESERVE_DM = 3  # 300 mm per wire (150 per end)
NETWORK_RESERVE_MM = 300  # only for meter_3p (Hager: ≥ 30 cm free cable)
NETWORK_LEADS: tuple[tuple[int, str], ...] = (
    (400, "ZZ45WAN040"), (1000, "ZZ45WAN100"), (1500, "ZZ45WAN150"), (2000, "ZZ45WAN200"), (5000, "ZZ45WAN500"),
)
WIRE_LABEL_PIECE_MM = 15.0  # one sleeve; ungeprüft
WIRE_LABEL_MAX_DOTS = 48


def default_control_block() -> dict[str, Any]:
    """What ``placeModule`` seeds: t1…t6, the BDEW labels, the first six colours."""
    return {
        "terminals": [{"id": f"t{index + 1}", "label": label, "color": WIRE_COLOURS[index]}
                      for index, label in enumerate(DEFAULT_CONTROL_LABELS)],
        "rail": None, "wire_mm2": DEFAULT_WIRE_MM2, "wire_length_m": None,
        "label_material": DEFAULT_LABEL_MATERIAL, "off": False,
    }


def stored_block(document: Any) -> dict[str, Any] | None:
    enclosure = enclosure_of(document)
    return parse_control_block(enclosure.get("control_block")) if enclosure is not None else None


def resolve_block(document: Any, block: Any) -> dict[str, Any] | None:
    """The parsed block: read from the document for ``DERIVE``, else as given."""
    return stored_block(document) if block is DERIVE else block


# ── Carrier (§3.1) ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Carrier:
    module: dict[str, Any]
    spec: dict[str, Any]
    index: int

    @property
    def id(self) -> str:
        return ident(self.module.get("id"))

    @property
    def field(self) -> int:
        return as_int(self.module.get("field"))

    @property
    def family(self) -> str:
        return str(self.spec.get("family"))

    @property
    def reserve(self) -> bool:
        return self.spec.get("reserve_field") is True


def meter_candidates(document: Any, catalog: EnclosureCatalog) -> list[Carrier]:
    """Meter-family modules in (field, unit, list index) order (``_meter_modules``)."""
    found: list[Carrier] = []
    for index, module in enumerate(modules_of(document)):
        spec = module_spec(module, catalog)
        if spec is not None and spec.get("family") in METER_FAMILIES:
            found.append(Carrier(module, spec, index))
    return sorted(found, key=lambda c: (c.field, as_int(c.module.get("unit")), c.index))


def control_carrier(document: Any, catalog: EnclosureCatalog) -> Carrier | None:
    """The first candidate that is no reserve field, else the first; None without one."""
    candidates = meter_candidates(document, catalog)
    in_use = [candidate for candidate in candidates if not candidate.reserve]
    return (in_use or candidates or [None])[0]


# ── Scene points (§3.4) ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Grid:
    """The cabinet raster, with the spec model's defaults for an unknown code."""

    margin: float
    field_width: float
    unit: float
    units_per_field: int
    height_mm: int

    @classmethod
    def of(cls, document: Any, catalog: EnclosureCatalog) -> Grid:
        enclosure = enclosure_of(document)
        code = enclosure.get("code") if enclosure is not None else None
        spec = (catalog.enclosure(code) if isinstance(code, str) else None) or {}
        return cls(margin=float(as_int(spec.get("margin_mm"), 25)),
                   field_width=float(as_int(spec.get("field_width_mm"), 250)),
                   unit=float(as_int(spec.get("unit_mm"), 150)),
                   units_per_field=as_int(spec.get("units_per_field"), 1), height_mm=as_int(spec.get("height_mm")))

    def zone_origin(self, module: Mapping[str, Any], zone: Mapping[str, Any]) -> tuple[float, float]:
        x = self.margin + zone_field(module, zone) * self.field_width
        y = self.margin + (as_int(module.get("unit")) + as_int(zone.get("unit"))) * self.unit
        return x, y

    def rail_left(self, module: Mapping[str, Any], zone: Mapping[str, Any], rail: Mapping[str, Any]) -> float:
        zone_x, _ = self.zone_origin(module, zone)
        return zone_x + (self.field_width - as_int(rail.get("ple"), 1) * PLE_MM) / 2

    def rail_y(self, module: Mapping[str, Any], zone: Mapping[str, Any], rail: Mapping[str, Any]) -> float:
        _, zone_y = self.zone_origin(module, zone)
        return zone_y + as_int(rail.get("unit")) * self.unit + self.unit / 2

    def rail_centre(self, module: Mapping[str, Any], zone: Mapping[str, Any], rail: Mapping[str, Any]) -> tuple[float, float]:
        return (self.rail_left(module, zone, rail) + as_int(rail.get("ple"), 1) * PLE_MM / 2,
                self.rail_y(module, zone, rail))

    def meter_place(self, module: Mapping[str, Any], zone: Mapping[str, Any], k: int) -> tuple[float, float]:
        """Centre of place ``k`` of a ZF zone, in ``_meter_boxes``' expression order."""
        zone_x, zone_y = self.zone_origin(module, zone)
        places = max(1, as_int(zone.get("meter_places"), 1))
        zone_h = as_int(zone.get("units"), 1) * self.unit
        if zone.get("meter_type") == "3punkt":
            cell = zone_h / places
            return zone_x + self.field_width / 2, zone_y + k * cell + cell / 2
        cell = self.field_width / places
        return zone_x + k * cell + cell / 2, zone_y + zone_h / 2


def first_rail(zone: Mapping[str, Any]) -> dict[str, Any] | None:
    """The zone's first non-retired rail in spec order."""
    return next((rail for rail in dicts(zone.get("rails")) if not rail.get("retired")), None)


def first_meter_zone(spec: Mapping[str, Any]) -> dict[str, Any] | None:
    zones = meter_zones(spec)
    return zones[0][0] if zones else None


# ── Placement (§3.2) ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Candidate:
    zone: dict[str, Any]
    rail: dict[str, Any]
    position: int
    row_id: str | None
    devices_mm: float
    capacity_mm: float


@dataclass(frozen=True)
class BlockLayout:
    """The placement, unrounded; ``as_dict`` is the twinned output."""

    carrier: Carrier
    rail: Candidate
    rail_x: float
    rail_y: float
    offset_mm: float
    width_mm: float
    overflow: bool
    parts: tuple[dict[str, Any], ...]
    terminals: tuple[dict[str, Any], ...]

    @property
    def point(self) -> tuple[float, float]:
        """The block's centre on its rail: where the control wires leave."""
        return self.rail_x + self.offset_mm + self.width_mm / 2, self.rail_y

    @property
    def field(self) -> int:
        return zone_field(self.carrier.module, self.rail.zone)

    @property
    def rail_title(self) -> str:
        return default_rail_label(self.carrier.module, self.rail.zone, self.rail.position)

    def as_dict(self) -> dict[str, Any]:
        return {
            "moduleId": self.carrier.id, "railKey": str(self.rail.rail.get("key")), "field": self.field,
            "railTitle": self.rail_title, "railX": round1(self.rail_x), "railY": round1(self.rail_y),
            "offsetMm": round1(self.offset_mm), "widthMm": round1(self.width_mm),
            "devicesMm": round1(self.rail.devices_mm), "capacityMm": round1(self.rail.capacity_mm),
            "overflow": self.overflow,
            "parts": [{**part, "offsetMm": round1(part["offsetMm"]), "widthMm": round1(part["widthMm"])}
                      for part in self.parts],
        }


def candidate_rails(document: Any, catalog: EnclosureCatalog, carrier: Carrier) -> list[Candidate]:
    """The carrier's AAR DIN rails, top → bottom by (zone unit + rail unit), ties in spec order."""
    linked = linked_rows(document, catalog)
    rows = {row["id"]: row for row in rows_of(document)}
    names = module_rails(carrier.module)
    found: list[tuple[int, Candidate]] = []
    for zone, rail, position in spec_rails(carrier.spec):
        if zone.get("type") != "AAR" or rail.get("retired") or rail.get("mount") != "rail":
            continue
        key = str(rail.get("key"))
        row_id = names.get(key)
        if row_id is not None and linked.get(row_id) != (carrier.id, key):
            row_id = None
        devices = 0.0
        for device in row_devices(rows.get(row_id) if row_id is not None else None):
            devices += enclosure_device_width_mm(device, rail)
        capacity = as_int(rail.get("ple"), 1) * PLE_MM
        found.append((as_int(zone.get("unit")) + as_int(rail.get("unit")),
                      Candidate(zone, rail, position, row_id, devices, capacity)))
    return [candidate for _, candidate in sorted(found, key=lambda pair: pair[0])]


def block_parts(terminals: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], float]:
    """249-116 | n × 2002-1671 | 2002-1692 | 249-116, offsets relative to the block; total width."""
    sequence: list[tuple[str, dict[str, Any] | None, int | None]] = [(PART_END_STOP, None, None)]
    sequence += [(PART_TERMINAL, terminal, position) for position, terminal in enumerate(terminals, start=1)]
    sequence += [(PART_PLATE, None, None), (PART_END_STOP, None, None)]
    cursor = 0.0
    parts: list[dict[str, Any]] = []
    for part_id, terminal, position in sequence:
        width = CONTROL_PARTS[part_id].width_mm
        parts.append({
            "partId": part_id, "terminalId": terminal["id"] if terminal else None,
            "label": terminal["label"] if terminal else None, "color": terminal["color"] if terminal else None,
            "position": position, "offsetMm": cursor, "widthMm": width,
        })
        cursor += width
    return parts, cursor


def _choose_rail(candidates: list[Candidate], stored: str | None, block_mm: float) -> Candidate:
    for candidate in candidates:
        if stored is not None and str(candidate.rail.get("key")) == stored:
            return candidate
    for candidate in candidates:
        if candidate.devices_mm + block_mm <= candidate.capacity_mm + TOLERANCE_MM:
            return candidate
    return candidates[0]


def control_block_layout(document: Any, catalog: EnclosureCatalog, *, block: Any = DERIVE) -> BlockLayout | None:
    """The placement with unrounded numbers; None when there is nothing to place."""
    parsed = resolve_block(document, block)
    if parsed is None or parsed.get("off") or not parsed.get("terminals"):
        return None
    carrier = control_carrier(document, catalog)
    if carrier is None:
        return None
    candidates = candidate_rails(document, catalog, carrier)
    if not candidates:
        return None
    parts, block_mm = block_parts(list(parsed["terminals"]))
    chosen = _choose_rail(candidates, parsed.get("rail"), block_mm)
    grid = Grid.of(document, catalog)
    return BlockLayout(
        carrier=carrier, rail=chosen,
        rail_x=grid.rail_left(carrier.module, chosen.zone, chosen.rail),
        rail_y=grid.rail_y(carrier.module, chosen.zone, chosen.rail),
        offset_mm=max(chosen.capacity_mm - block_mm, chosen.devices_mm), width_mm=block_mm,
        overflow=chosen.devices_mm + block_mm > chosen.capacity_mm + TOLERANCE_MM,
        parts=tuple(parts), terminals=tuple(parsed["terminals"]),
    )


def place_control_block(document: Any, catalog: EnclosureCatalog, *, block: Any = DERIVE) -> dict[str, Any] | None:
    """§3.2's output (camelCase, millimetres ``round1``); None when nothing is placed."""
    layout = control_block_layout(document, catalog, block=block)
    return layout.as_dict() if layout is not None else None
