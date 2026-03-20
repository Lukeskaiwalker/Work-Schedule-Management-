from __future__ import annotations
from datetime import datetime, time, timedelta, timezone
import json
import os
from fastapi.testclient import TestClient
from app.routers import workflow_helpers
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

def test_task_overdue_flag_and_optional_due_date(client: TestClient, admin_token: str):
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-3002", "name": "Project Overdue", "description": "overdue", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    today = datetime.now(timezone.utc).date()
    yesterday_iso = (today - timedelta(days=1)).isoformat()
    tomorrow_iso = (today + timedelta(days=1)).isoformat()

    overdue_task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Open overdue task",
            "status": "open",
            "due_date": yesterday_iso,
        },
    )
    assert overdue_task.status_code == 200
    assert overdue_task.json()["status"] == "open"
    assert overdue_task.json()["is_overdue"] is True

    no_due_date_task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Task without due date",
            "status": "open",
            "due_date": None,
        },
    )
    assert no_due_date_task.status_code == 200
    assert no_due_date_task.json()["due_date"] is None
    assert no_due_date_task.json()["is_overdue"] is False

    future_task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Open future task",
            "status": "open",
            "due_date": tomorrow_iso,
        },
    )
    assert future_task.status_code == 200
    assert future_task.json()["is_overdue"] is False

    done_past_task = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Done past task",
            "status": "done",
            "due_date": yesterday_iso,
        },
    )
    assert done_past_task.status_code == 200
    assert done_past_task.json()["is_overdue"] is False

    open_tasks = client.get("/api/tasks?view=all_open", headers=auth_headers(admin_token))
    assert open_tasks.status_code == 200
    open_by_title = {row["title"]: row for row in open_tasks.json()}
    assert open_by_title["Open overdue task"]["is_overdue"] is True
    assert open_by_title["Task without due date"]["is_overdue"] is False
    assert open_by_title["Open future task"]["is_overdue"] is False

    completed_tasks = client.get("/api/tasks?view=completed", headers=auth_headers(admin_token))
    assert completed_tasks.status_code == 200
    completed_by_title = {row["title"]: row for row in completed_tasks.json()}
    assert completed_by_title["Done past task"]["is_overdue"] is False


def test_task_duration_returns_end_time(client: TestClient, admin_token: str):
    worker = _create_user(client, admin_token, "worker-duration@example.com", "employee")
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-3003", "name": "Project Duration", "description": "duration", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    created = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Duration task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "08:30",
            "estimated_hours": 1.5,
            "assignee_ids": [worker["id"]],
        },
    )
    assert created.status_code == 200
    payload = created.json()
    assert payload["estimated_hours"] == 1.5
    assert payload["end_time"] == "10:00:00"

    listed = client.get("/api/tasks?view=all_open", headers=auth_headers(admin_token))
    assert listed.status_code == 200
    by_title = {row["title"]: row for row in listed.json()}
    assert by_title["Duration task"]["end_time"] == "10:00:00"


def test_overlapping_task_requires_confirmation(client: TestClient, admin_token: str):
    worker = _create_user(client, admin_token, "worker-overlap@example.com", "employee")
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-3004", "name": "Project Overlap", "description": "overlap", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    first = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "First task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "08:00",
            "estimated_hours": 2.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert first.status_code == 200

    overlapping = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Second task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "09:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert overlapping.status_code == 409
    detail = overlapping.json()["detail"]
    assert detail["code"] == "task_overlap"
    assert detail["overlaps"][0]["title"] == "First task"
    assert detail["overlaps"][0]["shared_assignee_ids"] == [worker["id"]]

    confirmed = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Second task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "09:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
            "confirm_overlap": True,
        },
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["title"] == "Second task"


def test_overlap_check_skips_other_assignees(client: TestClient, admin_token: str):
    first_worker = _create_user(client, admin_token, "worker-a@example.com", "employee")
    second_worker = _create_user(client, admin_token, "worker-b@example.com", "employee")
    project = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": "2026-3005", "name": "Project Parallel", "description": "parallel", "status": "active"},
    )
    assert project.status_code == 200
    project_id = project.json()["id"]

    first = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Task A",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "08:00",
            "estimated_hours": 2.0,
            "assignee_ids": [first_worker["id"]],
        },
    )
    assert first.status_code == 200

    second = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_id,
            "title": "Task B",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "09:00",
            "estimated_hours": 1.0,
            "assignee_ids": [second_worker["id"]],
        },
    )
    assert second.status_code == 200


def test_back_to_back_tasks_require_travel_buffer_confirmation(client: TestClient, admin_token: str, monkeypatch):
    worker = _create_user(client, admin_token, "worker-travel@example.com", "employee")
    project_a = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-3006",
            "name": "Project A",
            "description": "travel-a",
            "status": "active",
            "construction_site_address": "Baustelle A 1, 10115 Berlin",
        },
    )
    assert project_a.status_code == 200
    project_a_id = project_a.json()["id"]

    project_b = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-3007",
            "name": "Project B",
            "description": "travel-b",
            "status": "active",
            "construction_site_address": "Baustelle B 1, 10969 Berlin",
        },
    )
    assert project_b.status_code == 200
    project_b_id = project_b.json()["id"]

    monkeypatch.setattr(
        workflow_helpers,
        "_estimate_travel_minutes_between_projects",
        lambda db, from_project_id, to_project_id: 25 if from_project_id != to_project_id else 0,
    )

    first = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_a_id,
            "title": "Early task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "08:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert first.status_code == 200

    second = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_b_id,
            "title": "Follow-up task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "09:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert second.status_code == 409
    detail = second.json()["detail"]
    assert detail["code"] == "task_overlap"
    assert detail["overlaps"][0]["title"] == "Early task"
    assert detail["overlaps"][0]["overlap_type"] == "travel_overlap"
    assert detail["overlaps"][0]["travel_minutes"] == 25

    confirmed = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_b_id,
            "title": "Follow-up task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "09:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
            "confirm_overlap": True,
        },
    )
    assert confirmed.status_code == 200


def test_back_to_back_tasks_use_address_fallback_travel_estimate(client: TestClient, admin_token: str):
    worker = _create_user(client, admin_token, "worker-travel-fallback@example.com", "employee")
    project_a = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-3010",
            "name": "Fallback Project A",
            "description": "travel-fallback-a",
            "status": "active",
            "construction_site_address": "Alphaweg 1, 10115 Berlin",
        },
    )
    assert project_a.status_code == 200
    project_a_id = project_a.json()["id"]

    project_b = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-3011",
            "name": "Fallback Project B",
            "description": "travel-fallback-b",
            "status": "active",
            "construction_site_address": "Betaweg 5, 10115 Berlin",
        },
    )
    assert project_b.status_code == 200
    project_b_id = project_b.json()["id"]

    first = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_a_id,
            "title": "Fallback early task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "08:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert first.status_code == 200

    second = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_b_id,
            "title": "Fallback follow-up task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "09:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert second.status_code == 409
    detail = second.json()["detail"]
    assert detail["code"] == "task_overlap"
    assert detail["overlaps"][0]["title"] == "Fallback early task"
    assert detail["overlaps"][0]["overlap_type"] == "travel_overlap"
    assert detail["overlaps"][0]["travel_minutes"] == 12


def test_planning_assign_week_checks_travel_overlap(client: TestClient, admin_token: str):
    planner = _create_user(client, admin_token, "planner-travel-week@example.com", "planning")
    worker = _create_user(client, admin_token, "worker-travel-week@example.com", "employee")
    planner_token = _login(client, "planner-travel-week@example.com")
    _ = planner

    project_a = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-3012",
            "name": "Planning Travel A",
            "description": "planning-travel-a",
            "status": "active",
            "construction_site_address": "Alphaweg 1, 10115 Berlin",
        },
    )
    assert project_a.status_code == 200
    project_a_id = project_a.json()["id"]

    project_b = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "2026-3013",
            "name": "Planning Travel B",
            "description": "planning-travel-b",
            "status": "active",
            "customer_address": "Betaweg 5, 10115 Berlin",
        },
    )
    assert project_b.status_code == 200
    project_b_id = project_b.json()["id"]

    first = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project_a_id,
            "title": "Planning base task",
            "status": "open",
            "due_date": "2026-03-19",
            "start_time": "08:00",
            "estimated_hours": 1.0,
            "assignee_ids": [worker["id"]],
        },
    )
    assert first.status_code == 200

    assigned = client.post(
        "/api/planning/week/2026-03-16",
        headers=auth_headers(planner_token),
        json=[
            {
                "project_id": project_b_id,
                "title": "Planning follow-up task",
                "status": "open",
                "due_date": "2026-03-19",
                "start_time": "09:00",
                "estimated_hours": 1.0,
                "assignee_ids": [worker["id"]],
            }
        ],
    )
    assert assigned.status_code == 409
    detail = assigned.json()["detail"]
    assert detail["code"] == "task_overlap"
    assert detail["assignment_index"] == 0
    assert detail["overlaps"][0]["overlap_type"] == "travel_overlap"
    assert detail["overlaps"][0]["travel_minutes"] == 12
