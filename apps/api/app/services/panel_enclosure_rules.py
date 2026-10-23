"""Placement rules and geometric problems of a cabinet board, as findings.

docs/PANEL_ENCLOSURE.md §5. Twin of ``apps/web/src/utils/enclosureRules.ts``,
pinned on ``apps/web/src/test/fixtures/enclosureFixtures.json``.

D6 is "warn, never block": a board captured half-built must save, so every
rule here is a finding (``level`` warn/info, a ``rule`` id), never a refusal,
and the function never raises. VDE-AR-N 4100:2026-04 rules are a Prüfhilfe —
the Schrank tab says they do not replace the grid operator's TAB.

What both twins keep identical beyond the table in §5:

* the output is sorted by (position of ``rule`` in ``RULE_ORDER``, scope,
  message), strings by code point — so neither side depends on the other's
  iteration order;
* numbers in messages: millimetres via ``round1`` with a German decimal
  comma and no ",0" (``29,9``, ``1050``); meter places are counted from 1;
  "Feld n" is the 0-based field + 1 — the module's field for module-level
  rules, the zone's field (module field + zone offset) for the APZ, meter
  places, SAS credit and Reihenklemmen;
* ``rating(d)`` is the last number in the rating text ("B16" → 16, "0,5 A"
  → 0.5); none means unknown, and an unknown rating never counts as small;
* SAS credit (``vde.nar_sls``): every SLS on a SAS rail is credited at most
  once, to meter modules in (field, unit, document) order, each taking from
  the pool in (field, module unit, module id, zone unit, rail unit, position)
  order the SLS whose field is the module's or an adjacent one;
* a row named under a key or code the catalogue does not resolve gets
  ``encl.stale_rail``, not also ``encl.row_unlinked``;
* ``encl.row_order`` compares the whole stored order with
  ``physical_row_order`` (rows outside the cabinet included, which belong last).

Round 2 (docs/PANEL_ENCLOSURE_R2.md §4.1) replaced the one ``encl.terminals``
note with ten WAGO terminal rules (``panel_enclosure_terminal_rules``), which
read the board's precomputed terminals and placement.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Mapping

from app.schemas.panel_enclosure import METER_FAMILIES
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_geometry import mm_text
from app.services.panel_enclosure_layout import (
    PLE_MM,
    as_int,
    dangling_claim,
    dicts,
    enclosure_device_width_mm,
    enclosure_of,
    ident,
    linked_rows,
    meter_place_count,
    meter_zones,
    module_rails,
    module_spec,
    modules_of,
    occupied_meters,
    physical_row_order,
    resolvable_rails,
    row_devices,
    rows_of,
    spec_rails,
    text,
    zone_field,
)
from app.services.panel_enclosure_terminal_rules import TERMINAL_RULE_ORDER, terminal_findings
from app.services.panel_enclosure_terminals import BoardTerminals
from app.services.schaltplan_layout import DEVICE_CATALOG, build_topology

logger = logging.getLogger(__name__)

RULE_ORDER: tuple[str, ...] = (
    "encl.unknown_code", "encl.out_of_bounds", "encl.overlap", "encl.height_mismatch", "encl.field_gap",
    "encl.row_unlinked", "encl.stale_rail", "encl.row_order", "encl.rail_overflow", "encl.supplied_dangling",
    "encl.cross_module_feed", "encl.unverified", "encl.meter_device", "encl.meter_place_invalid",
    *TERMINAL_RULE_ORDER, "vde.nar_sls", "vde.nar_contents", "vde.sls_rating", "vde.aar_contents", "vde.aar_circuits",
    "vde.3p_main_switch", "vde.rfz_devices", "vde.apz_missing", "vde.apz_position", "vde.meter_place_empty",
)
_RANK = {rule: index for index, rule in enumerate(RULE_ORDER)}
VDE_PREFIX = "VDE-AR-N 4100: "

_SMALL_TAP_A = 10.0  # an LS up to 10 A may tap the NAR / sit on the RfZ (Spannungsabgriff)
_AAR_MAX_A = 16.0
_AAR_PER_PLACE = 3
_SLS_MAX_A = {10: 35, 16: 50}  # field wiring mm² → largest SLS (E35 / E50)
_AAR_ALLOWED = frozenset({"hauptschalter", "rcd", "rcbo", "mcb", "hlak", "terminal", "spd", "blank", "pv", "wallbox"})
_RFZ_FORBIDDEN = frozenset({
    "rcd", "rcbo", "hauptschalter", "sls", "fuse", "contactor", "impulse", "timer", "bell_transformer",
    "knx_actuator", "wallbox", "pv", "sub_feed",
})
_NUMBER = re.compile(r"\d+(?:[.,]\d+)?")

Finding = dict[str, str]


# ── The board, read once ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Module:
    raw: dict[str, Any]
    index: int
    id: str
    code: str
    field: int
    unit: int
    spec: dict[str, Any] | None
    art: str  # the article number, or the code when the catalogue does not know it
    width: int  # in fields; an unknown code is drawn 1 × 1
    height: int  # in units


@dataclass(frozen=True)
class _Rail:
    """A rail that holds a row: resolvable, and its row exists."""

    module: _Module
    zone: dict[str, Any]
    rail: dict[str, Any]
    row: dict[str, Any]
    field: int

    @property
    def zone_type(self) -> str:
        return str(self.zone.get("type"))

    @property
    def devices(self) -> list[dict[str, Any]]:
        return row_devices(self.row)


@dataclass(frozen=True)
class _Board:
    document: Mapping[str, Any]
    catalog: EnclosureCatalog
    cabinet: dict[str, Any] | None
    cabinet_code: str
    modules: tuple[_Module, ...]
    rows: tuple[dict[str, Any], ...]
    rails: tuple[_Rail, ...]
    linked: Mapping[str, tuple[str, str]]
    rail_by_row: Mapping[str, _Rail]

    def rail_of_row(self, row_id: str | None) -> _Rail | None:
        return self.rail_by_row.get(row_id) if row_id else None

    def rails_of(self, module: _Module, *types: str) -> list[_Rail]:
        return [rail for rail in self.rails if rail.module is module and rail.zone_type in types]


def _read_board(document: Any, catalog: EnclosureCatalog) -> _Board | None:
    enclosure = enclosure_of(document)
    if enclosure is None:
        return None
    code = text(enclosure.get("code"))
    rows = tuple(rows_of(document))
    by_id = {row["id"]: row for row in rows}
    linked = linked_rows(document, catalog)
    modules: list[_Module] = []
    rails: list[_Rail] = []
    for index, raw in enumerate(modules_of(document)):
        spec = module_spec(raw, catalog)
        module = _Module(
            raw=raw, index=index, id=ident(raw.get("id")), code=text(raw.get("code")),
            field=as_int(raw.get("field")), unit=as_int(raw.get("unit")), spec=spec,
            art=str(spec.get("article_no")) if spec is not None else text(raw.get("code")),
            width=as_int(spec.get("width_fields"), 1) if spec is not None else 1,
            height=as_int(spec.get("height_units"), 1) if spec is not None else 1,
        )
        modules.append(module)
        names = module_rails(raw)
        for zone, rail, _ in spec_rails(spec) if spec is not None else ():
            row_id = names.get(str(rail.get("key")))
            if row_id is not None and linked.get(row_id) == (module.id, str(rail.get("key"))):
                rails.append(_Rail(module, zone, rail, by_id[row_id], zone_field(raw, zone)))
    return _Board(document, catalog, catalog.enclosure(code) if code else None, code,
                  tuple(modules), rows, tuple(rails), linked, {rail.row["id"]: rail for rail in rails})


# ── Small helpers ────────────────────────────────────────────────────────────


def _finding(rule: str, level: str, scope: str, message: str) -> Finding:
    prefix = VDE_PREFIX if rule.startswith("vde.") else ""
    return {"level": level, "scope": scope, "message": prefix + message, "rule": rule}


def _short(device: Mapping[str, Any]) -> str:
    entry = DEVICE_CATALOG.get(str(device.get("kind") or ""))
    return str(entry["short"]) if entry is not None else (text(device.get("kind")) or "?")


def _bmk(device: Mapping[str, Any]) -> str:
    return text(device.get("designation")) or _short(device)


def _row_name(row: Mapping[str, Any]) -> str:
    return text(row.get("label")) or str(row.get("id"))


def _kind(device: Mapping[str, Any]) -> str:
    return str(device.get("kind") or "")


def _is_circuit(device: Mapping[str, Any]) -> bool:
    return bool(DEVICE_CATALOG.get(_kind(device), {}).get("circuit"))


def rating(device: Mapping[str, Any]) -> float | None:
    """The last number in the rating ("B16" → 16, "E35" → 35); None if none."""
    numbers = _NUMBER.findall(text(device.get("rating")))
    return float(numbers[-1].replace(",", ".")) if numbers else None


def _occupied(module: _Module) -> list[int]:
    count = meter_place_count(module.spec) if module.spec is not None else 0
    return [place for place in occupied_meters(module.raw) if place < count]


def _need(module: _Module) -> int:
    return max(1, len(_occupied(module)))


def _meter_modules(board: _Board) -> list[_Module]:
    found = [m for m in board.modules if m.spec is not None and m.spec.get("family") in METER_FAMILIES]
    return sorted(found, key=lambda m: (m.field, m.unit, m.index))


def _cells(module: _Module) -> set[tuple[int, int]]:
    return {(f, u) for f in range(module.field, module.field + module.width)
            for u in range(module.unit, module.unit + module.height)}


def _row_of_device(board: _Board) -> dict[int, str]:
    """id(device dict) → row id: build_topology hands back the same dicts."""
    return {id(device): row["id"] for row in board.rows for device in row_devices(row)}


# ── encl.* ───────────────────────────────────────────────────────────────────


def _unknown_codes(board: _Board) -> Iterator[Finding]:
    message = "Unbekannter oder fehlerhafter Katalogcode {code} — nur als Platzhalter gezeigt."
    if board.cabinet is None:
        yield _finding("encl.unknown_code", "warn", "", message.format(code=board.cabinet_code or "?"))
    for module in board.modules:
        if module.spec is None:
            yield _finding("encl.unknown_code", "warn", module.id, message.format(code=module.code or "?"))


def _bounds(board: _Board) -> Iterator[Finding]:
    if board.cabinet is None:
        return
    fields, units = as_int(board.cabinet.get("fields"), 1), as_int(board.cabinet.get("units_per_field"), 1)
    for m in board.modules:
        if m.field < 0 or m.unit < 0 or m.field + m.width > fields or m.unit + m.height > units:
            yield _finding("encl.out_of_bounds", "warn", m.id, f"{m.art}: ragt aus dem Schrank (Feld {m.field + 1}).")


def _overlaps(board: _Board) -> Iterator[Finding]:
    cells = [_cells(m) for m in board.modules]
    for later, module in enumerate(board.modules):
        for earlier in range(later):
            shared = cells[earlier] & cells[later]
            if shared:
                field = min(f for f, _ in shared) + 1
                yield _finding("encl.overlap", "warn", module.id,
                               f"{board.modules[earlier].art} und {module.art} überlappen in Feld {field}.")


def _height(board: _Board) -> Iterator[Finding]:
    if board.cabinet is None:
        return
    usable = as_int(board.cabinet.get("units_per_field")) * as_int(board.cabinet.get("unit_mm"))
    for m in board.modules:
        field_height = m.spec.get("field_height_mm") if m.spec is not None else None
        if isinstance(field_height, int) and field_height != usable:
            yield _finding("encl.height_mismatch", "warn", m.id,
                           f"{m.art}: für {field_height} mm Felder — passt nicht in {board.cabinet.get('article_no')}.")


def _field_gaps(board: _Board) -> Iterator[Finding]:
    if board.cabinet is None:
        return
    fields, units = as_int(board.cabinet.get("fields"), 1), as_int(board.cabinet.get("units_per_field"), 1)
    covered = set().union(*(_cells(m) for m in board.modules)) if board.modules else set()
    for field in range(fields):
        free = sum(1 for unit in range(units) if (field, unit) not in covered)
        if free:
            length = mm_text(free * as_int(board.cabinet.get("unit_mm")))
            yield _finding("encl.field_gap", "info", "", f"Feld {field + 1}: {length} mm ohne Modul — Abdeckung einplanen.")


def _stale_names(board: _Board) -> dict[str, tuple[_Module, str]]:
    """Rows outside the cabinet that a module names under an unresolvable key."""
    existing = {row["id"] for row in board.rows}
    out: dict[str, tuple[_Module, str]] = {}
    for module in board.modules:
        rails = resolvable_rails(module.raw, board.catalog)
        for key, row_id in module_rails(module.raw).items():
            if row_id in existing and row_id not in board.linked and key not in rails and row_id not in out:
                out[row_id] = (module, key)
    return out


def _unlinked(board: _Board) -> Iterator[Finding]:
    stale = _stale_names(board)
    for row in board.rows:
        if row["id"] not in board.linked and row["id"] not in stale:
            yield _finding("encl.row_unlinked", "info", row["id"], f"{_row_name(row)}: keiner Hutschiene im Schrank zugeordnet.")


def _stale_rails(board: _Board) -> Iterator[Finding]:
    rows = {row["id"]: row for row in board.rows}
    for row_id, (module, key) in _stale_names(board).items():
        yield _finding("encl.stale_rail", "warn", row_id,
                       f"{_row_name(rows[row_id])}: Hutschiene „{key}“ gibt es in {module.art} nicht — gilt als „Nicht im Schrank“.")
    for rail in board.rails:
        if rail.rail.get("retired") and rail.devices:
            yield _finding("encl.stale_rail", "info", rail.row["id"],
                           f"{_row_name(rail.row)}: Hutschiene „{rail.rail.get('key')}“ in {rail.module.art} ist ausgemustert — Geräte umsetzen.")


def _row_order(board: _Board) -> Iterator[Finding]:
    if [row["id"] for row in board.rows] != physical_row_order(board.document, board.catalog):
        yield _finding("encl.row_order", "warn", "",
                       "Reihenfolge der Reihen passt nicht zum Schrank — im Tab Schrank „Reihen ordnen“ tippen.")


def _rail_overflow(board: _Board) -> Iterator[Finding]:
    for rail in board.rails:
        ple = as_int(rail.rail.get("ple"), 1)
        total = sum(enclosure_device_width_mm(device, rail.rail) for device in rail.devices)
        slots = as_int(rail.row.get("slots"), 12) or 12
        if total > ple * PLE_MM + 0.05 and slots != ple:
            yield _finding("encl.rail_overflow", "warn", rail.row["id"],
                           f"{_row_name(rail.row)}: {mm_text(total)} mm Geräte auf {ple} PLE Hutschiene.")


def _supplied_dangling(board: _Board) -> Iterator[Finding]:
    for row in board.rows:
        for device in row_devices(row):
            if dangling_claim(device, board.document, board.catalog):
                yield _finding("encl.supplied_dangling", "info", ident(device.get("id")),
                               f"{_bmk(device)}: gehört zu keinem Modul mehr — zählt als eigenes Gerät.")


def _cross_module_feed(board: _Board) -> Iterator[Finding]:
    row_of = _row_of_device(board)
    counts: dict[tuple[str, int], int] = {}
    heads: dict[int, dict[str, Any]] = {}
    for group in build_topology(dict(board.document))["groups"]:
        head = group["device"]
        if head is None:
            continue
        head_rail = board.rail_of_row(row_of.get(id(head)))
        for child in group["children"]:
            child_rail = board.rail_of_row(row_of.get(id(child)))
            if child.get("parent_id") or child_rail is None:
                continue  # an explicit feed is a decision; a row outside the cabinet is not ours
            if head_rail is None or head_rail.module is not child_rail.module:
                key = (child_rail.row["id"], id(head))
                counts[key] = counts.get(key, 0) + 1
                heads[id(head)] = head
    rows = {row["id"]: row for row in board.rows}
    for (row_id, head_key), count in counts.items():
        yield _finding("encl.cross_module_feed", "warn", row_id,
                       f"{_row_name(rows[row_id])}: {count} Stromkreis(e) hängen an {_bmk(heads[head_key])} aus einem "
                       "anderen Feld — FI davor setzen oder Einspeisung prüfen.")


def _unverified(board: _Board) -> Iterator[Finding]:
    def first_note(spec: Mapping[str, Any]) -> str:
        notes = [note for note in spec.get("unverified") or [] if isinstance(note, str) and note]
        return notes[0] if notes else "ohne Angabe"

    if board.cabinet is not None and not board.cabinet.get("verified"):
        yield _finding("encl.unverified", "info", "",
                       f"{board.cabinet.get('article_no')}: Katalogdaten ungeprüft — {first_note(board.cabinet)}.")
    seen: set[str] = set()
    for module in board.modules:
        if module.spec is not None and not module.spec.get("verified") and module.code not in seen:
            seen.add(module.code)
            yield _finding("encl.unverified", "info", module.id,
                           f"{module.art}: Katalogdaten ungeprüft — {first_note(module.spec)}.")


def _meter_device(board: _Board) -> Iterator[Finding]:
    if not any(m.spec is not None and meter_place_count(m.spec) > 0 for m in board.modules):
        return
    for row in board.rows:
        for device in row_devices(row):
            if _kind(device) == "meter":
                yield _finding("encl.meter_device", "info", ident(device.get("id")),
                               f"{_bmk(device)}: Zwischenzähler auf der Hutschiene — eHZ/3-Punkt gehören auf den Zählerplatz.")


def _meter_place_invalid(board: _Board) -> Iterator[Finding]:
    for module in board.modules:
        if module.spec is None:
            continue
        count = meter_place_count(module.spec)
        for place in occupied_meters(module.raw):
            if place >= count:
                yield _finding("encl.meter_place_invalid", "info", module.id,
                               f"{module.art}: Zählerplatz {place + 1} gibt es nicht — Eintrag wird ignoriert.")


# ── vde.* (VDE-AR-N 4100:2026-04) ────────────────────────────────────────────


def _sas_pool(board: _Board) -> list[tuple[int, dict[str, Any]]]:
    """(field, SLS) on every SAS rail, in the order credit is handed out."""
    keyed: list[tuple[tuple[Any, ...], int, dict[str, Any]]] = []
    for rail in board.rails:
        if rail.zone_type != "SAS":
            continue
        for position, device in enumerate(rail.devices):
            if _kind(device) == "sls":
                key = (rail.field, rail.module.unit, rail.module.id, as_int(rail.zone.get("unit")),
                       as_int(rail.rail.get("unit")), position)
                keyed.append((key, rail.field, device))
    keyed.sort(key=lambda item: item[0])
    return [(field, device) for _, field, device in keyed]


def _nar_sls(board: _Board) -> Iterator[Finding]:
    pool = _sas_pool(board)
    used: set[int] = set()
    for module in _meter_modules(board):
        need = _need(module)
        have = sum(1 for rail in board.rails_of(module, "NAR") for d in rail.devices if _kind(d) == "sls")
        for index, (field, _) in enumerate(pool):
            if have >= need:
                break
            if index not in used and abs(field - module.field) <= 1:
                used.add(index)
                have += 1
        if have < need:
            yield _finding("vde.nar_sls", "warn", module.id,
                           f"Feld {module.field + 1} ({module.art}): {have} SLS-Schalter für {need} Zählerplatz/-plätze im NAR.")


def _nar_contents(board: _Board) -> Iterator[Finding]:
    for rail in board.rails:
        if rail.zone_type != "NAR":
            continue
        art = rail.module.art
        for device in rail.devices:
            kind = _kind(device)
            if kind == "fuse":
                message = f"NAR {art}: NH/Neozed ist nicht als Trennvorrichtung zulässig — SLS verwenden."
            elif kind in ("rcd", "rcbo") or (_is_circuit(device) and not _small_mcb(device)):
                message = f"NAR {art}: {_short(device)} gehört nicht in den NAR."
            else:
                continue
            yield _finding("vde.nar_contents", "warn", ident(device.get("id")), message)


def _small_mcb(device: Mapping[str, Any]) -> bool:
    """An LS up to 10 A: the Spannungsabgriff the NAR and the RfZ allow."""
    amps = rating(device)
    return _kind(device) == "mcb" and amps is not None and amps <= _SMALL_TAP_A


def _sls_rating(board: _Board) -> Iterator[Finding]:
    for module in board.modules:
        wiring = module.spec.get("wiring_mm2") if module.spec is not None else None
        limit = _SLS_MAX_A.get(wiring) if isinstance(wiring, int) else None
        if limit is None:
            continue  # unknown wiring: silent rather than a guess from the article code
        for rail in board.rails_of(module, "NAR"):
            for device in rail.devices:
                amps = rating(device)
                if _kind(device) == "sls" and amps is not None and amps > limit:
                    yield _finding("vde.sls_rating", "warn", ident(device.get("id")),
                                   f"Feld {module.field + 1} ({module.art}): SLS {text(device.get('rating'))} zu groß für "
                                   f"{wiring} mm² Feldverdrahtung (max. E{limit}).")


def _aar_contents(board: _Board) -> Iterator[Finding]:
    for rail in board.rails:
        if rail.zone_type != "AAR":
            continue
        for device in rail.devices:
            if _kind(device) not in _AAR_ALLOWED:
                yield _finding("vde.aar_contents", "warn", ident(device.get("id")),
                               f"AAR {rail.module.art}: {_short(device)} gehört nicht in den AAR — kein Stromkreisverteiler.")


def _aar_circuits(board: _Board) -> Iterator[Finding]:
    for module in board.modules:
        circuits = [d for rail in board.rails_of(module, "AAR") for d in rail.devices if _is_circuit(d)]
        too_big = any((amps := rating(d)) is not None and amps > _AAR_MAX_A for d in circuits)
        if len(circuits) > _AAR_PER_PLACE * _need(module) or too_big:
            yield _finding("vde.aar_circuits", "warn", module.id,
                           f"AAR {module.art}: höchstens drei Stromkreise je Zählerplatz, je max. 16 A.")


def _main_switch_3p(board: _Board) -> Iterator[Finding]:
    for module in _meter_modules(board):
        if module.spec is None or module.spec.get("family") != "meter_3p":
            continue
        need = _need(module)
        have = sum(1 for rail in board.rails_of(module, "AAR") for d in rail.devices if _kind(d) == "hauptschalter")
        if have < need:
            yield _finding("vde.3p_main_switch", "warn", module.id,
                           f"Hinter jedem 3-Punkt-Zähler in Feld {module.field + 1} gehört ein Hauptschalter in den AAR "
                           f"({have} von {need}).")


def _rfz_devices(board: _Board) -> Iterator[Finding]:
    for rail in board.rails:
        if rail.zone_type not in ("RFZ", "APZ"):
            continue
        for device in rail.devices:
            kind = _kind(device)
            if kind in _RFZ_FORBIDDEN or (kind == "mcb" and not _small_mcb(device)):
                yield _finding("vde.rfz_devices", "warn", ident(device.get("id")),
                               f"RfZ/APZ ({rail.module.art}) ist nur für Geräte des Netz-/Messstellenbetreibers.")


def _zones(board: _Board, zone_type: str) -> Iterator[tuple[_Module, dict[str, Any]]]:
    for module in board.modules:
        for zone in dicts(module.spec.get("zones")) if module.spec is not None else ():
            if zone.get("type") == zone_type:
                yield module, zone


def _apz_missing(board: _Board) -> Iterator[Finding]:
    if _meter_modules(board) and not any(True for _ in _zones(board, "APZ")):
        yield _finding("vde.apz_missing", "warn", "", "Kein APZ im Schrank (mind. 300 mm, plombierbar).")


def _apz_position(board: _Board) -> Iterator[Finding]:
    if board.cabinet is None:
        return
    units = as_int(board.cabinet.get("units_per_field"), 1)
    meter_fields = {zone_field(module.raw, zone) for module, zone in _zones(board, "ZF")}
    reported: set[str] = set()
    for module, zone in _zones(board, "APZ"):
        top = module.unit + as_int(zone.get("unit"))
        bottom = top + as_int(zone.get("units"), 1)
        field = zone_field(module.raw, zone)
        if module.id not in reported and ((top != 0 and bottom != units) or field in meter_fields):
            reported.add(module.id)
            yield _finding("vde.apz_position", "warn", module.id,
                           f"APZ in Feld {field + 1}: oben oder unten am Schrankrand und seitlich neben dem Zählerfeld.")


def _meter_place_empty(board: _Board) -> Iterator[Finding]:
    for module in board.modules:
        if module.spec is None:
            continue
        occupied = occupied_meters(module.raw)
        for zone, first in meter_zones(module.spec):
            for place in range(first, first + as_int(zone.get("meter_places"))):
                if place not in occupied:
                    yield _finding("vde.meter_place_empty", "info", module.id,
                                   f"Zählerplatz {place + 1} in Feld {zone_field(module.raw, zone) + 1} als Reserve "
                                   "geplant — Blindabdeckung steht auf der Materialliste.")


# ── Entry point ──────────────────────────────────────────────────────────────

_CHECKS: tuple[Callable[[_Board], Iterator[Finding]], ...] = (
    _unknown_codes, _bounds, _overlaps, _height, _field_gaps, _unlinked, _stale_rails, _row_order,
    _rail_overflow, _supplied_dangling, _cross_module_feed, _unverified, _meter_device, _meter_place_invalid,
    _nar_sls, _nar_contents, _sls_rating, _aar_contents, _aar_circuits, _main_switch_3p,
    _rfz_devices, _apz_missing, _apz_position, _meter_place_empty,
)


def enclosure_findings(document: Any, catalog: EnclosureCatalog, terms: BoardTerminals | None = None,
                       placement: Mapping[str, Any] | None = None) -> list[Finding]:
    """Every cabinet finding of a board, sorted; [] without a cabinet. Never raises.

    ``terms``/``placement``: the board's ``board_terminals`` and
    ``place_terminals``, when the caller already has them.
    """
    try:
        board = _read_board(document, catalog)
        if board is None:
            return []
        findings = [finding for check in _CHECKS for finding in check(board)]
        findings += terminal_findings(document, catalog, terms, placement)
    except Exception:  # noqa: BLE001 — a finding must never take a board's page down
        # Last resort only: the readers above are tolerant by construction, and
        # the tests assert this line is never reached on garbage documents.
        logger.exception("cabinet findings failed for a board; showing none")
        return []
    return sorted(findings, key=lambda f: (_RANK[f["rule"]], f["scope"], f["message"]))
