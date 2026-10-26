"""The Materialliste of a Verteiler, and the boards a person touched last.

Split out of ``workflow_schaltplan`` (which owns the plan itself, its PDF
and its labels) because this is the Werkstatt's view of a board: what goes
in, what was scanned in, which shelf article a line means. Same prefix,
same access rules — reading follows the plan's visibility, writing needs
``reports:create`` like editing the plan does.

The Regal station's own endpoints live in ``workflow_station_werkstatt``;
both call the same ``services/schaltplan_material`` functions, so a scan at
the wall and a "+1" in the browser write the identical ledger row.

Returns are the exception to ``reports:create``: booking a part taken out of
a cabinet module back onto the shelf ("Ins Lager", the ``salvage`` ledger
type) raises stock without an earlier decrement, so it — and saying which
article a removed line means — needs ``werkstatt:manage``, the grant
``inventory_plus`` needs (docs/PANEL_ENCLOSURE.md D6, D11, §15).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import assert_project_access, get_current_user, require_permission
from app.core.permissions import has_permission_for_user
from app.core.time import to_naive_utc
from app.models.entities import User, WerkstattArticle, WerkstattMovement
from app.models.schaltplan import PanelMaterialManualLine, PanelPlan, PanelWorkSession
from app.routers.workflow_helpers import _content_disposition
from app.routers.workflow_schaltplan import _assert_readable, _get_plan_or_404, _load_names, _summary
from app.schemas.schaltplan import (
    PanelMaterialBookRequest,
    PanelMaterialManualCreate,
    PanelMaterialManualUpdate,
    PanelMaterialMappingOut,
    PanelMaterialMappingRequest,
    PanelMaterialOut,
    PanelMaterialSummaryOut,
    PanelPlanSummary,
    PanelWorkSessionEndRequest,
)
from app.services import panel_enclosure_material as enclosure_material
from app.services import panel_work
from app.services import schaltplan_material as material
from app.services.runtime_settings import get_company_settings
from app.services.schaltplan_material_pdf import build_material_pdf
from app.services.werkstatt_movements import load_article_for_update

router = APIRouter(prefix="/schaltplan", tags=["schaltplan"])

RECENT_LIMIT_MAX = 25
#: Lines added by hand per board. A real list stays far below (a board's whole
#: Materialliste is rarely 50 lines); the cap stops a runaway client.
MAX_MANUAL_LINES = 200
#: Line keys a mapping may name: the derived planned lines, the cabinet
#: preparation's wires and ``prep:`` parts included (R4 §6: they have no
#: article number to match). ``article:`` (an unplanned booking) and
#: ``salvage:`` (an orphaned return) name an article already and are refused.
MAPPABLE_PREFIXES = ("device:", "part:", "enclosure:", "module:", "accessory:", "wire:", "prep:")
RETURN_PREFIX = "removed:"


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


# ── Returns: parts taken out of a cabinet module (docs/PANEL_ENCLOSURE.md §6) ──


@router.post("/panels/{plan_id}/material/salvage", response_model=PanelMaterialOut)
def salvage_material(
    plan_id: int,
    payload: PanelMaterialBookRequest,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    """Book a part taken out of a module back into stock — "Ins Lager"."""
    return _book_return(db, current_user, plan_id, payload, enclosure_material.book_salvage)


@router.post("/panels/{plan_id}/material/unsalvage", response_model=PanelMaterialOut)
def unsalvage_material(
    plan_id: int,
    payload: PanelMaterialBookRequest,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    """Take a return back — bounded by the board's returns and by the shelf."""
    return _book_return(db, current_user, plan_id, payload, enclosure_material.undo_salvage)


def _book_return(
    db: Session, user: User, plan_id: int, payload: PanelMaterialBookRequest, book: Callable[..., WerkstattMovement]
) -> PanelMaterialOut:
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, user, plan)
    # Locked: the shelf bound of a take-back reads the very counter a booking
    # elsewhere may be changing (werkstatt_movements.load_article_for_update).
    article = load_article_for_update(db, payload.article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Artikel nicht gefunden")
    try:
        book(db, plan=plan, article=article, quantity=payload.quantity, user_id=user.id)
    except material.MaterialError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return material.panel_material(db, plan)


# ── Lines added by hand, and the list as a PDF (owner, 2026-10-09) ──────────


def _manual_line_or_404(db: Session, plan: PanelPlan, line_id: int) -> PanelMaterialManualLine:
    row = db.get(PanelMaterialManualLine, line_id)
    if row is None or row.panel_id != plan.id:
        raise HTTPException(status_code=404, detail="Position nicht gefunden")
    return row


@router.post("/panels/{plan_id}/material/manual", response_model=PanelMaterialOut)
def add_manual_material(
    plan_id: int,
    payload: PanelMaterialManualCreate,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    """Add material the schematic cannot derive: a shelf article or a free
    text, with a quantity. Same bar as booking."""
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    existing = db.scalar(
        select(func.count(PanelMaterialManualLine.id)).where(PanelMaterialManualLine.panel_id == plan.id)
    )
    if int(existing or 0) >= MAX_MANUAL_LINES:
        raise HTTPException(status_code=400, detail=f"Höchstens {MAX_MANUAL_LINES} Positionen von Hand je Verteiler.")
    article = _article_or_404(db, payload.article_id) if payload.article_id is not None else None
    if article is not None and bool(article.is_archived):
        raise HTTPException(status_code=400, detail="Artikel ist archiviert.")
    label = (article.item_name if article is not None else payload.label) or ""
    db.add(
        PanelMaterialManualLine(
            panel_id=plan.id,
            article_id=article.id if article is not None else None,
            label=label[:255],
            quantity=payload.quantity,
            note=payload.note,
            created_by=current_user.id,
        )
    )
    db.commit()
    return material.panel_material(db, plan)


@router.patch("/panels/{plan_id}/material/manual/{line_id}", response_model=PanelMaterialOut)
def update_manual_material(
    plan_id: int,
    line_id: int,
    payload: PanelMaterialManualUpdate,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    row = _manual_line_or_404(db, plan, line_id)
    if payload.quantity is not None:
        row.quantity = payload.quantity
    if payload.label is not None and payload.label.strip():
        row.label = payload.label.strip()[:255]
    if payload.note is not None:
        row.note = payload.note.strip() or None
    db.add(row)
    db.commit()
    return material.panel_material(db, plan)


@router.delete("/panels/{plan_id}/material/manual/{line_id}", response_model=PanelMaterialOut)
def delete_manual_material(
    plan_id: int,
    line_id: int,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    """Remove a hand-added line. Bookings against its article stay booked —
    they then show as "nicht geplant", which is what really went in."""
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    db.delete(_manual_line_or_404(db, plan, line_id))
    db.commit()
    return material.panel_material(db, plan)


@router.get("/panels/{plan_id}/material/pdf")
def panel_material_pdf(
    plan_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The Materialliste as an A4 PDF: every line, planned and booked."""
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    pdf = build_material_pdf(
        material=material.panel_material(db, plan),
        company_name=get_company_settings(db).get("company_name"),
    )
    file_name = f"Materialliste_{plan.panel_number}_{datetime.now():%Y-%m-%d}.pdf".replace(" ", "_")
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(file_name, inline=True)},
    )


@router.put("/material/mapping", response_model=PanelMaterialMappingOut)
def set_material_mapping(
    payload: PanelMaterialMappingRequest,
    current_user: User = Depends(require_permission("reports:create")),
    db: Session = Depends(get_db),
) -> PanelMaterialMappingOut:
    """Tell every board which stock article a planned line means.

    Global by design (see ``models.schaltplan.PanelMaterialArticle``);
    ``article_id: null`` forgets it, after which a WAGO part or a cabinet
    line falls back to the automatic match and anything else shows the
    assign control again. A removed line's article is what a return books
    into stock, so only the Werkstatt says (or forgets) which one it is.
    """
    key = payload.key.strip()
    if key.startswith(RETURN_PREFIX):
        if not has_permission_for_user(current_user.id, current_user.role, "werkstatt:manage"):
            raise HTTPException(status_code=403, detail="Rückläufe ordnet die Werkstatt zu.")
    elif not key.startswith(MAPPABLE_PREFIXES):
        raise HTTPException(
            status_code=400,
            detail=(
                "Nur geplante Positionen (Gerät, Klemme, Schrank, Modul, Zubehör, Aderleitung, Schrankvorbereitung, "
                "Rücklauf) können zugeordnet werden."
            ),
        )
    article = _article_or_404(db, payload.article_id) if payload.article_id is not None else None
    if article is not None and bool(article.is_archived):
        raise HTTPException(status_code=400, detail="Artikel ist archiviert.")
    material.set_mapping(db, key=key, article=article, user_id=current_user.id)
    db.commit()
    return PanelMaterialMappingOut(key=key, article=material.article_out(article) if article is not None else None)


@router.post("/panels/{plan_id}/work-sessions/{session_id}/end", response_model=PanelMaterialOut)
def end_work_session(
    plan_id: int,
    session_id: int,
    payload: PanelWorkSessionEndRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> PanelMaterialOut:
    """Close a running session by hand -- the fix for a forgotten clock-out.

    Your own session: anybody who can see the board, because forgetting to scan
    out is the commonest thing that will happen and the person who forgot is the
    one who knows when they stopped. Somebody else's: ``werkstatt:manage``,
    because that edits a colleague's hours. The end time may be given and should
    be: "ended now" the morning after is fifteen hours nobody worked.
    """
    plan = _get_plan_or_404(db, plan_id)
    _assert_readable(db, current_user, plan)
    session = db.get(PanelWorkSession, session_id)
    if session is None or session.panel_id != plan.id:
        raise HTTPException(status_code=404, detail="Arbeitszeit nicht gefunden")
    if session.user_id != current_user.id and not has_permission_for_user(
        current_user.id, current_user.role, "werkstatt:manage"
    ):
        raise HTTPException(status_code=403, detail="Permission denied")
    if session.ended_at is not None:
        raise HTTPException(status_code=409, detail="Diese Arbeitszeit ist bereits beendet.")
    try:
        panel_work.end_session(
            db, session, actor=current_user, ended_at=to_naive_utc(payload.ended_at)
        )
    except panel_work.WorkSessionError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    return material.panel_material(db, plan)
