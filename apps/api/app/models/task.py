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
    # Legacy free-typed crate number, kept as-is: existing tasks hold arbitrary
    # values (the integration tests use 7 and 9), so it must never gain
    # validation. Once a task links a real box the server MIRRORS that box's
    # rack slot into this column, which keeps the ICS export and the
    # construction-report prefill correct with no changes at those call sites.
    storage_box_number: Mapped[int | None] = mapped_column(Integer)
    # The real link, new in v2.7. SET NULL rather than CASCADE — deleting a
    # crate must never delete the job that referenced it.
    construction_box_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_construction_boxes.id", ondelete="SET NULL"),
        index=True,
        nullable=True,
    )
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

    # ── v2.5.0 customer confirmation ────────────────────────────────────
    # ``customer_confirmation_status`` is the SINGLE source of truth for
    # whether confirmation is requested + its current state. Null means
    # "not requested" (no indicator shown anywhere). Any other value means
    # confirmation is part of this task's lifecycle:
    #   "pending"   — requested, awaiting either email reply or manual entry
    #   "confirmed" — customer or operator confirmed
    #   "declined"  — customer declined (needs rescheduling)
    customer_confirmation_status: Mapped[str | None] = mapped_column(String(16))
    customer_confirmation_at: Mapped[datetime | None] = mapped_column(DateTime)
    # How the confirmation was recorded: "email" (customer clicked link),
    # "phone" or "manual" (operator typed it in).
    customer_confirmation_method: Mapped[str | None] = mapped_column(String(16))
    # Operator who recorded the confirmation; null when the customer
    # self-served by clicking the email link.
    customer_confirmation_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    customer_confirmation_notes: Mapped[str | None] = mapped_column(Text)
    # Opaque 32-hex random token embedded in the email link. UNIQUE index
    # at the DB level so the public endpoint resolves a token to a single
    # task in one row lookup. Null whenever no email has been sent (or
    # after a due_date change clears it for a fresh round).
    customer_confirmation_token: Mapped[str | None] = mapped_column(String(64))
    customer_confirmation_email_sent_at: Mapped[datetime | None] = mapped_column(DateTime)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow, nullable=False)


class TaskAssignment(Base):
    __tablename__ = "task_assignments"
    __table_args__ = (UniqueConstraint("task_id", "user_id", name="uq_task_assignment"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(ForeignKey("tasks.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)


class TaskMaterial(Base):
    """One material line on a task — what to bring, and what came back.

    Tasks previously carried materials as ``Task.materials_required``, a single
    free-text blob. That is fine for a note to a colleague and useless for
    anything else: it cannot be checked off on site, cannot say how much of
    something is needed, and above all cannot be reconciled against stock,
    because nothing in it identifies an article.

    These rows exist so a construction box can be unpacked into the task that
    will consume it. ``quantity`` is what was packed; ``quantity_used`` is what
    the report says was actually fitted, and stays NULL until then. The gap
    between them is what goes back on the shelf — which is the whole reason
    both are stored rather than one being overwritten.

    Identity is snapshotted (name, article number, EAN) the way box items do
    it: an article can be renamed or archived years later, and a finished job
    should still read as it did on the day.
    """

    __tablename__ = "task_materials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    task_id: Mapped[int] = mapped_column(
        ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )

    # Where this line came from. Deselecting a box must remove exactly the
    # lines that selecting it added and nothing a person typed by hand, so
    # provenance is stored rather than inferred. SET NULL on the item because
    # box lines are edited freely while the crate is being packed; the box id
    # is what the removal actually keys on.
    source_box_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_construction_boxes.id", ondelete="SET NULL"), index=True
    )
    source_box_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_construction_box_items.id", ondelete="SET NULL"), index=True
    )

    # Null for a catalog or free-text line: only article-backed rows can move
    # stock, exactly as in werkstatt_construction_box_items.
    article_id: Mapped[int | None] = mapped_column(
        ForeignKey("werkstatt_articles.id", ondelete="SET NULL"), index=True
    )

    item_name: Mapped[str] = mapped_column(String(255), nullable=False)
    article_no: Mapped[str | None] = mapped_column(String(64))
    ean: Mapped[str | None] = mapped_column(String(64))
    unit: Mapped[str | None] = mapped_column(String(32))

    quantity: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # NULL means "not reported yet", which is different from a reported zero:
    # zero says the item came back untouched, NULL says nobody has said.
    quantity_used: Mapped[int | None] = mapped_column(Integer)

    notes: Mapped[str | None] = mapped_column(Text)
    added_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )
