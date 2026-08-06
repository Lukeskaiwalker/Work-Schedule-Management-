"""test_notifications.py — Tests for the /api/notifications endpoints."""
from __future__ import annotations

from dataclasses import dataclass

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.notification import Notification
from tests.conftest import auth_headers


def _create_employee(client: TestClient, admin_token: str, email: str) -> dict:
    response = client.post(
        "/api/admin/users",
        json={
            "email": email,
            "password": "Test1234!",
            "full_name": email.split("@")[0].replace("_", " ").title(),
            "role": "employee",
            "language": "en",
        },
        headers=auth_headers(admin_token),
    )
    assert response.status_code in (200, 201), response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post(
        "/api/auth/login",
        json={"email": email, "password": "Test1234!"},
    )
    assert response.status_code == 200
    token = response.headers.get("X-Access-Token")
    assert token
    return token


@dataclass(frozen=True)
class NotifiedTask:
    """One employee, one project, one task they were assigned to."""

    employee_id: int
    employee_token: str
    project_id: int
    task_id: int
    notification_id: int


def _setup_notified_task(
    client: TestClient,
    admin_token: str,
    *,
    slug: str,
) -> NotifiedTask:
    """Create project + employee + assigned task, and return the notification."""
    project_response = client.post(
        "/api/projects",
        json={
            "project_number": f"2026-NOTIF-{slug}",
            "name": f"Notif Project {slug}",
            "status": "active",
            "customer_name": f"Customer {slug}",
            "customer_address": f"{slug} Street 1",
        },
        headers=auth_headers(admin_token),
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    email = f"{slug.lower()}_notif@example.com"
    employee = _create_employee(client, admin_token, email)
    employee_token = _login(client, email)

    task_response = client.post(
        "/api/tasks",
        json={
            "title": f"Task {slug}",
            "project_id": project_id,
            "assignee_ids": [employee["id"]],
        },
        headers=auth_headers(admin_token),
    )
    assert task_response.status_code in (200, 201), task_response.text

    listed = client.get("/api/notifications", headers=auth_headers(employee_token))
    assert listed.status_code == 200, listed.text
    rows = listed.json()
    assert len(rows) == 1

    return NotifiedTask(
        employee_id=employee["id"],
        employee_token=employee_token,
        project_id=project_id,
        task_id=task_response.json()["id"],
        notification_id=rows[0]["id"],
    )


def _stored_notification(notification_id: int) -> Notification | None:
    with SessionLocal() as session:
        return session.execute(
            select(Notification).where(Notification.id == notification_id)
        ).scalar_one_or_none()


def test_notifications_empty_for_new_user(client: TestClient, admin_token: str) -> None:
    """A freshly created user has no notifications."""
    email = "alice_notif@example.com"
    _create_employee(client, admin_token, email)
    token = _login(client, email)

    response = client.get("/api/notifications", headers=auth_headers(token))
    assert response.status_code == 200
    assert response.json() == []


def test_assignment_creates_notification(client: TestClient, admin_token: str) -> None:
    """Assigning a user to a task creates a notification for that user."""
    project_response = client.post(
        "/api/projects",
        json={
            "project_number": "2026-NOTIF-001",
            "name": "Notif Test Project",
            "status": "active",
            "customer_name": "Notif Customer",
            "customer_address": "Test Street 1",
        },
        headers=auth_headers(admin_token),
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    email = "bob_notif@example.com"
    employee = _create_employee(client, admin_token, email)
    employee_token = _login(client, email)

    task_response = client.post(
        "/api/tasks",
        json={
            "title": "Do the thing",
            "project_id": project_id,
            "assignee_ids": [employee["id"]],
        },
        headers=auth_headers(admin_token),
    )
    assert task_response.status_code in (200, 201), task_response.text

    notifications_response = client.get("/api/notifications", headers=auth_headers(employee_token))
    assert notifications_response.status_code == 200
    notifications = notifications_response.json()
    assert len(notifications) == 1
    assert notifications[0]["event_type"] == "task.assigned"
    assert notifications[0]["read_at"] is None


def test_mark_all_read_clears_unread(client: TestClient, admin_token: str) -> None:
    """PATCH /notifications/read-all sets read_at on all unread notifications."""
    project_response = client.post(
        "/api/projects",
        json={
            "project_number": "2026-NOTIF-002",
            "name": "Read Test Project",
            "status": "active",
            "customer_name": "Read Customer",
            "customer_address": "Read Street 2",
        },
        headers=auth_headers(admin_token),
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    email = "carol_notif@example.com"
    employee = _create_employee(client, admin_token, email)
    employee_token = _login(client, email)

    client.post(
        "/api/tasks",
        json={
            "title": "Task for Carol",
            "project_id": project_id,
            "assignee_ids": [employee["id"]],
        },
        headers=auth_headers(admin_token),
    )

    mark_response = client.patch("/api/notifications/read-all", headers=auth_headers(employee_token))
    assert mark_response.status_code == 200
    assert mark_response.json()["marked_read"] == 1

    notifications = client.get("/api/notifications", headers=auth_headers(employee_token)).json()
    assert all(row["read_at"] is not None for row in notifications)


def test_self_assignment_does_not_create_notification(client: TestClient, admin_token: str) -> None:
    """When the actor assigns themselves, no self-notification is created."""
    project_response = client.post(
        "/api/projects",
        json={
            "project_number": "2026-NOTIF-003",
            "name": "Self Assign Project",
            "status": "active",
            "customer_name": "Self Customer",
            "customer_address": "Self Street 3",
        },
        headers=auth_headers(admin_token),
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    me_response = client.get("/api/auth/me", headers=auth_headers(admin_token))
    admin_id = me_response.json()["id"]

    client.post(
        "/api/tasks",
        json={
            "title": "Admin self-task",
            "project_id": project_id,
            "assignee_ids": [admin_id],
        },
        headers=auth_headers(admin_token),
    )

    notifications = client.get("/api/notifications", headers=auth_headers(admin_token)).json()
    assert all(row["event_type"] != "task.assigned" for row in notifications)


def test_completed_task_notifications_are_hidden(client: TestClient, admin_token: str) -> None:
    project_response = client.post(
        "/api/projects",
        json={
            "project_number": "2026-NOTIF-004",
            "name": "Completed Task Project",
            "status": "active",
            "customer_name": "Completed Customer",
            "customer_address": "Done Street 4",
        },
        headers=auth_headers(admin_token),
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    email = "done_notif@example.com"
    employee = _create_employee(client, admin_token, email)
    employee_token = _login(client, email)

    task_response = client.post(
        "/api/tasks",
        json={
            "title": "Will be completed",
            "project_id": project_id,
            "assignee_ids": [employee["id"]],
        },
        headers=auth_headers(admin_token),
    )
    assert task_response.status_code in (200, 201), task_response.text
    task_id = task_response.json()["id"]

    notifications_response = client.get("/api/notifications", headers=auth_headers(employee_token))
    assert notifications_response.status_code == 200
    assert len(notifications_response.json()) == 1

    complete_response = client.patch(
        f"/api/tasks/{task_id}",
        json={"status": "done"},
        headers=auth_headers(admin_token),
    )
    assert complete_response.status_code == 200, complete_response.text

    notifications_after_done = client.get("/api/notifications", headers=auth_headers(employee_token))
    assert notifications_after_done.status_code == 200
    assert notifications_after_done.json() == []


def test_deleted_task_notifications_are_hidden(client: TestClient, admin_token: str) -> None:
    project_response = client.post(
        "/api/projects",
        json={
            "project_number": "2026-NOTIF-005",
            "name": "Deleted Task Project",
            "status": "active",
            "customer_name": "Deleted Customer",
            "customer_address": "Gone Street 5",
        },
        headers=auth_headers(admin_token),
    )
    assert project_response.status_code == 200, project_response.text
    project_id = project_response.json()["id"]

    email = "deleted_notif@example.com"
    employee = _create_employee(client, admin_token, email)
    employee_token = _login(client, email)

    task_response = client.post(
        "/api/tasks",
        json={
            "title": "Will be deleted",
            "project_id": project_id,
            "assignee_ids": [employee["id"]],
        },
        headers=auth_headers(admin_token),
    )
    assert task_response.status_code in (200, 201), task_response.text
    task_id = task_response.json()["id"]

    notifications_response = client.get("/api/notifications", headers=auth_headers(employee_token))
    assert notifications_response.status_code == 200
    assert len(notifications_response.json()) == 1

    delete_response = client.delete(f"/api/tasks/{task_id}", headers=auth_headers(admin_token))
    assert delete_response.status_code == 200, delete_response.text

    notifications_after_delete = client.get("/api/notifications", headers=auth_headers(employee_token))
    assert notifications_after_delete.status_code == 200
    assert notifications_after_delete.json() == []


# ── Dismissing a single notification ─────────────────────────────────────────


def test_dismiss_removes_notification_from_the_list(
    client: TestClient, admin_token: str
) -> None:
    """Clicking a notification removes it — and it stays gone after a reload."""
    setup = _setup_notified_task(client, admin_token, slug="DISMISS1")

    dismiss_response = client.patch(
        f"/api/notifications/{setup.notification_id}/dismiss",
        headers=auth_headers(setup.employee_token),
    )
    assert dismiss_response.status_code == 200, dismiss_response.text
    body = dismiss_response.json()
    assert body["id"] == setup.notification_id
    assert body["dismissed_at"] is not None

    # A fresh request is the "after a refresh" case: the state is a column,
    # not something the client is holding on to.
    after = client.get("/api/notifications", headers=auth_headers(setup.employee_token))
    assert after.status_code == 200
    assert after.json() == []


def test_dismiss_returns_a_json_body_not_204(client: TestClient, admin_token: str) -> None:
    """
    Guards the failure mode that made dismissals look broken in the browser:
    FastAPI sends ``content-type: application/json`` on a 204 even though the
    body is empty, so a client that parses the response throws on success.
    """
    setup = _setup_notified_task(client, admin_token, slug="DISMISS2")

    response = client.patch(
        f"/api/notifications/{setup.notification_id}/dismiss",
        headers=auth_headers(setup.employee_token),
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.content, "204-style empty body breaks JSON-parsing clients"


def test_dismiss_also_marks_the_notification_read(
    client: TestClient, admin_token: str
) -> None:
    """A dismissed entry must not keep the bell badge lit."""
    setup = _setup_notified_task(client, admin_token, slug="DISMISS3")

    response = client.patch(
        f"/api/notifications/{setup.notification_id}/dismiss",
        headers=auth_headers(setup.employee_token),
    )
    assert response.status_code == 200, response.text
    assert response.json()["read_at"] is not None


def test_dismiss_is_idempotent(client: TestClient, admin_token: str) -> None:
    """A double click (or a retry) is not an error and keeps the first stamp."""
    setup = _setup_notified_task(client, admin_token, slug="DISMISS4")

    first = client.patch(
        f"/api/notifications/{setup.notification_id}/dismiss",
        headers=auth_headers(setup.employee_token),
    )
    second = client.patch(
        f"/api/notifications/{setup.notification_id}/dismiss",
        headers=auth_headers(setup.employee_token),
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert second.json()["dismissed_at"] == first.json()["dismissed_at"]


def test_dismiss_foreign_notification_is_rejected(
    client: TestClient, admin_token: str
) -> None:
    """Another user's notification is invisible, not just unwritable."""
    setup = _setup_notified_task(client, admin_token, slug="DISMISS5")
    _create_employee(client, admin_token, "intruder_notif@example.com")
    intruder_token = _login(client, "intruder_notif@example.com")

    response = client.patch(
        f"/api/notifications/{setup.notification_id}/dismiss",
        headers=auth_headers(intruder_token),
    )
    assert response.status_code == 404

    stored = _stored_notification(setup.notification_id)
    assert stored is not None
    assert stored.dismissed_at is None


def test_dismiss_unknown_notification_is_404(client: TestClient, admin_token: str) -> None:
    response = client.patch(
        "/api/notifications/999999/dismiss", headers=auth_headers(admin_token)
    )
    assert response.status_code == 404


def test_mark_all_read_ignores_dismissed_notifications(
    client: TestClient, admin_token: str
) -> None:
    """read-all covers what the panel shows, so the count stays truthful."""
    setup = _setup_notified_task(client, admin_token, slug="DISMISS6")
    client.patch(
        f"/api/notifications/{setup.notification_id}/dismiss",
        headers=auth_headers(setup.employee_token),
    )

    response = client.patch(
        "/api/notifications/read-all", headers=auth_headers(setup.employee_token)
    )
    assert response.status_code == 200
    assert response.json()["marked_read"] == 0


# ── Notifications resolved by their subject ──────────────────────────────────


def test_completing_a_task_resolves_its_notifications(
    client: TestClient, admin_token: str
) -> None:
    """Completion dismisses the row itself, not just its rendering."""
    setup = _setup_notified_task(client, admin_token, slug="RESOLVE1")

    complete = client.patch(
        f"/api/tasks/{setup.task_id}",
        json={"status": "done"},
        headers=auth_headers(admin_token),
    )
    assert complete.status_code == 200, complete.text

    stored = _stored_notification(setup.notification_id)
    assert stored is not None
    assert stored.dismissed_at is not None
    assert stored.read_at is not None


def test_reopening_a_task_does_not_resurrect_its_notification(
    client: TestClient, admin_token: str
) -> None:
    """
    The difference between resolving at write time and only filtering at read
    time: with a read-time filter alone, reopening the task would bring a
    week-old "you were assigned" entry back into the panel.
    """
    setup = _setup_notified_task(client, admin_token, slug="RESOLVE2")

    done = client.patch(
        f"/api/tasks/{setup.task_id}",
        json={"status": "done"},
        headers=auth_headers(admin_token),
    )
    assert done.status_code == 200, done.text

    reopened = client.patch(
        f"/api/tasks/{setup.task_id}",
        json={"status": "open"},
        headers=auth_headers(admin_token),
    )
    assert reopened.status_code == 200, reopened.text

    after = client.get("/api/notifications", headers=auth_headers(setup.employee_token))
    assert after.status_code == 200
    assert after.json() == []


def test_completing_a_task_twice_keeps_the_first_resolution(
    client: TestClient, admin_token: str
) -> None:
    """Re-saving a done task must not re-stamp an already resolved row."""
    setup = _setup_notified_task(client, admin_token, slug="RESOLVE3")

    client.patch(
        f"/api/tasks/{setup.task_id}",
        json={"status": "done"},
        headers=auth_headers(admin_token),
    )
    first = _stored_notification(setup.notification_id)
    assert first is not None and first.dismissed_at is not None
    first_dismissed_at = first.dismissed_at

    again = client.patch(
        f"/api/tasks/{setup.task_id}",
        json={"status": "done"},
        headers=auth_headers(admin_token),
    )
    assert again.status_code == 200, again.text

    second = _stored_notification(setup.notification_id)
    assert second is not None
    assert second.dismissed_at == first_dismissed_at


def test_deleting_a_task_resolves_its_notifications(
    client: TestClient, admin_token: str
) -> None:
    """Notifications hold a plain entity_id, so nothing else cleans them up."""
    setup = _setup_notified_task(client, admin_token, slug="RESOLVE4")

    deleted = client.delete(
        f"/api/tasks/{setup.task_id}", headers=auth_headers(admin_token)
    )
    assert deleted.status_code == 200, deleted.text

    stored = _stored_notification(setup.notification_id)
    assert stored is not None
    assert stored.dismissed_at is not None


def test_assignee_completing_their_own_task_resolves_the_notification(
    client: TestClient, admin_token: str
) -> None:
    """
    The reported case: the employee ticks the task off in "Meine Aufgaben" and
    the notification about it must be gone the next time they open the bell.
    Employees take a different branch in update_task than managers do.
    """
    setup = _setup_notified_task(client, admin_token, slug="RESOLVE5")

    complete = client.patch(
        f"/api/tasks/{setup.task_id}",
        json={"status": "done"},
        headers=auth_headers(setup.employee_token),
    )
    assert complete.status_code == 200, complete.text

    after = client.get("/api/notifications", headers=auth_headers(setup.employee_token))
    assert after.status_code == 200
    assert after.json() == []

    stored = _stored_notification(setup.notification_id)
    assert stored is not None
    assert stored.dismissed_at is not None
