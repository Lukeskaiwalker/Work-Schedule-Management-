from __future__ import annotations
import json
import os
from fastapi.testclient import TestClient
from app.services import report_jobs as report_jobs_service
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}



def test_construction_report_uses_nickname_for_submitted_by(client: TestClient, admin_token: str, monkeypatch):
    set_nickname = client.patch(
        "/api/auth/me",
        headers=auth_headers(admin_token),
        json={"nickname": "ReportAlias"},
    )
    assert set_nickname.status_code == 200

    captured: dict[str, str] = {}

    def fake_build_report_pdf_bytes(
        payload,
        report_date,
        submitted_by,
        project_name=None,
        logo_path=None,
        photos=None,
        company_name=None,
        **_kwargs,
    ):
        _ = payload, report_date, project_name, logo_path, photos, company_name
        captured["pdf_submitted_by"] = submitted_by
        return b"%PDF-1.4 fake"

    def fake_build_report_summary_text(project_id, report_date, payload, submitted_by):
        _ = project_id, report_date, payload
        captured["summary_submitted_by"] = submitted_by
        return "summary"

    monkeypatch.setattr(report_jobs_service, "build_report_pdf_bytes", fake_build_report_pdf_bytes)
    monkeypatch.setattr(report_jobs_service, "build_report_summary_text", fake_build_report_summary_text)

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-4010", "name": "Nickname Report Project", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-02-26",
            "payload": {
                "customer": "Nickname Customer",
                "project_name": "Nickname Report Project",
                "project_number": "2026-4010",
                "workers": [{"name": "Worker A"}],
            },
        },
    )
    assert report.status_code == 200
    assert captured["pdf_submitted_by"] == "ReportAlias"
    assert captured["summary_submitted_by"] == "ReportAlias"

def test_recent_reports_date_range_filter(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-HIST", "name": "History Project", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    def _make(report_date: str) -> None:
        r = client.post(
            f"/api/projects/{project_id}/construction-reports",
            headers=auth_headers(admin_token),
            json={
                "report_date": report_date,
                "payload": {
                    "customer": "History Customer",
                    "project_name": "History Project",
                    "project_number": "2026-HIST",
                    "workers": [{"name": "Worker"}],
                },
            },
        )
        assert r.status_code == 200, r.text

    _make("2026-01-01")  # old visit, and (below) backdated submission → fully outside
    _make("2026-07-10")  # recent visit
    _make("2026-01-15")  # OLD visit but submitted "now" → must still surface

    # Backdate the first report's submission time so it is old by BOTH measures.
    # The other two keep their real (just-now) created_at.
    from datetime import date as _date, datetime as _datetime

    from sqlalchemy import select as _select

    from app.core.db import SessionLocal
    from app.models.entities import ConstructionReport

    with SessionLocal() as db:
        row = db.scalars(
            _select(ConstructionReport).where(ConstructionReport.report_date == _date(2026, 1, 1))
        ).first()
        assert row is not None
        row.created_at = _datetime(2026, 1, 1, 12, 0, 0)
        db.commit()

    # No date params → unchanged behaviour (newest-N by submission returns all).
    all_recent = client.get("/api/construction-reports/recent", headers=auth_headers(admin_token))
    assert all_recent.status_code == 200
    assert {"2026-01-01", "2026-07-10"} <= {row["report_date"] for row in all_recent.json()}

    # since= keeps anything recent by EITHER visit date or submission time.
    windowed = client.get(
        "/api/construction-reports/recent?since=2026-06-01", headers=auth_headers(admin_token)
    )
    assert windowed.status_code == 200
    windowed_dates = [row["report_date"] for row in windowed.json()]
    assert "2026-07-10" in windowed_dates            # recent visit
    assert "2026-01-15" in windowed_dates            # old visit, filed just now
    assert "2026-01-01" not in windowed_dates        # old by both measures

    # until= upper-bounds the window.
    until_q = client.get(
        "/api/construction-reports/recent?until=2026-06-01", headers=auth_headers(admin_token)
    )
    assert until_q.status_code == 200
    until_dates = [row["report_date"] for row in until_q.json()]
    assert "2026-01-01" in until_dates
    assert "2026-07-10" not in until_dates


def test_construction_report_office_material_need_keeps_commas_in_single_item(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-5100",
            "name": "Comma Material Project",
            "status": "active",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-03-01",
            "send_telegram": False,
            "payload": {
                "work_done": "Installed cable route",
                "office_material_need": "NYM-J 5x6, 25m ring",
            },
        },
    )
    assert report.status_code == 200

    material_needs = client.get("/api/materials", headers=auth_headers(admin_token))
    assert material_needs.status_code == 200
    project_entries = [entry for entry in material_needs.json() if entry["project_id"] == project_id]
    assert len(project_entries) == 1
    assert project_entries[0]["item"] == "NYM-J 5x6, 25m ring"


# ── Customer-owned reports (customer first, project optional) ─────────────────


def _make_customer(client: TestClient, admin_token: str, name: str) -> int:
    resp = client.post(
        "/api/customers",
        headers=auth_headers(admin_token),
        json={"name": name, "address": "Hauptstr. 1, 12345 Musterstadt"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _make_project(client: TestClient, admin_token: str, number: str, customer_id: int | None) -> int:
    body: dict = {"project_number": number, "name": f"Project {number}", "status": "active"}
    if customer_id is not None:
        body["customer_id"] = customer_id
    resp = client.post("/api/projects", headers=auth_headers(admin_token), json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _report_payload() -> dict:
    return {"customer": "", "workers": [{"name": "Worker"}]}


def test_report_on_project_derives_customer(client: TestClient, admin_token: str):
    customer_id = _make_customer(client, admin_token, "Derive GmbH")
    project_id = _make_project(client, admin_token, "2026-DERIVE", customer_id)

    created = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={"report_date": "2026-08-01", "payload": _report_payload()},
    )
    assert created.status_code == 200, created.text
    # Customer is inherited from the project even though the client never sent it.
    assert created.json()["customer_id"] == customer_id


def test_report_without_project_stores_customer(client: TestClient, admin_token: str):
    customer_id = _make_customer(client, admin_token, "Direct AG")

    created = client.post(
        "/api/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "customer_id": customer_id,
            "report_date": "2026-08-02",
            "payload": _report_payload(),
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["customer_id"] == customer_id
    assert body["project_id"] is None
    # No project => no per-project sequence number.
    assert body["report_number"] is None


def test_report_customer_project_mismatch_rejected(client: TestClient, admin_token: str):
    customer_a = _make_customer(client, admin_token, "Kunde A")
    customer_b = _make_customer(client, admin_token, "Kunde B")
    project_b = _make_project(client, admin_token, "2026-MISMATCH", customer_b)

    resp = client.post(
        f"/api/projects/{project_b}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "customer_id": customer_a,
            "report_date": "2026-08-03",
            "payload": _report_payload(),
        },
    )
    assert resp.status_code == 400
    assert "does not match" in resp.json()["detail"]


def test_customer_reports_endpoint_unions_direct_and_project_reports(
    client: TestClient, admin_token: str
):
    customer_id = _make_customer(client, admin_token, "Union GmbH")
    project_id = _make_project(client, admin_token, "2026-UNION", customer_id)

    # One report via the project, one filed directly against the customer.
    assert client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={"report_date": "2026-08-04", "payload": _report_payload()},
    ).status_code == 200
    assert client.post(
        "/api/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "customer_id": customer_id,
            "report_date": "2026-08-05",
            "payload": _report_payload(),
        },
    ).status_code == 200

    listing = client.get(
        f"/api/customers/{customer_id}/construction-reports", headers=auth_headers(admin_token)
    )
    assert listing.status_code == 200, listing.text
    rows = listing.json()
    assert len(rows) == 2
    assert {row["report_date"] for row in rows} == {"2026-08-04", "2026-08-05"}
    # Both carry the customer, one carries the project.
    assert all(row["customer_id"] == customer_id for row in rows)
    assert {row["project_id"] for row in rows} == {project_id, None}
    # Newest report_date first.
    assert rows[0]["report_date"] == "2026-08-05"


def test_customer_reports_endpoint_404_for_unknown_customer(client: TestClient, admin_token: str):
    resp = client.get("/api/customers/999999/construction-reports", headers=auth_headers(admin_token))
    assert resp.status_code == 404


# ── Report-born material needs (v2.15) ───────────────────────────────────────
#
# A need written on a building site used to arrive in the office as one string
# — "NYM-J 5x6 - 25 m - ArtNr 11102138" in the `item` column, no quantity, no
# unit, no catalogue link — so every one of them had to be retyped before it
# could be ordered. These pin the parse that makes them orderable as filed.


def _seed_catalog_row(article_no: str, *, name: str, unit: str | None = "m") -> int:
    from app.core.db import SessionLocal
    from app.models.entities import MaterialCatalogItem

    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"report-{article_no}",
            source_file="test.csv",
            source_line=1,
            article_no=article_no,
            item_name=name,
            unit=unit,
            search_text=f"{article_no} {name}".lower(),
        )
        db.add(row)
        db.commit()
        return row.id


def test_report_material_needs_carry_quantity_unit_and_catalog_link(
    client: TestClient, admin_token: str
):
    catalog_id = _seed_catalog_row("11102138", name="NYM-J 5x6", unit="m")
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-5200", "name": "Bedarf aus Bericht", "status": "active"},
    )
    assert project.status_code == 200, project.text
    project_id = project.json()["id"]

    report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-03-02",
            "send_telegram": False,
            "payload": {
                "work_done": "Leitungen gezogen",
                # `note` is what the web puts the form's ART.NR column in
                # (App.tsx: `note: row.article_no.trim()`), a repurposing that
                # predates this parser — so that is what the test sends.
                "materials_needed": [
                    {"item": "NYM-J 5x6", "qty": "25", "unit": "m", "note": "11102138"},
                    {"item": "Kabelbinder", "qty": "1", "unit": "Pack"},
                ],
                # The serialised twin is the only place the article number is.
                "office_material_need": (
                    "NYM-J 5x6 - 25 m - ArtNr 11102138\nKabelbinder - 1 Pack"
                ),
            },
        },
    )
    assert report.status_code == 200, report.text

    needs = client.get("/api/materials", headers=auth_headers(admin_token)).json()
    rows = {row["item"]: row for row in needs if row["project_id"] == project_id}
    assert set(rows) == {"NYM-J 5x6", "Kabelbinder"}

    cable = rows["NYM-J 5x6"]
    assert cable["quantity"] == "25"
    assert cable["unit"] == "m"
    assert cable["article_no"] == "11102138"
    assert cable["material_catalog_item_id"] == catalog_id
    # NOT "11102138": the number is already in `article_no` and in the meta
    # line under the title. Repeating it as the Notiz put a bare number on
    # every report-born row and on every wholesaler order line built from one.
    assert cable["notes"] is None

    # No article number, no link — and that is fine: the row is still a need.
    assert rows["Kabelbinder"]["quantity"] == "1"
    assert rows["Kabelbinder"]["unit"] == "Pack"
    assert rows["Kabelbinder"]["material_catalog_item_id"] is None


def test_report_note_survives_when_it_is_not_the_article_number(
    client: TestClient, admin_token: str
):
    """Only the duplicate is dropped. A note that says something is kept."""

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-5203", "name": "Mit Notiz", "status": "active"},
    )
    project_id = project.json()["id"]

    report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-03-05",
            "send_telegram": False,
            "payload": {
                "materials_needed": [
                    {"item": "Rohr M20", "qty": "12", "unit": "Stk", "note": "für Halle 2"}
                ],
                "office_material_need": "Rohr M20 - 12 Stk - ArtNr UE-77",
            },
        },
    )
    assert report.status_code == 200, report.text

    needs = client.get("/api/materials", headers=auth_headers(admin_token)).json()
    row = next(entry for entry in needs if entry["project_id"] == project_id)
    assert row["article_no"] == "UE-77"
    assert row["notes"] == "für Halle 2"


def test_report_material_needs_fall_back_to_the_serialised_text(
    client: TestClient, admin_token: str
):
    """Older clients send only `office_material_need` — it still has to parse."""

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-5201", "name": "Nur Text", "status": "active"},
    )
    project_id = project.json()["id"]

    report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-03-03",
            "send_telegram": False,
            "payload": {
                "work_done": "Dose gesetzt",
                "office_material_need": "Schalterdose tief - 10 Stk - ArtNr XY-9",
            },
        },
    )
    assert report.status_code == 200, report.text

    needs = client.get("/api/materials", headers=auth_headers(admin_token)).json()
    row = next(entry for entry in needs if entry["project_id"] == project_id)
    assert row["item"] == "Schalterdose tief"
    assert row["quantity"] == "10"
    assert row["unit"] == "Stk"
    assert row["article_no"] == "XY-9"


def test_report_material_needs_are_born_ready_to_order(client: TestClient, admin_token: str):
    """The point of the parse: the row can go straight into a Bestellung."""

    supplier = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(admin_token), json={"name": "Unielektro"}
    )
    assert supplier.status_code == 200, supplier.text
    supplier_id = supplier.json()["id"]

    from app.core.db import SessionLocal
    from app.models.entities import MaterialCatalogItem

    with SessionLocal() as db:
        catalog_row = MaterialCatalogItem(
            external_key="report-order-UE-77",
            source_file="test.csv",
            source_line=1,
            article_no="UE-77",
            item_name="Rohr M20",
            unit="Stk",
            supplier_id=supplier_id,
            search_text="ue-77 rohr m20",
        )
        db.add(catalog_row)
        db.commit()

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-5202", "name": "Direkt bestellbar", "status": "active"},
    )
    project_id = project.json()["id"]

    report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-03-04",
            "send_telegram": False,
            "payload": {
                "materials_needed": [{"item": "Rohr M20", "qty": "12", "unit": "Stk"}],
                "office_material_need": "Rohr M20 - 12 Stk - ArtNr UE-77",
            },
        },
    )
    assert report.status_code == 200, report.text

    rows = client.get("/api/werkstatt/bedarfe", headers=auth_headers(admin_token)).json()
    need = next(row for row in rows if row["project_id"] == project_id)
    assert need["orderable"] is True
    assert need["source"] == "report"

    ordered = client.post(
        "/api/werkstatt/bedarfe/create-order",
        headers=auth_headers(admin_token),
        json={"need_ids": [need["id"]]},
    )
    assert ordered.status_code == 200, ordered.text
    line = ordered.json()["orders"][0]["lines"][0]
    assert line["supplier_article_no"] == "UE-77"
    assert line["quantity_ordered"] == 12
