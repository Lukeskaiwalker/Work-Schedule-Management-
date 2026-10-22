"""The "Aufbau" PDF: the cabinet front at a real scale, then the Materialliste.

docs/PANEL_ENCLOSURE.md §13. Page 1 is A4 landscape with the open front view
at the largest of 1:5, 1:8, 1:10, 1:15, 1:20 that fits a 180 × 180 mm box —
never an arbitrary shrink, so a fitter can measure off the paper — and a
right column that stops with "… und {n} weitere" instead of running off the
sheet. The Materialliste pages follow, portrait, as their own PDF prints them.
"""

from __future__ import annotations

import re
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.schaltplan import PanelPlan
from app.schemas.schaltplan import PanelMaterialArticleOut, PanelMaterialLineOut, PanelMaterialOut, PanelMaterialPanelOut
from app.services.panel_enclosure_catalog import builtin_catalog
from app.services.panel_enclosure_pdf import MM, build_aufbau_pdf, pick_scale
from app.services.schaltplan_material_pdf import build_material_pdf
from scripts.write_enclosure_fixtures import meter_dist_zb33s, violations_zb34s
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
    assert len(pages) == 1 + len(_pages(material.content))
    width, height = pages[0]
    assert width > height  # landscape
    assert all(w < h for w, h in pages[1:])  # the Materialliste stays portrait
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
