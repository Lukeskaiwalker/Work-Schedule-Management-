"""Werkstatt — Tablet persona reorder endpoints.

Split out of ``workflow_werkstatt_tablet.py`` so each persona sub-module
stays under the 400-line file-size cap. Mounted by the Tablet composite
router (``workflow_werkstatt_tablet.py``).

The submit path auto-sends: it creates a draft and moves it to ``sent`` in
one request, which is exactly why it must run the same pre-send resolution
as the shop hand-over. A reorder is assembled from stock-level suggestions,
not from a supplier's catalogue, so it is the order most likely to carry a
line the supplier cannot identify — and before this check it shipped anyway.

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
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.schemas.werkstatt import (
    ReorderSubmitPayload,
    ReorderSuggestionGroupOut,
    WerkstattOrderOut,
)
from app.schemas.werkstatt_procurement import OrderLineCreatePayload
from app.services.werkstatt_order_lines import build_order_line, create_draft_order
from app.services.werkstatt_order_send import prepare_order_for_send, require_resolved
from app.services.werkstatt_orders import transition_order
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

    articles_by_id = {
        article.id: article
        for article in db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id.in_(article_ids))
        ).all()
    }
    missing = [aid for aid in article_ids if aid not in articles_by_id]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown article id(s): {missing}",
        )

    now = utcnow()
    try:
        order = create_draft_order(
            db,
            supplier=supplier,
            project_id=None,
            title=None,
            source="reorder",
            created_by=current_user.id,
            now=now,
            notes=payload.notes,
        )
        for line_payload in payload.lines:
            build_order_line(
                db,
                order,
                OrderLineCreatePayload(
                    article_id=line_payload.article_id,
                    quantity_ordered=line_payload.quantity,
                    unit_price_cents=line_payload.unit_price_cents,
                ),
                article=articles_by_id[line_payload.article_id],
                now=now,
            )

        # The same gate as the shop hand-over. On a 409 the draft above is
        # rolled back with everything else — the buyer fixes the supplier
        # number on the article and submits again, or overrides.
        preparation = prepare_order_for_send(db, order, backfill=True)
        require_resolved(preparation, allow_unresolved=payload.allow_unresolved)

        # Immediate transition draft → sent.
        transition_order(db, order, "sent", actor_id=current_user.id)
    except HTTPException:
        db.rollback()
        raise

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
