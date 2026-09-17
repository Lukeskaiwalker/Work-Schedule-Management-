"""Werkstatt article-supplier link CRUD.

Endpoints:
- POST   /werkstatt/articles/{article_id}/suppliers      (upsert on the pair)
- PATCH  /werkstatt/articles/{article_id}/suppliers/{link_id}
- DELETE /werkstatt/articles/{article_id}/suppliers/{link_id}

POST is an upsert on ``(article, supplier)``: when the pair already exists the
fields the caller actually sent are written onto that link and it is returned
with 200. The order drawer relies on this — a line drafted before the link
existed carries no link id, so "record what the supplier calls this article"
must be expressible without knowing whether a link is already there. A
duplicate used to be a 400 that left the number on the line only, so the next
order for the same article asked again.

Enforces at most one `is_preferred=True` link per article — setting a second
atomically clears the previous one.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.core.time import utcnow
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattSupplier,
)
from app.routers.workflow_werkstatt_article_mappers import (
    article_supplier_out,
    clear_preferred_link,
)
from app.schemas.werkstatt import (
    WerkstattArticleSupplierCreate,
    WerkstattArticleSupplierOut,
    WerkstattArticleSupplierUpdate,
)

router = APIRouter(prefix="", tags=["werkstatt-desktop"])


def add_supplier_link(
    db: Session,
    *,
    article_id: int,
    payload: WerkstattArticleSupplierCreate,
) -> WerkstattArticleSupplier:
    """Shared helper reused by the article-creation endpoints.

    Validates the supplier exists, upserts on (article, supplier) — see the
    module header — and clears any previous preferred link when the link is
    (or becomes) preferred.
    """
    supplier = db.get(WerkstattSupplier, payload.supplier_id)
    if supplier is None:
        raise HTTPException(status_code=400, detail="Lieferant nicht gefunden")
    existing = db.scalar(
        select(WerkstattArticleSupplier).where(
            WerkstattArticleSupplier.article_id == article_id,
            WerkstattArticleSupplier.supplier_id == payload.supplier_id,
        )
    )
    if existing is not None:
        return _update_existing_link(db, existing, payload)
    link = WerkstattArticleSupplier(
        article_id=article_id,
        supplier_id=payload.supplier_id,
        supplier_article_no=(payload.supplier_article_no or None),
        typical_price_cents=payload.typical_price_cents,
        currency=payload.currency,
        typical_lead_time_days=payload.typical_lead_time_days,
        minimum_order_quantity=payload.minimum_order_quantity,
        is_preferred=payload.is_preferred,
        source_catalog_item_id=payload.source_catalog_item_id,
        notes=(payload.notes or None),
    )
    db.add(link)
    db.flush()
    if link.is_preferred:
        clear_preferred_link(db, article_id=article_id, keep_link_id=link.id)
    return link


def _update_existing_link(
    db: Session,
    link: WerkstattArticleSupplier,
    payload: WerkstattArticleSupplierCreate,
) -> WerkstattArticleSupplier:
    """The upsert half of `add_supplier_link`: only what was sent changes.

    `model_fields_set` separates "the caller said is_preferred=False" from
    "the caller said nothing", so a POST that only carries the supplier's
    number cannot silently un-prefer the link or reset its price. A number
    sent as empty is ignored rather than written: the point of the call is to
    record a number, never to erase one the article already has.
    """

    sent = payload.model_fields_set - {"supplier_id"}
    for field in sent:
        value = getattr(payload, field)
        if field == "supplier_article_no":
            value = (value or "").strip() or None
            if value is None:
                continue
        elif field == "notes":
            value = value or None
        setattr(link, field, value)
    link.updated_at = utcnow()
    db.add(link)
    db.flush()
    if link.is_preferred:
        clear_preferred_link(db, article_id=link.article_id, keep_link_id=link.id)
    return link


@router.post(
    "/articles/{article_id}/suppliers",
    response_model=WerkstattArticleSupplierOut,
)
def add_article_supplier_link_endpoint(
    article_id: int,
    payload: WerkstattArticleSupplierCreate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleSupplierOut:
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=404, detail="Artikel nicht gefunden")
    link = add_supplier_link(db, article_id=article_id, payload=payload)
    db.commit()
    db.refresh(link)
    supplier = db.get(WerkstattSupplier, link.supplier_id)
    return article_supplier_out(link, supplier=supplier)


@router.patch(
    "/articles/{article_id}/suppliers/{link_id}",
    response_model=WerkstattArticleSupplierOut,
)
def update_article_supplier_link_endpoint(
    article_id: int,
    link_id: int,
    payload: WerkstattArticleSupplierUpdate,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> WerkstattArticleSupplierOut:
    link = db.get(WerkstattArticleSupplier, link_id)
    if link is None or link.article_id != article_id:
        raise HTTPException(status_code=404, detail="Lieferanten-Verknüpfung nicht gefunden")
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(link, field, value)
    link.updated_at = utcnow()
    db.add(link)
    if data.get("is_preferred") is True:
        clear_preferred_link(db, article_id=article_id, keep_link_id=link.id)
    db.commit()
    db.refresh(link)
    supplier = db.get(WerkstattSupplier, link.supplier_id)
    return article_supplier_out(link, supplier=supplier)


@router.delete("/articles/{article_id}/suppliers/{link_id}")
def delete_article_supplier_link_endpoint(
    article_id: int,
    link_id: int,
    _: User = Depends(require_permission("werkstatt:manage")),
    db: Session = Depends(get_db),
) -> dict[str, bool]:
    link = db.get(WerkstattArticleSupplier, link_id)
    if link is None or link.article_id != article_id:
        raise HTTPException(status_code=404, detail="Lieferanten-Verknüpfung nicht gefunden")
    db.delete(link)
    db.commit()
    return {"ok": True}
