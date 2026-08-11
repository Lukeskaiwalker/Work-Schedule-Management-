"""Projection of machine rows into `MachineOut`.

Extracted from the machines router because the scan cascade needs the exact
same shape: a scanned label and an opened detail page must describe the machine
identically, or the phone and the desk disagree about whether a drill is
overdue. Two projections would drift the first time one of them is edited.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattArticleUnit,
    WerkstattLocation,
)
from app.schemas.werkstatt_machines import MachineComponentOut, MachineOut
from app.services import werkstatt_machines as machines


def name_maps(db: Session) -> tuple[dict[int, str], dict[int, str]]:
    """id → name for locations and users, fetched once per request.

    The alternative is a relationship load per row; a workshop with a few
    hundred machines would turn one list into a few hundred queries.
    """
    locations = {row.id: row.name for row in db.scalars(select(WerkstattLocation)).all()}
    users = {row.id: (row.full_name or row.email) for row in db.scalars(select(User)).all()}
    return locations, users


def machine_out(
    unit: WerkstattArticleUnit,
    *,
    article: WerkstattArticle | None,
    locations: dict[int, str],
    users: dict[int, str],
    components: list[WerkstattArticleUnit] | None = None,
    component_articles: dict[int, WerkstattArticle] | None = None,
    now: datetime | None = None,
) -> MachineOut:
    moment = now or utcnow()
    component_articles = component_articles or {}

    return MachineOut(
        id=unit.id,
        unit_number=unit.unit_number,
        article_id=unit.article_id,
        article_name=article.item_name if article else None,
        manufacturer=article.manufacturer if article else None,
        parent_unit_id=unit.parent_unit_id,
        serial_number=unit.serial_number,
        status=unit.status,
        current_location_id=unit.current_location_id,
        current_location_name=locations.get(unit.current_location_id or -1),
        holder_user_id=unit.holder_user_id,
        holder_name=users.get(unit.holder_user_id or -1),
        booked_from=unit.booked_from,
        booked_until=unit.booked_until,
        is_overdue=bool(
            unit.status == machines.STATUS_OUT
            and unit.booked_until is not None
            and unit.booked_until < moment
        ),
        inspection_required=unit.inspection_required,
        inspection_interval_days=unit.inspection_interval_days,
        last_inspected_at=unit.last_inspected_at,
        next_inspection_due_at=unit.next_inspection_due_at,
        inspection_overdue=bool(
            unit.inspection_required
            and unit.next_inspection_due_at is not None
            and unit.next_inspection_due_at < moment
        ),
        purchased_at=unit.purchased_at,
        notes=unit.notes,
        is_archived=unit.is_archived,
        created_at=unit.created_at,
        components=[
            MachineComponentOut(
                id=child.id,
                unit_number=child.unit_number,
                article_id=child.article_id,
                article_name=(
                    component_articles[child.article_id].item_name
                    if child.article_id in component_articles
                    else None
                ),
                status=child.status,
                serial_number=child.serial_number,
                next_inspection_due_at=child.next_inspection_due_at,
            )
            for child in (components or [])
        ],
    )


def machine_out_with_components(db: Session, unit: WerkstattArticleUnit) -> MachineOut:
    """`machine_out` with the unit's components hydrated.

    What a scan should return: somebody pointing a phone at a drill needs to be
    told the battery and charger are going with it *before* they confirm.
    """
    components = machines.child_units(db, unit.id)
    locations, users = name_maps(db)
    wanted = {unit.article_id} | {c.article_id for c in components}
    articles = {
        a.id: a
        for a in db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id.in_(wanted or {-1}))
        ).all()
    }
    return machine_out(
        unit,
        article=articles.get(unit.article_id),
        locations=locations,
        users=users,
        components=components,
        component_articles=articles,
    )
