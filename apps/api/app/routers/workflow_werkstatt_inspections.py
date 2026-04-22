"""Werkstatt — Tablet persona BG-Prüfung (inspection) endpoints.

Split out of ``workflow_werkstatt_tablet.py`` so each persona sub-module
stays under the 400-line file-size cap. Mounted by the Tablet composite
router.

See `WERKSTATT_CONTRACT.md` §3.4 for the endpoint contract.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import User, WerkstattArticle
from app.schemas.werkstatt import (
    WerkstattInspectionDueOut,
    WerkstattInspectionRecordPayload,
)
from app.services.werkstatt_inspections import (
    list_inspections_due,
    record_inspection,
)

router = APIRouter(prefix="/werkstatt", tags=["werkstatt-tablet"])


@router.get("/inspections/due", response_model=list[WerkstattInspectionDueOut])
def get_inspections_due(
    days_ahead: int = Query(default=30, ge=0, le=365),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattInspectionDueOut]:
    return list_inspections_due(db, days_ahead=days_ahead)


@router.post(
    "/inspections/{article_id}",
    response_model=WerkstattInspectionDueOut,
)
def record_article_inspection(
    article_id: int,
    payload: WerkstattInspectionRecordPayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattInspectionDueOut:
    article = db.get(WerkstattArticle, article_id)
    if article is None or article.is_archived:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Article not found")
    if not article.bg_inspection_required:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Article does not require BG-Prüfung",
        )

    record_inspection(
        db,
        article,
        passed=payload.passed,
        inspected_at=payload.inspected_at,
        notes=payload.notes,
        actor_id=current_user.id,
    )
    db.commit()
    db.refresh(article)

    # Return the refreshed row in the same shape as the due-list, so the
    # FE can patch its local state without a reload.
    now = utcnow()
    days_until_due = (
        (article.next_bg_due_at - now).days
        if article.next_bg_due_at is not None
        else None
    )
    if days_until_due is None:
        urgency: str = "ok"
    elif days_until_due < 0:
        urgency = "overdue"
    elif days_until_due <= 7:
        urgency = "due_soon"
    else:
        urgency = "ok"

    return WerkstattInspectionDueOut(
        article_id=article.id,
        article_number=article.article_number,
        article_name=article.item_name,
        category_name=None,
        location_name=None,
        last_bg_inspected_at=article.last_bg_inspected_at,
        next_bg_due_at=article.next_bg_due_at,
        days_until_due=days_until_due,
        urgency=urgency,  # type: ignore[arg-type]
    )
