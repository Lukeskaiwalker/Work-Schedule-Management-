"""Shapes of the partner portal (``/api/portal``) and its office side.

Portal shapes are deliberately narrow: each field is something a
subcontractor needs to do the job. Anything internal — the customer's phone
and email, finances, the project description, other partners on a task,
the four-stage project status — has no field here, so it cannot leak by a
later ``model_validate(row)`` picking it up.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

PortalUserStatus = Literal["invited", "active", "disabled"]
PortalFileSource = Literal["partner", "office", "external"]
ProjectPhase = Literal["running", "finished"]


# ── Office side: logins on a partner ─────────────────────────────────────────

class PartnerPortalUserCreate(BaseModel):
    full_name: str = Field(min_length=1, max_length=255)
    email: EmailStr

    @field_validator("full_name")
    @classmethod
    def _name_not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("full_name must not be blank")
        return stripped


class PartnerPortalUserOut(BaseModel):
    id: int
    partner_id: int
    full_name: str
    email: str
    is_active: bool
    status: PortalUserStatus
    invite_sent_at: datetime | None = None
    invite_accepted_at: datetime | None = None
    last_login_at: datetime | None = None
    created_at: datetime


class PartnerPortalLinkOut(BaseModel):
    """A freshly minted invite or password link, and whether the mail went out.

    The link is returned even when the email was sent, so the office can hand
    it over another way (WhatsApp, SMS) when SMTP is not configured.
    """

    user: PartnerPortalUserOut
    kind: Literal["invite", "password_reset"]
    invite_link: str
    expires_at: datetime
    sent: bool
    email_error_type: str | None = None
    email_error_detail: str | None = None


# ── Office side: projects handed to partners ────────────────────────────────

class ProjectPartnerUpsert(BaseModel):
    note: str | None = Field(default=None, max_length=4000)


class ProjectPartnerSummary(BaseModel):
    id: int
    name: str
    trade: str | None = None
    archived_at: datetime | None = None


class ProjectPartnerOut(BaseModel):
    """A partner who sees this project.

    ``assigned`` is True for a project handed over as a whole (it has the
    note and can be taken back), False for a partner who sees the project
    only through tasks on it — listed so the office knows everybody who reads
    the project's ``Partnerportal`` folder.
    """

    project_id: int
    partner_id: int
    partner: ProjectPartnerSummary
    assigned: bool = True
    note: str | None = None
    portal_user_count: int = 0
    task_count: int = 0
    hours_total: float = 0
    created_at: datetime | None = None
    updated_at: datetime | None = None


class PartnerHoursTaskRef(BaseModel):
    id: int
    title: str


class PartnerHoursOut(BaseModel):
    """A partner's hours as the office reads them (all partners, all fields)."""

    id: int
    partner: ProjectPartnerSummary
    project_id: int | None = None
    task: PartnerHoursTaskRef | None = None
    work_date: date
    workers: int
    hours: float
    total_hours: float
    note: str | None = None
    reported_by: str | None = None
    created_at: datetime


# ── The portal ───────────────────────────────────────────────────────────────

class PortalUserOut(BaseModel):
    id: int
    full_name: str
    email: str


class PortalPartnerOut(BaseModel):
    id: int
    name: str
    trade: str | None = None


class PortalCompanyOut(BaseModel):
    name: str
    logo_url: str = ""
    phone: str = ""
    email: str = ""


class PortalMeOut(BaseModel):
    user: PortalUserOut
    partner: PortalPartnerOut
    company: PortalCompanyOut


class PortalProjectRef(BaseModel):
    id: int
    number: str
    name: str


class PortalTaskOut(BaseModel):
    id: int
    title: str
    status: Literal["open", "in_progress", "on_hold", "done"]
    due_date: date | None = None
    end_date: date | None = None
    start_time: time | None = None
    estimated_hours: float | None = None
    is_overdue: bool = False
    project: PortalProjectRef | None = None
    customer_name: str | None = None
    address: str | None = None
    attachment_count: int = 0


class PortalFileOut(BaseModel):
    id: int
    file_name: str
    content_type: str
    created_at: datetime
    source: PortalFileSource


class PortalDocumentOut(BaseModel):
    """A file from the project's ``Partnerportal`` folder.

    ``folder`` is the path below that folder (``""`` for the folder itself),
    so the portal can group "Pläne", "Fotos vorher", … without ever seeing
    the project's other folder names.
    """

    id: int
    file_name: str
    content_type: str
    folder: str = ""
    created_at: datetime


class PortalHoursOut(BaseModel):
    id: int
    work_date: date
    workers: int
    hours: float
    total_hours: float
    note: str | None = None
    task: PartnerHoursTaskRef | None = None
    reported_by: str | None = None
    created_at: datetime
    can_delete: bool = False


#: Limits of one report: a crew of at most 50, quarter hours up to a day.
HOURS_MAX_WORKERS = 50
HOURS_MAX_PER_PERSON = 24.0


class PortalHoursIn(BaseModel):
    """One day of one crew. Anchor: a task of the partner's, or a project they
    see (a task may name its own project too, never another one)."""

    task_id: int | None = Field(default=None, ge=1)
    project_id: int | None = Field(default=None, ge=1)
    work_date: date
    workers: int = Field(default=1, ge=1, le=HOURS_MAX_WORKERS)
    hours: float = Field(gt=0, le=HOURS_MAX_PER_PERSON)
    note: str | None = Field(default=None, max_length=2000)

    @field_validator("hours")
    @classmethod
    def _quarter_hours(cls, value: float) -> float:
        quarters = value * 4
        if abs(quarters - round(quarters)) > 1e-6:
            raise ValueError("hours must be a multiple of 0.25")
        return round(quarters) / 4

    @field_validator("note")
    @classmethod
    def _note_or_none(cls, value: str | None) -> str | None:
        text = (value or "").strip()
        return text or None

    @model_validator(mode="after")
    def _needs_an_anchor(self) -> "PortalHoursIn":
        if self.task_id is None and self.project_id is None:
            raise ValueError("task_id or project_id is required")
        return self


class PortalTaskDetailOut(PortalTaskOut):
    description: str | None = None
    subtasks: list[str] = Field(default_factory=list)
    materials: str | None = None
    site_access_type: str | None = None
    site_access_note: str | None = None
    project_note: str | None = None
    team: list[str] = Field(default_factory=list)
    files: list[PortalFileOut] = Field(default_factory=list)
    documents: list[PortalDocumentOut] = Field(default_factory=list)
    hours: list[PortalHoursOut] = Field(default_factory=list)
    hours_total: float = 0
    can_complete: bool = False


class PortalCompleteIn(BaseModel):
    note: str | None = Field(default=None, max_length=4000)


class PortalNextTask(BaseModel):
    id: int
    title: str
    due_date: date | None = None
    start_time: time | None = None


class PortalProjectOut(BaseModel):
    id: int
    number: str
    name: str
    address: str | None = None
    phase: ProjectPhase
    open_task_count: int = 0
    overdue_task_count: int = 0
    next_task: PortalNextTask | None = None


class PortalProjectDetailOut(PortalProjectOut):
    site_access_type: str | None = None
    site_access_note: str | None = None
    partner_note: str | None = None
    tasks: list[PortalTaskOut] = Field(default_factory=list)
    documents: list[PortalDocumentOut] = Field(default_factory=list)
    hours: list[PortalHoursOut] = Field(default_factory=list)
    hours_total: float = 0


class PortalPasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=8, max_length=256)
