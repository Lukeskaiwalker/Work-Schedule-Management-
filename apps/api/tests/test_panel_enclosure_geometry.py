"""The cabinet as a list of boxes (docs/PANEL_ENCLOSURE.md §4).

One pure function, twice: ``panel_enclosure_geometry.py`` here (for the Aufbau
PDF) and ``enclosureGeometry.ts`` in the editor (SVG and three.js). Renderers
only draw boxes, so the PDF and the screen can only disagree if the two
functions do — which the shared fixture rules out.
"""

from __future__ import annotations

import json

import pytest

from app.services.panel_enclosure_catalog import EnclosureCatalog, builtin_catalog
from app.services.panel_enclosure_geometry import build_enclosure_scene, round1
from app.services.panel_enclosure_terminals import place_terminals
from scripts.write_enclosure_fixtures import (
    FIXTURE_PATH,
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
    terminals_zb34s,
)


def _boxes(scene: dict, kind: str | None = None) -> dict[str, dict]:
    return {box["id"]: box for box in scene["boxes"] if kind is None or box["kind"] == kind}


def _open(doc: dict) -> dict:
    scene = build_enclosure_scene(doc, builtin_catalog(), view="open")
    assert scene is not None
    return scene


def _closed(doc: dict) -> dict:
    scene = build_enclosure_scene(doc, builtin_catalog(), view="closed")
    assert scene is not None
    return scene


# ── the shared fixture ───────────────────────────────────────────────────────


def test_both_views_match_the_fixture_on_every_board() -> None:
    fixtures = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    catalog = EnclosureCatalog.from_out(fixtures["catalog"])
    for name, board in fixtures["boards"].items():
        assert build_enclosure_scene(board["document"], catalog, view="open") == board["scene_open"], name
        assert build_enclosure_scene(board["document"], catalog, view="closed") == board["scene_closed"], name


# ── numbers ──────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "rounded"),
    [(0.25, 0.3), (0.35, 0.4), (78.75, 78.8), (2.45, 2.5), (-0.04, 0.0), (17.5, 17.5), (12.0, 12.0), (1.04999, 1.0)],
)
def test_round1_rounds_half_up_never_to_even(value: float, rounded: float) -> None:
    # Python's round() rounds half to even; the TS twin uses Math.floor(v·10 + 0.5).
    assert round1(value) == rounded


def test_no_scene_without_a_known_cabinet() -> None:
    doc = meter_dist_zb33s()
    assert build_enclosure_scene({**doc, "enclosure": None}, builtin_catalog()) is None
    unknown = {**doc, "enclosure": {**doc["enclosure"], "code": "ZX00GONE"}}
    assert build_enclosure_scene(unknown, builtin_catalog()) is None
    module_as_cabinet = {**doc, "enclosure": {**doc["enclosure"], "code": "ZU37KS"}}
    assert build_enclosure_scene(module_as_cabinet, builtin_catalog()) is None


# ── the cabinet ──────────────────────────────────────────────────────────────


def test_shell_fields_and_modules_sit_on_the_raster() -> None:
    scene = _open(meter_dist_zb33s())
    assert (scene["width"], scene["height"], scene["depth"], scene["view"]) == (800.0, 1100.0, 205.0, "open")
    boxes = _boxes(scene)
    assert {k: boxes["shell"][k] for k in ("x", "y", "z", "w", "h", "d")} == {
        "x": 0.0, "y": 0.0, "z": 0.0, "w": 800.0, "h": 1100.0, "d": 205.0}
    fields = _boxes(scene, "field")
    assert [(f["x"], f["y"], f["w"], f["h"], f["label"]) for f in fields.values()] == [
        (25.0, 25.0, 250.0, 1050.0, "Feld 1"), (275.0, 25.0, 250.0, 1050.0, "Feld 2"), (525.0, 25.0, 250.0, 1050.0, "Feld 3")]
    mod = boxes["module:mod-z"]
    assert (mod["x"], mod["y"], mod["w"], mod["h"], mod["label"]) == (25.0, 25.0, 250.0, 1050.0, "ZH3EH16")
    assert mod["flags"] == ["unverified"]
    assert boxes["module:mod-v"]["flags"] == []


def test_module_y_follows_its_unit() -> None:
    doc = document("ZB33S", [module("c1", "ZU62A", 0, {}, unit=0), module("c3", "ZU62A", 0, {}, unit=3)], [])
    boxes = _boxes(_open(doc), "module")
    assert boxes["module:c1"]["y"] == 25.0
    assert boxes["module:c3"]["y"] == 25.0 + 150 * 3


def test_zones_are_labelled_by_type_unless_named() -> None:
    zones = _boxes(_open(meter_dist_zb33s()), "zone")
    assert [(z["label"], z["zoneType"], z["y"], z["h"]) for z in zones.values() if z["moduleId"] == "mod-z"] == [
        ("AAR", "AAR", 25.0, 300.0), ("RfZ", "RFZ", 325.0, 150.0), ("Zählerfeld", "ZF", 475.0, 300.0),
        ("NAR", "NAR", 775.0, 300.0)]


# ── rails and devices ────────────────────────────────────────────────────────


def test_rails_are_centred_in_their_unit_and_ple_wide() -> None:
    boxes = _boxes(_open(meter_dist_zb33s()))
    aar1 = boxes["rail:mod-z:aar1"]
    # Unit 0 of the AAR: centre at 25 + 75 = 100; 12 PLE = 210 mm, centred in 250.
    assert (aar1["x"], aar1["y"], aar1["w"], aar1["h"], aar1["z"], aar1["d"]) == (45.0, 82.5, 210.0, 35.0, 40.0, 7.5)
    assert (aar1["rowId"], aar1["label"], aar1["zoneType"]) == ("row-aar1", "F1 · AAR 1", "AAR")
    apz = boxes["rail:mod-a:apz"]
    assert apz["w"] == 6 * 17.5 and apz["x"] == 525.0 + (250 - 105) / 2
    # A rail without a row is drawn empty, with the label its row would get.
    rfz = boxes["rail:mod-z:rfz"]
    assert (rfz["rowId"], rfz["label"]) == (None, "F1 · RfZ")


def test_a_busbar_is_its_own_kind_and_an_sls_on_it_is_78_75_mm() -> None:
    boxes = _boxes(_open(meter_dist_zb33s()))
    nar = boxes["rail:mod-z:nar"]
    assert nar["kind"] == "busbar"
    assert (nar["y"], nar["h"], nar["z"], nar["d"]) == (850.0 - 30, 60.0, 30.0, 12.0)
    sls = boxes["device:dev-q0"]
    assert (sls["x"], sls["w"], sls["y"], sls["h"], sls["label"]) == (45.0, 78.8, 805.0, 90.0, "Q0")


def test_devices_sit_side_by_side_from_the_rail_start() -> None:
    boxes = _boxes(_open(meter_dist_zb33s()), "device")
    row_v1 = [b for b in boxes.values() if b["rowId"] == "row-v1"]
    assert [(b["deviceId"], b["x"], b["w"]) for b in row_v1] == [
        ("dev-f1", 295.0, 70.0), ("dev-f1-1", 365.0, 17.5), ("dev-f1-2", 382.5, 17.5)]
    assert boxes["device:dev-q1"]["flags"] == ["supplied"]
    assert boxes["device:dev-f1"]["flags"] == []


def test_a_device_past_the_rail_end_is_flagged() -> None:
    # Three FIs fill the 210 mm exactly (no flag); the LS after them sticks out.
    devices = [fi(f"f{i}", f"F{i}") for i in range(3)] + [ls("last", "F9", "9", "x")]
    doc = document("ZB33S", [module("m", "ZU37KS", 0, {"r1": "r"})], [row("r", "r", devices)])
    boxes = _boxes(_open(doc), "device")
    assert [b["flags"] for b in boxes.values()] == [[], [], [], ["overflow"]]


def test_devices_label_with_bmk_else_the_catalogue_short() -> None:
    doc = document("ZB33S", [module("m", "ZU37KS", 0, {"r1": "r"})],
                   [row("r", "r", [dev("a", "mcb", designation=" F7 "), dev("b", "spd")])])
    boxes = _boxes(_open(doc), "device")
    assert [b["label"] for b in boxes.values()] == ["F7", "SPD"]


def test_rows_outside_the_cabinet_draw_nothing() -> None:
    doc = document("ZB33S", [module("m", "ZU37KS", 0, {})], [row("loose", "Reihe 1", [ls("d", "F1", "1", "x")])])
    assert _boxes(_open(doc), "device") == {}


# ── meters ───────────────────────────────────────────────────────────────────


def test_ehz_places_sit_side_by_side_and_free_ones_say_so() -> None:
    doc = document("ZB33S", [module("m", "ZH3EL22", 0, {}, meters=[meter(1, "1XYZ0000000002")])], [])
    boxes = _boxes(_open(doc))
    free, used = boxes["meter:m:0"], boxes["meter:m:1"]
    # ZF zone: units 3–4 → y 475, 300 high; two cells of 125 mm.
    assert (free["kind"], free["label"], free["flags"]) == ("meter_place", "frei", ["free"])
    assert (free["x"], free["y"], free["w"], free["h"], free["z"], free["d"]) == (32.5, 520.0, 110.0, 210.0, 15.0, 1.0)
    assert (used["kind"], used["label"], used["x"], used["z"], used["d"]) == ("meter", "1XYZ0000000002", 157.5, 40.0, 80.0)


def test_three_point_places_stack_and_an_unnumbered_meter_reads_zaehler() -> None:
    boxes = _boxes(_open(tall_zb54s()))
    top, bottom = boxes["meter:mod-t:0"], boxes["meter:mod-t:1"]
    # ZH53X3 in field 2: ZF units 2–6 → y 325, 750 high; two cells of 375 mm.
    assert (top["x"], top["y"], top["w"], top["h"]) == (310.0, 347.5, 180.0, 330.0)
    assert (bottom["y"], bottom["label"]) == (722.5, "Zähler")
    assert top["label"] == "1XYZ0000000022"


# ── the closed view ──────────────────────────────────────────────────────────


def test_the_closed_view_shows_covers_fronts_windows_and_blind_plates() -> None:
    doc = meter_dist_zb33s()
    doc["enclosure"]["modules"][0]["meters"] = []
    closed = _closed(doc)
    kinds = {box["kind"] for box in closed["boxes"]}
    assert {"cover", "cover_slot", "device_front", "window", "blind_plate", "door", "handle"} <= kinds
    assert not kinds & {"device", "meter", "meter_place"}
    boxes = _boxes(closed)
    assert boxes["cover:mod-z:nar"]["flags"] == ["sealable"]
    assert boxes["cover:mod-v:vt"]["flags"] == []
    cover = boxes["cover:mod-z:aar"]
    assert (cover["x"], cover["y"], cover["w"], cover["h"], cover["z"]) == (27.0, 27.0, 246.0, 296.0, 120.0)
    slot = boxes["slot:mod-z:aar1"]
    assert (slot["y"], slot["h"], slot["z"], slot["d"]) == (77.0, 46.0, 122.0, 0.5)
    front = boxes["front:dev-q1"]
    assert (front["y"], front["h"], front["z"], front["label"]) == (77.5, 45.0, 123.0, "Q1")
    assert boxes["blind:mod-z:0"]["label"] == "Blindabdeckung"
    assert boxes["window:mod-z:0"]["z"] == 122.0


def test_an_occupied_place_shows_its_number_through_the_window() -> None:
    boxes = _boxes(_closed(meter_dist_zb33s()))
    assert boxes["mfront:mod-z:0"]["label"] == "1XYZ0000000001"
    assert "blind:mod-z:0" not in boxes


def test_the_open_view_has_no_cover_layer_but_keeps_the_doors() -> None:
    kinds = {box["kind"] for box in _open(meter_dist_zb33s())["boxes"]}
    assert not kinds & {"cover", "cover_slot", "device_front", "window", "meter_front", "blind_plate"}
    assert {"door", "handle"} <= kinds


def test_door_leaves_and_handles() -> None:
    boxes = _boxes(_open(meter_dist_zb33s()))
    doors = [(b["x"], b["w"], b["h"], b["z"], b["d"]) for b in boxes.values() if b["kind"] == "door"]
    assert doors == [(0.0, 400.0, 1100.0, 205.0, 2.0), (400.0, 400.0, 1100.0, 205.0, 2.0)]
    assert [(boxes[f"handle:{i}"]["x"], boxes[f"handle:{i}"]["y"]) for i in (0, 1)] == [(370.0, 490.0), (415.0, 490.0)]
    single = document("ZB32S", [], [])
    handle = _boxes(_open(single))["handle:0"]
    assert (handle["x"], handle["w"], handle["h"], handle["z"], handle["d"]) == (520.0, 15.0, 120.0, 207.0, 20.0)


# ── what a broken board still draws ──────────────────────────────────────────


def test_an_unknown_module_is_a_one_unit_placeholder() -> None:
    doc = document("ZB33S", [module("x", "ZX00GONE", 1, {"r1": "r"}, unit=2, fittings=[])],
                   [row("r", "r", [ls("d", "F1", "1", "x")])])
    boxes = _boxes(_open(doc))
    placeholder = boxes["module:x"]
    assert (placeholder["x"], placeholder["y"], placeholder["w"], placeholder["h"]) == (275.0, 325.0, 250.0, 150.0)
    assert (placeholder["label"], placeholder["flags"]) == ("ZX00GONE", ["unknown_code"])
    assert not [b for b in boxes.values() if b["kind"] in ("zone", "rail", "device")]


def test_the_order_is_deterministic_and_flags_are_sorted() -> None:
    doc = meter_dist_zb33s()
    doc["rows"][0]["devices"][0]["supplied_by"] = supplied("mod-z", "hs")  # an SLS claiming the HS: first claimant
    scene = _open(doc)
    keys = [(b["z"], b["y"], b["x"], b["id"]) for b in scene["boxes"]]
    assert keys == sorted(keys)
    assert all(b["flags"] == sorted(b["flags"]) for b in scene["boxes"])
    assert scene == _open(doc)


# ── WAGO terminal strips (docs/PANEL_ENCLOSURE_R2.md §8) ─────────────────────


def test_each_placed_strip_is_one_box_on_its_terminal_rail_in_the_open_view() -> None:
    doc = meter_dist_zb33s()
    boxes = _boxes(_open(doc))
    rail = boxes["rail:mod-v:r1"]
    strip = boxes["terminal:dev-f1:leiste"]
    # x from the rail's left end; 96 × 42.3 mm is the 2003-7641 body, a drawing approximation.
    assert {k: strip[k] for k in ("kind", "x", "y", "z", "w", "h", "d", "label")} == {
        "kind": "terminal_strip", "x": rail["x"], "y": round1(rail["y"] + 17.5 - 48), "z": 47.5,
        "w": 30.7, "h": 96.0, "d": 42.3, "label": "X1"}
    assert (strip["moduleId"], strip["railKey"], strip["rowId"], strip["deviceId"], strip["zoneType"], strip["flags"]) == (
        "mod-v", "r1", None, None, "VT", [])
    assert sorted(b["id"] for b in boxes.values() if b["kind"] == "terminal_strip") == [
        "terminal:dev-f1:leiste", "terminal:dev-f3:leiste"]


def test_the_closed_view_has_no_strips_but_both_views_mark_the_reserved_rails() -> None:
    doc = meter_dist_zb33s()
    for scene in (_open(doc), _closed(doc)):
        rails = _boxes(scene, "rail")
        assert rails["rail:mod-v:r1"]["flags"] == ["terminals"] and rails["rail:mod-v:r2"]["flags"] == ["terminals"]
        assert rails["rail:mod-v:r3"]["flags"] == [] and rails["rail:mod-z:aar1"]["flags"] == []
    assert not _boxes(_closed(doc), "terminal_strip")


def test_strips_follow_devices_left_on_a_reserved_rail_and_placeholders_are_not_drawn() -> None:
    doc = terminals_zb34s()
    for scene in (_open(doc), _closed(doc)):
        ids = set(_boxes(scene))
        assert "device:dev-pl1" not in ids and "front:dev-pl1" not in ids
    boxes = _boxes(_open(doc))
    rail = boxes["rail:mod-k:r2"]
    assert boxes["device:dev-f1-7"]["x"] == round1(rail["x"] + 35.0)
    assert boxes["terminal:dev-f2:leiste"]["x"] == round1(rail["x"] + 52.5)
    assert boxes["terminal:dev-f3:leiste"]["w"] == 61.9  # the end plate sits inside X3, before its 2009-305
    assert "terminal:dev-f4:leiste" not in boxes  # unplaced strips get no box


def test_a_precomputed_placement_gives_the_same_scene() -> None:
    doc = tall_zb54s()
    placement = place_terminals(doc, builtin_catalog())
    for view in ("open", "closed"):
        assert build_enclosure_scene(doc, builtin_catalog(), view=view, placement=placement) == build_enclosure_scene(
            doc, builtin_catalog(), view=view)
