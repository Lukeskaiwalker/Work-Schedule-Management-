"""The Stromlaufplan's layout (docs/SCHALTPLAN_STROMLAUF.md §5.3, §6): pure
geometry, checked by invariants over generated and fixture boards.

What must hold on every sheet: every primitive inside the drawing area;
groups in model order; continuation markers paired; a junction dot at every
tap and a hop at exactly every crossing that is not a junction; PE never
through an RCD or MCB; N under a 4-pole RCD taken from the RCD; no wire
joining two sources; texts that fit their slot, never overlap and are at
least 6.5 pt; the same output for the same input."""

from __future__ import annotations

import copy
import itertools
from typing import Any

import pytest

from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.schaltplan_pdf_style import DRAW_X0, DRAW_X1, DRAW_Y0, DRAW_Y1, FONT, FONT_BOLD, text_width
from app.services.schaltplan_stromlauf_layout import Frame, layout_stromlauf, paginate_columns
from app.services.schaltplan_stromlauf_layout_routes import crossings, on_segment, segments, taps
from app.services.schaltplan_stromlauf_model import build_stromlauf_model
from scripts import enclosure_fixture_boards as fixtures
from tests.test_schaltplan import _device, _document

HOP_R = 2.2


def _ls(name: str, circuit: int, *, phase: str = "L1", poles: int = 1, cable: str = "NYM-J 3x2,5 mm²",
        **extra: Any) -> dict:
    return _device(name, "mcb", te=poles, poles=poles, rating="B16", circuit=str(circuit), phase=phase,
                   label="Steckdosen Küche Arbeitsplatte links", room="Küche", cable=cable, **extra)


def _board(fis: int, per_fi: int, *, mix: bool = False, unknown: bool = False) -> dict:
    """``fis`` FIs with ``per_fi`` circuits each: rotating phases, every fourth
    a 3-pole LS with a 5-core cable when ``mix``; phase "-" when ``unknown``."""
    rows = []
    for g in range(1, fis + 1):
        devices = [_device(f"f{g}", "rcd", te=4, poles=4, rating="40 A", residual_current="30 mA", rcd_type="A")]
        for i in range(1, per_fi + 1):
            phase = "-" if unknown else ("L1", "L2", "L3")[i % 3]
            if mix and i % 4 == 0:
                devices.append(_ls(f"f{g}.{i}", 100 * g + i, phase="L1-L3", poles=3, cable="NYM-J 5x2,5 mm²"))
            else:
                devices.append(_ls(f"f{g}.{i}", 100 * g + i, phase=phase))
        rows.append({"id": f"row-{g}", "label": f"Reihe {g}", "slots": 48, "devices": devices})
    return {**_document([]), "rows": rows}


def _two_sources() -> dict:
    """SLS → HS → two FIs, a second SLS → HS → one FI, a pre-fused FI, a bare LS."""
    devices = [
        _ls("x1", 90, phase="L2"),
        _device("q0", "sls", te=3, poles=3, designation="Q0", rating="E35"),
        _device("q1", "hauptschalter", te=3, poles=3, designation="Q1", rating="63 A", parent_id="q0"),
        _device("q10", "sls", te=3, poles=3, designation="Q10", rating="E35"),
        _device("q11", "hauptschalter", te=3, poles=3, designation="Q11", rating="63 A", parent_id="q10"),
        _device("f0", "fuse", te=3, poles=3, designation="F0", rating="35 A"),
        _device("f1", "rcd", te=4, poles=4, rating="40 A", residual_current="30 mA", rcd_type="A", parent_id="q1"),
        _ls("f1.1", 1), _ls("f1.2", 2, phase="L3"),
        _device("f2", "rcd", te=4, poles=4, rating="40 A", residual_current="30 mA", rcd_type="A", parent_id="q11"),
        _ls("f2.1", 3, phase="L2"),
        _device("f3", "rcd", te=4, poles=4, rating="40 A", residual_current="", rcd_type="", parent_id="f0"),
        _ls("f3.1", 4, phase="-", cable=""), _ls("f3.2", 5, cable="NYM-J 7x1,5"),
    ]
    return _document(devices)


def _fixture_boards() -> list[tuple[str, dict]]:
    return [(name, build()) for name, build in sorted(fixtures.BOARDS.items())]


GENERATED = [
    *((f"{fis}x{per}", _board(fis, per)) for fis, per in itertools.product((1, 2, 5, 12), (0, 1, 8, 13, 40))),
    ("mix-3x9", _board(3, 9, mix=True)),
    ("mix-11x8", _board(11, 8, mix=True)),
    ("unknown-2x6", _board(2, 6, unknown=True)),
    ("two-sources", _two_sources()),
    ("empty", _document([])),
]


def _sheets(document: dict, catalog=None) -> list[dict]:
    model = build_stromlauf_model(document, catalog)
    return layout_stromlauf(model, Frame(first_sheet=3))


def _text_box(text: dict) -> tuple[float, float, float, float]:
    font = FONT_BOLD if text.get("bold") else FONT
    width = text_width(text["text"], font, text["size"])
    size = text["size"]
    if text.get("angle"):
        return (text["x"] - 0.75 * size, text["y"], text["x"] + 0.22 * size, text["y"] + width)
    left = {"start": text["x"], "middle": text["x"] - width / 2, "end": text["x"] - width}[text["anchor"]]
    return (left, text["y"] - 0.22 * size, left + width, text["y"] + 0.75 * size)


def _inside(box: tuple[float, float, float, float]) -> bool:
    x0, y0, x1, y1 = box
    return DRAW_X0 - 0.01 <= x0 and x1 <= DRAW_X1 + 0.01 and DRAW_Y0 - 0.01 <= y0 and y1 <= DRAW_Y1 + 0.01


def _overlap(a: tuple[float, ...], b: tuple[float, ...]) -> bool:
    return a[0] < b[2] - 0.05 and b[0] < a[2] - 0.05 and a[1] < b[3] - 0.05 and b[1] < a[3] - 0.05


def _check_sheet(sheet: dict) -> None:
    wires = sheet["wires"]
    for wire in wires:
        for x, y in wire["points"]:
            assert _inside((x, y, x, y)), (wire, sheet["number"])
    for x, y in sheet["dots"]:
        assert _inside((x - 2, y - 2, x + 2, y + 2))
    for hop in sheet["hops"]:
        assert _inside((hop["x"] - HOP_R, hop["y"] - HOP_R, hop["x"] + HOP_R, hop["y"] + HOP_R))
    for box in sheet["boxes"]:
        assert _inside((box["x"], box["y"], box["x"] + box["w"], box["y"] + box["h"])), box
    # A dot at every tap; a hop at exactly every crossing that is not a junction.
    dots = {tuple(dot) for dot in sheet["dots"]}
    assert set(taps(wires)) <= dots, set(taps(wires)) - dots
    assert {(hop["x"], hop["y"]) for hop in sheet["hops"]} == set(crossings(wires))
    _check_texts(sheet)
    _check_boxes(sheet)
    _check_sources(wires)


def _check_texts(sheet: dict) -> None:
    boxes = []
    for text in sheet["texts"]:
        assert text["size"] >= 6.5, text
        font = FONT_BOLD if text.get("bold") else FONT
        if "w" in text:
            assert text_width(text["text"], font, text["size"]) <= text["w"] + 0.01, text
        box = _text_box(text)
        assert _inside(box), text
        boxes.append((box, text))
    for (a, ta), (b, tb) in itertools.combinations(boxes, 2):
        assert not _overlap(a, b), (ta, tb)


def _check_boxes(sheet: dict) -> None:
    devices = [box for box in sheet["boxes"] if box["kind"] in ("rcd", "mcb", "rcbo", "fuse", "sls", "switch")]
    for wire in sheet["wires"]:
        if wire["conductor"] not in ("PE", "PEN"):
            continue
        for (x0, y0), (x1, y1) in segments(wire["points"]):
            for box in devices:
                crosses = (min(x0, x1) < box["x"] + box["w"] and max(x0, x1) > box["x"]
                           and min(y0, y1) < box["y"] + box["h"] and max(y0, y1) > box["y"])
                assert not crosses, (wire, box)
    for box in sheet["boxes"]:
        if box["kind"] == "rcd" and len(box["poles"]) == 4:
            n_x = next(pole["x"] for pole in box["poles"] if pole["conductor"] == "N")
            assert any(w["conductor"] == "N" and w["points"][0] == [n_x, box["y"]] for w in sheet["wires"]), box


def _check_sources(wires: list[dict]) -> None:
    for a, b in itertools.combinations(wires, 2):
        if a["source"] == b["source"]:
            continue
        for point in (*a["points"], *b["points"]):
            other = b if point in a["points"] else a
            assert not any(on_segment(tuple(point), s, interior=False) for s in segments(other["points"])), (a, b)


@pytest.mark.parametrize(("name", "document"), GENERATED, ids=[name for name, _ in GENERATED])
def test_generated_boards_keep_every_invariant(name: str, document: dict) -> None:
    sheets = _sheets(document)
    assert [sheet["number"] for sheet in sheets] == list(range(3, 3 + len(sheets)))
    for sheet in sheets:
        _check_sheet(sheet)
    _check_markers(sheets)
    assert sheets == _sheets(document)  # deterministic


@pytest.mark.parametrize(("name", "document"), _fixture_boards(), ids=[name for name, _ in _fixture_boards()])
def test_fixture_boards_keep_every_invariant(name: str, document: dict) -> None:
    sheets = _sheets(document, builtin_catalog())
    for sheet in sheets:
        _check_sheet(sheet)
    _check_markers(sheets)


def _check_markers(sheets: list[dict]) -> None:
    outgoing = [(sheet["number"], int(t["text"].rsplit(" ", 1)[1])) for sheet in sheets for t in sheet["texts"]
                if t["text"].startswith("→ Forts. Blatt ")]
    incoming = [(int(t["text"].rsplit(" ", 1)[1]), sheet["number"]) for sheet in sheets for t in sheet["texts"]
                if t["text"].startswith("Forts. von Blatt ")]
    assert sorted(outgoing) == sorted(incoming)


def test_groups_keep_the_model_order_and_every_circuit_appears_once() -> None:
    document = _board(5, 13, mix=True)
    model = build_stromlauf_model(document)
    plans = paginate_columns(model, Frame())
    heads = [chunk.group.key for sheet in plans for band in sheet for segment in band for chunk in segment.chunks]
    assert list(dict.fromkeys(heads)) == [group.key for group in model.groups]
    circuits = [(chunk.group.key, i) for sheet in plans for band in sheet for segment in band
                for chunk in segment.chunks for i in range(chunk.start, chunk.stop)]
    assert circuits == [(group.key, i) for group in model.groups for i in range(len(group.circuits))]


def test_every_source_has_its_own_bus_segment() -> None:
    model = build_stromlauf_model(_two_sources())
    plans = paginate_columns(model, Frame())
    segments_ = [segment for sheet in plans for band in sheet for segment in band]
    assert [segment.source.key for segment in segments_] == ["", "q0>q1", "q10>q11"]
    assert [segment.source.caption for segment in segments_] == ["", "hinter Q1", "hinter Q11"]
    assert [unit.name for unit in segments_[1].source.series] == ["Q0 SLS", "Q1 HS"]
    first, second = segments_[0], segments_[1]
    assert second.x0 - first.x1 >= 16


def test_a_chain_behind_a_drawn_head_gets_its_own_segment_and_names_its_origin() -> None:
    """Q1 HS has circuits of its own and feeds F1: F1 must not hang off the bus
    after Q0 (it would bypass Q1), it starts a segment "von Q1 HS"."""
    devices = [
        _device("q0", "sls", te=3, poles=3, designation="Q0", rating="E35"),
        _device("q1", "hauptschalter", te=3, poles=3, designation="Q1", parent_id="q0"),
        _ls("q1.1", 1),
        _device("f1", "rcd", te=4, poles=4, parent_id="q1"), _ls("f1.1", 2),
    ]
    model = build_stromlauf_model(_document(devices))
    assert [(s.key, s.caption, [u.name for u in s.series], s.origin) for s in model.sources] == [
        ("q0", "hinter Q0", ["Q0 SLS"], "supply"), ("q0>q1", "hinter Q1", [], "von Q1 HS")]
    sheet = layout_stromlauf(model, Frame())[0]
    assert "von Q1 HS" in [t["text"] for t in sheet["texts"]]
    _check_sheet(sheet)


def test_the_first_band_opens_with_the_supply_and_the_feeder_chain() -> None:
    sheet = _sheets(_two_sources())[0]
    texts = [t["text"] for t in sheet["texts"]]
    assert "Zuleitung NYY-J 5x16 mm² · Vorsicherung NH 63 A · TN-S" in texts
    assert {"Q0 SLS", "Q1 HS", "Q10 SLS", "Q11 HS"} <= set(texts)
    assert "hinter Q1" in texts and "hinter Q11" in texts and "von Einspeisung" in texts
    assert "IΔn 30 mA · Typ A" in texts or {"IΔn 30 mA", "Typ A"} <= set(texts)
    assert "IΔn — · Typ —" in texts or {"IΔn —", "Typ —"} <= set(texts)
    assert "F0 35 A" in texts and ("OHNE FI-SCHUTZ" in texts or {"OHNE", "FI-SCHUTZ"} <= set(texts))
    assert "Leitung —" in texts and "7-adrig" in texts
    kinds = [box["kind"] for box in sheet["boxes"]]
    assert kinds.count("sls") == 2 and kinds.count("switch") == 2 and kinds.count("fuse") == 1


def test_unknown_phases_are_drawn_in_warn_and_counted_once_per_sheet() -> None:
    sheets = _sheets(_board(2, 6, unknown=True))
    assert sum(1 for sheet in sheets for w in sheet["wires"] if w["conductor"] == "L?") >= 12
    assert sheets[0]["note"] == "L? = Phase nicht angegeben (12 Stromkreise)"
    assert _sheets(_board(2, 6))[0]["note"] == ""


def test_column_width_follows_the_core_count() -> None:
    model = build_stromlauf_model(_board(1, 4, mix=True))
    chunk = paginate_columns(model, Frame())[0][0][0].chunks[0]
    assert chunk.widths == (48.0, 48.0, 48.0, 64.0)


def test_a_tn_c_s_four_core_infeed_splits_the_pen_on_the_first_band() -> None:
    document = _board(1, 2)
    document["supply"] = {**document["supply"], "system": "TN-C-S", "incoming": "NYY-J 4x35"}
    sheet = _sheets(document)[0]
    assert any(w["conductor"] == "PEN" for w in sheet["wires"])
    assert "PEN-Aufteilung im NAR" in [t["text"] for t in sheet["texts"]]


def test_the_model_and_the_layout_never_mutate_the_document() -> None:
    document = _two_sources()
    before = copy.deepcopy(document)
    _sheets(document)
    assert document == before


def test_terminal_labels_reach_the_column() -> None:
    document = _board(1, 2)
    model = build_stromlauf_model(document, terminal_labels={"f1.1": ["X1.1"], "f1.2": ["X1.2"]})
    texts = [t["text"] for t in layout_stromlauf(model, Frame())[0]["texts"]]
    assert "X1.1" in texts and "X1.2" in texts


def test_a_label_word_too_wide_at_7_pt_steps_down_to_6_5_pt_before_it_is_cut() -> None:
    """"Wärmepumpe" is 46.3 pt in bold 7 pt and 43.0 pt at 6.5 pt: in a 48 pt column
    (44 pt of text) it prints whole at 6.5 pt; a word too wide even then is still cut
    (slice D's render review)."""
    devices = [_device("f1", "rcd", te=4, poles=4, rating="40 A", residual_current="30 mA", rcd_type="A"),
               {**_ls("f1.1", 1), "label": "Wärmepumpe Steuerung"},
               {**_ls("f1.2", 2), "label": "Licht Flur"},
               {**_ls("f1.3", 3), "label": "Hauswirtschaftsraumbeleuchtung"}]
    texts = [t for sheet in _sheets(_document(devices)) for t in sheet["texts"]]
    by_text = {t["text"]: t for t in texts}
    assert by_text["Wärmepumpe"]["size"] == 6.5 and by_text["Steuerung"]["size"] == 6.5
    assert by_text["Licht Flur"]["size"] == 7.0
    assert any(t["text"].startswith("Hauswirt") and t["text"].endswith("…") for t in texts)
