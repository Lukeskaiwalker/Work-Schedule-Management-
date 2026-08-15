"""GET /api/time/day-activity — what a person did on one day.

The time page shows hours; this answers the next question a supervisor asks
when they click a day — "doing what, and where". Two sources: the tasks that
were scheduled for that person that day, and the construction reports they
filed that day (the report carries the "where" and the "what").

The load-bearing behaviours, and why each is here:

  * access mirrors /entries exactly — you see your own day, and only
    time:view_all / time:manage see someone else's. A plain employee reading a
    colleague's movements would be a quiet privacy leak, so it is pinned.
  * "that day" is a plain calendar-date match on report_date / due_date, which
    are naive local dates. A row from an adjacent day must not bleed in.
  * a task counts whether the person is on it via the modern many-assignee
    join or the legacy single assignee column — older rows still use the
    latter, and missing them would silently under-report activity.
"""

from __future__ import annotations

from datetime import date

from fastapi.testclient import TestClient


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _employee(client: TestClient, admin_token: str, email: str) -> dict:
    resp = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={"email": email, "password": "Password123!", "full_name": email.split("@")[0], "role": "employee"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _login(client: TestClient, email: str) -> str:
    resp = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert resp.status_code == 200, resp.text
    return resp.headers["X-Access-Token"]


def _project(client: TestClient, admin_token: str, number: str) -> int:
    resp = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": number, "name": f"Projekt {number}", "status": "active"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _task(client: TestClient, admin_token: str, project_id: int, *, title: str, due: str, assignees: list[int]) -> int:
    resp = client.post(
        "/api/tasks",
        headers=_auth(admin_token),
        json={
            "project_id": project_id,
            "title": title,
            "status": "open",
            "due_date": due,
            "assignee_ids": assignees,
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _insert_report(*, user_id: int, project_id: int, report_date: str, work_done: str) -> int:
    """Write a report row straight to the DB.

    Going through the create endpoint would drag in the whole PDF pipeline; all
    this test needs is a row with a specific author, date and payload, so it
    sets exactly those.
    """

    from app.core.db import SessionLocal
    from app.models.entities import ConstructionReport

    with SessionLocal() as db:
        report = ConstructionReport(
            user_id=user_id,
            project_id=project_id,
            report_date=date.fromisoformat(report_date),
            payload={"work_done": work_done, "project_number": "n/a"},
            processing_status="done",
        )
        db.add(report)
        db.commit()
        db.refresh(report)
        return report.id


DAY = "2026-05-12"
OTHER_DAY = "2026-05-13"


def test_a_day_shows_the_tasks_and_reports_for_that_person_and_day(
    client: TestClient, admin_token: str
) -> None:
    employee = _employee(client, admin_token, "tag-1@example.com")
    project_id = _project(client, admin_token, "TAG-1")

    on_day = _task(client, admin_token, project_id, title="Wechselrichter setzen", due=DAY, assignees=[employee["id"]])
    _task(client, admin_token, project_id, title="Morgen", due=OTHER_DAY, assignees=[employee["id"]])
    report_id = _insert_report(
        user_id=employee["id"], project_id=project_id, report_date=DAY, work_done="Zählerschrank verdrahtet"
    )
    _insert_report(user_id=employee["id"], project_id=project_id, report_date=OTHER_DAY, work_done="anderer Tag")

    token = _login(client, "tag-1@example.com")
    resp = client.get(f"/api/time/day-activity?day={DAY}", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()

    task_ids = {t["id"] for t in body["tasks"]}
    assert on_day in task_ids
    assert len(body["tasks"]) == 1, "a task due another day must not appear"
    assert body["tasks"][0]["title"] == "Wechselrichter setzen"
    assert body["tasks"][0]["project_number"] == "TAG-1"

    report_ids = {r["id"] for r in body["reports"]}
    assert report_ids == {report_id}, "only the report filed on this day"
    assert "verdrahtet" in body["reports"][0]["work_summary"]


def test_a_report_by_another_person_is_not_shown(client: TestClient, admin_token: str) -> None:
    mine = _employee(client, admin_token, "tag-mine@example.com")
    theirs = _employee(client, admin_token, "tag-theirs@example.com")
    project_id = _project(client, admin_token, "TAG-2")

    _insert_report(user_id=theirs["id"], project_id=project_id, report_date=DAY, work_done="nicht meins")

    token = _login(client, "tag-mine@example.com")
    resp = client.get(f"/api/time/day-activity?user_id={mine['id']}&day={DAY}", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    assert resp.json()["reports"] == []


def test_a_supervisor_can_see_an_employees_day(client: TestClient, admin_token: str) -> None:
    """admin holds time:manage, so it stands in for a supervisor here."""

    employee = _employee(client, admin_token, "tag-emp@example.com")
    project_id = _project(client, admin_token, "TAG-3")
    _task(client, admin_token, project_id, title="Sichtbar für Chef", due=DAY, assignees=[employee["id"]])

    resp = client.get(
        f"/api/time/day-activity?user_id={employee['id']}&day={DAY}", headers=_auth(admin_token)
    )
    assert resp.status_code == 200, resp.text
    assert any(t["title"] == "Sichtbar für Chef" for t in resp.json()["tasks"])


def test_a_plain_employee_cannot_read_another_users_day(client: TestClient, admin_token: str) -> None:
    """The privacy boundary: hours-view permission is what gates this, exactly
    as it gates /entries. Without it, a colleague's day is off-limits."""

    _employee(client, admin_token, "tag-a@example.com")
    other = _employee(client, admin_token, "tag-b@example.com")

    token = _login(client, "tag-a@example.com")
    resp = client.get(f"/api/time/day-activity?user_id={other['id']}&day={DAY}", headers=_auth(token))
    assert resp.status_code == 403, resp.text


def test_a_legacy_single_assignee_task_still_counts(client: TestClient, admin_token: str) -> None:
    """Older tasks carry the assignee in tasks.assignee_id rather than the join
    table. Matching only the modern table would silently drop them."""

    from app.core.db import SessionLocal
    from app.models.entities import Task

    employee = _employee(client, admin_token, "tag-legacy@example.com")
    project_id = _project(client, admin_token, "TAG-4")

    with SessionLocal() as db:
        task = Task(
            project_id=project_id,
            title="Alt-Zuweisung",
            status="open",
            due_date=date.fromisoformat(DAY),
            assignee_id=employee["id"],  # legacy column only, no TaskAssignment row
        )
        db.add(task)
        db.commit()
        db.refresh(task)
        legacy_id = task.id

    token = _login(client, "tag-legacy@example.com")
    resp = client.get(f"/api/time/day-activity?day={DAY}", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    assert legacy_id in {t["id"] for t in resp.json()["tasks"]}


def test_an_empty_day_returns_empty_lists(client: TestClient, admin_token: str) -> None:
    employee = _employee(client, admin_token, "tag-empty@example.com")
    token = _login(client, "tag-empty@example.com")
    resp = client.get(f"/api/time/day-activity?day={DAY}", headers=_auth(token))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["tasks"] == []
    assert body["reports"] == []
    assert body["day"] == DAY
