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

    update_vacation_balance = client.patch(
        f"/api/time/vacation-balance/{employee['id']}",
        headers=auth_headers(admin_token),
        json={
            "vacation_days_per_year": 30,
            "vacation_days_available": 18,
            "vacation_days_carryover": 3,
        },
    )
    assert update_vacation_balance.status_code == 200
    assert update_vacation_balance.json()["vacation_days_per_year"] == 30
    assert update_vacation_balance.json()["vacation_days_available"] == 18
    assert update_vacation_balance.json()["vacation_days_carryover"] == 3
    assert update_vacation_balance.json()["vacation_days_total_remaining"] == 21

    audit_logs = client.get("/api/admin/audit-logs", headers=auth_headers(admin_token))
    assert audit_logs.status_code == 200
    assert any(
        row["action"] == "time.vacation_balance_manual_update"
        and row["category"] == "time"
        and row["target_id"] == str(employee["id"])
        and row["details"]["after"]["vacation_days_available"] == 18
        and row["details"]["after"]["vacation_days_carryover"] == 3
        and row["details"]["after"]["vacation_days_total_remaining"] == 21
        for row in audit_logs.json()
    )

    clock_in = client.post("/api/time/clock-in", headers=auth_headers(employee_token))
    assert clock_in.status_code == 200
    clock_entry_id = clock_in.json()["clock_entry_id"]

    current = client.get("/api/time/current", headers=auth_headers(employee_token))
    assert current.status_code == 200
    assert current.json()["clock_entry_id"] == clock_entry_id
    assert current.json()["required_daily_hours"] == 7.25
    assert current.json()["vacation_days_per_year"] == 30
    assert current.json()["vacation_days_available"] == 18
    assert current.json()["vacation_days_carryover"] == 3
    assert current.json()["vacation_days_total_remaining"] == 21
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


def test_vacation_balance_initializes_and_rolls_over_yearly(
    client: TestClient,
    admin_token: str,
    monkeypatch,
):
    from app.routers import time_tracking

    monkeypatch.setattr(time_tracking, "utcnow", lambda: datetime(2026, 1, 15, 10, 0, 0))

    employee = _create_user(client, admin_token, "employee-vacation-rollover@example.com", "employee")
    employee_token = _login(client, "employee-vacation-rollover@example.com")

    first_setup = client.patch(
        f"/api/time/vacation-balance/{employee['id']}",
        headers=auth_headers(admin_token),
        json={
            "vacation_days_per_year": 30,
            "vacation_days_available": 0,
            "vacation_days_carryover": 0,
        },
    )
    assert first_setup.status_code == 200
    assert first_setup.json()["vacation_days_available"] == 30
    assert first_setup.json()["vacation_days_carryover"] == 0
    assert first_setup.json()["vacation_days_total_remaining"] == 30

    year_end_state = client.patch(
        f"/api/time/vacation-balance/{employee['id']}",
        headers=auth_headers(admin_token),
        json={
            "vacation_days_per_year": 30,
            "vacation_days_available": 18,
            "vacation_days_carryover": 2,
        },
    )
    assert year_end_state.status_code == 200

    monkeypatch.setattr(time_tracking, "utcnow", lambda: datetime(2027, 1, 2, 9, 0, 0))

    rolled_balance = client.get("/api/time/current", headers=auth_headers(employee_token))
    assert rolled_balance.status_code == 200
    assert rolled_balance.json()["vacation_days_per_year"] == 30
    assert rolled_balance.json()["vacation_days_available"] == 30
    assert rolled_balance.json()["vacation_days_carryover"] == 18
    assert rolled_balance.json()["vacation_days_total_remaining"] == 48

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

    vacation_balance = client.patch(
        f"/api/time/vacation-balance/{employee['id']}",
        headers=auth_headers(admin_token),
        json={
            "vacation_days_per_year": 30,
            "vacation_days_available": 20,
            "vacation_days_carryover": 3,
        },
    )
    assert vacation_balance.status_code == 200

    vacation_request = client.post(
        "/api/time/vacation-requests",
        headers=auth_headers(employee_token),
        json={"start_date": "2026-02-17", "end_date": "2026-02-18", "note": "Family trip"},
    )
    assert vacation_request.status_code == 200
    assert vacation_request.json()["status"] == "pending"
    assert vacation_request.json()["vacation_days_used"] == 2
    request_id = vacation_request.json()["id"]

    approve = client.patch(
        f"/api/time/vacation-requests/{request_id}",
        headers=auth_headers(admin_token),
        json={"status": "approved"},
    )
    assert approve.status_code == 200
    assert approve.json()["status"] == "approved"
    assert approve.json()["vacation_days_used"] == 2

    current_after_approval = client.get("/api/time/current", headers=auth_headers(employee_token))
    assert current_after_approval.status_code == 200
    assert current_after_approval.json()["vacation_days_carryover"] == 1
    assert current_after_approval.json()["vacation_days_available"] == 20
    assert current_after_approval.json()["vacation_days_total_remaining"] == 21

    users_after_approval = client.get("/api/admin/users", headers=auth_headers(admin_token))
    assert users_after_approval.status_code == 200
    approved_employee_row = next(row for row in users_after_approval.json() if row["id"] == employee["id"])
    assert approved_employee_row["vacation_days_carryover"] == 1
    assert approved_employee_row["vacation_days_available"] == 20
    assert approved_employee_row["vacation_days_total_remaining"] == 21

    holiday_aware_request = client.post(
        "/api/time/vacation-requests",
        headers=auth_headers(employee_token),
        json={"start_date": "2026-04-30", "end_date": "2026-05-04", "note": "Bridge days"},
    )
    assert holiday_aware_request.status_code == 200
    assert holiday_aware_request.json()["vacation_days_used"] == 2

    school_block = client.post(
        "/api/time/school-absences",
        headers=auth_headers(accountant_token),
        json={
            "user_id": employee["id"],
            "title": "Berufsschule",
            "absence_type": "school",
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
            "absence_type": "school",
            "start_date": "2026-02-16",
            "end_date": "2026-02-16",
            "recurrence_weekday": 2,
            "recurrence_until": "2026-03-31",
        },
    )
    assert school_weekly.status_code == 200

    employee_requests = client.get("/api/time/vacation-requests", headers=auth_headers(employee_token))
    assert employee_requests.status_code == 200
    assert any(
        row["id"] == request_id and row["status"] == "approved" and row["vacation_days_used"] == 2
        for row in employee_requests.json()
    )

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

    reject = client.patch(
        f"/api/time/vacation-requests/{request_id}",
        headers=auth_headers(admin_token),
        json={"status": "rejected"},
    )
    assert reject.status_code == 200
    current_after_reject = client.get("/api/time/current", headers=auth_headers(employee_token))
    assert current_after_reject.status_code == 200
    assert current_after_reject.json()["vacation_days_carryover"] == 3
    assert current_after_reject.json()["vacation_days_available"] == 20
    assert current_after_reject.json()["vacation_days_total_remaining"] == 23

    users_after_reject = client.get("/api/admin/users", headers=auth_headers(admin_token))
    assert users_after_reject.status_code == 200
    rejected_employee_row = next(row for row in users_after_reject.json() if row["id"] == employee["id"])
    assert rejected_employee_row["vacation_days_carryover"] == 3
    assert rejected_employee_row["vacation_days_available"] == 20
    assert rejected_employee_row["vacation_days_total_remaining"] == 23


def test_vacation_request_rejects_ranges_without_working_days(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-vacation-zero@example.com", "employee")
    employee_token = _login(client, "employee-vacation-zero@example.com")

    vacation_request = client.post(
        "/api/time/vacation-requests",
        headers=auth_headers(employee_token),
        json={"start_date": "2026-05-01", "end_date": "2026-05-03", "note": "Holiday weekend"},
    )
    assert vacation_request.status_code == 400
    assert vacation_request.json()["detail"] == "Vacation request must include at least one working day"


def test_absence_requests_use_real_type_labels_and_support_review_update_delete(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-absence-request@example.com", "employee")
    planner = _create_user(client, admin_token, "planner-absence-request@example.com", "planning")
    employee_token = _login(client, "employee-absence-request@example.com")
    planner_token = _login(client, "planner-absence-request@example.com")

    absence_request = client.post(
        "/api/time/school-absences",
        headers=auth_headers(employee_token),
        json={
            "user_id": employee["id"],
            "title": "Krankmeldung",
            "absence_type": "sick",
            "counts_as_hours": True,
            "start_date": "2026-03-17",
            "end_date": "2026-03-18",
            "recurrence_weekday": None,
            "recurrence_until": None,
        },
    )
    assert absence_request.status_code == 200
    assert absence_request.json()["status"] == "pending"
    absence_id = absence_request.json()["id"]

    own_absences = client.get("/api/time/school-absences", headers=auth_headers(employee_token))
    assert own_absences.status_code == 200
    assert any(row["id"] == absence_id and row["status"] == "pending" for row in own_absences.json())

    planning_before_approval = client.get("/api/planning/week/2026-03-16", headers=auth_headers(planner_token))
    assert planning_before_approval.status_code == 200
    assert not any(
        item["user_id"] == employee["id"] and item["type"] == "sick"
        for day in planning_before_approval.json()["days"]
        for item in day["absences"]
    )

    approve_request = client.patch(
        f"/api/time/school-absences/{absence_id}/review",
        headers=auth_headers(admin_token),
        json={"status": "approved"},
    )
    assert approve_request.status_code == 200
    assert approve_request.json()["status"] == "approved"
    assert approve_request.json()["absence_type"] == "sick"

    planning_after_approval = client.get("/api/planning/week/2026-03-16", headers=auth_headers(planner_token))
    assert planning_after_approval.status_code == 200
    assert any(
        item["user_id"] == employee["id"] and item["type"] == "sick" and item["label"] == "Krankmeldung"
        for day in planning_after_approval.json()["days"]
        for item in day["absences"]
    )

    update_absence = client.patch(
        f"/api/time/school-absences/{absence_id}",
        headers=auth_headers(admin_token),
        json={
            "title": "Krankmeldung angepasst",
            "absence_type": "sick",
            "counts_as_hours": True,
            "start_date": "2026-03-18",
            "end_date": "2026-03-19",
            "recurrence_weekday": None,
            "recurrence_until": None,
        },
    )
    assert update_absence.status_code == 200
    assert update_absence.json()["title"] == "Krankmeldung angepasst"
    assert update_absence.json()["start_date"] == "2026-03-18"
    assert update_absence.json()["end_date"] == "2026-03-19"

    delete_absence = client.delete(
        f"/api/time/school-absences/{absence_id}",
        headers=auth_headers(admin_token),
    )
    assert delete_absence.status_code == 200

    audit_logs = client.get("/api/admin/audit-logs", headers=auth_headers(admin_token))
    assert audit_logs.status_code == 200
    actions = {row["action"] for row in audit_logs.json() if row["target_id"] == str(absence_id)}
    assert "school_absence.requested" in actions
    assert "school_absence.reviewed" in actions
    assert "school_absence.updated" in actions
    assert "school_absence.deleted" in actions


def test_time_view_all_can_list_entries_for_every_user(client: TestClient, admin_token: str):
    employee_one = _create_user(client, admin_token, "employee-view-a@example.com", "employee")
    employee_two = _create_user(client, admin_token, "employee-view-b@example.com", "employee")
    accountant = _create_user(client, admin_token, "accountant-view@example.com", "accountant")

    employee_one_token = _login(client, "employee-view-a@example.com")
    employee_two_token = _login(client, "employee-view-b@example.com")
    accountant_token = _login(client, "accountant-view@example.com")

    first_clock_in = client.post("/api/time/clock-in", headers=auth_headers(employee_one_token))
    assert first_clock_in.status_code == 200
    first_clock_out = client.post("/api/time/clock-out", headers=auth_headers(employee_one_token))
    assert first_clock_out.status_code == 200

    second_clock_in = client.post("/api/time/clock-in", headers=auth_headers(employee_two_token))
    assert second_clock_in.status_code == 200
    second_clock_out = client.post("/api/time/clock-out", headers=auth_headers(employee_two_token))
    assert second_clock_out.status_code == 200

    entries_response = client.get("/api/time/entries?period=weekly", headers=auth_headers(accountant_token))
    assert entries_response.status_code == 200
    returned_user_ids = {row["user_id"] for row in entries_response.json()}
    assert employee_one["id"] in returned_user_ids
    assert employee_two["id"] in returned_user_ids

    forbidden_patch = client.patch(
        f"/api/time/entries/{first_clock_in.json()['clock_entry_id']}",
        headers=auth_headers(accountant_token),
        json={"clock_in": "2026-02-17T07:30:00", "clock_out": "2026-02-17T16:30:00", "break_minutes": 30},
    )
    assert forbidden_patch.status_code == 403


def test_group_recent_self_time_edit_is_limited_and_logged(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-group-time@example.com", "employee")
    coworker = _create_user(client, admin_token, "employee-group-other@example.com", "employee")
    employee_token = _login(client, "employee-group-time@example.com")
    coworker_token = _login(client, "employee-group-other@example.com")

    entry_ids: list[int] = []
    for _ in range(4):
        clock_in_response = client.post("/api/time/clock-in", headers=auth_headers(employee_token))
        assert clock_in_response.status_code == 200
        entry_ids.append(clock_in_response.json()["clock_entry_id"])
        clock_out_response = client.post("/api/time/clock-out", headers=auth_headers(employee_token))
        assert clock_out_response.status_code == 200

    coworker_clock_in = client.post("/api/time/clock-in", headers=auth_headers(coworker_token))
    assert coworker_clock_in.status_code == 200
    coworker_entry_id = coworker_clock_in.json()["clock_entry_id"]
    coworker_clock_out = client.post("/api/time/clock-out", headers=auth_headers(coworker_token))
    assert coworker_clock_out.status_code == 200

    not_allowed_before_group = client.patch(
        f"/api/time/entries/{entry_ids[-1]}",
        headers=auth_headers(employee_token),
        json={"clock_in": "2026-02-17T07:00:00", "clock_out": "2026-02-17T15:30:00", "break_minutes": 30},
    )
    assert not_allowed_before_group.status_code == 403

    create_group = client.post(
        "/api/admin/employee-groups",
        headers=auth_headers(admin_token),
        json={
            "name": "Recent time edit group",
            "member_user_ids": [employee["id"]],
            "can_update_recent_own_time_entries": True,
        },
    )
    assert create_group.status_code == 200
    assert create_group.json()["can_update_recent_own_time_entries"] is True

    update_recent = client.patch(
        f"/api/time/entries/{entry_ids[-1]}",
        headers=auth_headers(employee_token),
        json={"clock_in": "2026-02-17T07:00:00", "clock_out": "2026-02-17T15:30:00", "break_minutes": 30},
    )
    assert update_recent.status_code == 200
    assert update_recent.json()["can_edit"] is True

    update_oldest = client.patch(
        f"/api/time/entries/{entry_ids[0]}",
        headers=auth_headers(employee_token),
        json={"clock_in": "2026-02-16T07:00:00", "clock_out": "2026-02-16T15:30:00", "break_minutes": 30},
    )
    assert update_oldest.status_code == 403

    update_coworker = client.patch(
        f"/api/time/entries/{coworker_entry_id}",
        headers=auth_headers(employee_token),
        json={"clock_in": "2026-02-17T08:00:00", "clock_out": "2026-02-17T16:00:00", "break_minutes": 30},
    )
    assert update_coworker.status_code == 403

    own_entries = client.get("/api/time/entries?period=weekly", headers=auth_headers(employee_token))
    assert own_entries.status_code == 200
    editable_rows = [row for row in own_entries.json() if row["can_edit"]]
    assert len(editable_rows) == 3

    audit_logs = client.get("/api/admin/audit-logs", headers=auth_headers(admin_token))
    assert audit_logs.status_code == 200
    assert any(
        row["action"] == "time_entry.recent_self_update"
        and row["category"] == "time"
        and row["actor_user_id"] == employee["id"]
        for row in audit_logs.json()
    )


def test_time_entries_support_custom_date_range_filters(client: TestClient, admin_token: str):
    employee = _create_user(client, admin_token, "employee-range@example.com", "employee")
    employee_token = _login(client, "employee-range@example.com")

    first_clock_in = client.post("/api/time/clock-in", headers=auth_headers(employee_token))
    assert first_clock_in.status_code == 200
    first_entry_id = first_clock_in.json()["clock_entry_id"]
    assert client.post("/api/time/clock-out", headers=auth_headers(employee_token)).status_code == 200

    second_clock_in = client.post("/api/time/clock-in", headers=auth_headers(employee_token))
    assert second_clock_in.status_code == 200
    second_entry_id = second_clock_in.json()["clock_entry_id"]
    assert client.post("/api/time/clock-out", headers=auth_headers(employee_token)).status_code == 200

    patch_first = client.patch(
        f"/api/time/entries/{first_entry_id}",
        headers=auth_headers(admin_token),
        json={"clock_in": "2026-02-10T07:00:00", "clock_out": "2026-02-10T15:00:00", "break_minutes": 30},
    )
    assert patch_first.status_code == 200
    patch_second = client.patch(
        f"/api/time/entries/{second_entry_id}",
        headers=auth_headers(admin_token),
        json={"clock_in": "2026-02-20T07:00:00", "clock_out": "2026-02-20T15:00:00", "break_minutes": 30},
    )
    assert patch_second.status_code == 200

    filtered = client.get(
        "/api/time/entries?start_date=2026-02-01&end_date=2026-02-15",
        headers=auth_headers(employee_token),
    )
    assert filtered.status_code == 200
    rows = filtered.json()
    assert len(rows) == 1
    assert rows[0]["id"] == first_entry_id
