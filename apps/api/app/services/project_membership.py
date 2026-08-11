"""Default project membership: everyone is on every project.

## What membership does

`_projects_visible_to_user` (routers/workflow_helpers.py) grants an employee
sight of a project when they are an explicit `ProjectMember` **or** hold a task
in it. Office and admin roles bypass membership entirely via
`has_global_project_access`, so in practice these rows only ever matter for the
`employee` role.

## Why the default is "everyone"

The company runs one crew across all its jobs: a fitter sent to cover a
different site for an afternoon needs the address, the site-access note and the
material list *before* anyone thinks to add them to the project. The old
default — see only what you were explicitly given — made that a support request
at exactly the wrong moment.

## Why rows rather than a permission change

Flipping `has_global_project_access` to true for employees would have been one
line, and would have thrown away the ability to ever scope anyone again. Real
rows keep the mechanism intact: the default is broad, and an admin can still
remove somebody from a single project and have that stick.

That "and have that stick" is the reason nothing here runs on a schedule or at
startup. Backfill happens **once**, in a migration; after that, membership is
granted only at the two moments something new appears — a project is created,
or a user is created. A periodic re-sync would silently undo every deliberate
removal, which is worse than the problem it would solve.

All functions here are idempotent and never touch an existing row, so a member
who was granted `can_manage` keeps it.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Project, ProjectMember, User


def _existing_pairs(db: Session, *, project_ids: list[int]) -> set[tuple[int, int]]:
    if not project_ids:
        return set()
    rows = db.execute(
        select(ProjectMember.project_id, ProjectMember.user_id).where(
            ProjectMember.project_id.in_(project_ids)
        )
    ).all()
    return {(row[0], row[1]) for row in rows}


def _active_user_ids(db: Session) -> list[int]:
    """Active users only.

    A deactivated account is one somebody switched off on purpose; quietly
    re-granting it access to every project would defeat that. Reactivation goes
    through the admin screens, which can add the memberships back.
    """

    return list(db.scalars(select(User.id).where(User.is_active.is_(True))).all())


def add_all_users_to_project(db: Session, *, project_id: int) -> int:
    """Give every active user membership of one project. Returns rows added.

    Existing memberships are left exactly as they are — importantly including
    the creator's `can_manage=True`, which `create_project` writes first.
    """

    existing = _existing_pairs(db, project_ids=[project_id])
    added = 0
    for user_id in _active_user_ids(db):
        if (project_id, user_id) in existing:
            continue
        db.add(
            ProjectMember(
                project_id=project_id, user_id=user_id, can_manage=False, is_default=True
            )
        )
        added += 1
    return added


def add_user_to_all_projects(db: Session, *, user_id: int) -> int:
    """Give one user membership of every project. Returns rows added.

    Archived projects are included deliberately: they stay readable in the
    archive view, and a new hire being unable to open last year's job to find
    out what was installed there is the same gap this default exists to close.
    """

    project_ids = list(db.scalars(select(Project.id)).all())
    if not project_ids:
        return 0

    already = {
        row[0]
        for row in db.execute(
            select(ProjectMember.project_id).where(ProjectMember.user_id == user_id)
        ).all()
    }
    added = 0
    for project_id in project_ids:
        if project_id in already:
            continue
        db.add(
            ProjectMember(
                project_id=project_id, user_id=user_id, can_manage=False, is_default=True
            )
        )
        added += 1
    return added


def backfill_default_memberships(db: Session) -> int:
    """One-off: every active user onto every existing project.

    Used by migration 0067. Exposed as a function rather than living only as
    SQL in the migration so the behaviour is testable on SQLite, where the test
    suite builds its schema with `create_all` and never runs migrations at all.
    """

    project_ids = list(db.scalars(select(Project.id)).all())
    user_ids = _active_user_ids(db)
    if not project_ids or not user_ids:
        return 0

    existing = _existing_pairs(db, project_ids=project_ids)
    added = 0
    for project_id in project_ids:
        for user_id in user_ids:
            if (project_id, user_id) in existing:
                continue
            db.add(
                ProjectMember(
                    project_id=project_id,
                    user_id=user_id,
                    can_manage=False,
                    is_default=True,
                )
            )
            added += 1
    return added
