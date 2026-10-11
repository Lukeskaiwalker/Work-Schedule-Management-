"""Partner hours: the rules and the read side, shared by portal and office.

A row is one day of one crew (``workers`` people, ``hours`` each). The portal
shows a partner their own company's rows only; the office sees every
partner's. Writing happens in ``routers/portal_hours.py`` (partners) and
``routers/workflow_partner_hours.py`` (the office may remove).
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.entities import Partner, PartnerTimeEntry, Task, User
from app.schemas.portal import (
    PartnerHoursOut,
    PartnerHoursTaskRef,
    PortalHoursOut,
    ProjectPartnerSummary,
)

#: A partner may take back their own report for this long; after that the
#: office has probably checked it against an invoice, and changes go through
#: the office.
PARTNER_DELETE_WINDOW = timedelta(days=7)
#: How far back a day may be reported (catches a typed "2002").
OLDEST_WORK_DAY = timedelta(days=365)
#: "Today" on a phone in Germany can be tomorrow on a UTC server clock.
FUTURE_TOLERANCE = timedelta(days=1)
#: Reports one company may file in 24 hours. A crew files a handful a day;
#: the cap is there so a stolen (internet-facing) login cannot flood the
#: office with rows — the per-IP rate limit alone would allow thousands.
MAX_REPORTS_PER_DAY = 100


def work_date_problem(work_date: date, today: date) -> str | None:
    if work_date > today + FUTURE_TOLERANCE:
        return "The work date lies in the future"
    if work_date < today - OLDEST_WORK_DAY:
        return "The work date is more than a year ago"
    return None


def reports_in_last_day(db: Session, partner_id: int, now: datetime) -> int:
    """Every report filed in 24 hours — taken-back ones included, or
    report-and-withdraw would never reach the cap."""
    return int(
        db.scalar(
            select(func.count(PartnerTimeEntry.id)).where(
                PartnerTimeEntry.partner_id == partner_id,
                PartnerTimeEntry.created_at >= now - timedelta(days=1),
            )
        )
        or 0
    )


def live_entries_on_task(db: Session, task_id: int) -> int:
    return int(
        db.scalar(
            select(func.count(PartnerTimeEntry.id)).where(
                PartnerTimeEntry.task_id == task_id, PartnerTimeEntry.deleted_at.is_(None)
            )
        )
        or 0
    )


def live_entry_or_none(db: Session, entry_id: int) -> PartnerTimeEntry | None:
    entry = db.get(PartnerTimeEntry, entry_id)
    return entry if entry is not None and entry.deleted_at is None else None


def entry_total(entry: PartnerTimeEntry) -> float:
    return round(float(entry.workers) * float(entry.hours), 2)


def hours_total(entries: Iterable[PartnerTimeEntry]) -> float:
    return round(sum(entry_total(entry) for entry in entries), 2)


def partner_can_delete(entry: PartnerTimeEntry, partner_id: int, now: datetime) -> bool:
    """Their own company's report, for a week. Deliberately not tied to still
    seeing the task: the report is theirs even after the office moved the job."""
    return (
        entry.deleted_at is None
        and entry.partner_id == partner_id
        and now - entry.created_at <= PARTNER_DELETE_WINDOW
    )


def _ordered(query):
    return query.order_by(
        PartnerTimeEntry.work_date.desc(),
        PartnerTimeEntry.created_at.desc(),
        PartnerTimeEntry.id.desc(),
    )


def entries_for_task(db: Session, task_id: int, *, partner_id: int | None = None) -> list[PartnerTimeEntry]:
    query = select(PartnerTimeEntry).where(
        PartnerTimeEntry.task_id == task_id, PartnerTimeEntry.deleted_at.is_(None)
    )
    if partner_id is not None:
        query = query.where(PartnerTimeEntry.partner_id == partner_id)
    return list(db.scalars(_ordered(query)).all())


def entries_for_project(db: Session, project_id: int, *, partner_id: int | None = None) -> list[PartnerTimeEntry]:
    query = select(PartnerTimeEntry).where(
        PartnerTimeEntry.project_id == project_id, PartnerTimeEntry.deleted_at.is_(None)
    )
    if partner_id is not None:
        query = query.where(PartnerTimeEntry.partner_id == partner_id)
    return list(db.scalars(_ordered(query)).all())


def totals_by_partner(db: Session, project_id: int) -> dict[int, float]:
    rows = db.execute(
        select(
            PartnerTimeEntry.partner_id,
            func.sum(PartnerTimeEntry.workers * PartnerTimeEntry.hours),
        )
        .where(PartnerTimeEntry.project_id == project_id, PartnerTimeEntry.deleted_at.is_(None))
        .group_by(PartnerTimeEntry.partner_id)
    ).all()
    return {int(partner_id): round(float(total or 0), 2) for partner_id, total in rows}


def _lookups(db: Session, entries: list[PartnerTimeEntry]) -> tuple[dict[int, Task], dict[int, User]]:
    task_ids = {e.task_id for e in entries if e.task_id is not None}
    user_ids = {e.reported_by for e in entries if e.reported_by is not None}
    tasks = {t.id: t for t in db.scalars(select(Task).where(Task.id.in_(task_ids))).all()} if task_ids else {}
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(user_ids))).all()} if user_ids else {}
    return tasks, users


def _task_ref(tasks: dict[int, Task], task_id: int | None) -> PartnerHoursTaskRef | None:
    task = tasks.get(task_id) if task_id is not None else None
    return PartnerHoursTaskRef(id=task.id, title=task.title) if task else None


def _reporter(users: dict[int, User], user_id: int | None) -> str | None:
    user = users.get(user_id) if user_id is not None else None
    return user.display_name if user else None


def portal_entries_out(
    db: Session, entries: list[PartnerTimeEntry], *, partner_id: int, now: datetime
) -> list[PortalHoursOut]:
    """A partner's own rows. Callers pass rows already narrowed to the partner;
    the filter here is the second lock on that door."""
    own = [entry for entry in entries if entry.partner_id == partner_id]
    tasks, users = _lookups(db, own)
    return [
        PortalHoursOut(
            id=entry.id,
            work_date=entry.work_date,
            workers=entry.workers,
            hours=float(entry.hours),
            total_hours=entry_total(entry),
            note=entry.note,
            task=_task_ref(tasks, entry.task_id),
            reported_by=_reporter(users, entry.reported_by),
            created_at=entry.created_at,
            can_delete=partner_can_delete(entry, partner_id, now),
        )
        for entry in own
    ]


def office_entries_out(db: Session, entries: list[PartnerTimeEntry]) -> list[PartnerHoursOut]:
    tasks, users = _lookups(db, entries)
    partner_ids = {e.partner_id for e in entries}
    partners = {p.id: p for p in db.scalars(select(Partner).where(Partner.id.in_(partner_ids))).all()} if partner_ids else {}
    out: list[PartnerHoursOut] = []
    for entry in entries:
        partner = partners.get(entry.partner_id)
        if partner is None:
            continue
        out.append(
            PartnerHoursOut(
                id=entry.id,
                partner=ProjectPartnerSummary(
                    id=partner.id, name=partner.name, trade=partner.trade, archived_at=partner.archived_at
                ),
                project_id=entry.project_id,
                task=_task_ref(tasks, entry.task_id),
                work_date=entry.work_date,
                workers=entry.workers,
                hours=float(entry.hours),
                total_hours=entry_total(entry),
                note=entry.note,
                reported_by=_reporter(users, entry.reported_by),
                created_at=entry.created_at,
            )
        )
    return out


def _hours_text(value: float) -> str:
    text = f"{value:.2f}".rstrip("0").rstrip(".")
    return text.replace(".", ",")


def activity_message(entry: PartnerTimeEntry, partner_name: str, *, removed: bool = False) -> str:
    """``Stunden gemeldet: 2 × 7,5 Std = 15 Std am 09.10.2026 (Bedachungen …)``."""
    head = "Stundenmeldung entfernt" if removed else "Stunden gemeldet"
    amount = (
        f"{entry.workers} × {_hours_text(entry.hours)} Std = {_hours_text(entry_total(entry))} Std"
        if entry.workers != 1
        else f"{_hours_text(entry.hours)} Std"
    )
    return f"{head}: {amount} am {entry.work_date:%d.%m.%Y} ({partner_name})"
