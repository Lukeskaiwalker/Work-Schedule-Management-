from __future__ import annotations
from datetime import date, datetime, time

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    Time,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class Task(Base):
    __tablename__ = "tasks"
    # Anchor invariant: every task must point to a project, a customer,
    # or both. Tasks without an anchor are orphan data and the API
    # rejects them — but we also enforce at the schema level so a
    # mistaken UPDATE that clears both columns doesn't sneak through.
    __table_args__ = (
        CheckConstraint(
            "project_id IS NOT NULL OR customer_id IS NOT NULL",
            name="ck_tasks_project_or_customer",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # Nullable since v2.4.5: a task can be customer-only ("call Jane
    # about quote"). When set, ondelete=CASCADE removes the task with
    # its parent project — same as before.
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True, nullable=True
    )
    # New in v2.4.5: customer-only tasks. CASCADE on customer deletion
    # mirrors the project semantics — a task whose anchor record is
    # gone is orphan data we don't want to keep.
    customer_id: Mapped[int | None] = mapped_column(
        ForeignKey("customers.id", ondelete="CASCADE"), index=True, nullable=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    subtasks: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    materials_required: Mapped[str | None] = mapped_column(Text)
    storage_box_number: Mapped[int | None] = mapped_column(Integer)
    task_type: Mapped[str] = mapped_column(String(32), default="construction", nullable=False)
    class_template_id: Mapped[int | None] = mapped_column(
        ForeignKey("project_class_templates.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(64), default="open", nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date)
    start_time: Mapped[time | None] = mapped_column(Time)
    estimated_hours: Mapped[float | None] = mapped_column(Float)
    assignee_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    week_start: Mapped[date | None] = mapped_column(Date, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class TaskAssignment(Base):
    __tablename__ = "task_assignments"
    __table_args__ = (UniqueConstraint("task_id", "user_id", name="uq_task_assignment"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
