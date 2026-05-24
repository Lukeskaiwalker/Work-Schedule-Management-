"""Personal Access Token (PAT) model.

A PAT is a long-lived bearer credential a user mints from their settings
page (once their admin has flipped ``users.api_access_enabled = true``).

Tokens are emitted in the format ``smpl_pat_<43 url-safe chars>`` —
256 bits of entropy after the prefix. The raw token is shown to the
user *once* at mint time; we persist only its sha256 hash. A subsequent
request authenticates by sending the raw token in the
``Authorization: Bearer …`` header; the auth dependency hashes the
incoming value and looks up the row.

An "active" token is one where ``revoked_at IS NULL`` AND
(``expires_at IS NULL OR expires_at > now()``) AND the owning user has
``api_access_enabled = true`` AND ``is_active = true``. All four
conditions are checked at the request boundary — the DB has no
constraint, on purpose, so an admin can suspend access by flipping the
boolean without us having to mass-revoke the tokens.
"""
from __future__ import annotations
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


class ApiToken(Base):
    __tablename__ = "api_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # sha256(raw_token) hex — never the raw token itself.
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    # First 12 chars of the raw token (``smpl_pat_XYZ``), for UI display
    # only. Knowing the prefix doesn't let you authenticate — you'd need
    # the remaining 32+ random characters too.
    prefix: Mapped[str] = mapped_column(String(16), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
