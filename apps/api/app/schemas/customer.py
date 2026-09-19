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

from app.schemas.project import ProjectActivityOut, ProjectNoteCreate, ProjectOverviewOut


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
    # Who visited. Left out, whoever writes the summary is the visitor.
    visit_by_user_id: int | None = None


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
    # Who visited. Left out, whoever writes the summary is the visitor.
    visit_by_user_id: int | None = None


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
    """One row of the customer's change log.

    The log is the union of the customer's project logs and the customer's
    own events, so on the customer page each row has to say where it came
    from: a project row names its project, a customer row has none.
    Mirrors `CustomerActivity` in the web types.
    """

    # "project" rows carry a project chip; "customer" rows are the
    # customer's own events, which have no project to name.
    source: Literal["project", "customer"] = "project"
    project_id: int | None = None
    customer_id: int | None = None
    project_number: str | None = None
    project_name: str | None = None
    # Opaque keyset cursor of this row; pass it as ?cursor= to page further back.
    cursor: str = ""


class CustomerNoteCreate(ProjectNoteCreate):
    """A posting on the customer's feed. The body rule — stripped,
    normalised line endings, 1..4000 characters — is the project note's,
    inherited so the two feeds can never drift apart on what a note holds."""


class CustomerNoteOut(BaseModel):
    id: int
    customer_id: int
    author_user_id: int | None = None
    # None for the entry migration 0092 carried over from the old notes
    # text: nobody knows who wrote that one.
    author_name: str | None = None
    body: str
    created_at: datetime


# ``ProjectOverviewOut.customer`` names CustomerOut, but schemas.project
# cannot import this module — this module imports it for ProjectActivityOut.
# So the overview keeps the name as a forward reference and is completed
# here, once CustomerOut exists.
ProjectOverviewOut.model_rebuild(_types_namespace={"CustomerOut": CustomerOut})
