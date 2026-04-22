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
