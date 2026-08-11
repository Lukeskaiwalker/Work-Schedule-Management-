"""Booking, returning and inspecting individually tracked machines.

Every state change here writes a row to `werkstatt_movements`. The unit columns
(`status`, `holder_user_id`, `current_location_id`) are a denormalised snapshot
of the latest movement, exactly as the article stock counters are a snapshot of
their ledger — the same pattern the Werkstatt already uses, so "who had it last"
survives even if a snapshot is ever corrected by hand.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.time import utcnow
from app.models.entities import (
    User,
    WerkstattArticle,
    WerkstattArticleUnit,
    WerkstattMovement,
)
from app.services.werkstatt_unit_numbers import next_unit_number

STATUS_AVAILABLE = "verfuegbar"
STATUS_OUT = "ausgegeben"
STATUS_SERVICE = "wartung"
STATUS_BROKEN = "defekt"
STATUS_RETIRED = "ausgemustert"

VALID_STATUSES = {
    STATUS_AVAILABLE,
    STATUS_OUT,
    STATUS_SERVICE,
    STATUS_BROKEN,
    STATUS_RETIRED,
}

# A machine that is out, in service or scrapped cannot be handed to someone
# else. Booking one of those is a mistake worth refusing rather than silently
# overwriting whoever currently has it.
BOOKABLE_STATUSES = {STATUS_AVAILABLE}


def _app_timezone() -> ZoneInfo:
    """The workshop's timezone. Same helper as time_tracking / daily_clock_summary."""
    name = (get_settings().app_timezone or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _end_of_day(moment: datetime) -> datetime:
    """End of the workshop's LOCAL day, returned as naive UTC.

    The scanner's default booking is "for today", and the honest end of today is
    the end of the day — not now plus 24 hours, which would leave a machine
    looking legitimately booked halfway through the next morning.

    The local part is not pedantry. Every timestamp in this app is stored as
    naive UTC and rendered in the browser's timezone, so a plain 23:59 UTC would
    reach a German screen as "01:59 tomorrow" — a return time nobody agreed to,
    on a date that is not today, sitting next to the words "für heute".
    """
    tz = _app_timezone()
    local = moment.replace(tzinfo=timezone.utc).astimezone(tz)
    end_local = local.replace(hour=23, minute=59, second=59, microsecond=0)
    return end_local.astimezone(timezone.utc).replace(tzinfo=None)


def child_units(db: Session, unit_id: int) -> list[WerkstattArticleUnit]:
    """Live sub-components of a machine (its charger, batteries, case)."""
    return list(
        db.scalars(
            select(WerkstattArticleUnit).where(
                WerkstattArticleUnit.parent_unit_id == unit_id,
                WerkstattArticleUnit.is_archived.is_(False),
            )
        ).all()
    )


def create_unit(
    db: Session,
    *,
    article: WerkstattArticle,
    actor: User,
    serial_number: str | None = None,
    parent_unit_id: int | None = None,
    current_location_id: int | None = None,
    inspection_required: bool | None = None,
    inspection_interval_days: int | None = None,
    last_inspected_at: datetime | None = None,
    purchased_at: datetime | None = None,
    notes: str | None = None,
) -> WerkstattArticleUnit:
    """Register one physical machine against a catalogue article.

    Inspection settings fall back to the article's, so adding the fourth
    identical drill does not mean re-entering that this model needs a DGUV3
    check every 12 months. Once set they are the unit's own — see the model.
    """
    required = (
        article.bg_inspection_required if inspection_required is None else inspection_required
    )
    interval = (
        article.bg_inspection_interval_days
        if inspection_interval_days is None
        else inspection_interval_days
    )

    unit = WerkstattArticleUnit(
        unit_number=next_unit_number(db),
        article_id=article.id,
        parent_unit_id=parent_unit_id,
        serial_number=(serial_number or None),
        status=STATUS_AVAILABLE,
        current_location_id=current_location_id,
        inspection_required=bool(required),
        inspection_interval_days=interval,
        last_inspected_at=last_inspected_at,
        next_inspection_due_at=(
            last_inspected_at + timedelta(days=interval)
            if required and interval and last_inspected_at
            else None
        ),
        purchased_at=purchased_at,
        notes=notes,
        created_by=actor.id,
    )
    db.add(unit)
    db.flush()

    # The article's serialized flag is derived from reality rather than being a
    # separate thing to remember: the moment a machine exists for an article,
    # that article is serialized.
    if not article.is_serialized:
        article.is_serialized = True

    return unit


def _record(
    db: Session,
    *,
    unit: WerkstattArticleUnit,
    movement_type: str,
    actor: User,
    from_location_id: int | None,
    to_location_id: int | None,
    assignee_user_id: int | None,
    expected_return_at: datetime | None,
    notes: str | None,
) -> WerkstattMovement:
    movement = WerkstattMovement(
        article_id=unit.article_id,
        unit_id=unit.id,
        movement_type=movement_type,
        # Always 1: a unit is one machine. The column stays for the fungible
        # rows that share this table.
        quantity=1,
        from_location_id=from_location_id,
        to_location_id=to_location_id,
        user_id=actor.id,
        assignee_user_id=assignee_user_id,
        expected_return_at=expected_return_at,
        notes=notes,
    )
    db.add(movement)
    return movement


def book_unit(
    db: Session,
    *,
    unit: WerkstattArticleUnit,
    actor: User,
    holder_user_id: int | None = None,
    to_location_id: int | None = None,
    booked_from: datetime | None = None,
    booked_until: datetime | None = None,
    for_today: bool = False,
    notes: str | None = None,
    cascade: bool = True,
) -> list[WerkstattArticleUnit]:
    """Hand a machine to a person or a vehicle, and its sub-components with it.

    Returns every unit whose state changed, the parent first.

    Cascading is not a convenience — it is what makes the record true. The
    charger physically leaves in the same van as the drill, so leaving it marked
    "in the workshop" would produce an inventory that disagrees with the shelf.
    """
    if unit.status not in BOOKABLE_STATUSES:
        raise ValueError(f"unit_not_bookable:{unit.status}")
    if holder_user_id is None and to_location_id is None:
        raise ValueError("booking_target_required")

    start = booked_from or utcnow()
    end = booked_until
    if end is None and for_today:
        end = _end_of_day(start)
    if end is not None and end <= start:
        raise ValueError("booking_window_invalid")

    changed: list[WerkstattArticleUnit] = []
    targets = [unit] + (child_units(db, unit.id) if cascade else [])

    for target in targets:
        # A sub-component that is already out on its own booking is left alone
        # rather than silently reassigned — someone else is relying on it.
        if target is not unit and target.status not in BOOKABLE_STATUSES:
            continue

        _record(
            db,
            unit=target,
            movement_type="checkout",
            actor=actor,
            from_location_id=target.current_location_id,
            to_location_id=to_location_id,
            assignee_user_id=holder_user_id,
            expected_return_at=end,
            notes=notes,
        )
        target.status = STATUS_OUT
        target.holder_user_id = holder_user_id
        target.current_location_id = to_location_id or target.current_location_id
        target.booked_from = start
        target.booked_until = end
        changed.append(target)

    db.flush()
    return changed


def return_unit(
    db: Session,
    *,
    unit: WerkstattArticleUnit,
    actor: User,
    to_location_id: int | None = None,
    status: str = STATUS_AVAILABLE,
    notes: str | None = None,
    cascade: bool = True,
) -> list[WerkstattArticleUnit]:
    """Book a machine (and its sub-components) back in."""
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid_status:{status}")

    changed: list[WerkstattArticleUnit] = []
    targets = [unit] + (child_units(db, unit.id) if cascade else [])

    for target in targets:
        # Returning a parent must not resurrect a child that was never out.
        if target is not unit and target.status != STATUS_OUT:
            continue

        _record(
            db,
            unit=target,
            movement_type="return",
            actor=actor,
            from_location_id=target.current_location_id,
            to_location_id=to_location_id,
            assignee_user_id=target.holder_user_id,
            expected_return_at=None,
            notes=notes,
        )
        target.status = status
        target.holder_user_id = None
        target.current_location_id = to_location_id or target.current_location_id
        target.booked_from = None
        target.booked_until = None
        changed.append(target)

    db.flush()
    return changed


def record_inspection(
    db: Session,
    *,
    unit: WerkstattArticleUnit,
    actor: User,
    inspected_at: datetime | None = None,
    interval_days: int | None = None,
    passed: bool = True,
    notes: str | None = None,
) -> WerkstattArticleUnit:
    """Record a DGUV3 / BG-Prüfung against one machine.

    A failed check sends the machine to `defekt` rather than merely noting it:
    the point of the inspection is to stop the tool being used, and a status the
    booking path already refuses is the only version of that which holds.
    """
    moment = inspected_at or utcnow()
    if interval_days is not None:
        unit.inspection_interval_days = interval_days
    unit.inspection_required = True
    unit.last_inspected_at = moment

    interval = unit.inspection_interval_days
    unit.next_inspection_due_at = moment + timedelta(days=interval) if interval else None

    if not passed:
        unit.status = STATUS_BROKEN
        unit.next_inspection_due_at = moment

    _record(
        db,
        unit=unit,
        movement_type="correction",
        actor=actor,
        from_location_id=unit.current_location_id,
        to_location_id=unit.current_location_id,
        assignee_user_id=None,
        expected_return_at=None,
        notes=notes or ("DGUV3 bestanden" if passed else "DGUV3 nicht bestanden"),
    )
    db.flush()
    return unit


def unit_history(db: Session, unit_id: int, limit: int = 100) -> list[WerkstattMovement]:
    """Custody log for one machine, newest first."""
    return list(
        db.scalars(
            select(WerkstattMovement)
            .where(WerkstattMovement.unit_id == unit_id)
            .order_by(WerkstattMovement.created_at.desc(), WerkstattMovement.id.desc())
            .limit(limit)
        ).all()
    )
