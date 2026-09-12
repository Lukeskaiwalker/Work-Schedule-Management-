"""Two task axes that must stay apart.

Task A — ``Task.status`` vocabulary. The office Status dropdown is built from
the DISTINCT raw strings in ``tasks.status``, so every spelling that ever
reached the column ("Offen", "offen ", "completed") became its own filter
entry. Input is now folded onto ``TASK_STATUSES`` and anything else is a 400.

Task B — ``Task.planning_status``, the internal planning certainty
("tentative" → "in Planung", "confirmed" → "bestätigt", None → nothing to
say). It is NOT execution progress and NOT the customer's confirmation; one
test here pins the two confirmation axes apart on a due_date change.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.core.db import SessionLocal
from app.models.entities import Task
from app.routers import workflow_helpers, workflow_tasks


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_user(client: TestClient, admin_token: str, email: str, role: str) -> dict:
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
    assert response.status_code == 200, response.text
    return response.json()


def _login(client: TestClient, email: str) -> str:
    response = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert response.status_code == 200, response.text
    return response.headers["X-Access-Token"]


def _seed_project(client: TestClient, admin_token: str, number: str = "P-PLAN-1") -> int:
    response = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={"project_number": number, "name": "Planning status project", "status": "Auftrag angenommen"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _seed_project_with_customer(client: TestClient, admin_token: str) -> int:
    cust = client.post(
        "/api/customers",
        headers=auth_headers(admin_token),
        json={
            "name": "Planning Test Customer",
            "address": "Hauptstr. 1, 12345 Berlin",
            "email": "planning-test@example.com",
            "language": "de",
        },
    )
    assert cust.status_code == 200, cust.text
    proj = client.post(
        "/api/projects",
        headers=auth_headers(admin_token),
        json={
            "project_number": "P-PLAN-CONF",
            "name": "Planning + confirmation project",
            "status": "Auftrag angenommen",
            "customer_id": cust.json()["id"],
        },
    )
    assert proj.status_code == 200, proj.text
    return proj.json()["id"]


def _create_task(client: TestClient, token: str, project_id: int, **extra) -> dict:
    response = client.post(
        "/api/tasks",
        headers=auth_headers(token),
        json={"project_id": project_id, "title": "Planning status task", "task_type": "construction", **extra},
    )
    assert response.status_code == 200, response.text
    return response.json()


UNKNOWN_DETAIL = "Unbekannter Status 'xyz' — erlaubt: offen, in Arbeit, pausiert, erledigt"


# ── Task A: status vocabulary ────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # canonical, any case / padding
        ("open", "open"),
        ("  OPEN ", "open"),
        ("in_progress", "in_progress"),
        ("on_hold", "on_hold"),
        ("done", "done"),
        # German labels
        ("Offen", "open"),
        ("offen ", "open"),
        ("in Arbeit", "in_progress"),
        ("In Bearbeitung", "in_progress"),
        ("pausiert", "on_hold"),
        ("Erledigt", "done"),
        ("fertig", "done"),
        ("abgeschlossen", "done"),
        # English variants
        ("completed", "done"),
        ("Complete", "done"),
        ("finished", "done"),
        ("closed", "done"),
        ("todo", "open"),
        ("to_do", "open"),
        ("to do", "open"),
        ("new", "open"),
        ("paused", "on_hold"),
        # spacing / hyphen variants
        ("in-progress", "in_progress"),
        ("in progress", "in_progress"),
        ("In  Progress", "in_progress"),
        ("inprogress", "in_progress"),
        ("on-hold", "on_hold"),
        ("on hold", "on_hold"),
        ("onhold", "on_hold"),
        # legacy stored value the overdue logic knows — passes through
        ("overdue", "overdue"),
        ("Overdue", "overdue"),
    ],
)
def test_status_aliases_normalise_to_canonical(raw: str, expected: str):
    assert workflow_helpers._normalize_task_status(raw) == expected


def test_status_vocabulary_constants_agree():
    assert workflow_helpers.TASK_STATUSES == ("open", "in_progress", "on_hold", "done")
    assert set(workflow_helpers.TASK_STATUS_ALIASES.values()) == set(workflow_helpers.TASK_STATUSES)
    assert "pending" not in workflow_helpers.TASK_STATUS_ALIASES
    assert "overdue" not in workflow_helpers.TASK_STATUS_ALIASES


def test_status_empty_input_returns_default_unchanged():
    assert workflow_helpers._normalize_task_status("") == "open"
    assert workflow_helpers._normalize_task_status(None) == "open"
    assert workflow_helpers._normalize_task_status("   ", default="done") == "done"
    # The update path passes the stored value as default; it must come back
    # verbatim, even when it is not canonical.
    assert workflow_helpers._normalize_task_status(None, default="Offen") == "Offen"


@pytest.mark.parametrize("raw", ["xyz", "pending", "blocked", "in", "done!"])
def test_status_unknown_raises_value_error(raw: str):
    with pytest.raises(ValueError) as excinfo:
        workflow_helpers._normalize_task_status(raw)
    assert str(excinfo.value) == f"Unbekannter Status '{raw}' — erlaubt: offen, in Arbeit, pausiert, erledigt"


def test_create_unknown_status_is_400_with_german_detail(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    response = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={"project_id": project_id, "title": "Bad status", "status": "xyz"},
    )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == UNKNOWN_DETAIL


def test_create_german_status_is_stored_canonical(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    created = _create_task(client, admin_token, project_id, status="Erledigt")
    assert created["status"] == "done"
    in_arbeit = _create_task(client, admin_token, project_id, status="In Arbeit")
    assert in_arbeit["status"] == "in_progress"
    with SessionLocal() as db:
        assert db.get(Task, created["id"]).status == "done"
        assert db.get(Task, in_arbeit["id"]).status == "in_progress"


def test_update_unknown_status_is_400_and_leaves_row_untouched(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    task_id = _create_task(client, admin_token, project_id)["id"]
    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"status": "xyz"},
    )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == UNKNOWN_DETAIL
    with SessionLocal() as db:
        assert db.get(Task, task_id).status == "open"


def test_update_german_status_is_stored_canonical(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    task_id = _create_task(client, admin_token, project_id)["id"]
    response = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"status": "pausiert"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "on_hold"


def test_overdue_status_is_still_accepted_and_stored(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    created = _create_task(client, admin_token, project_id, status="overdue")
    assert created["status"] == "overdue"
    assert created["is_overdue"] is True
    with SessionLocal() as db:
        assert db.get(Task, created["id"]).status == "overdue"


def test_legacy_stored_status_does_not_break_listing(client: TestClient, admin_token: str):
    """Rows written before the vocabulary existed may hold anything. Reading
    them must not raise — the list keeps working and the date decides."""
    project_id = _seed_project(client, admin_token)
    task_id = _create_task(client, admin_token, project_id, due_date=(date.today() - timedelta(days=1)).isoformat())["id"]
    with SessionLocal() as db:
        db.get(Task, task_id).status = "blocked"
        db.commit()
    response = client.get(f"/api/tasks?project_id={project_id}", headers=auth_headers(admin_token))
    assert response.status_code == 200, response.text
    row = next(entry for entry in response.json() if entry["id"] == task_id)
    assert row["status"] == "blocked"
    assert row["is_overdue"] is True


def test_bulk_weekly_plan_rejects_unknown_status_the_same_way(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    response = client.post(
        "/api/planning/week/2026-03-02",
        headers=auth_headers(admin_token),
        json=[
            {"project_id": project_id, "title": "Fine", "status": "Offen", "due_date": "2026-03-02"},
            {"project_id": project_id, "title": "Broken", "status": "xyz", "due_date": "2026-03-03"},
        ],
    )
    assert response.status_code == 400, response.text
    assert response.json()["detail"] == UNKNOWN_DETAIL
    # The whole batch is one transaction: the fine one was not committed.
    with SessionLocal() as db:
        assert db.query(Task).filter(Task.project_id == project_id).count() == 0


def test_bulk_weekly_plan_folds_german_status(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    response = client.post(
        "/api/planning/week/2026-03-02",
        headers=auth_headers(admin_token),
        json=[{"project_id": project_id, "title": "Monday", "status": "In Arbeit", "due_date": "2026-03-02"}],
    )
    assert response.status_code == 200, response.text
    with SessionLocal() as db:
        assert db.get(Task, response.json()["created_task_ids"][0]).status == "in_progress"


def test_employee_patching_erledigt_ends_as_done(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    employee = _create_user(client, admin_token, "status-employee@example.com", "employee")
    employee_token = _login(client, "status-employee@example.com")
    task_id = _create_task(client, admin_token, project_id, assignee_ids=[employee["id"]])["id"]

    # A known non-done spelling is still the permission error, not a 400.
    refused = client.patch(f"/api/tasks/{task_id}", headers=auth_headers(employee_token), json={"status": "open"})
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"] == "Assigned employees can only set status to done"

    # An unknown spelling is the vocabulary error.
    unknown = client.patch(f"/api/tasks/{task_id}", headers=auth_headers(employee_token), json={"status": "xyz"})
    assert unknown.status_code == 400, unknown.text
    assert unknown.json()["detail"] == UNKNOWN_DETAIL

    done = client.patch(f"/api/tasks/{task_id}", headers=auth_headers(employee_token), json={"status": "Erledigt"})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "done"


# ── Task B: planning_status ──────────────────────────────────────────────


def test_create_with_tentative_planning_status(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    created = _create_task(client, admin_token, project_id, planning_status="tentative")
    assert created["planning_status"] == "tentative"
    # Execution status and customer confirmation are untouched by it.
    assert created["status"] == "open"
    assert created["customer_confirmation_status"] is None
    with SessionLocal() as db:
        assert db.get(Task, created["id"]).planning_status == "tentative"


def test_create_without_planning_status_is_null(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    created = _create_task(client, admin_token, project_id)
    assert created["planning_status"] is None


def test_patch_planning_status_confirm_keep_and_clear(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    task_id = _create_task(client, admin_token, project_id, planning_status="tentative")["id"]

    confirmed = client.patch(
        f"/api/tasks/{task_id}", headers=auth_headers(admin_token), json={"planning_status": "confirmed"}
    )
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["planning_status"] == "confirmed"

    # Absent from the payload → unchanged.
    untouched = client.patch(f"/api/tasks/{task_id}", headers=auth_headers(admin_token), json={"title": "Renamed"})
    assert untouched.status_code == 200, untouched.text
    assert untouched.json()["planning_status"] == "confirmed"

    # Explicit null → cleared.
    cleared = client.patch(f"/api/tasks/{task_id}", headers=auth_headers(admin_token), json={"planning_status": None})
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["planning_status"] is None
    with SessionLocal() as db:
        assert db.get(Task, task_id).planning_status is None


def test_invalid_planning_status_is_422_on_create_and_update(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    bad_create = client.post(
        "/api/tasks",
        headers=auth_headers(admin_token),
        json={"project_id": project_id, "title": "Bad", "planning_status": "maybe"},
    )
    assert bad_create.status_code == 422, bad_create.text

    task_id = _create_task(client, admin_token, project_id)["id"]
    bad_update = client.patch(
        f"/api/tasks/{task_id}", headers=auth_headers(admin_token), json={"planning_status": "in Planung"}
    )
    assert bad_update.status_code == 422, bad_update.text


def test_employee_cannot_set_planning_status_but_can_still_mark_done(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    employee = _create_user(client, admin_token, "planning-employee@example.com", "employee")
    employee_token = _login(client, "planning-employee@example.com")
    task_id = _create_task(
        client, admin_token, project_id, assignee_ids=[employee["id"]], planning_status="tentative"
    )["id"]

    refused = client.patch(
        f"/api/tasks/{task_id}", headers=auth_headers(employee_token), json={"planning_status": "confirmed"}
    )
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"] == "Assigned employees can only mark tasks complete"

    done = client.patch(f"/api/tasks/{task_id}", headers=auth_headers(employee_token), json={"status": "done"})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "done"
    # The done transition does not touch the planning axis.
    assert done.json()["planning_status"] == "tentative"


def test_due_date_change_resets_customer_confirmation_but_not_planning_status(
    client: TestClient, admin_token: str
):
    """The two confirmation-shaped columns are different axes. Moving the
    date invalidates the CUSTOMER's yes (v2.5.0 rule) and must leave OUR
    planner's certainty alone — asserted together so they cannot drift."""
    project_id = _seed_project_with_customer(client, admin_token)
    future_due = (date.today() + timedelta(days=7)).isoformat()
    task_id = _create_task(
        client,
        admin_token,
        project_id,
        due_date=future_due,
        request_customer_confirmation=True,
        planning_status="confirmed",
    )["id"]
    manual = client.post(
        f"/api/tasks/{task_id}/customer-confirmation/manual",
        headers=auth_headers(admin_token),
        json={"action": "confirm", "method": "phone"},
    )
    assert manual.status_code == 200, manual.text
    assert manual.json()["customer_confirmation_status"] == "confirmed"
    assert manual.json()["planning_status"] == "confirmed"

    moved = client.patch(
        f"/api/tasks/{task_id}",
        headers=auth_headers(admin_token),
        json={"due_date": (date.today() + timedelta(days=14)).isoformat()},
    )
    assert moved.status_code == 200, moved.text
    body = moved.json()
    assert body["customer_confirmation_status"] == "pending"
    assert body["customer_confirmation_at"] is None
    assert body["planning_status"] == "confirmed"


def test_planning_status_does_not_affect_overdue_or_open_views(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    tentative = _create_task(client, admin_token, project_id, planning_status="tentative", due_date=yesterday)
    confirmed = _create_task(client, admin_token, project_id, planning_status="confirmed", due_date=yesterday)
    assert tentative["is_overdue"] is True
    assert confirmed["is_overdue"] is True

    listed = client.get(f"/api/tasks?view=all_open&project_id={project_id}", headers=auth_headers(admin_token))
    assert listed.status_code == 200, listed.text
    by_id = {entry["id"]: entry for entry in listed.json()}
    assert by_id[tentative["id"]]["planning_status"] == "tentative"
    assert by_id[confirmed["id"]]["planning_status"] == "confirmed"


def test_bulk_weekly_plan_accepts_planning_status(client: TestClient, admin_token: str):
    project_id = _seed_project(client, admin_token)
    response = client.post(
        "/api/planning/week/2026-03-09",
        headers=auth_headers(admin_token),
        json=[
            {"project_id": project_id, "title": "Rough", "due_date": "2026-03-09", "planning_status": "tentative"},
            {"project_id": project_id, "title": "Settled", "due_date": "2026-03-10", "planning_status": "confirmed"},
            {"project_id": project_id, "title": "Plain", "due_date": "2026-03-11"},
        ],
    )
    assert response.status_code == 200, response.text
    week = client.get(f"/api/planning/week/2026-03-09?project_id={project_id}", headers=auth_headers(admin_token))
    assert week.status_code == 200, week.text
    by_title = {task["title"]: task for day in week.json()["days"] for task in day["tasks"]}
    assert by_title["Rough"]["planning_status"] == "tentative"
    assert by_title["Settled"]["planning_status"] == "confirmed"
    assert by_title["Plain"]["planning_status"] is None


def test_task_updated_sse_payload_carries_planning_status(
    client: TestClient, admin_token: str, monkeypatch: pytest.MonkeyPatch
):
    """The SSE payload is ``_task_out(...).model_dump(mode="json")``, so the
    field comes along with ``status`` — pinned here so a hand-built payload
    can never silently drop it."""
    events: list[tuple[str, dict]] = []
    monkeypatch.setattr(workflow_tasks, "notify", lambda db, event_type, payload: events.append((event_type, payload)))
    project_id = _seed_project(client, admin_token)
    task_id = _create_task(client, admin_token, project_id, planning_status="tentative")["id"]
    created = next(payload for event_type, payload in events if event_type == "task.created")
    assert created["planning_status"] == "tentative"

    response = client.patch(
        f"/api/tasks/{task_id}", headers=auth_headers(admin_token), json={"planning_status": "confirmed"}
    )
    assert response.status_code == 200, response.text
    updated = next(payload for event_type, payload in events if event_type == "task.updated")
    assert updated["planning_status"] == "confirmed"
    assert updated["status"] == "open"
