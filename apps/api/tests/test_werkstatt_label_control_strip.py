"""The §14a strip with vertical text and the Aderbeschriftung (docs/PANEL_ENCLOSURE_R4.md §9.1, §9.2).

The block is stored on the enclosure and read through ``parse_control_block``
only; the strip exists when the block does, is not off and has a terminal.
The size rule is twinned (``controlStripSize``, fixture table
``control_strip_size``); the geometry is the printer's alone. The rotation
digit is a hypothesis until the test print T-V1, so the tests pin the
reading-frame box, which both candidate digits must print into.
"""

from __future__ import annotations

import json
import math
from dataclasses import replace

import pytest

from app.schemas.panel_enclosure import TUBE_MATERIAL_IDS as SCHEMA_TUBE_IDS
from app.services import werkstatt_label_control_strip as cs
from app.services.panel_enclosure_control_block import DEFAULT_CONTROL_LABELS, default_control_block
from app.services.schaltplan_layout import GLYPH_ADVANCE_EM, STRIP_SEG_PAD_DOTS, font_size_for_fits, text_width_em
from app.services.werkstatt_label_builtins import DEFAULT_MATERIALS, TUBE_MATERIAL_IDS
from app.services.werkstatt_label_errors import LabelLayoutOutOfBounds
from app.services.werkstatt_label_frame import _frame
from app.services.werkstatt_label_jobs import _anchor_extent, _elements, fit_to_media
from app.services.werkstatt_label_profile import PHYSICAL_DOTS_PER_MM, mm_to_dots
from app.services.werkstatt_label_strips import CAP_HEIGHT_RATIO, CAP_TOP_RATIO
from scripts.write_enclosure_fixtures import FIXTURE_PATH

M = {profile.id: profile for profile in DEFAULT_MATERIALS}
P2009, P211_501, P211_502 = M["wago-2009-110"], M["wago-211-501"], M["wago-211-502"]


def _doc(block: object = None, *, enclosure: bool = True) -> dict:
    if not enclosure:
        return {"version": 1, "rows": []}
    enc: dict = {"code": "ZB33S", "modules": []}
    if block is not None:
        enc["control_block"] = block
    return {"version": 1, "rows": [], "enclosure": enc}


def _block(labels: list[str], **extra) -> dict:
    block = default_control_block()
    block["terminals"] = [{"id": f"t{i + 1}", "label": label, "color": "braun"} for i, label in enumerate(labels)]
    return {**block, **extra}


def _elements_of(job: list[str]) -> list[str]:
    return job[job.index("^L") + 1:len(job) - 1 - job[::-1].index("E")]


def _at_lines(job: list[str]) -> list[str]:
    return [line for line in _elements_of(job) if line.startswith("AT,")]


# ── The predicate ──────────────────────────────────────────────────────────


def test_no_strip_without_a_block_an_enclosure_or_terminals() -> None:
    assert cs.control_strip(_doc(enclosure=False)) is None
    assert cs.control_strip(_doc()) is None
    assert cs.control_strip(_doc("not a block")) is None
    assert cs.control_strip(_doc(_block([]))) is None
    assert cs.control_strip(_doc(_block(["UNSM"], off=True))) is None
    assert cs.control_strip(None) is None


def test_the_default_block_is_a_six_terminal_strip_read_through_the_parser() -> None:
    strip = cs.control_strip(_doc(default_control_block()))
    assert strip is not None
    assert strip.labels == DEFAULT_CONTROL_LABELS
    assert (strip.strip_id, strip.part_count, strip.length_mm, strip.size, strip.blank_count) == ("control:block", 6, 31.2, 35, 0)
    # The parser cleans what the editor stored: control characters out, spaces stripped, 12 code points.
    messy = cs.control_strip(_doc(_block(["  UN\x07SM ", "", "ABCDEFGHIJKLMNOP"])))
    assert messy.labels == ("UNSM", "", "ABCDEFGHIJKL")
    assert messy.blank_count == 1
    assert messy.length_mm == 15.6


def test_the_ids_and_copy_are_the_contracts() -> None:
    assert (cs.CONTROL_STRIP_ID, cs.WIRE_STRIP_ID) == ("control:block", "control:wires")
    assert cs.CONTROL_STRIP_LABEL == "§14a-Klemmleiste"
    assert cs.WIRE_STRIP_LABEL == "Aderbeschriftung"
    assert cs.CONTROL_STALE_DETAIL == (
        "Die §14a-Klemmleiste wurde geändert oder entfernt — nichts gedruckt. "
        "Bitte die Seite neu laden und erneut drucken."
    )
    assert cs.NO_WIRE_LABELS_DETAIL == "Keine Aderbeschriftung — erst Klemmen benennen."
    assert cs.label_too_long_detail("Steuerbox 12") == "„Steuerbox 12“ ist zu lang für die Klemme — in der §14a-Klemmleiste kürzen."
    assert cs.CONTROL_SEGMENT_MM == 5.2 and cs.CONTROL_STRIP_MATERIAL_ID == "wago-2009-110"


# ── Size (twinned) ─────────────────────────────────────────────────────────


def _em_ltr(text: str) -> float:
    total = 0.0
    for ch in text:
        total += GLYPH_ADVANCE_EM.get(ch, 0.58)
    return total


def test_strip_size_is_the_tightest_fit_capped_at_48_and_the_segment() -> None:
    budget = 11 * PHYSICAL_DOTS_PER_MM - 2 * STRIP_SEG_PAD_DOTS
    assert cs.control_strip_budget_dots() == budget
    assert cs.control_strip_size(list(DEFAULT_CONTROL_LABELS)) == 35 == math.floor(budget / _em_ltr("UNSM"))
    assert cs.control_strip_size(["", "", ""]) == 48
    assert cs.control_strip_size([]) == 48
    assert cs.control_strip_size(["0%"]) == 48  # fits at 73, capped at 48
    assert cs.control_strip_size(["UNSM", "Steuerbox 12"]) == math.floor(budget / _em_ltr("Steuerbox 12")) == 17
    # The segment caps it too: 5,2 mm less the guard on both sides.
    assert cs.CONTROL_STRIP_CAP_DOTS == min(48, mm_to_dots(5.2) - 2 * 2) == 48


def test_the_fixture_table_pins_the_size_for_the_twin() -> None:
    rows = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))["control_strip_size"]
    assert rows[0] == {"labels": list(DEFAULT_CONTROL_LABELS), "size": 35}
    assert len(rows) >= 4
    for row in rows:
        assert cs.control_strip_size(row["labels"]) == row["size"], row


def test_the_em_is_summed_left_to_right() -> None:
    for text in ("UNSM", "60%", "Stve", "Steuerbox 12", "äöü ß°µ"):
        assert cs.control_strip_em(text) == _em_ltr(text)
        assert abs(cs.control_strip_em(text) - text_width_em(text)) < 1e-12


def test_a_label_fits_when_it_prints_at_24_dots_or_more() -> None:
    assert cs.control_label_fits("UNSM") is True
    assert cs.control_label_fits("") is True  # a blank label prints an empty segment
    assert cs.control_label_fits("WWWW") is True  # 28 dots
    assert cs.control_label_fits("WWWWW") is False  # 22 dots
    assert cs.control_label_fits("Steuerbox 12") is False
    assert cs.first_too_long(["UNSM", "WWWWW", "Steuerbox 12"]) == "WWWWW"
    assert cs.first_too_long(list(DEFAULT_CONTROL_LABELS)) is None


# ── Geometry (the printer's) ───────────────────────────────────────────────


def test_default_strip_has_one_vertical_text_per_terminal_and_the_strip_marks() -> None:
    job = cs.render_control_strip(P2009, DEFAULT_CONTROL_LABELS, size=35)
    texts = _at_lines(job)
    assert [line.split(",", 9)[-1] for line in texts] == list(DEFAULT_CONTROL_LABELS)
    assert all(",35,35,0,0E,0,0," in line for line in texts)
    # 3 mm lead, 6 × 5,2 mm, 3 mm lead plus the 2 mm print-origin offset:
    # 439 + 24 dots → 38,6 printer-mm → 39.
    assert job[:2] == ["^Q39,0", "^W11"]
    marks = [line for line in _elements_of(job) if line.startswith("Lo,")]
    assert len(marks) == 2 + 5
    # Start mark, five dividers, end mark — each on its own millimetre sum.
    halves = [2, 1, 1, 1, 1, 1, 2]
    centres = [int(line.split(",")[2]) + half for line, half in zip(marks, halves)]
    assert centres == [mm_to_dots(mm) + mm_to_dots(2) for mm in _edges_mm(6)]


def _edges_mm(count: int) -> list[float]:
    edge, out = 3.0, [3.0]
    for _ in range(count):
        edge += 5.2
        out.append(edge)
    return out


def test_the_reading_frame_box_follows_the_contract_formula() -> None:
    size = 35
    h_px = mm_to_dots(11)
    frame = _frame(P2009, w_px=1)
    edges = _edges_mm(6)
    for index, (line, label) in enumerate(zip(_at_lines(cs.render_control_strip(P2009, DEFAULT_CONTROL_LABELS, size=size)), DEFAULT_CONTROL_LABELS)):
        cx = mm_to_dots(edges[index] + 2.6)
        w = size * text_width_em(label)
        y0 = math.floor(h_px / 2 + w / 2 + 0.5)
        em_left = math.floor(cx - size * (CAP_TOP_RATIO + CAP_HEIGHT_RATIO / 2) + 0.5)
        x, y = (int(part) for part in line.split(",")[1:3])
        assert (x, y) == (frame.xm(y0), frame.ym(em_left)), label
        assert _anchor_extent("AT", line) == (x, x + math.ceil(w), y, y + size)


def test_rotation_two_prints_into_the_same_box(monkeypatch) -> None:
    zero = _at_lines(cs.render_control_strip(P2009, DEFAULT_CONTROL_LABELS, size=35))
    monkeypatch.setattr(cs, "VERTICAL_ROTATION", "2")
    two = _at_lines(cs.render_control_strip(P2009, DEFAULT_CONTROL_LABELS, size=35))
    assert all(",0,2E,0,0," in line for line in two)
    for a, b in zip(zero, two):
        assert _anchor_extent("AT", a) == _anchor_extent("AT", b)
    assert set(cs.VERTICAL_ANCHORS) == {"0", "2"}


def test_the_rotation_is_a_named_unverified_constant() -> None:
    assert cs.VERTICAL_ROTATION == "0"


def test_a_blank_label_keeps_its_segment_and_prints_nothing() -> None:
    full = cs.render_control_strip(P2009, ("UNSM", "60%", "30%"), size=35)
    gap = cs.render_control_strip(P2009, ("UNSM", "", "30%"), size=35)
    assert [line.split(",", 9)[-1] for line in _at_lines(gap)] == ["UNSM", "30%"]
    assert [line for line in _elements_of(gap) if line.startswith("Lo,")] == [line for line in _elements_of(full) if line.startswith("Lo,")]
    assert _at_lines(gap)[1] == _at_lines(full)[2]


def test_a_text_too_long_for_the_strip_is_refused_by_the_guard() -> None:
    with pytest.raises(LabelLayoutOutOfBounds):
        cs.render_control_strip(P2009, ("WWWWWWWWWWWW",), size=35)


def test_command_prefixes_are_cleaned_from_the_printed_text() -> None:
    texts = _at_lines(cs.render_control_strip(P2009, ("A~B", "^"), size=35))
    assert [line.split(",", 9)[-1] for line in texts] == ["A B"]


# ── The bounds check reads the rotation ────────────────────────────────────


def test_anchor_extent_per_rotation() -> None:
    w = 35 * text_width_em("UNSM")
    assert _anchor_extent("AT", "AT,100,50,35,35,0,1E,0,0,UNSM") == (65, 100, 50, 50)
    assert _anchor_extent("AT", "AT,10,50,35,35,0,0E,0,0,UNSM") == (10, 10 + math.ceil(w), 50, 85)
    assert _anchor_extent("AT", "AT,120,85,35,35,0,2E,0,0,UNSM") == (120 - math.ceil(w), 120, 50, 85)


def test_the_guard_refuses_a_vertical_text_past_the_strip() -> None:
    with pytest.raises(LabelLayoutOutOfBounds):
        fit_to_media(P2009, ["AT,40,50,35,35,0,0E,0,0,UNSM"], form_length_dots=None)  # x up to 144 > 130
    with pytest.raises(LabelLayoutOutOfBounds):
        fit_to_media(P2009, ["AT,90,50,35,35,0,2E,0,0,UNSM"], form_length_dots=None)  # x from −14
    assert fit_to_media(P2009, ["AT,13,50,35,35,0,0E,0,0,UNSM"], form_length_dots=None) == ["AT,13,50,35,35,0,0E,0,0,UNSM"]


def test_the_elements_parser_still_sees_every_kind() -> None:
    kinds = [kind for kind, _ in _elements(["AT,13,50,35,35,0,0E,0,0,UNSM", "Lo,1,2,3,4", "XRB1,2,3,0,2", "M1", "Y1,2,N"])]
    assert kinds == ["AT", "Lo", "XRB", "data", "Y"]


# ── Aderbeschriftung (§9.2) ────────────────────────────────────────────────


def test_wire_labels_are_every_named_terminal_twice_at_15_mm() -> None:
    segments = cs.wire_label_segments(_doc(_block(["UNSM", "", "0%"])))
    assert segments == [("UNSM", 15.0), ("UNSM", 15.0), ("0%", 15.0), ("0%", 15.0)]
    default = cs.wire_label_segments(_doc(default_control_block()))
    assert [text for text, _ in default] == [label for label in DEFAULT_CONTROL_LABELS for _ in (0, 1)]


def test_no_wire_labels_without_named_terminals() -> None:
    assert cs.wire_label_segments(_doc()) is None
    assert cs.wire_label_segments(_doc(_block(["", ""]))) is None
    assert cs.wire_label_segments(_doc(_block(["UNSM"], off=True))) is None


def test_wire_label_size_is_the_strip_fit_capped_at_48() -> None:
    segments = cs.wire_label_segments(_doc(default_control_block()))
    fitted, overflowing = font_size_for_fits(segments, P211_502.width_mm, pad_dots=STRIP_SEG_PAD_DOTS)
    assert cs.wire_label_size(segments, P211_502) == (min(fitted, 48), overflowing)
    assert cs.wire_label_size(segments, P211_502)[0] == 48
    assert cs.wire_label_size(segments, P211_501)[0] == font_size_for_fits(segments, 5, pad_dots=STRIP_SEG_PAD_DOTS)[0] == 42


def test_the_tube_ids_agree_with_the_schema() -> None:
    assert TUBE_MATERIAL_IDS == SCHEMA_TUBE_IDS == frozenset({"wago-211-501", "wago-211-502"})


def test_the_samples_render_on_their_materials() -> None:
    sample = cs.control_strip_sample(P2009)
    assert sample == cs.render_control_strip(P2009, DEFAULT_CONTROL_LABELS, size=35)
    wires = cs.wire_labels_sample(P211_502)
    assert len(_at_lines(wires)) == 12 and wires[1] == "^W8"
    moved = replace(P2009, across_offset_mm=-5.0)
    with pytest.raises(LabelLayoutOutOfBounds):
        cs.control_strip_sample(moved)
