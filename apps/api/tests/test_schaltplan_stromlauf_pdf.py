"""The Stromlaufplan on the canvas (docs/SCHALTPLAN_STROMLAUF.md §5.4, §6).

The renderer maps the layout and nothing else: every conductor in its colour
(PE and PEN with their 3/3 dashed overlay, control and data dashed), a hop
arc of r 2.2 pt for every crossing, nothing outside the drawing area, every
string at least 6.5 pt, the title strip's texts inside their cells — and the
whole PDF keeps its sheet order and calls ``build_legend`` exactly once."""

from __future__ import annotations

import pytest

from app.models.schaltplan import PanelPlan
from app.services import schaltplan_pdf
from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.schaltplan_pdf_style import (
    CONDUCTOR_COLOURS,
    DRAW_X0,
    DRAW_X1,
    DRAW_Y0,
    DRAW_Y1,
    OVERLAY_DASH,
    STRIP_Y0,
    STRIP_Y1,
    TITLE_STRIP_CELLS,
)
from app.services.schaltplan_stromlauf_layout import Frame, layout_stromlauf
from app.services.schaltplan_stromlauf_model import build_stromlauf_model
from app.services.schaltplan_stromlauf_pdf import draw_stromlauf_sheet_content, draw_stromlauf_sheets
from scripts.enclosure_fixture_boards import meter_dist_zb33s
from tests.pdf_recorder import Recorder
from tests.test_schaltplan import _pdf_text
from tests.test_schaltplan_stromlauf_layout import _board, _two_sources


def _plan(document: dict) -> PanelPlan:
    return PanelPlan(id=1, panel_number="VT-0042", customer_id=1, name="Musterhaus Verteilung", designation="UV1",
                     panel_type="sub", status="draft", revision=3, document=document)


def _layout(document: dict) -> list[dict]:
    return layout_stromlauf(build_stromlauf_model(document), Frame(first_sheet=2))


def _content(sheet: dict) -> Recorder:
    recorder = Recorder()
    draw_stromlauf_sheet_content(recorder, sheet)
    return recorder


@pytest.mark.parametrize("document", [_two_sources(), _board(3, 9, mix=True), _board(2, 6, unknown=True)])
def test_every_conductor_is_stroked_in_its_colour(document: dict) -> None:
    for sheet in _layout(document):
        recorder = _content(sheet)
        lines = [p for p in recorder.primitives if p.kind == "line"]
        strokes = {(p.stroke, p.dash) for p in lines}
        for conductor in {wire["conductor"] for wire in sheet["wires"]}:
            style = CONDUCTOR_COLOURS[conductor]
            assert (style.colour, style.dash or ()) in strokes, conductor
            if style.overlay:
                assert (style.overlay, OVERLAY_DASH) in strokes, conductor
        # PE: every solid green segment has its dashed yellow twin on the same course.
        pe = CONDUCTOR_COLOURS["PE"]
        green = sorted(p.bbox for p in lines if p.stroke == pe.colour and not p.dash)
        yellow = sorted(p.bbox for p in lines if p.stroke == pe.overlay and p.dash == OVERLAY_DASH)
        assert green and green == yellow


def test_a_hop_arc_for_every_crossing_and_a_dot_for_every_junction() -> None:
    sheet = _layout(_board(2, 8, mix=True))[0]
    recorder = _content(sheet)
    arcs = [p for p in recorder.primitives if p.kind == "arc"]
    base_arcs = [p for p in arcs if not p.dash]
    assert len(base_arcs) == len(sheet["hops"]) > 0
    for arc in arcs:
        x0, y0, x1, y1 = arc.bbox
        assert abs((x1 - x0) - 4.4) < 0.01 and abs((y1 - y0) - 4.4) < 0.01
    dots = [p for p in recorder.primitives if p.kind == "circle" and p.fill == "#1c2024"]
    assert len(dots) == len(sheet["dots"])


@pytest.mark.parametrize("document", [_two_sources(), _board(11, 8, mix=True), meter_dist_zb33s()])
def test_nothing_is_drawn_outside_the_drawing_area(document: dict) -> None:
    for sheet in _layout(document):
        for primitive in _content(sheet).primitives:
            x0, y0, x1, y1 = primitive.bbox
            assert DRAW_X0 - 0.6 <= x0 and x1 <= DRAW_X1 + 0.6, primitive
            assert DRAW_Y0 - 0.6 <= y0 and y1 <= DRAW_Y1 + 0.6, primitive
            if primitive.kind == "string":
                assert primitive.size >= 6.5, primitive
                assert "Δ" not in primitive.text  # drawn as a triangle: no standard font has it


def test_the_furniture_title_strip_and_key_fit() -> None:
    document = _board(2, 6, unknown=True)
    sheets = _layout(document)
    recorder = Recorder()
    draw_stromlauf_sheets(recorder, sheets, plan=_plan(document), customer_name="Familie Mustermann-Beispiel",
                          project_label="P-0001 · Neubau mit einem sehr langen Projektnamen am Musterweg",
                          fed_from=None, author="Test", company="Beispiel Elektro GmbH", first_sheet=2, total=5)
    texts = recorder.texts()
    assert "Stromlaufplan allpolig" in texts and "2/5" in texts
    assert "L? = Phase nicht angegeben (12 Stromkreise)" in texts
    assert {"L1 braun", "L2 schwarz", "L3 grau", "N blau", "PE grün-gelb", "PEN grün-gelb/blau"} <= set(texts)
    assert "Punkt = Verbindung · Bogen = Kreuzung ohne Verbindung" in texts
    edges = [DRAW_X0]
    for _label, width in TITLE_STRIP_CELLS:
        edges.append(edges[-1] + width)
    strip = [p for p in recorder.primitives if p.kind == "string" and STRIP_Y0 <= p.bbox[1] <= STRIP_Y1]
    assert strip
    for primitive in strip:
        cell = max(i for i, edge in enumerate(edges[:-1]) if primitive.bbox[0] >= edge - 0.01)
        assert primitive.bbox[2] <= edges[cell + 1] - 2.9, primitive
        assert primitive.size >= 6.5


def test_the_full_pdf_orders_the_sheets_and_calls_the_legend_once(monkeypatch) -> None:
    calls: list[frozenset[str]] = []
    original = schaltplan_pdf.build_legend

    def spy(document, *, terminal_skip=frozenset()):
        calls.append(terminal_skip)
        return original(document, terminal_skip=terminal_skip)

    monkeypatch.setattr(schaltplan_pdf, "build_legend", spy)
    pdf = schaltplan_pdf.build_panel_plan_pdf(plan=_plan(_two_sources()), company_name="Beispiel Elektro GmbH")
    text = _pdf_text(pdf)
    assert calls == [frozenset()]
    order = [text.index(b"bersichtsschaltplan"), text.index(b"Stromlaufplan allpolig"),
             text.index(b"Stromkreisliste / Legende")]
    assert order == sorted(order)
    assert b"Reihenklemmen" not in text


def test_a_cabinet_board_with_its_catalogue_renders() -> None:
    plan = _plan(meter_dist_zb33s())
    pdf = schaltplan_pdf.build_panel_plan_pdf(plan=plan, catalog=builtin_catalog())
    text = _pdf_text(pdf)
    assert b"Stromlaufplan allpolig" in text and b"hinter Q1" in text
    legend = schaltplan_pdf.build_panel_plan_pdf(plan=plan, legend_only=True, catalog=builtin_catalog())
    assert b"Stromlaufplan" not in _pdf_text(legend) and b"bersichtsschaltplan" not in _pdf_text(legend)
