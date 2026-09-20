"""The customer's Kundenbesuch feed.

``GET/POST /customers/{id}/visits``, ``PATCH/DELETE /customers/{id}/visits/{visit_id}``
— one entry per visit at the customer, each optionally linked to one of the
customer's projects. The single write-up the customer used to carry became
the feed's first entry (migration 0093). A project's Projektbericht opens
with the entries linked to it plus the unlinked ones.

Where an entry logs follows where it lives, as a task's does: linked to a
project, its ``project.visit_*`` row is on that project (the customer's
change log unions the project logs, so a second row on the customer would
show the same event twice); unlinked, it is a ``customer.visit_*`` row on
the customer.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import assert_project_access, get_current_user
from app.core.permissions import has_permission_for_user
from app.core.time import utcnow
from app.models.entities import Customer, CustomerVisit, Project, User
from app.routers.workflow_helpers import _assert_customer_files_access, _record_project_activity
from app.schemas.customer import CustomerVisitCreate, CustomerVisitOut, CustomerVisitUpdate
from app.services.customer_activity import record_customer_activity
from app.services.customer_visits import (
    customer_visits,
    visit_message,
    visit_preview,
    visits_out,
)

router = APIRouter(prefix="", tags=["customer-visits"])


# ── Shared with customer creation ─────────────────────────────────────────────


def _resolve_project(db: Session, user: User, *, customer_id: int, project_id: int) -> Project:
    """The project an entry names must be one of this customer's — a
    write-up about another customer's job is a 400, not a foreign key that
    happens to exist — and one the poster may open."""
    project = db.get(Project, project_id)
    if project is None or project.customer_id != customer_id:
        raise HTTPException(status_code=400, detail="Project does not belong to this customer")
    assert_project_access(db, user, project.id)
    return project


def _assert_known_visitor(db: Session, user_id: int | None) -> None:
    """A visitor the payload names must exist — a bad id is a 400 here,
    not a foreign-key error on commit."""
    if user_id is not None and db.get(User, user_id) is None:
        raise HTTPException(status_code=400, detail="Unknown visit_by_user_id")


def _record_visit_event(db: Session, visit: CustomerVisit, *, actor_user_id: int, action: str) -> None:
    """``posted`` / ``updated`` / ``deleted``, on the project when the entry
    names one and on the customer otherwise."""
    message = visit_message(visit, removed=action == "deleted")
    details = {
        "visit_id": visit.id,
        "visit_date": visit.visit_date.isoformat() if visit.visit_date else None,
        "project_id": visit.project_id,
        "preview": visit_preview(visit.summary),
    }
    if visit.project_id is not None:
        _record_project_activity(
            db,
            project_id=visit.project_id,
            actor_user_id=actor_user_id,
            event_type=f"project.visit_{action}",
            message=message,
            details=details,
        )
    else:
        record_customer_activity(
            db,
            customer_id=visit.customer_id,
            actor_user_id=actor_user_id,
            event_type=f"customer.visit_{action}",
            message=message,
            details=details,
        )


def add_customer_visit(
    db: Session,
    *,
    customer: Customer,
    payload: CustomerVisitCreate,
    actor_user_id: int,
    user: User | None = None,
) -> CustomerVisit:
    """Add an entry and its change-log row; flushed, not committed — the
    caller's transaction decides. ``user`` is needed only to check a
    project link (customer creation has none to check)."""
    if payload.project_id is not None:
        if user is None:
            raise HTTPException(status_code=400, detail="A new customer has no project to link the visit to")
        _resolve_project(db, user, customer_id=customer.id, project_id=payload.project_id)
    _assert_known_visitor(db, payload.visit_by_user_id)
    now = utcnow()
    visit = CustomerVisit(
        customer_id=customer.id,
        project_id=payload.project_id,
        visit_date=payload.visit_date,
        # Whoever posts the entry went, unless the payload names someone else.
        visit_by_user_id=payload.visit_by_user_id if payload.visit_by_user_id is not None else actor_user_id,
        summary=payload.summary,
        created_at=now,
        updated_at=now,
    )
    db.add(visit)
    db.flush()
    _record_visit_event(db, visit, actor_user_id=actor_user_id, action="posted")
    return visit


# ── Endpoints ─────────────────────────────────────────────────────────────────


def _visit_on_customer(db: Session, customer_id: int, visit_id: int) -> CustomerVisit:
    visit = db.get(CustomerVisit, visit_id)
    # An entry of another customer is "not found" here rather than
    # "forbidden": the URL names a customer, and this entry is not on it.
    if visit is None or visit.customer_id != customer_id:
        raise HTTPException(status_code=404, detail="Visit not found")
    return visit


def _assert_may_edit(visit: CustomerVisit, user: User) -> None:
    """The one who went, or a project manager's clean-up. The entry the
    migration carried over without a visitor is a manager's to edit."""
    is_visitor = visit.visit_by_user_id is not None and visit.visit_by_user_id == user.id
    if not is_visitor and not has_permission_for_user(user.id, user.role, "projects:manage"):
        raise HTTPException(status_code=403, detail="Only the visitor or a project manager can change a visit")


@router.get("/customers/{customer_id}/visits", response_model=list[CustomerVisitOut])
def list_customer_visits(
    customer_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Who may open the customer's files may read the feed: the rule borrowed
    # from the projects (docs/FILE_SCOPES.md). Unknown customer is a 404.
    _assert_customer_files_access(db, current_user, customer_id)
    return visits_out(db, customer_visits(db, customer_id))


@router.post("/customers/{customer_id}/visits", response_model=CustomerVisitOut)
def post_customer_visit(
    customer_id: int,
    payload: CustomerVisitCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Read access is enough to post — the fitter who was on site writes
    # what they found, not only the office.
    customer = _assert_customer_files_access(db, current_user, customer_id)
    visit = add_customer_visit(db, customer=customer, payload=payload, actor_user_id=current_user.id, user=current_user)
    db.commit()
    db.refresh(visit)
    return visits_out(db, [visit])[0]


@router.patch("/customers/{customer_id}/visits/{visit_id}", response_model=CustomerVisitOut)
def update_customer_visit(
    customer_id: int,
    visit_id: int,
    payload: CustomerVisitUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    visit = _visit_on_customer(db, customer_id, visit_id)
    _assert_may_edit(visit, current_user)
    data = payload.model_dump(exclude_unset=True)
    if "summary" in data and data["summary"] is None:
        raise HTTPException(status_code=400, detail="Visit summary must not be empty")
    if data.get("project_id") is not None:
        _resolve_project(db, current_user, customer_id=customer_id, project_id=data["project_id"])
    if "visit_by_user_id" in data:
        _assert_known_visitor(db, data["visit_by_user_id"])
    for field, value in data.items():
        setattr(visit, field, value)
    visit.updated_at = utcnow()
    db.add(visit)
    _record_visit_event(db, visit, actor_user_id=current_user.id, action="updated")
    db.commit()
    db.refresh(visit)
    return visits_out(db, [visit])[0]


@router.delete("/customers/{customer_id}/visits/{visit_id}", status_code=204)
def delete_customer_visit(
    customer_id: int,
    visit_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_customer_files_access(db, current_user, customer_id)
    visit = _visit_on_customer(db, customer_id, visit_id)
    _assert_may_edit(visit, current_user)
    # The log row is written before the delete: it names the entry's id and
    # where it was linked, which the deleted row can no longer tell.
    _record_visit_event(db, visit, actor_user_id=current_user.id, action="deleted")
    db.delete(visit)
    db.commit()
