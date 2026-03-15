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


class TimeEntryOut(BaseModel):
    id: int
    user_id: int
    clock_in: datetime
    clock_out: datetime | None = None
    is_open: bool
    break_hours: float
    required_break_hours: float
    deducted_break_hours: float
    net_hours: float


class TimeEntryUpdate(BaseModel):
    clock_in: datetime
    clock_out: datetime | None = None
    break_minutes: int = Field(default=0, ge=0, le=720)


class RequiredDailyHoursUpdate(BaseModel):
    required_daily_hours: float = Field(ge=1, le=24)


class RequiredDailyHoursOut(BaseModel):
    user_id: int
    required_daily_hours: float


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


class SchoolAbsenceOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    title: str
    absence_type: str = "other"
    counts_as_hours: bool = True
    start_date: date
    end_date: date
    recurrence_weekday: int | None = None
    recurrence_until: date | None = None
    created_by: int | None = None
    created_at: datetime
