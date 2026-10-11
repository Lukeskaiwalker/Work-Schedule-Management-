"""What left the Lager for a project without a Verteiler — the project
Material tab's ``source: "lager"`` rows.

A consumable taken at the Regal station, the desk or the phone for a project
is a ``consumption`` row with that ``project_id`` and no ``panel_id``
(``werkstatt_consumption.book_stock_consumption``); leftovers carried back
are ``consumption_undo`` in the same bucket. ``schaltplan_material
.project_panel_materials`` reads only rows joined to a board, so these were
invisible on the tab. Rows of a Verteiler (``panel_id``) and of a machine
unit (``unit_id``) are other buckets and never counted here.

``local_day`` is the date the tab shows for these rows and the Verteiler
rows: the workshop's day (``app_timezone``), not UTC's — a booking at 00:30
in Berlin is 22:30 the evening before in UTC.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import WerkstattArticle, WerkstattMovement
from app.services.werkstatt_consumption import CONSUMPTION, CONSUMPTION_UNDO


@dataclass(frozen=True)
class ProjectStockMaterial:
    article: WerkstattArticle
    # Pieces still consumed: consumption − consumption_undo, always > 0.
    net: int
    # How many times something was taken (the undo rows are not bookings).
    bookings: int
    last_at: datetime | None


def project_stock_materials(db: Session, project_id: int) -> list[ProjectStockMaterial]:
    """Net per article of the project's panel-less, unit-less consumption,
    by article name."""
    is_taken = WerkstattMovement.movement_type == CONSUMPTION
    net = func.sum(case((is_taken, WerkstattMovement.quantity), else_=-WerkstattMovement.quantity))
    rows = db.execute(
        select(
            WerkstattMovement.article_id,
            net.label("net"),
            func.sum(case((is_taken, 1), else_=0)).label("bookings"),
            func.max(WerkstattMovement.created_at).label("last_at"),
        )
        .where(
            WerkstattMovement.project_id == project_id,
            WerkstattMovement.panel_id.is_(None),
            WerkstattMovement.unit_id.is_(None),
            WerkstattMovement.movement_type.in_((CONSUMPTION, CONSUMPTION_UNDO)),
        )
        .group_by(WerkstattMovement.article_id)
        .having(net > 0)
    ).all()
    if not rows:
        return []
    articles = {
        article.id: article
        for article in db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id.in_([row.article_id for row in rows]))
        )
    }
    out = [
        ProjectStockMaterial(
            article=articles[row.article_id],
            net=int(row.net),
            bookings=int(row.bookings or 0),
            last_at=row.last_at,
        )
        for row in rows
        if row.article_id in articles
    ]
    out.sort(key=lambda row: (row.article.item_name.lower(), row.article.id))
    return out


def local_day(moment: datetime | None) -> date | None:
    """The workshop's calendar day of a stored timestamp (naive UTC, like
    every ``created_at``)."""
    if moment is None:
        return None
    return moment.replace(tzinfo=timezone.utc).astimezone(_workshop_zone()).date()


def _workshop_zone() -> ZoneInfo:
    name = (get_settings().app_timezone or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")
