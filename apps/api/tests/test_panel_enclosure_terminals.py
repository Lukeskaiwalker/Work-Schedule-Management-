"""WAGO terminals on the cabinet's rails (docs/PANEL_ENCLOSURE_R2.md §2.1, §3).

The placement is derived, never stored: which circuits get terminals at all
(the skip set, R3), which rails carry them (the top two VT rails of a field,
R2), which field a strip belongs to (R4, R6), and how a field's strips are
packed onto its two rails (R5) with one end plate per rail (R7). The only
stored input is ``module.terminal_order`` (§2.1), read leniently.

Owner answers of 2026-10-22 that change the addendum: no WAGO 249-116 end
stops anywhere (one end plate per rail is the only rail part), and the
Werkstatt facts stay as assumed (210 mm usable, unverified; RK fields need
no U84T).

Python computes; ``enclosureFixtures.json`` records ``terminal_skip`` and
``terminal_placement`` per board, and the TS twin must give the same.
"""

from __future__ import annotations

import copy
import json
from types import MappingProxyType, SimpleNamespace

import pytest

from app.core.db import SessionLocal
from app.models.entities import PanelCatalogEntry
from app.schemas.panel_enclosure import ModuleSpec
from app.services.panel_enclosure_catalog import CatalogEntry, EnclosureCatalog, builtin_catalog, load_catalog
from app.services.panel_enclosure_terminals import (
    INSULATED_RAILS_FITTING,
    TERMINAL_RAIL_USABLE_MM,
    TERMINAL_RAIL_USABLE_VERIFIED,
    WAGO_ZONE_TYPES,
    BoardTerminals,
    board_terminals,
    effective_sequence,
    empty_placement,
    field_order,
    insulation_sets,
    parse_terminal_order,
    place_terminals,
    strip_home_field,
    terminal_rail_keys,
    terminal_rail_parts,
    terminal_rails,
    terminal_skip,
)
from app.services.schaltplan_terminal_rules import END_PLATE_PART_IDS
from app.services.schaltplan_terminals import derive_terminals
from scripts.write_enclosure_fixtures import (
    FIXTURE_PATH,
    dev,
    document,
    fi,
    ls,
    ls_run,
    meter_dist_zb33s,
    module,
    row,
    terminals_overflow_zb32s,
    terminals_rk_zb53s,
    terminals_zb34s,
)
from tests.panel_enclosure_helpers import custom_module_spec

CATALOG = builtin_catalog()


def _with_custom(*raw_specs: dict) -> EnclosureCatalog:
    entries = dict(CATALOG.entries)
    for raw in raw_specs:
        spec = ModuleSpec.model_validate(raw).model_dump()
        entries[spec["code"]] = CatalogEntry(spec["code"], "module", spec, "custom", False)
    return EnclosureCatalog(MappingProxyType(entries))


def _field(placement: dict, number: int) -> dict:
    return next(field for field in placement["fields"] if field["field"] == number)


def _xs(rail: dict) -> list[str]:
    return [strip["xLabel"] for strip in rail["strips"]]


def _strip(stripId: str, stripNo: int, xLabel: str, groupId: str, homeField: int | None, headField: int | None,
           offsetMm: float, widthMm: float, extentMm: float, kind: str = "leiste") -> dict:
    return {"stripId": stripId, "stripNo": stripNo, "kind": kind, "xLabel": xLabel, "groupId": groupId,
            "homeField": homeField, "headField": headField, "offsetMm": offsetMm, "widthMm": widthMm,
            "extentMm": extentMm}


def _plate(part_id: str, offset: float) -> dict:
    return {"partId": part_id, "role": "end_plate", "offsetMm": offset,
            "widthMm": 0.8 if part_id == "2003-7692" else 1.0}


# ── the shared fixture ───────────────────────────────────────────────────────


def test_skip_and_placement_match_the_fixture_on_every_board() -> None:
    fixtures = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    assert fixtures["constants"] == {"TERMINAL_RAIL_USABLE_MM": 210.0, "TERMINAL_RAIL_USABLE_VERIFIED": False}
    catalog = EnclosureCatalog.from_out(fixtures["catalog"])
    for name, board in fixtures["boards"].items():
        terms = board_terminals(board["document"], catalog)
        assert sorted(terms.skip) == board["terminal_skip"], name
        assert place_terminals(board["document"], catalog, terms) == board["terminal_placement"], name
        assert board["terminal_placement"]["skip"] == board["terminal_skip"], name


def test_the_assumed_capacity_is_one_unverified_constant() -> None:
    assert (TERMINAL_RAIL_USABLE_MM, TERMINAL_RAIL_USABLE_VERIFIED) == (210.0, False)
    assert place_terminals(meter_dist_zb33s(), CATALOG)["usableMm"] == 210.0


def test_no_end_stops_only_one_end_plate_per_rail_with_strips() -> None:
    """Owner, 2026-10-22: no WAGO 249-116; the plate matches the rail's last terminal."""
    fixtures = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    for name, board in fixtures["boards"].items():
        placement = board["terminal_placement"]
        assert set(placement["railParts"]) <= END_PLATE_PART_IDS, name
        for field in placement["fields"]:
            for rail in field["rails"]:
                assert len(rail["parts"]) == (1 if rail["strips"] else 0), (name, rail["railKey"])
                assert all(part["role"] == "end_plate" for part in rail["parts"]), name


# ── which circuits get terminals (R3) ────────────────────────────────────────


_MM_FIELD = {
    "code": "ZX37MM", "article_no": "ZX37MM", "name": "Testfeld Multimedia", "family": "multimedia",
    "field_height_mm": None, "width_fields": 1, "height_units": 2,
    "zones": [{"key": "mm", "type": "MM", "unit": 0, "units": 2, "rails": [{"key": "mm1", "unit": 0, "ple": 12}]}],
    "fittings": [], "accessories": [], "verified": True,
}


def test_the_skip_set_is_every_device_on_a_rail_of_the_grid_operator_or_the_aar() -> None:
    catalog = _with_custom(_MM_FIELD)
    rows = [
        row("row-nar", "F1 · NAR", [dev("d-sls", "sls", designation="Q0"), ls("d-nar", "F0", "1", "x", terminal_block=True)]),
        row("row-rfz", "F1 · RfZ", [ls("d-rfz", "F1", "2", "x", terminal_block=True)]),
        row("row-aar", "F1 · AAR 1", [ls("d-aar", "F2", "3", "x")]),
        row("row-vf", "F1 · Verteilerfeld 1", [ls("d-vf", "F3", "4", "x", terminal_block=True)]),
        row("row-vt", "F2 · Verteiler 3", [ls("d-vt", "F4", "5", "x", terminal_block=True)]),
        row("row-rfz2", "F2 · RfZ", [ls("d-rfz2", "F5", "6", "x", terminal_block=True)]),
        row("row-apz", "F2 · APZ", [ls("d-apz", "F6", "7", "x", terminal_block=True)]),
        row("row-sas", "F3 · Sammelschienen", [ls("d-sas", "F7", "8", "x", terminal_block=True)]),
        row("row-mm", "F4 · Multimedia", [ls("d-mm", "F8", "9", "x", terminal_block=True)]),
        row("row-unknown", "F5 · Verteiler 1", [ls("d-unknown", "F9", "10", "x", terminal_block=True)]),
        row("row-loose", "Reihe 1", [ls("d-loose", "F10", "11", "x", terminal_block=True)]),
    ]
    doc = document("ZB55S", [
        module("m1", "ZH5EL27", 0, {"vf1": "row-vf", "aar1": "row-aar", "rfz": "row-rfz", "nar": "row-nar"}),
        module("m2", "ZU37VT4APZ2", 1, {"r3": "row-vt", "rfz": "row-rfz2", "apz": "row-apz"}),
        module("m3", "ZH53XS", 2, {"sas": "row-sas"}),
        module("m4", "ZX37MM", 3, {"mm1": "row-mm"}, fittings=[]),
        module("m5", "ZX99NOPE", 4, {"r1": "row-unknown"}, fittings=[]),
    ], rows)
    assert WAGO_ZONE_TYPES == frozenset({"VT", "VF", "MM", "SAS"})
    assert terminal_skip(doc, catalog) == frozenset({"d-sls", "d-nar", "d-rfz", "d-aar", "d-rfz2", "d-apz"})
    terms = board_terminals(doc, catalog)
    flagged = {t["device_id"] for g in terms.groups for t in g["terminals"] if t["device_id"]}
    assert {"d-vf", "d-vt", "d-sas", "d-mm", "d-unknown", "d-loose"} <= flagged
    assert not flagged & terms.skip


def test_a_board_without_a_cabinet_skips_nothing_and_places_nothing() -> None:
    doc = meter_dist_zb33s()
    doc["enclosure"] = None
    terms = board_terminals(doc, CATALOG)
    assert (terms.skip, terms.groups) == (frozenset(), tuple(derive_terminals(doc)))
    assert place_terminals(doc, CATALOG) == empty_placement() == {
        "skip": [], "usableMm": 210.0, "fields": [], "elsewhere": [], "outside": [], "noRails": [],
        "railParts": {}, "insulationSets": 0}


def test_skipped_aar_circuits_renumber_the_board() -> None:
    doc = terminals_zb34s()
    first_without_skip = derive_terminals(doc)[0]["strips"][0]["strip_id"]
    terms = board_terminals(doc, CATALOG)
    assert first_without_skip == "dev-q1:leiste"
    assert terms.groups[0]["strips"][0]["strip_id"] == "dev-f1:leiste"
    assert sorted(terms.skip) == ["dev-aar-ls1", "dev-q0", "dev-q1", "dev-x0"]


def test_placement_refuses_groups_derived_without_the_skip_set() -> None:
    doc = terminals_zb34s()
    with pytest.raises(TypeError):
        place_terminals(doc, CATALOG, list(derive_terminals(doc)))  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        place_terminals(doc, CATALOG, {"skip": frozenset(), "groups": ()})  # type: ignore[arg-type]
    assert isinstance(board_terminals(doc, CATALOG), BoardTerminals)


# ── terminal rails (R2) ──────────────────────────────────────────────────────


def test_terminal_rails_are_the_top_two_vt_rails_of_each_field() -> None:
    doc = document("ZB55S", [
        module("m0", "ZU37KS", 0, {"r2": "row-a"}),
        module("m1", "ZU37RK", 1, {}, fittings=[]),  # placed before u84t existed: the served spec decides
        module("m2", "ZH53XS", 2, {}),
        module("m3", "ZH3EH16", 3, {}),
        module("m4", "ZX99NOPE", 4, {}, fittings=[]),
    ], [row("row-a", "F1 · Verteiler 2", [ls("d1", "F1", "1", "Licht"), dev("ph", "terminal")])])
    rails = terminal_rails(doc, CATALOG)
    assert sorted(rails) == [0, 1, 2]
    as_tuples = [(r.field, r.position, r.module_id, r.rail_key, r.row_id, r.title, r.capacity_mm, r.devices_mm, r.insulated)
                 for field in sorted(rails) for r in rails[field]]
    assert as_tuples == [
        (0, 0, "m0", "r1", None, "F1 · Verteiler 1", 210.0, 0.0, False),
        # the hand-placed "Reihenklemme N/PE" is a placeholder: not counted
        (0, 1, "m0", "r2", "row-a", "F1 · Verteiler 2", 210.0, 17.5, False),
        (1, 0, "m1", "r1", None, "F2 · Verteiler 1", 210.0, 0.0, True),
        (1, 1, "m1", "r2", None, "F2 · Verteiler 2", 210.0, 0.0, True),
        # SAS on top: the terminal rails are the first two VT rails below it
        (2, 0, "m2", "r1", None, "F3 · Verteiler 1", 210.0, 0.0, False),
        (2, 1, "m2", "r2", None, "F3 · Verteiler 2", 210.0, 0.0, False),
    ]
    assert terminal_rail_keys(doc, CATALOG) == frozenset(
        {("m0", "r1"), ("m0", "r2"), ("m1", "r1"), ("m1", "r2"), ("m2", "r1"), ("m2", "r2")})
    assert INSULATED_RAILS_FITTING == "u84t"


def test_a_retired_top_rail_hands_over_to_the_next_and_custom_rails_use_their_ple() -> None:
    spec = custom_module_spec(code="ZX37RET", height_units=4, zones=[
        {"key": "vt", "type": "VT", "unit": 0, "units": 4, "rails": [
            {"key": "r1", "unit": 0, "ple": 12, "retired": True}, {"key": "r2", "unit": 1, "ple": 12},
            {"key": "r3", "unit": 2, "ple": 8}, {"key": "r4", "unit": 3, "ple": 12}]}])
    doc = document("ZB32S", [module("m", "ZX37RET", 0, {}, fittings=[])], [])
    assert [(r.rail_key, r.capacity_mm) for r in terminal_rails(doc, _with_custom(spec))[0]] == [("r2", 210.0), ("r3", 140.0)]


def test_two_modules_in_one_field_rank_their_rails_by_height_then_module_id() -> None:
    catalog = _with_custom(custom_module_spec())
    doc = document("ZB32S", [
        module("mb", "ZX37TEST", 0, {}, unit=0, fittings=[]),
        module("ma", "ZX37TEST", 0, {}, unit=1, fittings=[]),
    ], [])
    assert [(r.module_id, r.rail_key) for r in terminal_rails(doc, catalog)[0]] == [("mb", "r1"), ("ma", "r1")]


# ── home fields (R4, R6) ─────────────────────────────────────────────────────


def _t(part_id: str, device_id: str | None) -> dict:
    return {"part_id": part_id, "device_id": device_id}


def test_a_leiste_homes_where_most_of_its_circuits_are_ties_go_to_the_first() -> None:
    leiste = {"kind": "leiste", "terminals": [
        _t("2016-7714", "f1"), _t("2003-7641", "a"), _t("2003-7641", "b"), _t("2003-7642", "b"),
        _t("2003-7641", "c"), _t("2009-305", None)]}
    assert strip_home_field(leiste, {"f1": 2, "a": 2, "b": 1, "c": 1}) == 1  # b counts once, the FI not at all
    assert strip_home_field(leiste, {"f1": 1, "a": 2, "b": 1}) == 2  # a tie: the first circuit's field
    assert strip_home_field(leiste, {"b": 3}) == 3  # circuits outside the cabinet do not count
    assert strip_home_field(leiste, {"f1": 0}) is None
    assert strip_home_field({"kind": "block", "device_id": "w", "terminals": []}, {"w": 4}) == 4


def test_a_strip_without_terminal_rails_in_its_field_goes_to_the_nearest_left_on_a_tie() -> None:
    doc = document("ZB53S", [
        module("ma", "ZU59KS", 0, {}),
        module("mm", "ZH5EL27", 1, {"vf1": "row-vf"}),
        module("mb", "ZU59KS", 2, {}),
    ], [row("row-vf", "F2 · Verteilerfeld 1", [fi("f1", "F1"), *ls_run("f1", "F1", range(1, 3), 1)])])
    placement = place_terminals(doc, CATALOG)
    assert placement["elsewhere"] == [{"stripId": "f1:leiste", "homeField": 1, "field": 0}]
    assert _field(placement, 0)["rails"][0]["strips"] == [
        _strip("f1:leiste", 1, "X1", "f1", 1, 1, 0.0, 29.9, 30.7)]
    assert _field(placement, 2)["rails"][0]["strips"] == []


def test_strips_with_no_field_at_all_are_listed_never_placed() -> None:
    only_meter = document("ZB53S", [module("mm", "ZH5EL27", 1, {"vf1": "row-vf"})],
                          [row("row-vf", "F2 · Verteilerfeld 1", [fi("f1", "F1"), *ls_run("f1", "F1", range(1, 3), 1)])])
    placement = place_terminals(only_meter, CATALOG)
    assert (placement["fields"], placement["noRails"], placement["outside"]) == ([], ["f1:leiste"], [])
    loose = document("ZB32S", [module("m", "ZU37KS", 0, {})],
                     [row("row-loose", "Reihe 1", [fi("f1", "F1"), *ls_run("f1", "F1", range(1, 3), 1)])])
    placement = place_terminals(loose, CATALOG)
    assert (placement["outside"], placement["noRails"]) == (["f1:leiste"], [])
    assert [_xs(rail) for rail in _field(placement, 0)["rails"]] == [[], []]


def test_a_block_homes_with_its_device_and_the_supply_strip_has_no_head() -> None:
    doc = document("ZB32S", [
        module("m0", "ZU37KS", 0, {"r3": "row-a"}),
        module("m1", "ZU37KS", 1, {"r3": "row-b"}),
    ], [
        row("row-a", "F1 · Verteiler 3", [ls("s1", "F0.1", "1", "x", terminal_block=True), fi("f1", "F1"),
                                         *ls_run("f1", "F1", range(1, 3), 2)]),
        row("row-b", "F2 · Verteiler 3", [ls("w1", "F1.3", "4", "Wallbox", rating="C32", poles=3, te=3,
                                             terminal_block=True, parent_id="f1")]),
    ])
    placement = place_terminals(doc, CATALOG)
    assert _field(placement, 0)["rails"][0]["strips"] == [
        _strip("supply:leiste", 1, "X1", "supply", 0, None, 0.0, 5.2, 5.2),
        _strip("f1:leiste", 2, "X2", "f1", 0, 0, 5.2, 29.9, 30.7),
    ]
    assert _field(placement, 1)["rails"][0]["strips"] == [
        _strip("w1:block", 3, "X3", "f1", 1, 0, 0.0, 60.0, 60.0, kind="block")]


# ── packing (R5, R7) ─────────────────────────────────────────────────────────


def test_the_owner_board_keeps_its_old_rows_and_packs_around_them() -> None:
    placement = place_terminals(terminals_zb34s(), CATALOG)
    field = _field(placement, 1)
    rail1, rail2 = field["rails"]
    assert (rail1["rowId"], rail1["devicesMm"], rail1["usedMm"], rail1["capacityMm"]) == ("row-old1", 140.0, 196.7, 210.0)
    assert rail1["strips"] == [_strip("dev-f1:leiste", 1, "X1", "dev-f1", 1, 1, 140.0, 55.9, 56.7)]
    # The plate sits after the last terminal block, before the 2009-305.
    assert rail1["parts"] == [_plate("2003-7692", 188.4)]
    # 3 LS = 52.5 mm; the hand-placed "Reihenklemme N/PE" is a placeholder.
    assert (rail2["rowId"], rail2["devicesMm"], _xs(rail2), rail2["usedMm"]) == ("row-old2", 52.5, ["X2", "X3"], 175.5)
    assert [s["offsetMm"] for s in rail2["strips"]] == [52.5, 113.6]
    assert rail2["parts"] == [_plate("2003-7692", 167.2)]
    assert field["unplaced"] == [
        {"stripId": "dev-f4:leiste", "xLabel": "X4", "widthMm": 61.1},
        {"stripId": "dev-f5:leiste", "xLabel": "X5", "widthMm": 61.1},
        {"stripId": "dev-f6:leiste", "xLabel": "X6", "widthMm": 61.1},
    ]
    assert (field["missingMm"], field["order"], field["orderModuleId"]) == (183.3, "default", None)


def test_first_fit_puts_a_block_back_onto_rail_1_that_next_fit_left_over() -> None:
    placement = place_terminals(terminals_zb34s(), CATALOG)
    field = _field(placement, 3)
    rail1, rail2 = field["rails"]
    assert (_xs(rail1), rail1["usedMm"], _xs(rail2), rail2["usedMm"]) == (["X7", "X8", "X10"], 204.0, ["X9", "X11", "X12"], 173.7)
    assert rail1["strips"][-1] == _strip("dev-f9-11:block", 10, "X10", "dev-f9", 3, 3, 143.0, 60.0, 60.0, kind="block")
    assert rail1["parts"] == [_plate("2016-7691", 203.0)]
    assert rail2["parts"] == [_plate("2003-7692", 165.4)]
    assert field["unplaced"] == []
    rk_rails = _field(placement, 2)["rails"]
    assert [(r["title"], r["insulated"], r["strips"], r["parts"], r["usedMm"]) for r in rk_rails] == [
        ("F3 · Verteiler 1", True, [], [], 0.0), ("F3 · Verteiler 2", True, [], [], 0.0)]
    assert terminal_rail_parts(placement) == {"2003-7692": 3, "2016-7691": 1}
    assert insulation_sets(placement) == 4


def test_a_strip_is_unplaced_only_when_it_fits_neither_rail() -> None:
    placement = place_terminals(terminals_overflow_zb32s(), CATALOG)
    field = _field(placement, 0)
    assert [(_xs(r), r["usedMm"]) for r in field["rails"]] == [(["X1", "X2"], 143.8), (["X3", "X4"], 143.8)]
    assert field["unplaced"] == [{"stripId": "dev-f5:leiste", "xLabel": "X5", "widthMm": 71.5}]
    assert field["missingMm"] == 71.5
    assert [(_xs(r), r["usedMm"]) for r in _field(placement, 1)["rails"]] == [([], 0.0), ([], 0.0)]
    assert (placement["railParts"], placement["insulationSets"]) == ({"2003-7692": 2}, 2)


@pytest.mark.parametrize("devices_mm, rail", [(148.1, 0), (148.9, 1)])
def test_the_end_plate_counts_against_the_rail(devices_mm: float, rail: int) -> None:
    doc = document("ZB32S", [module("m", "ZU37KS", 0, {"r1": "row-1", "r3": "row-3"})], [
        row("row-1", "F1 · Verteiler 1", [dev("big", "blank", width_mm=devices_mm)]),
        row("row-3", "F1 · Verteiler 3", [fi("f1", "F1"), *ls_run("f1", "F1", range(1, 9), 1)]),
    ])
    rails = _field(place_terminals(doc, CATALOG), 0)["rails"]
    # 148.1 + 61.1 + 0.8 = 210.0 fits; 148.9 + 61.1 + 0.8 = 210.8 does not.
    assert [_xs(r) for r in rails] == [["X1"] if index == rail else [] for index in range(2)]


def test_the_compliant_reference_places_its_strips_on_r1() -> None:
    placement = place_terminals(meter_dist_zb33s(), CATALOG)
    assert placement["skip"] == ["dev-q0", "dev-q1", "dev-x0"]
    assert [(f["field"], [(r["railKey"], _xs(r)) for r in f["rails"]]) for f in placement["fields"]] == [
        (1, [("r1", ["X1"]), ("r2", [])]), (2, [("r1", ["X2"]), ("r2", [])])]
    assert (placement["railParts"], placement["insulationSets"]) == ({"2003-7692": 2}, 2)


def test_the_rk_board_places_elsewhere_ignores_a_grown_split_and_keeps_the_sas_block() -> None:
    placement = place_terminals(terminals_rk_zb53s(), CATALOG)
    assert placement["skip"] == ["dev-q0"]
    assert placement["elsewhere"] == [{"stripId": "dev-f1:leiste", "homeField": 0, "field": 1}]
    field1 = _field(placement, 1)
    assert (field1["order"], field1["orderModuleId"]) == ("ignored", "mod-r")
    rail1, rail2 = field1["rails"]
    assert (_xs(rail1), rail1["usedMm"], _xs(rail2), rail2["usedMm"]) == (["X1", "X3"], 154.2, ["X4", "X2"], 77.5)
    assert rail1["parts"] == [_plate("2003-7692", 145.9)]
    # A Leiste without an FI ends in an Etagenklemme: the plate follows it.
    assert rail2["strips"][-1] == _strip("dev-q2:leiste", 2, "X2", "dev-q2", 1, 1, 61.1, 15.6, 15.6)
    assert rail2["parts"] == [_plate("2003-7692", 76.7)]
    field2 = _field(placement, 2)
    assert [(s["xLabel"], s["homeField"], s["headField"]) for s in field2["rails"][0]["strips"]] == [
        ("X5", 2, 1), ("X7", 2, 2), ("X6", 2, 2)]
    assert field2["rails"][0]["parts"] == [_plate("2016-7691", 125.0)]
    assert all(r["insulated"] for f in placement["fields"] for r in f["rails"])
    assert (placement["railParts"], placement["insulationSets"]) == ({"2003-7692": 2, "2016-7691": 1}, 0)


# ── the stored order (§2.1) ──────────────────────────────────────────────────


def test_effective_sequence_keeps_the_stored_order_and_merges_the_rest_at_their_default_neighbour() -> None:
    a, b, c, d = (SimpleNamespace(id=name) for name in "abcd")

    def ids(seq: list) -> list[str]:
        return [s.id for s in seq]

    assert ids(effective_sequence([a, b, c], ["c", "gone", "a", "b"])) == ["c", "a", "b"]
    assert ids(effective_sequence([a, b, c, d], ["c", "a"])) == ["c", "d", "a", "b"]
    assert ids(effective_sequence([a, b], ["b"])) == ["a", "b"]
    assert ids(effective_sequence([a, b], ["b", "b", "a"])) == ["b", "a"]
    assert ids(effective_sequence([a, b], [])) == ["a", "b"]


def _three_groups(order: dict | None = None) -> dict:
    rows = [row(f"row-{rail}", f"F1 · Verteiler {rail}",
                [fi(f"f{group}", f"F{group}"), *ls_run(f"f{group}", f"F{group}", range(1, 9), group * 10)])
            for group, rail in ((1, 3), (2, 4), (3, 5))]
    return document("ZB32S", [module("m", "ZU37KS", 0, {f"r{r}": f"row-{r}" for r in (3, 4, 5)}, terminal_order=order)], rows)


def test_a_stored_split_is_honoured_when_both_rails_fit() -> None:
    default = _field(place_terminals(_three_groups(), CATALOG), 0)
    assert ([_xs(r) for r in default["rails"]], default["order"]) == ([["X1", "X2", "X3"], []], "default")
    order = {"0": {"strips": ["f3:leiste", "f1:leiste", "f2:leiste"], "rail2_from": "f2:leiste"}}
    manual = _field(place_terminals(_three_groups(order), CATALOG), 0)
    assert ([_xs(r) for r in manual["rails"]], manual["order"], manual["orderModuleId"]) == (
        [["X3", "X1"], ["X2"]], "manual", "m")
    unsplit = _field(place_terminals(_three_groups({"0": {"strips": ["f3:leiste", "f1:leiste"]}}), CATALOG), 0)
    assert ([_xs(r) for r in unsplit["rails"]], unsplit["order"]) == ([["X3", "X1", "X2"], []], "manual")


def test_a_split_on_a_strip_that_is_gone_packs_the_stored_sequence_automatically() -> None:
    order = {"0": {"strips": ["f2:leiste", "gone:leiste"], "rail2_from": "gone:leiste"}}
    field = _field(place_terminals(_three_groups(order), CATALOG), 0)
    assert ([_xs(r) for r in field["rails"]], field["order"]) == ([["X1", "X2", "X3"], []], "manual")


def test_field_order_reads_the_first_terminal_rail_holder_with_an_entry() -> None:
    catalog = _with_custom(custom_module_spec())
    entry_a = {"0": {"strips": ["x:leiste"], "rail2_from": None}}
    entry_b = {"0": {"strips": ["y:leiste"], "rail2_from": None}}
    both = document("ZB32S", [
        module("mb", "ZX37TEST", 0, {}, unit=0, fittings=[], terminal_order=entry_b),
        module("ma", "ZX37TEST", 0, {}, unit=1, fittings=[], terminal_order=entry_a),
    ], [])
    assert field_order(both, catalog, 0) == {"module_id": "mb", "strips": ["y:leiste"], "rail2_from": None}
    only_second = copy.deepcopy(both)
    del only_second["enclosure"]["modules"][0]["terminal_order"]
    assert field_order(only_second, catalog, 0) == {"module_id": "ma", "strips": ["x:leiste"], "rail2_from": None}
    assert field_order(only_second, catalog, 1) is None


# ── insulation (R8) ──────────────────────────────────────────────────────────


def test_an_override_saved_without_u84t_still_insulates_its_rails() -> None:
    spec = copy.deepcopy(dict(CATALOG.module("ZU37RK")))
    spec["fittings"] = []
    with SessionLocal() as db:
        db.add(PanelCatalogEntry(code="ZU37RK", entry_type="module", spec=spec))
        db.commit()
        catalog = load_catalog(db)
    doc = document("ZB32S", [module("m", "ZU37RK", 0, {"r3": "row-3"}, fittings=[])],
                   [row("row-3", "F1 · Verteiler 3", [fi("f1", "F1"), *ls_run("f1", "F1", range(1, 3), 1)])])
    placement = place_terminals(doc, catalog)
    assert [r["insulated"] for r in _field(placement, 0)["rails"]] == [True, True]
    assert (placement["railParts"], placement["insulationSets"]) == ({"2003-7692": 1}, 0)


# ── tolerance ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "value, expected",
    [
        (None, None), ("0", None), ([], None), (42, None),
        ({"3": {"strips": ["a"]}, "x": {"strips": ["a"]}, 0: {"strips": ["a"]}}, None),
        ({"0": {"strips": "a"}}, None),
        ({"0": "x", "1": None, "2": {"strips": []}}, None),
        ({"0": {"strips": [1, None, "", "a", "a", "x" * 81, "y" * 80]}},
         {"0": {"strips": ["a", "y" * 80], "rail2_from": None}}),
        ({"0": {"strips": ["a"], "rail2_from": "b"}}, {"0": {"strips": ["a"], "rail2_from": None}}),
        ({"0": {"strips": ["a"], "rail2_from": 5, "extra": 1}}, {"0": {"strips": ["a"], "rail2_from": None}}),
        ({"2": {"strips": ["a", "b"], "rail2_from": "b"}}, {"2": {"strips": ["a", "b"], "rail2_from": "b"}}),
        ({"1": {"strips": [f"s{n}" for n in range(1000)]}},
         {"1": {"strips": [f"s{n}" for n in range(40)], "rail2_from": None}}),
    ],
)
def test_parse_terminal_order_drops_garbage_and_never_raises(value: object, expected: object) -> None:
    assert parse_terminal_order(value) == expected


_GARBAGE = [
    None, "x", 5, [],
    {"enclosure": {"code": "ZB33S", "modules": "x"}, "rows": []},
    {"enclosure": {"code": "ZB33S", "modules": [
        None, 5, {"id": 5}, {"id": "m", "code": 7},
        {"id": "m2", "code": "ZU37KS", "field": "x", "unit": None, "rails": {"r1": 5, "r2": "row"},
         "terminal_order": {"0": "x"}},
        {"id": "m3", "code": "ZU37RK", "field": 1, "unit": 0, "rails": "x", "terminal_order": [1]},
    ]}, "rows": [None, {"id": "row", "devices": "x"}, {"id": "row", "devices": [None, {"id": None, "width_mm": "x"}]}]},
    {"enclosure": {"code": "ZB33S", "modules": [{"id": "m", "code": "ZU37KS", "field": 0, "rails": {"r1": "row"}}]},
     "rows": 5},
    {"enclosure": {"code": "ZB33S", "modules": [{"id": "m", "code": "ZU37KS", "field": 0, "rails": {"r1": "row"}}]},
     "rows": [{"id": "row", "devices": [{"id": "d", "kind": "mcb", "terminal_block": True, "te": "x"}]}],
     "terminal_labels": "x"},
]


@pytest.mark.parametrize("doc", _GARBAGE)
def test_garbage_never_raises(doc: object) -> None:
    placement = place_terminals(doc, CATALOG)
    assert set(placement) == set(empty_placement())
    assert isinstance(terminal_skip(doc, CATALOG), frozenset)
    assert isinstance(terminal_rails(doc, CATALOG), dict)


def test_inputs_are_never_mutated() -> None:
    doc = terminals_rk_zb53s()
    before = copy.deepcopy(doc)
    place_terminals(doc, CATALOG)
    assert doc == before
