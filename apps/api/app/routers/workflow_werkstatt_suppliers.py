"""Werkstatt supplier CRUD.

Included from `workflow_werkstatt_desktop.py`. Endpoints:

- GET/POST/PATCH/DELETE /werkstatt/suppliers

List response denormalises `article_count` (non-archived
werkstatt_article_suppliers links) and `last_order_at` (max(ordered_at) across
werkstatt_orders for the supplier).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    User,
    WerkstattArticleSupplier,
    WerkstattOrder,
    WerkstattSupplier,
)
from app.schemas.werkstatt import (
    WerkstattSupplierCreate,
    WerkstattSupplierOut,
    WerkstattSupplierUpdate,
)

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


def _supplier_article_counts(db: Session) -> dict[int, int]:
    rows = db.execute(
        select(
            WerkstattArticleSupplier.supplier_id,
            func.count(WerkstattArticleSupplier.id),
        ).group_by(WerkstattArticleSupplier.supplier_id)
    ).all()
    return {sid: int(count) for sid, count in rows}


def _supplier_last_order_at(db: Session) -> dict[int, object]:
    rows = db.execute(
        select(WerkstattOrder.supplier_id, func.max(WerkstattOrder.ordered_at))
        .where(WerkstattOrder.ordered_at.is_not(None))
        .group_by(WerkstattOrder.supplier_id)
    ).all()
    return {sid: ordered_at for sid, ordered_at in rows}


def _supplier_out(
    row: WerkstattSupplier,
    *,
    article_count: int = 0,
    last_order_at=None,
) -> WerkstattSupplierOut:
    return WerkstattSupplierOut(
        id=row.id,
        name=row.name,
        short_name=row.short_name,
        email=row.email,
        order_email=row.order_email,
        phone=row.phone,
        contact_person=row.contact_person,
        address_street=row.address_street,
        address_zip=row.address_zip,
        address_city=row.address_city,
        address_country=row.address_country,
        default_lead_time_days=row.default_lead_time_days,
        notes=row.notes,
        is_archived=row.is_archived,
        article_count=article_count,
        last_order_at=last_order_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.get("/suppliers", response_model=list[WerkstattSupplierOut])
def list_suppliers(
    include_archived: bool = Query(default=False),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattSupplierOut]:
    stmt = select(WerkstattSupplier)
    if not include_archived:
        stmt = stmt.where(WerkstattSupplier.is_archived.is_(False))
    stmt = stmt.order_by(WerkstattSupplier.name.asc(), WerkstattSupplier.id.asc())
    rows = list(db.scalars(stmt).all())
    counts = _supplier_article_counts(db)
    last_orders = _supplier_last_order_at(db)
    return [
        _supplier_out(
            r,
            article_count=counts.get(r.id, 0),
            last_order_at=last_orders.get(r.id),
        )
        for r in rows
    ]


@router.post("/suppliers", response_model=WerkstattSupplierOut)
def create_supplier(
    payload: WerkstattSupplierCreate,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattSupplierOut:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    existing = db.scalar(select(WerkstattSupplier).where(WerkstattSupplier.name == name))
    if existing is not None:
        raise HTTPException(status_code=400, detail="Supplier name already exists")
    row = WerkstattSupplier(
        name=name,
        short_name=(payload.short_name or None),
        email=(payload.email or None),
        order_email=(payload.order_email or None),
        phone=(payload.phone or None),
        contact_person=(payload.contact_person or None),
        address_street=(payload.address_street or None),
        address_zip=(payload.address_zip or None),
        address_city=(payload.address_city or None),
        address_country=(payload.address_country or None),
        default_lead_time_days=payload.default_lead_time_days,
        notes=(payload.notes or None),
        created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _supplier_out(row)


@router.patch("/suppliers/{supplier_id}", response_model=WerkstattSupplierOut)
def update_supplier(
    supplier_id: int,
    payload: WerkstattSupplierUpdate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattSupplierOut:
    row = db.get(WerkstattSupplier, supplier_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Supplier not found")
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        data["name"] = data["name"].strip()
        if not data["name"]:
            raise HTTPException(status_code=400, detail="Name is required")
        clash = db.scalar(
            select(WerkstattSupplier).where(
                WerkstattSupplier.name == data["name"],
                WerkstattSupplier.id != supplier_id,
            )
        )
        if clash is not None:
            raise HTTPException(status_code=400, detail="Supplier name already exists")
    for field, value in data.items():
        setattr(row, field, value)
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _supplier_out(row)


@router.delete("/suppliers/{supplier_id}", response_model=WerkstattSupplierOut)
def archive_supplier(
    supplier_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattSupplierOut:
    row = db.get(WerkstattSupplier, supplier_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Supplier not found")
    row.is_archived = True
    row.updated_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _supplier_out(row)
