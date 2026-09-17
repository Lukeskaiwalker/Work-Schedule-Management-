"""One way to put a line on an order.

Three callers used to build ``WerkstattOrderLine`` rows by hand — draft
creation, the drawer's "add line" and the reorder auto-send — and each
snapshotted a different subset of what the supplier calls the thing. A line
created through the draft endpoint reached the resolver with no supplier
number at all and showed a blank in the drawer until submit backfilled it.

Everything now goes through `build_order_line`, which knows the three kinds
of line and snapshots the same fields for each:

  stocked    ``article_id``      — name, EAN, unit from the article; the
                                   supplier link supplies number and price.
  catalogue  ``catalog_item_id`` — this supplier's Datanorm row; its article
                                   number IS the supplier number, so the line
                                   resolves at step 0 forever after. Linked to
                                   a stocked article by EAN when we have one,
                                   so delivery moves stock.
  free       neither             — whatever the caller typed.

An explicit field in the payload always wins over the snapshot source, so a
buyer can correct a catalogue name or type the number for an unlinked article.

Pure functions over a session, no FastAPI routing. They flush, never commit —
the caller owns the transaction. The 4xx they raise carry German detail
because the drawer shows it verbatim.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    MaterialCatalogItem,
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattOrder,
    WerkstattOrderLine,
    WerkstattSupplier,
)
from app.schemas.werkstatt_procurement import OrderLineCreatePayload
from app.services.werkstatt_order_composition import resolve_article
from app.services.werkstatt_orders import generate_order_number


def create_draft_order(
    db: Session,
    *,
    supplier: WerkstattSupplier,
    project_id: int | None,
    title: str | None,
    source: str,
    created_by: int,
    now: datetime | None = None,
    task_id: int | None = None,
    notes: str | None = None,
    delivery_reference: str | None = None,
) -> WerkstattOrder:
    """A numbered, empty draft for one supplier. Flushed so it has an id."""

    stamp = now or utcnow()
    order = WerkstattOrder(
        order_number=generate_order_number(db, now=stamp),
        supplier_id=supplier.id,
        status="draft",
        currency="EUR",
        notes=notes,
        delivery_reference=delivery_reference,
        title=title,
        task_id=task_id,
        project_id=project_id,
        source=source,
        created_by=created_by,
        created_at=stamp,
        updated_at=stamp,
    )
    db.add(order)
    db.flush()
    return order


def _load_article(db: Session, article_id: int) -> WerkstattArticle:
    article = db.get(WerkstattArticle, article_id)
    if article is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Artikel nicht gefunden")
    return article


def _load_catalog_row(db: Session, order: WerkstattOrder, catalog_item_id: int) -> MaterialCatalogItem:
    """This supplier's row, or a refusal.

    Two wholesalers reuse each other's numbers freely, so a row of another
    supplier on this order would confidently order the wrong product — the
    trap `resolve_article` documents.
    """

    row = db.get(MaterialCatalogItem, catalog_item_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Katalogeintrag nicht gefunden"
        )
    if row.supplier_id != order.supplier_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Katalogeintrag gehört zu einem anderen Lieferanten",
        )
    return row


def _supplier_link(
    db: Session,
    *,
    order: WerkstattOrder,
    article: WerkstattArticle | None,
    pinned_link_id: int | None,
) -> WerkstattArticleSupplier | None:
    """The article↔supplier link a line snapshots price and number from."""

    if pinned_link_id is not None:
        link = db.get(WerkstattArticleSupplier, pinned_link_id)
        if link is None or article is None or link.article_id != article.id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="article_supplier_id does not match article_id",
            )
        return link
    if article is None:
        return None
    return db.scalar(
        select(WerkstattArticleSupplier).where(
            WerkstattArticleSupplier.article_id == article.id,
            WerkstattArticleSupplier.supplier_id == order.supplier_id,
        )
    )


def build_order_line(
    db: Session,
    order: WerkstattOrder,
    payload: OrderLineCreatePayload,
    *,
    article: WerkstattArticle | None = None,
    now: datetime | None = None,
) -> WerkstattOrderLine:
    """Add one line to ``order`` and return it, flushed.

    ``article`` may be passed by a caller that already loaded it (the draft
    endpoint prefetches its articles in one query); otherwise it is loaded
    from ``payload.article_id``. The caller recomputes the order total.
    """

    stamp = now or utcnow()
    if article is None and payload.article_id is not None:
        article = _load_article(db, payload.article_id)

    row: MaterialCatalogItem | None = None
    if payload.catalog_item_id is not None:
        row = _load_catalog_row(db, order, payload.catalog_item_id)
        if article is None:
            # A catalogue pick for something we stock should move stock on
            # delivery. resolve_article matches by this supplier's number
            # first, then by the global EAN.
            article_id, _ = resolve_article(
                db,
                supplier_id=order.supplier_id,
                supplier_article_no=row.article_no,
                ean=row.ean,
            )
            if article_id is not None:
                article = db.get(WerkstattArticle, article_id)

    if article is None and row is None:
        if not (payload.description or "").strip() and not (
            payload.supplier_article_no or ""
        ).strip():
            # Without an article, a line needs at least something to identify
            # it, or the order grows a row nobody can act on.
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Bitte einen Artikel wählen oder Bezeichnung/Artikelnummer angeben",
            )

    link = _supplier_link(
        db,
        order=order,
        article=article,
        pinned_link_id=getattr(payload, "article_supplier_id", None),
    )

    unit_price = payload.unit_price_cents
    if unit_price is None and link is not None:
        unit_price = link.typical_price_cents

    line = WerkstattOrderLine(
        order_id=order.id,
        article_id=article.id if article else None,
        article_supplier_id=link.id if link else None,
        supplier_article_no=_first(
            payload.supplier_article_no,
            row.article_no if row else None,
            link.supplier_article_no if link else None,
        ),
        description=_first(
            payload.description,
            row.item_name if row else None,
            article.item_name if article else None,
        ),
        manufacturer=_first(
            payload.manufacturer,
            row.manufacturer if row else None,
            article.manufacturer if article else None,
        ),
        ean=_first(payload.ean, row.ean if row else None, article.ean if article else None),
        unit=_first(payload.unit, row.unit if row else None, article.unit if article else None),
        quantity_ordered=payload.quantity_ordered,
        quantity_received=0,
        unit_price_cents=unit_price,
        currency=payload.currency or (link.currency if link else order.currency) or "EUR",
        line_status="pending",
        notes=payload.notes,
        created_at=stamp,
        updated_at=stamp,
    )
    db.add(line)
    db.flush()
    return line


def _first(*values: str | None) -> str | None:
    """The first value with something in it, stripped. None when none has."""

    for value in values:
        text = (value or "").strip()
        if text:
            return text
    return None
