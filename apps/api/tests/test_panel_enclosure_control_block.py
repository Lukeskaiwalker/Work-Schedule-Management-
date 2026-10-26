"""The §14a Steuersignal-Klemmleiste: stored block, carrier, placement, box (docs/PANEL_ENCLOSURE_R4.md §2, §3.1, §3.2, §5).

The TypeScript twin (``enclosureControlBlock.ts``) is pinned on the same
answers through ``enclosureFixtures.json`` (``control_block`` per board and
the ``control_block_parse`` table).
"""

from __future__ import annotations

import copy
import json
import math

import pytest

from app.schemas.panel_enclosure import ModuleSpec, PanelEnclosure, parse_control_block
from app.schemas.schaltplan import PanelDocument
from app.services.panel_enclosure_catalog import CatalogEntry, EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_control_block import (
    CONTROL_PARTS,
    DEFAULT_CONTROL_LABELS,
    DERIVE,
    NETWORK_LEADS,
    WIRE_COLOUR_STYLE,
    WIRE_COLOURS,
    control_carrier,
    default_control_block,
    place_control_block,
)
from app.services.panel_enclosure_geometry import build_enclosure_scene
from app.services.schaltplan_terminal_rules import TERMINAL_PARTS
from scripts.write_enclosure_fixtures import (
    CONTROL_BLOCK_PARSE_CASES,
    FIXTURE_PATH,
    control_ehz_zb33s,
    dev,
    document,
    meter,
    module,
    row,
)

CATALOG = builtin_catalog()


def _fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _block(**overrides: object) -> dict:
    return {**default_control_block(), **overrides}


def _terminals(*labels: str) -> list[dict]:
    return [{"id": f"t{i + 1}", "label": label, "color": WIRE_COLOURS[i % 8]} for i, label in enumerate(labels)]


# ── constants ────────────────────────────────────────────────────────────────


def test_the_block_parts_are_not_circuit_terminal_parts() -> None:
    """R4-3: the block has its own part table, so "no 249-116" still holds for circuits."""
    assert set(CONTROL_PARTS) == {"249-116", "2002-1671", "2002-1692"}
    assert not set(CONTROL_PARTS) & set(TERMINAL_PARTS)
    assert [(p.width_mm, p.marker) for p in CONTROL_PARTS.values()] == [(6.0, False), (5.2, True), (1.0, False)]


def test_wire_colours_never_name_pe_or_n_and_all_have_a_style() -> None:
    assert WIRE_COLOURS == ("braun", "schwarz", "grau", "rot", "violett", "weiß", "orange", "rosa")
    assert set(WIRE_COLOUR_STYLE) == set(WIRE_COLOURS)
    assert not {"grün-gelb", "grün", "gelb", "blau", "hellblau"} & set(WIRE_COLOURS)
    assert [code for _, code in NETWORK_LEADS] == ["ZZ45WAN040", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200", "ZZ45WAN500"]


def test_the_default_block_is_six_bdew_terminals_and_parses_to_itself() -> None:
    block = default_control_block()
    assert [t["label"] for t in block["terminals"]] == list(DEFAULT_CONTROL_LABELS) == [
        "UNSM", "60%", "30%", "0%", "UStve", "Stve"]
    assert [t["color"] for t in block["terminals"]] == list(WIRE_COLOURS[:6])
    assert [t["id"] for t in block["terminals"]] == ["t1", "t2", "t3", "t4", "t5", "t6"]
    assert parse_control_block(block) == block
    assert list(block) == ["terminals", "rail", "wire_mm2", "wire_length_m", "label_material", "off"]
    assert default_control_block() is not block  # a fresh copy each time


# ── parse_control_block (§2.1) ───────────────────────────────────────────────


def test_the_fixture_table_is_what_the_parser_answers() -> None:
    table = _fixture()["control_block_parse"]
    assert [entry["output"] for entry in table] == [parse_control_block(case) for case in CONTROL_BLOCK_PARSE_CASES]


def test_not_a_dict_is_no_block_and_an_empty_dict_is_an_empty_block() -> None:
    for value in (None, "x", [], 5, True):
        assert parse_control_block(value) is None
    assert parse_control_block({}) == {"terminals": [], "rail": None, "wire_mm2": 2.5, "wire_length_m": None,
                                       "label_material": "wago-211-502", "off": False}


def test_ids_keep_valid_unique_ones_and_fill_the_smallest_free_number() -> None:
    entries = [{"id": "t2"}, {"id": "t2"}, {"id": "T3"}, {"id": "t1234"}, {"id": "t01"}, {"id": 5}, {}]
    ids = [t["id"] for t in parse_control_block({"terminals": entries})["terminals"]]
    assert ids == ["t2", "t1", "t3", "t4", "t01", "t5", "t6"]


def test_entries_are_dicts_only_and_at_most_twelve() -> None:
    parsed = parse_control_block({"terminals": [{"label": "A"}, "x", None, 3, {"label": "B"}]})
    assert [t["label"] for t in parsed["terminals"]] == ["A", "B"]
    assert [t["color"] for t in parsed["terminals"]] == ["braun", "schwarz"]  # index after filtering
    many = parse_control_block({"terminals": [{"label": f"K{i}"} for i in range(14)]})
    assert [t["label"] for t in many["terminals"]] == [f"K{i}" for i in range(12)]


def test_labels_lose_control_characters_and_outer_spaces_then_are_cut_to_twelve_code_points() -> None:
    def label(value: object) -> str:
        return parse_control_block({"terminals": [{"label": value}]})["terminals"][0]["label"]

    assert label(7) == ""
    assert label("  60 %  ") == "60 %"
    assert label("a\u0000b\u001fc\u007fd\u0085e\u009f") == "abcde"
    assert label(" UNSM ") == " UNSM "  # only U+0020 is stripped
    assert label("\tStve\n") == "Stve"  # the tab and newline go as control characters
    assert label("  0123456789abc") == "0123456789ab"
    assert label("Steuerbox-Abgang-1 ") == "Steuerbox-Ab"
    assert label("🔌" * 13) == "🔌" * 12  # code points, not UTF-16 units
    assert label("abcdefghijk l") == "abcdefghijk "  # cut after the strip: no second strip


def test_colours_fall_back_to_the_position_default() -> None:
    values = ["weiß", "grün", "Braun", None, "rosa", "", "orange", 3, "blau"]
    parsed = parse_control_block({"terminals": [{"color": c} for c in values]})
    assert [t["color"] for t in parsed["terminals"]] == [
        "weiß", "schwarz", "grau", "rot", "rosa", "weiß", "orange", "rosa", "braun"]


@pytest.mark.parametrize(("value", "expected"), [
    ("aar2", "aar2"), ("AAR1", None), ("", None), ("aar 1", None), (5, None), ("a" * 41, None), ("aar1\n", None),
    (None, None),
])
def test_rail(value: object, expected: str | None) -> None:
    assert parse_control_block({"rail": value})["rail"] == expected


@pytest.mark.parametrize(("value", "expected"), [
    (1.5, 1.5), (2.5, 2.5), (2, 2.5), (True, 2.5), ("2.5", 2.5), (4, 2.5), (None, 2.5),
])
def test_wire_mm2(value: object, expected: float) -> None:
    assert parse_control_block({"wire_mm2": value})["wire_mm2"] == expected


@pytest.mark.parametrize(("value", "expected"), [
    (0.44, None), (0.45, 0.5), (1.25, 1.3), (3, 3.0), (20.04, 20.0), (20.05, None), (True, None), ("5", None),
    (-1, None), (1e12, None), (math.nan, None), (math.inf, None), (-math.inf, None), (1e308, None),
])
def test_wire_length_is_rounded_half_up_and_kept_between_half_a_metre_and_twenty(value: object, expected: object) -> None:
    assert parse_control_block({"wire_length_m": value})["wire_length_m"] == expected


def test_tube_and_off() -> None:
    assert parse_control_block({"label_material": "wago-211-501"})["label_material"] == "wago-211-501"
    for value in ("wago-2009-110", ["wago-211-501"], None, {"x": 1}):
        assert parse_control_block({"label_material": value})["label_material"] == "wago-211-502"
    assert parse_control_block({"off": True})["off"] is True
    for value in ("true", 1, None, False):
        assert parse_control_block({"off": value})["off"] is False


def test_the_schema_stores_the_parsed_block_and_never_dumps_an_absent_one() -> None:
    raw = {"code": "ZB33S", "modules": [], "control_block": {**default_control_block(), "extra": 1}}
    dumped = PanelEnclosure.model_validate(raw).model_dump(mode="json")
    assert dumped["control_block"] == default_control_block()  # unknown keys inside the block dropped
    assert "control_block" not in PanelEnclosure.model_validate({"code": "ZB33S"}).model_dump(mode="json")
    garbage = PanelEnclosure.model_validate({"code": "ZB33S", "control_block": "nonsense"}).model_dump(mode="json")
    assert "control_block" not in garbage
    assert "prep" not in garbage


def test_a_stored_board_with_a_block_round_trips() -> None:
    doc = control_ehz_zb33s()
    assert PanelDocument.model_validate(doc).model_dump(mode="json") == doc
    assert doc["enclosure"]["control_block"] == default_control_block()


# ── carrier (§3.1) ───────────────────────────────────────────────────────────


def _doc(modules: list[dict], rows: list[dict] | None = None, *, cabinet: str = "ZB33S", **extra: object) -> dict:
    return document(cabinet, modules, rows or [], **extra)


def test_the_carrier_is_the_first_meter_module_from_the_left() -> None:
    doc = _doc([module("m-v", "ZU37KS", 0, {}), module("m-b", "ZH3EL27", 2, {}), module("m-a", "ZH33X7", 1, {})])
    assert control_carrier(doc, CATALOG).id == "m-a"


def test_a_reserve_field_is_never_the_carrier_while_a_meter_field_in_use_exists() -> None:
    doc = _doc([module("m-r", "ZH33XL", 0, {}), module("m-p", "ZH33X7", 1, {})])
    carrier = control_carrier(doc, CATALOG)
    assert (carrier.id, carrier.reserve) == ("m-p", False)
    only_reserve = _doc([module("m-r", "ZH33XL", 1, {}), module("m-v", "ZU37KS", 0, {})])
    carrier = control_carrier(only_reserve, CATALOG)
    assert (carrier.id, carrier.reserve) == ("m-r", True)


def test_moving_a_meter_module_moves_the_carrier_and_ties_go_by_unit_then_list_order() -> None:
    doc = _doc([module("m-a", "ZH3EL27", 1, {}), module("m-b", "ZH3EL27", 2, {})])
    assert control_carrier(doc, CATALOG).id == "m-a"
    moved = copy.deepcopy(doc)
    moved["enclosure"]["modules"][0]["field"] = 2
    moved["enclosure"]["modules"][1]["field"] = 0
    assert control_carrier(moved, CATALOG).id == "m-b"
    tie = copy.deepcopy(doc)
    tie["enclosure"]["modules"][1]["field"] = 1
    assert control_carrier(tie, CATALOG).id == "m-a"


def test_no_meter_module_no_carrier() -> None:
    assert control_carrier(_doc([module("m-v", "ZU37KS", 0, {})]), CATALOG) is None
    assert control_carrier({"rows": []}, CATALOG) is None


def test_reserve_field_is_a_catalogue_flag_on_the_three_reserve_kits_only() -> None:
    flagged = sorted(code for code, entry in CATALOG.entries.items() if entry.spec and entry.spec.get("reserve_field"))
    assert flagged == ["ZH33XL", "ZH52XL", "ZH53XL"]
    assert ModuleSpec.model_fields["reserve_field"].default is False


# ── placement (§3.2) ─────────────────────────────────────────────────────────


def _eh16(rails: dict | None = None) -> dict:
    return module("m-z", "ZH3EH16", 0, rails or {}, meters=[meter(0, "1XYZ0000000099")])


def test_the_default_block_sits_right_aligned_on_aar1_beside_the_main_switch() -> None:
    placed = control_ehz_zb33s_placement()
    assert {k: placed[k] for k in placed if k != "parts"} == {
        "moduleId": "mod-a", "railKey": "aar1", "field": 0, "railTitle": "F1 · AAR 1", "railX": 45.0,
        "railY": 100.0, "offsetMm": 165.8, "widthMm": 44.2, "devicesMm": 52.5, "capacityMm": 210.0,
        "overflow": False,
    }
    parts = placed["parts"]
    assert [p["partId"] for p in parts] == ["249-116", *["2002-1671"] * 6, "2002-1692", "249-116"]
    assert [p["offsetMm"] for p in parts] == [0.0, 6.0, 11.2, 16.4, 21.6, 26.8, 32.0, 37.2, 38.2]
    assert [p["position"] for p in parts] == [None, 1, 2, 3, 4, 5, 6, None, None]
    assert parts[1] == {"partId": "2002-1671", "terminalId": "t1", "label": "UNSM", "color": "braun", "position": 1,
                        "offsetMm": 6.0, "widthMm": 5.2}


def control_ehz_zb33s_placement() -> dict:
    placed = place_control_block(control_ehz_zb33s(), CATALOG)
    assert placed is not None
    return placed


def test_the_fixture_pins_every_board_s_placement() -> None:
    fixture = _fixture()
    from scripts.write_enclosure_fixtures import BOARDS, EnclosureCatalog as Catalog

    catalog = Catalog.from_out(fixture["catalog"])
    for name, make in BOARDS.items():
        assert fixture["boards"][name]["control_block"] == place_control_block(make(), catalog), name


def test_nothing_is_placed_without_a_block_terminals_carrier_or_aar_rail() -> None:
    base = [_eh16()]
    assert place_control_block(_doc(base), CATALOG) is None  # absent
    assert place_control_block(_doc(base, control_block=_block(off=True)), CATALOG) is None
    assert place_control_block(_doc(base, control_block=_block(terminals=[])), CATALOG) is None
    assert place_control_block(_doc([module("m-v", "ZU37KS", 0, {})], control_block=_block()), CATALOG) is None
    assert place_control_block(_doc(base), CATALOG, block=default_control_block()) is not None
    assert place_control_block(_doc(base, control_block=_block()), CATALOG, block=None) is None
    no_aar = _catalog_with(_meter_spec("ZX3NOAAR", aar_rails=[]))
    assert place_control_block(_doc([module("m-x", "ZX3NOAAR", 0, {}, fittings=[])], control_block=_block()),
                               no_aar) is None


def test_a_stored_rail_is_honoured_even_when_full_and_the_automatic_rail_is_the_first_with_room() -> None:
    full = [dev(f"d{i}", "mcb", designation=f"F{i}") for i in range(10)]  # 175 mm
    rows = [row("r-a1", "F1 · AAR 1", full)]
    auto = place_control_block(_doc([_eh16({"aar1": "r-a1"})], rows, control_block=_block()), CATALOG)
    assert (auto["railKey"], auto["devicesMm"], auto["overflow"]) == ("aar2", 0.0, False)
    stored = place_control_block(_doc([_eh16({"aar1": "r-a1"})], rows, control_block=_block(rail="aar1")), CATALOG)
    assert (stored["railKey"], stored["overflow"], stored["offsetMm"]) == ("aar1", True, 175.0)
    unknown = place_control_block(_doc([_eh16({"aar1": "r-a1"})], rows, control_block=_block(rail="nar")), CATALOG)
    assert unknown["railKey"] == "aar2"  # the NAR is no candidate


def test_both_rails_full_takes_the_first_and_never_draws_over_the_devices() -> None:
    full = [dev(f"d{i}", "mcb") for i in range(11)]  # 192.5 mm
    rows = [row("r-a1", "F1 · AAR 1", full), row("r-a2", "F1 · AAR 2", [dev(f"e{i}", "mcb") for i in range(11)])]
    placed = place_control_block(_doc([_eh16({"aar1": "r-a1", "aar2": "r-a2"})], rows, control_block=_block()),
                                 CATALOG)
    assert (placed["railKey"], placed["overflow"], placed["offsetMm"], placed["widthMm"]) == ("aar1", True, 192.5, 44.2)


def test_placeholders_count_on_the_aar_rail() -> None:
    """An AAR rail is never a terminal rail, so a hand-placed Reihenklemme takes its space."""
    rows = [row("r-a1", "F1 · AAR 1", [dev("d-t", "terminal", te=2)])]
    placed = place_control_block(_doc([_eh16({"aar1": "r-a1"})], rows, control_block=_block()), CATALOG)
    assert placed["devicesMm"] == 35.0


def test_a_row_named_twice_counts_for_its_first_rail_only() -> None:
    rows = [row("r-a1", "F1 · AAR 1", [dev("d1", "mcb")])]
    doc = _doc([_eh16({"aar1": "r-a1"}), module("m-2", "ZH3EL27", 1, {})], rows, control_block=_block())
    doc["enclosure"]["modules"][1]["rails"] = {"aar1": "r-a1"}  # hand edit, not via the schema
    assert place_control_block(doc, CATALOG)["devicesMm"] == 17.5


def test_twelve_terminals_and_a_one_terminal_block() -> None:
    twelve = place_control_block(_doc([_eh16()], control_block=_block(terminals=_terminals(*"ABCDEFGHIJKL"))), CATALOG)
    assert twelve["widthMm"] == 75.4  # 6 + 12 × 5.2 + 1 + 6
    one = place_control_block(_doc([_eh16()], control_block=_block(terminals=_terminals("UNSM"))), CATALOG)
    assert (one["widthMm"], one["offsetMm"]) == (18.2, 191.8)


def test_the_placement_never_mutates_the_document() -> None:
    doc = control_ehz_zb33s()
    before = copy.deepcopy(doc)
    place_control_block(doc, CATALOG)
    build_enclosure_scene(doc, CATALOG)
    assert doc == before


# ── the scene box (§5) ───────────────────────────────────────────────────────


def test_the_block_is_one_box_in_the_open_view_only() -> None:
    doc = control_ehz_zb33s()
    boxes = [b for b in build_enclosure_scene(doc, CATALOG)["boxes"] if b["kind"] == "control_block"]
    assert boxes == [{
        "id": "control:block", "kind": "control_block", "x": 210.8, "y": 52.0, "z": 47.5, "w": 44.2, "h": 96.0,
        "d": 42.3, "label": "§14a", "moduleId": "mod-a", "railKey": "aar1", "rowId": "row-a-aar1",
        "deviceId": None, "zoneType": "AAR", "flags": [],
    }]
    closed = build_enclosure_scene(doc, CATALOG, view="closed")["boxes"]
    assert not [b for b in closed if b["kind"] == "control_block"]
    assert not [b for b in build_enclosure_scene(doc, CATALOG, block=None)["boxes"] if b["kind"] == "control_block"]
    assert build_enclosure_scene(doc, CATALOG, block=DERIVE) == build_enclosure_scene(doc, CATALOG)


def test_an_overflowing_block_box_is_flagged() -> None:
    rows = [row("r-a1", "F1 · AAR 1", [dev(f"d{i}", "mcb") for i in range(11)]),
            row("r-a2", "F1 · AAR 2", [dev(f"e{i}", "mcb") for i in range(11)])]
    doc = _doc([_eh16({"aar1": "r-a1", "aar2": "r-a2"})], rows, control_block=_block())
    box = next(b for b in build_enclosure_scene(doc, CATALOG)["boxes"] if b["kind"] == "control_block")
    assert box["flags"] == ["overflow"]


# ── helpers for custom specs ─────────────────────────────────────────────────


def _meter_spec(code: str, *, aar_rails: list[dict], family: str = "meter_ehz", rfz: bool = True) -> dict:
    zones = [{"key": "aar", "type": "AAR", "unit": 0, "units": 2, "rails": aar_rails}]
    if rfz:
        zones.append({"key": "rfz", "type": "RFZ", "unit": 2, "units": 1,
                      "rails": [{"key": "rfz", "unit": 0, "ple": 12, "mount": "rail"}]})
    meter_type = "ehz" if family == "meter_ehz" else "3punkt"
    zones += [
        {"key": "zf", "type": "ZF", "unit": 3, "units": 2, "meter_places": 1, "meter_type": meter_type},
        {"key": "nar", "type": "NAR", "unit": 5, "units": 2,
         "rails": [{"key": "nar", "unit": 0, "ple": 12, "mount": "busbar"}]},
    ]
    return {"code": code, "article_no": code, "name": f"Testfeld {code}", "family": family, "field_height_mm": 1050,
            "width_fields": 1, "height_units": 7, "zones": zones, "verified": True}


def _catalog_with(*specs: dict) -> EnclosureCatalog:
    entries = dict(CATALOG.entries)
    for raw in specs:
        spec = ModuleSpec.model_validate(raw).model_dump()
        entries[spec["code"]] = CatalogEntry(spec["code"], "module", spec, "custom", False)
    return EnclosureCatalog(entries)
