"""Werkstatt article CRUD + image refresh + catalog linking.

Endpoints:

- GET    /werkstatt/articles                 (search + filter)
- POST   /werkstatt/articles                 (optionally with supplier_links[])
- GET    /werkstatt/articles/{id}
- PATCH  /werkstatt/articles/{id}
- DELETE /werkstatt/articles/{id}            (soft-archive)
- POST   /werkstatt/articles/{id}/refresh-image
- POST   /werkstatt/articles/{id}/link-catalog    { catalog_item_id }
- POST   /werkstatt/articles/from-catalog         { catalog_item_id, ... }

Supplier-link CRUD for articles lives in `workflow_werkstatt_article_suppliers.py`.
Mapping helpers (row → Out) live in `workflow_werkstatt_article_mappers.py`.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import (
    MaterialCatalogItem,
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattCategory,
    WerkstattLocation,
    WerkstattSupplier,
)
from app.routers.workflow_werkstatt_article_mappers import (
    article_full_out,
    article_lite_out,
    clear_preferred_link,
)
from app.schemas.werkstatt import (
    WerkstattArticleCreate,
    WerkstattArticleFromCatalogCreate,
    WerkstattArticleLinkCatalog,
    WerkstattArticleLiteOut,
    WerkstattArticleMergeOut,
    WerkstattArticleMergePayload,
    WerkstattArticleOut,
    WerkstattArticleSupplierCreate,
    WerkstattArticleUpdate,
    WerkstattCatalogFoldOut,
    WerkstattDuplicateCandidateOut,
    WerkstattSimilarArticleOut,
    WerkstattSupplierLinkAddedOut,
)
from app.services.material_catalog import ensure_material_catalog_item_image
from app.services.werkstatt_article_dedup import (
    find_duplicate_candidates,
    link_catalog_duplicates,
    merge_articles,
)
from app.services.werkstatt_movements import book_opening_stock
from app.services.werkstatt_article_numbers import next_article_number
from app.services.search_matching import (
    similarity_score,
    supports_trigram,
    token_matches_any,
    tokenize,
)

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


ARTICLE_LIST_DEFAULT_LIMIT = 100
ARTICLE_LIST_MAX_LIMIT = 500


def _add_supplier_link(
    db: Session,
    *,
    article_id: int,
    payload: WerkstattArticleSupplierCreate,
) -> WerkstattArticleSupplier:
    # Imported lazily to avoid an import cycle with the article-suppliers router.
    from app.routers.workflow_werkstatt_article_suppliers import add_supplier_link

    return add_supplier_link(db, article_id=article_id, payload=payload)


# ──────────────────────────────────────────────────────────────────────────
# GET /articles — list + search + filter
# ──────────────────────────────────────────────────────────────────────────


@router.get("/articles", response_model=list[WerkstattArticleLiteOut])
def list_articles(
    q: str = Query(default=""),
    category_id: int | None = Query(default=None),
    location_id: int | None = Query(default=None),
    supplier_id: int | None = Query(default=None),
    status: str | None = Query(default=None, description="stock_status filter"),
    include_archived: bool = Query(default=False),
    limit: int = Query(default=ARTICLE_LIST_DEFAULT_LIMIT, ge=1, le=ARTICLE_LIST_MAX_LIMIT),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattArticleLiteOut]:
    stmt = select(WerkstattArticle)
    if not include_archived:
        stmt = stmt.where(WerkstattArticle.is_archived.is_(False))
    if category_id is not None:
        stmt = stmt.where(WerkstattArticle.category_id == category_id)
    if location_id is not None:
        stmt = stmt.where(WerkstattArticle.location_id == location_id)
    if supplier_id is not None:
        stmt = stmt.where(
            WerkstattArticle.id.in_(
                select(WerkstattArticleSupplier.article_id).where(
                    WerkstattArticleSupplier.supplier_id == supplier_id
                )
            )
        )
    query = q.strip()
    if query:
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_").lower()
        like = f"%{escaped}%"
        stmt = stmt.where(
            or_(
                func.lower(WerkstattArticle.item_name).like(like, escape="\\"),
                func.lower(WerkstattArticle.article_number).like(like, escape="\\"),
                func.lower(func.coalesce(WerkstattArticle.ean, "")).like(like, escape="\\"),
                func.lower(func.coalesce(WerkstattArticle.manufacturer, "")).like(like, escape="\\"),
            )
        )
    stmt = stmt.order_by(WerkstattArticle.item_name.asc(), WerkstattArticle.id.asc()).limit(limit)
    rows = list(db.scalars(stmt).all())

    category_ids = {r.category_id for r in rows if r.category_id}
    location_ids = {r.location_id for r in rows if r.location_id}
    categories_by_id: dict[int, str] = {}
    if category_ids:
        categories_by_id = {
            cid: name
            for cid, name in db.execute(
                select(WerkstattCategory.id, WerkstattCategory.name).where(
                    WerkstattCategory.id.in_(category_ids)
                )
            ).all()
        }
    locations_by_id: dict[int, str] = {}
    if location_ids:
        locations_by_id = {
            lid: name
            for lid, name in db.execute(
                select(WerkstattLocation.id, WerkstattLocation.name).where(
                    WerkstattLocation.id.in_(location_ids)
                )
            ).all()
        }

    result = [
        article_lite_out(
            r,
            category_name=categories_by_id.get(r.category_id) if r.category_id else None,
            location_name=locations_by_id.get(r.location_id) if r.location_id else None,
        )
        for r in rows
    ]
    if status:
        result = [row for row in result if row.stock_status == status]
    return result


# ──────────────────────────────────────────────────────────────────────────
# POST /articles
# ──────────────────────────────────────────────────────────────────────────


@router.post("/articles", response_model=WerkstattArticleOut)
def create_article(
    payload: WerkstattArticleCreate,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    item_name = payload.item_name.strip()
    if not item_name:
        raise HTTPException(status_code=400, detail="Item name is required")
    if payload.category_id is not None and db.get(WerkstattCategory, payload.category_id) is None:
        raise HTTPException(status_code=400, detail="Category not found")
    if payload.location_id is not None and db.get(WerkstattLocation, payload.location_id) is None:
        raise HTTPException(status_code=400, detail="Location not found")
    ean = (payload.ean or "").strip() or None
    if ean:
        clash = db.scalar(select(WerkstattArticle).where(WerkstattArticle.ean == ean))
        if clash is not None:
            raise HTTPException(status_code=400, detail="EAN already in use by another article")

    article = WerkstattArticle(
        article_number=next_article_number(db),
        ean=ean,
        item_name=item_name,
        manufacturer=(payload.manufacturer or None),
        category_id=payload.category_id,
        location_id=payload.location_id,
        unit=(payload.unit or None),
        image_url=(payload.image_url or None),
        image_source=payload.image_source,
        source_catalog_item_id=payload.source_catalog_item_id,
        # Counters start at zero and are derived from the ledger; the opening
        # quantity is booked as an `intake` movement below. Setting them here
        # would be undone by the first recompute.
        stock_total=0,
        stock_available=0,
        stock_out=0,
        stock_repair=0,
        stock_min=payload.stock_min,
        is_serialized=payload.is_serialized,
        bg_inspection_required=payload.bg_inspection_required,
        bg_inspection_interval_days=payload.bg_inspection_interval_days,
        purchase_price_cents=payload.purchase_price_cents,
        currency=payload.currency,
        notes=(payload.notes or None),
        created_by=current_user.id,
    )
    db.add(article)
    db.flush()
    book_opening_stock(db, article, payload.stock_total, user_id=current_user.id)

    for link_payload in payload.supplier_links:
        _add_supplier_link(db, article_id=article.id, payload=link_payload)

    db.commit()
    db.refresh(article)
    return article_full_out(db, article)


# NOTE: must stay ABOVE `GET /articles/{article_id}`. FastAPI matches routes in
# registration order, so a literal path declared after a parameterised one that
# shares its shape is unreachable — "/articles/duplicates" would be parsed as
# article_id="duplicates" and 422 before this handler ever ran.
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
            )
        )
    return out


@router.get("/articles/{article_id}", response_model=WerkstattArticleOut)
def get_article(
    article_id: int,
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Article not found")
    return article_full_out(db, article)


@router.patch("/articles/{article_id}", response_model=WerkstattArticleOut)
def update_article(
    article_id: int,
    payload: WerkstattArticleUpdate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Article not found")

    data = payload.model_dump(exclude_unset=True)
    if "ean" in data:
        new_ean = (data["ean"] or "").strip() or None
        if new_ean and new_ean != article.ean:
            clash = db.scalar(
                select(WerkstattArticle).where(
                    WerkstattArticle.ean == new_ean,
                    WerkstattArticle.id != article_id,
                )
            )
            if clash is not None:
                raise HTTPException(status_code=400, detail="EAN already in use by another article")
        data["ean"] = new_ean
    if "category_id" in data and data["category_id"] is not None:
        if db.get(WerkstattCategory, data["category_id"]) is None:
            raise HTTPException(status_code=400, detail="Category not found")
    if "location_id" in data and data["location_id"] is not None:
        if db.get(WerkstattLocation, data["location_id"]) is None:
            raise HTTPException(status_code=400, detail="Location not found")
    if "item_name" in data and data["item_name"] is not None:
        data["item_name"] = data["item_name"].strip()
        if not data["item_name"]:
            raise HTTPException(status_code=400, detail="Item name is required")
    for field, value in data.items():
        setattr(article, field, value)
    article.updated_at = utcnow()
    db.add(article)
    db.commit()
    db.refresh(article)
    return article_full_out(db, article)


@router.delete("/articles/{article_id}", response_model=WerkstattArticleOut)
def archive_article(
    article_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Article not found")
    article.is_archived = True
    article.updated_at = utcnow()
    db.add(article)
    db.commit()
    db.refresh(article)
    return article_full_out(db, article)


@router.post("/articles/{article_id}/refresh-image", response_model=WerkstattArticleOut)
def refresh_article_image(
    article_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Article not found")
    if article.source_catalog_item_id is not None:
        catalog_item = db.get(MaterialCatalogItem, article.source_catalog_item_id)
        if catalog_item is not None:
            ensure_material_catalog_item_image(db, catalog_item)
            if catalog_item.image_url:
                article.image_url = catalog_item.image_url
                article.image_source = (
                    "unielektro"
                    if (catalog_item.image_source or "").startswith("unielektro")
                    else "catalog"
                )
                article.image_checked_at = utcnow()
                article.updated_at = utcnow()
                db.add(article)
                db.commit()
                db.refresh(article)
    return article_full_out(db, article)


@router.post("/articles/{article_id}/link-catalog", response_model=WerkstattArticleOut)
def link_article_to_catalog(
    article_id: int,
    payload: WerkstattArticleLinkCatalog,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Article not found")
    catalog_item = db.get(MaterialCatalogItem, payload.catalog_item_id)
    if catalog_item is None:
        raise HTTPException(status_code=404, detail="Catalog item not found")
    article.source_catalog_item_id = catalog_item.id
    # Backfill missing fields from the catalog row (non-destructive).
    if not article.ean and catalog_item.ean:
        article.ean = catalog_item.ean
    if not article.manufacturer and catalog_item.manufacturer:
        article.manufacturer = catalog_item.manufacturer
    if not article.unit and catalog_item.unit:
        article.unit = catalog_item.unit
    if not article.image_url and catalog_item.image_url:
        article.image_url = catalog_item.image_url
        article.image_source = "catalog"
        article.image_checked_at = utcnow()
    article.updated_at = utcnow()
    db.add(article)
    db.commit()
    db.refresh(article)
    return article_full_out(db, article)


@router.post("/articles/from-catalog", response_model=WerkstattArticleOut)
def create_article_from_catalog(
    payload: WerkstattArticleFromCatalogCreate,
    current_user: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleOut:
    catalog_item = db.get(MaterialCatalogItem, payload.catalog_item_id)
    if catalog_item is None:
        raise HTTPException(status_code=404, detail="Catalog item not found")
    if payload.category_id is not None and db.get(WerkstattCategory, payload.category_id) is None:
        raise HTTPException(status_code=400, detail="Category not found")
    if payload.location_id is not None and db.get(WerkstattLocation, payload.location_id) is None:
        raise HTTPException(status_code=400, detail="Location not found")

    ean = (catalog_item.ean or "").strip() or None
    if ean:
        existing = db.scalar(select(WerkstattArticle).where(WerkstattArticle.ean == ean))
        if existing is not None:
            raise HTTPException(
                status_code=400,
                detail="An article with this EAN already exists",
            )

    article = WerkstattArticle(
        article_number=next_article_number(db),
        ean=ean,
        item_name=catalog_item.item_name,
        manufacturer=catalog_item.manufacturer,
        category_id=payload.category_id,
        location_id=payload.location_id,
        unit=catalog_item.unit,
        image_url=catalog_item.image_url,
        image_source=("catalog" if catalog_item.image_url else None),
        image_checked_at=utcnow() if catalog_item.image_url else None,
        source_catalog_item_id=catalog_item.id,
        # Counters start at zero and are derived from the ledger; the opening
        # quantity is booked as an `intake` movement below. Setting them here
        # would be undone by the first recompute.
        stock_total=0,
        stock_available=0,
        stock_out=0,
        stock_repair=0,
        stock_min=payload.stock_min,
        currency="EUR",
        notes=(payload.notes or None),
        created_by=current_user.id,
    )
    db.add(article)
    db.flush()
    book_opening_stock(db, article, payload.stock_total, user_id=current_user.id)

    # Auto-link the catalog row's own supplier_id if the caller didn't provide
    # their own link for that supplier.
    supplied_ids = {link.supplier_id for link in payload.supplier_links}
    explicit_links = list(payload.supplier_links)
    if catalog_item.supplier_id is not None and catalog_item.supplier_id not in supplied_ids:
        explicit_links.append(
            WerkstattArticleSupplierCreate(
                supplier_id=catalog_item.supplier_id,
                supplier_article_no=catalog_item.article_no,
                source_catalog_item_id=catalog_item.id,
                is_preferred=len(explicit_links) == 0,
            )
        )
    for link_payload in explicit_links:
        _add_supplier_link(db, article_id=article.id, payload=link_payload)

    # Auto-fold the OTHER suppliers' Datanorm rows for this same EAN. Without
    # this the article knows only the wholesaler whose catalog row it was
    # created from, and the identical product from a second Datanorm stays a
    # disconnected duplicate. EAN is a global product id, so an exact match is
    # safe to apply without review.
    link_catalog_duplicates(db, article)

    db.commit()
    db.refresh(article)
    return article_full_out(db, article)


# ──────────────────────────────────────────────────────────────────────────
# Deduplication — one article carrying every supplier's article number
# ──────────────────────────────────────────────────────────────────────────


@router.post(
    "/articles/{article_id}/fold-catalog-duplicates",
    response_model=WerkstattCatalogFoldOut,
)
def fold_catalog_duplicates(
    article_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattCatalogFoldOut:
    """Attach every same-EAN Datanorm row to this article as a supplier link.

    Running a second supplier's Datanorm creates a second catalog row for the
    same physical product. This folds them together so one article carries
    supplier A's article number *and* supplier B's, which is what the reorder
    and scan paths need. Safe to call repeatedly — existing links are left
    untouched rather than overwritten.
    """
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Article not found")

    before = db.scalar(
        select(func.count(WerkstattArticleSupplier.id)).where(
            WerkstattArticleSupplier.article_id == article.id
        )
    )
    created = link_catalog_duplicates(db, article)
    db.commit()

    supplier_names = {
        row[0]: row[1]
        for row in db.execute(
            select(WerkstattSupplier.id, WerkstattSupplier.name).where(
                WerkstattSupplier.id.in_([link.supplier_id for link in created] or [-1])
            )
        ).all()
    }
    return WerkstattCatalogFoldOut(
        article_id=article.id,
        ean=article.ean,
        linked=[
            WerkstattSupplierLinkAddedOut(
                supplier_id=link.supplier_id,
                supplier_name=supplier_names.get(link.supplier_id),
                supplier_article_no=link.supplier_article_no,
            )
            for link in created
        ],
        already_linked=int(before or 0),
    )


@router.post("/articles/merge", response_model=WerkstattArticleMergeOut)
def merge_duplicate_articles(
    payload: WerkstattArticleMergePayload,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleMergeOut:
    """Fold one article into another, moving every referencing row with it.

    The duplicate is archived rather than deleted: movements and order lines
    reference articles with ``ondelete=RESTRICT`` because they are an audit
    ledger, and its article number may already be on a printed label.
    """
    if payload.survivor_id == payload.duplicate_id:
        raise HTTPException(status_code=400, detail="Cannot merge an article into itself")

    survivor = db.get(WerkstattArticle, payload.survivor_id)
    if survivor is None:
        raise HTTPException(status_code=404, detail="Survivor article not found")
    duplicate = db.get(WerkstattArticle, payload.duplicate_id)
    if duplicate is None:
        raise HTTPException(status_code=404, detail="Duplicate article not found")
    if duplicate.is_archived:
        raise HTTPException(status_code=400, detail="Duplicate article is already archived")

    result = merge_articles(db, survivor=survivor, duplicate=duplicate)
    db.commit()
    return WerkstattArticleMergeOut(
        survivor_id=result.survivor_id,
        merged_id=result.merged_id,
        supplier_links_moved=result.supplier_links_moved,
        supplier_links_skipped=result.supplier_links_skipped,
        movements_moved=result.movements_moved,
        order_lines_moved=result.order_lines_moved,
        box_items_moved=result.box_items_moved,
        fields_filled=list(result.fields_filled),
    )


@router.get("/articles/{article_id}/similar", response_model=list[WerkstattSimilarArticleOut])
def list_similar_articles(
    article_id: int,
    limit: int = Query(default=10, ge=1, le=50),
    _: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[WerkstattSimilarArticleOut]:
    """Comparable articles, ordered by what is actually on the shelf.

    "Show me similar items" is only useful on a building site if it surfaces
    what can be grabbed *today*, so the primary sort is ``stock_available``
    descending and closeness is the tie-break — not the other way round. An
    exact-but-empty match is less useful than a near match with 40 in the rack.

    Similarity comes from trigram distance where the extension is available,
    and falls back to shared name tokens otherwise (the SQLite test path), so
    the endpoint behaves the same either way.
    """
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Article not found")

    trigram = supports_trigram(db)
    score = similarity_score(WerkstattArticle.item_name, article.item_name, enabled=trigram)

    stmt = select(WerkstattArticle, score.label("score")).where(
        WerkstattArticle.id != article.id,
        WerkstattArticle.is_archived.is_(False),
    )
    if article.category_id is not None:
        # Same category is the strongest available signal for "of that type".
        stmt = stmt.where(WerkstattArticle.category_id == article.category_id)
    else:
        # No category to lean on: require at least one shared name token so we
        # do not return the whole inventory sorted by stock.
        tokens = tokenize(article.item_name)
        if tokens:
            stmt = stmt.where(
                or_(
                    *[
                        token_matches_any([WerkstattArticle.item_name], token)
                        for token in tokens
                    ]
                )
            )

    rows = db.execute(
        stmt.order_by(
            WerkstattArticle.stock_available.desc(),
            score.desc(),
            WerkstattArticle.item_name.asc(),
        ).limit(limit)
    ).all()
    if not rows:
        return []

    candidate_ids = [row[0].id for row in rows]
    supplier_rows = db.execute(
        select(WerkstattArticleSupplier.article_id, WerkstattSupplier.name)
        .join(WerkstattSupplier, WerkstattSupplier.id == WerkstattArticleSupplier.supplier_id)
        .where(WerkstattArticleSupplier.article_id.in_(candidate_ids))
    ).all()
    suppliers_by_article: dict[int, list[str]] = {}
    for candidate_id, supplier_name in supplier_rows:
        suppliers_by_article.setdefault(candidate_id, []).append(supplier_name)

    return [
        WerkstattSimilarArticleOut(
            article_id=candidate.id,
            article_number=candidate.article_number,
            item_name=candidate.item_name,
            ean=candidate.ean,
            unit=candidate.unit,
            stock_available=int(candidate.stock_available or 0),
            stock_total=int(candidate.stock_total or 0),
            similarity=round(float(candidate_score or 0.0), 3),
            supplier_names=sorted(suppliers_by_article.get(candidate.id, [])),
        )
        for candidate, candidate_score in rows
    ]
