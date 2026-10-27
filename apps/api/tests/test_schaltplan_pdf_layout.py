"""The Übersichtsschaltplan's sheet layout and the Stromkreisliste's columns.

What must hold (owner's prints of 2026-09-24 and 2026-10-09, and
docs/SCHALTPLAN_STROMLAUF.md §4): groups are packed several per band and a
group wider than a band is split into column chunks with paired markers
"→ Forts. Blatt k" / "Forts. von Blatt i" — nothing past the frame, nothing
scaled; groups behind different sources never share a busbar line; feeder
heads without circuits form a compact chain beside the supply instead of
empty boxes; the second band's busbar sits below the deepest text a circuit
in band 0 can stack; and the pole count is visible — on the symbol, beside
the rating and in the legend's device column — because a 1-pole and a 3-pole
LS read identically otherwise. On the Stromkreisliste no text may run into
the next column: every header fits its column and every wrapped cell line
fits, at the same total width as before, so the sheet glued into the door
keeps its size.
"""

from __future__ import annotations

import itertools

import pytest
from fastapi.testclient import TestClient
from reportlab.pdfbase.pdfmetrics import stringWidth

from app.services import schaltplan_pdf as pdf
from app.services import schaltplan_pdf_overview as ov
from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.schaltplan_layout import build_legend, build_topology
from app.services.schaltplan_pdf_style import (
    DRAW_X0,
    DRAW_X1,
    DRAW_Y0,
    DRAW_Y1,
    FONT,
    FONT_BOLD,
    TITLE_STRIP_CELLS,
    fit_text,
    wrap,
)
from scripts.enclosure_fixture_boards import meter_dist_zb33s, violations_zb34s
from tests.pdf_recorder import Recorder
from tests.test_schaltplan import _auth, _create_panel, _customer, _device, _document, _pdf_text


def _group(name: str, circuits: int, **head: object) -> dict:
    return {"device": _device(name, "rcd", te=4, poles=4, **head),
            "children": [_device(f"{name}.{i}", "mcb") for i in range(circuits)],
            "pre_fuse": None, "fed_by": None, "feeds": [], "feed_cycle": False}


def _shape(sheets: list[ov.OverviewSheet]) -> list[list[list[tuple[str, int, int]]]]:
    return [[[(chunk.group["device"]["id"], chunk.start, chunk.stop) for chunk in band] for band in sheet.bands]
            for sheet in sheets]


def _board(fis: int, per_fi: int) -> dict:
    """``fis`` FIs with ``per_fi`` LS each, one row per FI (a row holds at most 96 devices)."""
    rows: list[dict] = []
    for g in range(1, fis + 1):
        devices = [_device(f"f{g}", "rcd", te=4, poles=4, rating="40 A", residual_current="30 mA", rcd_type="A")]
        devices += [_device(f"f{g}.{i}", "mcb", rating="B16", circuit=str(100 * g + i),
                            label="Steckdosen Küche Arbeitsplatte links", room="Küche",
                            cable="NYM-J 3x2,5 mm²", phase="L1") for i in range(1, per_fi + 1)]
        rows.append({"id": f"row-{g}", "label": f"Reihe {g}", "slots": 48, "devices": devices})
    return {**_document([]), "rows": rows}


# ── Packing ─────────────────────────────────────────────────────────────────


def test_several_groups_share_a_band() -> None:
    # Four FIs with two LS each: three in band 0 (x 200..802), the fourth in band 1.
    sheets = ov.paginate_overview([_group(f"f{g}", 2) for g in range(1, 5)])
    assert _shape(sheets) == [[[("f1", 0, 2), ("f2", 0, 2), ("f3", 0, 2)], [("f4", 0, 2)]]]
    first = sheets[0].bands[0][0]
    assert first.x == ov.BAND_X0[0] == 200 and first.width == 156


def test_a_group_wider_than_the_rest_of_a_band_continues_in_the_next_band() -> None:
    # 4 + 6 circuits: one sheet, not two — and F2 whole in the empty band below (review 2:
    # it was torn 3+3 although band 1 held all six).
    sheets = ov.paginate_overview([_group("f1", 4), _group("f2", 6)])
    assert _shape(sheets) == [[[("f1", 0, 4)], [("f2", 0, 6)]]]
    # Never a one-column chunk: with room for one column only, the group moves on.
    sheets = ov.paginate_overview([_group("f1", 6), _group("f2", 3)])
    assert _shape(sheets) == [[[("f1", 0, 6)], [("f2", 0, 3)]]]


def test_a_group_that_fits_the_next_band_whole_is_not_split() -> None:
    assert _shape(ov.paginate_overview([_group("f1", 4), _group("f2", 4)])) == [[[("f1", 0, 4)], [("f2", 0, 4)]]]
    for sheet in ov.paginate_overview([_group("f1", 4), _group("f2", 4), _group("f3", 3)]):
        for band in sheet.bands:
            for chunk in band:
                assert (chunk.start, chunk.stop) == (0, len(chunk.group["children"])), chunk.group["device"]["id"]


def test_keeping_groups_whole_never_costs_a_sheet() -> None:
    for fis in range(1, 5):
        for sizes in itertools.product(range(2, 7), repeat=fis):
            groups = [_group(f"f{i}", n) for i, n in enumerate(sizes, start=1)]
            loads = ov._ordered_loads(groups)
            assert len(ov.paginate_overview(groups)) <= len(ov._pack(loads, keep_whole=False)), sizes


def test_a_group_wider_than_a_band_is_split_into_column_chunks() -> None:
    sheets = ov.paginate_overview([_group("f1", 12)])
    assert _shape(sheets) == [[[("f1", 0, 7)], [("f1", 7, 12)]]]
    head, tail = sheets[0].bands[0][0], sheets[0].bands[1][0]
    assert (head.next_sheet, tail.prev_sheet) == (1, 1)
    assert head.x + head.width <= DRAW_X1 and tail.x == ov.BAND_X0[1] == DRAW_X0


def test_eleven_fis_with_eight_circuits_each_need_far_fewer_than_twelve_sheets() -> None:
    groups = [_group(f"f{g}", 8) for g in range(1, 12)]
    sheets = ov.paginate_overview(groups)
    assert len(sheets) <= 6
    chunks = [chunk for sheet in sheets for band in sheet.bands for chunk in band]
    # Every circuit exactly once, in order; every chunk inside its band.
    seen = [(chunk.group["device"]["id"], i) for chunk in chunks for i in range(chunk.start, chunk.stop)]
    assert seen == [(f"f{g}", i) for g in range(1, 12) for i in range(8)]
    for number, sheet in enumerate(sheets, start=1):
        for band_index, band in enumerate(sheet.bands):
            for chunk in band:
                assert ov.BAND_X0[band_index] <= chunk.x and chunk.x + chunk.width <= DRAW_X1
                if chunk.stop < len(chunk.group["children"]):
                    assert chunk.next_sheet is not None and chunk.next_sheet >= number
                if chunk.start > 0:
                    assert chunk.prev_sheet is not None and chunk.prev_sheet <= number


def test_continuation_markers_are_paired() -> None:
    sheets = ov.paginate_overview([_group("f1", 30), _group("f2", 3)])
    chunks = [(number, chunk) for number, sheet in enumerate(sheets, start=1)
              for band in sheet.bands for chunk in band]
    for (number, chunk), (next_number, follower) in zip(chunks, chunks[1:]):
        if chunk.group is follower.group:
            assert chunk.next_sheet == next_number and follower.prev_sheet == number
            assert chunk.stop == follower.start


def test_groups_behind_different_sources_get_their_own_busbar_segment() -> None:
    q0 = _device("q0", "sls", te=3, poles=3, designation="Q0")
    q1 = _device("q1", "hauptschalter", te=3, poles=3, designation="Q1", parent_id="q0")
    q10 = _device("q10", "sls", te=3, poles=3, designation="Q10")
    q11 = _device("q11", "hauptschalter", te=3, poles=3, designation="Q11", parent_id="q10")
    devices = [q0, q1, q10, q11]
    for name, feeder in (("f1", "q1"), ("f2", "q11"), ("f3", "q1")):
        devices += [_device(name, "rcd", te=4, poles=4, parent_id=feeder), _device(f"{name}.1", "mcb")]
    groups = build_topology(_document(devices))["groups"]
    chain = ov.feeder_chains(groups)
    assert [[link.device["id"] for link in item] for item in chain] == [["q0", "q1"], ["q10", "q11"]]
    sheets = ov.paginate_overview(groups)
    assert _shape(sheets) == [[[("f1", 0, 1), ("f3", 0, 1), ("f2", 0, 1)], []]]
    segments = sheets[0].segments[0]
    assert [(segment.caption, segment.supply) for segment in segments] == [("hinter Q1", False), ("hinter Q11", False)]
    assert segments[1].x0 - segments[0].x1 >= 16


def test_supply_circuits_on_the_rfz_are_the_unmetered_measuring_side() -> None:
    document = violations_zb34s()
    groups = ov.overview_groups(document, builtin_catalog())
    boxes = [(group.get("box"), [child["id"] for child in group["children"]]) for group in groups if group["device"] is None]
    assert boxes == [("meter", ["dev-r1"])]
    # Without the catalogue nothing is known about rails: the plain warning box.
    plain = ov.overview_groups(document, None)
    assert [group.get("box") for group in plain if group["device"] is None] == ["warn"]


# ── Geometry ────────────────────────────────────────────────────────────────


def test_vertical_metrics_leave_room_for_the_title_strip() -> None:
    assert (ov._Y_BUS, ov._Y_GROUP_TOP, ov._Y_GROUP_BOT, ov._Y_SUBBUS) == (488, 470, 432, 416)
    assert (ov._Y_DEV_TOP, ov._Y_DEV_BOT, ov._Y_CHIP, ov._Y_TEXT, ov._BAND_DY) == (396, 356, 342, 328, 212)
    assert sum(width for _label, width in TITLE_STRIP_CELLS) == 762


def test_the_lower_busbar_clears_the_deepest_circuit_text_of_the_upper_band() -> None:
    # A circuit stacks two label lines, room, cable and phase under its chip.
    deepest_baseline = ov._Y_TEXT - 2 * ov._LABEL_PITCH - 2 * ov._DETAIL_PITCH
    lower_bar = ov._Y_BUS - ov._BAND_DY
    caption_top = lower_bar + 5 + 6.5
    assert caption_top < deepest_baseline - 6
    # …and the lower band's own deepest line (descender included) stays inside the drawing area.
    assert deepest_baseline - ov._BAND_DY - 0.22 * 6.5 >= DRAW_Y0


def _content(document: dict, catalog=None) -> Recorder:
    recorder = Recorder()
    groups = ov.overview_groups(document, catalog)
    chains = ov.feeder_chains(groups)
    for sheet in ov.paginate_overview(groups):
        ov.draw_overview_content(recorder, sheet, supply=document.get("supply") or {}, fed_from=None, chains=chains)
        recorder.showPage()
    return recorder


def _assert_inside(recorder: Recorder) -> None:
    for primitive in recorder.primitives:
        x0, y0, x1, y1 = primitive.bbox
        assert DRAW_X0 - 0.01 <= x0 and x1 <= DRAW_X1 + 0.01, primitive
        assert DRAW_Y0 - 0.01 <= y0 and y1 <= DRAW_Y1 + 0.01, primitive
        if primitive.kind == "string":
            assert primitive.size >= 6.5, primitive


@pytest.mark.parametrize("fis", [1, 2, 5, 12])
@pytest.mark.parametrize("per_fi", [0, 1, 7, 8, 9, 23, 40])
def test_every_primitive_of_every_overview_sheet_is_inside_the_drawing_area(fis: int, per_fi: int) -> None:
    _assert_inside(_content(_board(fis, per_fi)))


def test_cabinet_boards_stay_inside_the_drawing_area_too() -> None:
    for board in (meter_dist_zb33s(), violations_zb34s()):
        recorder = _content(board, builtin_catalog())
        _assert_inside(recorder)
    texts = _content(violations_zb34s(), builtin_catalog()).texts()
    assert "Messsystem (ungezählt, vor SLS)" in texts and "OHNE FI-SCHUTZ" not in texts


def test_the_feeder_chain_is_drawn_beside_the_supply() -> None:
    texts = " ".join(_content(meter_dist_zb33s(), builtin_catalog()).texts())
    assert "Q0 SLS" in texts and "Q1 HS" in texts and "speist F1, F2, F3" in texts
    assert "über Q1 HS" in texts and "hinter Q1" in texts


def test_many_feeder_chains_become_one_row_each_and_never_overlap() -> None:
    """Ten SLS → HS chains (a 5-field Doppelstock cabinet) no longer fit as plates
    beside the supply: one fitted row per chain, inside x 40..190, none on another."""
    from tests.test_schaltplan_stromlauf_cabinet import cabinet_board

    recorder = _content(cabinet_board(5, 2), builtin_catalog())
    _assert_inside(recorder)
    first_page = [p for p in recorder.primitives if p.kind == "string" and p.page == 0]
    chain = [p for p in first_page if p.bbox[0] < 190 and 292 <= p.bbox[1] <= 424]
    assert len([p for p in chain if "→ Sammelschiene" in p.text]) == 10
    for primitive in chain:
        assert primitive.bbox[2] <= 190.01, primitive
    for a, b in itertools.combinations(chain, 2):
        assert not (a.bbox[0] < b.bbox[2] and b.bbox[0] < a.bbox[2] and a.bbox[1] < b.bbox[3] and b.bbox[1] < a.bbox[3]), (a, b)


def test_title_strip_texts_are_fitted_then_cut() -> None:
    assert fit_text("Kurz", FONT, 50) == ("Kurz", 7.5)
    text, size = fit_text("Familie Mustermann-Beispielname GbR", FONT_BOLD, 104)
    assert size == 6.5 and text.endswith("…") and stringWidth(text, FONT_BOLD, size) <= 104


def test_pole_counts_reach_the_diagram_and_the_legend() -> None:
    assert ov._poles(_device("f1.1", "mcb")) == 1
    assert ov._poles(_device("f1.3", "mcb", te=3, poles=3)) == 3
    assert ov._poles({"kind": "rcd"}) == 4  # catalog default when the document has none
    rows = build_legend(
        _document(
            [
                _device("f1", "rcd", te=4, poles=4, rating="40 A"),
                _device("f1.1", "mcb", rating="B16", circuit="1"),
                _device("f1.2", "mcb", te=3, poles=3, rating="B16", circuit="2"),
            ]
        )
    )
    assert [(row["device"], row["poles"]) for row in rows] == [("LS", "1"), ("LS", "3")]


def test_a_large_board_prints_the_overview_and_the_stromlauf_sheets(client: TestClient, admin_token: str) -> None:
    customer = _customer(client, admin_token)
    panel = _create_panel(client, admin_token, customer, designation="UV11", document=_board(11, 8))
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    pages = resp.content.count(b"/Type /Page") - resp.content.count(b"/Type /Pages")
    text = _pdf_text(resp.content)
    assert b"Stromlaufplan allpolig" in text and b"bersichtsschaltplan" in text
    overview = len(ov.paginate_overview(build_topology(_board(11, 8))["groups"]))
    assert overview <= 6 and pages < 12 + 2
    legend = client.get(f"/api/schaltplan/panels/{panel['id']}/pdf?legend_only=true", headers=_auth(admin_token))
    assert b"Stromlaufplan" not in _pdf_text(legend.content)


# ── Stromkreisliste ─────────────────────────────────────────────────────────


def test_every_legend_header_fits_its_column_at_the_same_total_width() -> None:
    assert sum(width for _key, _title, width in pdf._LEGEND_COLUMNS) == 534
    for key, title, width in pdf._LEGEND_COLUMNS:
        size = pdf._legend_header_size(title, width)
        assert stringWidth(title, FONT_BOLD, size) <= width - 6, (key, title, size)
        assert size >= 6.5, (key, title, size)  # still readable in a dark cellar


@pytest.mark.parametrize(
    "text",
    [
        "Waschmaschine Hauswirtschaftsraum Untergeschoss links neben der Tür",
        "Küchenarbeitsplattensteckdosenleiste",
        "Außenbeleuchtung Terrasse, Garten und Einfahrt mit Bewegungsmelder und Dämmerungsschalter",
        "NYM-J5x2,5mm²-Zuleitung-Unterverteilung-Dachgeschoss",
        # A short word first, then one wider than the column: the second
        # word must be cut too, not let into "Gerät" (review, 2026-10-09).
        "UG Hauswirtschaftsraum",
        "F1 Küchenarbeitsplattensteckdosenleiste und Kühlschrank",
    ],
)
def test_no_wrapped_legend_line_is_wider_than_its_column(text: str) -> None:
    for _key, _title, width in pdf._LEGEND_COLUMNS:
        for line in wrap(text, FONT, 7.5, width - 6, 3):
            assert stringWidth(line, FONT, 7.5) <= width - 6, (width, line)


def test_a_wide_word_after_a_short_one_is_cut_and_marked_not_dropped() -> None:
    lines = wrap("UG Hauswirtschaftsraum", FONT, 7.5, 50, 3)
    assert lines[0] == "UG"
    assert lines[1].startswith("Hauswirt") and lines[1].endswith("…")
    assert all(stringWidth(line, FONT, 7.5) <= 50 for line in lines)
    # Text left over when the lines run out ends in "…", and a line that
    # still has room keeps its last word whole.
    assert wrap("Steckdosen Küche Arbeitsplatte links", FONT, 7.5, 92, 1) == ["Steckdosen Küche…"]
