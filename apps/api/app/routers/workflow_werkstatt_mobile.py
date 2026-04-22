"""Werkstatt — Mobile persona endpoints.

Owned by: Mobile BE agent.

This router covers the "field technician" persona:
  - Scan resolution (cascade: Werkstatt article → supplier article_no →
    catalog item → not_found) — see ``services/werkstatt_scan.py``
  - Quick checkout (entnehmen)
  - Quick return (zurückgeben)
  - Compact movement list (for mobile home screen)
  - "My checkouts" list

See ``WERKSTATT_CONTRACT.md`` §3.1, §3.2 for the endpoint contract,
§5 for file ownership, and §6 for conventions.

Scan cascade order (MUST be preserved exactly):
  1. werkstatt_articles.article_number == code       → kind=werkstatt_article, matched_by=sp
  2. werkstatt_articles.ean == code                  → kind=werkstatt_article, matched_by=ean
  3. werkstatt_article_suppliers.supplier_article_no == code
                                                     → kind=werkstatt_article, matched_by=supplier_no
  4. material_catalog_items.ean == code              → kind=catalog_match, matched_by=catalog_ean
  5. material_catalog_items.article_no == code       → kind=catalog_match, matched_by=catalog_article_no
  6. Otherwise                                       → kind=not_found

Permissions: all endpoints require an authenticated user. Admins with
``werkstatt:manage`` may pass ``?on_behalf_of=<user_id>`` on checkout /
return to operate on another user's behalf, and ``?all=true`` on the
movements list to see system-wide activity.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import has_permission_for_user
from app.models.entities import User, WerkstattArticle, WerkstattMovement
from app.schemas.werkstatt import (
    CheckoutPayload,
    MyCheckoutOut,
    ReturnPayload,
    ScanResolveResult,
    WerkstattArticleOut,
    WerkstattMovementOut,
)
from app.services.werkstatt_movements import (
    MovementError,
    apply_movement,
    build_movement_out_rows,
    list_my_checkouts,
)
from app.services.werkstatt_scan import _article_out, resolve_scan


router = APIRouter(prefix="/werkstatt", tags=["werkstatt-mobile"])


# ──────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────


def _has_manage_perm(user: User) -> bool:
    return has_permission_for_user(user.id, user.role, "werkstatt:manage")


def _resolve_acting_user_id(
    current_user: User,
    *,
    on_behalf_of: int | None,
    db: Session,
) -> int:
    """Resolve the "who is doing the checkout/return" user_id.

    Regular users always act as themselves. Admins with ``werkstatt:manage``
    may pass ``on_behalf_of`` to record the movement against a different
    user. Raises HTTP 403 on privilege mismatch, 404 if the target user
    does not exist / is inactive.
    """

    if on_behalf_of is None or on_behalf_of == current_user.id:
        return current_user.id
    if not _has_manage_perm(current_user):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="werkstatt:manage permission required to act on_behalf_of another user",
        )
    target = db.get(User, int(on_behalf_of))
    if target is None or not target.is_active:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Target user not found",
        )
    return target.id


def _load_article_or_404(db: Session, article_id: int) -> WerkstattArticle:
    article = db.get(WerkstattArticle, int(article_id))
    if article is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Werkstatt article not found",
        )
    if bool(article.is_archived):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Article is archived — no movements allowed",
        )
    return article


# ──────────────────────────────────────────────────────────────────────────
# §3.1 Scan resolution
# ──────────────────────────────────────────────────────────────────────────


@router.get("/scan/resolve", response_model=ScanResolveResult)
def scan_resolve(
    code: str = Query(..., description="Raw scanned code (EAN, SP-Nr, supplier article no, …)"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ScanResolveResult:
    """Run the 6-step scan cascade (see module docstring for ordering).

    Any authenticated user may call this endpoint.
    """

    _ = current_user  # auth enforcement only — no per-user filtering
    return resolve_scan(db, code)


# ──────────────────────────────────────────────────────────────────────────
# §3.2 Quick checkout / return
# ──────────────────────────────────────────────────────────────────────────


@router.post("/mobile/checkout", response_model=WerkstattArticleOut)
def mobile_checkout(
    payload: CheckoutPayload,
    on_behalf_of: int | None = Query(default=None, ge=1),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    """Record a checkout movement and return the updated article snapshot.

    ``assignee_user_id`` (optional body field) is who *receives* the tool;
    ``user_id`` on the ledger is always who *performed* the transaction
    (the caller, or the ``on_behalf_of`` user when an admin acts for them).
    """

    article = _load_article_or_404(db, payload.article_id)
    acting_user_id = _resolve_acting_user_id(
        current_user, on_behalf_of=on_behalf_of, db=db
    )

    # If assignee_user_id was not provided, the tool goes to whoever is
    # performing the checkout. This matches the field-tech default of
    # "I'm taking this for myself".
    assignee = payload.assignee_user_id
    if assignee is None:
        assignee = acting_user_id
    else:
        assignee_user = db.get(User, int(assignee))
        if assignee_user is None or not assignee_user.is_active:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Assignee user not found",
            )

    try:
        apply_movement(
            db,
            article=article,
            movement_type="checkout",
            quantity=payload.quantity,
            user_id=acting_user_id,
            assignee_user_id=assignee,
            project_id=payload.project_id,
            expected_return_at=payload.expected_return_at,
            notes=payload.notes,
        )
    except MovementError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    db.commit()
    db.refresh(article)
    return _article_out(db, article)


@router.post("/mobile/return", response_model=WerkstattArticleOut)
def mobile_return(
    payload: ReturnPayload,
    on_behalf_of: int | None = Query(default=None, ge=1),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    """Record a return / repair_out / correction movement (depending on
    ``condition``) and return the updated article snapshot.

    Condition mapping:
      - ``ok``     → ``return``
      - ``repair`` → ``repair_out``
      - ``lost``   → ``correction`` (shrinks stock_total too)
    """

    article = _load_article_or_404(db, payload.article_id)
    acting_user_id = _resolve_acting_user_id(
        current_user, on_behalf_of=on_behalf_of, db=db
    )

    if payload.condition == "ok":
        movement_type = "return"
    elif payload.condition == "repair":
        movement_type = "repair_out"
    else:  # "lost"
        movement_type = "correction"

    try:
        apply_movement(
            db,
            article=article,
            movement_type=movement_type,
            quantity=payload.quantity,
            user_id=acting_user_id,
            notes=payload.notes,
        )
    except MovementError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc

    db.commit()
    db.refresh(article)
    return _article_out(db, article)


# ──────────────────────────────────────────────────────────────────────────
# Movement list / My checkouts
# ──────────────────────────────────────────────────────────────────────────


@router.get("/mobile/movements", response_model=list[WerkstattMovementOut])
def mobile_movements(
    limit: int = Query(default=20, ge=1, le=200),
    all_movements: bool = Query(default=False, alias="all"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattMovementOut]:
    """Compact list of recent movements for the mobile home screen.

    Defaults to the caller's own movements (as performer or assignee).
    Admins with ``werkstatt:manage`` may pass ``?all=true`` to see
    every movement across the team.
    """

    stmt = select(WerkstattMovement).order_by(
        desc(WerkstattMovement.created_at), desc(WerkstattMovement.id)
    )
    if all_movements:
        if not _has_manage_perm(current_user):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="werkstatt:manage permission required for ?all=true",
            )
    else:
        stmt = stmt.where(
            (WerkstattMovement.user_id == current_user.id)
            | (WerkstattMovement.assignee_user_id == current_user.id)
        )

    rows = list(db.scalars(stmt.limit(limit)).all())
    return [WerkstattMovementOut(**row) for row in build_movement_out_rows(db, rows)]


@router.get("/mobile/my-checkouts", response_model=list[MyCheckoutOut])
def mobile_my_checkouts(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MyCheckoutOut]:
    """Return the caller's outstanding checkouts — one row per distinct
    ``(article, project)`` tuple with ``quantity_out > 0``.

    Matches the "I still have these tools" card on the mobile home screen.
    """

    raw_rows = list_my_checkouts(db, current_user.id)
    return [MyCheckoutOut(**row) for row in raw_rows]
