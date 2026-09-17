"""Aggregate query helpers for the Werkstatt Desktop dashboard endpoint.

Keeps the router thin by concentrating all the left-joins + GROUP BY logic
here. Each helper returns a Pydantic `*Out` object or list of objects so the
router just composes them into the top-level `WerkstattDashboardOut`.
"""

from __future__ import annotations

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    Project,
    User,
    WerkstattArticle,
    WerkstattCategory,
    WerkstattLocation,
    WerkstattMovement,
)
from app.schemas.werkstatt import (
    WerkstattCheckoutGroupItemOut,
    WerkstattCheckoutGroupPreviewOut,
    WerkstattDashboardKpisOut,
    WerkstattInspectionDueOut,
    WerkstattMovementOut,
    ReorderSuggestionLineOut,
)
from app.services.werkstatt_on_site import list_on_site_groups


DASHBOARD_RECENT_MOVEMENTS_LIMIT = 5
DASHBOARD_REORDER_PREVIEW_LIMIT = 5
DASHBOARD_ON_SITE_GROUPS_LIMIT = 3
DASHBOARD_ON_SITE_ITEMS_LIMIT = 5
DASHBOARD_MAINTENANCE_LIMIT = 5


def compute_dashboard_kpis(db: Session) -> WerkstattDashboardKpisOut:
    active_articles = and_(
        WerkstattArticle.is_archived.is_(False),
    )
    total_articles = int(db.scalar(select(func.count(WerkstattArticle.id)).where(active_articles)) or 0)
    total_categories = int(
        db.scalar(
            select(func.count(WerkstattCategory.id)).where(WerkstattCategory.is_archived.is_(False))
        )
        or 0
    )
    below_min_count = int(
        db.scalar(
            select(func.count(WerkstattArticle.id)).where(
                active_articles,
                WerkstattArticle.stock_min > 0,
                WerkstattArticle.stock_available < WerkstattArticle.stock_min,
            )
        )
        or 0
    )
    on_site_count = int(
        db.scalar(
            select(func.count(WerkstattArticle.id)).where(
                active_articles, WerkstattArticle.stock_out > 0
            )
        )
        or 0
    )
    # Projects that STILL have something out, not every project that has ever
    # received a checkout. The plain distinct-count below never subtracted a
    # return, so the tile only ever grew: after a year it read "projects we have
    # lent anything to, ever", beside an on_site_count that does net returns.
    # list_on_site_groups replays the ledger per article and is the one place
    # that arithmetic lives; a group with a null project_id is stock out without
    # a job attached and is not a project.
    on_site_project_count = sum(
        1 for group in list_on_site_groups(db) if group.project_id is not None
    )
    unavailable_count = int(
        db.scalar(
            select(func.count(WerkstattArticle.id)).where(
                active_articles, WerkstattArticle.stock_available <= 0
            )
        )
        or 0
    )
    in_repair_count = int(
        db.scalar(
            select(func.count(WerkstattArticle.id)).where(
                active_articles, WerkstattArticle.stock_repair > 0
            )
        )
        or 0
    )
    return WerkstattDashboardKpisOut(
        total_articles=total_articles,
        total_categories=total_categories,
        below_min_count=below_min_count,
        on_site_count=on_site_count,
        on_site_project_count=on_site_project_count,
        unavailable_count=unavailable_count,
        in_repair_count=in_repair_count,
    )


def compute_reorder_preview(db: Session, *, limit: int = DASHBOARD_REORDER_PREVIEW_LIMIT) -> list[ReorderSuggestionLineOut]:
    rows = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.stock_min > 0,
            WerkstattArticle.stock_available < WerkstattArticle.stock_min,
        )
        .order_by(
            (WerkstattArticle.stock_available - WerkstattArticle.stock_min).asc(),
            WerkstattArticle.item_name.asc(),
        )
        .limit(limit)
    ).all()
    result: list[ReorderSuggestionLineOut] = []
    for article in rows:
        suggested = max(1, article.stock_min - article.stock_available)
        unit_price = article.purchase_price_cents
        line_total = unit_price * suggested if unit_price is not None else None
        result.append(
            ReorderSuggestionLineOut(
                article_id=article.id,
                article_number=article.article_number,
                article_name=article.item_name,
                image_url=article.image_url,
                stock_available=article.stock_available,
                stock_min=article.stock_min,
                suggested_quantity=suggested,
                unit=article.unit,
                unit_price_cents=unit_price,
                line_total_cents=line_total,
            )
        )
    return result


def recent_movements(db: Session, *, limit: int = DASHBOARD_RECENT_MOVEMENTS_LIMIT) -> list[WerkstattMovementOut]:
    stmt = (
        select(WerkstattMovement, WerkstattArticle, User, Project)
        .join(WerkstattArticle, WerkstattArticle.id == WerkstattMovement.article_id)
        .join(User, User.id == WerkstattMovement.user_id)
        .outerjoin(Project, Project.id == WerkstattMovement.project_id)
        .order_by(WerkstattMovement.created_at.desc(), WerkstattMovement.id.desc())
        .limit(limit)
    )
    # From/to location names require a second pass. Fetch all locations once.
    location_ids: set[int] = set()
    rows = db.execute(stmt).all()
    for movement, _article, _user, _project in rows:
        if movement.from_location_id:
            location_ids.add(movement.from_location_id)
        if movement.to_location_id:
            location_ids.add(movement.to_location_id)
    assignee_ids: set[int] = {
        movement.assignee_user_id for movement, _, _, _ in rows if movement.assignee_user_id
    }
    locations_by_id: dict[int, str] = {}
    if location_ids:
        loc_rows = db.execute(
            select(WerkstattLocation.id, WerkstattLocation.name).where(
                WerkstattLocation.id.in_(location_ids)
            )
        ).all()
        locations_by_id = {row_id: name for row_id, name in loc_rows}
    assignees_by_id: dict[int, str] = {}
    if assignee_ids:
        assignee_rows = db.execute(
            select(User.id, User.full_name, User.email).where(User.id.in_(assignee_ids))
        ).all()
        for uid, full_name, email in assignee_rows:
            assignees_by_id[uid] = full_name or email or f"User #{uid}"

    result: list[WerkstattMovementOut] = []
    for movement, article, user, project in rows:
        result.append(
            WerkstattMovementOut(
                id=movement.id,
                article_id=movement.article_id,
                article_number=article.article_number,
                article_name=article.item_name,
                movement_type=movement.movement_type,  # type: ignore[arg-type]
                quantity=movement.quantity,
                from_location_name=(
                    locations_by_id.get(movement.from_location_id)
                    if movement.from_location_id
                    else None
                ),
                to_location_name=(
                    locations_by_id.get(movement.to_location_id)
                    if movement.to_location_id
                    else None
                ),
                project_id=movement.project_id,
                project_number=project.project_number if project else None,
                project_name=project.name if project else None,
                user_id=movement.user_id,
                user_display_name=(user.full_name or user.email or f"User #{user.id}"),
                assignee_user_id=movement.assignee_user_id,
                assignee_display_name=(
                    assignees_by_id.get(movement.assignee_user_id)
                    if movement.assignee_user_id
                    else None
                ),
                expected_return_at=movement.expected_return_at,
                notes=movement.notes,
                created_at=movement.created_at,
            )
        )
    return result


def on_site_groups(db: Session, *, limit: int = DASHBOARD_ON_SITE_GROUPS_LIMIT) -> list[WerkstattCheckoutGroupPreviewOut]:
    """The dashboard's preview of what is still out, biggest sites first.

    Derived from ``list_on_site_groups`` rather than counted here. The version
    this replaces selected projects by their number of ``checkout`` ledger rows
    and listed the five newest of those rows — with nothing subtracting a
    return, so a tool booked back days ago kept its place on the card, and a
    site whose every item had come home could still head the list. The ledger
    replay is the only arithmetic that answers "still out"; keeping a second,
    looser one next to it is how the card and the page underneath it came to
    disagree.

    Only the shape is this function's own: the preview caps at ``limit``
    projects and five items each, and drops the no-project group, which belongs
    on the full page rather than in a card about sites.
    """
    groups: list[WerkstattCheckoutGroupPreviewOut] = []
    for group in list_on_site_groups(db):
        if group.project_id is None:
            continue
        items = [
            WerkstattCheckoutGroupItemOut(
                article_id=item.article_id,
                article_number=item.article_number,
                article_name=item.article_name,
                quantity=item.quantity_out,
                assignee_display_name=item.assignee_display_name,
                expected_return_at=item.expected_return_at,
                is_overdue=item.is_overdue,
            )
            for item in group.items[:DASHBOARD_ON_SITE_ITEMS_LIMIT]
        ]
        groups.append(
            WerkstattCheckoutGroupPreviewOut(
                project_id=group.project_id,
                project_number=group.project_number or "",
                project_title=group.project_title or "",
                # What the site actually has out, not how many of them fit on
                # the card — the number under the title must not shrink when
                # the preview truncates.
                item_count=group.item_count,
                items=items,
            )
        )
        if len(groups) >= limit:
            break
    return groups

def maintenance_entries(
    db: Session, *, limit: int = DASHBOARD_MAINTENANCE_LIMIT
) -> list[WerkstattInspectionDueOut]:
    now = utcnow()
    rows = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.bg_inspection_required.is_(True),
            or_(
                WerkstattArticle.next_bg_due_at.is_(None),
                WerkstattArticle.next_bg_due_at.is_not(None),
            ),
        )
        .order_by(
            # Overdue/soon first — NULLs last.
            WerkstattArticle.next_bg_due_at.asc().nulls_last(),
            WerkstattArticle.item_name.asc(),
        )
        .limit(limit)
    ).all()
    if not rows:
        return []

    category_ids = {r.category_id for r in rows if r.category_id}
    location_ids = {r.location_id for r in rows if r.location_id}
    categories_by_id: dict[int, str] = {}
    if category_ids:
        categories_by_id = {
            row_id: name
            for row_id, name in db.execute(
                select(WerkstattCategory.id, WerkstattCategory.name).where(
                    WerkstattCategory.id.in_(category_ids)
                )
            ).all()
        }
    locations_by_id: dict[int, str] = {}
    if location_ids:
        locations_by_id = {
            row_id: name
            for row_id, name in db.execute(
                select(WerkstattLocation.id, WerkstattLocation.name).where(
                    WerkstattLocation.id.in_(location_ids)
                )
            ).all()
        }

    result: list[WerkstattInspectionDueOut] = []
    for article in rows:
        days_until: int | None
        urgency: str
        if article.next_bg_due_at is None:
            days_until = None
            urgency = "ok"
        else:
            delta = article.next_bg_due_at - now
            days_until = int(delta.days)
            if days_until < 0:
                urgency = "overdue"
            elif days_until <= 14:
                urgency = "due_soon"
            else:
                urgency = "ok"
        result.append(
            WerkstattInspectionDueOut(
                article_id=article.id,
                article_number=article.article_number,
                article_name=article.item_name,
                category_name=(
                    categories_by_id.get(article.category_id) if article.category_id else None
                ),
                location_name=(
                    locations_by_id.get(article.location_id) if article.location_id else None
                ),
                last_bg_inspected_at=article.last_bg_inspected_at,
                next_bg_due_at=article.next_bg_due_at,
                days_until_due=days_until,
                urgency=urgency,  # type: ignore[arg-type]
            )
        )
    return result
