"""Werkstatt — Tablet persona reorder endpoints.

Split out of ``workflow_werkstatt_tablet.py`` so each persona sub-module
stays under the 400-line file-size cap. Mounted by the Tablet composite
router (``workflow_werkstatt_tablet.py``).

See `WERKSTATT_CONTRACT.md` §3.4.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
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
    ReorderSubmitPayload,
    ReorderSuggestionGroupOut,
    WerkstattOrderOut,
)
from app.services.werkstatt_orders import (
    generate_order_number,
    transition_order,
)
from app.services.werkstatt_reorder import compute_reorder_suggestions

from app.routers._werkstatt_tablet_shared import (
    compute_total_cents,
    load_order_full,
)

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-tablet"])


@router.get(
    "/reorder/suggestions",
    response_model=list[ReorderSuggestionGroupOut],
)
def get_reorder_suggestions(
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ReorderSuggestionGroupOut]:
    return compute_reorder_suggestions(db)


@router.post(
    "/reorder/submit",
    response_model=WerkstattOrderOut,
)
def submit_reorder(
    payload: ReorderSubmitPayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattOrderOut:
    supplier = db.get(WerkstattSupplier, payload.supplier_id)
    if supplier is None or supplier.is_archived:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Supplier not found"
        )

    article_ids = [line.article_id for line in payload.lines]
    if not article_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Reorder submission requires at least one line",
        )

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

    # Prefetch article-supplier snapshots for this supplier.
    links = db.scalars(
        select(WerkstattArticleSupplier).where(
            WerkstattArticleSupplier.article_id.in_(article_ids),
            WerkstattArticleSupplier.supplier_id == supplier.id,
        )
    ).all()
    links_by_article: dict[int, WerkstattArticleSupplier] = {
        link.article_id: link for link in links
    }

    now = utcnow()
    order = WerkstattOrder(
        order_number=generate_order_number(db, now=now),
        supplier_id=supplier.id,
        status="draft",
        currency="EUR",
        notes=payload.notes,
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    db.add(order)
    db.flush()

    for line_payload in payload.lines:
        link = links_by_article.get(line_payload.article_id)
        unit_price = line_payload.unit_price_cents
        if unit_price is None and link is not None:
            unit_price = link.typical_price_cents
        currency = link.currency if link and link.currency else "EUR"
        line = WerkstattOrderLine(
            order_id=order.id,
            article_id=line_payload.article_id,
            article_supplier_id=link.id if link else None,
            quantity_ordered=line_payload.quantity,
            quantity_received=0,
            unit_price_cents=unit_price,
            currency=currency,
            line_status="pending",
            created_at=now,
            updated_at=now,
        )
        db.add(line)

    db.flush()

    # Immediate transition draft → sent.
    transition_order(db, order, "sent", actor_id=current_user.id)
    order.total_amount_cents = compute_total_cents(
        list(
            db.scalars(
                select(WerkstattOrderLine).where(
                    WerkstattOrderLine.order_id == order.id
                )
            ).all()
        )
    )

    db.commit()
    db.refresh(order)
    return load_order_full(db, order)
