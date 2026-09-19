"""Customer-only tasks behave like project tasks.

A task anchored to a customer (``customer_id`` set, ``project_id`` null) used
to be visible only from inside that customer's page: every list carried it
but nothing named the customer, a status change tried to write a project
activity with no project and failed, and the customer's change log never
heard of it. These tests pin the other behaviour:

  * every list view and the planning week carry ``customer_name`` (and the
    address, for the travel hint) on a customer task;
  * an assigned employee finds the task under view=my and can complete it;
  * create / update / delete record ``customer_activities`` rows — and never
    a project activity — while a project task keeps its project log only;
  * the weekly planning POST accepts a customer-only assignment.
"""

from __future__ import annotations

from datetime import date, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.customer import CustomerActivity
from app.models.project import ProjectActivity

EMPLOYEE_PASSWORD = "Password123!"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_customer(client: TestClient, admin_token: str, name: str, address: str | None = None) -> dict:
    payload: dict = {"name": name}
    if address is not None:
        payload["address"] = address
    response = client.post("/api/customers", headers=auth_headers(admin_token), json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _create_project(client: TestClient, admin_token: str, number: str, customer_id: int | None = None) -> dict:
    payload: dict = {"project_number": number, "name": f"Projekt {number}", "status": "active"}
    if customer_id is not None:
        payload["customer_id"] = customer_id
    response = client.post("/api/projects", headers=auth_headers(admin_token), json=payload)
    assert response.status_code == 200, response.text
    return response.json()


def _create_user(client: TestClient, admin_token: str, email: str, role: str = "employee") -> dict:
    response = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={"email": email, "password": EMPLOYEE_PASSWORD, "full_name": f"{role.title()} User", "role": role},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": EMPLOYEE_PASSWORD})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _create_task(client: TestClient, token: str, **payload) -> dict:
    response = client.post(
        "/api/tasks",
        headers=auth_headers(token),
        json={"title": "Rückruf wegen Angebot", "task_type": "office", **payload},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _list(client: TestClient, token: str, query: str) -> list[dict]:
    response = client.get(f"/api/tasks?{query}", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _activity(client: TestClient, token: str, customer_id: int) -> list[dict]:
    response = client.get(f"/api/customers/{customer_id}/activity", headers=auth_headers(token))
    assert response.status_code == 200, response.text
    return response.json()


def _monday(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _project_activity_rows_for_task(task_id: int) -> list[ProjectActivity]:
    with SessionLocal() as db:
        rows = db.scalars(select(ProjectActivity)).all()
        return [row for row in rows if (row.details or {}).get("task_id") == task_id]


def _customer_activity_rows(customer_id: int) -> list[CustomerActivity]:
    """The customer's task events only — the customer's own rows (its
    creation, a note) are the customer router's business, not this file's."""
    with SessionLocal() as db:
        rows = db.scalars(
            select(CustomerActivity)
            .where(CustomerActivity.customer_id == customer_id)
            .order_by(CustomerActivity.id.asc())
        ).all()
        return [row for row in rows if row.event_type.startswith("task.")]


# ── Lists name the customer ──────────────────────────────────────────────────


def test_list_views_carry_customer_name_and_address_on_a_customer_task(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Müller Haustechnik GmbH", address="Hauptstr. 1, 12345 Berlin")
    admin = client.get("/api/auth/me", headers=auth_headers(admin_token)).json()
    task = _create_task(client, admin_token, customer_id=customer["id"], assignee_ids=[admin["id"]])

    # The create response already names the customer — the row is inserted
    # into the open list without a reload.
    assert task["customer_name"] == "Müller Haustechnik GmbH"
    assert task["customer_address"] == "Hauptstr. 1, 12345 Berlin"
    assert task["project_id"] is None

    for view in ("all_open", "my", "my_all", "projects_overview"):
        rows = [row for row in _list(client, admin_token, f"view={view}") if row["id"] == task["id"]]
        assert len(rows) == 1, view
        assert rows[0]["customer_id"] == customer["id"], view
        assert rows[0]["customer_name"] == "Müller Haustechnik GmbH", view
        assert rows[0]["customer_address"] == "Hauptstr. 1, 12345 Berlin", view

    done = client.patch(f"/api/tasks/{task['id']}", headers=auth_headers(admin_token), json={"status": "done"})
    assert done.status_code == 200, done.text
    completed = [row for row in _list(client, admin_token, "view=completed") if row["id"] == task["id"]]
    assert len(completed) == 1
    assert completed[0]["customer_name"] == "Müller Haustechnik GmbH"


def test_project_task_has_no_customer_name_of_its_own(client: TestClient, admin_token: str):
    # The label helper on the client says "Projekt: …" for these; a project
    # task must not suddenly read "Kunde: …" because its project has one.
    customer = _create_customer(client, admin_token, "Projekt Kunde")
    project = _create_project(client, admin_token, "2026-4101", customer["id"])
    task = _create_task(client, admin_token, project_id=project["id"])
    assert task["customer_id"] is None
    assert task["customer_name"] is None
    assert task["customer_address"] is None


def test_planning_week_carries_customer_name_on_a_customer_task(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Wochenplan Kunde")
    monday = _monday(date.today() + timedelta(days=14))
    task = _create_task(
        client,
        admin_token,
        customer_id=customer["id"],
        task_type="customer_appointment",
        due_date=(monday + timedelta(days=2)).isoformat(),
    )

    week = client.get(f"/api/planning/week/{monday.isoformat()}", headers=auth_headers(admin_token))
    assert week.status_code == 200, week.text
    wednesday = next(day for day in week.json()["days"] if day["date"] == (monday + timedelta(days=2)).isoformat())
    rows = [row for row in wednesday["tasks"] if row["id"] == task["id"]]
    assert len(rows) == 1
    assert rows[0]["customer_name"] == "Wochenplan Kunde"
    assert rows[0]["project_id"] is None


def test_employee_sees_and_completes_an_assigned_customer_task(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Monteur Kunde")
    employee = _create_user(client, admin_token, "customer-task-employee@example.com")
    employee_token = _login(client, "customer-task-employee@example.com")
    task = _create_task(client, admin_token, customer_id=customer["id"], assignee_ids=[employee["id"]])

    mine = [row for row in _list(client, employee_token, "view=my") if row["id"] == task["id"]]
    assert len(mine) == 1
    assert mine[0]["customer_name"] == "Monteur Kunde"

    # Completing is the one write an employee has, and it used to fail with a
    # project activity that had no project to belong to.
    done = client.patch(
        f"/api/tasks/{task['id']}",
        headers=auth_headers(employee_token),
        json={"status": "done", "expected_updated_at": task["updated_at"]},
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "done"


# ── The customer's change log hears about its tasks ─────────────────────────


def test_customer_task_lifecycle_records_customer_activities_only(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Protokoll Kunde")
    task = _create_task(client, admin_token, customer_id=customer["id"], title="Angebot nachfassen")

    moved = client.patch(
        f"/api/tasks/{task['id']}",
        headers=auth_headers(admin_token),
        json={"due_date": (date.today() + timedelta(days=3)).isoformat()},
    )
    assert moved.status_code == 200, moved.text

    deleted = client.delete(f"/api/tasks/{task['id']}", headers=auth_headers(admin_token))
    assert deleted.status_code == 200, deleted.text

    rows = _activity(client, admin_token, customer["id"])
    task_rows = [row for row in rows if row["event_type"].startswith("task.")]
    assert [(row["event_type"], row["message"]) for row in task_rows] == [
        ("task.deleted", "Task deleted: Angebot nachfassen"),
        ("task.updated", "Task updated: Angebot nachfassen"),
        ("task.created", "Task created: Angebot nachfassen"),
    ]
    # Customer rows: no project to name.
    assert all(row["project_id"] is None and row["project_number"] is None for row in task_rows)
    assert all(row["details"]["task_id"] == task["id"] for row in task_rows)
    # The same fields the project log carries, so the two read alike.
    updated = next(row for row in task_rows if row["event_type"] == "task.updated")
    assert set(updated["details"]) >= {"task_id", "status", "due_date", "end_date", "start_time", "estimated_hours"}

    assert _project_activity_rows_for_task(task["id"]) == []


def test_project_task_lifecycle_records_project_activities_only(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Projektlog Kunde")
    project = _create_project(client, admin_token, "2026-4102", customer["id"])
    task = _create_task(client, admin_token, project_id=project["id"], title="Material bestellen")

    done = client.patch(f"/api/tasks/{task['id']}", headers=auth_headers(admin_token), json={"status": "done"})
    assert done.status_code == 200, done.text
    deleted = client.delete(f"/api/tasks/{task['id']}", headers=auth_headers(admin_token))
    assert deleted.status_code == 200, deleted.text

    assert _customer_activity_rows(customer["id"]) == []
    events = sorted(row.event_type for row in _project_activity_rows_for_task(task["id"]))
    assert events == ["task.created", "task.deleted", "task.updated"]

    # The customer's feed still shows them — through the project log, with
    # the project named, exactly as before.
    rows = [row for row in _activity(client, admin_token, customer["id"]) if row["event_type"].startswith("task.")]
    assert {row["project_number"] for row in rows} == {"2026-4102"}


def test_customer_task_with_a_project_too_logs_to_the_project_only(client: TestClient, admin_token: str):
    # "Both anchors" means the project is the home of the task; the customer
    # feed already unions that project's log, so a second row would show the
    # same event twice.
    customer = _create_customer(client, admin_token, "Beide Anker Kunde")
    project = _create_project(client, admin_token, "2026-4103", customer["id"])
    task = _create_task(client, admin_token, project_id=project["id"], customer_id=customer["id"])
    assert task["customer_name"] == "Beide Anker Kunde"

    assert _customer_activity_rows(customer["id"]) == []
    assert [row.event_type for row in _project_activity_rows_for_task(task["id"])] == ["task.created"]


# ── Weekly planning POST ─────────────────────────────────────────────────────


def test_planning_assign_week_accepts_a_customer_only_assignment(client: TestClient, admin_token: str):
    customer = _create_customer(client, admin_token, "Planung Kunde")
    monday = _monday(date.today() + timedelta(days=21))

    response = client.post(
        f"/api/planning/week/{monday.isoformat()}",
        headers=auth_headers(admin_token),
        json=[{"customer_id": customer["id"], "title": "Vor-Ort-Termin", "task_type": "customer_appointment"}],
    )
    assert response.status_code == 200, response.text
    created_ids = response.json()["created_task_ids"]
    assert len(created_ids) == 1

    rows = [row for row in _list(client, admin_token, f"view=all_open&week_start={monday.isoformat()}") if row["id"] == created_ids[0]]
    assert len(rows) == 1
    assert rows[0]["customer_name"] == "Planung Kunde"
    assert rows[0]["project_id"] is None

    activities = _customer_activity_rows(customer["id"])
    assert [(row.event_type, row.message) for row in activities] == [("task.created", "Task created: Vor-Ort-Termin")]
    assert _project_activity_rows_for_task(created_ids[0]) == []


def test_planning_assign_week_still_refuses_an_unknown_customer(client: TestClient, admin_token: str):
    monday = _monday(date.today() + timedelta(days=28))
    response = client.post(
        f"/api/planning/week/{monday.isoformat()}",
        headers=auth_headers(admin_token),
        json=[{"customer_id": 987654, "title": "Geistertermin"}],
    )
    assert response.status_code == 400, response.text
