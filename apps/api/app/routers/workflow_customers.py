"""Customer CRUD — first-class replacement for `projects.customer_*`.

Included from `workflow.py` under the `/api` prefix. Endpoints:

  GET   /api/customers              list (aggregates project counts)
  GET   /api/customers/{id}         detail
  GET   /api/customers/{id}/projects linked projects
  POST  /api/customers              create
  PATCH /api/customers/{id}         partial update
  POST  /api/customers/{id}/archive soft-archive
  POST  /api/customers/{id}/unarchive clear archive

No hard delete. Permission piggy-backs on `projects:manage` —
customers are a sub-concept of the project lifecycle. Archiving a
customer does NOT cascade: linked projects keep their customer_id.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import Customer, Project, User
from app.schemas.customer import (
    CustomerCreate,
    CustomerListItemOut,
    CustomerOut,
    CustomerUpdate,
)
from app.schemas.project import ProjectOut
from app.services.customers import sync_project_from_customer

router = APIRouter(prefix="", tags=["customers"])


def _customer_list_item(
    row: Customer,
    *,
    project_count: int,
    active_project_count: int,
    last_project_activity_at,
) -> CustomerListItemOut:
    return CustomerListItemOut.model_validate(
        {
            "id": row.id,
            "name": row.name,
            "address": row.address,
            "contact_person": row.contact_person,
            "email": row.email,
            "phone": row.phone,
            "tax_id": row.tax_id,
            "notes": row.notes,
            "birthday": row.birthday,
            "marktakteur_nummer": row.marktakteur_nummer,
            "archived_at": row.archived_at,
            "created_by": row.created_by,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
            "project_count": project_count,
            "active_project_count": active_project_count,
            "last_project_activity_at": last_project_activity_at,
        }
    )


def _aggregate_project_stats(
    db: Session, customer_ids: list[int]
) -> dict[int, tuple[int, int, object]]:
    """customer_id → (project_count, active_project_count, last_activity_at)."""
    if not customer_ids:
        return {}
    active_case = func.sum(
        func.coalesce(
            # Status != 'archived' is "active" for this aggregate. We use a CASE
            # via func.case for cross-dialect compatibility.
            _active_flag_expr(),
            0,
        )
    )
    rows = db.execute(
        select(
            Project.customer_id,
            func.count(Project.id),
            active_case,
            func.max(Project.last_updated_at),
        )
        .where(Project.customer_id.in_(customer_ids))
        .group_by(Project.customer_id)
    ).all()
    return {
        customer_id: (int(total or 0), int(active or 0), last_at)
        for customer_id, total, active, last_at in rows
    }


def _active_flag_expr():
    # 1 if project is "active" (status != 'archived'), else 0. SQLAlchemy
    # `case()` works on both SQLite (tests) and Postgres.
    from sqlalchemy import case

    return case(
        (Project.status == "archived", 0),
        else_=1,
    )


@router.get("/customers", response_model=list[CustomerListItemOut])
def list_customers(
    q: str | None = Query(default=None),
    archived: bool = Query(default=False),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[CustomerListItemOut]:
    stmt = select(Customer)
    if archived:
        stmt = stmt.where(Customer.archived_at.is_not(None))
    else:
        stmt = stmt.where(Customer.archived_at.is_(None))
    if q and q.strip():
        needle = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Customer.name.ilike(needle),
                Customer.contact_person.ilike(needle),
                Customer.email.ilike(needle),
            )
        )
    stmt = stmt.order_by(Customer.name.asc(), Customer.id.asc()).limit(limit).offset(offset)
    customers = list(db.scalars(stmt).all())
    stats = _aggregate_project_stats(db, [c.id for c in customers])
    return [
        _customer_list_item(
            c,
            project_count=stats.get(c.id, (0, 0, None))[0],
            active_project_count=stats.get(c.id, (0, 0, None))[1],
            last_project_activity_at=stats.get(c.id, (0, 0, None))[2],
        )
        for c in customers
    ]


@router.get("/customers/{customer_id}", response_model=CustomerOut)
def get_customer(
    customer_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Customer:
    row = db.get(Customer, customer_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    return row


@router.get("/customers/{customer_id}/projects", response_model=list[ProjectOut])
def list_customer_projects(
    customer_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    customer = db.get(Customer, customer_id)
    if customer is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    rows = db.scalars(
        select(Project)
        .where(Project.customer_id == customer_id)
        .order_by(Project.last_updated_at.desc().nullslast(), Project.id.desc())
    ).all()
    return list(rows)


@router.post("/customers", response_model=CustomerOut)
def create_customer(
    payload: CustomerCreate,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> Customer:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    row = Customer(
        name=name,
        address=(payload.address or None),
        contact_person=(payload.contact_person or None),
        email=(str(payload.email) if payload.email else None),
        phone=(payload.phone or None),
        tax_id=(payload.tax_id or None),
        notes=(payload.notes or None),
        birthday=payload.birthday,
        marktakteur_nummer=(payload.marktakteur_nummer or None),
        created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/customers/{customer_id}", response_model=CustomerOut)
def update_customer(
    customer_id: int,
    payload: CustomerUpdate,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> Customer:
    row = db.get(Customer, customer_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        if data["name"] is None:
            raise HTTPException(status_code=400, detail="Name is required")
        data["name"] = data["name"].strip()
        if not data["name"]:
            raise HTTPException(status_code=400, detail="Name is required")
    if "email" in data and data["email"] is not None:
        data["email"] = str(data["email"])
    for field, value in data.items():
        setattr(row, field, value)
    row.updated_at = utcnow()
    db.add(row)
    # Keep linked projects' denormalised mirror in step.
    linked_projects = db.scalars(
        select(Project).where(Project.customer_id == customer_id)
    ).all()
    for project in linked_projects:
        sync_project_from_customer(project, row)
        project.last_updated_at = utcnow()
        db.add(project)
    db.commit()
    db.refresh(row)
    return row


@router.post("/customers/{customer_id}/archive", response_model=CustomerOut)
def archive_customer(
    customer_id: int,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> Customer:
    row = db.get(Customer, customer_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    if row.archived_at is None:
        row.archived_at = utcnow()
        row.updated_at = utcnow()
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.post("/customers/{customer_id}/unarchive", response_model=CustomerOut)
def unarchive_customer(
    customer_id: int,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> Customer:
    row = db.get(Customer, customer_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Customer not found")
    if row.archived_at is not None:
        row.archived_at = None
        row.updated_at = utcnow()
        db.add(row)
        db.commit()
        db.refresh(row)
    return row
