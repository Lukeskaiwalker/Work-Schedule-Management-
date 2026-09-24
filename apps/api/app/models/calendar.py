"""A user's personal calendar subscription.

One row per user: the secret behind their ``…/api/calendar/<token>/feed.ics``
link. Calendar apps fetch that link without a login, so the token is the
whole credential — stored as a sha256 hash for the lookup (like a PAT) and
Fernet-encrypted for showing the link again on the profile page (unlike a
PAT, which is shown once; a subscription link has to be re-copied onto the
next phone). Rotating = a new token in the same row; the old link then 404s
everywhere it was pasted. ``last_fetched_at`` / ``last_fetch_agent`` tell the
user whether their phone is actually polling.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class CalendarFeed(Base):
    __tablename__ = "calendar_feeds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True, index=True)
    token_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_fetched_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_fetch_agent: Mapped[str | None] = mapped_column(String(200))
    fetch_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
