from __future__ import annotations
from datetime import datetime, time, timedelta, timezone
import json
import os
from fastapi.testclient import TestClient
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
    archived_candidate = _create_user(client, admin_token, "employee6@example.com", "employee")
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
            "subtasks": ["Mount frame", "Connect inverter", "Test output"],
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
    assert created_task.json()["subtasks"] == ["Mount frame", "Connect inverter", "Test output"]
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
    assert admin_updates_task.json()["subtasks"] == ["Mount frame", "Connect inverter", "Test output"]
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

    participant_users = client.get("/api/threads/participant-users", headers=auth_headers(employee_token))
    assert participant_users.status_code == 200
    participant_user_ids = {row["id"] for row in participant_users.json()}
    assert employee["id"] in participant_user_ids
    assert employee_b["id"] in participant_user_ids
    assert archived_candidate["id"] in participant_user_ids

    participant_roles = client.get("/api/threads/participant-roles", headers=auth_headers(employee_token))
    assert participant_roles.status_code == 200
    participant_role_values = set(participant_roles.json())
    assert "employee" in participant_role_values
    assert "accountant" in participant_role_values

    restricted_thread = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={
            "name": "Restricted Crew Chat",
            "participant_user_ids": [employee_b["id"]],
            "participant_roles": ["accountant"],
        },
    )
    assert restricted_thread.status_code == 200
    restricted_thread_id = restricted_thread.json()["id"]
    assert restricted_thread.json()["visibility"] == "restricted"
    assert restricted_thread.json()["is_restricted"] is True
    assert restricted_thread.json()["participant_user_ids"] == sorted([employee["id"], employee_b["id"]])
    assert restricted_thread.json()["participant_roles"] == ["accountant"]

    archived_member_thread = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={"name": "Archive-safe thread", "participant_user_ids": [archived_candidate["id"]]},
    )
    assert archived_member_thread.status_code == 200
    archived_member_thread_id = archived_member_thread.json()["id"]

    threads = client.get("/api/threads", headers=auth_headers(employee_token))
    assert threads.status_code == 200
    thread_names = {entry["name"] for entry in threads.json()}
    assert "General Team Chat" in thread_names
    assert "Project A Chat" in thread_names
    assert "Restricted Crew Chat" in thread_names
    assert "Latest Construction Reports" not in thread_names

    threads_for_employee_b = client.get("/api/threads", headers=auth_headers(employee_b_token))
    assert threads_for_employee_b.status_code == 200
    names_for_employee_b = {entry["name"] for entry in threads_for_employee_b.json()}
    assert "Restricted Crew Chat" in names_for_employee_b

    threads_for_accountant = client.get("/api/threads", headers=auth_headers(accountant_token))
    assert threads_for_accountant.status_code == 200
    names_for_accountant = {entry["name"] for entry in threads_for_accountant.json()}
    assert "Restricted Crew Chat" in names_for_accountant

    outsider_threads = client.get("/api/threads", headers=auth_headers(outsider_token))
    assert outsider_threads.status_code == 200
    outsider_names = {entry["name"] for entry in outsider_threads.json()}
    assert "Restricted Crew Chat" not in outsider_names

    restricted_update_add_outsider = client.patch(
        f"/api/threads/{restricted_thread_id}",
        headers=auth_headers(employee_token),
        json={
            "name": "Restricted Crew Chat",
            "participant_user_ids": [employee_b["id"], outsider["id"]],
            "participant_roles": ["accountant"],
            "participant_group_ids": [],
        },
    )
    assert restricted_update_add_outsider.status_code == 200
    updated_user_ids = set(restricted_update_add_outsider.json()["participant_user_ids"])
    assert updated_user_ids == {employee["id"], employee_b["id"], outsider["id"]}

    outsider_threads_after_add = client.get("/api/threads", headers=auth_headers(outsider_token))
    assert outsider_threads_after_add.status_code == 200
    outsider_names_after_add = {entry["name"] for entry in outsider_threads_after_add.json()}
    assert "Restricted Crew Chat" in outsider_names_after_add

    restricted_update_remove_outsider = client.patch(
        f"/api/threads/{restricted_thread_id}",
        headers=auth_headers(employee_token),
        json={
            "name": "Restricted Crew Chat",
            "participant_user_ids": [employee_b["id"]],
            "participant_roles": ["accountant"],
            "participant_group_ids": [],
        },
    )
    assert restricted_update_remove_outsider.status_code == 200

    outsider_threads_after_remove = client.get("/api/threads", headers=auth_headers(outsider_token))
    assert outsider_threads_after_remove.status_code == 200
    outsider_names_after_remove = {entry["name"] for entry in outsider_threads_after_remove.json()}
    assert "Restricted Crew Chat" not in outsider_names_after_remove

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

    archive_thread_denied = client.post(
        f"/api/threads/{employee_thread_id}/archive",
        headers=auth_headers(employee_b_token),
    )
    assert archive_thread_denied.status_code == 403

    archive_thread_ok = client.post(
        f"/api/threads/{employee_thread_id}/archive",
        headers=auth_headers(employee_token),
    )
    assert archive_thread_ok.status_code == 200
    assert archive_thread_ok.json()["is_archived"] is True
    assert archive_thread_ok.json()["status"] == "archived"

    threads_after_archive = client.get("/api/threads", headers=auth_headers(employee_token))
    assert threads_after_archive.status_code == 200
    assert all(entry["id"] != employee_thread_id for entry in threads_after_archive.json())

    threads_with_archive = client.get("/api/threads?include_archived=true", headers=auth_headers(employee_token))
    assert threads_with_archive.status_code == 200
    archived_entry = next((entry for entry in threads_with_archive.json() if entry["id"] == employee_thread_id), None)
    assert archived_entry is not None
    assert archived_entry["is_archived"] is True

    archived_thread_send = client.post(
        f"/api/threads/{employee_thread_id}/messages",
        headers=auth_headers(employee_token),
        data={"body": "Should fail on archived"},
    )
    assert archived_thread_send.status_code == 409

    restore_thread_denied = client.post(
        f"/api/threads/{employee_thread_id}/restore",
        headers=auth_headers(employee_b_token),
    )
    assert restore_thread_denied.status_code == 403

    restore_thread_ok = client.post(
        f"/api/threads/{employee_thread_id}/restore",
        headers=auth_headers(employee_token),
    )
    assert restore_thread_ok.status_code == 200
    assert restore_thread_ok.json()["is_archived"] is False
    assert restore_thread_ok.json()["status"] == "active"

    threads_after_restore = client.get("/api/threads", headers=auth_headers(employee_token))
    assert threads_after_restore.status_code == 200
    assert any(entry["id"] == employee_thread_id for entry in threads_after_restore.json())

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

    restricted_message = client.post(
        f"/api/threads/{restricted_thread_id}/messages",
        headers=auth_headers(employee_token),
        data={"body": "Private update"},
    )
    assert restricted_message.status_code == 200

    restricted_denied_read = client.get(
        f"/api/threads/{restricted_thread_id}/messages",
        headers=auth_headers(outsider_token),
    )
    assert restricted_denied_read.status_code == 403

    restricted_denied_send = client.post(
        f"/api/threads/{restricted_thread_id}/messages",
        headers=auth_headers(outsider_token),
        data={"body": "Should not pass"},
    )
    assert restricted_denied_send.status_code == 403

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

    delete_thread_denied = client.delete(
        f"/api/threads/{employee_thread_id}",
        headers=auth_headers(employee_b_token),
    )
    assert delete_thread_denied.status_code == 403

    delete_thread_ok = client.delete(
        f"/api/threads/{employee_thread_id}",
        headers=auth_headers(employee_token),
    )
    assert delete_thread_ok.status_code == 200
    assert delete_thread_ok.json()["ok"] is True

    threads_after_thread_delete = client.get("/api/threads", headers=auth_headers(employee_token))
    assert threads_after_thread_delete.status_code == 200
    assert all(entry["id"] != employee_thread_id for entry in threads_after_thread_delete.json())

    deleted_thread_messages = client.get(
        f"/api/threads/{employee_thread_id}/messages",
        headers=auth_headers(employee_token),
    )
    assert deleted_thread_messages.status_code == 404

    archive_user = client.delete(f"/api/admin/users/{archived_candidate['id']}", headers=auth_headers(admin_token))
    assert archive_user.status_code == 200

    participant_users_after_archive = client.get("/api/threads/participant-users", headers=auth_headers(employee_token))
    assert participant_users_after_archive.status_code == 200
    participant_ids_after_archive = {row["id"] for row in participant_users_after_archive.json()}
    assert archived_candidate["id"] not in participant_ids_after_archive

    archived_member_thread_update = client.patch(
        f"/api/threads/{archived_member_thread_id}",
        headers=auth_headers(employee_token),
        json={
            "name": "Archive-safe thread updated",
            "participant_user_ids": [archived_candidate["id"]],
            "participant_roles": [],
            "participant_group_ids": [],
        },
    )
    assert archived_member_thread_update.status_code == 200
    assert archived_candidate["id"] in archived_member_thread_update.json()["participant_user_ids"]

    archived_user_restricted = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={"name": "Archived participant thread", "participant_user_ids": [archived_candidate["id"]]},
    )
    assert archived_user_restricted.status_code == 400

    invalid_role_restricted = client.post(
        "/api/threads",
        headers=auth_headers(employee_token),
        json={"name": "Invalid role thread", "participant_roles": ["not-a-real-role"]},
    )
    assert invalid_role_restricted.status_code == 400

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
    assert autofill_report.json()["report_number"] == 1

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
                "source_task_id": created_task_id,
                "completed_subtasks": ["Mount frame", "Test output"],
            },
        },
    )
    assert report.status_code == 200
    data = report.json()
    assert data["report_number"] == 2
    assert data["processing_status"] == "completed"
    assert data["telegram_mode"] == "stub"
    assert data["attachment_file_name"].endswith(".pdf")
    follow_up_task_id = data["follow_up_task_id"]
    assert follow_up_task_id is not None
    assert data["follow_up_subtask_count"] == 1
    processing_status = client.get(
        f"/api/construction-reports/{data['id']}/processing",
        headers=auth_headers(employee_token),
    )
    assert processing_status.status_code == 200
    assert processing_status.json()["processing_status"] == "completed"
    assert processing_status.json()["report_number"] == 2

    tasks_after_report = client.get(
        f"/api/tasks?view=all_open&project_id={project_id}",
        headers=auth_headers(admin_token),
    )
    assert tasks_after_report.status_code == 200
    follow_up_task = next((entry for entry in tasks_after_report.json() if entry["id"] == follow_up_task_id), None)
    assert follow_up_task is not None
    assert follow_up_task["title"].startswith("Install inverter + meter")
    assert follow_up_task["subtasks"] == ["Connect inverter"]
    assert follow_up_task["assignee_ids"] == []

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

    material_available_update = client.patch(
        f"/api/materials/{material_item['id']}",
        headers=auth_headers(employee_token),
        json={"status": "available"},
    )
    assert material_available_update.status_code == 200
    assert material_available_update.json()["status"] == "available"

    material_completed_update = client.patch(
        f"/api/materials/{material_item['id']}",
        headers=auth_headers(employee_token),
        json={"status": "completed"},
    )
    assert material_completed_update.status_code == 200
    assert material_completed_update.json()["status"] == "completed"

    materials_queue_after_complete = client.get("/api/materials", headers=auth_headers(employee_token))
    assert materials_queue_after_complete.status_code == 200
    assert all(entry["id"] != material_item["id"] for entry in materials_queue_after_complete.json())

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
    office_notes = project_overview_after_report.json()["office_notes"]
    assert len(office_notes) >= 1
    assert office_notes[0]["report_id"] == data["id"]
    assert office_notes[0]["office_rework"] == "No rework needed"
    assert office_notes[0]["office_next_steps"] == "Switchboard wiring"

    project_files = client.get(f"/api/projects/{project_id}/files", headers=auth_headers(employee_token))
    assert project_files.status_code == 200
    report_file = next((entry for entry in project_files.json() if entry["file_name"] == data["attachment_file_name"]), None)
    assert report_file is not None
    assert report_file["content_type"] == "application/pdf"
    assert report_file["folder"] == "Berichte"

    report_download = client.get(f"/api/files/{report_file['id']}/download", headers=auth_headers(employee_token))
    assert report_download.status_code == 200
    assert report_download.content.startswith(b"%PDF")

    report_feed_threads = client.get("/api/threads", headers=auth_headers(employee_token))
    assert report_feed_threads.status_code == 200
    report_feed = next((entry for entry in report_feed_threads.json() if entry["name"] == "Latest Construction Reports"), None)
    assert report_feed is not None
    assert report_feed["project_id"] is None

    report_feed_messages = client.get(
        f"/api/threads/{report_feed['id']}/messages",
        headers=auth_headers(employee_token),
    )
    assert report_feed_messages.status_code == 200
    feed_message_for_report = next(
        (
            entry
            for entry in report_feed_messages.json()
            if str(entry.get("body") or "").find(f"#{data['report_number']}") >= 0
        ),
        None,
    )
    assert feed_message_for_report is not None
    assert "Project 2026-1001A - Project A" in str(feed_message_for_report.get("body") or "")
    assert len(feed_message_for_report["attachments"]) >= 1
    feed_attachment_id = int(feed_message_for_report["attachments"][0]["id"])
    assert feed_attachment_id == report_file["id"]

    outsider_feed_preview = client.get(f"/api/files/{feed_attachment_id}/preview", headers=auth_headers(outsider_token))
    assert outsider_feed_preview.status_code == 200
    assert outsider_feed_preview.content.startswith(b"%PDF")

    delete_report_feed = client.delete(f"/api/threads/{report_feed['id']}", headers=auth_headers(admin_token))
    assert delete_report_feed.status_code == 403

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
                    "materials": [{"item": " cable ", "qty": "2,5", "unit": "m", "article_no": "A1"}],
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
    multipart_payload = multipart_report.json()
    assert multipart_payload["report_number"] == 3
    assert len(multipart_payload["report_images"]) == 2

    project_report_files = client.get(
        f"/api/construction-reports/files?project_id={project_id}",
        headers=auth_headers(employee_token),
    )
    assert project_report_files.status_code == 200
    assert any(entry["file_name"] == data["attachment_file_name"] for entry in project_report_files.json())
    assert any(
        entry["file_name"] == "report-0003-photo-001.jpg" and str(entry.get("folder") or "").startswith("Bilder")
        for entry in project_report_files.json()
    )
    assert any(
        entry["file_name"] == "report-0003-photo-002.jpg" and str(entry.get("folder") or "").startswith("Bilder")
        for entry in project_report_files.json()
    )

    project_finance_after_multipart_report = client.get(
        f"/api/projects/{project_id}/finance",
        headers=auth_headers(employee_token),
    )
    assert project_finance_after_multipart_report.status_code == 200
    assert project_finance_after_multipart_report.json()["reported_hours_total"] == 17.0

    project_materials_summary = client.get(
        f"/api/projects/{project_id}/materials",
        headers=auth_headers(employee_token),
    )
    assert project_materials_summary.status_code == 200
    material_summary_entry = next(
        (
            entry
            for entry in project_materials_summary.json()
            if entry["item"] == "Cable" and entry.get("unit") == "m" and entry.get("article_no") == "A1"
        ),
        None,
    )
    assert material_summary_entry is not None
    assert material_summary_entry["quantity_total"] == 12.5
    assert material_summary_entry["occurrence_count"] == 2
    assert material_summary_entry["report_count"] == 2

    project_materials_summary_denied = client.get(
        f"/api/projects/{project_id}/materials",
        headers=auth_headers(outsider_token),
    )
    assert project_materials_summary_denied.status_code == 403

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
    assert global_payload["report_number"] is None
    assert global_payload["processing_status"] == "completed"
    assert global_payload["attachment_file_name"].endswith(".pdf")

    global_reports = client.get("/api/construction-reports", headers=auth_headers(employee_token))
    assert global_reports.status_code == 200
    assert any(entry["id"] == global_payload["id"] and entry["project_id"] is None for entry in global_reports.json())

    threads_after_global_report = client.get("/api/threads", headers=auth_headers(employee_token))
    assert threads_after_global_report.status_code == 200
    assert len(threads_after_global_report.json()) >= 1
    assert threads_after_global_report.json()[0]["name"] == "Latest Construction Reports"

    recent_reports = client.get("/api/construction-reports/recent?limit=10", headers=auth_headers(employee_token))
    assert recent_reports.status_code == 200
    recent_payload = recent_reports.json()
    assert len(recent_payload) >= 3
    assert recent_payload[0]["id"] == global_payload["id"]
    assert any(
        entry["id"] == data["id"]
        and entry["project_id"] == project_id
        and entry["attachment_id"] == report_file["id"]
        for entry in recent_payload
    )

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
