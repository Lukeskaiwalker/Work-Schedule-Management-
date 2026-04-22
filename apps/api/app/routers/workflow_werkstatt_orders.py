"""Werkstatt — Tablet persona order-lifecycle endpoints.

Split out of ``workflow_werkstatt_tablet.py`` so each persona sub-module
stays under the 400-line file-size cap. Mounted by the Tablet composite
router.

See `WERKSTATT_CONTRACT.md` §3.4 for the endpoint contract and §6 for
the strict status machine enforced here.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattOrder,
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.schemas.werkstatt import (
    WerkstattOrderCreatePayload,
    WerkstattOrderOut,
    WerkstattOrderStatus,
    WerkstattOrderSummaryOut,
    WerkstattOrderUpdatePayload,
)
from app.services.werkstatt_orders import (
    generate_order_number,
    recompute_expected_delivery,
    transition_order,
)

from app.routers._werkstatt_tablet_shared import (
    compute_total_cents,
    load_order_full,
    order_summary,
)

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-tablet"])


@router.get("/orders", response_model=list[WerkstattOrderSummaryOut])
def list_orders(
    order_status: WerkstattOrderStatus | None = Query(default=None, alias="status"),
    supplier_id: int | None = None,
    overdue_only: bool = False,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattOrderSummaryOut]:
    stmt = select(WerkstattOrder)
    if order_status is not None:
        stmt = stmt.where(WerkstattOrder.status == order_status)
    if supplier_id is not None:
        stmt = stmt.where(WerkstattOrder.supplier_id == supplier_id)
    stmt = stmt.order_by(WerkstattOrder.created_at.desc(), WerkstattOrder.id.desc())
    orders = list(db.scalars(stmt).all())

    if not orders:
        return []

    supplier_ids = {order.supplier_id for order in orders}
    suppliers_by_id: dict[int, WerkstattSupplier] = {}
    if supplier_ids:
        for supplier in db.scalars(
            select(WerkstattSupplier).where(WerkstattSupplier.id.in_(supplier_ids))
        ).all():
            suppliers_by_id[supplier.id] = supplier

    order_ids = [order.id for order in orders]
    line_counts: dict[int, int] = {}
    if order_ids:
        rows = db.execute(
            select(WerkstattOrderLine.order_id, func.count(WerkstattOrderLine.id))
            .where(WerkstattOrderLine.order_id.in_(order_ids))
            .group_by(WerkstattOrderLine.order_id)
        ).all()
        line_counts = {row[0]: row[1] for row in rows}

    now = utcnow()
    out: list[WerkstattOrderSummaryOut] = []
    for order in orders:
        summary = order_summary(
            order,
            suppliers_by_id.get(order.supplier_id),
            line_counts.get(order.id, 0),
            now,
        )
        if overdue_only and (summary.days_overdue is None or summary.days_overdue <= 0):
            continue
        out.append(summary)
    return out


@router.post("/orders", response_model=WerkstattOrderOut)
def create_order(
    payload: WerkstattOrderCreatePayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    supplier = db.get(WerkstattSupplier, payload.supplier_id)
    if supplier is None or supplier.is_archived:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Supplier not found"
        )

    if payload.lines:
        article_ids = [line.article_id for line in payload.lines]
        articles = list(
            db.scalars(
                select(WerkstattArticle).where(WerkstattArticle.id.in_(article_ids))
            ).all()
        )
        articles_by_id = {article.id: article for article in articles}
        missing = [aid for aid in article_ids if aid not in articles_by_id]
        if missing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Unknown article id(s): {missing}",
            )

    now = utcnow()
    order = WerkstattOrder(
        order_number=generate_order_number(db, now=now),
        supplier_id=supplier.id,
        status="draft",
        currency="EUR",
        notes=payload.notes,
        delivery_reference=payload.delivery_reference,
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    db.flush()

    for line_payload in payload.lines:
        link: WerkstattArticleSupplier | None = None
        if line_payload.article_supplier_id is not None:
            link = db.get(WerkstattArticleSupplier, line_payload.article_supplier_id)
            if link is None or link.article_id != line_payload.article_id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="article_supplier_id does not match article_id",
                )
        if link is None:
            link = db.scalar(
                select(WerkstattArticleSupplier).where(
                    WerkstattArticleSupplier.article_id == line_payload.article_id,
                    WerkstattArticleSupplier.supplier_id == supplier.id,
                )
            )
        unit_price = line_payload.unit_price_cents
        if unit_price is None and link is not None:
            unit_price = link.typical_price_cents
        currency = line_payload.currency or (link.currency if link else "EUR")
        line = WerkstattOrderLine(
            order_id=order.id,
            article_id=line_payload.article_id,
            article_supplier_id=link.id if link else None,
            quantity_ordered=line_payload.quantity_ordered,
            quantity_received=0,
            unit_price_cents=unit_price,
            currency=currency,
            line_status="pending",
            notes=line_payload.notes,
            created_at=now,
            updated_at=now,
        )
        db.add(line)

    db.flush()
    order.total_amount_cents = compute_total_cents(
        list(
            db.scalars(
                select(WerkstattOrderLine).where(WerkstattOrderLine.order_id == order.id)
            ).all()
        )
    )
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


@router.get("/orders/{order_id}", response_model=WerkstattOrderOut)
def get_order(
    order_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    return load_order_full(db, order)


@router.patch("/orders/{order_id}", response_model=WerkstattOrderOut)
def update_order(
    order_id: int,
    payload: WerkstattOrderUpdatePayload,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")

    fields = payload.model_dump(exclude_unset=True)
    if "notes" in fields:
        order.notes = fields["notes"]
    if "delivery_reference" in fields:
        order.delivery_reference = fields["delivery_reference"]
    order.updated_at = utcnow()
    db.add(order)
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


@router.post("/orders/{order_id}/mark-sent", response_model=WerkstattOrderOut)
def mark_order_sent(
    order_id: int,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    # transition_order enforces the state machine and stamps ordered_at +
    # expected_delivery_at. We clear ordered_at so the service always
    # recomputes from "now" — but only after the state-machine check
    # passes, to avoid leaving a pending UPDATE in the session on 409.
    previous_ordered_at = order.ordered_at
    try:
        transition_order(db, order, "sent", actor_id=current_user.id)
    except HTTPException:
        db.rollback()
        raise
    # Recompute ordered_at deliberately so a forced re-send stamps now.
    if previous_ordered_at == order.ordered_at:
        order.ordered_at = utcnow()
        recompute_expected_delivery(db, order)
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


@router.post("/orders/{order_id}/mark-delivered", response_model=WerkstattOrderOut)
def mark_order_delivered(
    order_id: int,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    try:
        transition_order(db, order, "delivered", actor_id=current_user.id)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


@router.post("/orders/{order_id}/cancel", response_model=WerkstattOrderOut)
def cancel_order(
    order_id: int,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Order not found")
    if order.status not in {"draft", "sent"}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot cancel order in status '{order.status}'",
        )
    try:
        transition_order(db, order, "cancelled", actor_id=current_user.id)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)
