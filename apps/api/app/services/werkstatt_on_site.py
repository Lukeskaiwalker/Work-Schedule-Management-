"""What is still out of the workshop, grouped by building site.

The dashboard's ``on_site_groups`` answers a smaller question: it counts
``checkout`` rows per project, top three projects, five rows each. Counting
checkout rows means a tool that was returned yesterday is still listed, because
a ``return`` carries neither ``project_id`` nor ``assignee_user_id`` — the
ledger never links a return back to the checkout it settles.

So this module reconstructs that link. Per article, it replays the ledger in
order and consumes each outgoing movement against the OLDEST open checkout
(FIFO). What survives the replay is what is genuinely still out there, and it
sums to ``article.stock_out`` by construction — the same ledger produces both,
via ``recompute_article_stock``.

FIFO is a choice, not a fact: the ledger does not record which checkout a
return settles, so no attribution can be derived. Oldest-first is the one that
matches how a workshop reads the list ("this has been gone longest"), and it is
deterministic, which a heuristic weighted by assignee would not be.

The replay is bounded rather than run over the whole ledger — see
``_open_lot_rows``. A page that reloads after every booking must not cost a
full ledger scan materialised in Python each time.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime

from sqlalchemy import case, func, or_, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    Project,
    User,
    WerkstattArticle,
    WerkstattMovement,
)
from app.schemas.werkstatt_on_site import (
    WerkstattOnSiteGroupOut,
    WerkstattOnSiteItemOut,
)

#: Movement types that take stock OUT of the workshop.
_OUTGOING = "checkout"

#: Movement types that end an outstanding checkout: the item is back on the
#: shelf (``return``), in the repair shop (``repair_out``), or written off as
#: lost (``correction``). All three decrement ``stock_out`` in
#: ``services/werkstatt_movements.py``, so all three settle a checkout here.
_SETTLING = frozenset({"return", "repair_out", "correction"})


@dataclass(frozen=True)
class _Row:
    """The six ledger columns the replay reads.

    Deliberately not a ``WerkstattMovement``: the replay never touches the
    other twenty columns, and instantiating mapped entities for history that
    only gets summed is what made this endpoint a memory risk.
    """

    movement_type: str
    quantity: int
    project_id: int | None
    assignee_user_id: int | None
    created_at: datetime
    expected_return_at: datetime | None


@dataclass(frozen=True)
class _Lot:
    """One checkout, with however much of it is still outstanding."""

    remaining: int
    project_id: int | None
    assignee_user_id: int | None
    checked_out_at: datetime
    expected_return_at: datetime | None


#: One rendered row: same site, same person, same deadline.
_LotKey = tuple[int | None, int | None, datetime | None]


def _replay(rows: list[_Row]) -> list[_Lot]:
    """Consume settling movements against open checkouts, oldest first.

    ``rows`` must already be in ledger order. Returns the lots that are still
    open, oldest first. A settling movement with nothing left to settle is
    dropped rather than carried as a negative: the snapshot counter clamps at
    zero for the same reason, and a negative lot would surface on this page as
    a phantom row.
    """

    open_lots: list[_Lot] = []
    for row in rows:
        quantity = int(row.quantity or 0)
        if quantity <= 0:
            continue
        if row.movement_type == _OUTGOING:
            open_lots = [
                *open_lots,
                _Lot(
                    remaining=quantity,
                    project_id=row.project_id,
                    assignee_user_id=row.assignee_user_id,
                    checked_out_at=row.created_at,
                    expected_return_at=row.expected_return_at,
                ),
            ]
            continue
        if row.movement_type not in _SETTLING:
            continue  # intake / repair_back / stock-take never touch `out`
        left = quantity
        settled: list[_Lot] = []
        for lot in open_lots:
            if left <= 0:
                settled = [*settled, lot]
                continue
            take = min(left, lot.remaining)
            left -= take
            if lot.remaining > take:
                settled = [*settled, replace(lot, remaining=lot.remaining - take)]
        open_lots = settled
    return open_lots


def _merge_lots(lots: list[_Lot]) -> list[_Lot]:
    """Collapse lots of the same article into one row per (site, person, deadline).

    Two checkouts of the same cable drum to the same person on the same site
    are one line on the page — but only while they are due back at the same
    moment. The deadline is part of the key because it is the fact the page
    colours and counts by: merging a lot due last week with one that has no
    return date at all would stamp the whole remainder as overdue and send the
    office chasing quantity that was never late.

    Returned oldest-checkout-first, so the page's FIFO story stays visible.
    """

    merged: dict[_LotKey, _Lot] = {}
    for lot in lots:
        key: _LotKey = (lot.project_id, lot.assignee_user_id, lot.expected_return_at)
        current = merged.get(key)
        if current is None:
            merged[key] = lot
            continue
        merged[key] = replace(
            current,
            remaining=current.remaining + lot.remaining,
            checked_out_at=min(current.checked_out_at, lot.checked_out_at),
        )
    return sorted(merged.values(), key=lambda lot: lot.checked_out_at)


def _open_lot_rows(db: Session, article_ids: set[int]) -> dict[int, list[_Row]]:
    """The ledger rows the replay actually needs, per article, in order.

    Not the whole history. Per article the query finds the most recent moment
    at which the outgoing balance stood at zero and starts there: a FIFO replay
    whose balance has reached zero holds no open lots, so everything before
    that point is settled history that cannot contribute an open lot. Starting
    at (rather than after) that timestamp is deliberate — it needs no row-value
    comparison to break ties within one timestamp, and the settling rows it
    replays too early are clamped away, which provably leaves the surviving
    lots unchanged.

    Two cases get the full history instead, both decided by the same query.
    One is an article whose balance stood at zero at no point in its ledger,
    not even before its first checkout — there is simply nothing to skip. The
    other is an article whose running balance goes NEGATIVE, which means a
    settling row larger than the balance it settles (``correction`` is the one
    type the write path does not bound against ``stock_out``). After that the
    replay's clamp and the raw sum have drifted apart, a raw zero crossing no
    longer marks an empty replay, and the shortcut would silently drop lots
    that are genuinely still out.
    """

    if not article_ids:
        return {}

    # Signed effect of each row on "how much is out", which is what the replay
    # tracks. Everything else (intake, repair_back, stock-take) is neutral.
    delta = case(
        (WerkstattMovement.movement_type == _OUTGOING, WerkstattMovement.quantity),
        (WerkstattMovement.movement_type.in_(sorted(_SETTLING)), -WerkstattMovement.quantity),
        else_=0,
    )
    running = func.sum(delta).over(
        partition_by=WerkstattMovement.article_id,
        order_by=(
            WerkstattMovement.created_at.asc(),
            WerkstattMovement.id.asc(),
        ),
    )
    ledger = (
        select(
            WerkstattMovement.article_id.label("article_id"),
            WerkstattMovement.id.label("id"),
            WerkstattMovement.movement_type.label("movement_type"),
            WerkstattMovement.quantity.label("quantity"),
            WerkstattMovement.project_id.label("project_id"),
            WerkstattMovement.assignee_user_id.label("assignee_user_id"),
            WerkstattMovement.created_at.label("created_at"),
            WerkstattMovement.expected_return_at.label("expected_return_at"),
            running.label("running"),
        )
        .where(WerkstattMovement.article_id.in_(article_ids))
        .cte("on_site_ledger")
    )
    floors = (
        select(
            ledger.c.article_id.label("article_id"),
            func.min(ledger.c.running).label("low_water"),
            func.max(
                case((ledger.c.running == 0, ledger.c.created_at), else_=None)
            ).label("settled_at"),
        )
        .group_by(ledger.c.article_id)
        .cte("on_site_floors")
    )
    stmt = (
        select(
            ledger.c.article_id,
            ledger.c.movement_type,
            ledger.c.quantity,
            ledger.c.project_id,
            ledger.c.assignee_user_id,
            ledger.c.created_at,
            ledger.c.expected_return_at,
        )
        .join(floors, floors.c.article_id == ledger.c.article_id)
        .where(
            or_(
                floors.c.settled_at.is_(None),
                floors.c.low_water < 0,
                ledger.c.created_at >= floors.c.settled_at,
            )
        )
        .order_by(
            ledger.c.article_id.asc(),
            ledger.c.created_at.asc(),
            ledger.c.id.asc(),
        )
    )

    by_article: dict[int, list[_Row]] = {}
    for row in db.execute(stmt):
        by_article.setdefault(int(row.article_id), []).append(
            _Row(
                movement_type=row.movement_type,
                quantity=int(row.quantity or 0),
                project_id=row.project_id,
                assignee_user_id=row.assignee_user_id,
                created_at=row.created_at,
                expected_return_at=row.expected_return_at,
            )
        )
    return by_article


def list_on_site_groups(db: Session) -> list[WerkstattOnSiteGroupOut]:
    """Everything currently checked out, grouped by project. No cap."""

    articles = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.stock_out > 0,
        )
        .order_by(WerkstattArticle.item_name.asc())
    ).all()
    if not articles:
        return []

    rows_by_article = _open_lot_rows(db, {a.id for a in articles})

    # (project_id → rows), plus the ids we have to resolve to display names.
    rows_by_project: dict[int | None, list[WerkstattOnSiteItemOut]] = {}
    assignee_ids: set[int] = set()
    pending: list[tuple[WerkstattArticle, _Lot]] = []
    for article in articles:
        open_lots = _replay(rows_by_article.get(int(article.id), []))
        for lot in _merge_lots(open_lots):
            if lot.remaining <= 0:
                continue
            if lot.assignee_user_id is not None:
                assignee_ids.add(int(lot.assignee_user_id))
            pending.append((article, lot))

    assignee_names: dict[int, str] = {}
    if assignee_ids:
        for user in db.scalars(select(User).where(User.id.in_(assignee_ids))).all():
            assignee_names[int(user.id)] = user.display_name

    now = utcnow()
    for article, lot in pending:
        deadline = lot.expected_return_at
        item = WerkstattOnSiteItemOut(
            article_id=int(article.id),
            article_number=article.article_number,
            article_name=article.item_name,
            unit=article.unit,
            image_url=article.image_url,
            quantity_out=int(lot.remaining),
            assignee_user_id=lot.assignee_user_id,
            assignee_display_name=(
                assignee_names.get(int(lot.assignee_user_id))
                if lot.assignee_user_id is not None
                else None
            ),
            checked_out_at=lot.checked_out_at,
            expected_return_at=deadline,
            is_overdue=bool(deadline is not None and deadline < now),
        )
        rows_by_project.setdefault(lot.project_id, []).append(item)

    if not rows_by_project:
        return []

    project_ids = {pid for pid in rows_by_project if pid is not None}
    projects_by_id = {
        p.id: p
        for p in db.scalars(select(Project).where(Project.id.in_(project_ids))).all()
    } if project_ids else {}

    # A movement may name a project row that has since been deleted. Those
    # articles are still out, so they join the "no project" bucket rather than
    # forming a second nameless group beside it — or worse, disappearing.
    resolved: dict[int | None, list[WerkstattOnSiteItemOut]] = {}
    for project_id, items in rows_by_project.items():
        key = project_id if project_id in projects_by_id else None
        resolved[key] = [*resolved.get(key, []), *items]

    groups: list[WerkstattOnSiteGroupOut] = []
    for project_id, items in resolved.items():
        project = projects_by_id.get(project_id) if project_id is not None else None
        ordered = sorted(
            items,
            key=lambda row: (not row.is_overdue, row.article_name.lower()),
        )
        groups.append(
            WerkstattOnSiteGroupOut(
                project_id=project.id if project else None,
                project_number=project.project_number if project else None,
                project_title=project.name if project else None,
                item_count=len(ordered),
                total_quantity=sum(row.quantity_out for row in ordered),
                overdue_count=sum(1 for row in ordered if row.is_overdue),
                items=ordered,
            )
        )

    # Sites with something late come first; the no-project bucket goes last.
    return sorted(
        groups,
        key=lambda group: (
            group.project_number is None,
            group.overdue_count == 0,
            group.project_number or "",
        ),
    )
