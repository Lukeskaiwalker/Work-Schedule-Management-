"""notification.py — Pydantic schemas for the notification system."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


class NotificationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_type: str
    entity_type: str
    entity_id: int | None
    project_id: int | None
    message: str
    read_at: datetime | None
    created_at: datetime
    # Enriched display name of the actor — resolved at query time, not stored
    actor_name: str | None = None
