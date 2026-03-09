"""test_notifications.py — Tests for the /api/notifications endpoints."""
from __future__ import annotations

from fastapi.testclient import TestClient

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
