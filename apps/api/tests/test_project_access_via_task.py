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
