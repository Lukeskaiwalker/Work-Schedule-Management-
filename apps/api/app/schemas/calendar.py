"""The profile page's view of a user's calendar subscription."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class CalendarFeedOut(BaseModel):
    url: str
    webcal_url: str
    created_at: datetime
    last_fetched_at: datetime | None = None
    last_fetch_agent: str | None = None
    fetch_count: int = 0
