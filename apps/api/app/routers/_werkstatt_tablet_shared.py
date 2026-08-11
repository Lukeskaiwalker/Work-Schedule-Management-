"""Shared helpers for the Tablet persona sub-routers.

Private to the tablet split (``workflow_werkstatt_tablet.py`` +
``workflow_werkstatt_orders.py`` + ``workflow_werkstatt_reorder.py`` +
``workflow_werkstatt_inspections.py``). The leading underscore signals that
other agents' code should not import from here.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import (
    Project,
    Task,
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattIdsConnection,
    WerkstattOrder,
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.schemas.werkstatt import (
    WerkstattOrderLineOut,
    WerkstattOrderOut,
    WerkstattOrderSummaryOut,
)


def compute_total_cents(lines: list[WerkstattOrderLine]) -> int | None:
    """Sum unit_price_cents × quantity_ordered across priced lines.

    Returns ``None`` when no line has a unit price set, so the UI can
    show "Preis auf Anfrage" instead of a misleading 0-EUR subtotal.
    """

    if not lines:
        return None
    total = 0
    any_priced = False
    for line in lines:
        if line.unit_price_cents is None:
            continue
        total += line.unit_price_cents * line.quantity_ordered
        any_priced = True
    return total if any_priced else None


def _order_line_out(
    line: WerkstattOrderLine,
    article: WerkstattArticle | None,
    article_supplier: WerkstattArticleSupplier | None,
) -> WerkstattOrderLineOut:
    """Project one line, whether or not it resolves to a stocked article.

    `article_name` is resolved here rather than in the UI so there is exactly
    one rule for what a line is called: the stocked article's name wins,
    because that is what the shelf label says; otherwise the supplier's own
    description; otherwise the supplier's article number, so a line is never
    rendered as a blank row.

    `supplier_article_no` prefers the line's own snapshot over the join. The
    snapshot is what we ordered; the link is only what we currently believe,
    and the two diverge as soon as anyone edits the article-supplier record.
    """

    display_name = (
        (article.item_name if article else None)
        or line.description
        or line.supplier_article_no
        or "Unbenannte Position"
    )
    return WerkstattOrderLineOut(
        id=line.id,
        order_id=line.order_id,
        article_id=line.article_id,
        article_number=article.article_number if article else None,
        article_name=display_name,
        article_supplier_id=line.article_supplier_id,
        supplier_article_no=(
            line.supplier_article_no
            or (article_supplier.supplier_article_no if article_supplier else None)
        ),
        description=line.description,
        manufacturer=line.manufacturer or (article.manufacturer if article else None),
        ean=line.ean or (article.ean if article else None),
        unit=line.unit or (article.unit if article else None),
        source_import_id=line.source_import_id,
        is_stocked=line.article_id is not None,
        quantity_ordered=line.quantity_ordered,
        quantity_received=line.quantity_received,
        unit_price_cents=line.unit_price_cents,
        currency=line.currency,
        line_status=line.line_status,  # type: ignore[arg-type]
        received_at=line.received_at,
        notes=line.notes,
        created_at=line.created_at,
        updated_at=line.updated_at,
    )


def load_order_full(db: Session, order: WerkstattOrder) -> WerkstattOrderOut:
    """Hydrate a full order view including lines, supplier, and creator."""

    lines = list(
        db.scalars(
            select(WerkstattOrderLine)
            .where(WerkstattOrderLine.order_id == order.id)
            .order_by(WerkstattOrderLine.id.asc())
        ).all()
    )
    # Free lines carry no article_id; filtering here keeps the IN clause from
    # being handed a NULL that can never match anything.
    article_ids = [line.article_id for line in lines if line.article_id is not None]
    supplier_link_ids = [
        line.article_supplier_id
        for line in lines
        if line.article_supplier_id is not None
    ]
    articles_by_id: dict[int, WerkstattArticle] = {}
    if article_ids:
        for article in db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id.in_(article_ids))
        ).all():
            articles_by_id[article.id] = article
    links_by_id: dict[int, WerkstattArticleSupplier] = {}
    if supplier_link_ids:
        for link in db.scalars(
            select(WerkstattArticleSupplier).where(
                WerkstattArticleSupplier.id.in_(supplier_link_ids)
            )
        ).all():
            links_by_id[link.id] = link

    supplier = db.get(WerkstattSupplier, order.supplier_id)
    creator = db.get(User, order.created_by) if order.created_by else None

    line_outs = [
        _order_line_out(
            line,
            articles_by_id.get(line.article_id) if line.article_id is not None else None,
            links_by_id.get(line.article_supplier_id)
            if line.article_supplier_id is not None
            else None,
        )
        for line in lines
    ]

    total_cents = compute_total_cents(lines)

    task = db.get(Task, order.task_id) if order.task_id else None
    project = db.get(Project, order.project_id) if order.project_id else None
    # Drives whether the UI offers "im Shop bestellen" on this order at all.
    has_shop = (
        db.scalar(
            select(WerkstattIdsConnection.id).where(
                WerkstattIdsConnection.supplier_id == order.supplier_id,
                WerkstattIdsConnection.is_enabled.is_(True),
            )
        )
        is not None
    )

    return WerkstattOrderOut(
        id=order.id,
        order_number=order.order_number,
        supplier_id=order.supplier_id,
        supplier_name=supplier.name if supplier else "",
        status=order.status,  # type: ignore[arg-type]
        total_amount_cents=total_cents,
        currency=order.currency,
        ordered_at=order.ordered_at,
        expected_delivery_at=order.expected_delivery_at,
        delivered_at=order.delivered_at,
        delivery_reference=order.delivery_reference,
        notes=order.notes,
        created_by=order.created_by,
        created_by_name=getattr(creator, "full_name", None) if creator else None,
        line_count=len(line_outs),
        lines=line_outs,
        title=order.title,
        is_template=order.is_template,
        template_name=order.template_name,
        task_id=order.task_id,
        task_title=task.title if task else None,
        project_id=order.project_id,
        project_name=project.name if project else None,
        source=order.source,
        external_reference=order.external_reference,
        merged_into_order_id=order.merged_into_order_id,
        merged_at=order.merged_at,
        submitted_at=order.submitted_at,
        supplier_has_shop=has_shop,
        created_at=order.created_at,
        updated_at=order.updated_at,
    )


def order_summary(
    order: WerkstattOrder,
    supplier: WerkstattSupplier | None,
    line_count: int,
    now: datetime,
    task_title: str | None = None,
) -> WerkstattOrderSummaryOut:
    days_overdue: int | None = None
    if (
        order.expected_delivery_at is not None
        and order.status in {"sent", "confirmed", "partially_delivered"}
        and now > order.expected_delivery_at
    ):
        days_overdue = (now - order.expected_delivery_at).days

    return WerkstattOrderSummaryOut(
        id=order.id,
        order_number=order.order_number,
        supplier_id=order.supplier_id,
        supplier_name=supplier.name if supplier else "",
        status=order.status,  # type: ignore[arg-type]
        total_amount_cents=order.total_amount_cents,
        currency=order.currency,
        ordered_at=order.ordered_at,
        expected_delivery_at=order.expected_delivery_at,
        delivered_at=order.delivered_at,
        line_count=line_count,
        days_overdue=days_overdue,
        title=order.title,
        is_template=order.is_template,
        template_name=order.template_name,
        task_id=order.task_id,
        task_title=task_title,
        project_id=order.project_id,
        source=order.source,
        merged_into_order_id=order.merged_into_order_id,
    )
