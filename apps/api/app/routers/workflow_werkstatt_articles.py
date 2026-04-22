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
    WerkstattArticleOut,
    WerkstattArticleSupplierCreate,
    WerkstattArticleUpdate,
)
from app.services.material_catalog import ensure_material_catalog_item_image
from app.services.werkstatt_article_numbers import next_article_number

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
        stock_total=payload.stock_total,
        stock_available=payload.stock_total,
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

    for link_payload in payload.supplier_links:
        _add_supplier_link(db, article_id=article.id, payload=link_payload)

    db.commit()
    db.refresh(article)
    return article_full_out(db, article)


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
        stock_total=payload.stock_total,
        stock_available=payload.stock_total,
        stock_out=0,
        stock_repair=0,
        stock_min=payload.stock_min,
        currency="EUR",
        notes=(payload.notes or None),
        created_by=current_user.id,
    )
    db.add(article)
    db.flush()

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

    db.commit()
    db.refresh(article)
    return article_full_out(db, article)
