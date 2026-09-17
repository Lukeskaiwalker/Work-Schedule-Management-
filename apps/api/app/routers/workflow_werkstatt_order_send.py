"""Werkstatt — seeing and exporting what a supplier will receive.

Two endpoints beside the IDS hand-over in `workflow_werkstatt_ids.py`:

  ``GET /werkstatt/orders/{id}/resolution``
        Read-only, any authenticated user. What each line resolves to under
        the supplier's identifier policy, so the drawer can badge a line red
        BEFORE anybody presses "Im Shop bestellen". Writes nothing — opening
        an order must never be distinguishable from submitting it.

  ``GET /werkstatt/orders/{id}/export``
        `werkstatt:manage`. The hand-over for a supplier without a shop
        connection: a CSV download, the quick-order text, or both as JSON for
        the SPA to copy to the clipboard. Refuses with 409 while a line is
        unresolved unless ``allow_unresolved`` says otherwise, and stamps
        ``submitted_at`` on a draft exactly as the IDS path does — "the
        numbers left the building" means the same thing on both.

Mounted before the tablet router so the literal suffixes are matched before
``GET /werkstatt/orders/{order_id}`` could see them.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import JSONResponse, PlainTextResponse, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import User, WerkstattOrder
from app.schemas.werkstatt_procurement import OrderExportOut, OrderResolutionOut
from app.services.werkstatt_order_export import export_order_items
from app.services.werkstatt_order_send import (
    describe_resolution,
    prepare_order_for_send,
    require_resolved,
)

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-procurement"])

ExportFormat = Literal["csv", "text", "json"]

# Excel opens a UTF-8 CSV with umlauts intact only when it starts with a BOM;
# without one "Möller" reads as "MÃ¶ller" on every Windows desk in the
# office. The JSON variant leaves the BOM out — the SPA adds it when it
# builds the download blob, and a BOM inside a JSON string is only noise.
CSV_BOM = "﻿"


def _load_order(db: Session, order_id: int) -> WerkstattOrder:
    order = db.get(WerkstattOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bestellung nicht gefunden")
    return order


@router.get("/orders/{order_id}/resolution", response_model=OrderResolutionOut)
def order_resolution(
    order_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OrderResolutionOut:
    """Per-line preview of the hand-over. Reads only — see the module header."""

    order = _load_order(db, order_id)
    preparation = prepare_order_for_send(db, order, backfill=False)
    return describe_resolution(db, preparation)


# response_model=None: three renderings leave here (a CSV file, plain text,
# JSON), so the JSON shape is documented by OrderExportOut and built by hand.
@router.get("/orders/{order_id}/export", response_model=None)
def export_order(
    order_id: int,
    export_format: ExportFormat = Query(default="json", alias="format"),
    allow_unresolved: bool = Query(default=False),
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> Response:
    """The manual-channel hand-over.

    Stamps ``submitted_at`` on a draft only. Re-downloading the list for a
    sent order a week later is bookkeeping, not a second hand-over, and must
    not move the timestamp the drawer shows as "übergeben am".
    """

    order = _load_order(db, order_id)
    if order.is_template:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Eine Vorlage kann nicht exportiert werden — bitte zuerst übernehmen",
        )

    preparation = prepare_order_for_send(db, order, backfill=True)
    try:
        require_resolved(preparation, allow_unresolved=allow_unresolved)
    except HTTPException:
        # A refused export writes nothing — not even the resolver's backfill,
        # which would make "I looked at the export button" a data change.
        db.rollback()
        raise

    exported = export_order_items(
        preparation.items,
        preparation.identifier,
        warnings=preparation.warnings,
        channel=preparation.channel,
    )
    if order.status == "draft":
        order.submitted_at = utcnow()
        db.add(order)
    db.commit()
    db.refresh(order)

    filename = f"{order.order_number}.csv"
    if export_format == "csv":
        return Response(
            content=CSV_BOM + exported.csv,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    if export_format == "text":
        return PlainTextResponse(exported.text)
    body = OrderExportOut(
        order_id=order.id,
        order_number=order.order_number,
        filename=filename,
        identifier=preparation.identifier,
        csv=exported.csv,
        text=exported.text,
        warnings=list(exported.warnings),
        sent_positions=exported.sent_positions,
        dropped_positions=exported.dropped_positions,
        submitted_at=order.submitted_at,
    )
    return JSONResponse(content=body.model_dump(mode="json"))
