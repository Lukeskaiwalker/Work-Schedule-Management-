"""The bell speaks German.

The notification panel prints ``message`` verbatim, and the assignment
notification used to be written in English ("Initial Admin assigned you to
"…""). New rows are German; rows stored before keep their text in the
database and read German when listed — the line is structured, so the actor
and the task title can be carried over.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.notification import Notification
from app.services.notification_messages import display_notification_message, task_assigned_message
from tests.conftest import auth_headers

PASSWORD = "Test1234!"


def _employee_token(client: TestClient, admin_token: str, email: str) -> tuple[int, str]:
    created = client.post(
        "/api/admin/users",
        json={"email": email, "password": PASSWORD, "full_name": "Erika Elektro", "role": "employee"},
        headers=auth_headers(admin_token),
    )
    assert created.status_code in (200, 201), created.text
    login = client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return created.json()["id"], login.headers["X-Access-Token"]


def _project(client: TestClient, admin_token: str, number: str) -> int:
    response = client.post(
        "/api/projects",
        json={"project_number": number, "name": f"Projekt {number}", "status": "in_durchfuehrung"},
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def test_the_assignment_line_is_german() -> None:
    assert task_assigned_message("Luca", "Gerüst aufbauen") == "Luca hat dir die Aufgabe „Gerüst aufbauen“ zugewiesen"


def test_an_old_english_assignment_line_reads_german() -> None:
    old = 'Initial Admin assigned you to "Zählerschrank setzen"'
    assert display_notification_message("task.assigned", old) == (
        "Initial Admin hat dir die Aufgabe „Zählerschrank setzen“ zugewiesen"
    )
    # Quotes inside the title belong to the title.
    assert display_notification_message("task.assigned", 'Bob assigned you to "Kabel "NYM" ziehen"') == (
        "Bob hat dir die Aufgabe „Kabel \"NYM\" ziehen“ zugewiesen"
    )
    # Anything else is left as it is.
    assert display_notification_message("task.assigned", "Luca hat dir die Aufgabe „X“ zugewiesen") == (
        "Luca hat dir die Aufgabe „X“ zugewiesen"
    )
    assert display_notification_message("other.event", 'A assigned you to "B"') == 'A assigned you to "B"'


def test_assigning_a_task_notifies_in_german(client: TestClient, admin_token: str) -> None:
    employee_id, token = _employee_token(client, admin_token, "erika_bell@example.com")
    project_id = _project(client, admin_token, "2026-BELL-1")
    task = client.post(
        "/api/tasks",
        json={"title": "Zählerschrank setzen", "project_id": project_id, "assignee_ids": [employee_id]},
        headers=auth_headers(admin_token),
    )
    assert task.status_code in (200, 201), task.text

    listed = client.get("/api/notifications", headers=auth_headers(token))
    assert listed.status_code == 200, listed.text
    [row] = listed.json()
    assert row["message"] == "Initial Admin hat dir die Aufgabe „Zählerschrank setzen“ zugewiesen"


def test_an_old_row_is_listed_in_german_and_stored_as_it_was(client: TestClient, admin_token: str) -> None:
    employee_id, token = _employee_token(client, admin_token, "erika_old_bell@example.com")
    project_id = _project(client, admin_token, "2026-BELL-2")
    task = client.post(
        "/api/tasks",
        json={"title": "Abnahme", "project_id": project_id, "assignee_ids": [employee_id]},
        headers=auth_headers(admin_token),
    )
    assert task.status_code in (200, 201), task.text
    with SessionLocal() as db:
        row = db.query(Notification).filter(Notification.user_id == employee_id).one()
        # As a v2.14.40 server wrote it.
        row.message = 'Initial Admin assigned you to "Abnahme"'
        db.commit()
        row_id = row.id

    listed = client.get("/api/notifications", headers=auth_headers(token))
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["message"] == "Initial Admin hat dir die Aufgabe „Abnahme“ zugewiesen"

    with SessionLocal() as db:
        assert db.get(Notification, row_id).message == 'Initial Admin assigned you to "Abnahme"'


# PostgreSQL refuses a VARCHAR overflow at commit, and the notification is
# added in the task's own transaction — a line wider than the column costs the
# task, not just the bell. SQLite does not enforce the width, so these tests
# measure the line instead of waiting for the database to object.
MESSAGE_WIDTH = Notification.__table__.c["message"].type.length


def test_a_long_title_is_cut_so_the_line_fits_the_column() -> None:
    title = ("Unterverteilung UV-3 umbauen, " * 10)[:230]
    message = task_assigned_message("Initial Admin", title)
    assert len(message) <= MESSAGE_WIDTH
    assert message.startswith("Initial Admin hat dir die Aufgabe „")
    # The cut is visible and the sentence still closes.
    assert message.endswith("…“ zugewiesen")
    kept = message.removeprefix("Initial Admin hat dir die Aufgabe „").removesuffix("…“ zugewiesen")
    assert kept and title.startswith(kept)


def test_a_title_that_fits_is_not_cut() -> None:
    room = MESSAGE_WIDTH - len(task_assigned_message("Initial Admin", ""))
    exact = "a" * room
    assert task_assigned_message("Initial Admin", exact) == f"Initial Admin hat dir die Aufgabe „{exact}“ zugewiesen"
    assert len(task_assigned_message("Initial Admin", exact)) == MESSAGE_WIDTH
    one_more = task_assigned_message("Initial Admin", exact + "b")
    assert len(one_more) == MESSAGE_WIDTH
    assert one_more.endswith("…“ zugewiesen")


def test_an_overlong_name_still_fits_the_column() -> None:
    # full_name is a 255-character column itself; the line must fit anyway.
    assert len(task_assigned_message("A" * 255, "Gerüst aufbauen")) <= MESSAGE_WIDTH


def test_a_long_title_on_create_and_on_edit_stores_a_line_that_fits(
    client: TestClient, admin_token: str
) -> None:
    employee_id, token = _employee_token(client, admin_token, "erika_long_bell@example.com")
    project_id = _project(client, admin_token, "2026-BELL-3")
    title = ("Zählerschrank im Keller tauschen und neu verdrahten; " * 5)[:230]

    created = client.post(
        "/api/tasks",
        json={"title": title, "project_id": project_id, "assignee_ids": [employee_id]},
        headers=auth_headers(admin_token),
    )
    assert created.status_code in (200, 201), created.text
    # The edit path writes its own notification when an assignee is added.
    later = client.post(
        "/api/tasks",
        json={"title": title, "project_id": project_id},
        headers=auth_headers(admin_token),
    )
    assert later.status_code in (200, 201), later.text
    edited = client.patch(
        f"/api/tasks/{later.json()['id']}",
        json={"assignee_ids": [employee_id]},
        headers=auth_headers(admin_token),
    )
    assert edited.status_code == 200, edited.text

    with SessionLocal() as db:
        stored = [row.message for row in db.query(Notification).filter(Notification.user_id == employee_id)]
    assert len(stored) == 2
    for message in stored:
        assert len(message) <= MESSAGE_WIDTH
        assert message.startswith("Initial Admin hat dir die Aufgabe „Zählerschrank im Keller")
        assert message.endswith("…“ zugewiesen")

    listed = client.get("/api/notifications", headers=auth_headers(token))
    assert listed.status_code == 200, listed.text
    assert all(len(row["message"]) <= MESSAGE_WIDTH for row in listed.json())
