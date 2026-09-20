"""The Kundenbesuch feed: what a visit's row looks like on the wire, what a
project's report prints of it, and the one line the change log keeps.

A visit is written up on the customer and may name one of the customer's
projects. A project's Projektbericht opens with the entries linked to it
plus the unlinked ones — those are about the customer as such, and belong
in every project's report. Entries linked to another project of the same
customer are that project's business and stay out.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Sequence

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.entities import CustomerVisit, Project, User
from app.schemas.customer import CustomerVisitOut

# What the activity log keeps of a write-up: enough to recognise it on one
# line of the change log.
VISIT_PREVIEW_CHARS = 120


def visit_preview(summary: str) -> str:
    return " ".join(summary.split())[:VISIT_PREVIEW_CHARS]


def visit_message(visit: CustomerVisit, *, removed: bool = False) -> str:
    """The change-log line: dated when the visit is, plain when it is not."""
    if removed:
        return "Kundenbesuch entfernt"
    if visit.visit_date is not None:
        return f"Kundenbesuch am {visit.visit_date.strftime('%d.%m.%Y')}"
    return "Kundenbesuch erfasst"


def _visitor_names(db: Session, visits: Sequence[CustomerVisit]) -> dict[int, str]:
    user_ids = sorted({visit.visit_by_user_id for visit in visits if visit.visit_by_user_id is not None})
    if not user_ids:
        return {}
    users = db.scalars(select(User).where(User.id.in_(user_ids))).all()
    return {user.id: user.display_name for user in users}


def _project_labels(db: Session, visits: Sequence[CustomerVisit]) -> dict[int, tuple[str, str]]:
    project_ids = sorted({visit.project_id for visit in visits if visit.project_id is not None})
    if not project_ids:
        return {}
    projects = db.scalars(select(Project).where(Project.id.in_(project_ids))).all()
    return {project.id: (project.project_number, project.name) for project in projects}


def visit_out(
    visit: CustomerVisit,
    *,
    visit_by_name: str | None,
    project_label: tuple[str, str] | None,
) -> CustomerVisitOut:
    number, name = project_label if project_label is not None else (None, None)
    return CustomerVisitOut(
        id=visit.id,
        customer_id=visit.customer_id,
        project_id=visit.project_id,
        project_number=number,
        project_name=name,
        visit_date=visit.visit_date,
        visit_by_user_id=visit.visit_by_user_id,
        visit_by_name=visit_by_name,
        summary=visit.summary,
        created_at=visit.created_at,
        updated_at=visit.updated_at,
    )


def visits_out(db: Session, visits: Sequence[CustomerVisit]) -> list[CustomerVisitOut]:
    """The rows with their visitor's name and their project's label — one
    query for all the names and one for all the projects, as the feeds do."""
    names = _visitor_names(db, visits)
    labels = _project_labels(db, visits)
    return [
        visit_out(
            visit,
            visit_by_name=names.get(visit.visit_by_user_id) if visit.visit_by_user_id is not None else None,
            project_label=labels.get(visit.project_id) if visit.project_id is not None else None,
        )
        for visit in visits
    ]


def customer_visits(db: Session, customer_id: int) -> list[CustomerVisit]:
    """The feed, newest posting first."""
    return list(
        db.scalars(
            select(CustomerVisit)
            .where(CustomerVisit.customer_id == customer_id)
            .order_by(CustomerVisit.created_at.desc(), CustomerVisit.id.desc())
        ).all()
    )


def _report_order_key(visit: CustomerVisit) -> tuple[bool, date, datetime, int]:
    # Dated visits in the order they happened; the undated ones after them,
    # in the order they were written up.
    return (visit.visit_date is None, visit.visit_date or date.max, visit.created_at, visit.id)


def report_visits(db: Session, *, customer_id: int, project_id: int) -> list[CustomerVisit]:
    """What a project's report opens with: the customer's entries linked
    to this project or to none, in reading order."""
    rows = db.scalars(
        select(CustomerVisit).where(
            CustomerVisit.customer_id == customer_id,
            or_(CustomerVisit.project_id == project_id, CustomerVisit.project_id.is_(None)),
        )
    ).all()
    return sorted(rows, key=_report_order_key)
