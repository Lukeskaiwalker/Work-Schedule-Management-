from __future__ import annotations
from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class ConstructionReport(Base):
    """A construction site report.

    Ownership is CUSTOMER-first: a report belongs to a customer, and optionally
    also to one of that customer's projects. ``project_id`` therefore stays
    nullable — a report filed against a customer with no project is a first-class
    case, not a degenerate one.

    Two consequences of that ownership model are encoded here:

    * ``project_id`` is ON DELETE **SET NULL**, not CASCADE. Projects are hard
      deleted (``db.delete(project)``) and there is no ORM cascade in between, so
      CASCADE meant deleting a project silently destroyed its reports — i.e. the
      customer's signed field documents. Detaching is the correct behaviour;
      the report survives on the customer record.
    * ``report_number`` remains a PER-PROJECT sequence and stays NULL when there
      is no project. It is deliberately NOT re-scoped to the customer: issued
      numbers are already baked into rendered PDFs, PDF filenames and dispatched
      Telegram messages, so renumbering would invalidate existing artefacts.

    ``idempotency_key`` makes a lost-response retry safe: the client mints a key
    per submission attempt and sends it as the ``Idempotency-Key`` header, the
    row keeps it, and a later request from the same user with the same key is
    answered with this row instead of a second report. The unique index on
    ``(user_id, idempotency_key)`` is what holds under concurrency — a retry
    racing the original collides on it rather than slipping past a SELECT.
    NULL keys are distinct, so reports created without the header are exempt.
    """

    __tablename__ = "construction_reports"
    __table_args__ = (
        UniqueConstraint("project_id", "report_number", name="uq_construction_report_project_number"),
        Index("ix_construction_reports_user_idempotency_key", "user_id", "idempotency_key", unique=True),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id", ondelete="SET NULL"), index=True
    )
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"), index=True)
    report_number: Mapped[int | None] = mapped_column(Integer)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    report_date: Mapped[date] = mapped_column(Date, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    telegram_sent: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    telegram_mode: Mapped[str] = mapped_column(String(16), default="stub", nullable=False)
    processing_status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False, index=True)
    processing_error: Mapped[str | None] = mapped_column(Text)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime)
    pdf_file_name: Mapped[str | None] = mapped_column(String(255))
    idempotency_key: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class ConstructionReportJob(Base):
    __tablename__ = "construction_report_jobs"
    __table_args__ = (UniqueConstraint("construction_report_id", name="uq_construction_report_job_report"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    construction_report_id: Mapped[int] = mapped_column(
        ForeignKey("construction_reports.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )
    send_telegram: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="queued", nullable=False, index=True)
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)
