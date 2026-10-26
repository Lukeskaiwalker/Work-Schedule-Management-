"""Placement rules and geometric problems as findings (docs/PANEL_ENCLOSURE.md §5).

D6: warn, never block — a board captured half-built must save, so every rule
is a finding with a ``rule`` id, and the function never raises. Each rule is
shown firing on a minimal change to the compliant reference board and
staying silent on the board itself.
"""

from __future__ import annotations

import copy
import json
import logging

import pytest
from fastapi.testclient import TestClient

from app.schemas.panel_enclosure import ModuleSpec
from app.services.panel_enclosure_catalog import CatalogEntry, EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_rules import RULE_ORDER, enclosure_findings
from scripts.write_enclosure_fixtures import (
    FIXTURE_PATH,
    cross_feed_zb33s,
    custom_apz_middle_spec,
    dev,
    document,
    fi,
    ls,
    meter,
    meter_dist_zb33s,
    module,
    row,
    supplied,
    tall_zb54s,
    violations_zb34s,
)
from tests.panel_enclosure_helpers import auth, create_panel


def _catalog_with(*specs: dict) -> EnclosureCatalog:
    """The built-ins, the fixture's custom APZ field, and ``specs``."""
    entries = dict(builtin_catalog().entries)
    for raw in (custom_apz_middle_spec(), *specs):
        spec = ModuleSpec.model_validate(raw).model_dump()
        entries[spec["code"]] = CatalogEntry(spec["code"], "module", spec, "custom", False)
    return EnclosureCatalog(entries)


def _findings(doc: dict, catalog: EnclosureCatalog | None = None) -> list[dict]:
    return enclosure_findings(doc, catalog or _catalog_with())


def _rule(doc: dict, rule: str, catalog: EnclosureCatalog | None = None) -> list[tuple[str, str, str]]:
    return [(f["level"], f["scope"], f["message"]) for f in _findings(doc, catalog) if f["rule"] == rule]


def _rows(doc: dict) -> dict[str, dict]:
    return {r["id"]: r for r in doc["rows"]}


def _module(doc: dict, module_id: str) -> dict:
    return next(m for m in doc["enclosure"]["modules"] if m["id"] == module_id)


# ── the shared fixture ───────────────────────────────────────────────────────


def test_findings_match_the_fixture_on_every_board() -> None:
    fixtures = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    catalog = EnclosureCatalog.from_out(fixtures["catalog"])
    for name, board in fixtures["boards"].items():
        assert enclosure_findings(board["document"], catalog) == board["findings"], name


def test_the_compliant_reference_board_has_no_warning() -> None:
    findings = _findings(meter_dist_zb33s())
    assert [f for f in findings if f["level"] == "warn"] == []
    # Round 4: a board older than the §14a block is told to add one (info, R4-2).
    assert {f["rule"] for f in findings} == {"encl.unverified", "encl.terminals", "encl.control_block_missing"}


def test_findings_come_sorted_by_rule_then_scope_then_message() -> None:
    findings = _findings(violations_zb34s())
    keys = [(RULE_ORDER.index(f["rule"]), f["scope"], f["message"]) for f in findings]
    assert keys == sorted(keys)
    assert all(set(f) == {"level", "scope", "message", "rule"} for f in findings)


def test_vde_findings_say_which_rule_book() -> None:
    for finding in _findings(violations_zb34s()):
        assert finding["message"].startswith("VDE-AR-N 4100: ") == finding["rule"].startswith("vde."), finding


def test_a_board_without_a_cabinet_has_no_cabinet_findings() -> None:
    doc = meter_dist_zb33s()
    assert _findings({**doc, "enclosure": None}) == []


# ── catalogue and geometry ───────────────────────────────────────────────────


def test_unknown_codes_are_placeholders() -> None:
    doc = meter_dist_zb33s()
    _module(doc, "mod-v")["code"] = "ZX00GONE"
    assert _rule(doc, "encl.unknown_code") == [
        ("warn", "mod-v", "Unbekannter oder fehlerhafter Katalogcode ZX00GONE — nur als Platzhalter gezeigt.")]
    doc["enclosure"]["code"] = "ZX00CAB"
    assert ("warn", "", "Unbekannter oder fehlerhafter Katalogcode ZX00CAB — nur als Platzhalter gezeigt.") in _rule(
        doc, "encl.unknown_code")


def test_an_invalid_entry_counts_as_unknown() -> None:
    entries = dict(builtin_catalog().entries)
    entries["ZX00BAD"] = CatalogEntry("ZX00BAD", "module", None, "custom", False, invalid=True)
    doc = meter_dist_zb33s()
    _module(doc, "mod-v")["code"] = "ZX00BAD"
    assert [r[1] for r in _rule(doc, "encl.unknown_code", EnclosureCatalog(entries))] == ["mod-v"]


def test_modules_out_of_bounds_overlapping_or_of_the_wrong_height() -> None:
    doc = document("ZB33S", [
        module("a", "ZU62A", 0, {}), module("b", "ZU79A", 0, {}),
        module("c", "ZU37KS", 3, {}), module("d", "ZU62A", 1, {}, unit=7),
        module("e", "ZH5EL27", 2, {}),
    ], [])
    assert _rule(doc, "encl.overlap") == [("warn", "b", "ZU62A und ZU79A überlappen in Feld 1.")]
    assert _rule(doc, "encl.out_of_bounds") == [
        ("warn", "c", "ZU37KS: ragt aus dem Schrank (Feld 4)."),
        ("warn", "d", "ZU62A: ragt aus dem Schrank (Feld 2)."),
        ("warn", "e", "ZH5EL27: ragt aus dem Schrank (Feld 3)."),
    ]
    assert _rule(doc, "encl.height_mismatch") == [("warn", "e", "ZH5EL27: für 1350 mm Felder — passt nicht in ZB33S.")]


def test_free_units_ask_for_a_cover() -> None:
    assert _rule(cross_feed_zb33s(), "encl.field_gap") == [
        ("info", "", "Feld 2: 1050 mm ohne Modul — Abdeckung einplanen.")]
    assert _rule(tall_zb54s(), "encl.field_gap") == [("info", "", "Feld 4: 1200 mm ohne Modul — Abdeckung einplanen.")]


# ── rows and rails ───────────────────────────────────────────────────────────


def test_a_row_outside_the_cabinet_is_named() -> None:
    doc = meter_dist_zb33s()
    doc["rows"].append(row("row-loose", "Reihe 9", [ls("d9", "F9", "9", "x")]))
    assert _rule(doc, "encl.row_unlinked") == [("info", "row-loose", "Reihe 9: keiner Hutschiene im Schrank zugeordnet.")]


def test_stale_and_retired_rails() -> None:
    doc = meter_dist_zb33s()
    doc["rows"].append(row("row-stale", "Alt", [ls("d9", "F9", "9", "x")]))
    _module(doc, "mod-z")["rails"]["aar9"] = "row-stale"
    assert _rule(doc, "encl.stale_rail") == [
        ("warn", "row-stale", "Alt: Hutschiene „aar9“ gibt es in ZH3EH16 nicht — gilt als „Nicht im Schrank“.")]
    assert _rule(doc, "encl.row_unlinked") == []
    assert _rule(violations_zb34s(), "encl.stale_rail") == [
        ("info", "row-c5", "F4 · Verteiler 5: Hutschiene „r5“ in ZX37APZM ist ausgemustert — Geräte umsetzen.")]


def test_rows_out_of_physical_order() -> None:
    assert _rule(cross_feed_zb33s(), "encl.row_order") == [
        ("warn", "", "Reihenfolge der Reihen passt nicht zum Schrank — im Tab Schrank „Reihen ordnen“ tippen.")]
    doc = meter_dist_zb33s()
    doc["rows"] = [doc["rows"][1], doc["rows"][0], *doc["rows"][2:]]
    assert len(_rule(doc, "encl.row_order")) == 1


def test_an_overflowing_rail_unless_the_slot_warning_says_it() -> None:
    doc = meter_dist_zb33s()
    rail = _rows(doc)["row-v2"]
    rail["devices"] += [fi("x1", "F8"), fi("x2", "F9")]
    rail["slots"] = 18
    assert _rule(doc, "encl.rail_overflow") == [("warn", "row-v2", "F2 · Verteiler 4: 245 mm Geräte auf 12 PLE Hutschiene.")]
    rail["slots"] = 12
    assert _rule(doc, "encl.rail_overflow") == []


def test_a_claim_on_a_part_no_module_has() -> None:
    doc = meter_dist_zb33s()
    _rows(doc)["row-v2"]["devices"].append(dev("t", "terminal", designation="X5", supplied_by=supplied("mod-z", "busbar")))
    _rows(doc)["row-v1"]["devices"].append(dev("g", "spd", supplied_by=supplied("mod-gone", "hs")))
    assert _rule(doc, "encl.supplied_dangling") == [
        ("info", "g", "SPD: gehört zu keinem Modul mehr — zählt als eigenes Gerät."),
        ("info", "t", "X5: gehört zu keinem Modul mehr — zählt als eigenes Gerät."),
    ]


def test_positional_circuits_fed_from_another_field() -> None:
    assert _rule(cross_feed_zb33s(), "encl.cross_module_feed") == [
        ("warn", "row-r1",
         "F3 · Verteiler 1: 2 Stromkreis(e) hängen an F1 aus einem anderen Feld — FI davor setzen oder Einspeisung prüfen.")]
    doc = cross_feed_zb33s()
    for item in _rows(doc)["row-r1"]["devices"]:
        item["parent_id"] = "dev-f1"  # an explicit feed is a decision, not an accident
    assert _rule(doc, "encl.cross_module_feed") == []


def test_unverified_catalogue_data_once_per_code() -> None:
    doc = meter_dist_zb33s()
    doc["enclosure"]["modules"].append(module("mod-z2", "ZH3EH16", 1, {}, unit=0))
    assert _rule(doc, "encl.unverified") == [(
        "info", "mod-z",
        "ZH3EH16: Katalogdaten ungeprüft — Feldaufbau (AAR oben, RfZ, eHZ, NAR unten) aus Hager Tipp 44 abgeleitet.")]


def test_a_din_rail_meter_on_a_board_with_meter_places() -> None:
    doc = meter_dist_zb33s()
    _rows(doc)["row-v2"]["devices"].append(dev("p1", "meter", designation="P1"))
    assert _rule(doc, "encl.meter_device") == [
        ("info", "p1", "P1: Zwischenzähler auf der Hutschiene — eHZ/3-Punkt gehören auf den Zählerplatz.")]
    no_places = cross_feed_zb33s()
    no_places["rows"][0]["devices"].append(dev("p1", "meter"))
    assert _rule(no_places, "encl.meter_device") == []


def test_meter_places_that_do_not_exist_or_stay_free() -> None:
    doc = meter_dist_zb33s()
    _module(doc, "mod-z")["meters"] = [meter(3, "1XYZ0000000003")]
    assert _rule(doc, "encl.meter_place_invalid") == [
        ("info", "mod-z", "ZH3EH16: Zählerplatz 4 gibt es nicht — Eintrag wird ignoriert.")]
    assert _rule(doc, "vde.meter_place_empty") == [(
        "info", "mod-z",
        "VDE-AR-N 4100: Zählerplatz 1 in Feld 1 als Reserve geplant — Blindabdeckung steht auf der Materialliste.")]


def test_terminal_strips_are_stated_per_field() -> None:
    # Round 2 places them on the field's two top rails (R2 §4.1); the other
    # nine terminal rules: tests/test_panel_enclosure_terminal_rules.py.
    assert _rule(meter_dist_zb33s(), "encl.terminals") == [
        ("info", "", "Feld 2: 4 Reihenklemmen auf den oberen Hutschienen, 30,7 von 420 mm belegt."),
        ("info", "", "Feld 3: 3 Reihenklemmen auf den oberen Hutschienen, 25,5 von 420 mm belegt."),
    ]


# ── VDE-AR-N 4100 ────────────────────────────────────────────────────────────


def test_one_sls_per_occupied_meter_place() -> None:
    assert _rule(violations_zb34s(), "vde.nar_sls") == [
        ("warn", "mod-d", "VDE-AR-N 4100: Feld 2 (ZH3EL22): 1 SLS-Schalter für 2 Zählerplatz/-plätze im NAR."),
        ("warn", "mod-p", "VDE-AR-N 4100: Feld 3 (ZH33X7): 0 SLS-Schalter für 1 Zählerplatz/-plätze im NAR."),
    ]
    doc = meter_dist_zb33s()
    _module(doc, "mod-z")["meters"] = []
    _rows(doc)["row-nar"]["devices"] = []
    # No occupied place still needs one SLS: need = max(1, occupied).
    assert len(_rule(doc, "vde.nar_sls")) == 1


def test_an_sls_on_the_busbar_field_is_credited_to_an_adjacent_meter_field_once() -> None:
    assert _rule(tall_zb54s(), "vde.nar_sls") == []
    doc = tall_zb54s()
    # Move the busbar field away from the meter fields: no credit.
    _module(doc, "mod-s")["field"], _module(doc, "mod-c")["field"] = 3, 2
    assert [r[1] for r in _rule(doc, "vde.nar_sls")] == ["mod-t"]
    # Two short meter fields either side of one SAS SLS: the first in field order takes it.
    doc = tall_zb54s()
    _rows(doc)["row-m-nar"]["devices"] = []
    _module(doc, "mod-s")["field"], _module(doc, "mod-t")["field"] = 1, 2
    flagged = [r[1] for r in _rule(doc, "vde.nar_sls")]
    assert flagged == ["mod-t"]


def test_what_belongs_on_the_nar() -> None:
    assert _rule(violations_zb34s(), "vde.nar_contents") == [
        ("warn", "dev-e-f0", "VDE-AR-N 4100: NAR ZH3EL27: NH/Neozed ist nicht als Trennvorrichtung zulässig — SLS verwenden."),
        ("warn", "dev-e-fi", "VDE-AR-N 4100: NAR ZH3EL27: FI gehört nicht in den NAR."),
    ]
    doc = meter_dist_zb33s()
    nar = _rows(doc)["row-nar"]["devices"]
    nar += [ls("tap", "F0.1", "", "Spannungsabgriff", rating="B10"), ls("big", "F0.2", "", "x", rating="B16"),
            ls("bare", "F0.3", "", "x", rating=""), dev("rcbo", "rcbo", designation="F0.4", rating="B10")]
    assert [r[1] for r in _rule(doc, "vde.nar_contents")] == ["bare", "big", "rcbo"]


def test_the_sls_must_suit_the_field_wiring() -> None:
    assert _rule(violations_zb34s(), "vde.sls_rating") == [
        ("warn", "dev-e-q0", "VDE-AR-N 4100: Feld 1 (ZH3EL27): SLS E50 zu groß für 10 mm² Feldverdrahtung (max. E35).")]
    doc = document("ZB33S", [module("m", "ZH3EL16", 0, {"nar": "nar"})],
                   [row("nar", "nar", [dev("q", "sls", designation="Q0", rating="E50")])])
    assert _rule(doc, "vde.sls_rating") == []
    _rows(doc)["nar"]["devices"][0]["rating"] = "E63"
    assert [r[2].endswith("(max. E50).") for r in _rule(doc, "vde.sls_rating")] == [True]
    # Unknown wiring: silent rather than a guess from the article code.
    assert _rule(meter_dist_zb33s(), "vde.sls_rating") == []


def test_the_aar_takes_main_switches_and_up_to_three_small_circuits_per_place() -> None:
    assert _rule(violations_zb34s(), "vde.aar_contents") == [
        ("warn", "dev-k1", "VDE-AR-N 4100: AAR ZH3EL27: Schütz gehört nicht in den AAR — kein Stromkreisverteiler.")]
    assert _rule(violations_zb34s(), "vde.aar_circuits") == [
        ("warn", "mod-e", "VDE-AR-N 4100: AAR ZH3EL27: höchstens drei Stromkreise je Zählerplatz, je max. 16 A.")]
    doc = meter_dist_zb33s()
    aar = _rows(doc)["row-aar2"]["devices"]
    aar += [dev("pv", "pv", designation="F21", rating="B16"), dev("wb", "wallbox", designation="F22", rating="B16"),
            ls("a3", "F23", "", "x")]
    assert _rule(doc, "vde.aar_contents") == []
    assert _rule(doc, "vde.aar_circuits") == []
    aar.append(ls("a4", "F24", "", "x"))
    assert len(_rule(doc, "vde.aar_circuits")) == 1  # four circuits for one place
    aar.pop(-2)
    aar[-1]["rating"] = "B20"
    assert len(_rule(doc, "vde.aar_circuits")) == 1  # three again, but one above 16 A


def test_three_aar_circuits_per_occupied_place() -> None:
    doc = document("ZB33S", [module("m", "ZH3EL22", 0, {"aar1": "a1"}, meters=[meter(0), meter(1)])],
                   [row("a1", "a1", [ls(f"c{i}", f"F{i}", "", "x") for i in range(6)])])
    assert _rule(doc, "vde.aar_circuits") == []
    _module(doc, "m")["meters"] = [meter(0)]
    assert len(_rule(doc, "vde.aar_circuits")) == 1


def test_a_main_switch_behind_every_three_point_meter() -> None:
    assert _rule(violations_zb34s(), "vde.3p_main_switch") == [(
        "warn", "mod-p",
        "VDE-AR-N 4100: Hinter jedem 3-Punkt-Zähler in Feld 3 gehört ein Hauptschalter in den AAR (0 von 1).")]
    doc = tall_zb54s()
    assert _rule(doc, "vde.3p_main_switch") == []
    _rows(doc)["row-t-aar2"]["devices"] = []
    assert [r[2].endswith("(1 von 2).") for r in _rule(doc, "vde.3p_main_switch")] == [True]


def test_the_rfz_and_apz_are_for_the_grid_operator() -> None:
    assert _rule(violations_zb34s(), "vde.rfz_devices") == [
        ("warn", "dev-r1", "VDE-AR-N 4100: RfZ/APZ (ZH3EL27) ist nur für Geräte des Netz-/Messstellenbetreibers.")]
    doc = meter_dist_zb33s()
    doc["rows"].insert(0, row("row-rfz", "F1 · RfZ", [
        ls("ok", "F0.1", "", "Steuerung", rating="B10"), dev("spd", "spd"), ls("bare", "F0.2", "", "x", rating=""),
        dev("hs", "hauptschalter")]))
    _module(doc, "mod-z")["rails"]["rfz"] = "row-rfz"
    assert [r[1] for r in _rule(doc, "vde.rfz_devices")] == ["bare", "hs"]


def test_a_meter_board_needs_an_apz_at_the_cabinet_edge_beside_the_meters() -> None:
    assert _rule(meter_dist_zb33s(), "vde.apz_missing") == []
    assert _rule(tall_zb54s(), "vde.apz_missing") == [
        ("warn", "", "VDE-AR-N 4100: Kein APZ im Schrank (mind. 300 mm, plombierbar).")]
    assert _rule(cross_feed_zb33s(), "vde.apz_missing") == []
    assert _rule(violations_zb34s(), "vde.apz_position") == [
        ("warn", "mod-c",
         "VDE-AR-N 4100: APZ in Feld 4: oben oder unten am Schrankrand und seitlich neben dem Zählerfeld.")]
    small_apz = {
        "code": "ZX2APZ", "article_no": "ZX2APZ", "name": "APZ-Feld 300 mm", "family": "distribution_apz",
        "field_height_mm": None, "width_fields": 1, "height_units": 2, "verified": True,
        "zones": [{"key": "apz", "type": "APZ", "unit": 0, "units": 2, "rails": [{"key": "apz", "unit": 0, "ple": 6}]}],
    }
    doc = document("ZB52S", [module("m", "ZH3EL27", 0, {}, meters=[meter(0)]), module("a", "ZX2APZ", 0, {}, unit=7, fittings=[])], [])
    assert [r[1] for r in _rule(doc, "vde.apz_position", _catalog_with(small_apz))] == ["a"]
    _module(doc, "a")["field"] = 1
    assert _rule(doc, "vde.apz_position", _catalog_with(small_apz)) == []


# ── robustness ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "broken",
    [
        {},
        {"enclosure": "ZB33S"},
        {"enclosure": {"code": None}},
        {"enclosure": {"code": "ZB33S", "modules": "x"}, "rows": "y"},
        {"enclosure": {"code": "ZB33S", "modules": [None, 7, {"id": None, "code": "ZH3EH16", "field": "a"},
                                                    {"id": "m", "code": "ZH3EH16", "rails": {"nar": 5, "aar1": "r"},
                                                     "meters": [None, {"place": "x"}, {"place": 99}],
                                                     "fittings": "x"}]},
         "rows": [None, {"id": "r", "devices": [None, {"kind": "sls", "rating": None, "te": "x",
                                                     "supplied_by": "m"}]}, {"devices": None}]},
    ],
)
def test_garbage_never_raises(broken: dict, caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR, logger="app.services.panel_enclosure_rules"):
        assert isinstance(enclosure_findings(copy.deepcopy(broken), builtin_catalog()), list)
    # Tolerance comes from reading carefully, not from the last-resort guard.
    assert caplog.records == []


def test_inputs_are_never_mutated() -> None:
    doc = violations_zb34s()
    before = copy.deepcopy(doc)
    enclosure_findings(doc, builtin_catalog())
    assert doc == before


# ── the panel detail (§5: appended to validate_document's output) ────────────


def test_the_panel_detail_carries_the_cabinet_findings_with_their_rule(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token, cross_feed_zb33s())
    body = client.get(f"/api/schaltplan/panels/{panel['id']}", headers=auth(admin_token)).json()
    rules = [f["rule"] for f in body["findings"]]
    assert "encl.row_order" in rules and "encl.cross_module_feed" in rules
    # validate_document's own findings come first and keep rule "".
    first_cabinet = next(i for i, rule in enumerate(rules) if rule)
    assert all(rule == "" for rule in rules[:first_cabinet]) and all(rules[first_cabinet:])
    assert body["findings"] == panel["findings"]
