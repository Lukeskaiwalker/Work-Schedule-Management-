"""Partner (external contractor) model.

A Partner represents an external contractor — electrician, plumber,
roofer, etc. — that can be attached to a Task alongside internal
employees. A Partner itself has no credentials: it is a company with
contact data and a free-text `trade` ("Elektro", "Sanitär", ...). Its
people may get logins for the partner portal — `users` rows with role
"external" and `partner_id` pointing here — which see exactly the tasks
linked through `TaskPartner` and the projects linked through
`ProjectPartner` (or reached by one of those tasks).

`TaskPartner` is the join between `tasks` and `partners`, modelled
exactly the same way as `TaskAssignment` (see
`app.models.task.TaskAssignment`) — same shape, different FK.

Archiving is soft (`archived_at`); there is no hard delete. Deleting
the creating user only clears `created_by` (SET NULL), never the
Partner itself.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class Partner(Base):
    __tablename__ = "partners"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    contact_person: Mapped[str | None] = mapped_column(String(255))
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(128))
    address: Mapped[str | None] = mapped_column(String(500))
    trade: Mapped[str | None] = mapped_column(String(128), index=True)
    tax_id: Mapped[str | None] = mapped_column(String(64))
    notes: Mapped[str | None] = mapped_column(Text)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )


class TaskPartner(Base):
    __tablename__ = "task_partners"
    __table_args__ = (
        UniqueConstraint("task_id", "partner_id", name="uq_task_partner"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), index=True
    )
    partner_id: Mapped[int] = mapped_column(
        ForeignKey("partners.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False
    )


class ProjectPartner(Base):
    """A whole project handed to a partner, with the office's note for them.

    Tasks reach a partner through `TaskPartner`; this row is for the cases
    where the partner should see the job itself — the roofer who does the
    whole roof of a new build — even before (or without) a task naming them.
    `note` is written by the office FOR the partner ("Material über die
    Hofeinfahrt") and is shown in the portal; it is not an internal note.
    """

    __tablename__ = "project_partners"
    __table_args__ = (
        UniqueConstraint("project_id", "partner_id", name="uq_project_partner"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=False
    )
    partner_id: Mapped[int] = mapped_column(
        ForeignKey("partners.id", ondelete="CASCADE"), index=True, nullable=False
    )
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )


class PartnerTimeEntry(Base):
    """Hours a partner's crew reports for a task or a project.

    Job costing for subcontracted work, not attendance: the office checks a
    partner's invoice against these. Employees' time lives in
    ``clock_entries`` and ``panel_work_sessions``; a partner has no clock.

    One row is one day of one crew: ``workers`` people for ``hours`` each, so
    the day's total is the product. ``task_id`` is SET NULL and the task's
    ``project_id`` is copied in, so deleting a task keeps its hours on the
    project instead of losing what the office has to pay for. A
    customer-only task has no project; such a row keeps ``task_id`` only, and
    the task cannot be deleted while it has live hours (``delete_task``).
    """

    __tablename__ = "partner_time_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    partner_id: Mapped[int] = mapped_column(
        ForeignKey("partners.id", ondelete="CASCADE"), index=True, nullable=False
    )
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )
    task_id: Mapped[int | None] = mapped_column(
        ForeignKey("tasks.id", ondelete="SET NULL"), index=True
    )
    work_date: Mapped[date] = mapped_column(Date, nullable=False)
    workers: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    hours: Mapped[float] = mapped_column(Float, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    reported_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False
    )
    # Taking a report back (partner within a week, office any time) marks the
    # row instead of deleting it: it stays the record of what was sent, and
    # the daily cap keeps counting it — otherwise report-and-withdraw would
    # be an unlimited loop for a stolen login.
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime)
    deleted_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
