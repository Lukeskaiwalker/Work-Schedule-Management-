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
