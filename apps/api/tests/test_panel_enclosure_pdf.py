"""The "Aufbau" PDF: the cabinet front at a real scale, then the Materialliste.

docs/PANEL_ENCLOSURE.md §13. Page 1 is A4 landscape with the open front view
at the largest of 1:5, 1:8, 1:10, 1:15, 1:20 that fits a 180 × 180 mm box —
never an arbitrary shrink, so a fitter can measure off the paper — and a
right column that stops with "… und {n} weitere" instead of running off the
sheet. The Materialliste pages follow, portrait, as their own PDF prints them.
"""

from __future__ import annotations

import copy
import re
from datetime import datetime
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen.canvas import Canvas

from app.core.db import SessionLocal
from app.models.schaltplan import PanelPlan
from app.schemas.schaltplan import PanelMaterialArticleOut, PanelMaterialLineOut, PanelMaterialOut, PanelMaterialPanelOut
from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.panel_enclosure_pdf import MM, _draw_front, _fill, _stroke, build_aufbau_pdf, pick_scale
from app.services.panel_enclosure_pdf_control import control_page, with_control_page
from app.services.panel_enclosure_pdf_terminal_sheet import LayoutPage
from app.services.panel_enclosure_pdf_terminals import closeup_layout, draw_terminal_closeup_pages
from app.services.panel_enclosure_terminal_closeup import terminal_closeup
from app.services.panel_enclosure_terminals import place_terminals
from app.services.schaltplan_material_pdf import build_material_pdf
from app.services.panel_enclosure_prep import cabinet_prep
from scripts import enclosure_fixture_boards as fixture_boards
from scripts.write_enclosure_fixtures import (
    busbar_gap_zb34s,
    control_3p_zb53s,
    control_ehz_zb33s,
    document as board,
    fi,
    ls,
    meter_dist_zb33s,
    module,
    row,
    terminals_rk_zb53s,
    terminals_zb34s,
    violations_zb34s,
)
from tests.panel_enclosure_helpers import auth, create_panel, employee, hidden_project
from tests.pdf_recorder import Recorder
from tests.test_schaltplan import _pdf_text

BOX = 180 * MM


def _pages(pdf: bytes) -> list[tuple[float, float]]:
    """(width, height) of every page, in page order."""
    return [(float(w), float(h)) for w, h in re.findall(rb"/MediaBox \[\s*0 0 ([\d.]+) ([\d.]+)\s*\]", pdf)]


def _material(lines: list[PanelMaterialLineOut], **totals) -> PanelMaterialOut:
    panel = PanelMaterialPanelOut(id=1, panel_number="VT-0042", designation="ZS1", name="Zählerschrank Haus A",
                                  panel_type="meter", status="draft", customer_id=1, updated_at=datetime(2026, 10, 21))
    return PanelMaterialOut(panel=panel, lines=lines, **totals)


# ── the scale ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("width", "height", "scale"),
    [(1300, 1400, 8), (550, 1100, 8), (600, 600, 5), (900, 900, 5), (901, 600, 8), (4000, 4000, 20), (3000, 200, 20)],
)
def test_the_largest_standard_scale_that_fits(width: int, height: int, scale: int) -> None:
    assert pick_scale(width, height, BOX, BOX) == scale


def test_every_shipped_cabinet_prints_at_1_to_8() -> None:
    for entry in builtin_catalog().entries.values():
        if entry.entry_type == "enclosure":
            assert pick_scale(entry.spec["width_mm"], entry.spec["height_mm"], BOX, BOX) == 8, entry.code


# ── the route ────────────────────────────────────────────────────────────────


def test_the_aufbau_pdf_is_a_landscape_sheet_and_the_materialliste(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token, meter_dist_zb33s())
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/aufbau/pdf", headers=auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "application/pdf"
    disposition = resp.headers["content-disposition"]
    assert disposition.startswith("inline") and f"Aufbau_{panel['panel_number']}_" in disposition
    pages = _pages(resp.content)
    material = client.get(f"/api/schaltplan/panels/{panel['id']}/material/pdf", headers=auth(admin_token))
    # Page 1, one close-up page per field with placed terminals (Feld 2 and 3,
    # no text shortened, so no legend page), then the Materialliste.
    assert len(pages) == 1 + 2 + len(_pages(material.content))
    assert all(w > h for w, h in pages[:3])  # landscape: the front view and the close-ups
    assert all(w < h for w, h in pages[3:])  # the Materialliste stays portrait
    text = _pdf_text(resp.content)
    assert b"stab 1:8" in text  # "Maßstab 1:8"
    for word in (panel["panel_number"].encode(), b"ZB33S", b"ZH3EH16", b"Q0", b"1XYZ0000000001", b"Materialliste"):
        assert word in text, word


def test_a_board_without_a_cabinet_has_no_aufbau(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token)
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/aufbau/pdf", headers=auth(admin_token))
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Für diesen Verteiler ist kein Schrank geplant."
    assert client.get("/api/schaltplan/panels/99999/aufbau/pdf", headers=auth(admin_token)).status_code == 404


def test_the_aufbau_follows_the_plan_s_visibility(client: TestClient, admin_token: str) -> None:
    # The login first: a new login joins the projects that already exist.
    fitter = employee(client, admin_token, "monteur.aufbau@example.com")
    panel = create_panel(client, admin_token, meter_dist_zb33s(), project_id=hidden_project())
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/aufbau/pdf", headers=auth(fitter))
    assert resp.status_code in (403, 404)
    assert client.get(f"/api/schaltplan/panels/{panel['id']}/aufbau/pdf", headers=auth(admin_token)).status_code == 200


def test_an_unknown_cabinet_still_prints_with_a_note(client: TestClient, admin_token: str) -> None:
    panel = create_panel(client, admin_token, meter_dist_zb33s())
    with SessionLocal() as db:
        plan = db.get(PanelPlan, panel["id"])
        plan.document = {**plan.document, "enclosure": {**plan.document["enclosure"], "code": "ZX00CAB"}}
        db.commit()
    resp = client.get(f"/api/schaltplan/panels/{panel['id']}/aufbau/pdf", headers=auth(admin_token))
    assert resp.status_code == 200, resp.text
    assert b"ZX00CAB" in _pdf_text(resp.content)


# ── the right column ─────────────────────────────────────────────────────────


def _aufbau(document: dict, findings: list[dict], material: PanelMaterialOut | None = None) -> bytes:
    plan = PanelPlan(id=1, panel_number="VT-0042", customer_id=1, name="Zählerschrank Haus A", designation="ZS1",
                     panel_type="meter", status="draft", revision=3, document=document)
    return build_aufbau_pdf(plan=plan, catalog=builtin_catalog(), material=material or _material([]),
                            findings=findings, customer_name="Familie Beispiel", project_label="P-1 · Neubau",
                            company_name="Beispiel Elektro")


def test_a_long_findings_list_stops_at_the_column_bottom() -> None:
    findings = [{"level": "warn", "scope": "", "message": f"Hinweis Nummer {i} zum Schrank", "rule": "vde.x"}
                for i in range(60)]
    text = _pdf_text(_aufbau(meter_dist_zb33s(), findings))
    assert b"Hinweis Nummer 0 " in text
    match = re.search(rb"und (\d+) weitere", text)
    assert match is not None and 0 < int(match.group(1)) < 60
    # The full list follows on the Materialliste's last page.
    assert b"Hinweis Nummer 59 " in text


def test_only_warnings_reach_the_hint_list() -> None:
    findings = [{"level": "info", "scope": "", "message": "Nur eine Info", "rule": "encl.field_gap"},
                {"level": "warn", "scope": "", "message": "Eine Warnung", "rule": "vde.apz_missing"}]
    text = _pdf_text(_aufbau(violations_zb34s(), findings))
    assert b"Eine Warnung" in text
    assert b"Nur eine Info" not in text


def test_removed_parts_are_listed_from_the_materialliste() -> None:
    removed = PanelMaterialLineOut(key="removed:ZH3EH16:hs", kind="removed", label="Hauptschalter",
                                   detail="aus Modul entfernt → ins Lager · ZH3EH16", planned=1, status="open")
    text = _pdf_text(_aufbau(meter_dist_zb33s(), [], _material([removed], returns_open=1)))
    assert b"Aus Modulen entfernt" in text and b"Hauptschalter" in text


# ── the Materialliste pages (shared with its own PDF) ────────────────────────


def test_the_materialliste_prints_cabinet_lines_and_a_returns_block() -> None:
    article = PanelMaterialArticleOut(id=7, article_number="SP-0007", item_name="Hager Hauptschalter 3-polig")
    lines = [
        PanelMaterialLineOut(key="enclosure:ZB33S", kind="enclosure", label="Zählerschrank univers Z",
                             detail="Hager ZB33S · 1100 × 800 × 205 mm · 3 Felder", planned=1, status="open"),
        PanelMaterialLineOut(key="device:mcb:1p:b16", kind="device", label="Leitungsschutzschalter (LS) B16",
                             planned=4, status="open"),
        PanelMaterialLineOut(key="removed:ZH3EH16:hs", kind="removed", label="Hauptschalter",
                             detail="aus Modul entfernt → ins Lager · ZH3EH16", planned=1, scanned=1, status="done",
                             article=article),
        PanelMaterialLineOut(key="salvage:9", kind="removed", label="HLAK",
                             detail="eingelagert, im Plan nicht mehr als entfernt geführt", planned=0, scanned=1,
                             status="unplanned"),
    ]
    text = _pdf_text(build_material_pdf(material=_material(lines, planned_total=5, open_lines=2, returns_open=0),
                                        company_name="Beispiel Elektro"))
    assert b"Schrank/Modul" in text
    assert b"Aus Modulen entfernt" in text
    # "eingelagert" for the booked return; "zu viel eingelagert" wraps in the status column.
    assert text.count(b"(eingelagert)") == 2 and b"(zu viel)" in text
    # Returns are not picks: the block comes after every planned line.
    assert text.index(b"Aus Modulen entfernt") > text.index(b"Leitungsschutzschalter")
    assert b"Freitext" not in text


def test_open_returns_are_named_in_the_summary() -> None:
    removed = PanelMaterialLineOut(key="removed:ZH3EH16:hs", kind="removed", label="Hauptschalter", planned=2,
                                   status="open")
    text = _pdf_text(build_material_pdf(material=_material([removed], returns_open=2), company_name=None))
    assert b"2 \\327 ins Lager offen" in text or "2 × ins Lager offen".encode("cp1252") in text


# ── the WAGO close-up pages (docs/PANEL_ENCLOSURE_R2.md §7.3) ────────────────

CATALOG = builtin_catalog()
LONG_LABEL = "Steckdosen Küche Arbeitsplatte links neben der Spüle und am Fenster"


class _Recorder(Canvas):
    """A canvas that remembers every string it draws (text, font, size) and every rectangle."""

    def __init__(self) -> None:
        super().__init__(BytesIO(), pagesize=landscape(A4))
        self.strings: list[tuple[str, str, float]] = []
        self.rects: list[tuple[float, float, float, float]] = []

    def _note(self, text: str) -> None:
        self.strings.append((text, self._fontname, self._fontsize))

    def drawString(self, x, y, text, *args, **kwargs):  # noqa: N802 (reportlab's name)
        self._note(text)
        return super().drawString(x, y, text, *args, **kwargs)

    def drawCentredString(self, x, y, text, *args, **kwargs):  # noqa: N802
        self._note(text)
        return super().drawCentredString(x, y, text, *args, **kwargs)

    def drawRightString(self, x, y, text, *args, **kwargs):  # noqa: N802
        self._note(text)
        return super().drawRightString(x, y, text, *args, **kwargs)

    def rect(self, x, y, width, height, *args, **kwargs):
        self.rects.append((x, y, width, height))
        return super().rect(x, y, width, height, *args, **kwargs)


def _plan(document: dict) -> PanelPlan:
    return PanelPlan(id=1, panel_number="VT-0042", customer_id=1, name="Zählerschrank Haus A", designation="ZS1",
                     panel_type="meter", status="draft", revision=3, document=document)


def _drawn(document: dict) -> tuple[_Recorder, int, list]:
    closeup = terminal_closeup(document, CATALOG)
    recorder = _Recorder()
    pages = draw_terminal_closeup_pages(recorder, plan=_plan(document), closeup=closeup,
                                        company_name="Beispiel Elektro")
    return recorder, pages, closeup_layout(closeup, plan=_plan(document), company_name="Beispiel Elektro")


def _ten_strips_with_long_labels() -> dict:
    """Ten FI groups of two LS with long names in one ZU37KS: ten strips on its two terminal rails."""
    groups = [
        [fi(f"dev-f{g}", f"F{g}"),
         *(ls(f"dev-f{g}-{k}", f"F{g}.{k}", str(2 * g + k), f"{LONG_LABEL} {g}.{k}", terminal_block=True)
           for k in (1, 2))]
        for g in range(1, 11)
    ]
    rows = [row(f"row-r{rail}", f"F1 · Verteiler {rail}", [*groups[2 * i], *groups[2 * i + 1]])
            for i, rail in enumerate(range(3, 8))]
    modules = [module("mod-v", "ZU37KS", 0, {f"r{rail}": f"row-r{rail}" for rail in range(3, 8)}),
               module("mod-w", "ZU37KS", 1, {})]
    return board("ZB32S", modules, rows)


def test_a_close_up_page_per_field_names_it_and_carries_markers_scale_and_the_control_measure() -> None:
    recorder, pages, layout = _drawn(meter_dist_zb33s())
    texts = [text for text, _, _ in recorder.strings]
    assert pages == len(layout) == 2  # Feld 2 and Feld 3 hold strips; nothing shortened, no legend
    assert [page.field for page in layout] == [1, 2] and not any(page.legend for page in layout)
    assert "Reihenklemmen · Feld 2 · VT-0042 Zählerschrank Haus A" in texts
    assert "Reihenklemmen · Feld 3 · VT-0042 Zählerschrank Haus A" in texts
    assert texts.count("Maßstab 1:1 (Breite) — zum Anlegen an die Hutschiene") == 2
    assert texts.count("Kontrollmaß 100 mm") == 2
    for marker in ("X1", "1.1", "1.2", "X2", "2.1", "F1.1 · Licht EG · Nr. 1", "NYM-J 3x2,5 mm²"):
        assert marker in texts, marker
    heading = next(text for text in texts if text.startswith("Hutschiene 1 · F2 · Verteiler 1"))
    assert "U84T: 1 Satz" in heading and "Abschlussplatte 2003-7692" in heading
    # 1:1 across: the rail outline is the rail's usable length, the bar 100 mm.
    widths = [width for _, _, width, _ in recorder.rects]
    assert any(abs(width - 210 * 72 / 25.4) < 0.01 for width in widths)
    assert any(abs(width - 100 * MM) < 0.01 for width in widths)


def test_no_string_on_a_close_up_page_is_wider_than_its_cell() -> None:
    for document in (_ten_strips_with_long_labels(), terminals_zb34s(), terminals_rk_zb53s()):
        recorder, _, layout = _drawn(document)
        # Every string drawn is a laid-out text, in order: nothing bypasses its cell.
        assert recorder.strings == [(text.text, text.font, text.size) for page in layout for text in page.texts]
        for page in layout:
            for text in page.texts:
                length, cross = (text.h, text.w) if text.rotated else (text.w, text.h)
                assert text.text and stringWidth(text.text, text.font, text.size) <= length + 0.01, text
                assert text.size <= cross + 0.01, text


def test_a_shortened_text_gets_a_legend_page_with_the_full_texts() -> None:
    document = _ten_strips_with_long_labels()
    _, pages, layout = _drawn(document)
    assert [(page.field, page.legend) for page in layout] == [(0, False), (0, True)]
    assert pages == 2
    field_page, legend = layout
    assert field_page.shortened and any(text.truncated for text in field_page.texts)
    legend_texts = [text.text for text in legend.texts]
    assert "Reihenklemmen · Feld 1 · Legende" in legend_texts
    # The für text in full (wrapped over lines, never cut).
    joined = " ".join(legend_texts)
    assert f"{LONG_LABEL} 10.2" in joined and "X10" in legend_texts and "10.2" in legend_texts


def test_unplaced_strips_and_devices_on_a_reserved_rail_are_on_the_page() -> None:
    recorder, _, layout = _drawn(terminals_zb34s())
    texts = [text for text, _, _ in recorder.strings]
    assert [page.field for page in layout if not page.legend] == [1, 3]  # the empty RK field gets no page
    assert "Ohne Platz: X4 (FI F4), X5 (FI F5), X6 (FI F6)" in texts
    assert "F1.4" in texts  # the LS still on the reserved rail, drawn before the strips
    rk = [text for text, _, _ in _drawn(terminals_rk_zb53s())[0].strings]
    assert any(text.startswith("Hutschiene 1 · F2 · Verteiler 1") and "U84T ab Werk" in text for text in rk)


def test_a_long_unplaced_list_is_cut_off_with_a_count() -> None:
    document = terminals_zb34s()
    closeup = copy.deepcopy(terminal_closeup(document, CATALOG))
    field = next(entry for entry in closeup if entry["field"] == 1)
    field["unplaced"] = [{"stripId": f"s{i}", "xLabel": f"X{i}", "title": f"X{i} · FI F{i} · {LONG_LABEL}",
                          "widthMm": 61.1} for i in range(100, 160)]
    layout = closeup_layout(closeup, plan=_plan(document))
    footer = next(text.text for page in layout for text in page.texts if text.text.startswith("Ohne Platz:"))
    match = re.search(r"… und (\d+) weitere$", footer)
    assert match is not None and 0 < int(match.group(1)) < 60


def test_a_board_without_placed_terminals_gets_no_close_up_page() -> None:
    recorder, pages, layout = _drawn(violations_zb34s())
    assert (pages, layout, recorder.strings) == (0, [], [])
    plain = _pages(_aufbau(violations_zb34s(), []))
    material = _pages(build_material_pdf(material=_material([]), company_name="Beispiel Elektro"))
    assert len(plain) == 1 + len(material)


def test_the_front_view_draws_strips_and_terminal_rails_in_the_schrank_tab_s_colours() -> None:
    # R2 §8: the 2D drawing (EnclosureFrontBoxes, schaltplan-enclosure-terminals.css) draws a placed
    # strip in WAGO grey (--sp-term-grey) with a dark outline (--sp-term-outline), and tints a rail
    # reserved for terminals orange (--sp-term-reserved under its hatch). The sheet takes the same
    # colours, the tint as one opaque print colour; every other rail stays grey.
    assert _fill("terminal_strip", set(), "VT") == colors.HexColor("#c9ced4")
    assert _stroke("terminal_strip", set()) == colors.HexColor("#2d3a48")
    assert _fill("rail", {"terminals"}, "VT") == colors.HexColor("#f8d6b7")
    assert _fill("rail", set(), "VT") == colors.HexColor("#9ca3af")


# ── Round 4: the §14a page and the runs (docs/PANEL_ENCLOSURE_R4.md §9.4, §5) ──

CONTROL_TITLE = "§14a-Klemmleiste · Feld 1 · VT-0042 Zählerschrank Haus A"


def _texts(page: LayoutPage) -> list[str]:
    return [text.text for text in page.texts]


def _page(field: int, legend: bool = False) -> LayoutPage:
    return LayoutPage(field, legend, (), (), False)


def test_the_control_page_draws_the_block_1_to_1_with_rotated_markers_and_a_table() -> None:
    document = control_ehz_zb33s()
    page = control_page(document, CATALOG, plan=_plan(document), company_name="Beispiel Elektro")
    assert page is not None and page.field == 0 and not page.legend
    texts = _texts(page)
    for expected in (CONTROL_TITLE, "Maßstab 1:1 (Breite) — zum Anlegen an die Hutschiene", "Kontrollmaß 100 mm",
                     "Klemme", "Bezeichnung", "Aderfarbe", "Ziel", "Lüsterklemme",
                     "Aderbeschriftung: WAGO 211-502 (Ø 4,8 mm), jede Bezeichnung zweimal"):
        assert expected in texts, expected
    # Each 2002-1671 carries its marker, turned to read bottom → top, at 6 pt down to 5 pt.
    markers = [text for text in page.texts if text.text in ("UNSM", "60%", "30%", "0%", "UStve", "Stve")
               and text.rotated]
    assert [text.text for text in markers] == ["UNSM", "60%", "30%", "0%", "UStve", "Stve"]
    assert all(5.0 <= text.size <= 6.0 for text in markers)
    assert texts.count("RfZ Feld 1") == 6
    assert [f"Pol {i}" in texts for i in range(1, 7)] == [True] * 6 and "Pol 7" not in texts
    assert "Braun" in texts and "Weiß" in texts
    # 1:1 across: the rail's 210 mm, the block right-aligned at 165,8 mm, every part at its width.
    widths = [round(shape.w / MM, 1) for shape in page.shapes]
    assert 210.0 in widths and 100.0 in widths
    assert widths.count(5.2) >= 6 and widths.count(6.0) >= 2 and 1.0 in widths
    first_stop = min(shape.x for shape in page.shapes if round(shape.w / MM, 1) == 6.0)
    assert abs(first_stop - (12 * MM + 165.8 * MM)) < 0.01


def test_a_renamed_3_punkt_block_names_the_apz_and_the_thin_tube() -> None:
    document = control_3p_zb53s()
    page = control_page(document, CATALOG, plan=_plan(document))
    assert page is not None
    texts = _texts(page)
    assert "P60" in texts and "0%" not in texts
    assert texts.count("APZ Feld 3") == 5 and texts.count("Braun") == 2
    assert "Aderbeschriftung: WAGO 211-501 (Ø 3,2 mm), jede Bezeichnung zweimal" in texts


def test_no_block_no_page_and_no_target_no_pole() -> None:
    assert control_page(meter_dist_zb33s(), CATALOG, plan=_plan(meter_dist_zb33s())) is None
    switched_off = control_ehz_zb33s()
    switched_off["enclosure"]["control_block"]["off"] = True
    assert control_page(switched_off, CATALOG, plan=_plan(switched_off)) is None
    # Without the RfZ module the wires have no target: the table says so, no Lüsterklemme.
    no_target = control_3p_zb53s()
    no_target["enclosure"]["modules"] = [m for m in no_target["enclosure"]["modules"] if m["code"] != "ZU59VT7APZ2"]
    page = control_page(no_target, CATALOG, plan=_plan(no_target))
    assert page is not None
    texts = _texts(page)
    assert not any(text.startswith("Pol ") for text in texts) and "APZ Feld 3" not in texts


def test_no_string_on_the_control_page_is_wider_than_its_cell() -> None:
    long_labels = control_ehz_zb33s()
    for terminal in long_labels["enclosure"]["control_block"]["terminals"]:
        terminal["label"] = "Wärmepumpe12"  # twelve code points, the most a label may have
    for document in (control_ehz_zb33s(), control_3p_zb53s(), long_labels):
        page = control_page(document, CATALOG, plan=_plan(document))
        assert page is not None
        for text in page.texts:
            length, cross = (text.h, text.w) if text.rotated else (text.w, text.h)
            assert text.text and stringWidth(text.text, text.font, text.size) <= length + 0.01, text
            assert text.size <= cross + 0.01, text


def test_the_control_page_follows_its_field_s_close_up_and_legend_else_page_1() -> None:
    control = _page(1)
    assert with_control_page([_page(0), _page(1), _page(1, True), _page(2)], control) == [
        _page(0), _page(1), _page(1, True), control, _page(2)]
    assert with_control_page([_page(1), _page(2)], _page(0)) == [_page(0), _page(1), _page(2)]
    assert with_control_page([_page(2)], None) == [_page(2)]
    assert with_control_page([], control) == [control]


def test_the_aufbau_of_a_board_with_a_block_has_the_control_page() -> None:
    material = _pages(build_material_pdf(material=_material([]), company_name="Beispiel Elektro"))
    pages = _pages(_aufbau(control_ehz_zb33s(), []))
    # Page 1, the §14a page (its field has no close-up), Feld 3's close-up, the Materialliste.
    assert len(pages) == 1 + 1 + 1 + len(material)
    assert all(w > h for w, h in pages[:3])
    text = _pdf_text(_aufbau(control_ehz_zb33s(), []))
    assert b"Klemmleiste \\267 Feld 1" in text or "Klemmleiste · Feld 1".encode("cp1252") in text
    assert len(_pages(_aufbau(busbar_gap_zb34s(), []))) == 1 + 1 + len(material)  # no block, no page


def test_the_front_view_draws_the_block_and_the_runs_dashed_with_their_labels() -> None:
    document = control_ehz_zb33s()
    recorder = Recorder()
    _draw_front(recorder, document, CATALOG, place_terminals(document, CATALOG))
    texts = recorder.texts()
    for label in ("§14a", "ZY3N2SA · SABO 1,6 A → RfZ", "ZY3N2SA · SABO 1,6 A → APZ", "ZZ45WAN100 · RJ45",
                  "6 × H07V-K 2,5 mm²"):
        assert label in texts, label
    lines = [p for p in recorder.primitives if p.kind == "line"]
    styles = {(p.stroke, p.dash) for p in lines}
    assert ("#7547c9", (6.0, 4.0)) in styles and ("#0f8b8d", (4.0, 3.0)) in styles
    assert any(dash == (2.0, 2.0) for _, dash in styles)
    assert _fill("control_block", set(), "AAR") == colors.HexColor("#b9c0c8")
    # A switched-off network lead is not drawn.
    gap = Recorder()
    _draw_front(gap, busbar_gap_zb34s(), CATALOG, place_terminals(busbar_gap_zb34s(), CATALOG))
    assert not any("RJ45" in text for text in gap.texts())
    assert "ZY3N2LS · LS 6 A → RfZ" in gap.texts()


def _overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] < b[2] - 0.2 and b[0] < a[2] - 0.2 and a[1] < b[3] - 0.2 and b[1] < a[3] - 0.2


@pytest.mark.parametrize("name", sorted(fixture_boards.BOARDS))
def test_a_run_label_never_covers_another_text_of_the_front_view(name: str) -> None:
    """Slice D's render review: "ZY3N2SA · SABO 1,6 A → RfZ" sat on the meter number
    and "… → APZ" on the SLS's BMK. A label follows its segment (turned 90° on a
    vertical one) and moves along the run until it covers no box label and no other run label."""
    document = fixture_boards.BOARDS[name]()
    prep = cabinet_prep(document, CATALOG)
    labels = {run["label"] for run in (prep["runs"] if prep is not None else [])}
    recorder = Recorder()
    _draw_front(recorder, document, CATALOG, place_terminals(document, CATALOG))
    strings = [p for p in recorder.primitives if p.kind == "string"]
    run_labels = [p for p in strings if p.text in labels]
    assert {p.text for p in run_labels} == labels
    for label in run_labels:
        for other in strings:
            if other is not label:
                assert not _overlaps(label.bbox, other.bbox), (label.text, other.text)


def _front(name: str) -> tuple[list, set[str]]:
    document = fixture_boards.BOARDS[name]()
    prep = cabinet_prep(document, CATALOG)
    recorder = Recorder()
    _draw_front(recorder, document, CATALOG, place_terminals(document, CATALOG))
    return recorder.primitives, {run["label"] for run in (prep["runs"] if prep is not None else [])}


def _covers(outer: tuple[float, float, float, float], inner: tuple[float, float, float, float]) -> bool:
    return (outer[0] <= inner[0] + 0.3 and outer[1] <= inner[1] + 0.3
            and outer[2] >= inner[2] - 0.3 and outer[3] >= inner[3] - 0.3)


@pytest.mark.parametrize("name", sorted(fixture_boards.BOARDS))
def test_a_run_line_never_strikes_through_a_box_label(name: str) -> None:
    """Review 2: the 3-Punkt meter number and the SLS's BMK were struck through by
    the supply and network leads. Every box label a lead crosses sits on its own
    knock-out, drawn after the leads and before the text."""
    primitives, run_labels = _front(name)
    lines = [i for i, p in enumerate(primitives) if p.kind == "line"]
    if not lines:
        return
    last_line = max(lines)
    for j, text in enumerate(primitives):
        if text.kind != "string" or text.text in run_labels or j < last_line:
            continue
        if not any(_overlaps(primitives[i].bbox, text.bbox) for i in lines):
            continue
        grounds = [p for p in primitives[last_line:j] if p.kind == "rect" and _covers(p.bbox, text.bbox)]
        assert grounds, (name, text.text)


@pytest.mark.parametrize("name", sorted(fixture_boards.BOARDS))
def test_leads_of_different_kinds_never_share_a_line(name: str) -> None:
    """The §14a control run and the SABO → APZ supply shared 147 pt of the NAR;
    network and control 29 pt on the RfZ rail. Each kind runs on its own offset."""
    primitives, _ = _front(name)
    lines = [p for p in primitives if p.kind == "line"]
    for a in lines:
        for b in lines:
            if (a.stroke, a.dash) == (b.stroke, b.dash):
                continue
            horizontal = a.bbox[3] - a.bbox[1] < 0.1 and b.bbox[3] - b.bbox[1] < 0.1
            vertical = a.bbox[2] - a.bbox[0] < 0.1 and b.bbox[2] - b.bbox[0] < 0.1
            if horizontal and abs(a.bbox[1] - b.bbox[1]) < 0.5:
                assert min(a.bbox[2], b.bbox[2]) - max(a.bbox[0], b.bbox[0]) <= 1.0, name
            if vertical and abs(a.bbox[0] - b.bbox[0]) < 0.5:
                assert min(a.bbox[3], b.bbox[3]) - max(a.bbox[1], b.bbox[1]) <= 1.0, name
