"""Shared mapping helpers for Werkstatt article rows.

Used by `workflow_werkstatt_articles.py` and any other router that needs to
return `WerkstattArticleOut` / `WerkstattArticleLiteOut` / `WerkstattArticleSupplierOut`.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattCategory,
    WerkstattLocation,
    WerkstattSupplier,
)
from app.schemas.werkstatt import (
    WerkstattArticleLiteOut,
    WerkstattArticleOut,
    WerkstattArticleSupplierOut,
)


def stock_status(article: WerkstattArticle) -> str:
    """Return the narrow stock status string used by the FE.

    - "empty":     nothing exists and nothing is available
    - "out":       nothing is available right now (but total > 0)
    - "low":       stock_min is set and stock_available falls below it
    - "available": healthy
    """
    if article.stock_total <= 0 and article.stock_available <= 0:
        return "empty"
    if article.stock_available <= 0:
        return "out"
    if article.stock_min > 0 and article.stock_available < article.stock_min:
        return "low"
    return "available"


def article_supplier_out(
    link: WerkstattArticleSupplier,
    *,
    supplier: WerkstattSupplier | None,
) -> WerkstattArticleSupplierOut:
    effective = (
        link.typical_lead_time_days
        if link.typical_lead_time_days is not None
        else (supplier.default_lead_time_days if supplier else None)
    )
    return WerkstattArticleSupplierOut(
        id=link.id,
        article_id=link.article_id,
        supplier_id=link.supplier_id,
        supplier_name=supplier.name if supplier else "",
        supplier_article_no=link.supplier_article_no,
        typical_price_cents=link.typical_price_cents,
        currency=link.currency,
        typical_lead_time_days=link.typical_lead_time_days,
        effective_lead_time_days=effective,
        minimum_order_quantity=link.minimum_order_quantity,
        is_preferred=link.is_preferred,
        source_catalog_item_id=link.source_catalog_item_id,
        last_ordered_at=link.last_ordered_at,
        last_confirmed_lead_time_days=link.last_confirmed_lead_time_days,
        notes=link.notes,
        created_at=link.created_at,
        updated_at=link.updated_at,
    )


def article_full_out(
    db: Session,
    article: WerkstattArticle,
    *,
    category: WerkstattCategory | None = None,
    location: WerkstattLocation | None = None,
) -> WerkstattArticleOut:
    if category is None and article.category_id:
        category = db.get(WerkstattCategory, article.category_id)
    if location is None and article.location_id:
        location = db.get(WerkstattLocation, article.location_id)
    link_rows = db.execute(
        select(WerkstattArticleSupplier, WerkstattSupplier)
        .join(
            WerkstattSupplier,
            WerkstattSupplier.id == WerkstattArticleSupplier.supplier_id,
        )
        .where(WerkstattArticleSupplier.article_id == article.id)
        .order_by(
            WerkstattArticleSupplier.is_preferred.desc(),
            WerkstattSupplier.name.asc(),
            WerkstattArticleSupplier.id.asc(),
        )
    ).all()
    supplier_outs = [
        article_supplier_out(link, supplier=supplier) for link, supplier in link_rows
    ]
    return WerkstattArticleOut(
        id=article.id,
        article_number=article.article_number,
        ean=article.ean,
        item_name=article.item_name,
        manufacturer=article.manufacturer,
        category_id=article.category_id,
        category_name=category.name if category else None,
        location_id=article.location_id,
        location_name=location.name if location else None,
        unit=article.unit,
        image_url=article.image_url,
        image_source=article.image_source,  # type: ignore[arg-type]
        image_checked_at=article.image_checked_at,
        source_catalog_item_id=article.source_catalog_item_id,
        stock_total=article.stock_total,
        stock_available=article.stock_available,
        stock_out=article.stock_out,
        stock_repair=article.stock_repair,
        stock_min=article.stock_min,
        stock_status=stock_status(article),  # type: ignore[arg-type]
        is_serialized=article.is_serialized,
        bg_inspection_required=article.bg_inspection_required,
        bg_inspection_interval_days=article.bg_inspection_interval_days,
        last_bg_inspected_at=article.last_bg_inspected_at,
        next_bg_due_at=article.next_bg_due_at,
        purchase_price_cents=article.purchase_price_cents,
        currency=article.currency,
        notes=article.notes,
        is_archived=article.is_archived,
        suppliers=supplier_outs,
        next_expected_delivery_at=None,
        created_at=article.created_at,
        updated_at=article.updated_at,
    )


def article_lite_out(
    article: WerkstattArticle,
    *,
    category_name: str | None,
    location_name: str | None,
) -> WerkstattArticleLiteOut:
    return WerkstattArticleLiteOut(
        id=article.id,
        article_number=article.article_number,
        ean=article.ean,
        item_name=article.item_name,
        manufacturer=article.manufacturer,
        category_name=category_name,
        location_name=location_name,
        stock_available=article.stock_available,
        stock_total=article.stock_total,
        stock_status=stock_status(article),  # type: ignore[arg-type]
        image_url=article.image_url,
        next_expected_delivery_at=None,
    )


def clear_preferred_link(db: Session, *, article_id: int, keep_link_id: int | None) -> None:
    """Set `is_preferred=False` on all other supplier links for this article."""
    stmt = select(WerkstattArticleSupplier).where(
        WerkstattArticleSupplier.article_id == article_id,
        WerkstattArticleSupplier.is_preferred.is_(True),
    )
    if keep_link_id is not None:
        stmt = stmt.where(WerkstattArticleSupplier.id != keep_link_id)
    for row in db.scalars(stmt).all():
        row.is_preferred = False
        row.updated_at = utcnow()
        db.add(row)
