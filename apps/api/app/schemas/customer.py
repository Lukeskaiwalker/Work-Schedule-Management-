"""Customer Pydantic schemas.

CustomerCreate / Update / Out mirror the Customer ORM entity.
CustomerListItemOut extends Out with aggregate project stats
(computed in the router via a join).

Kept in lock-step with `apps/web/src/types/customer.ts`.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    address: str | None = None
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    tax_id: str | None = None
    notes: str | None = None


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    address: str | None = None
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    tax_id: str | None = None
    notes: str | None = None


class CustomerOut(BaseModel):
    id: int
    name: str
    address: str | None = None
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    tax_id: str | None = None
    notes: str | None = None
    archived_at: datetime | None = None
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CustomerListItemOut(CustomerOut):
    project_count: int = 0
    active_project_count: int = 0
    last_project_activity_at: datetime | None = None
