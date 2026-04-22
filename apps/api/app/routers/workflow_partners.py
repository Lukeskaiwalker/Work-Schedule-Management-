"""Partner (external contractor) CRUD.

Included from `workflow.py` under the `/api` prefix. Endpoints:

  GET   /api/partners               list (aggregates task counts)
  GET   /api/partners/{id}          detail
  GET   /api/partners/{id}/tasks    linked tasks
  POST  /api/partners               create
  PATCH /api/partners/{id}          partial update
  POST  /api/partners/{id}/archive  soft-archive
  POST  /api/partners/{id}/unarchive  clear archive

No hard delete. Permission piggy-backs on `projects:manage` —
partners (like customers) are a sub-concept of the project
lifecycle. Archiving a Partner does NOT cascade: linked task rows
in `task_partners` remain in place.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import Partner, Task, TaskPartner, User
from app.schemas.partner import (
    PartnerCreate,
    PartnerListItemOut,
    PartnerOut,
    PartnerUpdate,
)
from app.schemas.task import TaskOut

router = APIRouter(prefix="", tags=["partners"])


def _partner_list_item(
    row: Partner,
    *,
    task_count: int,
    open_task_count: int,
    last_task_activity_at,
) -> PartnerListItemOut:
    return PartnerListItemOut.model_validate(
        {
            "id": row.id,
            "name": row.name,
            "contact_person": row.contact_person,
            "email": row.email,
            "phone": row.phone,
            "address": row.address,
            "trade": row.trade,
            "tax_id": row.tax_id,
            "notes": row.notes,
            "archived_at": row.archived_at,
            "created_by": row.created_by,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
            "task_count": task_count,
            "open_task_count": open_task_count,
            "last_task_activity_at": last_task_activity_at,
        }
    )


def _aggregate_task_stats(
    db: Session, partner_ids: list[int]
) -> dict[int, tuple[int, int, object]]:
    """partner_id -> (task_count, open_task_count, last_activity_at)."""
    if not partner_ids:
        return {}
    open_case = func.sum(
        case(
            (Task.status == "done", 0),
            else_=1,
        )
    )
    rows = db.execute(
        select(
            TaskPartner.partner_id,
            func.count(Task.id),
            open_case,
            func.max(Task.updated_at),
        )
        .join(Task, Task.id == TaskPartner.task_id)
        .where(TaskPartner.partner_id.in_(partner_ids))
        .group_by(TaskPartner.partner_id)
    ).all()
    return {
        partner_id: (int(total or 0), int(open_count or 0), last_at)
        for partner_id, total, open_count, last_at in rows
    }


@router.get("/partners", response_model=list[PartnerListItemOut])
def list_partners(
    q: str | None = Query(default=None),
    archived: bool = Query(default=False),
    trade: str | None = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PartnerListItemOut]:
    stmt = select(Partner)
    if archived:
        stmt = stmt.where(Partner.archived_at.is_not(None))
    else:
        stmt = stmt.where(Partner.archived_at.is_(None))
    if q and q.strip():
        needle = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                Partner.name.ilike(needle),
                Partner.contact_person.ilike(needle),
                Partner.email.ilike(needle),
                Partner.trade.ilike(needle),
            )
        )
    if trade and trade.strip():
        stmt = stmt.where(Partner.trade.ilike(f"%{trade.strip()}%"))
    stmt = (
        stmt.order_by(Partner.name.asc(), Partner.id.asc())
        .limit(limit)
        .offset(offset)
    )
    partners = list(db.scalars(stmt).all())
    stats = _aggregate_task_stats(db, [p.id for p in partners])
    return [
        _partner_list_item(
            p,
            task_count=stats.get(p.id, (0, 0, None))[0],
            open_task_count=stats.get(p.id, (0, 0, None))[1],
            last_task_activity_at=stats.get(p.id, (0, 0, None))[2],
        )
        for p in partners
    ]


@router.get("/partners/{partner_id}", response_model=PartnerOut)
def get_partner(
    partner_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Partner:
    row = db.get(Partner, partner_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Partner not found")
    return row


@router.get("/partners/{partner_id}/tasks", response_model=list[TaskOut])
def list_partner_tasks(
    partner_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from app.routers.workflow_helpers import _tasks_out

    partner = db.get(Partner, partner_id)
    if partner is None:
        raise HTTPException(status_code=404, detail="Partner not found")
    tasks = list(
        db.scalars(
            select(Task)
            .join(TaskPartner, TaskPartner.task_id == Task.id)
            .where(TaskPartner.partner_id == partner_id)
            .order_by(Task.due_date.asc().nullslast(), Task.id.desc())
        ).all()
    )
    return _tasks_out(db, tasks)


@router.post("/partners", response_model=PartnerOut)
def create_partner(
    payload: PartnerCreate,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> Partner:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    row = Partner(
        name=name,
        contact_person=(payload.contact_person or None),
        email=(str(payload.email) if payload.email else None),
        phone=(payload.phone or None),
        address=(payload.address or None),
        trade=(payload.trade.strip() if payload.trade and payload.trade.strip() else None),
        tax_id=(payload.tax_id or None),
        notes=(payload.notes or None),
        created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/partners/{partner_id}", response_model=PartnerOut)
def update_partner(
    partner_id: int,
    payload: PartnerUpdate,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> Partner:
    row = db.get(Partner, partner_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Partner not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        if data["name"] is None:
            raise HTTPException(status_code=400, detail="Name is required")
        data["name"] = data["name"].strip()
        if not data["name"]:
            raise HTTPException(status_code=400, detail="Name is required")
    if "email" in data and data["email"] is not None:
        data["email"] = str(data["email"])
    if "trade" in data and data["trade"] is not None:
        trimmed = data["trade"].strip()
        data["trade"] = trimmed or None
    for field, value in data.items():
        setattr(row, field, value)
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.post("/partners/{partner_id}/archive", response_model=PartnerOut)
def archive_partner(
    partner_id: int,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> Partner:
    row = db.get(Partner, partner_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Partner not found")
    if row.archived_at is None:
        row.archived_at = utcnow()
        row.updated_at = utcnow()
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.post("/partners/{partner_id}/unarchive", response_model=PartnerOut)
def unarchive_partner(
    partner_id: int,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
) -> Partner:
    row = db.get(Partner, partner_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Partner not found")
    if row.archived_at is not None:
        row.archived_at = None
        row.updated_at = utcnow()
        db.add(row)
        db.commit()
        db.refresh(row)
    return row
