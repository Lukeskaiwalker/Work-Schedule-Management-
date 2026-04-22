"""Partner (external contractor) model.

A Partner represents an external contractor — electrician, plumber,
roofer, etc. — that can be attached to a Task alongside internal
employees. Partners are NOT app users: they have no login and no
authentication credentials, only contact data and a free-text
`trade` ("Elektro", "Sanitär", ...).

`TaskPartner` is the join between `tasks` and `partners`, modelled
exactly the same way as `TaskAssignment` (see
`app.models.task.TaskAssignment`) — same shape, different FK.

Archiving is soft (`archived_at`); there is no hard delete. Deleting
the creating user only clears `created_by` (SET NULL), never the
Partner itself.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
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
    archived_at: Mapped[datetime | None] = mapped_column(DateTime)
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
