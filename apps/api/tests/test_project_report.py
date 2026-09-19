"""The Projektbericht — ``/projects/{id}/report`` and its preview.

What must hold: the collection reads every section of the project in the
order the report prints it; the rendering is a PDF with at least one page;
the preview is served inline with the file-preview hardening and saves
under its name on ``?download=1``; the paged preview answers a count and a
PNG; an employee without project access gets 403 everywhere; a manager can
file the report by hand, which stores it in Berichte and moves the pointer;
an employee cannot; marking the project abgeschlossen files it once — the
move on to the archive does not file a second one, re-opening and finishing
again does; and a rendering failure never costs the status change.
"""

from __future__ import annotations

import shutil
import subprocess
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import Project
from app.services.pdf_preview import PdfPreviewUnavailable, pdf_page_count
from app.services.project_report_data import collect_project_report_data
from app.services.project_report_pdf import build_project_report_filename, render_project_report_pdf
from tests.conftest import auth_headers

PASSWORD = "Password123!"


def _create_user(client: TestClient, admin_token: str, email: str, role: str, full_name: str) -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": PASSWORD, "full_name": full_name, "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _create_customer(client: TestClient, admin_token: str, name: str) -> int:
    response = client.post(
        "/api/customers",
        headers=auth_headers(admin_token),
        json={"name": name, "address": "Hauptstr. 1, 12345 Musterstadt", "contact_person": "Frau Muster", "email": "muster@example.com", "phone": "0123 456"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create_project(client: TestClient, admin_token: str, number: str, *, customer_id: int | None = None, status: str = "in_durchfuehrung") -> int:
    body: dict = {"project_number": number, "name": f"Bericht {number}", "status": status, "construction_site_address": "Baustelle 7, 12345 Musterstadt"}
    if customer_id is not None:
        body["customer_id"] = customer_id
    response = client.post("/api/projects", headers=auth_headers(admin_token), json=body)
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _set_status(client: TestClient, admin_token: str, project_id: int, status: str) -> dict:
    response = client.patch(f"/api/projects/{project_id}", headers=auth_headers(admin_token), json={"status": status})
    assert response.status_code == 200, response.text
    return response.json()


def _add_member(client: TestClient, admin_token: str, project_id: int, user_id: int, *, can_manage: bool) -> None:
    response = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        json={"user_id": user_id, "can_manage": can_manage},
    )
    assert response.status_code == 200, response.text


def _remove_membership(client: TestClient, admin_token: str, project_id: int, user_id: int) -> None:
    # Everyone is on every project by default, so "no access" is made on
    # purpose — the same way test_webdav hides a project.
    removed = client.delete(f"/api/projects/{project_id}/members/{user_id}", headers=auth_headers(admin_token))
    assert removed.status_code in (200, 204), removed.text


def _create_task(client: TestClient, admin_token: str, project_id: int, title: str, *, status: str, due_date: str, assignee_ids: list[int]) -> int:
    response = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={"project_id": project_id, "title": title, "status": status, "due_date": due_date, "assignee_ids": assignee_ids},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _post_note(client: TestClient, token: str, project_id: int, body: str) -> None:
    response = client.post(f"/api/projects/{project_id}/notes", headers=auth_headers(token), json={"body": body})
    assert response.status_code == 200, response.text


def _create_report(client: TestClient, admin_token: str, project_id: int) -> int:
    response = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-09-10",
            "send_telegram": False,
            "payload": {
                "workers": [{"name": "Bob Baumann", "start_time": "07:00", "end_time": "15:30"}],
                "work_done": "Leitungen gezogen",
                "completed_subtasks": ["Schlitze gefräst"],
                "materials_consumed": [{"item": "NYM-J 5x2,5", "qty": "40", "unit": "m"}],
                "materials_needed": [{"item": "NYM-J 5x6", "qty": "25", "unit": "m", "note": "11102138"}],
                "office_material_need": "NYM-J 5x6 - 25 m - ArtNr 11102138",
                "office_next_steps": "Zählerschrank bestellen",
                "office_rework": "Angebot Nachtrag schreiben",
                "extras": [{"description": "Zusätzliche Steckdose", "reason": "Kundenwunsch"}],
            },
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _upload_file(client: TestClient, admin_token: str, project_id: int, name: str, folder: str) -> int:
    response = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": folder},
        files={"file": (name, b"Plan", "text/plain")},
    )
    assert response.status_code == 200, response.text
    return response.json()[0]["id"]


def _report_state(client: TestClient, token: str, project_id: int) -> dict:
    response = client.get(f"/api/projects/{project_id}/report", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _report_files(client: TestClient, admin_token: str, project_id: int) -> list[dict]:
    response = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    return [row for row in response.json() if row["file_name"].startswith("Projektbericht_")]


def _recent_changes(client: TestClient, admin_token: str, project_id: int) -> list[dict]:
    response = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    return response.json()["recent_changes"]


def _poppler_available() -> bool:
    return shutil.which("pdfinfo") is not None and shutil.which("pdftoppm") is not None


def _full_project(client: TestClient, admin_token: str, number: str) -> tuple[int, dict, dict]:
    """A project with a customer, two explicit members, three tasks (one
    done), two notes, one site report (which also brings the material
    need) and one uploaded file."""
    anna = _create_user(client, admin_token, f"anna-{number}@example.com", "employee", "Anna Arbeit")
    bob = _create_user(client, admin_token, f"bob-{number}@example.com", "employee", "Bob Baumann")
    customer_id = _create_customer(client, admin_token, "Muster GmbH")
    project_id = _create_project(client, admin_token, number, customer_id=customer_id)
    _add_member(client, admin_token, project_id, anna["id"], can_manage=True)
    _add_member(client, admin_token, project_id, bob["id"], can_manage=False)
    _create_task(client, admin_token, project_id, "Zählerschrank setzen", status="open", due_date="2026-09-22", assignee_ids=[anna["id"], bob["id"]])
    _create_task(client, admin_token, project_id, "Schlitze fräsen", status="done", due_date="2026-09-08", assignee_ids=[bob["id"]])
    _create_task(client, admin_token, project_id, "Abnahme", status="open", due_date="2026-09-30", assignee_ids=[])
    _post_note(client, admin_token, project_id, "Erste Notiz")
    _post_note(client, _login(client, anna["email"]), project_id, "Zweite Notiz")
    _create_report(client, admin_token, project_id)
    _upload_file(client, admin_token, project_id, "plan.txt", "Anträge")
    _set_status(client, admin_token, project_id, "rechnung_verschickt")
    return project_id, anna, bob


def test_collects_every_section_in_report_order(client: TestClient, admin_token: str) -> None:
    project_id, anna, bob = _full_project(client, admin_token, "2026-7001")

    with SessionLocal() as db:
        data = collect_project_report_data(db, project_id)

    assert data.project_number == "2026-7001"
    assert data.status_label == "Rechnung verschickt"
    assert data.customer.name == "Muster GmbH"
    assert data.customer.address == "Hauptstr. 1, 12345 Musterstadt"
    assert data.customer.contact == "Frau Muster"
    assert data.site_address == "Baustelle 7, 12345 Musterstadt"

    # Team: the two explicit members with their roles (default members ride along).
    by_name = {member.display_name: member for member in data.members}
    assert by_name["Anna Arbeit"].can_manage is True
    assert by_name["Bob Baumann"].can_manage is False

    # Tasks in due-date order, with names and the open/done split.
    assert [task.title for task in data.tasks] == ["Schlitze fräsen", "Zählerschrank setzen", "Abnahme"]
    assert data.tasks[0].is_done and data.tasks[0].status_label == "Erledigt"
    assert data.tasks[1].assignees == ("Anna Arbeit", "Bob Baumann")
    assert data.open_task_count == 2 and data.done_task_count == 1

    # Notes oldest first, each with its author.
    assert [(note.body, note.author) for note in data.notes] == [("Erste Notiz", "Initial Admin"), ("Zweite Notiz", "Anna Arbeit")]

    # The site report, with the crew's hours and its lists.
    assert len(data.construction_reports) == 1
    report = data.construction_reports[0]
    assert report.number == 1
    assert report.workers[0].hours == 8.5 and report.total_hours == 8.5
    assert "Leitungen gezogen" in report.work_done and "- Schlitze gefräst" in report.work_done
    assert report.materials_consumed[0].item == "NYM-J 5x2,5"
    assert report.materials_needed[0].item == "NYM-J 5x6"
    assert report.open_points == ("Zählerschrank bestellen", "Zusätzliche Steckdose (Kundenwunsch)")
    assert report.office_rework == ("Angebot Nachtrag schreiben",)
    assert report.photo_count == 0

    # The need the report created, ready to order.
    assert [(need.item, need.article_no, need.quantity, need.unit, need.status_label) for need in data.material_needs] == [
        ("NYM-J 5x6", "11102138", "25", "m", "Bestellen")
    ]

    # Files: the upload in its folder (the site report's own PDF may sit beside it).
    assert ("Anträge", "plan.txt") in {(file.folder, file.file_name) for file in data.files}

    # Verlauf: the status change reads as labels, newest last.
    assert data.activities[-1].label == "Status geändert"
    assert data.activities[-1].message == "In Durchführung → Rechnung verschickt"
    assert data.activities[-1].actor == "Initial Admin"


def test_renders_a_pdf_with_at_least_one_page(client: TestClient, admin_token: str) -> None:
    project_id, _, _ = _full_project(client, admin_token, "2026-7002")
    with SessionLocal() as db:
        data = collect_project_report_data(db, project_id)
        project = db.get(Project, project_id)
        assert project is not None
        pdf = render_project_report_pdf(data, final=False, generated_at=project.created_at)
    assert pdf.startswith(b"%PDF-")
    try:
        assert pdf_page_count(pdf) >= 1
    except PdfPreviewUnavailable:
        pytest.skip("poppler not available")


def test_preview_serves_the_pdf_inline_and_as_a_download(client: TestClient, admin_token: str) -> None:
    project_id = _create_project(client, admin_token, "2026-7003")

    inline = client.get(f"/api/projects/{project_id}/report/preview", headers=auth_headers(admin_token))
    assert inline.status_code == 200, inline.text
    assert inline.headers["content-type"].startswith("application/pdf")
    assert inline.headers["content-disposition"].startswith("inline;")
    assert inline.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'self'" in inline.headers["content-security-policy"]
    assert inline.content.startswith(b"%PDF-")

    download = client.get(f"/api/projects/{project_id}/report/preview?download=1", headers=auth_headers(admin_token))
    assert download.status_code == 200, download.text
    disposition = download.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert "Projektbericht_2026-7003_" in disposition
    assert disposition.endswith(".pdf")


def test_preview_pages_answer_a_count_and_a_png(client: TestClient, admin_token: str) -> None:
    if not _poppler_available():
        pytest.skip("poppler not available")
    project_id = _create_project(client, admin_token, "2026-7004")

    count = client.get(f"/api/projects/{project_id}/report/preview-pages", headers=auth_headers(admin_token))
    assert count.status_code == 200, count.text
    assert count.json()["page_count"] >= 1

    page = client.get(f"/api/projects/{project_id}/report/preview-pages/1", headers=auth_headers(admin_token))
    assert page.status_code == 200, page.text
    assert page.headers["content-type"].startswith("image/png")
    assert page.content[:8] == b"\x89PNG\r\n\x1a\n"

    beyond = client.get(f"/api/projects/{project_id}/report/preview-pages/999", headers=auth_headers(admin_token))
    assert beyond.status_code == 404


def test_employee_without_project_access_is_refused(client: TestClient, admin_token: str) -> None:
    employee = _create_user(client, admin_token, "outsider-report@example.com", "employee", "Outsider")
    token = _login(client, employee["email"])
    project_id = _create_project(client, admin_token, "2026-7005")
    _remove_membership(client, admin_token, project_id, employee["id"])

    for path in ("report", "report/preview", "report/preview-pages", "report/preview-pages/1"):
        response = client.get(f"/api/projects/{project_id}/{path}", headers=auth_headers(token))
        assert response.status_code == 403, (path, response.text)


def test_manual_finalize_stores_the_report_in_berichte(client: TestClient, admin_token: str) -> None:
    project_id, _, _ = _full_project(client, admin_token, "2026-7006")

    finalized = client.post(f"/api/projects/{project_id}/report/finalize", headers=auth_headers(admin_token))
    assert finalized.status_code == 200, finalized.text
    state = finalized.json()
    assert state["finalized_at"]
    assert state["attachment_id"]
    assert state["file_name"].startswith("Projektbericht_2026-7006_") and state["file_name"].endswith(".pdf")

    files = _report_files(client, admin_token, project_id)
    assert [(row["id"], row["folder"], row["content_type"]) for row in files] == [
        (state["attachment_id"], "Berichte", "application/pdf")
    ]
    assert _report_state(client, admin_token, project_id) == state

    overview = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token)).json()
    assert overview["project_report"] == state
    recorded = [row for row in overview["recent_changes"] if row["event_type"] == "project.report_finalized"]
    assert recorded and recorded[0]["details"] == {"attachment_id": state["attachment_id"], "file_name": state["file_name"]}

    with SessionLocal() as db:
        project = db.get(Project, project_id)
        assert project is not None
        assert project.report_attachment_id == state["attachment_id"]
        assert project.report_finalized_at is not None

    # The stored copy opens like any other file — and the report does not
    # list itself in its Dateien section.
    stored = client.get(f"/api/files/{state['attachment_id']}/preview", headers=auth_headers(admin_token))
    assert stored.status_code == 200 and stored.content.startswith(b"%PDF-")
    with SessionLocal() as db:
        data = collect_project_report_data(db, project_id)
    assert state["file_name"] not in {file.file_name for file in data.files}

    # Filing again keeps the earlier copy and moves the pointer to the new one.
    again = client.post(f"/api/projects/{project_id}/report/finalize", headers=auth_headers(admin_token))
    assert again.status_code == 200, again.text
    assert again.json()["attachment_id"] != state["attachment_id"]
    assert len(_report_files(client, admin_token, project_id)) == 2
    assert _report_state(client, admin_token, project_id)["attachment_id"] == again.json()["attachment_id"]


def test_employee_cannot_finalize(client: TestClient, admin_token: str) -> None:
    employee = _create_user(client, admin_token, "member-report@example.com", "employee", "Member")
    token = _login(client, employee["email"])
    project_id = _create_project(client, admin_token, "2026-7007")

    refused = client.post(f"/api/projects/{project_id}/report/finalize", headers=auth_headers(token))
    assert refused.status_code == 403, refused.text
    assert _report_state(client, admin_token, project_id)["attachment_id"] is None


def test_status_change_to_abgeschlossen_files_the_report_once(client: TestClient, admin_token: str) -> None:
    project_id, _, _ = _full_project(client, admin_token, "2026-7008")
    assert _report_state(client, admin_token, project_id)["attachment_id"] is None

    _set_status(client, admin_token, project_id, "abgeschlossen")
    first = _report_state(client, admin_token, project_id)
    assert first["attachment_id"] and first["finalized_at"]
    assert len(_report_files(client, admin_token, project_id)) == 1
    events = [row["event_type"] for row in _recent_changes(client, admin_token, project_id)]
    assert "project.report_finalized" in events and "project.report_finalize_failed" not in events

    # Ending the project a second way does not file a second sheet.
    _set_status(client, admin_token, project_id, "archived")
    assert _report_state(client, admin_token, project_id) == first
    assert len(_report_files(client, admin_token, project_id)) == 1

    # Re-opened and finished again: a new sheet, the old one stays.
    _set_status(client, admin_token, project_id, "in_durchfuehrung")
    assert _report_state(client, admin_token, project_id) == first
    _set_status(client, admin_token, project_id, "abgeschlossen")
    second = _report_state(client, admin_token, project_id)
    assert second["attachment_id"] != first["attachment_id"]
    assert len(_report_files(client, admin_token, project_id)) == 2

    # The stored sheet carries the change that closed the project.
    with SessionLocal() as db:
        data = collect_project_report_data(db, project_id)
    messages = [activity.message for activity in data.activities]
    assert "In Durchführung → Abgeschlossen" in messages


def test_rendering_failure_keeps_the_status_change(client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch) -> None:
    project_id, _, _ = _full_project(client, admin_token, "2026-7009")

    def boom(*_args, **_kwargs):
        raise RuntimeError("kaputt")

    monkeypatch.setattr("app.routers.workflow_project_report.render_project_report_pdf", boom)

    updated = _set_status(client, admin_token, project_id, "abgeschlossen")
    assert updated["status"] == "abgeschlossen"

    # Committed, not just echoed: the overview reads the row back.
    overview = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token))
    assert overview.status_code == 200, overview.text
    assert overview.json()["project"]["status"] == "abgeschlossen"
    assert overview.json()["project_report"]["attachment_id"] is None

    assert _report_state(client, admin_token, project_id)["attachment_id"] is None
    assert _report_files(client, admin_token, project_id) == []
    changes = overview.json()["recent_changes"]
    failed = [row for row in changes if row["event_type"] == "project.report_finalize_failed"]
    assert failed and failed[0]["message"] == "RuntimeError"
    assert failed[0]["details"]["error"] == "kaputt"
    assert any(row["event_type"] == "project.state_changed" for row in changes)


def test_filename_is_project_number_and_date() -> None:
    from datetime import datetime

    assert build_project_report_filename("2026-7010", datetime(2026, 9, 19, 14, 5)) == "Projektbericht_2026-7010_2026-09-19.pdf"
    assert build_project_report_filename("Ärger/Nr 1", datetime(2026, 1, 2)) == "Projektbericht_rger_Nr_1_2026-01-02.pdf"


# ── the customer on the sheet: the visit preface, the type, the mobile ──


def _create_customer_with_visit(client: TestClient, admin_token: str, name: str) -> int:
    response = client.post(
        "/api/customers",
        headers=auth_headers(admin_token),
        json={
            "name": name,
            "customer_type": "private",
            "address": "Hauptstr. 1, 12345 Musterstadt",
            "contact_person": "Frau Muster",
            "email": "muster@example.com",
            "phone": "0123 456",
            "mobile": "0171 2345678",
            "visit_summary": "Altbau von 1962, Zählerschrank im Keller, Zuleitung muss neu.",
            "visit_date": "2026-09-01",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _report_data(project_id: int):
    with SessionLocal() as db:
        data = collect_project_report_data(db, project_id)
        project = db.get(Project, project_id)
        assert project is not None
        return data, project.created_at


def _pdf_text(pdf: bytes, tmp_path) -> str:
    """The rendered sheet as text, in print order — poppler reads it back."""
    if shutil.which("pdftotext") is None:
        pytest.skip("poppler not available")
    path = tmp_path / "report.pdf"
    path.write_bytes(pdf)
    return subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, check=True).stdout


def test_visit_section_comes_first_when_the_customer_has_a_summary(client: TestClient, admin_token: str, tmp_path) -> None:
    customer_id = _create_customer_with_visit(client, admin_token, "Besuchte Person")
    project_id = _create_project(client, admin_token, "2026-7101", customer_id=customer_id)

    data, created_at = _report_data(project_id)
    assert data.visit is not None
    assert data.visit.summary == "Altbau von 1962, Zählerschrank im Keller, Zuleitung muss neu."
    assert data.visit.visit_date == date(2026, 9, 1)
    assert data.visit.visited_by == "Initial Admin"
    assert data.customer.type_label == "Privatkunde"
    assert data.customer.mobile == "0171 2345678"
    assert data.customer.phone == "0123 456"

    text = _pdf_text(render_project_report_pdf(data, final=False, generated_at=created_at), tmp_path)
    assert "KUNDENBESUCH" in text
    assert text.index("KUNDENBESUCH") < text.index("PROJEKT & KUNDE")
    assert "Besuch am 01.09.2026" in text and "Initial Admin" in text
    assert "Altbau von 1962" in text
    assert "Privatkunde" in text
    assert "Mobil" in text and "0171 2345678" in text
    assert text.index("Telefon") < text.index("Mobil")


def test_visit_section_is_absent_without_a_summary(client: TestClient, admin_token: str, tmp_path) -> None:
    customer_id = _create_customer(client, admin_token, "Nie besucht GmbH")
    project_id = _create_project(client, admin_token, "2026-7102", customer_id=customer_id)

    data, created_at = _report_data(project_id)
    assert data.visit is None
    assert data.customer.type_label == ""
    assert data.customer.mobile == ""

    text = _pdf_text(render_project_report_pdf(data, final=False, generated_at=created_at), tmp_path)
    assert "KUNDENBESUCH" not in text
    assert "Kundentyp" not in text
    assert "Mobil" not in text
    assert "PROJEKT & KUNDE" in text

    # No customer at all: nothing to preface with either.
    alone_id = _create_project(client, admin_token, "2026-7103")
    alone, _ = _report_data(alone_id)
    assert alone.visit is None and alone.customer.type_label == "" and alone.customer.mobile == ""


def test_overview_carries_the_linked_customer(client: TestClient, admin_token: str) -> None:
    customer_id = _create_customer_with_visit(client, admin_token, "Kontakt Person")
    project_id = _create_project(client, admin_token, "2026-7104", customer_id=customer_id)

    overview = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token))
    assert overview.status_code == 200, overview.text
    customer = overview.json()["customer"]
    assert customer["id"] == customer_id
    assert customer["customer_type"] == "private"
    assert customer["mobile"] == "0171 2345678"
    assert customer["visit_summary"].startswith("Altbau von 1962")

    alone_id = _create_project(client, admin_token, "2026-7105")
    alone = client.get(f"/api/projects/{alone_id}/overview", headers=auth_headers(admin_token))
    assert alone.status_code == 200, alone.text
    assert alone.json()["customer"] is None
