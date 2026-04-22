"""Werkstatt scan-resolution cascade.

Owned by Mobile BE (used only by ``workflow_werkstatt_mobile``).

Given a raw scanned ``code`` (an EAN, SP-Nummer, supplier article number,
or Datanorm catalog identifier), resolve it via the six-step cascade
defined in ``WERKSTATT_CONTRACT.md §3.1``:

    1. werkstatt_articles.article_number == code       → werkstatt_article (sp)
    2. werkstatt_articles.ean == code                  → werkstatt_article (ean)
    3. werkstatt_article_suppliers.supplier_article_no == code
                                                       → werkstatt_article (supplier_no)
    4. material_catalog_items.ean == code              → catalog_match (catalog_ean)
                                                         (may return multiple)
    5. material_catalog_items.article_no == code       → catalog_match (catalog_article_no)
                                                         (may return multiple)
    6. Otherwise                                       → not_found

Ordering is load-bearing — the FE relies on it, and it's documented in the
contract. Do not rearrange without bumping the contract.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import (
    MaterialCatalogItem,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattCategory,
    WerkstattLocation,
    WerkstattSupplier,
)
from app.schemas.werkstatt import (
    MaterialCatalogItemLiteOut,
    ScanResolveCatalog,
    ScanResolveNotFound,
    ScanResolveResult,
    ScanResolveWerkstatt,
    WerkstattArticleOut,
    WerkstattStockStatus,
)


# ──────────────────────────────────────────────────────────────────────────
# Public entry point
# ──────────────────────────────────────────────────────────────────────────


def resolve_scan(db: Session, code: str) -> ScanResolveResult:
    """Run the six-step scan cascade and return a ``ScanResolveResult``.

    An empty / whitespace-only code resolves to ``not_found`` (with the
    original string preserved). All DB lookups use the normalised (stripped)
    value but the returned ``code`` for ``not_found`` is the raw input so
    the FE can echo exactly what was scanned.
    """

    raw = code or ""
    normalised = raw.strip()
    if not normalised:
        return ScanResolveNotFound(code=raw)

    # 1. werkstatt_articles.article_number == code
    article = db.scalars(
        select(WerkstattArticle).where(WerkstattArticle.article_number == normalised)
    ).first()
    if article is not None:
        return ScanResolveWerkstatt(
            article=_article_out(db, article),
            matched_by="sp",
        )

    # 2. werkstatt_articles.ean == code
    article = db.scalars(
        select(WerkstattArticle).where(WerkstattArticle.ean == normalised)
    ).first()
    if article is not None:
        return ScanResolveWerkstatt(
            article=_article_out(db, article),
            matched_by="ean",
        )

    # 3. werkstatt_article_suppliers.supplier_article_no == code
    #    If multiple links from different articles share the same supplier
    #    article number (shouldn't happen due to uniqueness per supplier_id,
    #    but we pick the deterministic winner by article_number ASC).
    supplier_link = db.scalars(
        select(WerkstattArticleSupplier)
        .join(WerkstattArticle, WerkstattArticle.id == WerkstattArticleSupplier.article_id)
        .where(WerkstattArticleSupplier.supplier_article_no == normalised)
        .order_by(WerkstattArticle.article_number.asc(), WerkstattArticleSupplier.id.asc())
    ).first()
    if supplier_link is not None:
        article = db.get(WerkstattArticle, supplier_link.article_id)
        if article is not None:
            return ScanResolveWerkstatt(
                article=_article_out(db, article),
                matched_by="supplier_no",
            )

    # 4. material_catalog_items.ean == code — return ALL rows
    catalog_rows = list(
        db.scalars(
            select(MaterialCatalogItem)
            .where(MaterialCatalogItem.ean == normalised)
            .order_by(MaterialCatalogItem.id.asc())
        ).all()
    )
    if catalog_rows:
        return ScanResolveCatalog(
            catalog_items=_catalog_items_out(db, catalog_rows),
            matched_by="catalog_ean",
        )

    # 5. material_catalog_items.article_no == code — return ALL rows
    catalog_rows = list(
        db.scalars(
            select(MaterialCatalogItem)
            .where(MaterialCatalogItem.article_no == normalised)
            .order_by(MaterialCatalogItem.id.asc())
        ).all()
    )
    if catalog_rows:
        return ScanResolveCatalog(
            catalog_items=_catalog_items_out(db, catalog_rows),
            matched_by="catalog_article_no",
        )

    # 6. Not found — echo the raw code unchanged.
    return ScanResolveNotFound(code=raw)


# ──────────────────────────────────────────────────────────────────────────
# Internal projections
# ──────────────────────────────────────────────────────────────────────────


def _stock_status(article: WerkstattArticle) -> WerkstattStockStatus:
    """Compute the canonical ``WerkstattStockStatus`` from an article's
    snapshot counters.

    Rules (kept in sync with ``apps/web/src/types/werkstatt.ts``):
      - ``is_archived``                                       → ``unavailable``
      - ``stock_total == 0``                                   → ``empty``
      - ``stock_available == 0 and stock_out > 0``             → ``out``
      - ``stock_available <= stock_min`` (and > 0 or min>0)   → ``low``
      - otherwise                                             → ``available``
    """

    if bool(article.is_archived):
        return "unavailable"
    total = int(article.stock_total or 0)
    available = int(article.stock_available or 0)
    stock_out = int(article.stock_out or 0)
    stock_min = int(article.stock_min or 0)
    if total <= 0:
        return "empty"
    if available <= 0 and stock_out > 0:
        return "out"
    if stock_min > 0 and available <= stock_min:
        return "low"
    if available <= 0:
        return "empty"
    return "available"


def _article_out(db: Session, article: WerkstattArticle) -> WerkstattArticleOut:
    """Minimal ``WerkstattArticleOut`` projection used by scan results.

    The scan result intentionally does not hydrate the full ``suppliers``
    list — the mobile persona shows a compact card and deep-links into
    the article detail view where Desktop BE hydrates the rest. We return
    an empty suppliers list here to keep this service self-contained.
    """

    category_name: str | None = None
    if article.category_id is not None:
        cat = db.get(WerkstattCategory, article.category_id)
        category_name = cat.name if cat else None

    location_name: str | None = None
    if article.location_id is not None:
        loc = db.get(WerkstattLocation, article.location_id)
        location_name = loc.name if loc else None

    return WerkstattArticleOut(
        id=article.id,
        article_number=article.article_number,
        ean=article.ean,
        item_name=article.item_name,
        manufacturer=article.manufacturer,
        category_id=article.category_id,
        category_name=category_name,
        location_id=article.location_id,
        location_name=location_name,
        unit=article.unit,
        image_url=article.image_url,
        image_source=article.image_source,  # type: ignore[arg-type]
        image_checked_at=article.image_checked_at,
        source_catalog_item_id=article.source_catalog_item_id,
        stock_total=int(article.stock_total or 0),
        stock_available=int(article.stock_available or 0),
        stock_out=int(article.stock_out or 0),
        stock_repair=int(article.stock_repair or 0),
        stock_min=int(article.stock_min or 0),
        stock_status=_stock_status(article),
        is_serialized=bool(article.is_serialized),
        bg_inspection_required=bool(article.bg_inspection_required),
        bg_inspection_interval_days=article.bg_inspection_interval_days,
        last_bg_inspected_at=article.last_bg_inspected_at,
        next_bg_due_at=article.next_bg_due_at,
        purchase_price_cents=article.purchase_price_cents,
        currency=article.currency or "EUR",
        notes=article.notes,
        is_archived=bool(article.is_archived),
        suppliers=[],
        next_expected_delivery_at=None,
        created_at=article.created_at,
        updated_at=article.updated_at,
    )


def _catalog_items_out(
    db: Session,
    rows: list[MaterialCatalogItem],
) -> list[MaterialCatalogItemLiteOut]:
    """Project catalog rows to the lite schema, batching the supplier join."""

    supplier_ids = {r.supplier_id for r in rows if r.supplier_id is not None}
    supplier_names: dict[int, str] = {}
    if supplier_ids:
        for supplier in db.scalars(
            select(WerkstattSupplier).where(WerkstattSupplier.id.in_(supplier_ids))
        ).all():
            supplier_names[supplier.id] = supplier.name

    return [
        MaterialCatalogItemLiteOut(
            id=row.id,
            external_key=row.external_key,
            supplier_id=row.supplier_id,
            supplier_name=supplier_names.get(row.supplier_id) if row.supplier_id else None,
            article_no=row.article_no,
            item_name=row.item_name,
            ean=row.ean,
            manufacturer=row.manufacturer,
            unit=row.unit,
            price_text=row.price_text,
            image_url=row.image_url,
        )
        for row in rows
    ]
