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
