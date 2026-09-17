"""What an order does to the needs that went into it.

The Bedarfe view and the Bestellungen view are two windows on one decision:
"this material is missing". Once a need becomes an order line, every change
to that order is also a statement about the need — delivered means the
material is here, cancelled means it is missing again — and if that rule
lives at each call site it survives exactly as long as nobody edits one of
them.

So it lives here, as one function with one switch, called in three places
(mark-delivered, cancel, line delete), plus the merge pair below for the
fourth — folding one draft into another. The callers stay plain: no early
return, no commit — this flushes and lets the request's transaction decide.

Deliberately NOT here: creating the lines. That is
`services/material_need_orders.py`, because it needs the catalogue and the
project, and this module must stay importable from the orders routers
without dragging either in.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    ProjectMaterialNeed,
    WerkstattOrder,
    WerkstattOrderLine,
)

# The ladder, in order. `ordered` sits between "we should buy this" and "it is
# on a van": it means a buyer has acted, which is precisely what the office
# could not express before and therefore tracked on paper.
MATERIAL_NEED_STATUS_LADDER: tuple[str, ...] = (
    "order",
    "ordered",
    "on_the_way",
    "available",
    "completed",
)

# Statuses a delivery may advance. A need somebody already marked `available`
# or `completed` by hand is left alone — the fitter who did that knows
# something the delivery note does not.
_DELIVERY_ADVANCES_FROM = frozenset({"order", "ordered", "on_the_way"})

OrderSyncEvent = str  # "delivered" | "cancelled" | "line_deleted"


def _linked_needs(
    db: Session, order: WerkstattOrder, *, line_id: int | None
) -> list[ProjectMaterialNeed]:
    query = select(ProjectMaterialNeed).where(
        ProjectMaterialNeed.werkstatt_order_id == order.id
    )
    if line_id is not None:
        query = query.where(ProjectMaterialNeed.werkstatt_order_line_id == line_id)
    return list(db.scalars(query).all())


def _release(need: ProjectMaterialNeed) -> None:
    """Put a need back on the shopping list, links cleared."""

    need.werkstatt_order_id = None
    need.werkstatt_order_line_id = None
    need.ordered_at = None
    # Only a need that was waiting on THIS order goes back to "Bestellen".
    # One a fitter has since marked available keeps that.
    if need.status in {"ordered", "on_the_way"}:
        need.status = "order"


def sync_needs_for_order(
    db: Session,
    order: WerkstattOrder,
    event: OrderSyncEvent,
    *,
    line_id: int | None = None,
    actor_user_id: int | None = None,
) -> int:
    """Apply one order event to the needs linked to it. Returns how many moved.

    ``line_deleted`` must be called BEFORE the line row is deleted: the
    database's ON DELETE SET NULL would otherwise erase the link this needs to
    find the rows by.

    Flushes, never commits — the calling request owns the transaction.
    """

    needs = _linked_needs(db, order, line_id=line_id if event == "line_deleted" else None)
    if not needs:
        return 0

    now = utcnow()
    changed = 0
    for need in needs:
        before = (need.status, need.werkstatt_order_id, need.werkstatt_order_line_id)
        if event == "delivered":
            if need.status in _DELIVERY_ADVANCES_FROM:
                # The link stays: it is the receipt for where the material
                # came from, and the row shows it as "BST-2026-0042".
                need.status = "available"
        elif event in {"cancelled", "line_deleted"}:
            _release(need)
        else:  # pragma: no cover — guarded by the Literal at the call sites
            raise ValueError(f"unknown order sync event: {event!r}")

        if before == (need.status, need.werkstatt_order_id, need.werkstatt_order_line_id):
            continue
        need.updated_at = now
        if actor_user_id is not None:
            need.updated_by = actor_user_id
        db.add(need)
        changed += 1

    if changed:
        db.flush()
    return changed


# ── Merge ─────────────────────────────────────────────────────────────────
#
# Merging is the fourth order event, and the only one whose outcome is not
# knowable in advance: `merge_orders` either RE-PARENTS a source line onto the
# target (the link survives, only the order id moves) or DELETES it because an
# identical line was already there (the link is gone, like a line deletion).
# Which of the two happened can only be read afterwards — but the FK is
# ON DELETE SET NULL, so afterwards the deleted line's id is already erased
# from the need row.
#
# Hence the pair: capture the links first, decide second. Splitting it is not
# elegance, it is the only ordering in which both facts exist at once.


@dataclass(frozen=True)
class MergeNeedLink:
    """One need's link to the order being merged away, captured before it is."""

    need_id: int
    line_id: int | None


def capture_merge_links(db: Session, source: WerkstattOrder) -> tuple[MergeNeedLink, ...]:
    """Snapshot the needs pointing at `source`. Call BEFORE the merge."""

    rows = db.execute(
        select(ProjectMaterialNeed.id, ProjectMaterialNeed.werkstatt_order_line_id).where(
            ProjectMaterialNeed.werkstatt_order_id == source.id
        )
    ).all()
    return tuple(MergeNeedLink(need_id=need_id, line_id=line_id) for need_id, line_id in rows)


def sync_needs_for_merge(
    db: Session,
    source: WerkstattOrder,
    target: WerkstattOrder,
    links: tuple[MergeNeedLink, ...],
    *,
    actor_user_id: int | None = None,
) -> int:
    """Follow the needs of a merged-away order. Returns how many moved.

    Call AFTER `merge_orders`, with the snapshot `capture_merge_links` took
    before it. A need whose line survived now belongs to the target — that is
    where the material was actually bought, and where "geliefert" will fire.
    A need whose line was folded into an existing one has no receipt of its
    own any more, so it goes back on the shopping list rather than pointing at
    an order that was retired.

    Flushes, never commits — the calling request owns the transaction.
    """

    if not links:
        return 0

    surviving_line_ids = set(
        db.scalars(
            select(WerkstattOrderLine.id).where(
                WerkstattOrderLine.order_id == target.id,
                WerkstattOrderLine.id.in_([link.line_id for link in links if link.line_id]),
            )
        ).all()
    )

    now = utcnow()
    changed = 0
    for link in links:
        need = db.get(ProjectMaterialNeed, link.need_id)
        if need is None:
            continue
        before = (need.status, need.werkstatt_order_id, need.werkstatt_order_line_id)
        if link.line_id is not None and link.line_id in surviving_line_ids:
            need.werkstatt_order_id = target.id
            need.werkstatt_order_line_id = link.line_id
        else:
            _release(need)
        if before == (need.status, need.werkstatt_order_id, need.werkstatt_order_line_id):
            continue
        need.updated_at = now
        if actor_user_id is not None:
            need.updated_by = actor_user_id
        db.add(need)
        changed += 1

    if changed:
        db.flush()
    return changed
