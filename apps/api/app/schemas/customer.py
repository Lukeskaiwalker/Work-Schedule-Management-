"""Customer Pydantic schemas.

CustomerCreate / Update / Out mirror the Customer ORM entity.
CustomerListItemOut extends Out with aggregate project stats
(computed in the router via a join).

Kept in lock-step with `apps/web/src/types/customer.ts`.
"""

from __future__ import annotations

from datetime import date, datetime

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.schemas.project import ProjectActivityOut


class CustomerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    address: str | None = None
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    tax_id: str | None = None
    notes: str | None = None
    birthday: date | None = None
    marktakteur_nummer: str | None = Field(default=None, max_length=64)
    # "company" or "private"; None = never chosen.
    customer_type: Literal["company", "private"] | None = None
    mobile: str | None = Field(default=None, max_length=128)
    # What the first visit found — printed at the head of the Projektbericht.
    visit_summary: str | None = Field(default=None, max_length=8000)
    visit_date: date | None = None


class CustomerUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    address: str | None = None
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    tax_id: str | None = None
    notes: str | None = None
    birthday: date | None = None
    marktakteur_nummer: str | None = Field(default=None, max_length=64)
    # "company" or "private"; None = never chosen.
    customer_type: Literal["company", "private"] | None = None
    mobile: str | None = Field(default=None, max_length=128)
    # What the first visit found — printed at the head of the Projektbericht.
    visit_summary: str | None = Field(default=None, max_length=8000)
    visit_date: date | None = None


class CustomerOut(BaseModel):
    id: int
    name: str
    address: str | None = None
    contact_person: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    tax_id: str | None = None
    notes: str | None = None
    birthday: date | None = None
    marktakteur_nummer: str | None = None
    customer_type: str | None = None
    mobile: str | None = None
    visit_summary: str | None = None
    visit_date: date | None = None
    visit_by_user_id: int | None = None
    archived_at: datetime | None = None
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CustomerListItemOut(CustomerOut):
    project_count: int = 0
    active_project_count: int = 0
    last_project_activity_at: datetime | None = None


class CustomerActivityOut(ProjectActivityOut):
    """One row of the customer's cross-project change log.
    # Where the row comes from: the union of the customer's project logs and
    # the customer's own events. A customer row has no project.
    source: Literal["project", "customer"] = "project"
    project_id: int | None = None
    customer_id: int | None = None
    # Opaque keyset cursor of this row; pass it as ?cursor= to page further back.
    cursor: str = ""

    A project activity, plus the project it belongs to — on the customer page
    the rows of several projects sit in one list, so each has to say which
    one it came from. Mirrors `CustomerActivity` in the web types.
    """

    project_number: str | None = None
    project_name: str | None = None
