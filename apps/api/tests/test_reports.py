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
