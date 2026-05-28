"""v2.5.34 — an employee assigned a task in a project gets READ access
to that project even without an explicit ProjectMember row.

Background: project #155 (id 113) in prod had 5 employees with task
assignments but ZERO project members. Because access control keyed
only on ProjectMember while task assignment lived in a separate table,
those employees got "Project access denied" on a project they were
assigned to work on. assert_project_access now treats "has a task here"
as sufficient for read (but not manage).
"""
from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.core.db import SessionLocal
from app.core.deps import assert_project_access
from app.core.permissions import ROLE_ADMIN, ROLE_EMPLOYEE
from app.core.security import get_password_hash
from app.models.entities import Project, ProjectMember, Task, TaskAssignment, User


def _make_user(db, email: str, role: str) -> User:
    user = User(
        email=email,
        password_hash=get_password_hash("Password123!"),
        full_name=email.split("@")[0],
        role=role,
        is_active=True,
    )
    db.add(user)
    db.flush()
    return user


def _make_project(db, number: str) -> Project:
    project = Project(project_number=number, name=f"Project {number}", status="active")
    db.add(project)
    db.flush()
    return project


def test_employee_without_membership_or_task_is_denied():
    with SessionLocal() as db:
        emp = _make_user(db, "emp-none@example.com", ROLE_EMPLOYEE)
        project = _make_project(db, "T-ACCESS-1")
        db.commit()

        with pytest.raises(HTTPException) as exc:
            assert_project_access(db, emp, project.id)
        assert exc.value.status_code == 403


def test_employee_with_task_assignment_gets_read_access():
    """The headline fix: a task assignment (multi-assignee join table)
    grants read access without a ProjectMember row."""
    with SessionLocal() as db:
        emp = _make_user(db, "emp-assigned@example.com", ROLE_EMPLOYEE)
        project = _make_project(db, "T-ACCESS-2")
        task = Task(project_id=project.id, title="Do the thing", status="open")
        db.add(task)
        db.flush()
        db.add(TaskAssignment(task_id=task.id, user_id=emp.id))
        db.commit()

        # Read access: must NOT raise.
        assert_project_access(db, emp, project.id)

        # Manage access: still denied — doing work != administering.
        with pytest.raises(HTTPException) as exc:
            assert_project_access(db, emp, project.id, manage_required=True)
        assert exc.value.status_code == 403


def test_employee_with_legacy_assignee_id_gets_read_access():
    """The legacy single-assignee column (tasks.assignee_id) must also
    grant read access — older rows and some import paths populate it
    instead of the join table."""
    with SessionLocal() as db:
        emp = _make_user(db, "emp-legacy@example.com", ROLE_EMPLOYEE)
        project = _make_project(db, "T-ACCESS-3")
        task = Task(project_id=project.id, title="Legacy task", status="open", assignee_id=emp.id)
        db.add(task)
        db.commit()

        assert_project_access(db, emp, project.id)


def test_membership_still_grants_manage_when_can_manage():
    """Regression guard: an explicit member with can_manage keeps full
    access — the refactor didn't break the membership path."""
    with SessionLocal() as db:
        emp = _make_user(db, "emp-manager@example.com", ROLE_EMPLOYEE)
        project = _make_project(db, "T-ACCESS-4")
        db.add(ProjectMember(project_id=project.id, user_id=emp.id, can_manage=True))
        db.commit()

        assert_project_access(db, emp, project.id)  # read
        assert_project_access(db, emp, project.id, manage_required=True)  # manage


def test_member_without_can_manage_is_denied_manage():
    """Regression guard: a read-only member still can't manage."""
    with SessionLocal() as db:
        emp = _make_user(db, "emp-readonly@example.com", ROLE_EMPLOYEE)
        project = _make_project(db, "T-ACCESS-5")
        db.add(ProjectMember(project_id=project.id, user_id=emp.id, can_manage=False))
        db.commit()

        assert_project_access(db, emp, project.id)  # read ok
        with pytest.raises(HTTPException) as exc:
            assert_project_access(db, emp, project.id, manage_required=True)
        assert exc.value.status_code == 403
        assert "manage" in exc.value.detail.lower()


def test_task_assignment_does_not_grant_manage_access():
    """Critical security boundary: task assignment grants READ only.
    An assigned employee must never be able to perform manage actions
    on a project they aren't an explicit can_manage member of."""
    with SessionLocal() as db:
        emp = _make_user(db, "emp-noManage@example.com", ROLE_EMPLOYEE)
        project = _make_project(db, "T-ACCESS-6")
        task = Task(project_id=project.id, title="Task", status="open")
        db.add(task)
        db.flush()
        db.add(TaskAssignment(task_id=task.id, user_id=emp.id))
        db.commit()

        with pytest.raises(HTTPException) as exc:
            assert_project_access(db, emp, project.id, manage_required=True)
        assert exc.value.status_code == 403


def test_admin_keeps_global_access_without_membership():
    """Regression guard: admins (projects:manage) bypass membership +
    task checks entirely."""
    with SessionLocal() as db:
        admin = _make_user(db, "admin-global@example.com", ROLE_ADMIN)
        project = _make_project(db, "T-ACCESS-7")
        db.commit()

        assert_project_access(db, admin, project.id)
        assert_project_access(db, admin, project.id, manage_required=True)


# ──────────────── v2.5.35: list/overview visibility parity ────────────────


def test_task_assigned_project_ids_unions_both_models():
    """The shared helper returns project IDs from both the join table
    and the legacy assignee_id column."""
    from app.core.deps import task_assigned_project_ids

    with SessionLocal() as db:
        emp = _make_user(db, "emp-ids@example.com", ROLE_EMPLOYEE)
        p_join = _make_project(db, "T-IDS-1")
        p_legacy = _make_project(db, "T-IDS-2")
        p_none = _make_project(db, "T-IDS-3")

        t_join = Task(project_id=p_join.id, title="join", status="open")
        db.add(t_join)
        db.flush()
        db.add(TaskAssignment(task_id=t_join.id, user_id=emp.id))
        db.add(Task(project_id=p_legacy.id, title="legacy", status="open", assignee_id=emp.id))
        # p_none has a task but assigned to nobody → must not appear.
        db.add(Task(project_id=p_none.id, title="unassigned", status="open"))
        db.commit()

        ids = task_assigned_project_ids(db, emp.id)
        assert p_join.id in ids
        assert p_legacy.id in ids
        assert p_none.id not in ids


def test_projects_overview_lists_task_assigned_project(client, admin_token):
    """End-to-end: an employee assigned a task in a project they aren't
    a member of sees that project in /projects-overview — not just when
    opening it directly. This is the gap v2.5.34 left and v2.5.35
    closes."""
    # Create an employee through the admin API so the login flow works.
    create = client.post(
        "/api/admin/users",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={
            "email": "overview-emp@example.com",
            "password": "Password123!",
            "full_name": "Overview Emp",
            "role": "employee",
        },
    )
    assert create.status_code == 200, create.text
    emp_id = create.json()["id"]

    login = client.post(
        "/api/auth/login",
        json={"email": "overview-emp@example.com", "password": "Password123!"},
    )
    emp_token = login.headers["X-Access-Token"]

    # Before any assignment: the employee sees no projects.
    before = client.get("/api/projects-overview", headers={"Authorization": f"Bearer {emp_token}"})
    assert before.status_code == 200
    assert before.json() == []

    # Create a project + task assigned to the employee directly in the DB
    # (mirrors the imported-project-with-no-members scenario).
    with SessionLocal() as db:
        project = _make_project(db, "T-OVERVIEW-1")
        task = Task(project_id=project.id, title="assigned", status="open")
        db.add(task)
        db.flush()
        db.add(TaskAssignment(task_id=task.id, user_id=emp_id))
        db.commit()
        project_id = project.id

    after = client.get("/api/projects-overview", headers={"Authorization": f"Bearer {emp_token}"})
    assert after.status_code == 200
    listed_ids = {row["project_id"] for row in after.json()}
    assert project_id in listed_ids, "task-assigned project must appear in the overview list"
