from __future__ import annotations
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class ClockEntry(Base):
    __tablename__ = "clock_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    clock_in: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    clock_out: Mapped[datetime | None] = mapped_column(DateTime)


class BreakEntry(Base):
    __tablename__ = "break_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    clock_entry_id: Mapped[int] = mapped_column(ForeignKey("clock_entries.id", ondelete="CASCADE"), index=True)
    break_start: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    break_end: Mapped[datetime | None] = mapped_column(DateTime)


class VacationRequest(Base):
    __tablename__ = "vacation_requests"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="pending", nullable=False, index=True)
    reviewed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class SchoolAbsence(Base):
    __tablename__ = "school_absences"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(255), default="Berufsschule", nullable=False)
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    absence_type: Mapped[str] = mapped_column(String(64), nullable=False, default="other")
    counts_as_hours: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    recurrence_weekday: Mapped[int | None] = mapped_column(Integer)
    recurrence_until: Mapped[date | None] = mapped_column(Date)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
