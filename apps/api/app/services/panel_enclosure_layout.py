"""What a cabinet board means: rails, rows, reading order, pre-fitted parts.

docs/PANEL_ENCLOSURE.md §2.3. Twin of ``apps/web/src/utils/enclosureLayout.ts``;
both are pinned on ``apps/web/src/test/fixtures/enclosureFixtures.json``
(``scripts/write_enclosure_fixtures.py``).

``rows[]`` stays the only device container (D1). A module's rails only
*reference* row ids, so everything here is derived, never stored:

* a **resolvable rail** is a key of the module's catalogue spec (retired
  rails included); a row a module names under any other key, or behind a
  code the catalogue does not resolve, is "Nicht im Schrank";
* the **electrical reading order** is fixed by zone *type*, never by the
  order a spec lists its zones in: RfZ/APZ rails of every module first (the
  grid operator's devices are fed before the SLS, so they belong to the
  supply group, never under a customer FI), then per module NAR → SAS → AAR
  → VF → VT → MM, then the rows outside the cabinet in their stored order;
* a **pre-fitted part** is the first device in row order whose
  ``supplied_by`` names a live module and a fitting of it that has a device.
  The module's fitting snapshot decides (D5), so this holds for unknown and
  invalid codes too.

Every reader here is tolerant: documents come from tablets several versions
behind and from hand edits, and the read path must never fail on one. A
value that is not where it should be is skipped, never raised on.
"""

from __future__ import annotations

import re
from typing import Any, Iterator, Mapping

from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.schaltplan_layout import MODULE_WIDTH_MM, device_width_mm

#: Rails of these zones feed first: they are the grid operator's (§2.3 step 1).
SUPPLY_ZONE_TYPES: frozenset[str] = frozenset({"RFZ", "APZ"})
#: Step 2 ranks. ZF and COVER zones carry no rails, so they have no rank.
ZONE_RANKS: Mapping[str, int] = {"NAR": 1, "SAS": 2, "AAR": 3, "VF": 4, "VT": 5, "MM": 6}
#: What a zone is called when its spec gives no label.
ZONE_LABELS: Mapping[str, str] = {
    "NAR": "NAR", "ZF": "Zählerfeld", "AAR": "AAR", "RFZ": "RfZ", "VF": "Verteilerfeld",
    "APZ": "APZ", "VT": "Verteiler", "SAS": "Sammelschienen", "MM": "Multimedia", "COVER": "Abdeckung",
}
#: ``PanelRow.label``'s ceiling; a generated rail label is cut to it.
ROW_LABEL_MAX = 64
#: Hager HTS335E on a busbar: 4.5 PLE. A drawing default, not a catalogue fact.
BUSBAR_SLS_WIDTH_MM = 78.75
PLE_MM = MODULE_WIDTH_MM


# ── Tolerant readers ─────────────────────────────────────────────────────────


def as_int(value: Any, fallback: int = 0) -> int:
    """An int from stored JSON; bools and anything unparsable are the fallback."""
    if isinstance(value, bool):
        return fallback
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return fallback


#: The edge junk ``text`` removes, twin of ``edgeTrimmed`` (utils/edgeTrim.ts),
#: pinned by the fixture table ``edge_trim``: ``str.strip`` and JS ``trim``
#: disagree (U+001C–U+001F and U+0085 vs U+FEFF), so both strip this one set —
#: every C0/C1 control, DEL, the no-break space and the Unicode spaces either strips.
_EDGE = "\x00-\x20\x7f-\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_EDGE_JUNK = re.compile(f"^[{_EDGE}]+|[{_EDGE}]+\\Z")


def text(value: Any) -> str:
    return _EDGE_JUNK.sub("", value) if isinstance(value, str) else ""


def ident(value: Any) -> str:
    """An id as stored (never stripped: ids are matched, not read)."""
    return value if isinstance(value, str) else ""


def dicts(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def enclosure_of(document: Any) -> dict[str, Any] | None:
    enclosure = document.get("enclosure") if isinstance(document, Mapping) else None
    return enclosure if isinstance(enclosure, dict) else None


def modules_of(document: Any) -> list[dict[str, Any]]:
    """The modules that can mean anything: a dict with a text id."""
    enclosure = enclosure_of(document)
    if enclosure is None:
        return []
    return [module for module in dicts(enclosure.get("modules")) if ident(module.get("id"))]


def rows_of(document: Any) -> list[dict[str, Any]]:
    """Rows with a text id, in stored order; a repeated id counts once (the first)."""
    rows = document.get("rows") if isinstance(document, Mapping) else None
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in dicts(rows):
        row_id = row.get("id")
        if isinstance(row_id, str) and row_id and row_id not in seen:
            seen.add(row_id)
            out.append(row)
    return out


def row_devices(row: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    return dicts(row.get("devices")) if row is not None else []


def module_rails(module: Mapping[str, Any]) -> dict[str, str]:
    """``module.rails`` with text keys and text row ids only."""
    rails = module.get("rails")
    if not isinstance(rails, dict):
        return {}
    return {key: row_id for key, row_id in rails.items() if isinstance(key, str) and isinstance(row_id, str) and row_id}


def module_spec(module: Mapping[str, Any], catalog: EnclosureCatalog) -> dict[str, Any] | None:
    code = module.get("code")
    return catalog.module(code) if isinstance(code, str) else None


def spec_rails(spec: Mapping[str, Any]) -> Iterator[tuple[dict[str, Any], dict[str, Any], int]]:
    """(zone, rail, 1-based position of the rail in its zone), in spec order."""
    for zone in dicts(spec.get("zones")):
        for position, rail in enumerate(dicts(zone.get("rails")), start=1):
            yield zone, rail, position


# ── Rails and rows (§2.3) ────────────────────────────────────────────────────


def resolvable_rails(module: Mapping[str, Any], catalog: EnclosureCatalog) -> dict[str, tuple[dict, dict]]:
    """rail key → (zone, rail) of the module's spec, retired rails included."""
    spec = module_spec(module, catalog)
    if spec is None:
        return {}
    return {str(rail.get("key")): (zone, rail) for zone, rail, _ in spec_rails(spec)}


def linked_rows(document: Any, catalog: EnclosureCatalog) -> dict[str, tuple[str, str]]:
    """row id → (module id, rail key) for every row that is "im Schrank".

    Only rows that exist, named under a resolvable rail. A row named twice
    (the schema refuses it; a hand edit may not) belongs to the first name,
    in module order and then ``module.rails`` order.
    """
    existing = {row["id"] for row in rows_of(document)}
    linked: dict[str, tuple[str, str]] = {}
    for module in modules_of(document):
        rails = resolvable_rails(module, catalog)
        for key, row_id in module_rails(module).items():
            if key in rails and row_id in existing and row_id not in linked:
                linked[row_id] = (ident(module.get("id")), key)
    return linked


def physical_row_order(document: Any, catalog: EnclosureCatalog) -> list[str]:
    """Row ids in electrical reading order (§2.3). Stable and idempotent.

    Sort keys, beyond the contract's (module field, module unit, module id,
    [zone-type rank,] zone unit, rail unit): zone field, then rail key —
    ties only a multi-field module can produce. Ids compare by code point.
    """
    linked = linked_rows(document, catalog)
    keyed: list[tuple[tuple[Any, ...], str]] = []
    for module in modules_of(document):
        spec = module_spec(module, catalog)
        if spec is None:
            continue
        module_id = ident(module.get("id"))
        place = (as_int(module.get("field")), as_int(module.get("unit")), module_id)
        names = module_rails(module)
        for zone, rail, _ in spec_rails(spec):
            key = str(rail.get("key"))
            row_id = names.get(key)
            if row_id is None or linked.get(row_id) != (module_id, key):
                continue
            kind = str(zone.get("type"))
            group, rank = (0, 0) if kind in SUPPLY_ZONE_TYPES else (1, ZONE_RANKS.get(kind, 99))
            tail = (as_int(zone.get("unit")), as_int(rail.get("unit")), as_int(zone.get("field")), key)
            keyed.append(((group, *place, rank, *tail), row_id))
    keyed.sort(key=lambda pair: pair[0])
    inside = [row_id for _, row_id in keyed]
    outside = [row["id"] for row in rows_of(document) if row["id"] not in linked]
    return inside + outside


def zone_label(zone: Mapping[str, Any]) -> str:
    return text(zone.get("label")) or ZONE_LABELS.get(str(zone.get("type")), "")


def zone_field(module: Mapping[str, Any], zone: Mapping[str, Any]) -> int:
    """The cabinet field a zone sits in (0-based): module field + zone offset."""
    return as_int(module.get("field")) + as_int(zone.get("field"))


def default_rail_label(module: Mapping[str, Any], zone: Mapping[str, Any], position: int) -> str:
    """"F1 · AAR 1", "F1 · NAR": what a rail's row is called when it is created.

    The number only when the zone has more than one rail; position is the
    rail's 1-based place in the zone's spec list (retired rails count, so a
    label never shifts when a rail is retired).
    """
    count = len(dicts(zone.get("rails")))
    suffix = f" {position}" if count > 1 else ""
    # Cut to what a row label may hold (PanelRow.label): a long admin-given
    # zone label must not make the new row unsaveable. Code points, like
    # Python's len — the TS twin cuts the same way.
    return f"F{zone_field(module, zone) + 1} · {zone_label(zone)}{suffix}"[:ROW_LABEL_MAX]


def enclosure_device_width_mm(device: Mapping[str, Any], rail: Mapping[str, Any]) -> float:
    """A device's width on a cabinet rail: its own ``width_mm``, else 78.75 mm
    for an SLS on a busbar (a drawing default), else te × 17.5 mm."""
    override = device.get("width_mm")
    if isinstance(override, (int, float)) and not isinstance(override, bool) and override > 0:
        return float(override)
    if device.get("kind") == "sls" and rail.get("mount") == "busbar":
        return BUSBAR_SLS_WIDTH_MM
    return device_width_mm(dict(device))


# ── Pre-fitted parts (§2.3, D5) ──────────────────────────────────────────────


def module_fittings(module: Mapping[str, Any], catalog: EnclosureCatalog) -> list[dict[str, Any]]:
    """The module's fitting snapshot; a module without one (no key, or null:
    a hand-made document) reads the catalogue's non-retired fittings in
    snapshot shape. An empty list IS a snapshot — "nothing came pre-fitted" —
    or a fitting an admin adds later would reach boards placed before it."""
    stored = module.get("fittings")
    if isinstance(stored, list):
        return [fitting for fitting in dicts(stored) if isinstance(fitting.get("key"), str)]
    spec = module_spec(module, catalog)
    if spec is None:
        return []
    out: list[dict[str, Any]] = []
    for fitting in dicts(spec.get("fittings")):
        if fitting.get("retired"):
            continue
        device = fitting.get("device")
        out.append({
            "key": fitting.get("key"), "label": fitting.get("label"), "article_no": fitting.get("article_no"),
            "device_kind": device.get("kind") if isinstance(device, dict) else None,
            "removable": bool(fitting.get("removable")),
        })
    return out


def device_fitting_keys(module: Mapping[str, Any], catalog: EnclosureCatalog) -> set[str]:
    return {str(f["key"]) for f in module_fittings(module, catalog) if text(f.get("device_kind"))}


def claim_of(device: Mapping[str, Any]) -> tuple[str, str] | None:
    """(module id, part) a device's ``supplied_by`` names, or None."""
    claim = device.get("supplied_by")
    if not isinstance(claim, dict):
        return None
    module_id, part = claim.get("module"), claim.get("part")
    if isinstance(module_id, str) and module_id and isinstance(part, str) and part:
        return module_id, part
    return None


def supplied_claims(document: Any, catalog: EnclosureCatalog) -> dict[str, tuple[str, str]]:
    """device id → (module id, fitting key) for every device that IS a fitting.

    First claimant in row order only; any later claimant of the same pair is
    an ordinary device. A claim on a module that is gone, or on a key that
    is no device fitting of its snapshot, makes nothing a fitting.
    """
    fitting_keys = {ident(m.get("id")): device_fitting_keys(m, catalog) for m in modules_of(document)}
    taken: set[tuple[str, str]] = set()
    out: dict[str, tuple[str, str]] = {}
    for row in rows_of(document):
        for device in row_devices(row):
            claim = claim_of(device)
            device_id = device.get("id")
            if claim is None or claim in taken or not isinstance(device_id, str):
                continue
            if claim[1] in fitting_keys.get(claim[0], set()):
                taken.add(claim)
                out[device_id] = claim
    return out


def supplied_device_ids(document: Any, catalog: EnclosureCatalog) -> set[str]:
    return set(supplied_claims(document, catalog))


def dangling_claim(device: Mapping[str, Any], document: Any, catalog: EnclosureCatalog) -> bool:
    """A ``supplied_by`` that names no live module, or a key that is no
    device fitting of its snapshot (``encl.supplied_dangling``)."""
    claim = claim_of(device)
    if claim is None:
        return isinstance(device.get("supplied_by"), dict)
    for module in modules_of(document):
        if ident(module.get("id")) == claim[0]:
            return claim[1] not in device_fitting_keys(module, catalog)
    return True


# ── Meter places ─────────────────────────────────────────────────────────────


def meter_zones(spec: Mapping[str, Any]) -> list[tuple[dict[str, Any], int]]:
    """(ZF zone, index of its first place) in spec order: places run over the
    module's ZF zones in spec order (§2.1)."""
    out: list[tuple[dict[str, Any], int]] = []
    first = 0
    for zone in dicts(spec.get("zones")):
        places = as_int(zone.get("meter_places"))
        if zone.get("type") == "ZF" and places > 0:
            out.append((zone, first))
            first += places
    return out


def meter_place_count(spec: Mapping[str, Any]) -> int:
    return sum(as_int(zone.get("meter_places")) for zone, _ in meter_zones(spec))


def occupied_meters(module: Mapping[str, Any]) -> dict[int, dict[str, Any]]:
    """place → its entry; the first entry wins a repeated place."""
    out: dict[int, dict[str, Any]] = {}
    for entry in dicts(module.get("meters")):
        place = entry.get("place")
        if isinstance(place, int) and not isinstance(place, bool) and place >= 0 and place not in out:
            out[place] = entry
    return out
