from __future__ import annotations
import csv
from datetime import date, datetime, time, timedelta, timezone
from io import StringIO
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.time import utcnow
from app.models.entities import BreakEntry, ClockEntry, SchoolAbsence, User, VacationRequest
from app.schemas.api import (
    RequiredDailyHoursOut,
    RequiredDailyHoursUpdate,
    SchoolAbsenceCreate,
    SchoolAbsenceOut,
    TimeCurrentOut,
    TimeEntryOut,
    TimeEntryUpdate,
    TimesheetOut,
    VacationRequestCreate,
    VacationRequestOut,
    VacationRequestReview,
)

router = APIRouter(prefix="/time", tags=["time-tracking"])


def _week_bounds(day: date) -> tuple[date, date]:
    start = day - timedelta(days=day.weekday())
    end = start + timedelta(days=6)
    return start, end


def _app_timezone() -> ZoneInfo:
    timezone_name = (get_settings().app_timezone or "UTC").strip() or "UTC"
    try:
        return ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError:
        return ZoneInfo("UTC")


def _local_date_from_utc(utc_naive: datetime) -> date:
    return utc_naive.replace(tzinfo=timezone.utc).astimezone(_app_timezone()).date()


def _local_period_bounds_utc(start_day: date, end_day: date) -> tuple[datetime, datetime]:
    app_tz = _app_timezone()
    start_local = datetime.combine(start_day, time.min, tzinfo=app_tz)
    end_local = datetime.combine(end_day, time.max, tzinfo=app_tz)
    start_utc = start_local.astimezone(timezone.utc).replace(tzinfo=None)
    end_utc = end_local.astimezone(timezone.utc).replace(tzinfo=None)
    return start_utc, end_utc


def _hours_between(start: datetime, end: datetime | None) -> float:
    if not end:
        return 0.0
    return max((end - start).total_seconds(), 0) / 3600.0


def _required_break_hours(worked_hours: float) -> float:
    # German ArbZG baseline: >6h => 30m, >9h => 45m.
    if worked_hours > 9:
        return 0.75
    if worked_hours > 6:
        return 0.5
    return 0.0


def _break_hours(db: Session, clock_entry_id: int, now: datetime | None = None) -> float:
    breaks = db.scalars(select(BreakEntry).where(BreakEntry.clock_entry_id == clock_entry_id)).all()
    total = 0.0
    for br in breaks:
        total += _hours_between(br.break_start, br.break_end or now)
    return total


def _overlap_hours(start: datetime, end: datetime | None, range_start: datetime, range_end: datetime) -> float:
    if not end:
        return 0.0
    overlap_start = max(start, range_start)
    overlap_end = min(end, range_end)
    if overlap_end <= overlap_start:
        return 0.0
    return (overlap_end - overlap_start).total_seconds() / 3600.0


def _break_hours_for_period(
    db: Session,
    clock_entry_id: int,
    period_start: datetime,
    period_end: datetime,
    now: datetime | None = None,
) -> float:
    breaks = db.scalars(select(BreakEntry).where(BreakEntry.clock_entry_id == clock_entry_id)).all()
    total = 0.0
    for br in breaks:
        total += _overlap_hours(br.break_start, br.break_end or now, period_start, period_end)
    return total


def _entry_metrics_for_period(
    db: Session,
    entry: ClockEntry,
    period_start: datetime,
    period_end: datetime,
    now: datetime | None = None,
) -> dict[str, float]:
    end = entry.clock_out or now
    worked_hours = _overlap_hours(entry.clock_in, end, period_start, period_end)
    break_hours = _break_hours_for_period(db, entry.id, period_start, period_end, now=now)
    required_break_hours = _required_break_hours(worked_hours)
    deducted_break_hours = max(break_hours, required_break_hours)
    return {
        "worked_hours": round(worked_hours, 2),
        "break_hours": round(break_hours, 2),
        "required_break_hours": round(required_break_hours, 2),
        "deducted_break_hours": round(deducted_break_hours, 2),
        "net_hours": round(max(worked_hours - deducted_break_hours, 0), 2),
    }


def _entries_overlapping_period(
    db: Session,
    user_id: int,
    period_start: datetime,
    period_end: datetime,
) -> list[ClockEntry]:
    return list(
        db.scalars(
            select(ClockEntry).where(
                ClockEntry.user_id == user_id,
                ClockEntry.clock_in <= period_end,
                or_(ClockEntry.clock_out.is_(None), ClockEntry.clock_out >= period_start),
            )
        ).all()
    )


def _is_time_manager(user: User) -> bool:
    return user.role in {"admin", "ceo", "accountant", "planning"}


def _is_required_hours_manager(user: User) -> bool:
    return user.role in {"admin", "ceo"}


def _is_vacation_reviewer(user: User) -> bool:
    return user.role in {"admin", "ceo"}


def _is_school_manager(user: User) -> bool:
    return user.role in {"admin", "ceo", "accountant"}


def _resolve_target_user_id(current_user: User, user_id: int | None) -> int:
    if user_id is None or user_id == current_user.id:
        return current_user.id
    if not _is_time_manager(current_user):
        raise HTTPException(status_code=403, detail="Not allowed")
    return user_id


def _vacation_request_out(db: Session, request_row: VacationRequest) -> VacationRequestOut:
    request_user = db.get(User, request_row.user_id)
    return VacationRequestOut(
        id=request_row.id,
        user_id=request_row.user_id,
        user_name=request_user.display_name if request_user else f"#{request_row.user_id}",
        start_date=request_row.start_date,
        end_date=request_row.end_date,
        note=request_row.note,
        status=request_row.status,
        reviewed_by=request_row.reviewed_by,
        reviewed_at=request_row.reviewed_at,
        created_at=request_row.created_at,
    )


def _school_absence_out(db: Session, row: SchoolAbsence) -> SchoolAbsenceOut:
    target_user = db.get(User, row.user_id)
    return SchoolAbsenceOut(
        id=row.id,
        user_id=row.user_id,
        user_name=target_user.display_name if target_user else f"#{row.user_id}",
        title=row.title,
        start_date=row.start_date,
        end_date=row.end_date,
        recurrence_weekday=row.recurrence_weekday,
        recurrence_until=row.recurrence_until,
        created_by=row.created_by,
        created_at=row.created_at,
    )


def _get_open_entry(db: Session, user_id: int) -> ClockEntry | None:
    return db.scalars(
        select(ClockEntry).where(ClockEntry.user_id == user_id, ClockEntry.clock_out.is_(None)).order_by(ClockEntry.id.desc())
    ).first()


def _entry_metrics(db: Session, entry: ClockEntry, now: datetime | None = None) -> dict[str, float]:
    end = entry.clock_out or now
    worked_hours = _hours_between(entry.clock_in, end)
    break_hours = _break_hours(db, entry.id, now=now)
    required_break_hours = _required_break_hours(worked_hours)
    deducted_break_hours = max(break_hours, required_break_hours)
    return {
        "worked_hours": round(worked_hours, 2),
        "break_hours": round(break_hours, 2),
        "required_break_hours": round(required_break_hours, 2),
        "deducted_break_hours": round(deducted_break_hours, 2),
        "net_hours": round(max(worked_hours - deducted_break_hours, 0), 2),
    }


def _entry_out(db: Session, entry: ClockEntry, now: datetime | None = None) -> TimeEntryOut:
    metrics = _entry_metrics(db, entry, now=now)
    return TimeEntryOut(
        id=entry.id,
        user_id=entry.user_id,
        clock_in=entry.clock_in,
        clock_out=entry.clock_out,
        is_open=entry.clock_out is None,
        break_hours=metrics["break_hours"],
        required_break_hours=metrics["required_break_hours"],
        deducted_break_hours=metrics["deducted_break_hours"],
        net_hours=metrics["net_hours"],
    )


def _sanitized_required_daily_hours(user: User) -> float:
    return round(max(float(user.required_daily_hours or 8.0), 1.0), 2)


@router.post("/clock-in")
def clock_in(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    open_entry = _get_open_entry(db, current_user.id)
    if open_entry:
        raise HTTPException(status_code=400, detail="Already clocked in")

    entry = ClockEntry(user_id=current_user.id)
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"clock_entry_id": entry.id, "clock_in": entry.clock_in}


@router.post("/clock-out")
def clock_out(
    clock_entry_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    entry = db.get(ClockEntry, clock_entry_id) if clock_entry_id else _get_open_entry(db, current_user.id)
    if not entry or entry.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Clock entry not found or no open shift")
    if entry.clock_out is not None:
        raise HTTPException(status_code=400, detail="Already clocked out")

    now = utcnow()
    open_break = db.scalars(
        select(BreakEntry).where(BreakEntry.clock_entry_id == entry.id, BreakEntry.break_end.is_(None))
    ).first()
    if open_break:
        open_break.break_end = now

    entry.clock_out = now
    db.add(entry)
    db.commit()
    db.refresh(entry)
    metrics = _entry_metrics(db, entry)
    return {
        "clock_entry_id": entry.id,
        "clock_out": entry.clock_out,
        "worked_hours": metrics["worked_hours"],
        "break_hours": metrics["break_hours"],
        "required_break_hours": metrics["required_break_hours"],
        "deducted_break_hours": metrics["deducted_break_hours"],
        "net_hours": metrics["net_hours"],
    }


@router.post("/{clock_entry_id}/break-start")
def break_start(clock_entry_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    entry = db.get(ClockEntry, clock_entry_id)
    if not entry or entry.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Clock entry not found")
    if entry.clock_out is not None:
        raise HTTPException(status_code=400, detail="Shift already closed")

    existing = db.scalars(
        select(BreakEntry).where(BreakEntry.clock_entry_id == clock_entry_id, BreakEntry.break_end.is_(None))
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Break already open")

    br = BreakEntry(clock_entry_id=clock_entry_id)
    db.add(br)
    db.commit()
    db.refresh(br)
    return {"break_id": br.id, "break_start": br.break_start}


@router.post("/break-start")
def break_start_open(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    entry = _get_open_entry(db, current_user.id)
    if not entry:
        raise HTTPException(status_code=400, detail="No open shift")
    return break_start(entry.id, current_user=current_user, db=db)


@router.post("/{clock_entry_id}/break-end")
def break_end(clock_entry_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    entry = db.get(ClockEntry, clock_entry_id)
    if not entry or entry.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Clock entry not found")

    br = db.scalars(
        select(BreakEntry).where(BreakEntry.clock_entry_id == clock_entry_id, BreakEntry.break_end.is_(None))
    ).first()
    if not br:
        raise HTTPException(status_code=400, detail="No open break")

    br.break_end = utcnow()
    db.add(br)
    db.commit()
    db.refresh(br)
    return {"break_id": br.id, "break_end": br.break_end}


@router.post("/break-end")
def break_end_open(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    entry = _get_open_entry(db, current_user.id)
    if not entry:
        raise HTTPException(status_code=400, detail="No open shift")
    return break_end(entry.id, current_user=current_user, db=db)


@router.get("/current", response_model=TimeCurrentOut)
def current_status(
    user_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    target_user_id = _resolve_target_user_id(current_user, user_id)
    target_user = db.get(User, target_user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    now = utcnow()
    required_daily_hours = _sanitized_required_daily_hours(target_user)

    local_today = _local_date_from_utc(now)
    start_dt, end_dt = _local_period_bounds_utc(local_today, local_today)
    day_entries = _entries_overlapping_period(db, target_user_id, start_dt, end_dt)
    daily_net_hours = round(
        sum(_entry_metrics_for_period(db, day_entry, start_dt, end_dt, now=now)["net_hours"] for day_entry in day_entries),
        2,
    )
    progress_percent = round((daily_net_hours / required_daily_hours) * 100, 2) if required_daily_hours > 0 else 0.0

    entry = _get_open_entry(db, target_user_id)
    if not entry:
        return TimeCurrentOut(
            server_time=now,
            required_daily_hours=required_daily_hours,
            daily_net_hours=daily_net_hours,
            progress_percent_live=progress_percent,
        )

    metrics = _entry_metrics(db, entry, now=now)
    open_break = db.scalars(
        select(BreakEntry).where(BreakEntry.clock_entry_id == entry.id, BreakEntry.break_end.is_(None))
    ).first()
    return TimeCurrentOut(
        server_time=now,
        clock_entry_id=entry.id,
        clock_in=entry.clock_in,
        break_open=open_break is not None,
        worked_hours_live=metrics["worked_hours"],
        break_hours_live=metrics["break_hours"],
        required_break_hours_live=metrics["required_break_hours"],
        deducted_break_hours_live=metrics["deducted_break_hours"],
        net_hours_live=metrics["net_hours"],
        required_daily_hours=required_daily_hours,
        daily_net_hours=daily_net_hours,
        progress_percent_live=progress_percent,
    )


@router.patch("/required-hours/{user_id}", response_model=RequiredDailyHoursOut)
def set_required_daily_hours(
    user_id: int,
    payload: RequiredDailyHoursUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _is_required_hours_manager(current_user):
        raise HTTPException(status_code=403, detail="Not allowed")

    target_user = db.get(User, user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    target_user.required_daily_hours = round(payload.required_daily_hours, 2)
    db.add(target_user)
    db.commit()
    db.refresh(target_user)
    return RequiredDailyHoursOut(
        user_id=target_user.id,
        required_daily_hours=target_user.required_daily_hours,
    )


@router.post("/vacation-requests", response_model=VacationRequestOut)
def create_vacation_request(
    payload: VacationRequestCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")
    row = VacationRequest(
        user_id=current_user.id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        note=(payload.note or "").strip() or None,
        status="pending",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _vacation_request_out(db, row)


@router.get("/vacation-requests", response_model=list[VacationRequestOut])
def list_vacation_requests(
    status: str | None = None,
    user_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    target_user_id = user_id
    if not _is_time_manager(current_user):
        target_user_id = current_user.id
    stmt = select(VacationRequest)
    if status:
        stmt = stmt.where(VacationRequest.status == status.strip().lower())
    if target_user_id:
        stmt = stmt.where(VacationRequest.user_id == target_user_id)
    rows = db.scalars(stmt.order_by(VacationRequest.created_at.desc(), VacationRequest.id.desc())).all()
    return [_vacation_request_out(db, row) for row in rows]


@router.patch("/vacation-requests/{request_id}", response_model=VacationRequestOut)
def review_vacation_request(
    request_id: int,
    payload: VacationRequestReview,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _is_vacation_reviewer(current_user):
        raise HTTPException(status_code=403, detail="Not allowed")
    row = db.get(VacationRequest, request_id)
    if not row:
        raise HTTPException(status_code=404, detail="Vacation request not found")
    next_status = payload.status.strip().lower()
    if next_status not in {"approved", "rejected"}:
        raise HTTPException(status_code=400, detail="Invalid status")
    row.status = next_status
    row.reviewed_by = current_user.id
    row.reviewed_at = utcnow()
    db.add(row)
    db.commit()
    db.refresh(row)
    return _vacation_request_out(db, row)


@router.get("/school-absences", response_model=list[SchoolAbsenceOut])
def list_school_absences(
    user_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    target_user_id = user_id
    if not _is_time_manager(current_user):
        target_user_id = current_user.id
    stmt = select(SchoolAbsence)
    if target_user_id:
        stmt = stmt.where(SchoolAbsence.user_id == target_user_id)
    rows = db.scalars(stmt.order_by(SchoolAbsence.start_date.desc(), SchoolAbsence.id.desc())).all()
    return [_school_absence_out(db, row) for row in rows]


@router.post("/school-absences", response_model=SchoolAbsenceOut)
def create_school_absence(
    payload: SchoolAbsenceCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _is_school_manager(current_user):
        raise HTTPException(status_code=403, detail="Not allowed")
    target_user = db.get(User, payload.user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="end_date must be on or after start_date")
    if payload.recurrence_weekday is not None and payload.recurrence_until and payload.recurrence_until < payload.start_date:
        raise HTTPException(status_code=400, detail="recurrence_until must be on or after start_date")
    if payload.recurrence_weekday is not None and payload.end_date != payload.start_date:
        raise HTTPException(
            status_code=400,
            detail="For recurring school days use a single-day start/end date and recurrence_until",
        )
    row = SchoolAbsence(
        user_id=payload.user_id,
        title=payload.title.strip(),
        start_date=payload.start_date,
        end_date=payload.end_date,
        recurrence_weekday=payload.recurrence_weekday,
        recurrence_until=payload.recurrence_until,
        created_by=current_user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _school_absence_out(db, row)


@router.delete("/school-absences/{absence_id}")
def delete_school_absence(
    absence_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not _is_school_manager(current_user):
        raise HTTPException(status_code=403, detail="Not allowed")
    row = db.get(SchoolAbsence, absence_id)
    if not row:
        raise HTTPException(status_code=404, detail="School absence not found")
    db.delete(row)
    db.commit()
    return {"ok": True}


@router.get("/timesheet", response_model=TimesheetOut)
def timesheet(
    period: str = "weekly",
    day: date | None = None,
    user_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    now = utcnow()
    target_day = day or _local_date_from_utc(now)
    target_user_id = _resolve_target_user_id(current_user, user_id)

    if period not in {"daily", "weekly"}:
        raise HTTPException(status_code=400, detail="Invalid period")

    if period == "daily":
        start_date = target_day
        end_date = target_day
    else:
        start_date, end_date = _week_bounds(target_day)

    start_dt, end_dt = _local_period_bounds_utc(start_date, end_date)

    entries = _entries_overlapping_period(db, target_user_id, start_dt, end_dt)

    total_hours = 0.0
    for entry in entries:
        total_hours += _entry_metrics_for_period(db, entry, start_dt, end_dt, now=now)["net_hours"]

    return TimesheetOut(
        user_id=target_user_id,
        total_hours=round(total_hours, 2),
        period_start=start_date,
        period_end=end_date,
    )


@router.get("/timesheet/export.csv")
def export_timesheet(
    day: date | None = None,
    user_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    target_day = day or _local_date_from_utc(utcnow())
    target_user_id = _resolve_target_user_id(current_user, user_id)

    week_start, week_end = _week_bounds(target_day)
    start_dt, end_dt = _local_period_bounds_utc(week_start, week_end)

    entries = _entries_overlapping_period(db, target_user_id, start_dt, end_dt)

    buffer = StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        [
            "clock_entry_id",
            "clock_in",
            "clock_out",
            "break_hours",
            "required_break_hours",
            "deducted_break_hours",
            "net_hours",
        ]
    )
    now = utcnow()
    for entry in entries:
        metrics = _entry_metrics_for_period(db, entry, start_dt, end_dt, now=now)
        writer.writerow(
            [
                entry.id,
                entry.clock_in.isoformat(),
                entry.clock_out.isoformat() if entry.clock_out else "",
                metrics["break_hours"],
                metrics["required_break_hours"],
                metrics["deducted_break_hours"],
                metrics["net_hours"],
            ]
        )

    headers = {
        "Content-Disposition": f"attachment; filename=timesheet-{target_user_id}-{week_start}.csv",
    }
    return Response(content=buffer.getvalue(), media_type="text/csv", headers=headers)


@router.get("/entries", response_model=list[TimeEntryOut])
def list_entries(
    period: str = "weekly",
    day: date | None = None,
    user_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    target_day = day or _local_date_from_utc(utcnow())
    target_user_id = _resolve_target_user_id(current_user, user_id)

    if period not in {"daily", "weekly"}:
        raise HTTPException(status_code=400, detail="Invalid period")

    if period == "daily":
        start_date = target_day
        end_date = target_day
    else:
        start_date, end_date = _week_bounds(target_day)

    start_dt, end_dt = _local_period_bounds_utc(start_date, end_date)
    entries = _entries_overlapping_period(db, target_user_id, start_dt, end_dt)
    entries.sort(key=lambda entry: entry.clock_in, reverse=True)
    now = utcnow()
    return [_entry_out(db, entry, now=now) for entry in entries]


@router.patch("/entries/{clock_entry_id}", response_model=TimeEntryOut)
def update_entry(
    clock_entry_id: int,
    payload: TimeEntryUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    entry = db.get(ClockEntry, clock_entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Clock entry not found")
    if entry.user_id != current_user.id and not _is_time_manager(current_user):
        raise HTTPException(status_code=403, detail="Not allowed")

    if payload.clock_out and payload.clock_out < payload.clock_in:
        raise HTTPException(status_code=400, detail="clock_out must be after clock_in")

    worked_minutes = _hours_between(payload.clock_in, payload.clock_out) * 60 if payload.clock_out else None
    if worked_minutes is not None and payload.break_minutes > worked_minutes:
        raise HTTPException(status_code=400, detail="break_minutes exceeds worked duration")

    entry.clock_in = payload.clock_in
    entry.clock_out = payload.clock_out
    db.add(entry)
    db.flush()

    existing_breaks = db.scalars(select(BreakEntry).where(BreakEntry.clock_entry_id == entry.id)).all()
    for existing in existing_breaks:
        db.delete(existing)

    if payload.break_minutes > 0:
        break_end = payload.clock_out or (payload.clock_in + timedelta(minutes=payload.break_minutes))
        break_start = break_end - timedelta(minutes=payload.break_minutes)
        if break_start < payload.clock_in:
            break_start = payload.clock_in
        db.add(BreakEntry(clock_entry_id=entry.id, break_start=break_start, break_end=break_end))

    db.commit()
    db.refresh(entry)
    return _entry_out(db, entry)
