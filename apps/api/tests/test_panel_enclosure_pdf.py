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
from app.services.panel_enclosure_pdf import MM, _fill, _stroke, build_aufbau_pdf, pick_scale
from app.services.panel_enclosure_pdf_terminals import closeup_layout, draw_terminal_closeup_pages
from app.services.panel_enclosure_terminal_closeup import terminal_closeup
from app.services.schaltplan_material_pdf import build_material_pdf
from scripts.write_enclosure_fixtures import (
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
