from __future__ import annotations
from datetime import datetime, time, timedelta, timezone
import json
import os
from urllib.parse import quote
from fastapi.testclient import TestClient
from app.main import _rate_bucket
from app.routers import workflow as workflow_router


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str):
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": f"{role.title()} User",
            "role": role,
        },
    )
    assert response.status_code == 200
    return response.json()


def _login(client: TestClient, email: str):
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200
    return response.headers["X-Access-Token"]


def test_project_task_planning_ticket_file_and_report_flow(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee2@example.com", "employee")
    employee_b = _create_user(client, admin_token, "employee4@example.com", "employee")
    outsider = _create_user(client, admin_token, "employee5@example.com", "employee")
    accountant = _create_user(client, admin_token, "accountant1@example.com", "accountant")
    _create_user(client, admin_token, "planner@example.com", "planning")
    planning_token = _login(client, "planner@example.com")
    employee_token = _login(client, "employee2@example.com")
    employee_b_token = _login(client, "employee4@example.com")
    outsider_token = _login(client, "employee5@example.com")
    accountant_token = _login(client, "accountant1@example.com")

    assignable_users = client.get("/api/users/assignable", headers=auth_headers(admin_token))
    assert assignable_users.status_code == 200
    assignable_ids = {row["id"] for row in assignable_users.json()}
    assert employee["id"] in assignable_ids
    assert accountant["id"] in assignable_ids

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-1001",
            "name": "Project A",
            "description": "desc",
            "status": "active",
            "customer_name": "ACME GmbH",
            "customer_address": "Main Street 1",
            "customer_contact": "Max Mustermann",
            "customer_email": "office@acme.example",
            "customer_phone": "+49 123 456789",
            "site_access_type": "code_access",
            "site_access_note": "4711#",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]
    assert project.json()["project_number"] == "2026-1001"
    assert project.json()["customer_name"] == "ACME GmbH"
    assert project.json()["site_access_type"] == "code_access"
    assert project.json()["site_access_note"] == "4711#"
    assert project.json().get("last_updated_at")
    project_created_last_updated = datetime.fromisoformat(project.json()["last_updated_at"])

    member = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert member.status_code == 200
    member_b = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee_b["id"], "can_manage": "false"},
    )
    assert member_b.status_code == 200

    created_task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Install inverter",
            "description": "Mount inverter in technical room",
            "materials_required": "Inverter, cable set",
            "storage_box_number": 7,
            "task_type": "office",
            "status": "open",
            "due_date": "2026-02-17",
            "start_time": "08:30",
            "assignee_ids": [employee["id"], employee_b["id"], accountant["id"]],
            "week_start": "2026-02-16",
        },
    )
    assert created_task.status_code == 200
    assert created_task.json()["materials_required"] == "Inverter, cable set"
    assert created_task.json()["storage_box_number"] == 7
    assert created_task.json()["task_type"] == "office"
    assert created_task.json()["start_time"] == "08:30:00"
    assert len(created_task.json()["assignee_ids"]) == 3
    created_task_id = created_task.json()["id"]

    project_overview = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token))
    assert project_overview.status_code == 200
    overview_payload = project_overview.json()
    assert overview_payload["open_tasks"] >= 1
    assert overview_payload["my_open_tasks"] >= 0
    assert overview_payload["finance"]["project_id"] == project_id
    assert any(change["event_type"] == "task.created" for change in overview_payload["recent_changes"])
    overview_last_updated = datetime.fromisoformat(overview_payload["project"]["last_updated_at"])
    assert overview_last_updated >= project_created_last_updated

    finance_update = client.patch(
        f"/api/projects/{project_id}/finance",
        headers=auth_headers(admin_token),
        json={
            "order_value_net": 100000.0,
            "down_payment_35": 35000.0,
            "main_components_50": 50000.0,
            "final_invoice_15": 15000.0,
            "planned_costs": 70000.0,
            "actual_costs": 65000.0,
            "contribution_margin": 35000.0,
            "planned_hours_total": 120.0,
        },
    )
    assert finance_update.status_code == 200
    assert finance_update.json()["order_value_net"] == 100000.0
    assert finance_update.json()["planned_hours_total"] == 120.0
    assert finance_update.json()["updated_by"] == 1

    project_overview_after_finance = client.get(f"/api/projects/{project_id}/overview", headers=auth_headers(admin_token))
    assert project_overview_after_finance.status_code == 200
    assert project_overview_after_finance.json()["finance"]["planned_hours_total"] == 120.0
    assert any(
        change["event_type"] == "finance.updated"
        for change in project_overview_after_finance.json()["recent_changes"]
    )

    planned = client.post(
        "/api/planning/week/2026-02-16",
        headers=auth_headers(planning_token),
        json=[
            {
                "project_id": project_id,
                "title": "Plan weekly task",
                "description": "",
                "task_type": "construction",
                "status": "open",
                "due_date": None,
                "assignee_id": employee["id"],
                "assignee_ids": [employee["id"], employee_b["id"]],
                "week_start": "2026-02-16",
            }
        ],
    )
    assert planned.status_code == 200
    task_id = planned.json()["created_task_ids"][0]

    my_tasks = client.get("/api/tasks?view=my", headers=auth_headers(employee_token))
    assert my_tasks.status_code == 200
    assert len(my_tasks.json()) >= 1
    assert any(task["id"] == task_id for task in my_tasks.json())
    assert any(task["id"] == task_id and len(task["assignee_ids"]) == 2 for task in my_tasks.json())

    my_tasks_b = client.get("/api/tasks?view=my", headers=auth_headers(employee_b_token))
    assert my_tasks_b.status_code == 200
    assert any(task["id"] == task_id for task in my_tasks_b.json())

    my_tasks_accountant = client.get("/api/tasks?view=my", headers=auth_headers(accountant_token))
    assert my_tasks_accountant.status_code == 200
    assert any(task["id"] == created_task_id for task in my_tasks_accountant.json())

    admin_updates_task = client.patch(
        f"/api/tasks/{created_task_id}",
        headers=auth_headers(admin_token),
        json={
            "title": "Install inverter + meter",
            "description": "Updated by admin",
            "materials_required": "Inverter, cable set, meter",
            "storage_box_number": 9,
            "due_date": "2026-02-18",
            "start_time": "09:45",
            "assignee_ids": [employee["id"], accountant["id"]],
        },
    )
    assert admin_updates_task.status_code == 200
    assert admin_updates_task.json()["title"] == "Install inverter + meter"
    assert admin_updates_task.json()["description"] == "Updated by admin"
    assert admin_updates_task.json()["storage_box_number"] == 9
    assert admin_updates_task.json()["start_time"] == "09:45:00"
    assert admin_updates_task.json()["assignee_ids"] == [employee["id"], accountant["id"]]

    mark_done = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(employee_token),
        json={"status": "done"},
    )
    assert mark_done.status_code == 200
    assert mark_done.json()["status"] == "done"

    my_tasks_after_done = client.get("/api/tasks?view=my", headers=auth_headers(employee_token))
    assert my_tasks_after_done.status_code == 200
    assert all(task["id"] != task_id for task in my_tasks_after_done.json())

    completed_tasks = client.get(
        f"/api/tasks?view=completed&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    assert completed_tasks.status_code == 200
    assert any(task["id"] == task_id and task["status"] == "done" for task in completed_tasks.json())

    outsider_denied = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(outsider_token),
        json={"status": "done"},
    )
    assert outsider_denied.status_code == 403

    deletable_task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Temporary task",
            "status": "open",
            "due_date": "2026-02-19",
            "assignee_ids": [employee["id"]],
        },
    )
    assert deletable_task.status_code == 200
    deletable_task_id = deletable_task.json()["id"]

    delete_task_denied = client.delete(
        f"/api/tasks/{deletable_task_id}",
        headers=auth_headers(employee_token),
    )
    assert delete_task_denied.status_code == 403

    delete_task_ok = client.delete(
        f"/api/tasks/{deletable_task_id}",
        headers=auth_headers(admin_token),
    )
    assert delete_task_ok.status_code == 200
    assert delete_task_ok.json()["ok"] is True

    task_list_after_delete = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    assert task_list_after_delete.status_code == 200
    assert all(entry["id"] != deletable_task_id for entry in task_list_after_delete.json())

    denied = client.post(
        "/api/projects",
        headers=auth_headers(employee_token),
        json={"project_number": "2026-1002", "name": "Nope", "description": "", "status": "active"},
    )
    assert denied.status_code == 403

    update_project = client.patch(
        f"/api/projects/{project_id}",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-1001A",
            "customer_name": "ACME Berlin",
            "customer_address": "Berlin 7",
            "customer_contact": "Erika Muster",
            "site_access_type": "call_before_departure",
        },
    )
    assert update_project.status_code == 200
    assert update_project.json()["project_number"] == "2026-1001A"
    assert update_project.json()["customer_name"] == "ACME Berlin"
    assert update_project.json()["site_access_type"] == "call_before_departure"
    assert update_project.json()["site_access_note"] is None

    site = client.post(
        f"/api/projects/{project_id}/sites",
        headers=auth_headers(admin_token),
        json={"name": "Site 1", "address": "Main Street 1"},
    )
    assert site.status_code == 200
    site_id = site.json()["id"]

    ticket = client.post(
        f"/api/projects/{project_id}/job-tickets",
        headers=auth_headers(admin_token),
        json={
            "site_id": site_id,
            "title": "Ticket 1",
            "site_address": "Main Street 1",
            "ticket_date": "2026-02-17",
            "assigned_crew": ["Crew A"],
            "checklist": [{"label": "Safety", "done": False}],
            "notes": "N/A",
        },
    )
    assert ticket.status_code == 200
    ticket_id = ticket.json()["id"]

    printable = client.get(
        f"/api/projects/{project_id}/job-tickets/{ticket_id}/print",
        headers=auth_headers(admin_token),
    )
    assert printable.status_code == 200
    assert "Job Ticket" in printable.text

    ticket_attachment = client.post(
        f"/api/projects/{project_id}/job-tickets/{ticket_id}/attachments",
        headers=auth_headers(admin_token),
        files={"file": ("ticket-note.txt", b"ticket attachment", "text/plain")},
    )
    assert ticket_attachment.status_code == 200

    ticket_attachments = client.get(
        f"/api/projects/{project_id}/job-tickets/{ticket_id}/attachments",
        headers=auth_headers(employee_token),
    )
    assert ticket_attachments.status_code == 200
    assert len(ticket_attachments.json()) == 1

    upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert upload.status_code == 200

    unicode_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("Screenshot 2025-12-02 at 8.40.04\u202fAM.png", b"fake-image-content", "image/png")},
    )
    assert unicode_upload.status_code == 200
    unicode_file_id = unicode_upload.json()["id"]

    unicode_download = client.get(f"/api/files/{unicode_file_id}/download", headers=auth_headers(employee_token))
    assert unicode_download.status_code == 200
    assert unicode_download.content == b"fake-image-content"
    assert "filename*=" in unicode_download.headers.get("content-disposition", "")

    unicode_preview = client.get(f"/api/files/{unicode_file_id}/preview", headers=auth_headers(employee_token))
    assert unicode_preview.status_code == 200
    assert unicode_preview.content == b"fake-image-content"
    assert unicode_preview.headers.get("content-disposition", "").startswith("inline;")

    files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(employee_token))
    assert files.status_code == 200
    assert len(files.json()) >= 1

    global_thread = client.post(
        "/api/threads",
        headers=auth_headers(admin_token),
        json={"name": "General Team Chat"},
    )
    assert global_thread.status_code == 200
    thread_id = global_thread.json()["id"]
    assert global_thread.json()["project_id"] is None
    assert global_thread.json()["message_count"] == 0
    assert global_thread.json()["unread_count"] == 0
    assert global_thread.json()["created_by"] == 1

    project_thread = client.post(
        "/api/threads",
        headers=auth_headers(admin_token),
        json={"name": "Project A Chat", "project_id": project_id},
    )
    assert project_thread.status_code == 200
    assert project_thread.json()["project_id"] == project_id

    threads = client.get("/api/threads", headers=auth_headers(employee_token))
    assert threads.status_code == 200
    thread_names = {entry["name"] for entry in threads.json()}
    assert "General Team Chat" in thread_names
    assert "Project A Chat" in thread_names

    employee_created_thread = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={"name": "Crew Alpha"},
    )
    assert employee_created_thread.status_code == 200
    employee_thread_id = employee_created_thread.json()["id"]
    assert employee_created_thread.json()["created_by"] == employee["id"]
    assert employee_created_thread.json()["can_edit"] is True

    employee_thread_patch = client.patch(
        f"/api/threads/{employee_thread_id}",
        headers=auth_headers(employee_token),
        json={"name": "Crew Alpha Edited"},
    )
    assert employee_thread_patch.status_code == 200
    assert employee_thread_patch.json()["name"] == "Crew Alpha Edited"

    employee_thread_assign_project = client.patch(
        f"/api/threads/{employee_thread_id}",
        headers=auth_headers(employee_token),
        json={"name": "Crew Alpha Edited", "project_id": project_id},
    )
    assert employee_thread_assign_project.status_code == 200
    assert employee_thread_assign_project.json()["project_id"] == project_id

    employee_thread_unassign_project = client.patch(
        f"/api/threads/{employee_thread_id}",
        headers=auth_headers(employee_token),
        json={"name": "Crew Alpha Edited", "project_id": None},
    )
    assert employee_thread_unassign_project.status_code == 200
    assert employee_thread_unassign_project.json()["project_id"] is None

    non_creator_patch_denied = client.patch(
        f"/api/threads/{employee_thread_id}",
        headers=auth_headers(employee_b_token),
        json={"name": "Not allowed"},
    )
    assert non_creator_patch_denied.status_code == 403

    message = client.post(
        f"/api/threads/{thread_id}/messages",
        headers=auth_headers(employee_token),
        data={"body": "Hello team"},
        files={"image": ("chat-image.png", b"fake-image-content", "image/png")},
    )
    assert message.status_code == 200
    assert message.json()["body"] == "Hello team"
    assert len(message.json()["attachments"]) == 1

    messages = client.get(f"/api/threads/{thread_id}/messages", headers=auth_headers(employee_token))
    assert messages.status_code == 200
    assert len(messages.json()) == 1
    assert len(messages.json()[0]["attachments"]) == 1

    plain_message = client.post(
        f"/api/threads/{thread_id}/messages",
        headers=auth_headers(employee_token),
        data={"body": "Text only"},
    )
    assert plain_message.status_code == 200
    assert plain_message.json()["body"] == "Text only"
    assert plain_message.json()["attachments"] == []

    attachment_only_message = client.post(
        f"/api/threads/{thread_id}/messages",
        headers=auth_headers(employee_token),
        files={"attachment": ("handover.txt", b"handover notes", "text/plain")},
    )
    assert attachment_only_message.status_code == 200
    assert attachment_only_message.json()["body"] is None
    assert len(attachment_only_message.json()["attachments"]) == 1

    unread_for_admin = client.get("/api/threads", headers=auth_headers(admin_token))
    assert unread_for_admin.status_code == 200
    unread_entry = next((entry for entry in unread_for_admin.json() if entry["id"] == thread_id), None)
    assert unread_entry is not None
    assert unread_entry["unread_count"] >= 1

    mark_read_admin = client.get(f"/api/threads/{thread_id}/messages", headers=auth_headers(admin_token))
    assert mark_read_admin.status_code == 200

    unread_reset_admin = client.get("/api/threads", headers=auth_headers(admin_token))
    assert unread_reset_admin.status_code == 200
    unread_reset_entry = next((entry for entry in unread_reset_admin.json() if entry["id"] == thread_id), None)
    assert unread_reset_entry is not None
    assert unread_reset_entry["unread_count"] == 0

    icon_upload = client.post(
        f"/api/threads/{employee_thread_id}/icon",
        headers=auth_headers(employee_token),
        files={"file": ("thread-icon.png", b"icon-content", "image/png")},
    )
    assert icon_upload.status_code == 200
    assert icon_upload.json()["ok"] is True

    icon_file = client.get(f"/api/threads/{employee_thread_id}/icon", headers=auth_headers(employee_b_token))
    assert icon_file.status_code == 200
    assert icon_file.content == b"icon-content"

    autofill_report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(employee_token),
        json={
            "report_date": "2026-02-17",
            "send_telegram": False,
            "payload": {
                "work_done": "Quick check",
            },
        },
    )
    assert autofill_report.status_code == 200
    autofill_report_id = autofill_report.json()["id"]

    reports_with_autofill = client.get(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(employee_token),
    )
    assert reports_with_autofill.status_code == 200
    autofill_payload = next(
        (entry["payload"] for entry in reports_with_autofill.json() if entry["id"] == autofill_report_id),
        None,
    )
    assert autofill_payload is not None
    assert autofill_payload["customer"] == "ACME Berlin"
    assert autofill_payload["project_number"] == "2026-1001A"

    report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(employee_token),
        json={
            "report_date": "2026-02-17",
            "send_telegram": True,
            "payload": {
                "customer": "ACME GmbH",
                "project_name": "Project A",
                "project_number": "2026-001",
                "workers": [{"name": "Max", "start_time": "07:30", "end_time": "16:00"}],
                "materials": [{"item": "Cable", "qty": "10", "unit": "m", "article_no": "A1"}],
                "extras": [{"description": "Extra trench", "reason": "Client request"}],
                "work_done": "Installed cable trays",
                "incidents": "None",
                "office_material_need": "Need 20m cable",
                "office_rework": "No rework needed",
                "office_next_steps": "Switchboard wiring",
            },
        },
    )
    assert report.status_code == 200
    data = report.json()
    assert data["processing_status"] == "completed"
    assert data["telegram_mode"] == "stub"
    assert data["attachment_file_name"].endswith(".pdf")
    processing_status = client.get(
        f"/api/construction-reports/{data['id']}/processing",
        headers=auth_headers(employee_token),
    )
    assert processing_status.status_code == 200
    assert processing_status.json()["processing_status"] == "completed"

    materials_queue = client.get("/api/materials", headers=auth_headers(employee_token))
    assert materials_queue.status_code == 200
    project_material_items = [entry for entry in materials_queue.json() if entry["project_id"] == project_id]
    assert any(entry["item"] == "Need 20m cable" and entry["status"] == "order" for entry in project_material_items)
    material_item = next(entry for entry in project_material_items if entry["item"] == "Need 20m cable")

    material_status_update = client.patch(
        f"/api/materials/{material_item['id']}",
        headers=auth_headers(employee_token),
        json={"status": "on_the_way"},
    )
    assert material_status_update.status_code == 200
    assert material_status_update.json()["status"] == "on_the_way"
    assert material_status_update.json()["project_id"] == project_id
    assert material_status_update.json()["report_date"] == "2026-02-17"

    materials_queue_after_update = client.get("/api/materials", headers=auth_headers(employee_token))
    assert materials_queue_after_update.status_code == 200
    assert any(
        entry["id"] == material_item["id"] and entry["status"] == "on_the_way"
        for entry in materials_queue_after_update.json()
    )

    project_finance_after_report = client.get(
        f"/api/projects/{project_id}/finance",
        headers=auth_headers(employee_token),
    )
    assert project_finance_after_report.status_code == 200
    assert project_finance_after_report.json()["reported_hours_total"] == 8.5

    project_overview_after_report = client.get(
        f"/api/projects/{project_id}/overview",
        headers=auth_headers(employee_token),
    )
    assert project_overview_after_report.status_code == 200
    assert project_overview_after_report.json()["finance"]["reported_hours_total"] == 8.5

    project_files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(employee_token))
    assert project_files.status_code == 200
    report_file = next((entry for entry in project_files.json() if entry["file_name"] == data["attachment_file_name"]), None)
    assert report_file is not None
    assert report_file["content_type"] == "application/pdf"
    assert report_file["folder"] == "Berichte"

    report_download = client.get(f"/api/files/{report_file['id']}/download", headers=auth_headers(employee_token))
    assert report_download.status_code == 200
    assert report_download.content.startswith(b"%PDF")

    multipart_report = client.post(
        f"/api/projects/{project_id}/construction-reports",
        headers=auth_headers(employee_token),
        data={
            "report_date": "2026-02-17",
            "send_telegram": "false",
            "payload": json.dumps(
                {
                    "customer": "ACME GmbH",
                    "project_name": "Project A",
                    "project_number": "2026-001",
                    "workers": [{"name": "Max", "start_time": "730", "end_time": "1600"}],
                    "materials": [],
                    "extras": [],
                    "work_done": "Wall prep",
                }
            ),
        },
        files=[
            ("images", ("site-photo.jpg", b"photo-data", "image/jpeg")),
            ("camera_images", ("mobile-capture.jpg", b"mobile-photo-data", "image/jpeg")),
        ],
    )
    assert multipart_report.status_code == 200
    assert len(multipart_report.json()["report_images"]) == 2

    project_report_files = client.get(
        f"/api/construction-reports/files?project_id={project_id}",
        headers=auth_headers(employee_token),
    )
    assert project_report_files.status_code == 200
    assert any(entry["file_name"] == data["attachment_file_name"] for entry in project_report_files.json())
    assert any(
        entry["file_name"] == "site-photo.jpg" and str(entry.get("folder") or "").startswith("Bilder")
        for entry in project_report_files.json()
    )
    assert any(
        entry["file_name"] == "mobile-capture.jpg" and str(entry.get("folder") or "").startswith("Bilder")
        for entry in project_report_files.json()
    )

    project_finance_after_multipart_report = client.get(
        f"/api/projects/{project_id}/finance",
        headers=auth_headers(employee_token),
    )
    assert project_finance_after_multipart_report.status_code == 200
    assert project_finance_after_multipart_report.json()["reported_hours_total"] == 17.0

    global_report = client.post(
        "/api/construction-reports",
        headers=auth_headers(employee_token),
        json={
            "report_date": "2026-02-18",
            "send_telegram": False,
            "payload": {
                "customer": "Walk-in Customer",
                "project_name": "Service Visit",
                "project_number": "",
                "workers": [{"name": "Alex"}],
                "work_done": "Standalone report without project",
            },
        },
    )
    assert global_report.status_code == 200
    global_payload = global_report.json()
    assert global_payload["project_id"] is None
    assert global_payload["processing_status"] == "completed"
    assert global_payload["attachment_file_name"].endswith(".pdf")

    global_reports = client.get("/api/construction-reports", headers=auth_headers(employee_token))
    assert global_reports.status_code == 200
    assert any(entry["id"] == global_payload["id"] and entry["project_id"] is None for entry in global_reports.json())

    global_files = client.get("/api/construction-reports/files", headers=auth_headers(employee_token))
    assert global_files.status_code == 200
    global_pdf = next((entry for entry in global_files.json() if entry["file_name"] == global_payload["attachment_file_name"]), None)
    assert global_pdf is not None
    assert global_pdf["folder"] == "Berichte"

    global_pdf_download = client.get(f"/api/files/{global_pdf['id']}/download", headers=auth_headers(employee_token))
    assert global_pdf_download.status_code == 200
    assert global_pdf_download.content.startswith(b"%PDF")

    delete_project_denied = client.delete(f"/api/projects/{project_id}", headers=auth_headers(employee_token))
    assert delete_project_denied.status_code == 403

    delete_project_ok = client.delete(f"/api/projects/{project_id}", headers=auth_headers(admin_token))
    assert delete_project_ok.status_code == 200
    assert delete_project_ok.json()["ok"] is True

    projects_after_delete = client.get("/api/projects", headers=auth_headers(admin_token))
    assert projects_after_delete.status_code == 200
    assert all(entry["id"] != project_id for entry in projects_after_delete.json())


def test_time_tracking_timesheet_and_csv(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee3@example.com", "employee")
    ceo_user = _create_user(client, admin_token, "ceo-time@example.com", "ceo")
    employee_token = _login(client, "employee3@example.com")
    ceo_token = _login(client, "ceo-time@example.com")

    update_required_denied = client.patch(
        f"/api/time/required-hours/{employee['id']}",
        headers=auth_headers(employee_token),
        json={"required_daily_hours": 7.5},
    )
    assert update_required_denied.status_code == 403

    update_required = client.patch(
        f"/api/time/required-hours/{employee['id']}",
        headers=auth_headers(admin_token),
        json={"required_daily_hours": 7.5},
    )
    assert update_required.status_code == 200
    assert update_required.json()["required_daily_hours"] == 7.5

    update_required_ceo = client.patch(
        f"/api/time/required-hours/{employee['id']}",
        headers=auth_headers(ceo_token),
        json={"required_daily_hours": 7.25},
    )
    assert update_required_ceo.status_code == 200
    assert update_required_ceo.json()["required_daily_hours"] == 7.25

    update_required_non_employee_target = client.patch(
        f"/api/time/required-hours/{ceo_user['id']}",
        headers=auth_headers(admin_token),
        json={"required_daily_hours": 6.5},
    )
    assert update_required_non_employee_target.status_code == 200
    assert update_required_non_employee_target.json()["required_daily_hours"] == 6.5

    clock_in = client.post("/api/time/clock-in", headers=auth_headers(employee_token))
    assert clock_in.status_code == 200
    clock_entry_id = clock_in.json()["clock_entry_id"]

    current = client.get("/api/time/current", headers=auth_headers(employee_token))
    assert current.status_code == 200
    assert current.json()["clock_entry_id"] == clock_entry_id
    assert current.json()["required_daily_hours"] == 7.25
    assert "daily_net_hours" in current.json()
    assert "progress_percent_live" in current.json()

    break_start = client.post(f"/api/time/{clock_entry_id}/break-start", headers=auth_headers(employee_token))
    assert break_start.status_code == 200
    break_end = client.post(f"/api/time/{clock_entry_id}/break-end", headers=auth_headers(employee_token))
    assert break_end.status_code == 200

    clock_out = client.post("/api/time/clock-out", headers=auth_headers(employee_token))
    assert clock_out.status_code == 200
    assert "deducted_break_hours" in clock_out.json()

    timesheet = client.get("/api/time/timesheet?period=weekly", headers=auth_headers(employee_token))
    assert timesheet.status_code == 200
    assert "total_hours" in timesheet.json()

    entries = client.get("/api/time/entries?period=weekly", headers=auth_headers(employee_token))
    assert entries.status_code == 200
    assert len(entries.json()) == 1

    patched = client.patch(
        f"/api/time/entries/{clock_entry_id}",
        headers=auth_headers(employee_token),
        json={"clock_in": "2026-02-17T07:30:00", "clock_out": "2026-02-17T16:30:00", "break_minutes": 45},
    )
    assert patched.status_code == 200
    assert patched.json()["break_hours"] == 0.75
    assert patched.json()["deducted_break_hours"] == 0.75

    csv_export = client.get("/api/time/timesheet/export.csv", headers=auth_headers(employee_token))
    assert csv_export.status_code == 200
    assert "clock_entry_id" in csv_export.text
    assert "deducted_break_hours" in csv_export.text


def test_project_class_templates_import_and_autocreate_tasks(client: TestClient, admin_token: str):
    template_download = client.get("/api/admin/project-classes/template.csv", headers=auth_headers(admin_token))
    assert template_download.status_code == 200
    assert "class_name" in template_download.text

    csv_payload = (
        "class_name,materials_required,tools_required,task_title,task_description,task_type\n"
        "PV Standard,\"PV modules\\nDC cable set\",\"Crimp tool\\nCable cutter\","
        "Mount modules,Install modules on roof,construction\n"
        "PV Standard,\"PV modules\\nDC cable set\",\"Crimp tool\\nCable cutter\","
        "Commissioning,Prepare handover checklist,office\n"
        "Heat Pump Retrofit,\"Heat pump unit\",\"Vacuum pump\","
        "Install heat pump,Install and pressure test the new unit,construction\n"
    )
    template_import = client.post(
        "/api/admin/project-classes/import-csv",
        headers=auth_headers(admin_token),
        files={"file": ("project-classes.csv", csv_payload.encode("utf-8"), "text/csv")},
    )
    assert template_import.status_code == 200
    assert template_import.json()["classes"] == 2
    assert template_import.json()["task_templates"] == 3

    templates = client.get("/api/project-class-templates", headers=auth_headers(admin_token))
    assert templates.status_code == 200
    template_by_name = {entry["name"]: entry for entry in templates.json()}
    assert "PV Standard" in template_by_name
    assert "Heat Pump Retrofit" in template_by_name
    pv_template_id = template_by_name["PV Standard"]["id"]
    heat_template_id = template_by_name["Heat Pump Retrofit"]["id"]

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-CLS-1",
            "name": "Class based project",
            "status": "active",
            "class_template_ids": [pv_template_id],
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    assigned = client.get(f"/api/projects/{project_id}/class-templates", headers=auth_headers(admin_token))
    assert assigned.status_code == 200
    assert [row["id"] for row in assigned.json()] == [pv_template_id]

    project_tasks = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    assert project_tasks.status_code == 200
    titles = {task["title"] for task in project_tasks.json()}
    assert "Mount modules" in titles
    assert "Commissioning" in titles
    for row in project_tasks.json():
        if row["title"] not in {"Mount modules", "Commissioning"}:
            continue
        assert row["due_date"] is None
        assert row["assignee_id"] is None
        assert row["assignee_ids"] == []
        assert row["class_template_id"] == pv_template_id

    class_based_task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Manual class task",
            "description": "Created manually from class",
            "class_template_id": pv_template_id,
            "status": "open",
        },
    )
    assert class_based_task.status_code == 200
    assert class_based_task.json()["class_template_id"] == pv_template_id
    assert "Materials:" in (class_based_task.json()["materials_required"] or "")
    assert "Tools:" in (class_based_task.json()["materials_required"] or "")

    class_not_assigned = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Wrong class task",
            "class_template_id": heat_template_id,
            "status": "open",
        },
    )
    assert class_not_assigned.status_code == 400


def test_time_tracking_counts_overnight_shift_in_daily_current(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-night@example.com", "employee")
    employee_token = _login(client, "employee-night@example.com")

    clock_in = client.post("/api/time/clock-in", headers=auth_headers(employee_token))
    assert clock_in.status_code == 200
    clock_entry_id = clock_in.json()["clock_entry_id"]

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    yesterday = (now - timedelta(days=1)).date()
    overnight_start = datetime.combine(yesterday, time(hour=22, minute=0))
    patch_response = client.patch(
        f"/api/time/entries/{clock_entry_id}",
        headers=auth_headers(employee_token),
        json={"clock_in": overnight_start.isoformat(), "clock_out": None, "break_minutes": 0},
    )
    assert patch_response.status_code == 200

    current = client.get("/api/time/current", headers=auth_headers(employee_token))
    assert current.status_code == 200
    assert current.json()["clock_entry_id"] == clock_entry_id
    assert current.json()["daily_net_hours"] > 0
    assert current.json()["progress_percent_live"] > 0

    timesheet_daily = client.get("/api/time/timesheet?period=daily", headers=auth_headers(employee_token))
    assert timesheet_daily.status_code == 200
    assert timesheet_daily.json()["total_hours"] > 0


def test_time_tracking_daily_uses_local_timezone_boundaries(
    client: TestClient, admin_token: str, monkeypatch
):
    from app.routers import time_tracking

    fixed_now = datetime(2026, 2, 17, 23, 30, 0)

    monkeypatch.setattr(time_tracking, "utcnow", lambda: fixed_now)

    employee = _create_user(client, admin_token, "employee-timezone@example.com", "employee")
    employee_token = _login(client, "employee-timezone@example.com")

    clock_in = client.post("/api/time/clock-in", headers=auth_headers(employee_token))
    assert clock_in.status_code == 200
    clock_entry_id = clock_in.json()["clock_entry_id"]

    patch_response = client.patch(
        f"/api/time/entries/{clock_entry_id}",
        headers=auth_headers(employee_token),
        json={"clock_in": "2026-02-17T08:00:00", "clock_out": None, "break_minutes": 0},
    )
    assert patch_response.status_code == 200

    current = client.get("/api/time/current", headers=auth_headers(employee_token))
    assert current.status_code == 200
    assert 0 < current.json()["daily_net_hours"] < 2

    timesheet_daily = client.get("/api/time/timesheet?period=daily", headers=auth_headers(employee_token))
    assert timesheet_daily.status_code == 200
    assert 0 < timesheet_daily.json()["total_hours"] < 2


def test_project_files_webdav_mount_flow(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-2001",
            "name": "WebDAV Project",
            "description": "dav",
            "status": "active",
            "customer_name": "Musterkunde",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]
    project_number = project.json()["project_number"]

    employee = _create_user(client, admin_token, "employee-dav-mount@example.com", "employee")
    member = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert member.status_code == 200

    put_response = client.put(
        f"/api/dav/projects/{project_id}/spec.txt",
        auth=("admin@example.com", "ChangeMe123!"),
        data=b"shared spec",
        headers={"Content-Type": "text/plain"},
    )
    assert put_response.status_code == 201

    propfind = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_id}",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert propfind.status_code == 207
    assert "spec.txt" in propfind.text
    assert "<D:getcontentlength>11</D:getcontentlength>" in propfind.text

    propfind_projects_root = client.request(
        "PROPFIND",
        "/api/dav/projects/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert propfind_projects_root.status_code == 207
    assert f"/api/dav/projects/{project_number}/" in propfind_projects_root.text
    assert "Musterkunde" in propfind_projects_root.text

    propfind_trailing_slash = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_id}/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert propfind_trailing_slash.status_code == 207
    assert "spec.txt" in propfind_trailing_slash.text

    get_response = client.get(
        f"/api/dav/projects/{project_id}/spec.txt",
        auth=("admin@example.com", "ChangeMe123!"),
    )
    assert get_response.status_code == 200
    assert get_response.content == b"shared spec"

    employee_propfind_number = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_number}/",
        auth=("employee-dav-mount@example.com", "Password123!"),
        headers={"Depth": "1"},
    )
    assert employee_propfind_number.status_code == 207
    assert "spec.txt" in employee_propfind_number.text

    employee_put_by_number = client.put(
        f"/api/dav/projects/{project_number}/crew-note.txt",
        auth=("employee-dav-mount@example.com", "Password123!"),
        data=b"crew-visible",
        headers={"Content-Type": "text/plain"},
    )
    assert employee_put_by_number.status_code == 201

    admin_get_by_id = client.get(
        f"/api/dav/projects/{project_id}/crew-note.txt",
        auth=("admin@example.com", "ChangeMe123!"),
    )
    assert admin_get_by_id.status_code == 200
    assert admin_get_by_id.content == b"crew-visible"


def test_preview_falls_back_to_octet_stream_for_invalid_stored_content_type(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2002", "name": "Preview MIME", "description": "mime", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    put_response = client.put(
        f"/api/dav/projects/{project_id}/broken-mime.bin",
        auth=("admin@example.com", "ChangeMe123!"),
        data=b"binary payload",
        headers={"Content-Type": "definitely-not-a-mime"},
    )
    assert put_response.status_code == 201

    files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(admin_token))
    assert files.status_code == 200
    uploaded = next((row for row in files.json() if row["file_name"] == "broken-mime.bin"), None)
    assert uploaded is not None

    preview = client.get(f"/api/files/{uploaded['id']}/preview", headers=auth_headers(admin_token))
    assert preview.status_code == 200
    assert preview.content == b"binary payload"
    assert preview.headers.get("content-type", "").startswith("application/octet-stream")


def test_project_file_upload_rejects_empty_payload(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-2003",
            "name": "Empty Upload Guard",
            "description": "files",
            "status": "active",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert upload.status_code == 400
    assert upload.json().get("detail") == "File body is required"


def test_rate_limiter_returns_429_response_without_middleware_exception(client: TestClient):
    _rate_bucket.clear()
    warmup = client.get("/api")
    assert warmup.status_code == 200
    key = next((value for value in _rate_bucket.keys() if value.endswith(":default")), None)
    assert key is not None
    bucket = _rate_bucket[key]
    bucket.clear()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for _ in range(480):
        bucket.append(now)

    limited = client.get("/api")
    assert limited.status_code == 429
    assert limited.json().get("detail") == "Too many requests"
    assert limited.headers.get("Retry-After") == "60"
    _rate_bucket.clear()


def test_webdav_projects_root_respects_project_access(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-dav@example.com", "employee")

    visible_project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2101", "name": "DAV Visible", "description": "visible", "status": "active"},
    )
    assert visible_project.status_code == 200
    visible_project_id = visible_project.json()["id"]
    visible_project_number = visible_project.json()["project_number"]

    hidden_project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2102", "name": "DAV Hidden", "description": "hidden", "status": "active"},
    )
    assert hidden_project.status_code == 200
    hidden_project_number = hidden_project.json()["project_number"]

    member_response = client.post(
        f"/api/projects/{visible_project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert member_response.status_code == 200

    propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/",
        auth=("employee-dav@example.com", "Password123!"),
        headers={"Depth": "1"},
    )
    assert propfind.status_code == 207
    assert f"/api/dav/projects/{visible_project_number}/" in propfind.text
    assert f"/api/dav/projects/{hidden_project_number}/" not in propfind.text


def test_webdav_projects_root_includes_archive_and_general_collections(client: TestClient, admin_token: str):
    active_project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2201", "name": "DAV Active", "description": "active", "status": "active"},
    )
    assert active_project.status_code == 200
    active_project_id = active_project.json()["id"]
    active_project_number = active_project.json()["project_number"]

    archived_project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-2202", "name": "DAV Archived", "description": "archived", "status": "active"},
    )
    assert archived_project.status_code == 200
    archived_project_id = archived_project.json()["id"]
    archived_project_number = archived_project.json()["project_number"]

    archived_status = client.patch(
        f"/api/projects/{archived_project_id}",
        headers=auth_headers(admin_token),
        json={"status": "archived"},
    )
    assert archived_status.status_code == 200

    archived_upload = client.post(
        f"/api/projects/{archived_project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("archived-note.txt", b"archive", "text/plain")},
    )
    assert archived_upload.status_code == 200

    global_report = client.post(
        "/api/construction-reports",
        headers=auth_headers(admin_token),
        json={
            "report_date": "2026-02-20",
            "send_telegram": False,
            "payload": {
                "customer": "General",
                "project_name": "General report",
                "project_number": "",
                "workers": [{"name": "Alex"}],
                "work_done": "General report content",
            },
        },
    )
    assert global_report.status_code == 200
    global_file_name = global_report.json()["attachment_file_name"]

    root_propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert root_propfind.status_code == 207
    assert "/api/dav/projects/general-projects/" in root_propfind.text
    assert "/api/dav/projects/archive/" in root_propfind.text
    assert f"/api/dav/projects/{active_project_number}/" in root_propfind.text
    assert f"/api/dav/projects/{archived_project_number}/" not in root_propfind.text

    archive_propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/archive/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert archive_propfind.status_code == 207
    assert f"/api/dav/projects/archive/{archived_project_id}/" in archive_propfind.text

    archive_project_propfind = client.request(
        "PROPFIND",
        f"/api/dav/projects/archive/{archived_project_id}/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert archive_project_propfind.status_code == 207
    assert "archived-note.txt" in archive_project_propfind.text

    general_propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/general-projects/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert general_propfind.status_code == 207
    assert "Berichte" in general_propfind.text

    general_reports_propfind = client.request(
        "PROPFIND",
        "/api/dav/projects/general-projects/Berichte/",
        auth=("admin@example.com", "ChangeMe123!"),
        headers={"Depth": "1"},
    )
    assert general_reports_propfind.status_code == 207
    assert global_file_name in general_reports_propfind.text


def test_planning_week_calendar_view(client: TestClient, admin_token: str):
    planner = _create_user(client, admin_token, "planner2@example.com", "planning")
    planner_token = _login(client, "planner2@example.com")
    _ = planner

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-3001", "name": "Project Calendar", "description": "calendar", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    assigned = client.post(
        "/api/planning/week/2026-02-16",
        headers=auth_headers(planner_token),
        json=[
            {
                "project_id": project_id,
                "title": "Monday task",
                "description": "",
                "task_type": "construction",
                "status": "open",
                "due_date": "2026-02-16",
                "assignee_id": None,
                "week_start": "2026-02-16",
            },
            {
                "project_id": project_id,
                "title": "Wednesday task",
                "description": "",
                "task_type": "office",
                "status": "open",
                "due_date": "2026-02-18",
                "assignee_id": None,
                "week_start": "2026-02-16",
            },
            {
                "project_id": project_id,
                "title": "Friday appointment",
                "description": "",
                "task_type": "customer_appointment",
                "status": "open",
                "due_date": "2026-02-20",
                "assignee_id": None,
                "week_start": "2026-02-16",
            },
        ],
    )
    assert assigned.status_code == 200

    week = client.get(f"/api/planning/week/2026-02-16?project_id={project_id}", headers=auth_headers(planner_token))
    assert week.status_code == 200
    payload = week.json()
    assert payload["week_start"] == "2026-02-16"
    assert payload["week_end"] == "2026-02-22"
    assert len(payload["days"]) == 7
    monday_tasks = payload["days"][0]["tasks"]
    wednesday_tasks = payload["days"][2]["tasks"]
    friday_tasks = payload["days"][4]["tasks"]
    assert any(task["title"] == "Monday task" for task in monday_tasks)
    assert any(task["title"] == "Wednesday task" for task in wednesday_tasks)
    assert any(task["title"] == "Friday appointment" for task in friday_tasks)
    assert "absences" in payload["days"][0]

    construction_week = client.get(
        f"/api/planning/week/2026-02-16?project_id={project_id}&task_type=construction",
        headers=auth_headers(planner_token),
    )
    assert construction_week.status_code == 200
    construction_tasks = [
        task["title"]
        for day in construction_week.json()["days"]
        for task in day["tasks"]
    ]
    assert "Monday task" in construction_tasks
    assert "Wednesday task" not in construction_tasks

    office_week = client.get(
        f"/api/planning/week/2026-02-16?project_id={project_id}&task_type=office",
        headers=auth_headers(planner_token),
    )
    assert office_week.status_code == 200
    office_tasks = [
        task["title"]
        for day in office_week.json()["days"]
        for task in day["tasks"]
    ]
    assert "Wednesday task" in office_tasks
    assert "Monday task" not in office_tasks
    assert "Friday appointment" not in office_tasks

    appointment_week = client.get(
        f"/api/planning/week/2026-02-16?project_id={project_id}&task_type=customer_appointment",
        headers=auth_headers(planner_token),
    )
    assert appointment_week.status_code == 200
    appointment_tasks = [
        task["title"]
        for day in appointment_week.json()["days"]
        for task in day["tasks"]
    ]
    assert "Friday appointment" in appointment_tasks
    assert "Monday task" not in appointment_tasks
    assert "Wednesday task" not in appointment_tasks


def test_project_files_folder_visibility_and_webdav_structure(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-folders@example.com", "employee")
    employee_token = _login(client, "employee-folders@example.com")

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-5101",
            "name": "Folder Test",
            "description": "folders",
            "status": "active",
            "customer_name": "Folder Kunde",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    member = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert member.status_code == 200

    create_public_folder = client.post(
        f"/api/projects/{project_id}/folders",
        headers=auth_headers(admin_token),
        json={"path": "Bilder/Tag1"},
    )
    assert create_public_folder.status_code == 200
    assert create_public_folder.json()["path"] == "Bilder/Tag1"

    public_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "Bilder/Tag1"},
        files={"file": ("public-note.txt", b"public", "text/plain")},
    )
    assert public_upload.status_code == 200
    assert public_upload.json()["folder"] == "Bilder/Tag1"
    assert public_upload.json()["path"] == "Bilder/Tag1/public-note.txt"

    auto_image_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("photo-auto.jpg", b"photo-bytes", "image/jpeg")},
    )
    assert auto_image_upload.status_code == 200
    assert auto_image_upload.json()["folder"] == "Bilder"

    auto_pdf_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        files={"file": ("report-auto.pdf", b"%PDF-sample", "application/pdf")},
    )
    assert auto_pdf_upload.status_code == 200
    assert auto_pdf_upload.json()["folder"] == "Berichte"

    root_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "/"},
        files={"file": ("root-note.txt", b"root", "text/plain")},
    )
    assert root_upload.status_code == 200
    assert root_upload.json()["folder"] == ""
    assert root_upload.json()["path"] == "root-note.txt"

    protected_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "Verwaltung"},
        files={"file": ("private-note.txt", b"private", "text/plain")},
    )
    assert protected_upload.status_code == 200

    protected_upload_denied = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(employee_token),
        data={"folder": "Verwaltung"},
        files={"file": ("blocked.txt", b"blocked", "text/plain")},
    )
    assert protected_upload_denied.status_code == 403

    employee_files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(employee_token))
    assert employee_files.status_code == 200
    assert all(not str(row["folder"]).startswith("Verwaltung") for row in employee_files.json())
    assert any(str(row["folder"]).startswith("Bilder") for row in employee_files.json())

    admin_files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(admin_token))
    assert admin_files.status_code == 200
    assert any(str(row["folder"]).startswith("Verwaltung") for row in admin_files.json())

    dav_root = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_id}/",
        auth=("employee-folders@example.com", "Password123!"),
        headers={"Depth": "1"},
    )
    assert dav_root.status_code == 207
    assert "Bilder" in dav_root.text
    assert "Verwaltung" not in dav_root.text


def test_webdav_protected_folder_blocks_employee_write_and_direct_access(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-protected-dav@example.com", "employee")

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-5201",
            "name": "Protected DAV",
            "description": "protected",
            "status": "active",
            "customer_name": "Protected Kunde",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    member = client.post(
        f"/api/projects/{project_id}/members",
        headers=auth_headers(admin_token),
        data={"user_id": employee["id"], "can_manage": "false"},
    )
    assert member.status_code == 200

    private_upload = client.post(
        f"/api/projects/{project_id}/files",
        headers=auth_headers(admin_token),
        data={"folder": "Verwaltung"},
        files={"file": ("private-note.txt", b"private data", "text/plain")},
    )
    assert private_upload.status_code == 200

    employee_mkcol_denied = client.request(
        "MKCOL",
        f"/api/dav/projects/{project_id}/Verwaltung/Subfolder",
        auth=("employee-protected-dav@example.com", "Password123!"),
    )
    assert employee_mkcol_denied.status_code == 403

    employee_put_denied = client.put(
        f"/api/dav/projects/{project_id}/Verwaltung/blocked.txt",
        auth=("employee-protected-dav@example.com", "Password123!"),
        data=b"blocked",
        headers={"Content-Type": "text/plain"},
    )
    assert employee_put_denied.status_code == 403

    employee_propfind_hidden = client.request(
        "PROPFIND",
        f"/api/dav/projects/{project_id}/Verwaltung/",
        auth=("employee-protected-dav@example.com", "Password123!"),
        headers={"Depth": "1"},
    )
    assert employee_propfind_hidden.status_code == 404

    employee_get_hidden = client.get(
        f"/api/dav/projects/{project_id}/Verwaltung/private-note.txt",
        auth=("employee-protected-dav@example.com", "Password123!"),
    )
    assert employee_get_hidden.status_code == 404

    admin_get_ok = client.get(
        f"/api/dav/projects/{project_id}/Verwaltung/private-note.txt",
        auth=("admin@example.com", "ChangeMe123!"),
    )
    assert admin_get_ok.status_code == 200
    assert admin_get_ok.content == b"private data"


def test_vacation_and_school_absences_flow(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-absence@example.com", "employee")
    planner = _create_user(client, admin_token, "planner-absence@example.com", "planning")
    accountant = _create_user(client, admin_token, "accountant-absence@example.com", "accountant")
    employee_token = _login(client, "employee-absence@example.com")
    planner_token = _login(client, "planner-absence@example.com")
    accountant_token = _login(client, "accountant-absence@example.com")

    vacation_request = client.post(
        "/api/time/vacation-requests",
        headers=auth_headers(employee_token),
        json={"start_date": "2026-02-17", "end_date": "2026-02-18", "note": "Family trip"},
    )
    assert vacation_request.status_code == 200
    assert vacation_request.json()["status"] == "pending"
    request_id = vacation_request.json()["id"]

    approve = client.patch(
        f"/api/time/vacation-requests/{request_id}",
        headers=auth_headers(admin_token),
        json={"status": "approved"},
    )
    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"

    school_block = client.post(
        "/api/time/school-absences",
        headers=auth_headers(accountant_token),
        json={
            "user_id": employee["id"],
            "title": "Berufsschule",
            "start_date": "2026-02-19",
            "end_date": "2026-02-20",
        },
    )
    assert school_block.status_code == 200

    school_weekly = client.post(
        "/api/time/school-absences",
        headers=auth_headers(accountant_token),
        json={
            "user_id": employee["id"],
            "title": "Schultag",
            "start_date": "2026-02-16",
            "end_date": "2026-02-16",
            "recurrence_weekday": 2,
            "recurrence_until": "2026-03-31",
        },
    )
    assert school_weekly.status_code == 200

    employee_requests = client.get("/api/time/vacation-requests", headers=auth_headers(employee_token))
    assert employee_requests.status_code == 200
    assert any(row["id"] == request_id and row["status"] == "approved" for row in employee_requests.json())

    school_rows = client.get(
        f"/api/time/school-absences?user_id={employee['id']}",
        headers=auth_headers(accountant_token),
    )
    assert school_rows.status_code == 200
    assert len(school_rows.json()) >= 2

    planning_week = client.get("/api/planning/week/2026-02-16", headers=auth_headers(planner_token))
    assert planning_week.status_code == 200
    days = planning_week.json()["days"]
    tuesday_absences = days[1]["absences"]
    wednesday_absences = days[2]["absences"]
    thursday_absences = days[3]["absences"]
    assert any(item["type"] == "vacation" and item["user_id"] == employee["id"] for item in tuesday_absences)
    assert any(item["type"] == "school" and item["user_id"] == employee["id"] for item in wednesday_absences)
    assert any(item["type"] == "school" and item["user_id"] == employee["id"] for item in thursday_absences)


def test_admin_project_csv_template_and_import(client: TestClient, admin_token: str):
    template = client.get("/api/admin/projects/import-template.csv", headers=auth_headers(admin_token))
    assert template.status_code == 200
    assert "project_number" in template.text
    assert "customer_name" in template.text

    csv_payload = (
        "project_number,name,status,customer_name,Notiz\n"
        "7001,CSV Import Projekt,active,CSV Kunde,Importiert\n"
        ",Temp Projekt,in_progress,Temp Kunde,Ohne Nummer\n"
    )
    imported = client.post(
        "/api/admin/projects/import-csv",
        headers=auth_headers(admin_token),
        files={"file": ("projects.csv", csv_payload.encode("utf-8"), "text/csv")},
    )
    assert imported.status_code == 200
    assert imported.json()["processed_rows"] == 2
    assert imported.json()["created"] == 2
    assert imported.json()["temporary_numbers"] == 1

    projects = client.get("/api/projects", headers=auth_headers(admin_token))
    assert projects.status_code == 200
    assert any(entry["project_number"] == "7001" for entry in projects.json())


def test_wiki_pages_crud_and_permissions(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "planner3@example.com", "planning")
    _create_user(client, admin_token, "employee6@example.com", "employee")
    planner_token = _login(client, "planner3@example.com")
    employee_token = _login(client, "employee6@example.com")

    create = client.post(
        "/api/wiki/pages",
        headers=auth_headers(planner_token),
        json={
            "title": "Fronius GEN24 Quick Guide",
            "category": "Inverter",
            "content": "Reset sequence and LED meanings.",
        },
    )
    assert create.status_code == 200
    page = create.json()
    assert page["slug"] == "fronius-gen24-quick-guide"
    page_id = page["id"]

    list_as_employee = client.get("/api/wiki/pages?q=Fronius", headers=auth_headers(employee_token))
    assert list_as_employee.status_code == 200
    assert any(entry["id"] == page_id for entry in list_as_employee.json())

    get_as_employee = client.get(f"/api/wiki/pages/{page_id}", headers=auth_headers(employee_token))
    assert get_as_employee.status_code == 200
    assert get_as_employee.json()["title"] == "Fronius GEN24 Quick Guide"

    employee_create_denied = client.post(
        "/api/wiki/pages",
        headers=auth_headers(employee_token),
        json={"title": "Not allowed", "content": "x"},
    )
    assert employee_create_denied.status_code == 403

    update = client.patch(
        f"/api/wiki/pages/{page_id}",
        headers=auth_headers(planner_token),
        json={"title": "Fronius GEN24 Service Guide", "content": "Updated"},
    )
    assert update.status_code == 200
    assert update.json()["slug"] == "fronius-gen24-service-guide"
    assert update.json()["content"] == "Updated"

    delete = client.delete(f"/api/wiki/pages/{page_id}", headers=auth_headers(planner_token))
    assert delete.status_code == 200
    assert delete.json()["ok"] is True

    gone = client.get(f"/api/wiki/pages/{page_id}", headers=auth_headers(employee_token))
    assert gone.status_code == 404


def test_wiki_library_files_search_and_preview(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "employee7@example.com", "employee")
    employee_token = _login(client, "employee7@example.com")

    wiki_root = os.environ["WIKI_ROOT_DIR"]
    html_rel = "fronius/inverters/gen24/Guide One.html"
    pdf_rel = "fronius/inverters/gen24/Guide One.pdf"
    zip_rel = "fronius/inverters/gen24/Guide One.zip"

    os.makedirs(os.path.join(wiki_root, "fronius", "inverters", "gen24"), exist_ok=True)
    with open(os.path.join(wiki_root, html_rel), "wb") as handle:
        handle.write(b"<html><body><h1>Guide</h1></body></html>")
    with open(os.path.join(wiki_root, pdf_rel), "wb") as handle:
        handle.write(b"%PDF-1.4 fake")
    with open(os.path.join(wiki_root, zip_rel), "wb") as handle:
        handle.write(b"PK fake")

    listed = client.get("/api/wiki/library/files", headers=auth_headers(employee_token))
    assert listed.status_code == 200
    payload = listed.json()
    paths = {entry["path"] for entry in payload}
    assert html_rel in paths
    assert pdf_rel in paths
    assert zip_rel in paths

    html_entry = next(entry for entry in payload if entry["path"] == html_rel)
    zip_entry = next(entry for entry in payload if entry["path"] == zip_rel)
    assert html_entry["previewable"] is True
    assert zip_entry["previewable"] is False

    searched = client.get("/api/wiki/library/files?q=guide%20one", headers=auth_headers(employee_token))
    assert searched.status_code == 200
    searched_paths = {entry["path"] for entry in searched.json()}
    assert html_rel in searched_paths
    assert pdf_rel in searched_paths

    html_raw = client.get(
        f"/api/wiki/library/raw/{quote(html_rel, safe='/')}",
        headers=auth_headers(employee_token),
    )
    assert html_raw.status_code == 200
    assert html_raw.text == "<html><body><h1>Guide</h1></body></html>"
    assert html_raw.headers.get("content-type", "").startswith("text/html")
    assert html_raw.headers.get("content-disposition", "").startswith("inline;")

    html_download = client.get(
        f"/api/wiki/library/raw/{quote(html_rel, safe='/')}?download=1",
        headers=auth_headers(employee_token),
    )
    assert html_download.status_code == 200
    assert html_download.headers.get("content-disposition", "").startswith("attachment;")

    traversal = client.get(
        "/api/wiki/library/raw/%2E%2E/secret.txt",
        headers=auth_headers(employee_token),
    )
    assert traversal.status_code == 400


def test_profile_avatar_upload_and_preview(client: TestClient, admin_token: str):
    created = _create_user(client, admin_token, "avatar-user@example.com", "employee")
    token = _login(client, "avatar-user@example.com")

    upload = client.post(
        "/api/users/me/avatar",
        headers=auth_headers(token),
        files={"file": ("avatar.png", b"fake-png-binary", "image/png")},
    )
    assert upload.status_code == 200
    assert upload.json()["ok"] is True

    me = client.get("/api/auth/me", headers=auth_headers(token))
    assert me.status_code == 200
    assert me.json().get("avatar_updated_at")

    preview = client.get(f"/api/users/{created['id']}/avatar", headers=auth_headers(token))
    assert preview.status_code == 200
    assert preview.content == b"fake-png-binary"
    assert preview.headers.get("content-type", "").startswith("image/")

    invalid_upload = client.post(
        "/api/users/me/avatar",
        headers=auth_headers(token),
        files={"file": ("not-image.txt", b"text", "text/plain")},
    )
    assert invalid_upload.status_code == 400

    delete_avatar = client.delete("/api/users/me/avatar", headers=auth_headers(token))
    assert delete_avatar.status_code == 200
    assert delete_avatar.json()["ok"] is True
    assert delete_avatar.json()["deleted"] is True
    assert delete_avatar.json()["avatar_updated_at"] is None

    me_without_avatar = client.get("/api/auth/me", headers=auth_headers(token))
    assert me_without_avatar.status_code == 200
    assert me_without_avatar.json().get("avatar_updated_at") is None

    preview_after_delete = client.get(f"/api/users/{created['id']}/avatar", headers=auth_headers(token))
    assert preview_after_delete.status_code == 404

    delete_avatar_again = client.delete("/api/users/me/avatar", headers=auth_headers(token))
    assert delete_avatar_again.status_code == 200
    assert delete_avatar_again.json()["deleted"] is False


def test_profile_settings_update_name_email_password(client: TestClient, admin_token: str):
    _create_user(client, admin_token, "profile-user@example.com", "employee")
    token = _login(client, "profile-user@example.com")

    rename_only = client.patch(
        "/api/auth/me",
        headers=auth_headers(token),
        json={"full_name": "Profile User Updated"},
    )
    assert rename_only.status_code == 200
    assert rename_only.json()["full_name"] == "Profile User Updated"

    email_without_password = client.patch(
        "/api/auth/me",
        headers=auth_headers(token),
        json={"email": "profile-user-new@example.com"},
    )
    assert email_without_password.status_code == 403

    update_all = client.patch(
        "/api/auth/me",
        headers=auth_headers(token),
        json={
            "full_name": "Profile User Final",
            "email": "profile-user-new@example.com",
            "current_password": "Password123!",
            "new_password": "Password123!New",
        },
    )
    assert update_all.status_code == 200
    assert update_all.json()["email"] == "profile-user-new@example.com"

    old_login = client.post("/api/auth/login", json={"email": "profile-user@example.com", "password": "Password123!"})
    assert old_login.status_code == 401
    new_login = client.post("/api/auth/login", json={"email": "profile-user-new@example.com", "password": "Password123!New"})
    assert new_login.status_code == 200


def test_admin_invite_and_password_reset_links(client: TestClient, admin_token: str):
    created = _create_user(client, admin_token, "reset-user@example.com", "employee")

    invite = client.post(
        f"/api/admin/users/{created['id']}/send-invite",
        headers=auth_headers(admin_token),
    )
    assert invite.status_code == 200
    invite_payload = invite.json()
    assert invite_payload["user_id"] == created["id"]
    assert "/invite?token=" in invite_payload["invite_link"]
    invite_token = invite_payload["invite_link"].split("token=", 1)[1]

    accept = client.post(
        "/api/auth/invites/accept",
        json={
            "token": invite_token,
            "new_password": "InviteAccept123!",
            "full_name": "Invited Employee",
            "email": "reset-user-updated@example.com",
        },
    )
    assert accept.status_code == 200
    assert accept.json()["invite_accepted_at"] is not None
    assert accept.json()["email"] == "reset-user-updated@example.com"

    login_after_invite = client.post(
        "/api/auth/login",
        json={"email": "reset-user-updated@example.com", "password": "InviteAccept123!"},
    )
    assert login_after_invite.status_code == 200

    reset = client.post(
        f"/api/admin/users/{created['id']}/send-password-reset",
        headers=auth_headers(admin_token),
    )
    assert reset.status_code == 200
    reset_payload = reset.json()
    assert "/reset-password?token=" in reset_payload["reset_link"]
    reset_token = reset_payload["reset_link"].split("token=", 1)[1]

    confirm_reset = client.post(
        "/api/auth/password-reset/confirm",
        json={"token": reset_token, "new_password": "ResetDone123!"},
    )
    assert confirm_reset.status_code == 200
    assert confirm_reset.json()["ok"] is True

    login_after_reset = client.post(
        "/api/auth/login",
        json={"email": "reset-user-updated@example.com", "password": "ResetDone123!"},
    )
    assert login_after_reset.status_code == 200


def test_project_weather_cache_throttle_and_offline_fallback(client: TestClient, admin_token: str, monkeypatch):
    from app.core.db import SessionLocal
    from app.models.entities import ProjectWeatherCache

    settings_update = client.patch(
        "/api/admin/settings/weather",
        headers=auth_headers(admin_token),
        json={"api_key": "owm-weather-key-for-tests"},
    )
    assert settings_update.status_code == 200

    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-WEATHER-1",
            "name": "Weather Project",
            "status": "active",
            "customer_name": "Weather GmbH",
            "customer_address": "Alexanderplatz 1, 10178 Berlin",
        },
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    call_counter = {"count": 0}

    def fake_fetch_openweather_forecast(*, api_key: str, query_address: str, language: str = "en"):
        call_counter["count"] += 1
        assert api_key == "owm-weather-key-for-tests"
        assert query_address == "Alexanderplatz 1, 10178 Berlin"
        assert language == "de"
        return (
            52.520008,
            13.404954,
            [
                {
                    "date": "2026-02-23",
                    "temp_min": 2.1,
                    "temp_max": 7.8,
                    "description": "leicht bewoelkt",
                    "icon": "03d",
                    "precipitation_probability": 20.0,
                    "wind_speed": 3.7,
                }
            ]
            * 5,
        )

    monkeypatch.setattr(workflow_router, "_fetch_openweather_forecast", fake_fetch_openweather_forecast)

    first = client.get(f"/api/projects/{project_id}/weather?refresh=true&lang=de", headers=auth_headers(admin_token))
    assert first.status_code == 200
    first_payload = first.json()
    assert first_payload["from_cache"] is False
    assert first_payload["stale"] is False
    assert len(first_payload["days"]) == 5

    second = client.get(f"/api/projects/{project_id}/weather?refresh=true&lang=de", headers=auth_headers(admin_token))
    assert second.status_code == 200
    second_payload = second.json()
    assert second_payload["from_cache"] is True
    assert call_counter["count"] == 1

    with SessionLocal() as db:
        cache_row = db.get(ProjectWeatherCache, project_id)
        assert cache_row is not None
        cache_row.fetched_at = datetime.now(timezone.utc) - timedelta(minutes=16)
        db.add(cache_row)
        db.commit()

    def failing_fetch_openweather_forecast(*, api_key: str, query_address: str, language: str = "en"):
        raise RuntimeError("network offline")

    monkeypatch.setattr(workflow_router, "_fetch_openweather_forecast", failing_fetch_openweather_forecast)

    third = client.get(f"/api/projects/{project_id}/weather?refresh=true&lang=de", headers=auth_headers(admin_token))
    assert third.status_code == 200
    third_payload = third.json()
    assert third_payload["from_cache"] is True
    assert third_payload["stale"] is True
    assert len(third_payload["days"]) == 5
    assert "cached" in (third_payload.get("message") or "").lower()


def test_weather_address_candidates_normalize_and_add_country_fallbacks():
    candidates = workflow_router._weather_address_candidates("Nolsenstr. 62,\n58452   Witten")
    assert candidates
    assert candidates[0] == "Nolsenstr. 62, 58452 Witten"
    assert "Nolsenstr. 62, 58452 Witten, Deutschland" in candidates
    assert "Nolsenstr. 62, 58452 Witten, Germany" in candidates


def test_weather_zip_candidates_extracts_postal_code():
    candidates = workflow_router._weather_zip_candidates("Stockumer Straße 65, Annen, 58453 Witten, Germany")
    assert candidates == ["58453,DE"]
