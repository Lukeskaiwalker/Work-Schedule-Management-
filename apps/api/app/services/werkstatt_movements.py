"""Werkstatt movement ledger — shared service.

This module is the authoritative implementation of stock mutations for the
Werkstatt feature. Both the Mobile BE (quick checkout/return) and the
Tablet BE (delivery-finalize flow) use ``apply_movement`` to write rows
into the append-only ``werkstatt_movements`` ledger; stock counters on
``werkstatt_articles`` are recomputed after each movement.

Design rules (see WERKSTATT_CONTRACT.md §2.5):

- The ledger is the source of truth. ``stock_total`` / ``stock_available``
  / ``stock_out`` / ``stock_repair`` are snapshots that we rebuild from
  the full ledger after every mutation.
- ``quantity`` is always positive; the sign is implied by ``movement_type``.
- Failures (e.g. negative checkout balance) raise ``MovementError`` so the
  router can translate it into an HTTP 400.

Movement types and their effect on the four counters:

    checkout    : available -= qty, out += qty          (total unchanged)
    return      : available += qty, out -= qty          (total unchanged)
    intake      : total    += qty, available += qty     (new stock arriving)
    correction  : total    -= qty, out      -= qty      (write-off for lost)
                  (clamped at zero for both counters)
    repair_out  : out      -= qty, repair   += qty      (total unchanged)
    repair_back : repair   -= qty, available += qty     (total unchanged)
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import Project, User, WerkstattArticle, WerkstattMovement


# ──────────────────────────────────────────────────────────────────────────
# Public errors
# ──────────────────────────────────────────────────────────────────────────


class MovementError(Exception):
    """Raised when a proposed ledger entry would be invalid (e.g. checkout
    quantity exceeds available stock, unknown movement_type, etc.)."""


# ──────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────


# Movement types that *decrement* each counter (the ledger aggregation flips
# the sign on these entries). Kept here so the recompute aggregate and the
# validation in apply_movement agree on semantics.
_DELTAS: dict[str, dict[str, int]] = {
    # counter → signed delta per unit quantity
    "checkout":    {"available": -1, "out":    +1},
    "return":      {"available": +1, "out":    -1},
    "intake":      {"total":     +1, "available": +1},
    "correction":  {"total":     -1, "out":    -1},
    "repair_out":  {"out":       -1, "repair": +1},
    "repair_back": {"repair":    -1, "available": +1},
}

ALLOWED_MOVEMENT_TYPES: frozenset[str] = frozenset(_DELTAS.keys())


# ──────────────────────────────────────────────────────────────────────────
# Core write path
# ──────────────────────────────────────────────────────────────────────────


def apply_movement(
    db: Session,
    *,
    article: WerkstattArticle,
    movement_type: str,
    quantity: int,
    user_id: int,
    assignee_user_id: int | None = None,
    project_id: int | None = None,
    from_location_id: int | None = None,
    to_location_id: int | None = None,
    expected_return_at: datetime | None = None,
    related_order_line_id: int | None = None,
    notes: str | None = None,
) -> WerkstattMovement:
    """Append a movement to the ledger and recompute the article's snapshot
    counters.

    The caller is responsible for commit semantics — this function calls
    ``db.flush()`` so the returned row has an ``id``, and mutates the
    passed-in article instance in-place with the new counters, but does
    NOT ``commit()``. Routers typically commit at the end of the request.
    """

    if movement_type not in ALLOWED_MOVEMENT_TYPES:
        raise MovementError(f"Unknown movement_type: {movement_type!r}")
    if quantity <= 0:
        raise MovementError("quantity must be positive")

    # Pre-validate: guard against negative balances for the obvious cases so
    # we surface a clear 400 before touching the DB. The recompute below is
    # the ultimate source of truth — these checks are just fast-fail.
    if movement_type == "checkout" and quantity > int(article.stock_available or 0):
        raise MovementError(
            f"Checkout quantity {quantity} exceeds stock_available "
            f"{article.stock_available} for article {article.article_number}"
        )
    if movement_type == "return" and quantity > int(article.stock_out or 0):
        raise MovementError(
            f"Return quantity {quantity} exceeds stock_out "
            f"{article.stock_out} for article {article.article_number}"
        )
    if movement_type == "repair_out" and quantity > int(article.stock_out or 0):
        raise MovementError(
            f"repair_out quantity {quantity} exceeds stock_out "
            f"{article.stock_out} for article {article.article_number}"
        )
    if movement_type == "repair_back" and quantity > int(article.stock_repair or 0):
        raise MovementError(
            f"repair_back quantity {quantity} exceeds stock_repair "
            f"{article.stock_repair} for article {article.article_number}"
        )

    now = utcnow()
    movement = WerkstattMovement(
        article_id=article.id,
        movement_type=movement_type,
        quantity=int(quantity),
        from_location_id=from_location_id,
        to_location_id=to_location_id,
        project_id=project_id,
        user_id=user_id,
        assignee_user_id=assignee_user_id,
        expected_return_at=expected_return_at,
        related_order_line_id=related_order_line_id,
        notes=notes,
        created_at=now,
    )
    db.add(movement)
    db.flush()  # make sure the row is visible to the recompute SELECT

    recompute_article_stock(db, article)
    return movement


# ──────────────────────────────────────────────────────────────────────────
# Recompute snapshot from the ledger
# ──────────────────────────────────────────────────────────────────────────


def recompute_article_stock(db: Session, article: WerkstattArticle) -> None:
    """Rebuild ``stock_total / stock_available / stock_out / stock_repair``
    for ``article`` by aggregating over the full ledger.

    Idempotent — safe to call even when the ledger hasn't changed. We clamp
    each counter at zero so a stray ``correction`` past the balance doesn't
    leave a negative snapshot.
    """

    # Sum ± qty per counter using a CASE per movement_type. Six types × four
    # counters is small and readable; a SQL aggregate is cheaper than loading
    # every row into Python.
    def _sum(counter: str) -> func.coalesce:
        branches: list = []
        for mv_type, deltas in _DELTAS.items():
            delta = deltas.get(counter, 0)
            if delta == 0:
                continue
            branches.append(
                (WerkstattMovement.movement_type == mv_type,
                 WerkstattMovement.quantity * delta)
            )
        if not branches:
            return func.coalesce(func.sum(None), 0)
        expr = case(*branches, else_=0)
        return func.coalesce(func.sum(expr), 0)

    stmt = select(
        _sum("total").label("total"),
        _sum("available").label("available"),
        _sum("out").label("out"),
        _sum("repair").label("repair"),
    ).where(WerkstattMovement.article_id == article.id)
    row = db.execute(stmt).one()

    article.stock_total = max(0, int(row.total or 0))
    article.stock_available = max(0, int(row.available or 0))
    article.stock_out = max(0, int(row.out or 0))
    article.stock_repair = max(0, int(row.repair or 0))
    db.add(article)


# ──────────────────────────────────────────────────────────────────────────
# Query helpers (read-side, shared across routers)
# ──────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _OutstandingRow:
    article_id: int
    quantity_out: int
    earliest_checkout_at: datetime
    latest_expected_return_at: datetime | None
    project_id: int | None


def list_my_checkouts(db: Session, user_id: int) -> list[dict]:
    """Return one row per distinct article for which *this user* still has
    checkouts that have not been fully balanced by subsequent returns.

    Grouping is by ``(article_id, project_id)`` so a tool checked out to two
    different projects appears as two rows — matching how the FE expects to
    render the "My checkouts" list.
    """

    # Outstanding = checkouts performed by this user
    #             − returns/repair_out/corrections that followed them on the
    #               same article. We approximate the balance per article by
    #               totalling signed contributions; the ledger doesn't
    #               link returns back to specific checkouts, so this is
    #               necessarily an aggregate view.
    #
    # Only movements with ``assignee_user_id == user_id`` (or if absent,
    # ``user_id == user_id``) count as "mine", so admins who check out a
    # tool *for* someone else do not see it here.
    mine_expr = (
        (WerkstattMovement.assignee_user_id == user_id)
        | and_(
            WerkstattMovement.assignee_user_id.is_(None),
            WerkstattMovement.user_id == user_id,
        )
    )

    # We compute outstanding per (article, project) tuple by summing
    # ``+qty`` for checkouts and ``−qty`` for returns / repair_out /
    # correction filed against the same (article, project) by the same user.
    signed_qty = case(
        (WerkstattMovement.movement_type == "checkout", WerkstattMovement.quantity),
        (WerkstattMovement.movement_type.in_(("return", "repair_out", "correction")),
         -WerkstattMovement.quantity),
        else_=0,
    )

    stmt = (
        select(
            WerkstattMovement.article_id.label("article_id"),
            WerkstattMovement.project_id.label("project_id"),
            func.coalesce(func.sum(signed_qty), 0).label("quantity_out"),
            func.min(
                case(
                    (WerkstattMovement.movement_type == "checkout",
                     WerkstattMovement.created_at),
                    else_=None,
                )
            ).label("earliest_checkout_at"),
            func.max(
                case(
                    (WerkstattMovement.movement_type == "checkout",
                     WerkstattMovement.expected_return_at),
                    else_=None,
                )
            ).label("latest_expected_return_at"),
        )
        .where(mine_expr)
        .group_by(WerkstattMovement.article_id, WerkstattMovement.project_id)
        .having(func.coalesce(func.sum(signed_qty), 0) > 0)
        .order_by(WerkstattMovement.article_id.asc())
    )
    raw_rows = db.execute(stmt).all()
    if not raw_rows:
        return []

    article_ids = {int(r.article_id) for r in raw_rows}
    project_ids = {int(r.project_id) for r in raw_rows if r.project_id is not None}

    articles_by_id = {
        a.id: a for a in db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id.in_(article_ids))
        ).all()
    }
    projects_by_id = {
        p.id: p for p in db.scalars(
            select(Project).where(Project.id.in_(project_ids))
        ).all()
    } if project_ids else {}

    out: list[dict] = []
    for row in raw_rows:
        article = articles_by_id.get(int(row.article_id))
        if article is None:
            continue
        project = projects_by_id.get(int(row.project_id)) if row.project_id else None
        out.append({
            "article_id": article.id,
            "article_number": article.article_number,
            "article_name": article.item_name,
            "image_url": article.image_url,
            "unit": article.unit,
            "quantity_out": int(row.quantity_out or 0),
            "earliest_checkout_at": row.earliest_checkout_at,
            "latest_expected_return_at": row.latest_expected_return_at,
            "project_id": project.id if project else None,
            "project_number": project.project_number if project else None,
            "project_name": project.name if project else None,
        })
    return out


def build_movement_out_rows(
    db: Session,
    movements: Iterable[WerkstattMovement],
) -> list[dict]:
    """Enrich a list of raw WerkstattMovement rows with article / user /
    project display info suitable for ``WerkstattMovementOut``.

    Used by the mobile movements list endpoint (and re-usable by other BE
    agents). Batched joins — one lookup per related table, not N+1.
    """

    movements_list = list(movements)
    if not movements_list:
        return []

    article_ids = {m.article_id for m in movements_list}
    user_ids: set[int] = set()
    project_ids: set[int] = set()
    location_ids: set[int] = set()
    for m in movements_list:
        user_ids.add(m.user_id)
        if m.assignee_user_id is not None:
            user_ids.add(m.assignee_user_id)
        if m.project_id is not None:
            project_ids.add(m.project_id)
        if m.from_location_id is not None:
            location_ids.add(m.from_location_id)
        if m.to_location_id is not None:
            location_ids.add(m.to_location_id)

    articles = {
        a.id: a for a in db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id.in_(article_ids))
        ).all()
    }
    users = {
        u.id: u for u in db.scalars(
            select(User).where(User.id.in_(user_ids))
        ).all()
    } if user_ids else {}
    projects = {
        p.id: p for p in db.scalars(
            select(Project).where(Project.id.in_(project_ids))
        ).all()
    } if project_ids else {}

    # Locations: only the display name is needed.
    location_names: dict[int, str] = {}
    if location_ids:
        from app.models.entities import WerkstattLocation  # local import to avoid cycles
        for loc in db.scalars(
            select(WerkstattLocation).where(WerkstattLocation.id.in_(location_ids))
        ).all():
            location_names[loc.id] = loc.name

    rows: list[dict] = []
    for m in movements_list:
        article = articles.get(m.article_id)
        performer = users.get(m.user_id)
        assignee = users.get(m.assignee_user_id) if m.assignee_user_id else None
        project = projects.get(m.project_id) if m.project_id else None
        rows.append({
            "id": m.id,
            "article_id": m.article_id,
            "article_number": article.article_number if article else "",
            "article_name": article.item_name if article else "",
            "movement_type": m.movement_type,
            "quantity": int(m.quantity),
            "from_location_name": location_names.get(m.from_location_id) if m.from_location_id else None,
            "to_location_name": location_names.get(m.to_location_id) if m.to_location_id else None,
            "project_id": m.project_id,
            "project_number": project.project_number if project else None,
            "project_name": project.name if project else None,
            "user_id": m.user_id,
            "user_display_name": performer.display_name if performer else "",
            "assignee_user_id": m.assignee_user_id,
            "assignee_display_name": assignee.display_name if assignee else None,
            "expected_return_at": m.expected_return_at,
            "notes": m.notes,
            "created_at": m.created_at,
        })
    return rows
