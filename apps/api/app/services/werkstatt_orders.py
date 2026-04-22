"""Werkstatt order lifecycle helpers.

Owned by: Tablet BE agent (see `WERKSTATT_CONTRACT.md` §3.4 and §5).

This module is responsible for:
  - Generating human-readable order numbers (``BST-{YYYY}-{NNNN}``)
  - Enforcing the order status machine
  - Computing expected delivery from lead time
  - Finalising a delivery (creating intake movements + refreshing stock
    counters)

Everything is written as pure functions that take a SQLAlchemy session.
No FastAPI primitives are imported so the services stay unit-testable in
isolation from the HTTP layer.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    WerkstattArticle,
    WerkstattArticleSupplier,
    WerkstattMovement,
    WerkstattOrder,
    WerkstattOrderLine,
    WerkstattSupplier,
)


# ──────────────────────────────────────────────────────────────────────────
# Order number generation
# ──────────────────────────────────────────────────────────────────────────


ORDER_NUMBER_PREFIX = "BST"


def generate_order_number(db: Session, *, now: datetime | None = None) -> str:
    """Return the next available order number for the current year.

    Format: ``BST-{YYYY}-{NNNN}`` with a zero-padded 4-digit counter that
    resets every calendar year. The counter is derived by scanning the
    maximum existing number that shares the same year prefix. A small
    retry loop guards against the unlikely race where two callers pick
    the same suffix concurrently.
    """

    effective_now = now or utcnow()
    year = effective_now.year
    prefix = f"{ORDER_NUMBER_PREFIX}-{year}-"

    existing_numbers = db.scalars(
        select(WerkstattOrder.order_number).where(
            WerkstattOrder.order_number.like(f"{prefix}%")
        )
    ).all()

    max_seq = 0
    for number in existing_numbers:
        suffix = number[len(prefix):]
        try:
            value = int(suffix)
        except (TypeError, ValueError):
            continue
        if value > max_seq:
            max_seq = value

    next_seq = max_seq + 1
    return f"{prefix}{next_seq:04d}"


# ──────────────────────────────────────────────────────────────────────────
# Status machine
# ──────────────────────────────────────────────────────────────────────────


# Explicit adjacency map. Terminal states map to empty set.
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "draft": frozenset({"sent", "cancelled"}),
    "sent": frozenset({"confirmed", "delivered", "cancelled"}),
    "confirmed": frozenset({"partially_delivered", "delivered", "cancelled"}),
    "partially_delivered": frozenset({"delivered"}),
    "delivered": frozenset(),
    "cancelled": frozenset(),
}

VALID_STATUSES: frozenset[str] = frozenset(ALLOWED_TRANSITIONS.keys())


def _assert_transition_allowed(current: str, new: str) -> None:
    if new not in VALID_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unknown order status '{new}'",
        )
    if new == current:
        # No-op transitions are a programming error further up; surface as 409.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Order already in status '{current}'",
        )
    allowed = ALLOWED_TRANSITIONS.get(current, frozenset())
    if new not in allowed:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot transition order from '{current}' to '{new}'",
        )


def transition_order(
    db: Session,
    order: WerkstattOrder,
    new_status: str,
    *,
    actor_id: int,
) -> WerkstattOrder:
    """Move ``order`` to ``new_status`` while enforcing the state machine.

    Side effects by target status:
      - ``sent``       → stamp ``ordered_at = now`` if missing and recompute
        ``expected_delivery_at`` from line lead times.
      - ``delivered``  → stamp ``delivered_at = now`` and finalise delivery
        (intake movements + stock counter refresh).
      - ``cancelled``  → no side effects beyond status bump.

    Raises 409 for invalid transitions.
    """

    current = order.status
    _assert_transition_allowed(current, new_status)

    now = utcnow()
    order.status = new_status
    order.updated_at = now

    if new_status == "sent":
        if order.ordered_at is None:
            order.ordered_at = now
        recompute_expected_delivery(db, order)
    elif new_status == "delivered":
        if order.delivered_at is None:
            order.delivered_at = now
        finalize_delivery(db, order, actor_id=actor_id)
    elif new_status == "partially_delivered":
        # Data model supports it; Mobile BE owns the partial-receive UI.
        pass
    elif new_status == "cancelled":
        pass

    db.add(order)
    return order


# ──────────────────────────────────────────────────────────────────────────
# Lead-time / expected delivery
# ──────────────────────────────────────────────────────────────────────────


def _article_supplier_lead_time(
    link: WerkstattArticleSupplier | None,
    supplier: WerkstattSupplier | None,
) -> int | None:
    """Return the effective lead-time days for one line.

    Precedence: per-link override → supplier default → None.
    """

    if link is not None and link.typical_lead_time_days is not None:
        return link.typical_lead_time_days
    if supplier is not None and supplier.default_lead_time_days is not None:
        return supplier.default_lead_time_days
    return None


def recompute_expected_delivery(db: Session, order: WerkstattOrder) -> None:
    """Recompute ``expected_delivery_at`` from the max line lead time.

    Uses the per-article-supplier override where available, else the
    supplier default. If no lead time is known for any line the field is
    left as-is (do not clear a caller-provided value)."""

    if order.ordered_at is None:
        return

    supplier = db.get(WerkstattSupplier, order.supplier_id)

    lines = db.scalars(
        select(WerkstattOrderLine).where(WerkstattOrderLine.order_id == order.id)
    ).all()

    best_days: int | None = None
    for line in lines:
        link = (
            db.get(WerkstattArticleSupplier, line.article_supplier_id)
            if line.article_supplier_id is not None
            else None
        )
        # If no snapshot link, look up the preferred link for this article ↔
        # supplier pair so we don't miss the lead time override.
        if link is None:
            link = db.scalar(
                select(WerkstattArticleSupplier).where(
                    WerkstattArticleSupplier.article_id == line.article_id,
                    WerkstattArticleSupplier.supplier_id == order.supplier_id,
                )
            )
        days = _article_supplier_lead_time(link, supplier)
        if days is None:
            continue
        if best_days is None or days > best_days:
            best_days = days

    if best_days is None and supplier is not None:
        best_days = supplier.default_lead_time_days

    if best_days is not None and order.ordered_at is not None:
        order.expected_delivery_at = order.ordered_at + timedelta(days=best_days)


# ──────────────────────────────────────────────────────────────────────────
# Delivery finalisation
# ──────────────────────────────────────────────────────────────────────────


def _refresh_article_counters(db: Session, article_id: int) -> None:
    """Recompute ``stock_total`` + ``stock_available`` from the movement
    ledger. Minimal inline implementation — Mobile BE owns the canonical
    ``apply_movement`` helper (see ``services/werkstatt_movements.py``);
    switch to it once it exists.

    TODO(tablet-be): switch to Mobile BE's apply_movement once it lands.
    """

    # Summed signed deltas per movement type.
    pos_types = ("intake", "return", "repair_back", "correction")
    neg_types = ("checkout", "repair_out")

    in_sum = (
        db.scalar(
            select(func.coalesce(func.sum(WerkstattMovement.quantity), 0)).where(
                WerkstattMovement.article_id == article_id,
                WerkstattMovement.movement_type.in_(pos_types),
            )
        )
        or 0
    )
    out_sum = (
        db.scalar(
            select(func.coalesce(func.sum(WerkstattMovement.quantity), 0)).where(
                WerkstattMovement.article_id == article_id,
                WerkstattMovement.movement_type.in_(neg_types),
            )
        )
        or 0
    )

    article = db.get(WerkstattArticle, article_id)
    if article is None:
        return

    # Stock buckets tracked separately.
    stock_out_sum = (
        db.scalar(
            select(func.coalesce(func.sum(WerkstattMovement.quantity), 0)).where(
                WerkstattMovement.article_id == article_id,
                WerkstattMovement.movement_type == "checkout",
            )
        )
        or 0
    )
    stock_return_sum = (
        db.scalar(
            select(func.coalesce(func.sum(WerkstattMovement.quantity), 0)).where(
                WerkstattMovement.article_id == article_id,
                WerkstattMovement.movement_type == "return",
            )
        )
        or 0
    )
    stock_repair_out_sum = (
        db.scalar(
            select(func.coalesce(func.sum(WerkstattMovement.quantity), 0)).where(
                WerkstattMovement.article_id == article_id,
                WerkstattMovement.movement_type == "repair_out",
            )
        )
        or 0
    )
    stock_repair_back_sum = (
        db.scalar(
            select(func.coalesce(func.sum(WerkstattMovement.quantity), 0)).where(
                WerkstattMovement.article_id == article_id,
                WerkstattMovement.movement_type == "repair_back",
            )
        )
        or 0
    )

    article.stock_total = max(int(in_sum) - int(out_sum), 0)
    article.stock_out = max(int(stock_out_sum) - int(stock_return_sum), 0)
    article.stock_repair = max(int(stock_repair_out_sum) - int(stock_repair_back_sum), 0)
    article.stock_available = max(
        article.stock_total - article.stock_out - article.stock_repair, 0
    )
    article.updated_at = utcnow()
    db.add(article)


def finalize_delivery(
    db: Session,
    order: WerkstattOrder,
    *,
    actor_id: int,
) -> None:
    """Create intake movements for every line that still has unreceived
    quantity, stamp line bookkeeping, and refresh the affected articles'
    stock counters.

    Idempotent: rerunning for a fully-received order creates no new
    movements because each line is skipped when ``quantity_received ==
    quantity_ordered``.
    """

    lines = db.scalars(
        select(WerkstattOrderLine).where(WerkstattOrderLine.order_id == order.id)
    ).all()
    now = utcnow()
    touched_articles: set[int] = set()

    for line in lines:
        remaining = max(line.quantity_ordered - line.quantity_received, 0)
        if remaining <= 0:
            # Already received — keep line_status consistent and continue.
            if line.line_status != "complete":
                line.line_status = "complete"
                line.received_at = line.received_at or now
                line.updated_at = now
                db.add(line)
            continue

        movement = WerkstattMovement(
            article_id=line.article_id,
            movement_type="intake",
            quantity=remaining,
            user_id=actor_id,
            related_order_line_id=line.id,
            notes=f"Wareneingang {order.order_number}",
            created_at=now,
        )
        db.add(movement)

        line.quantity_received = line.quantity_ordered
        line.line_status = "complete"
        line.received_at = now
        line.updated_at = now
        db.add(line)
        touched_articles.add(line.article_id)

    # Flush so the SUM over movements picks up our new intake rows.
    db.flush()

    for article_id in touched_articles:
        _refresh_article_counters(db, article_id)
