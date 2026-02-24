from __future__ import annotations

from fastapi.testclient import TestClient


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_project(client: TestClient, admin_token: str, project_number: str = "2026-LOCK-1") -> dict:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": project_number,
            "name": "Lock Test Project",
            "description": "",
            "status": "active",
        },
    )
    assert response.status_code == 200
    return response.json()


def test_project_update_conflict_returns_409(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-LOCK-PROJECT")
    project_id = project["id"]
    initial_token = project["last_updated_at"]
    assert initial_token

    first_update = client.patch(
        f"/api/projects/{project_id}",
        headers=auth_headers(admin_token),
        json={"expected_last_updated_at": initial_token, "customer_name": "First update"},
    )
    assert first_update.status_code == 200

    stale_update = client.patch(
        f"/api/projects/{project_id}",
        headers=auth_headers(admin_token),
        json={"expected_last_updated_at": initial_token, "customer_name": "Second update"},
    )
    assert stale_update.status_code == 409


def test_task_update_conflict_returns_409(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-LOCK-TASK")
    task_create = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={
            "project_id": project["id"],
            "title": "Task lock",
            "status": "open",
        },
    )
    assert task_create.status_code == 200
    task = task_create.json()
    initial_token = task["updated_at"]
    assert initial_token

    first_update = client.patch(
        f"/api/tasks/{task['id']}",
        headers=auth_headers(admin_token),
        json={"expected_updated_at": initial_token, "title": "Task lock updated"},
    )
    assert first_update.status_code == 200

    stale_update = client.patch(
        f"/api/tasks/{task['id']}",
        headers=auth_headers(admin_token),
        json={"expected_updated_at": initial_token, "title": "Task stale write"},
    )
    assert stale_update.status_code == 409


def test_project_finance_update_conflict_returns_409(client: TestClient, admin_token: str):
    project = _create_project(client, admin_token, "2026-LOCK-FIN")
    project_id = project["id"]

    current_finance = client.get(f"/api/projects/{project_id}/finance", headers=auth_headers(admin_token))
    assert current_finance.status_code == 200
    assert current_finance.json()["updated_at"] is None

    first_update = client.patch(
        f"/api/projects/{project_id}/finance",
        headers=auth_headers(admin_token),
        json={"expected_updated_at": None, "planned_hours_total": 42},
    )
    assert first_update.status_code == 200
    assert first_update.json()["updated_at"] is not None

    stale_update = client.patch(
        f"/api/projects/{project_id}/finance",
        headers=auth_headers(admin_token),
        json={"expected_updated_at": None, "planned_hours_total": 43},
    )
    assert stale_update.status_code == 409
