"""What the cabinet sheet reads from the cabinet itself (docs/SCHALTPLAN_STROMLAUF.md §5.2).

Split out of ``schaltplan_stromlauf_cabinet`` (lanes): the devices on cabinet
rails, the meter side, and every reader of the cabinet preparation
(``analyse_prep``, R4 §3.3) — the NAR segments with their infeed and joints,
the supply kit or the existing tap, the network lead and the §14a block.
They read ``cabinet_prep``'s items, runs and facts and its public helpers;
nothing here re-derives an article, a quantity or a length.

* **Meter side**: devices on RfZ/APZ rails and the small LS (≤ 10 A) tapping
  a NAR are the grid operator's side, fed before the SLS. They hang off the
  supply lead on the cabinet sheet, never under a customer RCD; the Übersicht
  draws the same set as its "Messsystem" box.

Pure.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_control_block import Grid, first_meter_zone
from app.services.panel_enclosure_layout import (
    SUPPLY_ZONE_TYPES,
    dicts,
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
from app.services.panel_enclosure_layout import ident as stored_id
from app.services.panel_enclosure_prep import (
    ROLE_MAIN,
    PrepState,
    busbar_runs,
    busbar_zones,
    control_target,
    first_apz,
    is_small_tap,
    supply_rfz_end,
)
from app.services.schaltplan_stromlauf_types import Unit, ident, make_unit

_END_TYPES: Mapping[str, str] = {"RfZ": "RFZ", "APZ": "APZ", "Zählerplatz": "RFZ"}


# ── Devices on cabinet rails ─────────────────────────────────────────────────


@dataclass(frozen=True)
class Placed:
    """A device on a cabinet rail."""

    device: dict[str, Any]
    module: dict[str, Any]
    zone: dict[str, Any]
    rail: dict[str, Any]
    slot: int  # left → right on its rail

    @property
    def id(self) -> str:
        return ident(self.device)

    @property
    def kind(self) -> str:
        return str(self.device.get("kind") or "")

    @property
    def zone_type(self) -> str:
        return str(self.zone.get("type"))

    @property
    def module_id(self) -> str:
        return stored_id(self.module.get("id"))

    @property
    def field(self) -> int:
        return zone_field(self.module, self.zone)


def placed_devices(document: Any, catalog: EnclosureCatalog) -> list[Placed]:
    """Every device on a linked cabinet rail, by module, spec rail order, slot."""
    linked = linked_rows(document, catalog)
    rows = {row["id"]: row for row in rows_of(document)}
    out: list[Placed] = []
    for module in modules_of(document):
        spec = module_spec(module, catalog)
        if spec is None:
            continue
        names = module_rails(module)
        for zone, rail, _position in spec_rails(spec):
            key = str(rail.get("key"))
            row_id = names.get(key)
            if row_id is None or linked.get(row_id) != (stored_id(module.get("id")), key):
                continue
            out += [Placed(device, module, zone, rail, slot) for slot, device in enumerate(row_devices(rows.get(row_id)))]
    return out


def is_meter_side(placed: Placed) -> bool:
    return placed.zone_type in SUPPLY_ZONE_TYPES or (placed.zone_type == "NAR" and is_small_tap(placed.device))


def meter_side_ids(document: Any, catalog: EnclosureCatalog) -> frozenset[str]:
    """Devices on RfZ/APZ rails and the small LS (≤ 10 A) tapping a NAR."""
    return frozenset(p.id for p in placed_devices(document, catalog) if is_meter_side(p))



@dataclass(frozen=True)
class NarSegment:
    """One ``main`` busbar zone on the vertical bus."""

    field: int
    zone: str               # "NAR" | "SAS"
    code: str
    reserve: bool
    run: int
    joint: bool             # joined to the segment above (same run)
    infeed: str             # on a run's first segment: "K96ESA5" / "5 × K96F"; else ""
    key: tuple[str, str] = ("", "")

    @property
    def label(self) -> str:
        """"Feld 1 · NAR · ZH33XL (Reservefeld)"."""
        zone = "Sammelschiene" if self.zone == "SAS" else self.zone
        return f"Feld {self.field + 1} · {zone} · {self.code}" + (" (Reservefeld)" if self.reserve else "")


@dataclass(frozen=True)
class SupplyKit:
    """The Spannungsversorgung of RfZ/APZ (R4 §3.3 a), or the tap that replaces it."""

    article: str            # "ZY3N2SA"; "" for an existing tap
    device: str             # "SABO 1,6 A" | "LS 6 A" | "Sicherungsbox 1 A"; the tap's rail title
    ends: tuple[str, ...]   # "RfZ Feld 1", "APZ Feld 3"
    tap: Unit | None = None
    tap_name: str = ""

    @property
    def label(self) -> str:
        """"ZY3N2SA · SABO 1,6 A" / "Abgriff F9 (F1 · RfZ)"."""
        return f"{self.article} · {self.device}" if self.article else f"Abgriff {self.tap_name} ({self.device})"


@dataclass(frozen=True)
class NetworkLead:
    article: str            # "ZZ45WAN100"
    start: str              # "APZ Feld 3"
    end: str                # "RfZ Feld 1" | "Zählerplatz Feld 1"


@dataclass(frozen=True)
class ControlBand:
    """The §14a block as the band draws it (R4 §2.1, §3.2)."""

    terminals: tuple[tuple[int, str, str], ...]  # (position, label, colour), left → right
    rail_title: str          # "F1 · AAR 1"
    wires: str               # "6 × H07V-K 2,5 mm²"; "" without a target
    target: str              # "RfZ Feld 1" | "APZ Feld 3"; "" without one
    missing: str             # without a target: why ("im Schrank fehlt ein APZ" / "Feld 1 hat keinen RfZ")
    luester: str             # "Lüsterklemme 6-polig (von 12-poliger Leiste)"



# ── The cabinet preparation ─────────────────────────────────────────────────


def prep_item(state: PrepState, group: str, *keys: str) -> dict[str, Any] | None:
    return next((e for e in state.items if e["group"] == group and (not keys or e["key"] in keys)), None)


def infeed_text(state: PrepState, runs: int) -> str:
    """"K96ESA5" (one per run) or "{cores} × {clamp}" per run; "" when off or none."""
    for entry in state.items:
        if entry["group"] != "busbar" or entry["key"] in ("accessory:ZZ55SAVE", "prep:pen_split") or entry["suppressed"]:
            continue
        if entry["articleNo"] == "K96ESA5":
            return "K96ESA5"
        return f"{entry['qty'] // max(1, runs)} × {entry['articleNo']}"
    return ""


def nar_segments(document: Any, catalog: EnclosureCatalog, state: PrepState) -> list[NarSegment]:
    runs = busbar_runs(busbar_zones(document, catalog), ROLE_MAIN)
    infeed = infeed_text(state, len(runs))
    out: list[NarSegment] = []
    for number, run in enumerate(runs):
        for index, zone in enumerate(run):
            kind = str(zone.placed.zone.get("type"))
            out.append(NarSegment(zone.field, kind, text(zone.placed.module.get("code")),
                                  zone.placed.spec.get("reserve_field") is True, number, index > 0,
                                  infeed if index == 0 else "", (zone.placed.module_id, kind)))
    return out


def _kit_device(state: PrepState, item: Mapping[str, Any]) -> str:
    run = next((r for r in state.runs if r["kind"] == "supply"), None)
    if run is not None:
        return run["label"].split(" · ", 1)[-1].rsplit(" → ", 1)[0]
    return str(item["label"]).split(", ")[1] if ", " in str(item["label"]) else ""


def supply_kit(document: Any, catalog: EnclosureCatalog, state: PrepState, side: Sequence[Placed]) -> SupplyKit | None:
    carrier = state.carrier
    if carrier is None:
        return None
    rfz = supply_rfz_end(document, catalog, Grid.of(document, catalog), carrier)
    apz = first_apz(document, catalog)
    ends = tuple(e for e in (f"{rfz.name} Feld {rfz.field + 1}" if rfz else "",
                             f"APZ Feld {apz.field + 1}" if apz else "") if e)
    item = prep_item(state, "supply")
    if item is not None and not item["suppressed"]:
        return SupplyKit(str(item["articleNo"]), _kit_device(state, item), ends)
    existing = state.facts.get("supply_existing")
    if existing is None:
        return None
    bmk, title = existing
    tap = next((p for p in side if make_unit(p.device).bmk == bmk), None)
    return SupplyKit("", title, ends, make_unit(tap.device) if tap is not None else None, bmk)


def kit_devices(kit: SupplyKit | None, side: Sequence[Placed]) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """The meter-side devices per lead end (by zone type); the rest on the first end."""
    ends = kit.ends if kit is not None else ()
    tap_id = kit.tap.id if kit is not None and kit.tap is not None else ""
    names: dict[str, list[str]] = {end: [] for end in ends}
    spare: list[str] = []
    for placed in side:
        if placed.id == tap_id:
            continue
        end = next((e for e in ends if _END_TYPES.get(e.split(" ", 1)[0]) == placed.zone_type), None)
        (names[end] if end is not None else spare).append(make_unit(placed.device).bmk)
    if spare:
        first = ends[0] if ends else ""
        names = {**names, first: [*names.get(first, []), *spare]}
    return tuple((end, tuple(found)) for end, found in names.items() if found)


def network_lead(document: Any, catalog: EnclosureCatalog, state: PrepState) -> NetworkLead | None:
    item, carrier, apz = prep_item(state, "network"), state.carrier, first_apz(document, catalog)
    if item is None or item["suppressed"] or carrier is None or apz is None:
        return None
    if carrier.family == "meter_ehz":
        zone = next((z for z in dicts(carrier.spec.get("zones")) if z.get("type") == "RFZ"), None)
        name = "RfZ"
    else:
        zone, name = first_meter_zone(carrier.spec), "Zählerplatz"
    field = zone_field(carrier.module, zone) if zone is not None else carrier.field
    return NetworkLead(str(item["articleNo"]), f"APZ Feld {apz.field + 1}", f"{name} Feld {field + 1}")


def control_band(document: Any, catalog: EnclosureCatalog, state: PrepState) -> ControlBand | None:
    layout = state.layout
    if layout is None:
        return None
    terminals = tuple((position, str(t["label"]), str(t["color"])) for position, t in enumerate(layout.terminals, 1))
    run = next((r for r in state.runs if r["kind"] == "control"), None)
    target = control_target(document, catalog, state.carrier)
    luester = prep_item(state, "control", "prep:luesterklemme")
    carrier = layout.carrier
    # The wording of encl.control_block_target (R4 §4).
    missing = "im Schrank fehlt ein APZ" if carrier.family == "meter_3p" else f"Feld {carrier.field + 1} hat keinen RfZ"
    return ControlBand(terminals=terminals, rail_title=layout.rail_title,
                       wires=str(run["label"]) if run is not None else "",
                       target=f"{target.name} Feld {target.field + 1}" if target is not None else "",
                       missing="" if target is not None else missing,
                       luester=str(luester["label"]) if luester is not None else "")
