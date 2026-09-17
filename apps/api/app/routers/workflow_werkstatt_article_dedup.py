"""The duplicate review queue: list, dismiss, merge.

Split out of ``workflow_werkstatt_articles.py`` and mounted BEFORE it, for the
reason the comment there has always given: FastAPI matches routes in
registration order, so ``/articles/duplicates`` declared after
``/articles/{article_id}`` is unreachable — it parses as an article id and 422s.
Keeping these three routes in their own file makes that ordering a property of
one ``include_router`` line instead of a rule somebody has to remember while
editing a 700-line module.

What this queue is for: a workshop that ran two suppliers' Datanorm imports
and years of hand-typed rows holds the same socket twice, under two names,
with the stock split between them. Nothing here merges automatically — a merge
is irreversible and the evidence is a name that looks alike — so every pair is
a question, and "Kein Duplikat" is as valid an answer as "Zusammenführen" and
is remembered just as firmly.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattCategory,
    WerkstattLocation,
)
from app.schemas.werkstatt import (
    WerkstattArticleMergeOut,
    WerkstattArticleMergePayload,
    WerkstattDuplicateCandidateOut,
    WerkstattDuplicateDismissPayload,
    WerkstattDuplicateSideOut,
)
from app.services.werkstatt_article_dedup import (
    DuplicateCandidate,
    dismiss_pair,
    find_duplicate_candidates,
    merge_articles,
    undismiss_pair,
)

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


def _reason_de(candidate: DuplicateCandidate) -> str:
    """Why this pair is on the screen, in the language of the workshop."""
    if candidate.reason_code == "supplier_no":
        return f"gleiche Lieferanten-Artikelnummer ({candidate.reason_detail or '—'})"
    return "fast gleicher Name, keine EAN zum Unterscheiden"


@router.get("/articles/duplicates", response_model=list[WerkstattDuplicateCandidateOut])
def list_duplicate_candidates(
    limit: int = Query(default=50, ge=1, le=200),
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> list[WerkstattDuplicateCandidateOut]:
    """Review queue: article pairs that look like the same product.

    Only pairs where at least one side has no EAN appear here — the database
    already guarantees two articles cannot share a non-null EAN, so anything
    with two EANs is genuinely two products however alike the names look.
    Nothing is merged automatically; this is the list a human confirms.

    Each side carries the facts the decision needs (stock, unit, EAN, the
    supplier numbers it holds) because a merge cannot be undone and the person
    choosing a survivor was otherwise opening two article pages in other tabs
    to compare them.
    """
    candidates = find_duplicate_candidates(db, limit=limit)
    if not candidates:
        return []

    ids = {candidate.article_id for candidate in candidates} | {
        candidate.duplicate_id for candidate in candidates
    }
    by_id = {
        article.id: article
        for article in db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id.in_(ids))
        ).all()
    }
    sides = _side_projections(db, by_id)

    out: list[WerkstattDuplicateCandidateOut] = []
    for candidate in candidates:
        left = by_id.get(candidate.article_id)
        right = by_id.get(candidate.duplicate_id)
        if left is None or right is None:
            continue
        out.append(
            WerkstattDuplicateCandidateOut(
                article_id=left.id,
                article_name=left.item_name,
                article_number=left.article_number,
                duplicate_id=right.id,
                duplicate_name=right.item_name,
                duplicate_number=right.article_number,
                score=candidate.score,
                reason=candidate.reason,
                reason_de=_reason_de(candidate),
                pair_key=candidate.pair_key,
                left=sides.get(left.id),
                right=sides.get(right.id),
            )
        )
    return out


def _side_projections(
    db: Session, by_id: dict[int, WerkstattArticle]
) -> dict[int, WerkstattDuplicateSideOut]:
    """Both halves of every pair, in three queries rather than 4×n.

    The listing is already O(n²) in Python over a capped article set; making it
    O(n) in *queries* on top of that is how a review screen becomes the one
    nobody waits for.
    """
    if not by_id:
        return {}
    article_ids = list(by_id)

    category_ids = {a.category_id for a in by_id.values() if a.category_id}
    categories = (
        {
            cid: name
            for cid, name in db.execute(
                select(WerkstattCategory.id, WerkstattCategory.name).where(
                    WerkstattCategory.id.in_(category_ids)
                )
            ).all()
        }
        if category_ids
        else {}
    )
    location_ids = {a.location_id for a in by_id.values() if a.location_id}
    locations = (
        {
            lid: name
            for lid, name in db.execute(
                select(WerkstattLocation.id, WerkstattLocation.name).where(
                    WerkstattLocation.id.in_(location_ids)
                )
            ).all()
        }
        if location_ids
        else {}
    )
    numbers: dict[int, list[str]] = {}
    for article_id, supplier_article_no in db.execute(
        select(
            WerkstattArticleSupplier.article_id,
            WerkstattArticleSupplier.supplier_article_no,
        ).where(WerkstattArticleSupplier.article_id.in_(article_ids))
    ).all():
        if supplier_article_no:
            numbers.setdefault(article_id, []).append(supplier_article_no)

    return {
        article.id: WerkstattDuplicateSideOut(
            id=article.id,
            article_number=article.article_number,
            item_name=article.item_name,
            ean=article.ean,
            internal_code=article.internal_code,
            unit=article.unit,
            stock_total=int(article.stock_total or 0),
            stock_available=int(article.stock_available or 0),
            category_name=categories.get(article.category_id) if article.category_id else None,
            location_name=locations.get(article.location_id) if article.location_id else None,
            supplier_numbers=sorted(numbers.get(article.id, [])),
            is_serialized=bool(article.is_serialized),
        )
        for article in by_id.values()
    }


@router.post("/articles/duplicates/dismiss", status_code=204)
def dismiss_duplicate_pair(
    payload: WerkstattDuplicateDismissPayload,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> Response:
    """"Kein Duplikat" — stop offering this pair.

    Persisted rather than hidden in the browser: the next person to open the
    queue would otherwise be asked the same question, and a queue that keeps
    asking answered questions is one people stop opening. Idempotent, and
    order-independent — the finder does not promise which side it shows first.
    """
    _require_pair(db, payload.article_id, payload.duplicate_id)
    dismiss_pair(
        db,
        left_id=payload.article_id,
        right_id=payload.duplicate_id,
        user_id=current_user.id,
    )
    db.commit()
    return Response(status_code=204)


@router.delete("/articles/duplicates/dismiss", status_code=204)
def restore_duplicate_pair(
    article_id: int = Query(...),
    duplicate_id: int = Query(...),
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> Response:
    """Undo a dismissal. The pair simply reappears in the queue."""
    _require_pair(db, article_id, duplicate_id)
    undismiss_pair(db, left_id=article_id, right_id=duplicate_id)
    db.commit()
    return Response(status_code=204)


def _require_pair(db: Session, left_id: int, right_id: int) -> None:
    if left_id == right_id:
        raise HTTPException(status_code=400, detail="Ein Artikel kann kein Duplikat von sich sein.")
    for article_id in (left_id, right_id):
        if db.get(WerkstattArticle, article_id) is None:
            raise HTTPException(status_code=404, detail="Artikel nicht gefunden")


@router.post("/articles/merge", response_model=WerkstattArticleMergeOut)
def merge_duplicate_articles(
    payload: WerkstattArticleMergePayload,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleMergeOut:
    """Fold one article into another, moving every referencing row with it.

    The duplicate is archived rather than deleted: movements and order lines
    reference articles with ``ondelete=RESTRICT`` because they are an audit
    ledger, and its article number may already be on a printed label — which
    keeps working, because the merge leaves a pointer the scan cascade follows.

    Refused in four cases, all of them things that cannot be undone if allowed:
    merging an article into itself, into an archived row, into a row that has
    itself been merged (a chain nobody could read back), or from a duplicate
    that is already archived.
    """
    if payload.survivor_id == payload.duplicate_id:
        raise HTTPException(status_code=400, detail="Ein Artikel kann nicht in sich selbst übernommen werden.")

    survivor = db.get(WerkstattArticle, payload.survivor_id)
    if survivor is None:
        raise HTTPException(status_code=404, detail="Ziel-Artikel nicht gefunden")
    duplicate = db.get(WerkstattArticle, payload.duplicate_id)
    if duplicate is None:
        raise HTTPException(status_code=404, detail="Duplikat nicht gefunden")
    if duplicate.is_archived:
        raise HTTPException(status_code=400, detail="Das Duplikat ist bereits archiviert.")
    if survivor.merged_into_id is not None:
        # Checked before `is_archived` because a merged row is always archived
        # too, and "wurde selbst schon zusammengeführt" names the actual
        # situation — the person is looking at a row that no longer exists as
        # a destination, and the survivor it points at is where to go.
        raise HTTPException(
            status_code=400,
            detail=(
                f"„{survivor.item_name}“ wurde selbst schon zusammengeführt — bitte den "
                "verbliebenen Artikel als Ziel wählen."
            ),
        )
    if survivor.is_archived:
        raise HTTPException(
            status_code=400,
            detail=(
                f"„{survivor.item_name}“ ist archiviert — bitte zuerst reaktivieren, "
                "sonst verschwindet der zusammengeführte Bestand aus der Liste."
            ),
        )

    try:
        result = merge_articles(db, survivor=survivor, duplicate=duplicate)
    except ValueError as exc:
        db.rollback()
        raise HTTPException(
            status_code=400,
            detail=(
                f"„{survivor.item_name}“ wurde selbst schon zusammengeführt — bitte den "
                "verbliebenen Artikel als Ziel wählen."
            ),
        ) from exc
    db.commit()
    return WerkstattArticleMergeOut(
        survivor_id=result.survivor_id,
        merged_id=result.merged_id,
        supplier_links_moved=result.supplier_links_moved,
        supplier_links_skipped=result.supplier_links_skipped,
        movements_moved=result.movements_moved,
        order_lines_moved=result.order_lines_moved,
        box_items_moved=result.box_items_moved,
        units_moved=result.units_moved,
        inventory_counts_moved=result.inventory_counts_moved,
        task_materials_moved=result.task_materials_moved,
        internal_code_moved=result.internal_code_moved,
        supplier_numbers_kept=list(result.supplier_numbers_kept),
        fields_filled=list(result.fields_filled),
    )
