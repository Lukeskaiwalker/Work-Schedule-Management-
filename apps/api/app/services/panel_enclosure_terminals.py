"""WAGO terminals on the cabinet's rails (docs/PANEL_ENCLOSURE_R2.md §2.1–§3).

Twin of ``apps/web/src/utils/enclosureTerminals.ts``; both are pinned on
``enclosureFixtures.json`` (keys ``terminal_skip``, ``terminal_placement``).

The terminals stay **derived** (R1). The placement is a pure function of the
document and the catalogue:

* the **skip set** (R3): every device on a rail whose zone is not a WAGO zone
  (AAR, NAR, RfZ, APZ) gets no terminal, whatever its flag says;
* the **terminal rails** (R2): the first two VT rails of each cabinet field,
  top → bottom, reserved whether or not anything is on them;
* the **home field** of a strip (R4): where most of its circuits are; a field
  without terminal rails sends its strips to the nearest one (R6);
* the **packing** (R5): the stored order or Leisten-then-Blocks, next-fit
  onto rail 1 then rail 2, then first-fit for what is left; never a third
  rail, never another field;
* the **rail parts** (R7): one end plate per rail that holds a strip,
  matching its last terminal block. No end stops (owner, 2026-10-22).

The only stored input is ``module.terminal_order`` (§2.1), read through the
lenient ``parse_terminal_order`` (it lives in ``schemas/panel_enclosure.py``,
which validates the key with it) here and in the schema alike.

Numbers are computed unrounded and ``round1`` is applied on the way out.
Every float sum runs left → right in an explicit loop, never ``sum()`` (it
compensates on Python 3.12, JavaScript does not), so both twins add the
same numbers in the same order and agree to the last bit.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

# The §2.1 parser lives with the schema (which needs it at class definition
# and must not import this module); re-exported here for the derivations.
from app.schemas.panel_enclosure import (  # noqa: F401  (re-exported)
    FIELD_OFFSET_KEYS,
    MAX_ORDER_STRIPS,
    STRIP_ID_MAX,
    parse_terminal_order,
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
    module_rails,
    module_spec,
    modules_of,
    row_devices,
    rows_of,
    spec_rails,
    zone_field,
)
from app.services.schaltplan_terminal_rules import END_PART_IDS, OUTGOING_PART_IDS, TERMINAL_PART_ORDER, TERMINAL_PARTS
from app.services.schaltplan_terminals import STRIP_KIND_BLOCK, STRIP_KIND_LEISTE, derive_terminals

#: Zones whose circuits keep their WAGO terminals (R3). AAR, NAR, RfZ and APZ
#: are the grid operator's side of the meter field; ZF and COVER hold none.
WAGO_ZONE_TYPES: frozenset[str] = frozenset({"VT", "VF", "MM", "SAS"})
#: Zones whose rails can be terminal rails (R2).
TERMINAL_RAIL_ZONE_TYPES: frozenset[str] = frozenset({"VT"})
TERMINAL_RAILS_PER_FIELD = 2
#: What terminals may use of a 12-PLE rail. UNVERIFIED (Q1a): the U842B rail
#: is ≈ 248 mm, but frame screws, U84T pieces and the cover edges have not
#: been measured. 210 mm is the 12-PLE figure, the one length known to be
#: clear of the frame. The Werkstatt measures; then set _VERIFIED.
TERMINAL_RAIL_USABLE_MM = 210.0
#: True flips ``encl.terminals_overflow`` from info to warn (§4.1).
TERMINAL_RAIL_USABLE_VERIFIED = False
STANDARD_RAIL_PLE = 12
TOLERANCE_MM = 0.05
#: A served spec with this non-retired fitting has insulated rails (R8, §2.2).
INSULATED_RAILS_FITTING = "u84t"
#: Hand-placed "Reihenklemme N/PE" on a terminal rail: a placeholder for the
#: strip space pre-R2 boards reserved by hand, never counted (§3.6).
PLACEHOLDER_KINDS: frozenset[str] = frozenset({"terminal"})

ORDER_DEFAULT, ORDER_MANUAL, ORDER_IGNORED = "default", "manual", "ignored"
PART_ROLE_END_PLATE = "end_plate"


def round1(value: float) -> float:
    """``floor(v·10 + 0.5) / 10``, as ``panel_enclosure_geometry.round1`` (not
    imported: the geometry will read the placement, so it imports this module)."""
    return math.floor(value * 10 + 0.5) / 10


# ── Which circuits get terminals (§3.1) ──────────────────────────────────────


@dataclass(frozen=True)
class BoardTerminals:
    """The groups the placement may use: derived WITH the board's skip set.

    ``place_terminals`` accepts nothing else, so groups derived without the
    skip set (other X numbers) cannot be placed by mistake.
    """

    skip: frozenset[str]
    groups: tuple[dict[str, Any], ...]


def _linked_rails(document: Any, catalog: EnclosureCatalog) -> dict[str, tuple[dict, dict, dict]]:
    """row id → (module, zone, rail) for every row "im Schrank"; the rule of
    ``panel_enclosure_layout.linked_rows`` (the first name wins)."""
    existing = {row["id"] for row in rows_of(document)}
    out: dict[str, tuple[dict, dict, dict]] = {}
    for module in modules_of(document):
        spec = module_spec(module, catalog)
        if spec is None:
            continue
        rails = {str(rail.get("key")): (zone, rail) for zone, rail, _ in spec_rails(spec)}
        for key, row_id in module_rails(module).items():
            if key in rails and row_id in existing and row_id not in out:
                out[row_id] = (module, *rails[key])
    return out


def terminal_skip(document: Any, catalog: EnclosureCatalog) -> frozenset[str]:
    """Ids of every device on a resolvable rail outside ``WAGO_ZONE_TYPES``;
    empty without a cabinet, so a legacy board derives exactly as before."""
    if enclosure_of(document) is None:
        return frozenset()
    linked = _linked_rails(document, catalog)
    skip: set[str] = set()
    for row in rows_of(document):
        link = linked.get(row["id"])
        if link is None or str(link[1].get("type")) in WAGO_ZONE_TYPES:
            continue
        skip.update(ident(device.get("id")) for device in row_devices(row) if ident(device.get("id")))
    return frozenset(skip)


def board_terminals(document: Any, catalog: EnclosureCatalog) -> BoardTerminals:
    """The only way to the groups a placement uses (§3.1)."""
    skip = terminal_skip(document, catalog)
    if not isinstance(document, Mapping) or not isinstance(document.get("rows"), (list, type(None))):
        return BoardTerminals(skip, ())
    return BoardTerminals(skip, tuple(derive_terminals(dict(document), skip=skip)))


# ── Terminal rails (§3.2) ────────────────────────────────────────────────────


@dataclass(frozen=True)
class TerminalRail:
    field: int            # cabinet field (zone_field(module, zone))
    position: int         # 0 = top terminal rail, 1 = second
    module_id: str
    rail_key: str
    row_id: str | None    # linked row, if any (back-compat devices)
    title: str            # generated label, "F2 · Verteiler 1"
    capacity_mm: float    # TERMINAL_RAIL_USABLE_MM on a 12-PLE rail, else ple × 17.5
    devices_mm: float     # Σ widths of non-placeholder devices on row_id
    insulated: bool       # served spec has the fitting "u84t"


def _insulated(spec: Mapping[str, Any]) -> bool:
    return any(f.get("key") == INSULATED_RAILS_FITTING and not f.get("retired") for f in dicts(spec.get("fittings")))


def _devices_mm(row: Mapping[str, Any] | None, rail: Mapping[str, Any]) -> float:
    total = 0.0
    for device in row_devices(row):
        if str(device.get("kind") or "") not in PLACEHOLDER_KINDS:
            total += enclosure_device_width_mm(device, rail)
    return total


def terminal_rails(document: Any, catalog: EnclosureCatalog) -> dict[int, tuple[TerminalRail, ...]]:
    """field → its terminal rails: the first two non-retired VT rails on a DIN
    mount, by (module unit + zone unit + rail unit, module id, rail key)."""
    rows = {row["id"]: row for row in rows_of(document)}
    linked = _linked_rails(document, catalog)
    candidates: dict[int, list[tuple[tuple[int, str, str], dict[str, Any]]]] = {}
    for module in modules_of(document):
        spec = module_spec(module, catalog)
        if spec is None:
            continue
        module_id, names, insulated = ident(module.get("id")), module_rails(module), _insulated(spec)
        for zone, rail, position in spec_rails(spec):
            if str(zone.get("type")) not in TERMINAL_RAIL_ZONE_TYPES or rail.get("mount") != "rail" or rail.get("retired"):
                continue
            key = str(rail.get("key"))
            row_id = names.get(key)
            link = linked.get(row_id) if row_id is not None else None
            # The row counts only where it is linked: the first name wins (a
            # row named twice by a hand edit belongs to its first rail).
            if link is None or link[0] is not module or str(link[2].get("key")) != key:
                row_id = None
            ple = as_int(rail.get("ple"), STANDARD_RAIL_PLE)
            field = zone_field(module, zone)
            candidates.setdefault(field, []).append((
                (as_int(module.get("unit")) + as_int(zone.get("unit")) + as_int(rail.get("unit")), module_id, key),
                {"module_id": module_id, "rail_key": key, "row_id": row_id,
                 "title": default_rail_label(module, zone, position),
                 "capacity_mm": TERMINAL_RAIL_USABLE_MM if ple == STANDARD_RAIL_PLE else ple * PLE_MM,
                 "devices_mm": _devices_mm(rows.get(row_id) if row_id else None, rail), "insulated": insulated},
            ))
    out: dict[int, tuple[TerminalRail, ...]] = {}
    for field in sorted(candidates):
        chosen = sorted(candidates[field], key=lambda pair: pair[0])[:TERMINAL_RAILS_PER_FIELD]
        out[field] = tuple(TerminalRail(field=field, position=index, **data) for index, (_, data) in enumerate(chosen))
    return out


def terminal_rail_keys(document: Any, catalog: EnclosureCatalog) -> frozenset[tuple[str, str]]:
    """(module id, rail key) of every terminal rail: the reserved rails."""
    return frozenset((rail.module_id, rail.rail_key) for rails in terminal_rails(document, catalog).values() for rail in rails)


# ── Home fields (§3.3) ───────────────────────────────────────────────────────


def device_fields(document: Any, catalog: EnclosureCatalog) -> dict[str, int]:
    """device id → cabinet field of the rail its row is linked to (resolvable rails only)."""
    linked = _linked_rails(document, catalog)
    out: dict[str, int] = {}
    for row in rows_of(document):
        link = linked.get(row["id"])
        if link is None:
            continue
        field = zone_field(link[0], link[1])
        for device in row_devices(row):
            device_id = ident(device.get("id"))
            if device_id and device_id not in out:
                out[device_id] = field
    return out


def strip_home_field(strip: Mapping[str, Any], fields_of: Mapping[str, int]) -> int | None:
    """R4: a Block's own device's field; a Leiste's field with the most of its
    circuits, a tie to the first circuit's field; None when none is in a field."""
    if strip.get("kind") == STRIP_KIND_BLOCK:
        return fields_of.get(str(strip.get("device_id") or ""))
    order: list[int] = []  # field of each distinct circuit, in strip order
    seen: set[str] = set()
    for terminal in strip.get("terminals") or []:
        device_id = terminal.get("device_id")
        if terminal.get("part_id") not in OUTGOING_PART_IDS or not device_id or device_id in seen:
            continue
        seen.add(device_id)
        if device_id in fields_of:
            order.append(fields_of[device_id])
    if not order:
        return None
    counts = Counter(order)
    best = max(counts.values())
    return next(field for field in order if counts[field] == best)


# ── Packing (§3.4) ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Strip:
    id: str
    no: int
    kind: str
    x_label: str
    group_id: str
    home_field: int | None
    head_field: int | None
    width: float              # Σ part widths, left → right
    end_plate: str | None     # the plate a rail ending in this strip takes
    tail_mm: float            # width of its trailing END_PART_IDS parts (the 2009-305)


def _strip_of(group: Mapping[str, Any], strip: Mapping[str, Any], fields_of: Mapping[str, int]) -> _Strip:
    terminals = list(strip["terminals"])
    width = 0.0
    for terminal in terminals:
        width += float(terminal["width_mm"])
    tail = 0.0
    last_block: Mapping[str, Any] | None = None
    for terminal in reversed(terminals):
        if terminal["part_id"] not in END_PART_IDS:
            last_block = terminal
            break
        tail += float(terminal["width_mm"])
    part = TERMINAL_PARTS.get(str(last_block["part_id"])) if last_block is not None else None
    head = group.get("head_device")
    head_id = ident(head.get("id")) if isinstance(head, Mapping) else ""
    return _Strip(
        id=str(strip["strip_id"]), no=int(strip["strip_no"]), kind=str(strip["kind"]), x_label=str(strip["x_label"]),
        group_id=str(group["group_id"]), home_field=strip_home_field(strip, fields_of),
        head_field=fields_of.get(head_id) if head_id else None, width=width,
        end_plate=part.end_plate if part is not None else None, tail_mm=tail,
    )


def _plate_mm(strip: _Strip) -> float:
    return TERMINAL_PARTS[strip.end_plate].width_mm if strip.end_plate else 0.0


def _used(rail: TerminalRail, strips: Sequence[_Strip]) -> float:
    """devices, then each strip left → right, then the last strip's end plate."""
    used = rail.devices_mm
    if not strips:
        return used
    for strip in strips:
        used += strip.width
    return used + _plate_mm(strips[-1])


def _fits(rail: TerminalRail, strips: Sequence[_Strip]) -> bool:
    return _used(rail, strips) <= rail.capacity_mm + TOLERANCE_MM


def field_order(document: Any, catalog: EnclosureCatalog, field: int,
                rails: Mapping[int, Sequence[TerminalRail]] | None = None) -> dict[str, Any] | None:
    """The stored order of a field: ``{"module_id", "strips", "rail2_from"}``.

    The field's modules are walked in terminal-rail order; the first one that
    carries an entry for this field (keyed by the field's offset inside the
    module) wins.
    """
    rails = terminal_rails(document, catalog) if rails is None else rails
    by_id: dict[str, dict[str, Any]] = {}
    for module in modules_of(document):
        by_id.setdefault(ident(module.get("id")), module)
    seen: set[str] = set()
    for rail in rails.get(field, ()):
        module = by_id.get(rail.module_id)
        if rail.module_id in seen or module is None:
            continue
        seen.add(rail.module_id)
        entry = (parse_terminal_order(module.get("terminal_order")) or {}).get(str(field - as_int(module.get("field"))))
        if entry is not None:
            return {"module_id": rail.module_id, **entry}
    return None


def effective_sequence(default: Sequence[Any], stored: Sequence[str]) -> list[Any]:
    """The stored ids that are current strips, in stored order; every other
    strip merged in right after its predecessor in ``default`` (front if none)."""
    by_id = {strip.id: strip for strip in default}
    seq = [by_id[strip_id] for strip_id in dict.fromkeys(stored) if strip_id in by_id]
    listed = {strip.id for strip in seq}
    for n, strip in enumerate(default):
        if strip.id in listed:
            continue
        at = 0 if n == 0 else next(i for i, s in enumerate(seq) if s.id == default[n - 1].id) + 1
        seq.insert(at, strip)
        listed.add(strip.id)
    return seq


def _place_field(field: int, rails: Sequence[TerminalRail], strips: Sequence[_Strip],
                 order: Mapping[str, Any] | None) -> dict[str, Any]:
    default = sorted(strips, key=lambda s: (s.kind != STRIP_KIND_LEISTE, s.no))
    seq = effective_sequence(default, order["strips"] if order else ())
    status = ORDER_MANUAL if order else ORDER_DEFAULT
    mark = order["rail2_from"] if order else None
    if mark is not None and len(rails) == 2:
        k = next((i for i, s in enumerate(seq) if s.id == mark), None)
        if k is not None and _fits(rails[0], seq[:k]) and _fits(rails[1], seq[k:]):
            return _layout(field, rails, [seq[:k], seq[k:]], [], status, order)
        if k is not None:
            status = ORDER_IGNORED  # a stored split that no longer fits is never kept
    content: list[list[_Strip]] = [[] for _ in rails]
    cursor, left = 0, []
    for strip in seq:  # next-fit keeps X1, X2 … in reading order
        for i in range(cursor, len(rails)):
            if _fits(rails[i], [*content[i], strip]):
                content[i].append(strip)
                cursor = i
                break
        else:
            left.append(strip)
    unplaced = []
    for strip in left:  # first-fit: the end of rail 1, else the end of rail 2
        for i, rail in enumerate(rails):
            if _fits(rail, [*content[i], strip]):
                content[i].append(strip)
                break
        else:
            unplaced.append(strip)
    return _layout(field, rails, content, unplaced, status, order)


def _rail_out(rail: TerminalRail, strips: Sequence[_Strip]) -> dict[str, Any]:
    cursor = rail.devices_mm
    placed: list[dict[str, Any]] = []
    offset = cursor
    for index, strip in enumerate(strips):
        offset = cursor
        # The plate sits inside the last strip when it ends in a 2009-305.
        extent = strip.width + (_plate_mm(strip) if index == len(strips) - 1 and strip.tail_mm > 0 else 0.0)
        placed.append({
            "stripId": strip.id, "stripNo": strip.no, "kind": strip.kind, "xLabel": strip.x_label,
            "groupId": strip.group_id, "homeField": strip.home_field, "headField": strip.head_field,
            "offsetMm": round1(offset), "widthMm": round1(strip.width), "extentMm": round1(extent),
        })
        cursor += extent
    parts: list[dict[str, Any]] = []
    if strips and strips[-1].end_plate:
        last = strips[-1]
        # After the last terminal block, before a trailing 2009-305. Drawn on
        # the right: the plate's open-side orientation is UNVERIFIED.
        parts.append({"partId": last.end_plate, "role": PART_ROLE_END_PLATE,
                      "offsetMm": round1(offset + last.width - last.tail_mm), "widthMm": round1(_plate_mm(last))})
    return {
        "moduleId": rail.module_id, "railKey": rail.rail_key, "rowId": rail.row_id, "position": rail.position,
        "title": rail.title, "capacityMm": round1(rail.capacity_mm), "devicesMm": round1(rail.devices_mm),
        "usedMm": round1(_used(rail, strips)), "insulated": rail.insulated, "strips": placed, "parts": parts,
    }


def _layout(field: int, rails: Sequence[TerminalRail], content: Sequence[Sequence[_Strip]],
            unplaced: Sequence[_Strip], status: str, order: Mapping[str, Any] | None) -> dict[str, Any]:
    missing = 0.0
    for strip in unplaced:
        missing += strip.width
    return {
        "field": field, "order": status, "orderModuleId": order["module_id"] if order else None,
        "rails": [_rail_out(rail, strips) for rail, strips in zip(rails, content)],
        "unplaced": [{"stripId": s.id, "xLabel": s.x_label, "widthMm": round1(s.width)} for s in unplaced],
        "missingMm": round1(missing),
    }


def _assign_fields(strips: Sequence[_Strip], rails: Mapping[int, Sequence[TerminalRail]]) -> tuple[
        dict[int, list[_Strip]], list[dict[str, Any]], list[str], list[str]]:
    """R4/R6: each strip to its home field, or the nearest field with terminal
    rails (ties to the left); listed when it has no home or there is no field."""
    target: dict[int, list[_Strip]] = {field: [] for field in rails}
    elsewhere: list[dict[str, Any]] = []
    outside: list[str] = []
    no_rails: list[str] = []
    for strip in strips:
        home = strip.home_field
        if home is None:
            outside.append(strip.id)
        elif home in target:
            target[home].append(strip)
        elif not target:
            no_rails.append(strip.id)
        else:
            field = min(target, key=lambda f: (abs(f - home), f))
            target[field].append(strip)
            elsewhere.append({"stripId": strip.id, "homeField": home, "field": field})
    return target, elsewhere, outside, no_rails


def empty_placement() -> dict[str, Any]:
    """The placement of a board without a cabinet."""
    return {"skip": [], "usableMm": TERMINAL_RAIL_USABLE_MM, "fields": [], "elsewhere": [], "outside": [],
            "noRails": [], "railParts": {}, "insulationSets": 0}


def place_terminals(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals | None = None) -> dict[str, Any]:
    """The board's terminal placement (§2.3); ``terms`` only from ``board_terminals``."""
    if terms is not None and not isinstance(terms, BoardTerminals):
        raise TypeError("place_terminals needs board_terminals(); groups without the skip set are refused")
    if enclosure_of(document) is None:
        return empty_placement()
    terms = board_terminals(document, catalog) if terms is None else terms
    rails = terminal_rails(document, catalog)
    fields_of = device_fields(document, catalog)
    strips = [_strip_of(group, strip, fields_of) for group in terms.groups for strip in group["strips"]]
    target, elsewhere, outside, no_rails = _assign_fields(strips, rails)
    fields = [_place_field(f, rails[f], target[f], field_order(document, catalog, f, rails)) for f in sorted(rails)]
    counts: Counter[str] = Counter()
    sets = 0
    for field in fields:
        for rail in field["rails"]:
            if not rail["strips"]:
                continue
            counts.update(part["partId"] for part in rail["parts"])
            sets += 0 if rail["insulated"] else 1
    return {
        "skip": sorted(terms.skip), "usableMm": TERMINAL_RAIL_USABLE_MM, "fields": fields, "elsewhere": elsewhere,
        "outside": outside, "noRails": no_rails,
        "railParts": {part_id: counts[part_id] for part_id in TERMINAL_PART_ORDER if counts[part_id]},
        "insulationSets": sets,
    }


def terminal_rail_parts(placement: Mapping[str, Any]) -> dict[str, int]:
    """part id → count of the rail parts (the end plates), for ``terminal_bom(extra=…)``."""
    return dict(placement.get("railParts") or {})


def insulation_sets(placement: Mapping[str, Any]) -> int:
    """U84T sets the board needs: terminal rails with strips that are not insulated."""
    return int(placement.get("insulationSets") or 0)
