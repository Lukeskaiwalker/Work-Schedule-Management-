"""The customer's cross-project change log.

Every project overview has a "Letzte Änderungen" card fed by
`project_activities`. The customer page wants the same list across all of
that customer's projects — the office asks "what happened at Müller lately",
not "what happened in 2026-0412".

There are no customer-level events yet: nothing records a customer's own
edits, so this feed is exactly the union of the project logs. When customer
events arrive (a nullable `customer_id` on the activity row, or a table of
their own) this module is where they join the feed — the router and the card
only see `CustomerActivityOut`.

The caller hands in the project ids the user may see; the feed never widens
past them. That intersection, not a permission on the endpoint, is what
keeps an employee from reading the log of a project they are not on.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import Project, User
from app.models.project import ProjectActivity
from app.schemas.customer import CustomerActivityOut

# The card loads a page at a time; 200 is the ceiling a client may ask for.
CUSTOMER_ACTIVITY_LIMIT_DEFAULT = 30
CUSTOMER_ACTIVITY_LIMIT_MAX = 200


def clamp_activity_limit(limit: int) -> int:
    """Any integer becomes a usable page size instead of a 422."""
    return max(1, min(int(limit), CUSTOMER_ACTIVITY_LIMIT_MAX))


def _customer_projects_by_id(db: Session, customer_id: int, visible_project_ids: set[int]) -> dict[int, Project]:
    """The customer's projects the user may see, keyed by id."""
    rows = db.scalars(select(Project).where(Project.customer_id == customer_id)).all()
    return {project.id: project for project in rows if project.id in visible_project_ids}


def _actor_names_by_id(db: Session, rows: list[ProjectActivity]) -> dict[int, str]:
    # One query for every actor on the page, as the project card does —
    # never one per row.
    actor_ids = sorted({row.actor_user_id for row in rows if row.actor_user_id is not None})
    if not actor_ids:
        return {}
    users = db.scalars(select(User).where(User.id.in_(actor_ids))).all()
    return {user.id: user.display_name for user in users}


def _activity_out(row: ProjectActivity, project: Project | None, actor_name: str | None) -> CustomerActivityOut:
    return CustomerActivityOut(
        id=row.id,
        project_id=row.project_id,
        actor_user_id=row.actor_user_id,
        actor_name=actor_name,
        event_type=row.event_type,
        message=row.message,
        details=row.details or {},
        created_at=row.created_at,
        project_number=project.project_number if project else None,
        project_name=project.name if project else None,
    )


def customer_activity_page(
    db: Session,
    *,
    customer_id: int,
    visible_project_ids: set[int],
    limit: int = CUSTOMER_ACTIVITY_LIMIT_DEFAULT,
    before_id: int | None = None,
) -> list[CustomerActivityOut]:
    """Newest first, `limit` rows, older than `before_id` when given.

    Keyset pagination on the id: the card asks for the page after the last
    row it holds, so a row posted between two requests can never shift the
    next page (an offset would repeat or skip one). Ids grow with time here,
    so "id < before_id" is the same cut as "older than that row".
    """
    projects = _customer_projects_by_id(db, customer_id, visible_project_ids)
    if not projects:
        return []

    stmt = select(ProjectActivity).where(ProjectActivity.project_id.in_(projects.keys()))
    if before_id is not None:
        stmt = stmt.where(ProjectActivity.id < before_id)
    stmt = stmt.order_by(ProjectActivity.created_at.desc(), ProjectActivity.id.desc()).limit(
        clamp_activity_limit(limit)
    )
    rows = list(db.scalars(stmt).all())

    actor_names = _actor_names_by_id(db, rows)
    return [
        _activity_out(row, projects.get(row.project_id), actor_names.get(row.actor_user_id or 0))
        for row in rows
    ]
