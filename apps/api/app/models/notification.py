"""notification.py — Personal notification records for task assignments."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # The user who receives this notification
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # The user who triggered the event (may be null for system events)
    actor_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    # e.g. "task.assigned"
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    # e.g. "task"
    entity_type: Mapped[str] = mapped_column(String(32), nullable=False)
    # The primary key of the entity (task_id, etc.)
    entity_id: Mapped[int | None] = mapped_column(Integer)
    # Scoping — lets the frontend know which project context to navigate to
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), index=True
    )

    # Human-readable message, e.g. "Luca assigned you to 'Install scaffolding'"
    message: Mapped[str] = mapped_column(String(255), nullable=False)

    # Null = unread; set when the panel is opened (mark-all-read).
    # "Read" only controls the unread styling and the bell badge — a read
    # notification is still listed.
    read_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    # Null = still in the list. Set when the entry leaves the panel for good:
    # either the user clicked it (explicit dismissal) or the server resolved
    # it because its subject is gone (task completed or deleted).
    # Kept as a soft delete rather than a row delete so the notification
    # history stays auditable and a dismissal can be reasoned about later.
    dismissed_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False, index=True
    )
