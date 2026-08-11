"""Building orders out of other things: carts, templates and other orders.

Where `werkstatt_orders.py` owns an order's *lifecycle* (numbering, status
machine, delivery), this module owns its *contents* — what goes on it, where
those lines came from, and how two orders become one.

Pure functions over a SQLAlchemy session, no FastAPI, so the interesting
semantics (does merging combine duplicate lines? does a template keep its
prices?) are testable without HTTP.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattOrder,
    WerkstattOrderLine,
)
from app.services.ids_cart_parser import ParsedCart
from app.services.werkstatt_orders import (
    TEMPLATE_NUMBER_PREFIX,
    generate_order_number,
)


# ──────────────────────────────────────────────────────────────────────────
# Catalogue resolution
# ──────────────────────────────────────────────────────────────────────────


def resolve_article(
    db: Session,
    *,
    supplier_id: int,
    supplier_article_no: str | None,
    ean: str | None,
) -> tuple[int | None, int | None]:
    """Match an incoming cart line to something we already stock.

    Returns ``(article_id, article_supplier_id)``, both ``None`` when the line
    is genuinely new to us — which is the common case and not a failure.

    Order of attempts, most trustworthy first:

      1. the supplier's own article number, scoped to THIS supplier. Two
         wholesalers reuse each other's numbers freely, so an unscoped match
         here would confidently link the wrong product.
      2. the EAN, which is globally unique by construction and therefore safe
         to match unscoped.

    Getting this right is what makes a delivered cart move stock for the
    things we actually count, while leaving the one-off job material alone.
    """

    if supplier_article_no:
        link = db.scalar(
            select(WerkstattArticleSupplier).where(
                WerkstattArticleSupplier.supplier_id == supplier_id,
                WerkstattArticleSupplier.supplier_article_no == supplier_article_no.strip(),
            )
        )
        if link is not None:
            return link.article_id, link.id

    if ean:
        article = db.scalar(
            select(WerkstattArticle).where(
                WerkstattArticle.ean == ean.strip(),
                WerkstattArticle.is_archived.is_(False),
            )
        )
        if article is not None:
            link = db.scalar(
                select(WerkstattArticleSupplier).where(
                    WerkstattArticleSupplier.article_id == article.id,
                    WerkstattArticleSupplier.supplier_id == supplier_id,
                )
            )
            return article.id, (link.id if link else None)

    return None, None


def recompute_total(db: Session, order: WerkstattOrder) -> None:
    """Refresh the denormalised order total from its lines."""

    lines = list(
        db.scalars(
            select(WerkstattOrderLine).where(WerkstattOrderLine.order_id == order.id)
        ).all()
    )
    total = 0
    any_priced = False
    for line in lines:
        if line.unit_price_cents is None:
            continue
        total += line.unit_price_cents * line.quantity_ordered
        any_priced = True
    order.total_amount_cents = total if any_priced else None
    order.updated_at = utcnow()
    db.add(order)


# ──────────────────────────────────────────────────────────────────────────
# Cart → lines
# ──────────────────────────────────────────────────────────────────────────


def append_cart_lines(
    db: Session,
    order: WerkstattOrder,
    cart: ParsedCart,
    *,
    import_id: int | None = None,
    now: datetime | None = None,
) -> list[WerkstattOrderLine]:
    """Add every line of a parsed cart to ``order``.

    Appends rather than replaces, which is what makes "shop again and add to
    the same order" work — the second trip extends the first instead of
    silently discarding it.

    Duplicates are NOT combined here, deliberately. Two trips that both bought
    cable are two facts, and collapsing them at import would hide a
    double-order the buyer needs to see. Merging is the explicit operation for
    that (`merge_orders`).
    """

    moment = now or utcnow()
    created: list[WerkstattOrderLine] = []

    for parsed in cart.lines:
        article_id, link_id = resolve_article(
            db,
            supplier_id=order.supplier_id,
            supplier_article_no=parsed.supplier_article_no,
            ean=parsed.ean,
        )
        line = WerkstattOrderLine(
            order_id=order.id,
            article_id=article_id,
            article_supplier_id=link_id,
            supplier_article_no=parsed.supplier_article_no,
            description=parsed.description,
            manufacturer=parsed.manufacturer,
            ean=parsed.ean,
            unit=parsed.unit,
            source_import_id=import_id,
            quantity_ordered=parsed.quantity,
            quantity_received=0,
            unit_price_cents=parsed.unit_price_cents,
            currency=parsed.currency or order.currency or "EUR",
            line_status="pending",
            # The parser's doubts are written onto the line itself so they
            # survive the import screen. A rounded quantity that is only
            # mentioned in a toast is a rounded quantity nobody remembers.
            notes="\n".join(parsed.warnings) if parsed.warnings else parsed.notes,
            created_at=moment,
            updated_at=moment,
        )
        db.add(line)
        created.append(line)

    db.flush()
    recompute_total(db, order)
    return created


# ──────────────────────────────────────────────────────────────────────────
# Merge
# ──────────────────────────────────────────────────────────────────────────


def _identity_key(line: WerkstattOrderLine) -> tuple:
    """What makes two lines the same *product*, ignoring price."""

    return (
        line.article_id,
        (line.supplier_article_no or "").strip().lower(),
        (line.ean or "").strip(),
        (line.currency or "EUR"),
    )


def _prices_combinable(left: int | None, right: int | None) -> bool:
    """Whether two lines for the same product may be summed.

    Equal prices obviously combine. Two DIFFERENT prices deliberately do not:
    that is either a price change worth noticing or a mistake worth seeing,
    and summing them would destroy both signals along with the ability to
    reconcile the invoice against the order.

    A missing price combines with anything, which is the case that matters in
    practice. Templates carry no prices on purpose (they outlive them), so
    merging a template-derived order into a cart would otherwise leave every
    article on the order twice — visibly duplicated, and for no reason, since
    "we don't know the price" is not a disagreement with a known one.
    """

    return left is None or right is None or left == right


def merge_orders(
    db: Session,
    *,
    source: WerkstattOrder,
    target: WerkstattOrder,
    actor_id: int,
    combine_duplicates: bool = True,
) -> WerkstattOrder:
    """Fold ``source`` into ``target`` and retire the source.

    Rules, all enforced as 409s because each one is a real way to lose data:

      - a template is never merged; it is instantiated first;
      - both orders must still be drafts. Merging into a sent order would
        change what was ordered after the wholesaler already had it;
      - suppliers must match. One order goes to one supplier, and a merged
        order addressed to two of them cannot be sent to either;
      - an order is not merged into itself.

    The source row survives with `merged_into_order_id` set and a `cancelled`
    status. Keeping it is what lets "I merged the wrong one" be answerable —
    the lines moved, but the record of the trip that produced them did not.
    """

    if source.id == target.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Eine Bestellung kann nicht mit sich selbst zusammengeführt werden",
        )
    if source.is_template or target.is_template:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Vorlagen können nicht zusammengeführt werden — bitte zuerst übernehmen",
        )
    if source.status != "draft" or target.status != "draft":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Nur Bestellungen im Entwurf können zusammengeführt werden",
        )
    if source.supplier_id != target.supplier_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Bestellungen verschiedener Lieferanten können nicht zusammengeführt werden",
        )

    now = utcnow()
    source_lines = list(
        db.scalars(
            select(WerkstattOrderLine)
            .where(WerkstattOrderLine.order_id == source.id)
            .order_by(WerkstattOrderLine.id.asc())
        ).all()
    )
    target_lines = list(
        db.scalars(
            select(WerkstattOrderLine).where(WerkstattOrderLine.order_id == target.id)
        ).all()
    )
    # Grouped by product, not by (product, price): a product can legitimately
    # appear more than once at different prices, and the first combinable
    # candidate wins.
    existing: dict[tuple, list[WerkstattOrderLine]] = {}
    if combine_duplicates:
        for line in target_lines:
            existing.setdefault(_identity_key(line), []).append(line)

    for line in source_lines:
        match: WerkstattOrderLine | None = None
        if combine_duplicates:
            for candidate in existing.get(_identity_key(line), []):
                if _prices_combinable(candidate.unit_price_cents, line.unit_price_cents):
                    match = candidate
                    break

        if match is not None:
            match.quantity_ordered += line.quantity_ordered
            # Keep whichever price is actually known. When both are, they are
            # equal by the combinability rule, so this is a no-op.
            if match.unit_price_cents is None:
                match.unit_price_cents = line.unit_price_cents
            match.updated_at = now
            db.add(match)
            db.delete(line)
            continue

        # Re-parent rather than copy: the line keeps its id, and with it its
        # `source_import_id`, so a merged order can still say which shopping
        # trip each line came from.
        line.order_id = target.id
        line.updated_at = now
        db.add(line)
        if combine_duplicates:
            existing.setdefault(_identity_key(line), []).append(line)

    source.status = "cancelled"
    source.merged_into_order_id = target.id
    source.merged_at = now
    source.updated_at = now
    db.add(source)

    if target.notes:
        target.notes = f"{target.notes}\nZusammengeführt mit {source.order_number}"
    else:
        target.notes = f"Zusammengeführt mit {source.order_number}"

    db.flush()
    recompute_total(db, target)
    return target


# ──────────────────────────────────────────────────────────────────────────
# Templates
# ──────────────────────────────────────────────────────────────────────────


def _copy_lines(
    db: Session,
    *,
    from_order_id: int,
    to_order_id: int,
    now: datetime,
    keep_prices: bool,
) -> int:
    lines = list(
        db.scalars(
            select(WerkstattOrderLine)
            .where(WerkstattOrderLine.order_id == from_order_id)
            .order_by(WerkstattOrderLine.id.asc())
        ).all()
    )
    for line in lines:
        db.add(
            WerkstattOrderLine(
                order_id=to_order_id,
                article_id=line.article_id,
                article_supplier_id=line.article_supplier_id,
                supplier_article_no=line.supplier_article_no,
                description=line.description,
                manufacturer=line.manufacturer,
                ean=line.ean,
                unit=line.unit,
                # Provenance is NOT copied: a copy did not come from that
                # shopping trip, it came from this template.
                source_import_id=None,
                quantity_ordered=line.quantity_ordered,
                quantity_received=0,
                unit_price_cents=line.unit_price_cents if keep_prices else None,
                currency=line.currency,
                line_status="pending",
                notes=line.notes,
                created_at=now,
                updated_at=now,
            )
        )
    return len(lines)


def save_as_template(
    db: Session,
    *,
    order: WerkstattOrder,
    name: str,
    actor_id: int,
) -> WerkstattOrder:
    """Snapshot an order as a reusable template.

    A copy, not a flag flip: the order the user just built is usually one they
    still intend to send, and turning it into a template in place would take
    it away from them.

    Prices are NOT carried over. A template lives for months and wholesale
    prices do not; a stale price silently applied to next year's order is
    worse than no price, because it looks authoritative. Prices come back from
    the article-supplier link when the template is used.
    """

    now = utcnow()
    template = WerkstattOrder(
        order_number=generate_order_number(db, now=now, prefix=TEMPLATE_NUMBER_PREFIX),
        supplier_id=order.supplier_id,
        status="draft",
        currency=order.currency,
        title=name,
        is_template=True,
        template_name=name,
        source="template",
        notes=order.notes,
        created_by=actor_id,
        created_at=now,
        updated_at=now,
    )
    db.add(template)
    db.flush()
    _copy_lines(
        db,
        from_order_id=order.id,
        to_order_id=template.id,
        now=now,
        keep_prices=False,
    )
    db.flush()
    return template


def apply_template(
    db: Session,
    *,
    template: WerkstattOrder,
    target: WerkstattOrder,
    now: datetime | None = None,
) -> int:
    """Append a template's lines to an existing draft order.

    Appending rather than replacing is what makes templates composable: a
    standard kit plus a second standard kit plus whatever the job needs.
    Prices are refreshed from the current article-supplier link, so a template
    written last year orders at this year's price.
    """

    if not template.is_template:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Diese Bestellung ist keine Vorlage",
        )
    if target.status != "draft" or target.is_template:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Vorlagen können nur in einen Entwurf übernommen werden",
        )
    if template.supplier_id != target.supplier_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Die Vorlage gehört zu einem anderen Lieferanten",
        )

    moment = now or utcnow()
    count = _copy_lines(
        db,
        from_order_id=template.id,
        to_order_id=target.id,
        now=moment,
        keep_prices=False,
    )
    db.flush()

    for line in db.scalars(
        select(WerkstattOrderLine).where(
            WerkstattOrderLine.order_id == target.id,
            WerkstattOrderLine.unit_price_cents.is_(None),
            WerkstattOrderLine.article_supplier_id.is_not(None),
        )
    ).all():
        link = db.get(WerkstattArticleSupplier, line.article_supplier_id)
        if link is not None and link.typical_price_cents is not None:
            line.unit_price_cents = link.typical_price_cents
            line.currency = link.currency or line.currency
            db.add(line)

    db.flush()
    recompute_total(db, target)
    return count
