"""Partner (external contractor) Pydantic schemas.

PartnerCreate / Update / Out mirror the Partner ORM entity.
PartnerListItemOut extends Out with aggregate task stats (computed
in the router via a join on `task_partners`).

Kept in lock-step with `apps/web/src/types/partner.ts`.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class PartnerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    address: str | None = None
    trade: str | None = None
    tax_id: str | None = None
    notes: str | None = None


class PartnerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    address: str | None = None
    trade: str | None = None
    tax_id: str | None = None
    notes: str | None = None


class PartnerOut(BaseModel):
    id: int
    name: str
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    address: str | None = None
    trade: str | None = None
    tax_id: str | None = None
    notes: str | None = None
    archived_at: datetime | None = None
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class PartnerListItemOut(PartnerOut):
    task_count: int = 0
    open_task_count: int = 0
    last_task_activity_at: datetime | None = None
