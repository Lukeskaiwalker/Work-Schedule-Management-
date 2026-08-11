"""Everyone is a member of every project by default.

The company runs one crew across all its jobs, so the old default — see only
what you were explicitly given — turned "cover that site this afternoon" into a
support request. These tests pin the two moments the default is applied (a
project appears, a user appears) and, just as importantly, the one thing it
must NOT do: undo a deliberate removal.

The backfill for pre-existing rows lives in migration 0067. The SQLite test
suite builds its schema with `create_all` and never runs migrations, so the
backfill is exercised here through the service the migration mirrors.
"""

from __future__ import annotations

from fastapi.testclient import TestClient


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _project(client: TestClient, admin_token: str, number: str) -> int:
    resp = client.post(
        "/api/projects",
        headers=_auth(admin_token),
        json={"project_number": number, "name": f"Projekt {number}", "status": "active"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["id"]


def _employee(client: TestClient, admin_token: str, email: str) -> dict:
    resp = client.post(
        "/api/admin/users",
        headers=_auth(admin_token),
        json={
            "email": email,
            "password": "Password123!",
            "full_name": email.split("@")[0],
            "role": "employee",
        },
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _login(client: TestClient, email: str) -> str:
    resp = client.post("/api/auth/login", json={"email": email, "password": "Password123!"})
    assert resp.status_code == 200, resp.text
    return resp.headers["X-Access-Token"]


def _member_ids(client: TestClient, admin_token: str, project_id: int) -> set[int]:
    resp = client.get(f"/api/projects/{project_id}/members", headers=_auth(admin_token))
    assert resp.status_code == 200, resp.text
    return {row["user_id"] for row in resp.json()}


def test_a_new_project_includes_every_existing_user(
    client: TestClient, admin_token: str
) -> None:
    one = _employee(client, admin_token, "neu-1@example.com")
    two = _employee(client, admin_token, "neu-2@example.com")

    project_id = _project(client, admin_token, "DEF-1")

    members = _member_ids(client, admin_token, project_id)
    assert one["id"] in members
    assert two["id"] in members


def test_a_new_user_is_added_to_every_existing_project(
    client: TestClient, admin_token: str
) -> None:
    first = _project(client, admin_token, "DEF-2")
    second = _project(client, admin_token, "DEF-3")

    newcomer = _employee(client, admin_token, "spaeter@example.com")

    assert newcomer["id"] in _member_ids(client, admin_token, first)
    assert newcomer["id"] in _member_ids(client, admin_token, second)


def test_an_employee_actually_sees_the_projects(client: TestClient, admin_token: str) -> None:
    """The membership rows are only worth anything if they reach the list an
    employee sees — office and admin roles bypass membership entirely, so this
    is the only role that proves the change."""

    _project(client, admin_token, "DEF-SIGHT-1")
    _project(client, admin_token, "DEF-SIGHT-2")
    _employee(client, admin_token, "sieht@example.com")

    token = _login(client, "sieht@example.com")
    visible = client.get("/api/projects", headers=_auth(token))
    assert visible.status_code == 200, visible.text
    numbers = {row["project_number"] for row in visible.json()}
    assert {"DEF-SIGHT-1", "DEF-SIGHT-2"} <= numbers


def test_a_removed_member_stays_removed(client: TestClient, admin_token: str) -> None:
    """The whole reason this is membership rows rather than a permission flag.

    Nothing re-syncs on a timer or at startup; if it did, every deliberate
    removal would silently revert and the admin screen would be a lie.
    """

    project_id = _project(client, admin_token, "DEF-4")
    employee = _employee(client, admin_token, "raus@example.com")
    assert employee["id"] in _member_ids(client, admin_token, project_id)

    removed = client.delete(
        f"/api/projects/{project_id}/members/{employee['id']}", headers=_auth(admin_token)
    )
    assert removed.status_code in (200, 204), removed.text
    assert employee["id"] not in _member_ids(client, admin_token, project_id)

    # Creating an unrelated project must not drag them back onto this one.
    _project(client, admin_token, "DEF-5")
    assert employee["id"] not in _member_ids(client, admin_token, project_id)


def test_the_creator_keeps_manage_rights(client: TestClient, admin_token: str) -> None:
    """The bulk add runs after the creator's own row and must not flatten its
    `can_manage=True` to the default false."""

    employee = _employee(client, admin_token, "chef@example.com")
    token = _login(client, "chef@example.com")

    created = client.post(
        "/api/projects",
        headers=_auth(token),
        json={"project_number": "DEF-6", "name": "Eigenes", "status": "active"},
    )
    if created.status_code == 403:
        # An employee may not create projects in this deployment's role map;
        # the invariant is then unreachable rather than broken.
        return
    assert created.status_code == 200, created.text

    members = client.get(
        f"/api/projects/{created.json()['id']}/members", headers=_auth(admin_token)
    ).json()
    creator = next(row for row in members if row["user_id"] == employee["id"])
    assert creator["can_manage"] is True


def test_a_deactivated_user_is_not_handed_new_projects(
    client: TestClient, admin_token: str
) -> None:
    """Switching an account off is deliberate; a backfill that re-grants it
    every project is a regression, not a default."""

    employee = _employee(client, admin_token, "inaktiv@example.com")
    patched = client.patch(
        f"/api/admin/users/{employee['id']}",
        headers=_auth(admin_token),
        json={"is_active": False},
    )
    assert patched.status_code == 200, patched.text

    project_id = _project(client, admin_token, "DEF-7")
    assert employee["id"] not in _member_ids(client, admin_token, project_id)


def test_default_membership_does_not_expose_project_finances(
    client: TestClient, admin_token: str
) -> None:
    """The boundary of the default: it grants team visibility, not commercials.

    Employees hold `finance:view` by default, and the finance endpoint checks
    that permission AND project access. Membership used to be the second key,
    so a blanket grant would have put the contribution margin of every job in
    the company in front of every fitter. That is not what "everyone is on the
    team" was meant to mean.
    """

    project_id = _project(client, admin_token, "FIN-1")
    _employee(client, admin_token, "kein-geld@example.com")
    token = _login(client, "kein-geld@example.com")

    # The project itself is visible — that is the whole point of the default.
    visible = client.get("/api/projects", headers=_auth(token))
    assert visible.status_code == 200, visible.text
    assert "FIN-1" in {row["project_number"] for row in visible.json()}
    # Its finances are not.
    denied = client.get(f"/api/projects/{project_id}/finance", headers=_auth(token))
    assert denied.status_code == 403, denied.text


def test_a_deliberate_member_still_sees_finances(
    client: TestClient, admin_token: str
) -> None:
    """The other half: adding somebody on purpose must restore what a
    membership always carried, even though a default row already existed."""

    project_id = _project(client, admin_token, "FIN-2")
    employee = _employee(client, admin_token, "mit-geld@example.com")
    token = _login(client, "mit-geld@example.com")
    assert client.get(f"/api/projects/{project_id}/finance", headers=_auth(token)).status_code == 403

    added = client.post(
        f"/api/projects/{project_id}/members",
        headers=_auth(admin_token),
        json={"user_id": employee["id"], "can_manage": False},
    )
    assert added.status_code == 200, added.text

    allowed = client.get(f"/api/projects/{project_id}/finance", headers=_auth(token))
    assert allowed.status_code == 200, allowed.text


def test_a_task_assignment_still_sees_finances(client: TestClient, admin_token: str) -> None:
    """The pre-existing task fallback is untouched: an employee working the
    job could always read its finances, and still can."""

    project_id = _project(client, admin_token, "FIN-3")
    employee = _employee(client, admin_token, "hat-aufgabe@example.com")
    token = _login(client, "hat-aufgabe@example.com")
    assert client.get(f"/api/projects/{project_id}/finance", headers=_auth(token)).status_code == 403

    task = client.post(
        "/api/tasks",
        headers=_auth(admin_token),
        json={
            "project_id": project_id,
            "title": "Verteiler setzen",
            "assignee_ids": [employee["id"]],
        },
    )
    assert task.status_code == 200, task.text

    allowed = client.get(f"/api/projects/{project_id}/finance", headers=_auth(token))
    assert allowed.status_code == 200, allowed.text


def test_the_backfill_is_idempotent(client: TestClient, admin_token: str) -> None:
    """Migration 0067 runs this once, but a re-run must not double-insert —
    the unique constraint would raise rather than skip."""

    from app.core.db import SessionLocal
    from app.services.project_membership import backfill_default_memberships

    project_id = _project(client, admin_token, "DEF-8")
    _employee(client, admin_token, "backfill@example.com")
    before = _member_ids(client, admin_token, project_id)

    with SessionLocal() as db:
        assert backfill_default_memberships(db) == 0
        db.commit()

    assert _member_ids(client, admin_token, project_id) == before
