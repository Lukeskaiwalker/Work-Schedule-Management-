"""Werkstatt BG-Prüfung (tool safety inspection) helpers.

Owned by: Tablet BE agent.

Implements:
  - ``list_inspections_due``: upcoming + overdue inspections for the
    "Prüfungen" view.
  - ``record_inspection``: stamps the article's inspection bookkeeping
    and appends an audit movement row.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    WerkstattArticle,
    WerkstattCategory,
    WerkstattLocation,
    WerkstattMovement,
)
from app.schemas.werkstatt import WerkstattInspectionDueOut

DUE_SOON_THRESHOLD_DAYS = 7


def _urgency_for(delta_days: int | None) -> str:
    if delta_days is None:
        return "ok"
    if delta_days < 0:
        return "overdue"
    if delta_days <= DUE_SOON_THRESHOLD_DAYS:
        return "due_soon"
    return "ok"


def list_inspections_due(
    db: Session,
    *,
    days_ahead: int = 30,
    now: datetime | None = None,
) -> list[WerkstattInspectionDueOut]:
    """Return all articles requiring BG-Prüfung that are either overdue or
    due within ``days_ahead`` days, plus those with no ``next_bg_due_at``
    yet (they need their initial inspection).
    """

    reference = now or utcnow()
    horizon = reference + timedelta(days=max(days_ahead, 0))

    rows = db.scalars(
        select(WerkstattArticle)
        .where(
            WerkstattArticle.is_archived.is_(False),
            WerkstattArticle.bg_inspection_required.is_(True),
        )
        .order_by(
            WerkstattArticle.next_bg_due_at.is_(None).desc(),
            WerkstattArticle.next_bg_due_at.asc(),
            WerkstattArticle.article_number.asc(),
        )
    ).all()

    # Pre-load taxonomies for the names.
    category_ids = {row.category_id for row in rows if row.category_id is not None}
    location_ids = {row.location_id for row in rows if row.location_id is not None}
    categories_by_id: dict[int, WerkstattCategory] = {}
    locations_by_id: dict[int, WerkstattLocation] = {}
    if category_ids:
        for cat in db.scalars(
            select(WerkstattCategory).where(WerkstattCategory.id.in_(category_ids))
        ).all():
            categories_by_id[cat.id] = cat
    if location_ids:
        for loc in db.scalars(
            select(WerkstattLocation).where(WerkstattLocation.id.in_(location_ids))
        ).all():
            locations_by_id[loc.id] = loc

    result: list[WerkstattInspectionDueOut] = []
    for article in rows:
        days_until_due: int | None
        next_due = article.next_bg_due_at
        if next_due is None:
            # Never inspected: surface as overdue so the user acts.
            days_until_due = None
            urgency = "overdue"
        else:
            days_until_due = (next_due - reference).days
            if next_due > horizon:
                # Not within our window and not overdue — skip.
                continue
            urgency = _urgency_for(days_until_due)

        result.append(
            WerkstattInspectionDueOut(
                article_id=article.id,
                article_number=article.article_number,
                article_name=article.item_name,
                category_name=(
                    categories_by_id[article.category_id].name
                    if article.category_id is not None
                    and article.category_id in categories_by_id
                    else None
                ),
                location_name=(
                    locations_by_id[article.location_id].name
                    if article.location_id is not None
                    and article.location_id in locations_by_id
                    else None
                ),
                last_bg_inspected_at=article.last_bg_inspected_at,
                next_bg_due_at=article.next_bg_due_at,
                days_until_due=days_until_due,
                urgency=urgency,  # type: ignore[arg-type]
            )
        )

    return result


def record_inspection(
    db: Session,
    article: WerkstattArticle,
    *,
    passed: bool,
    inspected_at: datetime | None,
    notes: str | None,
    actor_id: int,
) -> None:
    """Stamp ``article`` with the inspection result and append an audit
    movement row.

    Business rules:
      - If ``bg_inspection_interval_days`` is set, ``next_bg_due_at`` is
        advanced to ``inspected_at + interval``.
      - The audit movement uses ``movement_type="correction"`` with
        ``quantity=0`` and a notes prefix ``"BG-Prüfung"``.
    """

    stamp = inspected_at or utcnow()
    article.last_bg_inspected_at = stamp
    interval = article.bg_inspection_interval_days
    if interval is not None and interval > 0:
        article.next_bg_due_at = stamp + timedelta(days=interval)
    article.updated_at = utcnow()
    db.add(article)

    parts = [
        "BG-Prüfung",
        "bestanden" if passed else "nicht bestanden",
    ]
    if notes:
        parts.append(notes.strip())
    audit_note = " — ".join(part for part in parts if part)

    movement = WerkstattMovement(
        article_id=article.id,
        movement_type="correction",
        quantity=0,
        user_id=actor_id,
        notes=audit_note,
        created_at=utcnow(),
    )
    db.add(movement)
