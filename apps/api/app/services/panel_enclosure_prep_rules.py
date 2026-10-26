"""The round-4 findings: §14a block, busbar runs, supply kit and infeed (docs/PANEL_ENCLOSURE_R4.md §4).

Twin: the matching rules of ``apps/web/src/utils/enclosureRules.ts`` (or
``enclosurePrepRules.ts``), pinned on the fixture's ``findings``. Called by
``panel_enclosure_rules.enclosure_findings``, which sorts every finding by
``RULE_ORDER``; these rules sit after ``encl.meter_place_invalid`` and
before the terminal rules (``PREP_RULE_ORDER``).

Let B = the parsed block, C = its carrier, L = its placement. Board-level
rules use scope ``""``, as every board-level rule does; the block's rules
are scoped to the carrier, ``busbar_role`` to the customer module.
"""

from __future__ import annotations

from typing import Any, Iterator, Mapping

from app.services.cable_section_parse import parse_fuse_amps
from app.services.panel_enclosure_catalog import EnclosureCatalog
from app.services.panel_enclosure_control_block import (
    DERIVE,
    BlockLayout,
    Carrier,
    candidate_rails,
    control_block_layout,
    control_carrier,
    resolve_block,
)
from app.services.panel_enclosure_geometry import mm_text
from app.services.panel_enclosure_layout import text
from app.services.panel_enclosure_prep import (
    K96ESA5_MAX_FUSE_A,
    ROLE_CUSTOMER,
    ROLE_MAIN,
    BusbarZone,
    PrepState,
    analyse_prep,
    busbar_zones,
    control_target,
    joined,
)

PREP_RULE_ORDER: tuple[str, ...] = (
    "encl.control_block_missing", "encl.control_block_reserve", "encl.control_block_rail",
    "encl.control_block_overflow", "encl.control_block_target", "encl.control_block_bdew", "encl.control_tube",
    "encl.busbar_unjoined", "encl.busbar_role", "encl.supply_height", "encl.supply_existing",
    "encl.infeed_assumed", "encl.infeed_fuse", "encl.infeed_size", "encl.pen_split",
)
#: The number of terminals the BDEW Anwendungshilfe (Tab. 1) and VDE-AR-N 4100 name.
BDEW_TERMINALS = 6
NARROW_TUBE = "wago-211-501"
NARROW_TUBE_MAX_MM2 = 1.0

Finding = dict[str, str]


def _finding(rule: str, level: str, scope: str, message: str) -> Finding:
    return {"level": level, "scope": scope, "message": message, "rule": rule}


# ── The block (B, C, L) ──────────────────────────────────────────────────────


def _block_rules(document: Any, catalog: EnclosureCatalog, block: Mapping[str, Any] | None,
                 state: PrepState | None) -> Iterator[Finding]:
    carrier = control_carrier(document, catalog)
    if carrier is None:
        return
    field_no = carrier.field + 1
    if block is None:
        yield _finding("encl.control_block_missing", "info", "",
                       "Zählerschrank ohne §14a-Steuersignal-Klemmleiste: im ersten Zählerfeld anlegen.")
        return
    if block.get("off"):
        return
    if carrier.reserve:
        yield _finding("encl.control_block_reserve", "info", carrier.id,
                       f"§14a-Klemmleiste sitzt auf einem Reserve-Zählerfeld (Feld {field_no}).")
    if block.get("terminals") and not candidate_rails(document, catalog, carrier):
        yield _finding("encl.control_block_rail", "warn", carrier.id,
                       f"§14a-Klemmleiste: Feld {field_no} hat keine AAR-Hutschiene.")
    layout = state.layout if state is not None else control_block_layout(document, catalog, block=block)
    if layout is None:
        return
    yield from _placed_rules(document, catalog, block, layout, carrier)


def _placed_rules(document: Any, catalog: EnclosureCatalog, block: Mapping[str, Any], layout: BlockLayout,
                  carrier: Carrier) -> Iterator[Finding]:
    if layout.overflow:
        used = layout.rail.devices_mm
        used += layout.width_mm
        yield _finding("encl.control_block_overflow", "warn", carrier.id,
                       f"§14a-Klemmleiste passt nicht auf {layout.rail_title}: {mm_text(used)} mm von "
                       f"{mm_text(layout.rail.capacity_mm)} mm.")
    if control_target(document, catalog, carrier) is None:
        message = ("im Schrank fehlt ein APZ." if carrier.family == "meter_3p"
                   else f"Feld {carrier.field + 1} hat keinen RfZ.")
        yield _finding("encl.control_block_target", "warn", carrier.id, f"§14a-Steuerleitungen ohne Ziel: {message}")
    count = len(layout.terminals)
    if count != BDEW_TERMINALS:
        yield _finding("encl.control_block_bdew", "info", carrier.id,
                       f"§14a-Klemmleiste mit {count} statt 6 Klemmen — BDEW/VDE-AR-N 4100 sieht 6 vor.")
    mm2 = float(block.get("wire_mm2") or 0)
    if block.get("label_material") == NARROW_TUBE and mm2 > NARROW_TUBE_MAX_MM2:
        yield _finding("encl.control_tube", "warn", carrier.id,
                       f"Schrumpfschlauch 211-501 passt nur auf 0,75–1 mm² — Leitung ist {mm_text(mm2)} mm².")


# ── Busbars ──────────────────────────────────────────────────────────────────


def _role_gaps(members: list[BusbarZone]) -> Iterator[Finding]:
    fields = sorted({zone.field for zone in members})
    for a, b in zip(fields, fields[1:]):
        if b > a + 1:
            yield _finding("encl.busbar_unjoined", "warn", "",
                           f"Sammelschienen in Feld {a + 1} und Feld {b + 1} sind nicht verbunden: dazwischen liegt "
                           "kein Feld mit Sammelschiene.")
            continue
        pairs = [(x, y) for x in members if x.field == a for y in members if y.field == b]
        if any(joined(x, y) for x, y in pairs):
            continue
        if any(x.placed.module_id != y.placed.module_id for x, y in pairs):
            yield _finding("encl.busbar_unjoined", "warn", "",
                           f"Sammelschienen in Feld {a + 1} und Feld {b + 1} liegen nicht auf gleicher Höhe.")


def _busbar_rules(document: Any, catalog: EnclosureCatalog) -> Iterator[Finding]:
    zones = busbar_zones(document, catalog)
    for role in (ROLE_MAIN, ROLE_CUSTOMER):
        yield from _role_gaps([zone for zone in zones if zone.role == role])
    seen: set[tuple[str, str]] = set()
    for main in (zone for zone in zones if zone.role == ROLE_MAIN):
        for customer in (zone for zone in zones if zone.role == ROLE_CUSTOMER):
            if abs(main.field - customer.field) != 1 or main.placed.module_id == customer.placed.module_id:
                continue
            if not (main.placed.start < customer.placed.end and customer.placed.start < main.placed.end):
                continue
            message = (f"Sammelschiene in Feld {customer.field + 1} ist Kundenverteilung (gezählt) und wird nicht "
                       f"mit dem NAR von Feld {main.field + 1} verbunden.")
            if (customer.placed.module_id, message) not in seen:
                seen.add((customer.placed.module_id, message))
                yield _finding("encl.busbar_role", "info", customer.placed.module_id, message)


# ── Supply kit and infeed ────────────────────────────────────────────────────


def _active(state: PrepState, prefix: str) -> dict[str, Any] | None:
    return next((i for i in state.items if i["key"].startswith(prefix) and not i["suppressed"]), None)


def _supply_rules(document: Any, state: PrepState) -> Iterator[Finding]:
    height = state.facts.get("supply_height")
    if height is not None:
        yield _finding("encl.supply_height", "warn", "",
                       f"Spannungsversorgung RfZ/APZ: Schrankhöhe {height} mm nicht im Hager-Programm — "
                       "Bestückungspaket selbst wählen.")
    tap = state.facts.get("supply_existing")
    if tap is not None:
        yield _finding("encl.supply_existing", "info", "",
                       f"Spannungsabgriff bereits geplant ({tap[0]}, {tap[1]}) — Bestückungspaket nicht ergänzt; "
                       "Leitungen zu RfZ/APZ prüfen.")
    infeed = state.infeed
    if infeed is not None and infeed.get("assumed"):
        yield _finding("encl.infeed_assumed", "info", "",
                       "Querschnitt der Zuleitung unbekannt: Einspeiseadapter K96ESA5 (bis 25 mm²) angenommen. "
                       "Im Tab Daten bei „Zuleitung“ eintragen.")
    supply = document.get("supply") if isinstance(document.get("supply"), dict) else {}
    amps = parse_fuse_amps(supply.get("fuse"))
    if _active(state, "accessory:K96ESA5") is not None and amps is not None and amps > K96ESA5_MAX_FUSE_A:
        yield _finding("encl.infeed_fuse", "warn", "",
                       f"Einspeiseadapter K96ESA5 nur hinter höchstens NH00 gG 100 A: Vorsicherung "
                       f"„{text(supply.get('fuse'))}“ prüfen.")
    size = state.facts.get("infeed_size")
    if size is not None:
        yield _finding("encl.infeed_size", "warn", "",
                       f"Zuleitung {mm_text(size)} mm²: keine Sammelschienenklemme für 12×5 mm bis 185 mm² — "
                       "Einspeisung gesondert planen.")
    pen = state.facts.get("pen_field")
    if pen is not None:
        yield _finding("encl.pen_split", "info", "",
                       f"Zuleitung 4-adrig im TN-C-S-System: PEN im NAR von Feld {pen + 1} in PE und N aufteilen.")


def prep_findings(document: Any, catalog: EnclosureCatalog, *, block: Any = DERIVE) -> list[Finding]:
    """Every round-4 finding of a board (unsorted; the caller sorts)."""
    parsed = resolve_block(document, block)
    state = analyse_prep(document, catalog, block=parsed)
    findings = [*_block_rules(document, catalog, parsed, state), *_busbar_rules(document, catalog)]
    if state is not None:
        findings += _supply_rules(document, state)
    return findings
