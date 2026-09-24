"""The Materialliste of a Verteiler, and the boards a person touched last.

Split out of ``workflow_schaltplan`` (which owns the plan itself, its PDF
and its labels) because this is the Werkstatt's view of a board: what goes
in, what was scanned in, which shelf article a line means. Same prefix,
same access rules — reading follows the plan's visibility, writing needs
``reports:create`` like editing the plan does.

The Regal station's own endpoints live in ``workflow_station_werkstatt``;
both call the same ``services/schaltplan_material`` functions, so a scan at
the wall and a "+1" in the browser write the identical ledger row.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import assert_project_access, get_current_user, require_permission
from app.models.entities import User, WerkstattArticle
from app.models.schaltplan import PanelPlan
from app.routers.workflow_schaltplan import _assert_readable, _get_plan_or_404, _load_names, _summary
from app.schemas.schaltplan import (
    PanelMaterialBookRequest,
    PanelMaterialMappingOut,
    PanelMaterialMappingRequest,
    PanelMaterialOut,
    PanelMaterialSummaryOut,
    PanelPlanSummary,
)
from app.services import schaltplan_material as material

router = APIRouter(prefix="/schaltplan", tags=["schaltplan"])

RECENT_LIMIT_MAX = 25


def _visible_plans(db: Session, current_user: User, plans: list[PanelPlan]) -> list[PanelPlan]:
    """Drop project-linked plans the caller may not see (same rule as the list)."""
    visible: list[PanelPlan] = []
    for plan in plans:
        if plan.project_id is not None:
            try:
                assert_project_access(db, current_user, plan.project_id)
            except HTTPException:
                continue
        visible.append(plan)
    return visible


@router.get("/panels/recent", response_model=list[PanelPlanSummary])
def recent_panels(
    limit: int = Query(default=8, ge=1, le=RECENT_LIMIT_MAX),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PanelPlanSummary]:
    """The boards edited last, newest first — what the search box offers
    before anything is typed. Fetches a few more than asked so a run of
    invisible project boards does not leave the list short."""
    plans = list(db.scalars(select(PanelPlan).order_by(PanelPlan.updated_at.desc(), PanelPlan.id.desc()).limit(limit * 4)))
    visible = _visible_plans(db, current_user, plans)[:limit]
    names = _load_names(db, visible)
    return [_summary(plan, names) for plan in visible]


@router.get("/material/overview", response_model=list[PanelMaterialSummaryOut])
def material_overview(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PanelMaterialSummaryOut]:
    """Every visible board with its picking progress — the Werkstatt tab."""
    plans = _visible_plans(db, current_user, list(db.scalars(select(PanelPlan))))
    return material.material_overview(db, plans)


@router.get("/panels/{plan_id}/material", response_model=PanelMaterialOut)
def panel_material(
    plan_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    return material.panel_material(db, plan)


def _article_or_404(db: Session, article_id: int) -> WerkstattArticle:
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Artikel nicht gefunden")
    return article


@router.post("/panels/{plan_id}/material/book", response_model=PanelMaterialOut)
def book_material(
    plan_id: int,
    payload: PanelMaterialBookRequest,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    """Book an article as built into the board by hand — the browser's "+1"."""
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    article = _article_or_404(db, payload.article_id)
    try:
        material.book_consumption(
            db,
            plan=plan,
            article=article,
            quantity=payload.quantity,
            user_id=current_user.id,
            notes=material.booking_note(plan),
        )
    except material.MaterialError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return material.panel_material(db, plan)


@router.post("/panels/{plan_id}/material/unbook", response_model=PanelMaterialOut)
def unbook_material(
    plan_id: int,
    payload: PanelMaterialBookRequest,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    """Take a booking back — bounded by what the board still has of the article."""
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    article = _article_or_404(db, payload.article_id)
    try:
        material.undo_consumption(
            db,
            plan=plan,
            article=article,
            quantity=payload.quantity,
            user_id=current_user.id,
            notes=material.booking_note(plan, "Storno"),
        )
    except material.MaterialError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return material.panel_material(db, plan)


@router.put("/material/mapping", response_model=PanelMaterialMappingOut)
def set_material_mapping(
    payload: PanelMaterialMappingRequest,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelMaterialMappingOut:
    """Tell every board which stock article a planned line means.

    Global by design (see ``models.schaltplan.PanelMaterialArticle``);
    ``article_id: null`` forgets it, after which a WAGO part falls back to
    the automatic match and anything else shows the assign control again.
    """
    key = payload.key.strip()
    if not (key.startswith("device:") or key.startswith("part:")):
        raise HTTPException(status_code=400, detail="Nur geplante Positionen (device:… / part:…) können zugeordnet werden.")
    article = _article_or_404(db, payload.article_id) if payload.article_id is not None else None
    if article is not None and bool(article.is_archived):
        raise HTTPException(status_code=400, detail="Artikel ist archiviert.")
    material.set_mapping(db, key=key, article=article, user_id=current_user.id)
    db.commit()
    return PanelMaterialMappingOut(key=key, article=material.article_out(article) if article is not None else None)
