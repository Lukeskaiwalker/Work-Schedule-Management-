"""Customer Pydantic schemas.

CustomerCreate / Update / Out mirror the Customer ORM entity.
CustomerListItemOut extends Out with aggregate project stats
(computed in the router via a join).

Kept in lock-step with `apps/web/src/types/customer.ts`.
"""

from __future__ import annotations

from datetime import date, datetime

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.schemas.project import ProjectActivityOut, ProjectNoteCreate, ProjectOverviewOut


# A write-up is prose about a day on site; the cap is generous but finite so
# a pasted document does not become "the visit".
CUSTOMER_VISIT_MAX_CHARS = 8000


def _normalized_summary(value: str) -> str:
    # Line endings as the browser sent them differ per platform; the stored
    # text is what the feed shows and the report prints, so it is
    # normalised once, here.
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not text:
        raise ValueError("Visit summary must not be empty")
    if len(text) > CUSTOMER_VISIT_MAX_CHARS:
        raise ValueError(f"Visit summary must be at most {CUSTOMER_VISIT_MAX_CHARS} characters")
    return text


class CustomerVisitCreate(BaseModel):
    """One entry of the Kundenbesuch feed as it is posted."""

    summary: str
    visit_date: date | None = None
    # One of the customer's projects — the write-up is about that job — or
    # None: about the customer as such, printed in every project's report.
    project_id: int | None = None
    # Who went. Left out, whoever posts the entry is the visitor.
    visit_by_user_id: int | None = None

    @field_validator("summary")
    @classmethod
    def _summary_stripped_and_bounded(cls, value: str) -> str:
        return _normalized_summary(value)


class CustomerVisitUpdate(BaseModel):
    """A partial edit: only the fields sent change; ``project_id: None``
    unlinks the entry from its project."""

    summary: str | None = None
    visit_date: date | None = None
    project_id: int | None = None
    visit_by_user_id: int | None = None

    @field_validator("summary")
    @classmethod
    def _summary_stripped_and_bounded(cls, value: str | None) -> str | None:
        return None if value is None else _normalized_summary(value)


class CustomerVisitOut(BaseModel):
    id: int
    customer_id: int
    project_id: int | None = None
    # The linked project's number and name, so a row can be labelled
    # without a second request; None when the entry is not linked.
    project_number: str | None = None
    project_name: str | None = None
    visit_date: date | None = None
    visit_by_user_id: int | None = None
    # None for a visitor no longer in the system, and for the entry
    # migration 0093 carried over without one.
    visit_by_name: str | None = None
    summary: str
    created_at: datetime
    updated_at: datetime


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
    # The first visit, written up in the same form the customer is created
    # in: one request, one transaction. The entry cannot name a project —
    # the customer has none yet.
    visit: CustomerVisitCreate | None = None


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


# ── Zugangsdaten ──────────────────────────────────────────────────────────────
# The installation's logins. The secret never appears in these shapes; a
# reveal is its own call (routers/workflow_customer_credentials.py).

CREDENTIAL_CATEGORIES: tuple[str, ...] = ("inverter", "wallbox", "storage", "heatpump", "router", "portal", "other")
CredentialCategory = Literal["inverter", "wallbox", "storage", "heatpump", "router", "portal", "other"]


def _clean_optional(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    text = value.strip()
    return text[:limit] if text else None


class CustomerCredentialCreate(BaseModel):
    label: str = Field(min_length=1, max_length=160)
    category: CredentialCategory = "other"
    username: str | None = Field(default=None, max_length=255)
    secret: str | None = Field(default=None, max_length=512)
    url: str | None = Field(default=None, max_length=500)
    notes: str | None = Field(default=None, max_length=4000)

    @field_validator("label")
    @classmethod
    def _label_stripped(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("Bezeichnung darf nicht leer sein")
        return text

    @field_validator("username", "url", "notes")
    @classmethod
    def _optional_stripped(cls, value: str | None) -> str | None:
        return _clean_optional(value, 4000)


class CustomerCredentialUpdate(BaseModel):
    """Every field optional; ``secret`` absent keeps it, ``""`` clears it."""

    label: str | None = Field(default=None, min_length=1, max_length=160)
    category: CredentialCategory | None = None
    username: str | None = Field(default=None, max_length=255)
    secret: str | None = Field(default=None, max_length=512)
    url: str | None = Field(default=None, max_length=500)
    notes: str | None = Field(default=None, max_length=4000)

    @field_validator("label")
    @classmethod
    def _label_stripped(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        if not text:
            raise ValueError("Bezeichnung darf nicht leer sein")
        return text


class CustomerCredentialOut(BaseModel):
    id: int
    customer_id: int
    label: str
    category: str
    username: str | None = None
    url: str | None = None
    notes: str | None = None
    has_secret: bool = False
    created_at: datetime
    updated_at: datetime
    created_by_name: str | None = None
    updated_by_name: str | None = None
    last_revealed_at: datetime | None = None
    last_revealed_by_name: str | None = None


class CustomerCredentialRevealOut(BaseModel):
    secret: str
    revealed_at: datetime
