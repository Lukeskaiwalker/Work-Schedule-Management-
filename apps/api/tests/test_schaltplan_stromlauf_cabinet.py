"""The Stromlaufplan's cabinet sheet "Einspeisung & Zählerplatz" (docs/SCHALTPLAN_STROMLAUF.md §5.2, §5.3, §6).

On a readable cabinet board the supply, the NAR busbar, one lane per meter
place (SLS → Zähler → Trennvorrichtung → HLAK) and the "Steuerung &
Kommunikation" band get sheets of their own before the distribution sheets.
What must hold besides the sheet invariants of the distribution sheets: lanes
pair SLS and Trennvorrichtung physically, the distribution never draws a lane
device again, every lane's xref names the sheet its bus starts on and that
sheet answers "von Blatt …", at most four lanes per sheet with paired
continuation markers, and the §14a block's net never touches L/N/PE."""

from __future__ import annotations

import copy
import itertools
from typing import Any

import pytest

from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.panel_enclosure_control_block import default_control_block
from app.services.schaltplan_stromlauf_cabinet import meter_side_ids
from app.services.schaltplan_stromlauf_layout import Frame, layout_stromlauf
from app.services.schaltplan_stromlauf_layout_routes import on_segment, segments
from app.services.schaltplan_stromlauf_model import build_stromlauf_model
from app.services.schaltplan_stromlauf_pdf import draw_stromlauf_sheet_content
from app.services.schaltplan_pdf_style import CONDUCTOR_COLOURS, DRAW_X0, DRAW_X1, DRAW_Y0, DRAW_Y1
from scripts import enclosure_fixture_boards as fx
from tests.pdf_recorder import Recorder
from tests.test_schaltplan_stromlauf_layout import _check_markers, _check_sheet

CATALOG = builtin_catalog()
POWER = {"L1", "L2", "L3", "N", "PE", "PEN", "L?"}


# ── Generated cabinets: 1–5 fields × 1–2 meter places ───────────────────────


def cabinet_board(fields: int, places: int, *, block: bool = True, system: str = "TN-C-S",
                  incoming: str = "NYY-J 5x16 mm²") -> dict[str, Any]:
    """One meter module per field (ZH3EH16 for one place in a ZB3xS, ZH51X3NT for
    two in a ZB5xS), each place with its SLS, Trennvorrichtung and HLAK, and an
    FI with two LS behind every Trennvorrichtung on rows outside the cabinet."""
    code = "ZH3EH16" if places == 1 else "ZH51X3NT"
    cabinet = f"ZB{3 if places == 1 else 5}{max(fields, 2)}S"
    parts = ("hs",) if places == 1 else ("trenn", "trenn2")
    hlaks = ("hlak",) if places == 1 else ("hlak", "hlak2")
    modules, rows = [], []
    for f in range(fields):
        mid = f"mod-{f}"
        modules.append(fx.module(mid, code, f, {"nar": f"row-{f}-nar", "aar1": f"row-{f}-aar1", "aar2": f"row-{f}-aar2"},
                                 meters=[fx.meter(p, f"1XYZ00000001{f}{p}", f"WE {f + 1}.{p + 1}") for p in range(places)]))
        sls = [fx.dev(f"q{f}{p}0", "sls", designation=f"Q{f}{p}0", rating="E35") for p in range(places)]
        switches = [fx.dev(f"q{f}{p}1", "hauptschalter", designation=f"Q{f}{p}1", rating="63 A", parent_id=f"q{f}{p}0",
                           supplied_by=fx.supplied(mid, parts[p])) for p in range(places)]
        terminals = [fx.dev(f"x{f}{p}", "hlak", designation=f"X{f}{p}", supplied_by=fx.supplied(mid, hlaks[p]))
                     for p in range(places)]
        rows += [fx.row(f"row-{f}-nar", f"F{f + 1} · NAR", sls), fx.row(f"row-{f}-aar1", f"F{f + 1} · AAR 1", switches),
                 fx.row(f"row-{f}-aar2", f"F{f + 1} · AAR 2", terminals)]
        for p in range(places):
            group = f"f{f}{p}"
            rows.append(fx.row(f"row-{group}", f"Verteilung {f + 1}.{p + 1}", [
                fx.fi(f"dev-{group}", f"F{f}{p}", parent_id=f"q{f}{p}1"),
                *fx.ls_run(group, f"F{f}{p}", range(1, 3), 100 * f + 10 * p + 1)]))
    return fx.document(cabinet, modules, rows, supply={"system": system, "incoming": incoming},
                       control_block=default_control_block() if block else None)


GENERATED = [(f"cabinet-{f}x{p}", cabinet_board(f, p)) for f, p in itertools.product(range(1, 6), (1, 2))]
FIXTURES = ["meter_dist_zb33s", "three_point_zb53s", "control_ehz_zb33s", "control_3p_zb53s", "busbar_gap_zb34s",
            "reserve_zb33s",
            # every other fixture board with a meter module (slice D)
            "violations_zb34s", "removed_dangling_zb52s", "tall_zb54s", "terminals_zb34s", "terminals_rk_zb53s"]


def _model(document: dict):
    return build_stromlauf_model(document, CATALOG)


def _sheets(document: dict, first: int = 3) -> list[dict]:
    return layout_stromlauf(_model(document), Frame(first_sheet=first))


def _cabinet(sheets: list[dict]) -> list[dict]:
    return [sheet for sheet in sheets if sheet["kind"] == "cabinet"]


def _texts(sheets: list[dict]) -> list[str]:
    return [text["text"] for sheet in sheets for text in sheet["texts"]]


def _lane(model, number: int):
    return model.cabinet.lanes[number - 1]


# ── Model: lanes per meter place (§5.2) ──────────────────────────────────────


def test_one_lane_per_meter_place_pairs_sls_meter_and_trennvorrichtung() -> None:
    model = _model(fx.meter_dist_zb33s())
    lane = _lane(model, 1)
    assert (lane.number, lane.field, lane.place, lane.meter_kind) == (1, 0, 0, "eHZ")
    assert (lane.sls.designation, lane.switch.designation, lane.hlak.designation) == ("Q0", "Q1", "X0")
    assert (lane.meter_number, lane.meter_label, lane.carrier) == ("1XYZ0000000001", "Allgemein", True)
    assert len(model.cabinet.lanes) == 1


def test_a_doppelstock_gives_two_lanes_and_a_free_place_without_sls() -> None:
    model = _model(fx.three_point_zb53s())
    lanes = [(lane.number, lane.field, lane.place, lane.meter_kind, lane.sls.designation if lane.sls else None,
              lane.switch.designation if lane.switch else None, lane.hlak.designation if lane.hlak else None,
              lane.meter_number or "frei") for lane in model.cabinet.lanes]
    assert lanes == [
        (1, 0, 0, "3-Punkt", "Q0", "Q1", None, "1XYZ0000000051"),
        (2, 1, 0, "3-Punkt", "Q10", "Q11", "X10", "1XYZ0000000052"),
        (3, 2, 0, "3-Punkt", "Q20", "Q21", None, "1XYZ0000000053"),
        (4, 2, 1, "3-Punkt", None, "Q22", None, "frei"),
    ]


def test_the_lane_keeps_the_physical_pairing_and_warns_about_the_plan() -> None:
    document = fx.meter_dist_zb33s()
    rows = document["rows"]
    rows[0]["devices"].append(fx.dev("dev-q5", "sls", designation="Q5", rating="E35"))
    rows[1]["devices"][0]["parent_id"] = "dev-q5"
    lane = _lane(_model(document), 1)
    assert (lane.sls.designation, lane.switch.designation) == ("Q0", "Q1")
    assert "Einspeisung laut Plan: Q5" in lane.notes


def test_a_reserve_field_without_anything_gets_no_lane_but_its_nar_segment() -> None:
    model = _model(fx.reserve_zb33s())
    assert [(lane.number, lane.field, lane.code) for lane in model.cabinet.lanes] == [(1, 1, "ZH33X7")]
    segments_ = model.cabinet.segments
    assert [(s.field, s.zone, s.reserve, s.joint) for s in segments_] == [(0, "NAR", True, False), (1, "NAR", False, True)]
    assert model.cabinet.infeed == "4 × K96F" and model.cabinet.pen_split


def test_unjoined_runs_get_their_own_infeed() -> None:
    model = _model(fx.busbar_gap_zb34s())
    assert [(s.field, s.run, s.joint, s.infeed) for s in model.cabinet.segments] == [
        (0, 0, False, "K96ESA5"), (2, 1, False, "K96ESA5")]
    kit = model.cabinet.kit
    assert (kit.article, kit.device) == ("ZY3N2LS", "LS 6 A")
    assert model.cabinet.network is None and model.cabinet.control is None


def test_supply_kit_network_and_control_come_from_the_cabinet_preparation() -> None:
    cabinet = _model(fx.control_ehz_zb33s()).cabinet
    assert (cabinet.kit.article, cabinet.kit.device, cabinet.kit.ends) == ("ZY3N2SA", "SABO 1,6 A",
                                                                            ("RfZ Feld 1", "APZ Feld 3"))
    assert (cabinet.network.start, cabinet.network.end) == ("APZ Feld 3", "RfZ Feld 1")
    assert cabinet.network.article.startswith("ZZ45WAN")
    control = cabinet.control
    assert [t[1] for t in control.terminals] == ["UNSM", "60%", "30%", "0%", "UStve", "Stve"]
    assert (control.wires, control.target, control.luester) == (
        "6 × H07V-K 2,5 mm²", "RfZ Feld 1", "Lüsterklemme 6-polig (von 12-poliger Leiste)")
    assert [s.joint for s in cabinet.segments] == [False, True]
    assert cabinet.joint_label == "ZZ55SAVE"


def test_a_three_point_block_wires_to_the_apz() -> None:
    cabinet = _model(fx.control_3p_zb53s()).cabinet
    assert cabinet.control.target == "APZ Feld 3" and len(cabinet.control.terminals) == 5
    assert (cabinet.network.start, cabinet.network.end) == ("APZ Feld 3", "Zählerplatz Feld 1")
    assert cabinet.infeed == "5 × K96F"
    assert [s.field for s in cabinet.segments] == [0]  # the ZH53XS SAS is the customer's, never a NAR segment


# ── Model: the distribution never draws a lane device again ─────────────────


def test_lane_sources_lose_their_series_and_name_the_lane() -> None:
    model = _model(fx.meter_dist_zb33s())
    assert [(s.key, s.caption, s.series, s.origin) for s in model.sources] == [
        ("dev-q0>dev-q1", "hinter Q1 HS (Zähler 1, Feld 1)", (), "cabinet:mod-z:0")]


def test_lane_heads_without_circuits_leave_the_distribution() -> None:
    model = _model(fx.three_point_zb53s())
    assert [group.key for group in model.groups] == ["dev-w-f1"]
    ids = {unit.id for source in model.sources for unit in source.series}
    assert not ids & model.cabinet.device_ids


def test_a_lane_switch_with_circuits_becomes_a_headless_group_behind_it() -> None:
    model = _model(fx.terminals_zb34s())
    by_key = {group.key: group for group in model.groups}
    assert by_key["dev-q1"].head.unit is None and by_key["dev-q1"].source == "dev-q0>dev-q1"
    source = next(s for s in model.sources if s.key == "dev-q0>dev-q1")
    assert source.caption == "hinter Q1 HS (Zähler 1, Feld 1)" and source.origin == "cabinet:mod-z:0"


def test_meter_side_devices_hang_off_the_supply_lead_not_a_customer_group() -> None:
    document = fx.violations_zb34s()
    assert meter_side_ids(document, CATALOG) == frozenset({"dev-r1"})
    model = _model(document)
    assert "dev-r1" not in {c.unit.id for g in model.groups for c in g.circuits}
    assert any("F9" in name for _end, names in model.cabinet.kit_devices for name in names)


def test_aar_circuits_carry_their_location_tag() -> None:
    model = _model(fx.terminals_zb34s())
    smgw = next(c for g in model.groups for c in g.circuits if c.unit.id == "dev-aar-ls1")
    assert smgw.location == "AAR Feld 1"


def test_without_a_catalogue_or_a_cabinet_nothing_changes() -> None:
    plain = build_stromlauf_model(fx.meter_dist_zb33s())
    assert plain.cabinet is None and plain.sources[0].series
    assert _model(fx.cross_feed_zb33s()).cabinet is None  # no meter place: no cabinet sheet


# ── Layout: the sheet (§5.3) ─────────────────────────────────────────────────


@pytest.mark.parametrize("name", FIXTURES)
def test_fixture_cabinet_sheets_keep_every_invariant(name: str) -> None:
    document = fx.BOARDS[name]()
    sheets = _sheets(document)
    assert sheets[0]["kind"] == "cabinet" and sheets[0]["title"].endswith("Einspeisung & Zählerplatz")
    assert [sheet["number"] for sheet in sheets] == list(range(3, 3 + len(sheets)))
    for sheet in _cabinet(sheets):
        _check_sheet(sheet)
        _check_control_net(sheet)
    _check_markers(sheets)
    _check_lane_xrefs(sheets)
    assert sheets == _sheets(document)  # deterministic


@pytest.mark.parametrize(("name", "document"), GENERATED, ids=[name for name, _ in GENERATED])
def test_generated_cabinets_keep_every_invariant(name: str, document: dict) -> None:
    before = copy.deepcopy(document)
    sheets = _sheets(document)
    cabinet = _cabinet(sheets)
    assert cabinet
    for sheet in cabinet:
        _check_sheet(sheet)
        _check_control_net(sheet)
        assert sum(1 for t in sheet["texts"] if t["text"].startswith("Zähler ")) <= 4
    _check_markers(sheets)
    _check_lane_xrefs(sheets)
    lanes = [t for s in cabinet for t in s["texts"] if t["text"].startswith("Zähler ")]
    assert len(lanes) == len(_model(document).cabinet.lanes)
    assert document == before


def _check_control_net(sheet: dict) -> None:
    """No §14a or network wire shares a point with L/N/PE (§5.3: "No conductor
    joins the block to the supply-kit leads or the NAR")."""
    power = [w for w in sheet["wires"] if w["conductor"] in POWER]
    signal = [w for w in sheet["wires"] if w["conductor"] not in POWER]
    for a in signal:
        for b in power:
            for point in a["points"]:
                assert not any(on_segment(tuple(point), s, interior=False) for s in segments(b["points"])), (a, b)
            for point in b["points"]:
                assert not any(on_segment(tuple(point), s, interior=False) for s in segments(a["points"])), (a, b)


def _check_lane_xrefs(sheets: list[dict]) -> None:
    """"→ Sammelschiene Blatt k" on a cabinet sheet c ⇒ sheet k says "von Blatt c"."""
    by_number = {sheet["number"]: sheet for sheet in sheets}
    for sheet in _cabinet(sheets):
        for text in sheet["texts"]:
            if text["text"].startswith("→ Sammelschiene Blatt "):
                target = by_number[int(text["text"].rsplit(" ", 1)[1])]
                assert target["kind"] == "distribution"
                assert f"von Blatt {sheet['number']}" in [t["text"] for t in target["texts"]]


def test_the_cabinet_sheet_draws_supply_bus_lane_and_band() -> None:
    sheets = _sheets(fx.control_ehz_zb33s())
    cabinet = _cabinet(sheets)
    texts = _texts(cabinet)
    assert "Zuleitung NYY-J 5x16 mm² · Vorsicherung NH 63 A · TN-C-S" in texts
    assert {"K96ESA5", "ZZ55SAVE", "ZY3N2SA · SABO 1,6 A", "→ RfZ Feld 1", "→ APZ Feld 3"} <= set(texts)
    assert {"Q0 SLS", "Q1 HS", "X0 HLAK", "eHZ", "1XYZ0000000061", "Allgemein"} <= set(texts)
    assert "Steuerung & Kommunikation" in texts
    assert "UNSM ← gemessener Bereich (Erzeugungsanlage/Kundenanlage)" in texts
    assert "60% / 30% / 0% → Erzeugungsanlage" in texts
    assert "UStve ← gemessener Bereich" in texts and "Stve → steuVE" in texts
    assert "6 × H07V-K 2,5 mm²" in texts and "Lüsterklemme 6-polig · RfZ Feld 1" in texts
    assert any(t.startswith("ZZ45WAN") and t.endswith(" · RJ45") for t in texts)
    assert {"APZ Feld 3", "RfZ Feld 1"} <= set(texts)
    wires = [w for s in cabinet for w in s["wires"]]
    assert sum(1 for w in wires if w["conductor"] == "CTRL") >= 6
    assert any(w["conductor"] == "DATA" for w in wires)
    assert any(w.get("thin") and w["conductor"] == "L1" for w in wires)  # the SABO's lead
    names = [b for s in cabinet for b in s["boxes"] if b["kind"] == "control_terminal"]
    assert len(names) == 6
    assert any(t["angle"] == 90 and t["text"] == "UNSM" for s in cabinet for t in s["texts"])


def test_the_lane_xref_and_the_distribution_caption_answer_each_other() -> None:
    sheets = _sheets(fx.meter_dist_zb33s(), first=2)
    assert [sheet["kind"] for sheet in sheets] == ["cabinet", "distribution"]
    assert "→ Sammelschiene Blatt 3" in [t["text"] for t in sheets[0]["texts"]]
    texts = [t["text"] for t in sheets[1]["texts"]]
    assert "von Blatt 2" in texts and "hinter Q1 HS (Zähler 1, Feld 1)" in texts
    assert "Q0 SLS" not in texts and "Q1 HS" not in texts  # drawn on the cabinet sheet only
    assert "Zuleitung NYY-J 5x16 mm² · Vorsicherung NH 63 A · TN-C-S" not in texts


def test_a_four_core_tn_c_s_infeed_splits_the_pen_in_the_nar() -> None:
    sheet = _sheets(fx.reserve_zb33s())[0]
    assert "PEN-Aufteilung im NAR" in [t["text"] for t in sheet["texts"]]
    pen = [w for w in sheet["wires"] if w["conductor"] == "PEN"]
    assert pen and any(w["conductor"] == "N" for w in sheet["wires"])
    assert "4 × K96F" in [t["text"] for t in sheet["texts"]] and "ZZ55SAVE" in [t["text"] for t in sheet["texts"]]


def test_unjoined_runs_are_broken_and_never_share_a_wire() -> None:
    sheet = _sheets(fx.busbar_gap_zb34s())[0]
    texts = [t["text"] for t in sheet["texts"]]
    assert texts.count("K96ESA5") == 2 and "ZZ55SAVE" not in texts
    infeeds = [b for b in sheet["boxes"] if b["kind"] == "infeed"]
    assert len(infeeds) == 2
    low = min(b["y"] + b["h"] for b in infeeds)
    upper = [w for w in sheet["wires"] if w["conductor"] == "L1" and w["points"][0][0] == w["points"][-1][0]
             and min(p[1] for p in w["points"]) > low + 0.5]
    lower = [w for w in sheet["wires"] if w["conductor"] == "L1" and w["points"][0][0] == w["points"][-1][0]
             and max(p[1] for p in w["points"]) <= low + 0.5]
    assert upper and lower


def test_ten_lanes_need_three_sheets_with_paired_markers_and_the_band_on_the_carriers_sheet() -> None:
    sheets = _sheets(cabinet_board(5, 2), first=2)
    cabinet = _cabinet(sheets)
    lanes = [[t for t in s["texts"] if t["text"].startswith("Zähler ")] for s in cabinet]
    assert [len(item) for item in lanes] == [2, 4, 4]
    assert "Steuerung & Kommunikation" in [t["text"] for t in cabinet[0]["texts"]]
    assert "→ Forts. Blatt 3" in [t["text"] for t in cabinet[0]["texts"]]
    assert "Forts. von Blatt 2" in [t["text"] for t in cabinet[1]["texts"]]
    assert sheets[len(cabinet)]["kind"] == "distribution"


def test_the_renderer_strokes_control_and_data_dashed_and_stays_in_the_frame() -> None:
    for sheet in _cabinet(_sheets(fx.control_ehz_zb33s())):
        recorder = Recorder()
        draw_stromlauf_sheet_content(recorder, sheet)
        lines = [p for p in recorder.primitives if p.kind == "line"]
        strokes = {(p.stroke, p.dash) for p in lines}
        for conductor in ("CTRL", "DATA"):
            style = CONDUCTOR_COLOURS[conductor]
            assert (style.colour, style.dash) in strokes, conductor
        assert any(p.width < 1.0 and p.stroke == CONDUCTOR_COLOURS["L1"].colour for p in lines)  # thin leads
        for primitive in recorder.primitives:
            x0, y0, x1, y1 = primitive.bbox
            assert DRAW_X0 - 0.6 <= x0 and x1 <= DRAW_X1 + 0.6, primitive
            assert DRAW_Y0 - 0.6 <= y0 and y1 <= DRAW_Y1 + 0.6, primitive
            if primitive.kind == "string":
                assert primitive.size >= 6.5, primitive


def test_only_the_carriers_first_lane_carries_the_supply_kit() -> None:
    """A Doppelstock carrier has two lanes; the kit (and the band anchor) hang on the first only."""
    document = cabinet_board(1, 2)
    assert [lane.carrier for lane in _model(document).cabinet.lanes] == [True, False]
    sheet = _cabinet(_sheets(document))[0]
    assert [box["kind"] for box in sheet["boxes"]].count("sabo") == 1


def test_a_block_without_a_target_says_why_in_the_findings_words() -> None:
    texts = _texts(_cabinet(_sheets(cabinet_board(2, 2))))
    assert "§14a-Steuerleitungen ohne Ziel: im Schrank fehlt ein APZ" in texts
    assert not any(t.startswith("Lüsterklemme") for t in texts)


@pytest.mark.parametrize("name", ["tall_zb54s", "removed_dangling_zb52s"])
def test_a_missing_device_s_placeholder_text_is_never_shortened(name: str) -> None:
    """ "keine Trennvorrichtung" does not fit the 56 pt column in one bold line: it
    breaks after the first word instead of ending in "…" (slice D's render review)."""
    texts = _texts(_cabinet(_sheets(fx.BOARDS[name]())))
    assert not any("…" in t and t.startswith(("kein", "Trenn")) for t in texts), texts
    assert "keine" in texts and "Trennvorrichtung" in texts
