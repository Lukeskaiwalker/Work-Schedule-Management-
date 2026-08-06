from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class ClockOut(BaseModel):
    clock_entry_id: int


class BreakAction(BaseModel):
    clock_entry_id: int


class TimesheetOut(BaseModel):
    user_id: int
    total_hours: float
    period_start: date
    period_end: date


class TimeCurrentOut(BaseModel):
    server_time: datetime
    clock_entry_id: int | None = None
    clock_in: datetime | None = None
    break_open: bool = False
    worked_hours_live: float = 0
    break_hours_live: float = 0
    required_break_hours_live: float = 0
    deducted_break_hours_live: float = 0
    net_hours_live: float = 0
    required_daily_hours: float = 8
    daily_net_hours: float = 0
    progress_percent_live: float = 0
    vacation_days_per_year: float = 0
    vacation_days_available: float = 0
    vacation_days_carryover: float = 0
    vacation_days_total_remaining: float = 0


class TimeEntryOut(BaseModel):
    id: int
    user_id: int
    user_name: str | None = None
    clock_in: datetime
    clock_out: datetime | None = None
    is_open: bool
    break_hours: float
    required_break_hours: float
    deducted_break_hours: float
    net_hours: float
    can_edit: bool = False


class TimeEntryUpdate(BaseModel):
    clock_in: datetime
    clock_out: datetime | None = None
    break_minutes: int = Field(default=0, ge=0, le=720)


class RequiredDailyHoursUpdate(BaseModel):
    required_daily_hours: float = Field(ge=1, le=24)


class RequiredDailyHoursOut(BaseModel):
    user_id: int
    required_daily_hours: float


class VacationBalanceUpdate(BaseModel):
    vacation_days_per_year: float = Field(ge=0, le=366)
    vacation_days_available: float = Field(ge=0, le=366)
    vacation_days_carryover: float = Field(ge=0, le=366)


class VacationBalanceOut(BaseModel):
    user_id: int
    vacation_days_per_year: float
    vacation_days_available: float
    vacation_days_carryover: float
    vacation_days_total_remaining: float


class VacationRequestCreate(BaseModel):
    start_date: date
    end_date: date
    note: str | None = None


class VacationRequestReview(BaseModel):
    status: str = Field(pattern="^(approved|rejected)$")


class VacationRequestOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    start_date: date
    end_date: date
    vacation_days_used: int = 0
    note: str | None = None
    status: str
    reviewed_by: int | None = None
    reviewed_at: datetime | None = None
    created_at: datetime


class SchoolAbsenceCreate(BaseModel):
    user_id: int
    title: str = Field(default="Berufsschule", min_length=1, max_length=255)
    absence_type: str = Field(default="other", min_length=1, max_length=64)
    counts_as_hours: bool = True
    start_date: date
    end_date: date
    recurrence_weekday: int | None = Field(default=None, ge=0, le=6)
    recurrence_until: date | None = None


class SchoolAbsenceUpdate(BaseModel):
    title: str = Field(default="Berufsschule", min_length=1, max_length=255)
    absence_type: str = Field(default="other", min_length=1, max_length=64)
    counts_as_hours: bool = True
    start_date: date
    end_date: date
    recurrence_weekday: int | None = Field(default=None, ge=0, le=6)
    recurrence_until: date | None = None


class SchoolAbsenceReview(BaseModel):
    status: str = Field(pattern="^(approved|rejected)$")


class SchoolAbsenceOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    title: str
    absence_type: str = "other"
    counts_as_hours: bool = True
    status: str = "approved"
    start_date: date
    end_date: date
    recurrence_weekday: int | None = None
    recurrence_until: date | None = None
    created_by: int | None = None
    reviewed_by: int | None = None
    reviewed_at: datetime | None = None
    created_at: datetime


class VacationDayRemovePayload(BaseModel):
    """Take one booked day back out of a person's vacation.

    Used when someone worked despite being booked off: the day leaves the
    vacation range and its entitlement returns to their balance.
    """

    user_id: int
    day: date


class VacationDayRemoveOut(BaseModel):
    user_id: int
    day: date
    refunded_days: int
    refunded_available_days: int
    refunded_carryover_days: int
    # False for a weekend or public holiday, which never cost entitlement.
    was_deductible: bool
    request_deleted: bool
    split_into_second_request: bool
    balance: VacationBalanceOut


class TimeEntryCreate(BaseModel):
    """Fill in a working day that was never clocked.

    ``user_id`` defaults to the caller. Naming someone else requires
    ``time:manage``. The day is derived from ``clock_in`` rather than sent
    separately, so the entry can never claim a date its own timestamps
    contradict.
    """

    user_id: int | None = None
    clock_in: datetime
    clock_out: datetime | None = None
    break_minutes: int = Field(default=0, ge=0, le=720)


class TimeBackfillWindowOut(BaseModel):
    """What the current user may fill in, so the UI can gate its own controls."""

    user_id: int
    can_backfill_any_day: bool
    can_backfill_self: bool
    earliest_self_day: date | None
    latest_self_day: date | None
