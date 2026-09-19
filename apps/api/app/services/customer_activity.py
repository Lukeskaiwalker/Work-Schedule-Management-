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

from datetime import datetime

from app.models.entities import CustomerActivity, Project, User
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


def _actor_names_by_id(db: Session, rows: list) -> dict[int, str]:
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


def record_customer_activity(
    db: Session,
    *,
    customer_id: int,
    actor_user_id: int | None,
    event_type: str,
    message: str,
    details: dict | None = None,
) -> CustomerActivity:
    """A customer-level event — the twin of ``_record_project_activity``.

    Added to the session, not committed: it rides in the caller's transaction
    with the change it describes, or not at all.
    """
    row = CustomerActivity(
        customer_id=customer_id,
        actor_user_id=actor_user_id,
        event_type=event_type,
        message=message[:255],
        details=details or {},
    )
    db.add(row)
    return row


def make_cursor(created_at: datetime, source: str, row_id: int) -> str:
    return f"{created_at.isoformat()}|{source}|{row_id}"


def parse_cursor(cursor: str | None) -> tuple[datetime, str, int] | None:
    """``None`` for an absent or malformed cursor — a bad cursor shows the
    first page rather than a 422, like an out-of-range limit."""
    if not cursor:
        return None
    parts = cursor.split("|")
    if len(parts) != 3:
        return None
    try:
        return datetime.fromisoformat(parts[0]), parts[1], int(parts[2])
    except ValueError:
        return None


def _older_than(row_key: tuple[datetime, str, int], cursor_key: tuple[datetime, str, int]) -> bool:
    # Newest first means "older" is the smaller key; source and id only break
    # ties between rows written in the same microsecond.
    return row_key < cursor_key


def customer_activity_page(
    db: Session,
    *,
    customer_id: int,
    visible_project_ids: set[int],
    limit: int = CUSTOMER_ACTIVITY_LIMIT_DEFAULT,
    before_id: int | None = None,
    cursor: str | None = None,
) -> list[CustomerActivityOut]:
    """Newest first, `limit` rows, older than the cursor when given.

    Two sources are merged: the project logs of the customer's visible
    projects and the customer's own events. Each source is over-fetched by
    one page from the cursor's timestamp, merged and cut — keyset on
    (created_at, source, id), so a row posted between two requests can
    never shift the next page. ``before_id`` is the older, project-only
    cursor and is still honoured for clients that send it.
    """
    page = clamp_activity_limit(limit)
    cursor_key = parse_cursor(cursor)
    projects = _customer_projects_by_id(db, customer_id, visible_project_ids)

    project_rows: list[ProjectActivity] = []
    if projects:
        stmt = select(ProjectActivity).where(ProjectActivity.project_id.in_(projects.keys()))
        if before_id is not None:
            stmt = stmt.where(ProjectActivity.id < before_id)
        if cursor_key is not None:
            stmt = stmt.where(ProjectActivity.created_at <= cursor_key[0])
        stmt = stmt.order_by(ProjectActivity.created_at.desc(), ProjectActivity.id.desc()).limit(page + 1)
        project_rows = list(db.scalars(stmt).all())

    cstmt = select(CustomerActivity).where(CustomerActivity.customer_id == customer_id)
    if cursor_key is not None:
        cstmt = cstmt.where(CustomerActivity.created_at <= cursor_key[0])
    cstmt = cstmt.order_by(CustomerActivity.created_at.desc(), CustomerActivity.id.desc()).limit(page + 1)
    customer_rows = list(db.scalars(cstmt).all())

    merged: list[tuple[tuple[datetime, str, int], ProjectActivity | CustomerActivity, str]] = []
    for row in project_rows:
        merged.append(((row.created_at, "project", row.id), row, "project"))
    for row in customer_rows:
        merged.append(((row.created_at, "customer", row.id), row, "customer"))
    if cursor_key is not None:
        merged = [entry for entry in merged if _older_than(entry[0], cursor_key)]
    merged.sort(key=lambda entry: entry[0], reverse=True)
    merged = merged[:page]

    actor_names = _actor_names_by_id(db, [entry[1] for entry in merged])  # type: ignore[arg-type]
    out: list[CustomerActivityOut] = []
    for key, row, source in merged:
        if source == "project":
            item = _activity_out(row, projects.get(row.project_id), actor_names.get(row.actor_user_id or 0))  # type: ignore[arg-type]
            out.append(item.model_copy(update={"source": "project", "customer_id": customer_id, "cursor": make_cursor(*key)}))
        else:
            out.append(
                CustomerActivityOut(
                    id=row.id,
                    project_id=None,
                    customer_id=customer_id,
                    actor_user_id=row.actor_user_id,
                    actor_name=actor_names.get(row.actor_user_id or 0),
                    event_type=row.event_type,
                    message=row.message,
                    details=row.details or {},
                    created_at=row.created_at,
                    project_number=None,
                    project_name=None,
                    source="customer",
                    cursor=make_cursor(*key),
                )
            )
    return out
