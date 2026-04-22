"""Werkstatt reorder-suggestion engine.

Owned by: Tablet BE agent.

Articles whose ``stock_available`` is below ``stock_min`` are collected and
grouped by their preferred supplier (falling back to the cheapest
article-supplier link when no preferred one is set).
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.entities import (
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattSupplier,
)
from app.schemas.werkstatt import (
    ReorderSuggestionGroupOut,
    ReorderSuggestionLineOut,
)


@dataclass(frozen=True)
class _PickedLink:
    """The article-supplier link chosen as the ordering source for one
    article, together with its resolved supplier row."""

    link: WerkstattArticleSupplier
    supplier: WerkstattSupplier


def _pick_supplier_link(
    links: list[WerkstattArticleSupplier],
    suppliers_by_id: dict[int, WerkstattSupplier],
) -> _PickedLink | None:
    """Preferred-link-first, else cheapest-price fallback.

    Suppliers flagged as archived are excluded — we never suggest an order
    to an archived supplier. Returns ``None`` if no usable link exists.
    """

    usable = [
        link
        for link in links
        if suppliers_by_id.get(link.supplier_id) is not None
        and not suppliers_by_id[link.supplier_id].is_archived
    ]
    if not usable:
        return None

    preferred = [link for link in usable if link.is_preferred]
    if preferred:
        chosen = preferred[0]
        return _PickedLink(link=chosen, supplier=suppliers_by_id[chosen.supplier_id])

    # Fallback: cheapest available link. Missing prices sort last.
    def _price_key(link: WerkstattArticleSupplier) -> tuple[int, int]:
        price = link.typical_price_cents
        return (0, price) if price is not None else (1, 0)

    chosen = sorted(usable, key=_price_key)[0]
    return _PickedLink(link=chosen, supplier=suppliers_by_id[chosen.supplier_id])


def _suggested_quantity(article: WerkstattArticle, moq: int) -> int:
    """Order enough to bring stock back up to ``2 * stock_min``, honouring
    the link's minimum order quantity."""

    target = max(article.stock_min * 2 - article.stock_available, 0)
    if target <= 0:
        # Stock equals min exactly — still nudge one "moq" batch so the
        # article isn't stuck right on the threshold.
        target = moq
    return max(target, moq)


def compute_reorder_suggestions(
    db: Session,
) -> list[ReorderSuggestionGroupOut]:
    """Return one group per supplier of articles below their minimum stock.

    Ordering:
      - Groups sorted by supplier name (case-insensitive).
      - Lines within a group sorted by article_number.
    """

    below_min_articles = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.stock_min > 0,
            WerkstattArticle.stock_available < WerkstattArticle.stock_min,
        )
        .order_by(WerkstattArticle.article_number.asc())
    ).all()
    if not below_min_articles:
        return []

    article_ids = [article.id for article in below_min_articles]

    links = db.scalars(
        select(WerkstattArticleSupplier).where(
            WerkstattArticleSupplier.article_id.in_(article_ids)
        )
    ).all()
    links_by_article: dict[int, list[WerkstattArticleSupplier]] = {}
    for link in links:
        links_by_article.setdefault(link.article_id, []).append(link)

    supplier_ids = {link.supplier_id for link in links}
    suppliers: list[WerkstattSupplier] = []
    if supplier_ids:
        suppliers = list(
            db.scalars(
                select(WerkstattSupplier).where(
                    WerkstattSupplier.id.in_(supplier_ids)
                )
            ).all()
        )
    suppliers_by_id: dict[int, WerkstattSupplier] = {s.id: s for s in suppliers}

    groups_by_supplier: dict[int, dict] = {}

    for article in below_min_articles:
        picked = _pick_supplier_link(
            links_by_article.get(article.id, []),
            suppliers_by_id,
        )
        if picked is None:
            # Orphan article — no link at all. Skip it (the dashboard still
            # surfaces these via the "unavailable" list; reorder UI cannot
            # act on them without a supplier).
            continue

        link = picked.link
        supplier = picked.supplier
        unit_price = link.typical_price_cents
        quantity = _suggested_quantity(article, link.minimum_order_quantity)
        line_total = unit_price * quantity if unit_price is not None else None

        line = ReorderSuggestionLineOut(
            article_id=article.id,
            article_number=article.article_number,
            article_name=article.item_name,
            image_url=article.image_url,
            stock_available=article.stock_available,
            stock_min=article.stock_min,
            suggested_quantity=quantity,
            unit=article.unit,
            unit_price_cents=unit_price,
            line_total_cents=line_total,
        )

        bucket = groups_by_supplier.setdefault(
            supplier.id,
            {
                "supplier": supplier,
                "currency": link.currency or supplier.__dict__.get("currency") or "EUR",
                "subtotal": 0,
                "has_any_price": False,
                "lines": [],
            },
        )
        bucket["lines"].append(line)
        if line_total is not None:
            bucket["subtotal"] += line_total
            bucket["has_any_price"] = True

    groups: list[ReorderSuggestionGroupOut] = []
    for bucket in groups_by_supplier.values():
        supplier: WerkstattSupplier = bucket["supplier"]
        groups.append(
            ReorderSuggestionGroupOut(
                supplier_id=supplier.id,
                supplier_name=supplier.name,
                supplier_short_name=supplier.short_name,
                default_lead_time_days=supplier.default_lead_time_days,
                subtotal_cents=bucket["subtotal"] if bucket["has_any_price"] else None,
                currency=bucket["currency"],
                lines=bucket["lines"],
            )
        )

    groups.sort(key=lambda g: (g.supplier_name or "").lower())
    return groups
