"""Schemas for personal-access-token (PAT) management endpoints."""
from __future__ import annotations
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ApiTokenCreate(BaseModel):
    """Body for POST /api/auth/api-tokens.

    ``name`` is a human label for the UI ("Planning agent", "n8n
    workflow"). It is required so the user always knows what each
    token is for — debugging "which agent has this token?" later is
    much harder without it.

    ``expires_in_days`` defaults to 90. ``None`` is allowed but the
    UI doesn't expose it — agents that really need a never-expiring
    token must request it explicitly via the API.
    """

    name: str = Field(min_length=1, max_length=128)
    expires_in_days: int | None = Field(default=90, ge=1, le=3650)


class ApiTokenOut(BaseModel):
    """Public view of a token row — never includes the raw secret.

    The list endpoint and the revoke endpoint return this. The
    create endpoint returns ``ApiTokenCreatedOut`` instead, which
    includes the raw secret exactly once.
    """

    id: int
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None = None
    expires_at: datetime | None = None
    revoked_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class ApiTokenCreatedOut(ApiTokenOut):
    """Returned only by POST /api/auth/api-tokens, on the single occasion
    when the raw token value exists in plaintext. Subsequent reads
    cannot reconstruct it — the user must record it now."""

    token: str
