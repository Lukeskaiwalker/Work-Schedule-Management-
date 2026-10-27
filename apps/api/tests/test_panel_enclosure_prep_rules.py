"""The round-4 findings (docs/PANEL_ENCLOSURE_R4.md §4).

Every rule's condition and German text, its level and scope, and where the
rules sit in ``RULE_ORDER``. The fixture's ``findings`` pin the same answers
for the TypeScript twin.
"""

from __future__ import annotations

import json

from app.schemas.panel_enclosure import EnclosureSpec, ModuleSpec
from app.services.panel_enclosure_catalog import CatalogEntry, EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_control_block import default_control_block
from app.services.panel_enclosure_prep_rules import PREP_RULE_ORDER, prep_findings
from app.services.panel_enclosure_rules import RULE_ORDER, enclosure_findings
from app.services.panel_enclosure_layout import text
from app.services.panel_enclosure_terminal_rules import TERMINAL_RULE_ORDER
from scripts.write_enclosure_fixtures import (
    EDGE_TRIM_CASES,
    FIXTURE_PATH,
    busbar_gap_zb34s,
    control_3p_zb53s,
    dev,
    document,
    ls,
    meter_dist_zb33s,
    module,
    reserve_zb33s,
    row,
    two_meters_busbar_zb34s,
)

CATALOG = builtin_catalog()


def _doc(cabinet: str, modules: list[dict], rows: list[dict] | None = None, **extra: object) -> dict:
    return document(cabinet, modules, rows or [], **extra)


def _rules(doc: dict, catalog: EnclosureCatalog = CATALOG) -> list[tuple[str, str, str, str]]:
    return [(f["rule"], f["level"], f["scope"], f["message"]) for f in prep_findings(doc, catalog)]


def _rule(doc: dict, rule: str, catalog: EnclosureCatalog = CATALOG) -> list[tuple[str, str, str]]:
    return [(level, scope, message) for name, level, scope, message in _rules(doc, catalog) if name == rule]


def _block(**overrides: object) -> dict:
    return {**default_control_block(), **overrides}


def _with(*specs: dict) -> EnclosureCatalog:
    entries = dict(CATALOG.entries)
    for raw in specs:
        spec = ModuleSpec.model_validate(raw).model_dump()
        entries[spec["code"]] = CatalogEntry(spec["code"], "module", spec, "custom", False)
    return EnclosureCatalog(entries)


def _cabinet_catalog(height: int, units: int) -> EnclosureCatalog:
    raw = {"code": "ZX9TEST", "article_no": "ZX9TEST", "name": "Testschrank", "height_mm": height,
           "width_mm": 800, "depth_mm": 205, "fields": 3, "door_leaves": 2, "units_per_field": units,
           "ip": "IP44", "door": "Test", "verified": True}
    spec = EnclosureSpec.model_validate(raw).model_dump()
    return EnclosureCatalog({**CATALOG.entries, "ZX9TEST": CatalogEntry("ZX9TEST", "enclosure", spec, "custom", False)})


def _meter_spec(code: str, *, family: str = "meter_ehz", aar_rails: bool = True, rfz: bool = True) -> dict:
    rails = [{"key": "aar1", "unit": 0, "ple": 12, "mount": "rail"}] if aar_rails else []
    zones = [{"key": "aar", "type": "AAR", "unit": 0, "units": 2, "rails": rails}]
    if rfz:
        zones.append({"key": "rfz", "type": "RFZ", "unit": 2, "units": 1,
                      "rails": [{"key": "rfz", "unit": 0, "ple": 12, "mount": "rail"}]})
    zones += [{"key": "zf", "type": "ZF", "unit": 3, "units": 2, "meter_places": 1,
               "meter_type": "ehz" if family == "meter_ehz" else "3punkt"},
              {"key": "nar", "type": "NAR", "unit": 5, "units": 2,
               "rails": [{"key": "nar", "unit": 0, "ple": 12, "mount": "busbar"}]}]
    return {"code": code, "article_no": code, "name": f"Testfeld {code}", "family": family, "field_height_mm": 1050,
            "width_fields": 1, "height_units": 7, "zones": zones, "verified": True}


# ── the order ────────────────────────────────────────────────────────────────


def test_the_round_four_rules_sit_between_the_meter_places_and_the_terminals() -> None:
    assert PREP_RULE_ORDER == (
        "encl.control_block_missing", "encl.control_block_reserve", "encl.control_block_rail",
        "encl.control_block_overflow", "encl.control_block_target", "encl.control_block_bdew", "encl.control_tube",
        "encl.busbar_unjoined", "encl.busbar_meters", "encl.busbar_role", "encl.supply_height",
        "encl.supply_existing", "encl.infeed_assumed", "encl.infeed_fuse", "encl.infeed_size", "encl.infeed_small",
        "encl.pen_split",
    )
    start = RULE_ORDER.index(PREP_RULE_ORDER[0])
    assert RULE_ORDER[start - 1] == "encl.meter_place_invalid"
    assert RULE_ORDER[start:start + len(PREP_RULE_ORDER)] == PREP_RULE_ORDER
    assert RULE_ORDER[start + len(PREP_RULE_ORDER)] == TERMINAL_RULE_ORDER[0]


def test_the_board_findings_include_them_sorted_and_never_raise_on_garbage() -> None:
    findings = enclosure_findings(busbar_gap_zb34s(), CATALOG)
    keys = [(RULE_ORDER.index(f["rule"]), f["scope"], f["message"]) for f in findings]
    assert keys == sorted(keys)
    garbage = {"enclosure": {"code": "ZB33S", "modules": [{"id": "m", "code": "ZH3EL27", "field": "x"}],
                             "control_block": {"terminals": [None, {"id": 3}]}, "prep": [1]},
               "rows": "nope", "supply": None}
    rules = {f["rule"] for f in enclosure_findings(garbage, CATALOG)}
    assert "encl.control_block_bdew" in rules  # the one usable terminal is placed
    assert "encl.control_block_missing" in {f["rule"] for f in enclosure_findings(garbage, CATALOG, block=None)}


# ── the block ────────────────────────────────────────────────────────────────


def test_missing_only_with_a_carrier_and_without_any_stored_block() -> None:
    assert _rule(meter_dist_zb33s(), "encl.control_block_missing") == [
        ("info", "", "Zählerschrank ohne §14a-Steuersignal-Klemmleiste: im ersten Zählerfeld anlegen.")]
    removed = _doc("ZB33S", [module("m-z", "ZH3EH16", 0, {})], control_block=_block(off=True))
    assert _rule(removed, "encl.control_block_missing") == []
    assert _rules(removed) == []  # a removed block says nothing at all
    no_meter = _doc("ZB33S", [module("m-v", "ZU37KS", 0, {})])
    assert _rule(no_meter, "encl.control_block_missing") == []


def test_reserve_when_every_meter_field_is_a_reserve_one() -> None:
    doc = _doc("ZB33S", [module("m-r", "ZH33XL", 1, {})], control_block=_block())
    assert _rule(doc, "encl.control_block_reserve") == [
        ("info", "m-r", "§14a-Klemmleiste sitzt auf einem Reserve-Zählerfeld (Feld 2).")]
    assert _rule(reserve_zb33s(), "encl.control_block_reserve") == []


def test_rail_when_the_carrier_has_no_aar_din_rail() -> None:
    catalog = _with(_meter_spec("ZX3NOAAR", aar_rails=False))
    doc = _doc("ZB33S", [module("m-x", "ZX3NOAAR", 0, {}, fittings=[])], control_block=_block())
    assert _rule(doc, "encl.control_block_rail", catalog) == [
        ("warn", "m-x", "§14a-Klemmleiste: Feld 1 hat keine AAR-Hutschiene.")]
    empty = _doc("ZB33S", [module("m-x", "ZX3NOAAR", 0, {}, fittings=[])], control_block=_block(terminals=[]))
    assert _rule(empty, "encl.control_block_rail", catalog) == []


def test_overflow_names_the_rail_and_the_millimetres() -> None:
    rows = [row("r-a1", "F1 · AAR 1", [dev(f"d{i}", "mcb") for i in range(11)]),
            row("r-a2", "F1 · AAR 2", [dev(f"e{i}", "mcb") for i in range(10)])]
    doc = _doc("ZB33S", [module("m-z", "ZH3EH16", 0, {"aar1": "r-a1", "aar2": "r-a2"})], rows,
               control_block=_block())
    assert _rule(doc, "encl.control_block_overflow") == [
        ("warn", "m-z", "§14a-Klemmleiste passt nicht auf F1 · AAR 1: 236,7 mm von 210 mm.")]


def test_target_missing_for_both_meter_kinds() -> None:
    three = _doc("ZB33S", [module("m-p", "ZH33X7", 0, {})], control_block=_block())
    assert _rule(three, "encl.control_block_target") == [
        ("warn", "m-p", "§14a-Steuerleitungen ohne Ziel: im Schrank fehlt ein APZ.")]
    catalog = _with(_meter_spec("ZX3NORFZ", rfz=False))
    ehz = _doc("ZB33S", [module("m-x", "ZX3NORFZ", 1, {}, fittings=[])], control_block=_block())
    assert _rule(ehz, "encl.control_block_target", catalog) == [
        ("warn", "m-x", "§14a-Steuerleitungen ohne Ziel: Feld 2 hat keinen RfZ.")]


def test_bdew_and_tube_on_the_three_point_board() -> None:
    rules = _rules(control_3p_zb53s())
    assert ("encl.control_block_bdew", "info", "mod-p",
            "§14a-Klemmleiste mit 5 statt 6 Klemmen — BDEW/VDE-AR-N 4100 sieht 6 vor.") in rules
    assert ("encl.control_tube", "warn", "mod-p",
            "Schrumpfschlauch 211-501 passt nur auf 0,75–1 mm² — Leitung ist 2,5 mm².") in rules


def test_the_narrow_tube_takes_one_mm2_at_most_and_the_wide_one_any_choice() -> None:
    doc = _doc("ZB33S", [module("m-z", "ZH3EH16", 0, {})],
               control_block=_block(label_material="wago-211-501", wire_mm2=1.5))
    assert _rule(doc, "encl.control_tube") == [
        ("warn", "m-z", "Schrumpfschlauch 211-501 passt nur auf 0,75–1 mm² — Leitung ist 1,5 mm².")]
    doc2 = _doc("ZB33S", [module("m-z", "ZH3EH16", 0, {})], control_block=_block(wire_mm2=1.5))
    assert _rule(doc2, "encl.control_tube") == []


# ── busbars ──────────────────────────────────────────────────────────────────


def test_a_field_without_busbar_between_two_main_runs() -> None:
    assert _rule(busbar_gap_zb34s(), "encl.busbar_unjoined") == [
        ("warn", "", "Sammelschienen in Feld 1 und Feld 3 sind nicht verbunden: dazwischen liegt kein Feld mit "
                     "Sammelschiene.")]


def test_a_gap_filled_by_the_other_role_names_the_role() -> None:
    """Customer busbars between two NAR runs: the gap is the role split, not a missing busbar."""
    doc = _doc("ZB33S", [module("m-a", "ZH3EL27", 0, {}), module("m-s", "ZH3ES5", 1, {}),
                         module("m-b", "ZH3EL27", 2, {})])
    assert _rule(doc, "encl.busbar_unjoined") == [
        ("warn", "", "Sammelschienen in Feld 1 und Feld 3 sind nicht verbunden: dazwischen liegt Kundenverteilung "
                     "(gezählt), keine Hauptleitung.")]
    customers = _doc("ZB33S", [module("m-a", "ZH3ES5", 0, {}), module("m-e", "ZH3EL27", 1, {}),
                               module("m-b", "ZH3ES5", 2, {})])
    assert ("warn", "", "Kundensammelschienen in Feld 1 und Feld 3 sind nicht verbunden: dazwischen liegt die "
                        "Hauptleitung (ungezählt).") in _rule(customers, "encl.busbar_unjoined")


def test_customer_busbars_of_different_meters_are_named_and_never_called_unjoined() -> None:
    assert _rule(two_meters_busbar_zb34s(), "encl.busbar_meters") == [
        ("info", "", "Sammelschienen in Feld 3 und Feld 4 gehören zu verschiedenen Zählern und werden nicht "
                     "verbunden.")]
    assert _rule(two_meters_busbar_zb34s(), "encl.busbar_unjoined") == []
    assert _rule(two_meters_busbar_zb34s(second_feed="dev-m1-q1"), "encl.busbar_meters") == []
    # Two flats, each with its meter field and its own distribution: no gap to close between them.
    rows = [*_feed_rows("a", "F1 · AAR 1", "F2 · Verteiler 3"), *_feed_rows("b", "F3 · AAR 1", "F4 · Verteiler 3")]
    flats = _doc("ZB34S", [module("m-a", "ZH3EL27", 0, {"aar1": "r-a-hs"}), module("m-s", "ZH3ES5", 1, {"r3": "r-a-v"}),
                           module("m-b", "ZH3EL27", 2, {"aar1": "r-b-hs"}), module("m-t", "ZH3ES5", 3, {"r3": "r-b-v"})],
                 rows)
    assert [m for _l, _s, m in _rule(flats, "encl.busbar_unjoined") if m.startswith("Kundensammelschienen")] == []


def _feed_rows(prefix: str, switch_rail: str, rail: str) -> list[dict]:
    return [row(f"r-{prefix}-hs", switch_rail, [dev(f"d-{prefix}-q", "hauptschalter", designation=f"Q{prefix}")]),
            row(f"r-{prefix}-v", rail, [dev(f"d-{prefix}-f", "rcd", designation=f"F{prefix}", parent_id=f"d-{prefix}-q")])]


def test_neighbours_at_different_heights() -> None:
    doc = _doc("ZB54S", [module("m-e", "ZH3EL27", 0, {}), module("m-f", "ZH5EL27", 1, {})])
    assert _rule(doc, "encl.busbar_unjoined") == [
        ("warn", "", "Sammelschienen in Feld 1 und Feld 2 liegen nicht auf gleicher Höhe.")]


def test_a_customer_busbar_beside_a_nar_is_named_once() -> None:
    assert _rule(control_3p_zb53s(), "encl.busbar_role") == [
        ("info", "mod-s", "Sammelschiene in Feld 2 ist Kundenverteilung (gezählt) und wird nicht mit dem NAR von "
                          "Feld 1 verbunden.")]
    # A Verteilerfeld whose SAS holds an SLS is main: joined, no role note.
    rows = [row("r-sas", "F2 · Sammelschienen", [dev("d-q", "sls", designation="Q5", rating="E35")])]
    doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {}), module("m-s", "ZH3ES5", 1, {"sas": "r-sas"})], rows)
    assert _rule(doc, "encl.busbar_role") == [] and _rule(doc, "encl.busbar_unjoined") == []


# ── supply kit and infeed ────────────────────────────────────────────────────


def test_supply_height_and_existing_tap() -> None:
    rows = [row("r-rfz", "F1 · RfZ", [ls("d-tap", "F9", "9", "SMGW", rating="B6")])]
    doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {"rfz": "r-rfz"})], rows)
    assert _rule(doc, "encl.supply_existing") == [
        ("info", "", "Spannungsabgriff bereits geplant (F9, F1 · RfZ) — Bestückungspaket nicht ergänzt; Leitungen "
                     "zu RfZ/APZ prüfen.")]
    catalog = _cabinet_catalog(1250, 8)
    modules = [module("m-e", "ZH3EL27", 0, {})]
    odd = _doc("ZB33S", modules) | {"enclosure": {"code": "ZX9TEST", "modules": modules}}
    assert _rule(odd, "encl.supply_height", catalog) == [
        ("warn", "", "Spannungsversorgung RfZ/APZ: Schrankhöhe 1250 mm nicht im Hager-Programm — Bestückungspaket "
                     "selbst wählen.")]
    assert _rule(_doc("ZB33S", [module("m-v", "ZU37KS", 0, {})]), "encl.supply_height") == []


def test_infeed_assumed_fuse_size_and_pen_split() -> None:
    rules = _rules(busbar_gap_zb34s())
    assert ("encl.infeed_assumed", "info", "",
            "Querschnitt der Zuleitung unbekannt: Einspeiseadapter K96ESA5 (bis 25 mm²) angenommen. Im Tab Daten bei "
            "„Zuleitung“ eintragen.") in rules
    assert ("encl.infeed_fuse", "warn", "",
            "Einspeiseadapter K96ESA5 nur hinter höchstens NH00 gG 100 A: Vorsicherung „NH 125 A“ prüfen.") in rules
    big = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": "NYY-J 4x240"})
    assert _rule(big, "encl.infeed_size") == [
        ("warn", "", "Zuleitung 240 mm²: keine Sammelschienenklemme für 12×5 mm bis 185 mm² — Einspeisung gesondert "
                     "planen.")]
    assert _rule(reserve_zb33s(), "encl.pen_split") == [
        ("info", "", "Zuleitung 4-adrig im TN-C-S-System: PEN im NAR von Feld 1 in PE und N aufteilen.")]


def test_a_conductor_too_small_for_any_clamp_is_named() -> None:
    doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": "NYM-J 5x1,5"}, prep={"infeed": "clamps"})
    assert _rule(doc, "encl.infeed_small") == [
        ("warn", "", "Zuleitung 1,5 mm²: keine Sammelschienenklemme für 12×5 mm in diesem Querschnitt — "
                     "Einspeiseadapter K96ESA5 verwenden.")]
    al = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": "NAYY-J 4x6"})
    assert _rule(al, "encl.infeed_small") == [
        ("warn", "", "Zuleitung 6 mm² Al: keine Sammelschienenklemme für 12×5 mm in diesem Querschnitt — "
                     "Einspeisung gesondert planen.")]
    assert _rule(_doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": "NYM-J 5x1,5"}),
                 "encl.infeed_small") == []  # the automatic adapter takes it


def test_the_edge_trim_is_one_set_on_both_twins() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert [entry["output"] for entry in fixture["edge_trim"]] == [text(v) for v in EDGE_TRIM_CASES]
    assert [text(v) for v in ("\ufeff", "\ufeffQ1", "Q1\u001c", "\u0085", " F1 ")] == ["", "Q1", "Q1", "", "F1"]
    rows = [row("r-nar", "F1 · NAR", [dev("d-tap", "mcb", designation="\ufeff", rating="B6")])]
    doc = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {"nar": "r-nar"})], rows,
               supply={"incoming": "", "fuse": "\ufeffNH00 160 A\u001c"})
    assert _rule(doc, "encl.infeed_fuse") == [
        ("warn", "", "Einspeiseadapter K96ESA5 nur hinter höchstens NH00 gG 100 A: Vorsicherung „NH00 160 A“ prüfen.")]
    assert _rule(doc, "encl.supply_existing")[0][2].startswith("Spannungsabgriff bereits geplant (LS, F1 · NAR)")


def test_the_fuse_note_needs_an_active_adapter() -> None:
    clamps = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": "NYY-J 5x50", "fuse": "NH 160 A"})
    assert _rule(clamps, "encl.infeed_fuse") == []
    off = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"fuse": "NH 160 A"}, prep={"infeed": "off"})
    assert _rule(off, "encl.infeed_fuse") == []
    small = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"fuse": "NH00 100A"})
    assert _rule(small, "encl.infeed_fuse") == []


def test_assumed_only_for_the_automatic_adapter() -> None:
    forced = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": ""}, prep={"infeed": "K96ESA5"})
    assert _rule(forced, "encl.infeed_assumed") == []
    off = _doc("ZB33S", [module("m-e", "ZH3EL27", 0, {})], supply={"incoming": ""}, prep={"infeed": "off"})
    assert _rule(off, "encl.infeed_assumed") == []
