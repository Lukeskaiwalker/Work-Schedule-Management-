"""Inventur endpoints — starting, counting into, and closing a stock-take.

The hot path is ``POST /sessions/{id}/scan``. It is deliberately the only
request a scan makes: resolve, count, and answer in one round trip, because
the operator is standing at a shelf with a scanner and any second request is a
second chance to stall. See services/werkstatt_inventory.py for why an unknown
catalog code creates an article instead of asking a question.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattInventoryCount,
    WerkstattInventorySession,
)
from app.schemas.werkstatt import (
    InventoryCountOut,
    InventoryImportRequest,
    InventoryImportResult,
    InventoryCountSet,
    InventoryFinalizeResult,
    InventoryNameNewArticle,
    InventoryScanRequest,
    InventoryScanResult,
    InventorySessionCreate,
    InventorySessionDetailOut,
    InventorySessionOut,
)
from app.services.werkstatt_article_numbers import next_article_number
from app.services.werkstatt_inventory import (
    ImportRow,
    finalize_session,
    import_counts,
    looks_like_ean,
    scan_into_session,
)
from app.services.werkstatt_inventory import _bump as bump_count  # noqa: PLC2701 — same package
from app.routers.workflow_werkstatt_article_mappers import article_full_out

router = APIRouter(prefix="/werkstatt/inventory", tags=["werkstatt-inventory"])

_MANAGE = require_permission("werkstatt:manage")


def _counts_for(db: Session, session_id: int) -> list[InventoryCountOut]:
    rows = list(
        db.scalars(
            select(WerkstattInventoryCount)
            .where(WerkstattInventoryCount.session_id == session_id)
            .order_by(WerkstattInventoryCount.last_counted_at.desc())
        ).all()
    )
    out: list[InventoryCountOut] = []
    for row in rows:
        article = db.get(WerkstattArticle, row.article_id)
        if article is None:
            continue
        expected = int(article.stock_available or 0)
        out.append(
            InventoryCountOut(
                article_id=article.id,
                article_number=article.article_number,
                item_name=article.item_name,
                ean=article.ean,
                unit=article.unit,
                counted_qty=int(row.counted_qty),
                scan_count=int(row.scan_count),
                expected_qty=expected,
                delta=int(row.counted_qty) - expected,
            )
        )
    return out


def _session_out(db: Session, session: WerkstattInventorySession) -> InventorySessionOut:
    counts = _counts_for(db, session.id)
    return InventorySessionOut(
        **{c: getattr(session, c) for c in
           ("id", "name", "status", "location_id", "started_by", "started_at",
            "finalized_by", "finalized_at", "notes")},
        counted_articles=len(counts),
        total_units=sum(c.counted_qty for c in counts),
    )


def _require_open(db: Session, session_id: int) -> WerkstattInventorySession:
    session = db.get(WerkstattInventorySession, session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventur nicht gefunden")
    if session.status != "open":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Diese Inventur ist abgeschlossen.",
        )
    return session


@router.post("/sessions", response_model=InventorySessionOut)
def create_session(
    payload: InventorySessionCreate,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> InventorySessionOut:
    session = WerkstattInventorySession(
        name=payload.name.strip(),
        location_id=payload.location_id,
        notes=(payload.notes or None),
        started_by=current_user.id,
        status="open",
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return _session_out(db, session)


@router.get("/sessions", response_model=list[InventorySessionOut])
def list_sessions(
    _: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> list[InventorySessionOut]:
    sessions = db.scalars(
        select(WerkstattInventorySession).order_by(WerkstattInventorySession.started_at.desc())
    ).all()
    return [_session_out(db, s) for s in sessions]


@router.get("/sessions/{session_id}", response_model=InventorySessionDetailOut)
def get_session(
    session_id: int,
    _: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> InventorySessionDetailOut:
    session = db.get(WerkstattInventorySession, session_id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventur nicht gefunden")
    base = _session_out(db, session)
    return InventorySessionDetailOut(**base.model_dump(), counts=_counts_for(db, session_id))


@router.post("/sessions/{session_id}/scan", response_model=InventoryScanResult)
def scan(
    session_id: int,
    payload: InventoryScanRequest,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> InventoryScanResult:
    """One scan, one answer. Never bounces a resolvable code back as a question."""

    outcome = scan_into_session(
        db, session_id=session_id, code=payload.code.strip(), user=current_user
    )
    # A quantity > 1 means the operator typed it rather than scanning n times.
    if outcome.article is not None and payload.quantity > 1:
        outcome_qty = bump_count(db, session_id, outcome.article, payload.quantity - 1)
    else:
        outcome_qty = outcome.counted_qty
    db.commit()

    article_out = None
    if outcome.article is not None:
        db.refresh(outcome.article)
        article_out = article_full_out(db, outcome.article)
    return InventoryScanResult(
        status=outcome.status,
        code=outcome.code,
        article=article_out,
        counted_qty=outcome_qty,
        created_from_catalog=outcome.created_from_catalog,
    )


@router.post("/sessions/{session_id}/articles", response_model=InventoryScanResult)
def name_new_article(
    session_id: int,
    payload: InventoryNameNewArticle,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> InventoryScanResult:
    """The one interruption: a code nothing has seen, or an item with no
    barcode at all. Creates the article and counts it in the same request, so
    the operator types a name once and carries straight on."""

    _require_open(db, session_id)
    code = (payload.code or "").strip() or None
    # Split the same way the offline import does: a digits-only code is a
    # manufacturer barcode, anything else is one we minted. This path used to
    # put both in `ean`, which scanned but asserted that a manufacturer had
    # assigned a code this app invented.
    is_ean = looks_like_ean(code or "")
    article = WerkstattArticle(
        article_number=next_article_number(db),
        ean=code if is_ean else None,
        internal_code=None if is_ean else code,
        item_name=payload.item_name.strip(),
        unit=(payload.unit or None),
        stock_total=0,
        stock_available=0,
        stock_out=0,
        stock_repair=0,
        stock_min=0,
        currency="EUR",
        created_by=current_user.id,
    )
    db.add(article)
    db.flush()
    counted = bump_count(db, session_id, article, payload.quantity)
    db.commit()
    db.refresh(article)
    return InventoryScanResult(
        status="created",
        code=code or "",
        article=article_full_out(db, article),
        counted_qty=counted,
    )


@router.patch("/sessions/{session_id}/counts/{article_id}", response_model=InventoryCountOut)
def set_count(
    session_id: int,
    article_id: int,
    payload: InventoryCountSet,
    _: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> InventoryCountOut:
    _require_open(db, session_id)
    row = db.scalar(
        select(WerkstattInventoryCount).where(
            WerkstattInventoryCount.session_id == session_id,
            WerkstattInventoryCount.article_id == article_id,
        )
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Zählung nicht gefunden")
    # scan_count is deliberately left alone — it records how many scans
    # happened, which a typed correction does not change.
    row.counted_qty = payload.counted_qty
    db.add(row)
    db.commit()
    matches = [c for c in _counts_for(db, session_id) if c.article_id == article_id]
    return matches[0]


@router.delete("/sessions/{session_id}/counts/{article_id}", status_code=204, response_class=Response)
def remove_count(
    session_id: int,
    article_id: int,
    _: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> Response:
    _require_open(db, session_id)
    row = db.scalar(
        select(WerkstattInventoryCount).where(
            WerkstattInventoryCount.session_id == session_id,
            WerkstattInventoryCount.article_id == article_id,
        )
    )
    if row is not None:
        db.delete(row)
        db.commit()
    return Response(status_code=204)


@router.post("/sessions/{session_id}/import", response_model=InventoryImportResult)
def import_offline_counts(
    session_id: int,
    payload: InventoryImportRequest,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> InventoryImportResult:
    """Fold in a session counted offline by the local label agent.

    Post the agent's `/export/{name}.json` verbatim. Quantities are SET rather
    than added, so retrying a failed upload cannot double the count.
    """

    session = _require_open(db, session_id)
    rows = [
        ImportRow(
            code=r.code,
            item_name=r.item_name,
            counted_qty=r.counted_qty,
            scan_count=r.scan_count,
        )
        for r in payload.counts
    ]
    return InventoryImportResult(
        **import_counts(db, session=session, rows=rows, user=current_user)
    )


@router.post("/sessions/{session_id}/finalize", response_model=InventoryFinalizeResult)
def finalize(
    session_id: int,
    current_user: User = Depends(_MANAGE),
    db: Session = Depends(get_db),
) -> InventoryFinalizeResult:
    """Book the variances. This is the only step that moves real stock."""

    session = _require_open(db, session_id)
    return InventoryFinalizeResult(**finalize_session(db, session=session, user=current_user))
