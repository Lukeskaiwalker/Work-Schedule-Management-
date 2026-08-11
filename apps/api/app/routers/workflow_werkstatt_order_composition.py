"""Werkstatt — building an order's contents.

Split from `workflow_werkstatt_orders.py`, which owns the order *lifecycle*
(create, status transitions, delivery). This module owns what is ON an order:
adding and editing lines at any time, merging two orders, saving and applying
templates, and pointing an order at the job it is for.

One rule governs every mutation here: **the order must still be a draft**.
Templates are permanently draft, so the same check covers them without a
special case; and a sent order is a statement about what the wholesaler was
asked for, which must not change after the asking.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    Project,
    Task,
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattOrder,
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.routers._werkstatt_tablet_shared import load_order_full, order_summary
from app.schemas.werkstatt import WerkstattOrderOut, WerkstattOrderSummaryOut
from app.schemas.werkstatt_procurement import (
    OrderApplyTemplatePayload,
    OrderAttachPayload,
    OrderCreateFromTemplatePayload,
    OrderLineCreatePayload,
    OrderLineUpdatePayload,
    OrderMergePayload,
    OrderSaveTemplatePayload,
)
from app.services.werkstatt_order_composition import (
    apply_template,
    merge_orders,
    recompute_total,
    save_as_template,
)
from app.services.werkstatt_orders import generate_order_number

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-procurement"])


def _load_editable(db: Session, order_id: int) -> WerkstattOrder:
    """Fetch an order that may still be changed, or explain why it may not."""

    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden"
        )
    if order.status != "draft":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Bestellung im Status '{order.status}' kann nicht mehr geändert werden",
        )
    return order


# ──────────────────────────────────────────────────────────────────────────
# Lines
# ──────────────────────────────────────────────────────────────────────────


@router.post("/orders/{order_id}/lines", response_model=WerkstattOrderOut)
def add_order_line(
    order_id: int,
    payload: OrderLineCreatePayload,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    """Add one position — a stocked article, or free text.

    When an article is given, its name, EAN and unit are snapshotted onto the
    line and the supplier link supplies a price if the caller did not. That
    keeps a hand-added line indistinguishable from an imported one downstream,
    which is what lets merge and delivery treat them identically.
    """

    order = _load_editable(db, order_id)
    now = utcnow()

    article: WerkstattArticle | None = None
    link: WerkstattArticleSupplier | None = None
    if payload.article_id is not None:
        article = db.get(WerkstattArticle, payload.article_id)
        if article is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Artikel nicht gefunden"
            )
        link = db.scalar(
            select(WerkstattArticleSupplier).where(
                WerkstattArticleSupplier.article_id == article.id,
                WerkstattArticleSupplier.supplier_id == order.supplier_id,
            )
        )
    elif not (payload.description or "").strip() and not (
        payload.supplier_article_no or ""
    ).strip():
        # Without an article, a line needs at least something to identify it,
        # or the order grows a row nobody can act on.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Bitte einen Artikel wählen oder Bezeichnung/Artikelnummer angeben",
        )

    unit_price = payload.unit_price_cents
    if unit_price is None and link is not None:
        unit_price = link.typical_price_cents

    line = WerkstattOrderLine(
        order_id=order.id,
        article_id=article.id if article else None,
        article_supplier_id=link.id if link else None,
        supplier_article_no=(
            payload.supplier_article_no
            or (link.supplier_article_no if link else None)
        ),
        description=payload.description or (article.item_name if article else None),
        manufacturer=payload.manufacturer or (article.manufacturer if article else None),
        ean=payload.ean or (article.ean if article else None),
        unit=payload.unit or (article.unit if article else None),
        quantity_ordered=payload.quantity_ordered,
        quantity_received=0,
        unit_price_cents=unit_price,
        currency=payload.currency or (link.currency if link else order.currency) or "EUR",
        line_status="pending",
        notes=payload.notes,
        created_at=now,
        updated_at=now,
    )
    db.add(line)
    db.flush()
    recompute_total(db, order)
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


@router.patch("/orders/{order_id}/lines/{line_id}", response_model=WerkstattOrderOut)
def update_order_line(
    order_id: int,
    line_id: int,
    payload: OrderLineUpdatePayload,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    """Patch a line. Only the fields actually sent are touched.

    Setting `article_id` promotes a free line to a stocked one, which is how a
    cart position becomes something that moves stock on delivery.
    """

    order = _load_editable(db, order_id)
    line = db.get(WerkstattOrderLine, line_id)
    if line is None or line.order_id != order.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position nicht gefunden")

    fields = payload.model_dump(exclude_unset=True)

    if "article_id" in fields:
        article_id = fields["article_id"]
        if article_id is None:
            line.article_id = None
            line.article_supplier_id = None
        else:
            article = db.get(WerkstattArticle, article_id)
            if article is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="Artikel nicht gefunden"
                )
            line.article_id = article.id
            link = db.scalar(
                select(WerkstattArticleSupplier).where(
                    WerkstattArticleSupplier.article_id == article.id,
                    WerkstattArticleSupplier.supplier_id == order.supplier_id,
                )
            )
            line.article_supplier_id = link.id if link else None

    for name in (
        "supplier_article_no",
        "description",
        "manufacturer",
        "ean",
        "unit",
        "quantity_ordered",
        "unit_price_cents",
        "currency",
        "notes",
    ):
        if name in fields:
            setattr(line, name, fields[name])

    line.updated_at = utcnow()
    db.add(line)
    db.flush()
    recompute_total(db, order)
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


@router.delete("/orders/{order_id}/lines/{line_id}", response_model=WerkstattOrderOut)
def delete_order_line(
    order_id: int,
    line_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    order = _load_editable(db, order_id)
    line = db.get(WerkstattOrderLine, line_id)
    if line is None or line.order_id != order.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Position nicht gefunden")
    db.delete(line)
    db.flush()
    recompute_total(db, order)
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


# ──────────────────────────────────────────────────────────────────────────
# Merge
# ──────────────────────────────────────────────────────────────────────────


@router.post("/orders/{order_id}/merge", response_model=WerkstattOrderOut)
def merge_into_order(
    order_id: int,
    payload: OrderMergePayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    """Fold another draft into this one. The source is retired, not deleted."""

    target = db.get(WerkstattOrder, order_id)
    source = db.get(WerkstattOrder, payload.source_order_id)
    if target is None or source is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden")

    try:
        merge_orders(
            db,
            source=source,
            target=target,
            actor_id=current_user.id,
            combine_duplicates=payload.combine_duplicates,
        )
    except HTTPException:
        db.rollback()
        raise

    db.commit()
    db.refresh(target)
    return load_order_full(db, target)


# ──────────────────────────────────────────────────────────────────────────
# Templates
# ──────────────────────────────────────────────────────────────────────────


@router.get("/order-templates", response_model=list[WerkstattOrderSummaryOut])
def list_order_templates(
    supplier_id: int | None = None,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattOrderSummaryOut]:
    stmt = select(WerkstattOrder).where(WerkstattOrder.is_template.is_(True))
    if supplier_id is not None:
        stmt = stmt.where(WerkstattOrder.supplier_id == supplier_id)
    templates = list(db.scalars(stmt.order_by(WerkstattOrder.template_name.asc())).all())
    if not templates:
        return []

    suppliers = {
        supplier.id: supplier
        for supplier in db.scalars(
            select(WerkstattSupplier).where(
                WerkstattSupplier.id.in_({t.supplier_id for t in templates})
            )
        ).all()
    }
    counts = {
        row[0]: row[1]
        for row in db.execute(
            select(WerkstattOrderLine.order_id, func.count(WerkstattOrderLine.id))
            .where(WerkstattOrderLine.order_id.in_([t.id for t in templates]))
            .group_by(WerkstattOrderLine.order_id)
        ).all()
    }
    now = utcnow()
    return [
        order_summary(template, suppliers.get(template.supplier_id), counts.get(template.id, 0), now)
        for template in templates
    ]


@router.post("/orders/{order_id}/save-as-template", response_model=WerkstattOrderOut)
def save_order_as_template(
    order_id: int,
    payload: OrderSaveTemplatePayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    """Copy this order into a reusable template. The order itself is untouched."""

    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden")
    if order.is_template:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Das ist bereits eine Vorlage"
        )
    template = save_as_template(db, order=order, name=payload.name.strip(), actor_id=current_user.id)
    db.commit()
    db.refresh(template)
    return load_order_full(db, template)


@router.post("/orders/{order_id}/apply-template", response_model=WerkstattOrderOut)
def apply_template_to_order(
    order_id: int,
    payload: OrderApplyTemplatePayload,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    """Append a template's lines to this draft. Composable — apply several."""

    target = db.get(WerkstattOrder, order_id)
    template = db.get(WerkstattOrder, payload.template_id)
    if target is None or template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nicht gefunden")
    try:
        apply_template(db, template=template, target=target)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    db.refresh(target)
    return load_order_full(db, target)


@router.post("/orders/from-template", response_model=WerkstattOrderOut)
def create_order_from_template(
    payload: OrderCreateFromTemplatePayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    """Start a fresh order from a template, optionally attached to a job."""

    template = db.get(WerkstattOrder, payload.template_id)
    if template is None or not template.is_template:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vorlage nicht gefunden")
    if payload.task_id is not None and db.get(Task, payload.task_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Auftrag nicht gefunden")
    if payload.project_id is not None and db.get(Project, payload.project_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Projekt nicht gefunden")

    now = utcnow()
    order = WerkstattOrder(
        order_number=generate_order_number(db, now=now),
        supplier_id=template.supplier_id,
        status="draft",
        currency=template.currency,
        title=payload.title or template.template_name or template.title,
        source="template",
        task_id=payload.task_id,
        project_id=payload.project_id,
        notes=template.notes,
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    db.flush()
    apply_template(db, template=template, target=order, now=now)
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


# ──────────────────────────────────────────────────────────────────────────
# Attachment to jobs
# ──────────────────────────────────────────────────────────────────────────


@router.patch("/orders/{order_id}/attach", response_model=WerkstattOrderOut)
def attach_order(
    order_id: int,
    payload: OrderAttachPayload,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    """Point an order at a task and/or project, or detach it.

    Uses `exclude_unset` so an explicit `null` detaches while an omitted field
    is left alone — otherwise "rename the order" would silently unlink it from
    the job it belongs to.

    Allowed after the order is sent, unlike everything else here: which job the
    material was for is bookkeeping about the order, not a change to what was
    ordered, and it is routinely discovered late.
    """

    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden")

    fields = payload.model_dump(exclude_unset=True)
    if "task_id" in fields:
        task_id = fields["task_id"]
        if task_id is not None:
            task = db.get(Task, task_id)
            if task is None:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND, detail="Auftrag nicht gefunden"
                )
            # Inherit the task's project unless one was named explicitly, so a
            # job-attached order rolls up to the right project without the
            # user having to say it twice.
            if "project_id" not in fields and task.project_id is not None:
                order.project_id = task.project_id
        order.task_id = task_id
    if "project_id" in fields:
        project_id = fields["project_id"]
        if project_id is not None and db.get(Project, project_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Projekt nicht gefunden")
        order.project_id = project_id
    if "title" in fields:
        order.title = fields["title"]

    order.updated_at = utcnow()
    db.add(order)
    db.commit()
    db.refresh(order)
    return load_order_full(db, order)


@router.get("/tasks/{task_id}/orders", response_model=list[WerkstattOrderSummaryOut])
def list_orders_for_task(
    task_id: int,
    include_merged: bool = Query(default=False),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattOrderSummaryOut]:
    """Every order booked to one job — the task-side view of procurement."""

    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Auftrag nicht gefunden")

    stmt = select(WerkstattOrder).where(
        WerkstattOrder.task_id == task_id,
        WerkstattOrder.is_template.is_(False),
    )
    if not include_merged:
        stmt = stmt.where(WerkstattOrder.merged_into_order_id.is_(None))
    orders = list(db.scalars(stmt.order_by(WerkstattOrder.created_at.desc())).all())
    if not orders:
        return []

    suppliers = {
        supplier.id: supplier
        for supplier in db.scalars(
            select(WerkstattSupplier).where(
                WerkstattSupplier.id.in_({o.supplier_id for o in orders})
            )
        ).all()
    }
    counts = {
        row[0]: row[1]
        for row in db.execute(
            select(WerkstattOrderLine.order_id, func.count(WerkstattOrderLine.id))
            .where(WerkstattOrderLine.order_id.in_([o.id for o in orders]))
            .group_by(WerkstattOrderLine.order_id)
        ).all()
    }
    now = utcnow()
    return [
        order_summary(
            order, suppliers.get(order.supplier_id), counts.get(order.id, 0), now, task.title
        )
        for order in orders
    ]
