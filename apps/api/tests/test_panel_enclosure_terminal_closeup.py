"""The close-up ("Nahansicht") of a field's two terminal rails (R2 §7.1).

One pure layout for the app sheet and the PDF page: per terminal rail, the
devices that still sit on it (back-compat, drawn grey), then every part of
every placed strip at its offset on the rail — each terminal with its
marker, its conductor levels top → bottom, the "für" text of the Klemmen
tab and the cable — and the rail's end plate, drawn before a trailing
2009-305. Unplaced strips are listed with their titles. Python writes it
into ``enclosureFixtures.json`` (``terminal_closeup``); the TS twin
``enclosureTerminalCloseup.ts`` must give the same.
"""

from __future__ import annotations

import copy
import json

import pytest

from app.services.panel_enclosure_catalog import EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_terminal_closeup import terminal_closeup
from app.services.panel_enclosure_terminals import board_terminals, place_terminals
from app.services.schaltplan_pdf_terminals import row_values
from app.services.schaltplan_terminals import rcd_detail, terminal_for_text
from scripts.write_enclosure_fixtures import (
    FIXTURE_PATH,
    document,
    fi,
    ls,
    meter_dist_zb33s,
    module,
    row,
    terminals_rk_zb53s,
    terminals_zb34s,
)

CATALOG = builtin_catalog()


def _closeup(doc: dict) -> list[dict]:
    terms = board_terminals(doc, CATALOG)
    return terminal_closeup(doc, CATALOG, terms, place_terminals(doc, CATALOG, terms))


def _field(closeup: list[dict], number: int) -> dict:
    return next(field for field in closeup if field["field"] == number)


def test_closeup_matches_the_fixture_on_every_board() -> None:
    fixtures = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    catalog = EnclosureCatalog.from_out(fixtures["catalog"])
    for name, board in fixtures["boards"].items():
        doc = board["document"]
        terms = board_terminals(doc, catalog)
        assert terminal_closeup(doc, catalog, terms, place_terminals(doc, catalog, terms)) == board["terminal_closeup"], name


def test_one_entry_per_field_with_terminal_rails_both_rails_in_order() -> None:
    closeup = _closeup(meter_dist_zb33s())
    assert [field["field"] for field in closeup] == [1, 2]
    rails = _field(closeup, 1)["rails"]
    assert [(r["railKey"], r["position"], r["title"], r["capacityMm"], r["usedMm"], r["insulated"]) for r in rails] == [
        ("r1", 0, "F2 · Verteiler 1", 210.0, 30.7, False), ("r2", 1, "F2 · Verteiler 2", 210.0, 0.0, False)]
    assert rails[1]["items"] == [] and rails[1]["devices"] == []
    assert _field(closeup, 1)["order"] == "default" and _field(closeup, 1)["unplaced"] == []


def test_every_part_of_a_leiste_with_marker_levels_for_text_and_cable() -> None:
    items = _field(_closeup(meter_dist_zb33s()), 1)["rails"][0]["items"]
    assert items == [
        {"kind": "terminal", "partId": "2016-7714", "partNo": "WAGO 2016-7714", "stripId": "dev-f1:leiste", "xLabel": "X1",
         "offsetMm": 0.0, "widthMm": 12.0, "marker": "X1", "levels": ["N"], "forText": "FI F1 · 30 mA / Typ A",
         "cable": "", "deviceId": "dev-f1"},
        {"kind": "terminal", "partId": "2003-7641", "partNo": "WAGO 2003-7641", "stripId": "dev-f1:leiste", "xLabel": "X1",
         "offsetMm": 12.0, "widthMm": 5.2, "marker": "1.1", "levels": ["N", "L", "PE"],
         "forText": "F1.1 · Licht EG · Nr. 1", "cable": "NYM-J 3x2,5 mm²", "deviceId": "dev-f1-1"},
        {"kind": "terminal", "partId": "2003-7641", "partNo": "WAGO 2003-7641", "stripId": "dev-f1:leiste", "xLabel": "X1",
         "offsetMm": 17.2, "widthMm": 5.2, "marker": "1.2", "levels": ["N", "L", "PE"],
         "forText": "F1.2 · Steckdosen EG · Nr. 2", "cable": "NYM-J 3x2,5 mm²", "deviceId": "dev-f1-2"},
        # The end plate closes the last terminal block, before the 2009-305.
        {"kind": "end_plate", "partId": "2003-7692", "partNo": "WAGO 2003-7692", "stripId": None, "xLabel": "",
         "offsetMm": 22.4, "widthMm": 0.8, "marker": "", "levels": [], "forText": "", "cable": "", "deviceId": None},
        {"kind": "end_clamp", "partId": "2009-305", "partNo": "WAGO 2009-305", "stripId": "dev-f1:leiste", "xLabel": "X1",
         "offsetMm": 23.2, "widthMm": 7.5, "marker": "", "levels": [], "forText": "—", "cable": "", "deviceId": None},
    ]


def test_the_end_plate_sits_where_the_placement_put_it() -> None:
    doc = terminals_zb34s()
    terms = board_terminals(doc, CATALOG)
    placement = place_terminals(doc, CATALOG, terms)
    closeup = terminal_closeup(doc, CATALOG, terms, placement)
    for field in placement["fields"]:
        for rail, view in zip(field["rails"], _field(closeup, field["field"])["rails"]):
            plates = [(item["partId"], item["offsetMm"]) for item in view["items"] if item["kind"] == "end_plate"]
            assert plates == [(part["partId"], part["offsetMm"]) for part in rail["parts"]]


def test_phases_three_pole_outgoings_and_blocks_have_their_levels() -> None:
    doc = document("ZB32S", [module("mod-a", "ZU37KS", 0, {"r3": "row-a"})], [
        row("row-a", "F1 · Verteiler 3", [
            fi("dev-f1", "F1"),
            ls("dev-l2", "F1.1", "1", "Licht", phase="L2", terminal_block=True),
            ls("dev-3p", "F1.2", "2", "Motor", poles=3, te=3, terminal_block=True),
            ls("dev-b", "F1.3", "3", "Herd", rating="B20", poles=3, te=3, terminal_block=True)]),
    ])
    items = _field(_closeup(doc), 0)["rails"][0]["items"]
    levels = [(item["partId"], item["marker"], item["levels"]) for item in items]
    assert levels == [
        ("2016-7714", "X1", ["N"]),
        ("2003-7641", "1.1", ["N", "L2", "PE"]),
        ("2003-7641", "1.2", ["N", "L1", "PE"]),
        ("2003-7642", "1.3", ["L2", "L3"]),
        ("2009-305", "", []),
        # the Block, then its end plate (a rail ending in a 2016-76xx takes 2016-7691)
        ("2016-7604", "N", ["N"]),
        ("2016-7601", "L1", ["L1"]),
        ("2016-7601", "L2", ["L2"]),
        ("2016-7601", "L3", ["L3"]),
        ("2016-7607", "PE", ["PE"]),
        ("2016-7691", "", []),
    ]
    assert [item["kind"] for item in items][4:6] == ["end_clamp", "terminal"]
    assert items[-1]["kind"] == "end_plate" and items[-1]["offsetMm"] == 95.1  # 35.1 mm Leiste + 60 mm Block
    assert {item["xLabel"] for item in items[5:10]} == {"X2"}


def test_devices_left_on_a_reserved_rail_are_drawn_first_placeholders_are_not() -> None:
    rails = _field(_closeup(terminals_zb34s()), 1)["rails"]
    assert rails[1]["devices"] == [
        {"deviceId": "dev-f1-5", "label": "F1.5", "offsetMm": 0.0, "widthMm": 17.5},
        {"deviceId": "dev-f1-6", "label": "F1.6", "offsetMm": 17.5, "widthMm": 17.5},
        {"deviceId": "dev-f1-7", "label": "F1.7", "offsetMm": 35.0, "widthMm": 17.5},
    ]
    assert rails[1]["items"][0]["offsetMm"] == 52.5
    assert [d["label"] for d in rails[0]["devices"]] == ["F1", "F1.1", "F1.2", "F1.3", "F1.4"]
    assert rails[0]["devices"][0]["widthMm"] == 70.0


def test_unplaced_strips_carry_their_titles() -> None:
    field = _field(_closeup(terminals_zb34s()), 1)
    assert field["unplaced"] == [
        {"stripId": "dev-f4:leiste", "xLabel": "X4", "title": "X4 · FI F4 · F2 · Verteiler 5", "widthMm": 61.1},
        {"stripId": "dev-f5:leiste", "xLabel": "X5", "title": "X5 · FI F5 · F2 · Verteiler 6", "widthMm": 61.1},
        {"stripId": "dev-f6:leiste", "xLabel": "X6", "title": "X6 · FI F6 · F2 · Verteiler 7", "widthMm": 61.1},
    ]


def test_an_insulated_empty_field_and_an_ignored_order_are_echoed() -> None:
    assert [r["insulated"] for r in _field(_closeup(terminals_zb34s()), 2)["rails"]] == [True, True]
    assert all(r["items"] == [] for r in _field(_closeup(terminals_zb34s()), 2)["rails"])
    assert _field(_closeup(terminals_rk_zb53s()), 1)["order"] == "ignored"


def test_marker_overrides_are_what_the_close_up_shows() -> None:
    doc = meter_dist_zb33s()
    doc["terminal_labels"] = {"dev-f1-1:1": "Licht"}
    markers = [item["marker"] for item in _field(_closeup(doc), 1)["rails"][0]["items"]]
    assert markers[:3] == ["X1", "Licht", "1.2"]


def test_the_for_text_is_the_klemmen_tab_rule_shared_with_the_pdf_sheet() -> None:
    head = fi("dev-f1", "F1")
    device = ls("dev-f1-1", "F1.1", "7", "Licht")
    by_id = {"dev-f1-1": device}
    assert rcd_detail(head) == "30 mA / Typ A"
    assert rcd_detail(ls("x", "F2", "", "")) == ""
    assert terminal_for_text({"part_id": "2016-7714", "device_id": "dev-f1"}, by_id, head) == "FI F1 · 30 mA / Typ A"
    assert terminal_for_text({"part_id": "2003-7641", "device_id": "dev-f1-1"}, by_id, head) == "F1.1 · Licht · Nr. 7"
    assert terminal_for_text({"part_id": "2009-305", "device_id": None}, by_id, head) == "—"
    assert terminal_for_text({"part_id": "2003-7641", "device_id": "gone"}, by_id, head) == "—"
    terminal = {"position": 2, "part_id": "2003-7641", "part_no": "WAGO 2003-7641", "device_id": "dev-f1-1", "label": "1.1"}
    assert row_values(terminal, by_id, head)["for"] == "F1.1 · Licht · Nr. 7"


def test_a_board_without_a_cabinet_has_no_close_up() -> None:
    doc = meter_dist_zb33s()
    assert _closeup({**doc, "enclosure": None}) == []


@pytest.mark.parametrize("doc", [{}, {"enclosure": {"code": "ZB33S", "modules": [None, 3]}, "rows": [None]}])
def test_garbage_never_raises(doc: dict) -> None:
    assert isinstance(_closeup(doc), list)


def test_inputs_are_never_mutated() -> None:
    doc = terminals_zb34s()
    before = copy.deepcopy(doc)
    _closeup(doc)
    assert doc == before
