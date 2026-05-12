from __future__ import annotations
from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.partner import PartnerOut


class TaskCreate(BaseModel):
    # v2.4.5: a task is anchored to a project, a customer, or both.
    # The model_validator below enforces "at least one is set" so the
    # request never bypasses the DB CHECK constraint with a more
    # opaque IntegrityError. Both nullable individually so the UI can
    # send either shape without sending an explicit null.
    project_id: int | None = None
    customer_id: int | None = None
    title: str
    description: str | None = None
    subtasks: list[str] = Field(default_factory=list)
    materials_required: str | None = None
    storage_box_number: int | None = Field(default=None, ge=1)
    task_type: str = "construction"
    class_template_id: int | None = None
    status: str = "open"
    due_date: date | None = None
    start_time: time | None = None
    estimated_hours: float | None = None
    assignee_id: int | None = None
    assignee_ids: list[int] = Field(default_factory=list)
    partner_ids: list[int] = Field(default_factory=list)
    week_start: date | None = None
    confirm_overlap: bool = False
    # v2.5.0: when true, the task starts with confirmation_status="pending"
    # and (if customer email is available) an email goes out at create
    # time. The FE auto-checks this for task_type="construction" tasks
    # but lets the operator opt out.
    request_customer_confirmation: bool = False

    @model_validator(mode="after")
    def _require_anchor(self) -> "TaskCreate":
        if self.project_id is None and self.customer_id is None:
            raise ValueError("project_id or customer_id is required")
        return self

    @field_validator("estimated_hours")
    @classmethod
    def validate_estimated_hours(cls, value: float | None) -> float | None:
        if value is None:
            return None
        if value <= 0:
            raise ValueError("estimated_hours must be greater than 0")
        half_hour_steps = round(value * 2)
        if abs((half_hour_steps / 2) - value) > 1e-9:
            raise ValueError("estimated_hours must use 0.5-hour increments")
        if value >= 24:
            raise ValueError("estimated_hours must be less than 24 hours")
        return half_hour_steps / 2


class TaskUpdate(BaseModel):
    expected_updated_at: datetime | None = None
    title: str | None = None
    # Re-anchor support: an operator may move a task between projects
    # or convert a project task into a customer task (or vice-versa)
    # by patching these fields. Router-level logic enforces that the
    # final state still satisfies the at-least-one-anchor invariant.
    project_id: int | None = None
    customer_id: int | None = None
    description: str | None = None
    subtasks: list[str] | None = None
    materials_required: str | None = None
    storage_box_number: int | None = Field(default=None, ge=1)
    task_type: str | None = None
    class_template_id: int | None = None
    status: str | None = None
    due_date: date | None = None
    start_time: time | None = None
    estimated_hours: float | None = None
    assignee_id: int | None = None
    assignee_ids: list[int] | None = None
    partner_ids: list[int] | None = None
    week_start: date | None = None
    confirm_overlap: bool = False
    # v2.5.0: toggle confirmation-required on/off. True flips
    # status to "pending" + auto-sends email (if customer email
    # available); False clears status to null (no indicator shown).
    request_customer_confirmation: bool | None = None

    @field_validator("estimated_hours")
    @classmethod
    def validate_estimated_hours(cls, value: float | None) -> float | None:
        if value is None:
            return None
        if value <= 0:
            raise ValueError("estimated_hours must be greater than 0")
        half_hour_steps = round(value * 2)
        if abs((half_hour_steps / 2) - value) > 1e-9:
            raise ValueError("estimated_hours must use 0.5-hour increments")
        if value >= 24:
            raise ValueError("estimated_hours must be less than 24 hours")
        return half_hour_steps / 2


class TaskOut(BaseModel):
    id: int
    # Both anchors are nullable on output now (v2.4.5). At least one is
    # always set — the DB CHECK constraint guarantees it.
    project_id: int | None = None
    customer_id: int | None = None
    title: str
    description: str | None = None
    subtasks: list[str] = Field(default_factory=list)
    materials_required: str | None = None
    storage_box_number: int | None = None
    task_type: str = "construction"
    class_template_id: int | None = None
    status: str
    is_overdue: bool = False
    due_date: date | None = None
    start_time: time | None = None
    estimated_hours: float | None = None
    end_time: time | None = None
    assignee_id: int | None = None
    assignee_ids: list[int] = Field(default_factory=list)
    partner_ids: list[int] = Field(default_factory=list)
    partners: list[PartnerOut] = Field(default_factory=list)
    week_start: date | None = None
    # v2.5.0 customer-confirmation. status is the at-a-glance signal that
    # drives the colored dot on every task surface (null = no dot,
    # pending = amber, confirmed = green, declined = red). The other
    # fields populate the detailed status panel inside the task modal.
    customer_confirmation_status: str | None = None
    customer_confirmation_at: datetime | None = None
    customer_confirmation_method: str | None = None
    customer_confirmation_by_user_id: int | None = None
    customer_confirmation_by_display_name: str | None = None
    customer_confirmation_notes: str | None = None
    customer_confirmation_email_sent_at: datetime | None = None
    # Whether the task is past the email-link expiry window (today >=
    # due_date). Surfaced as a boolean so the FE can render a different
    # tooltip without re-implementing the date check.
    customer_confirmation_token_expired: bool = False
    updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


# ── v2.5.0 customer confirmation API shapes ──────────────────────────────


class CustomerConfirmationManualRequest(BaseModel):
    """Operator-driven manual confirmation (phone call, in-person nod, etc.).

    ``action`` is required so the same endpoint handles both confirm and
    decline. ``notes`` is optional context the operator wants to record
    alongside the timestamp (e.g. "Sprach mit Hr. Schmidt, kommt um 8")."""

    action: Literal["confirm", "decline"]
    method: Literal["phone", "manual"] = "phone"
    notes: str | None = None


class CustomerConfirmationEmailResult(BaseModel):
    """Response for the send-email / resend-email endpoint."""

    sent: bool
    sent_at: datetime | None = None
    error_detail: str | None = None


class PublicCustomerConfirmationOut(BaseModel):
    """Snapshot of a task surfaced on the unauthenticated /confirm/:token
    page. Only contains data the customer needs to make their decision;
    no internal IDs, no other-tasks-on-the-same-project leakage."""

    customer_name: str | None = None
    task_title: str
    task_description: str | None = None
    due_date: date | None = None
    start_time: time | None = None
    estimated_hours: float | None = None
    worker_display_names: list[str] = Field(default_factory=list)
    language: Literal["de", "en"] = "de"
    # Current state so the page can show "already confirmed" instead of
    # offering the buttons again on a second visit.
    confirmation_status: str | None = None
    confirmation_at: datetime | None = None
    # True when the link has expired (due_date passed). The FE shows
    # "Bitte rufen Sie uns an" instead of action buttons.
    expired: bool = False


class PublicCustomerConfirmationRequest(BaseModel):
    """Body for the unauthenticated POST. The endpoint validates the
    token from the path; this body only carries the action."""

    action: Literal["confirm", "decline"]


class PlanningAbsenceOut(BaseModel):
    type: str
    user_id: int
    user_name: str
    label: str
    status: str | None = None


class PlanningDayOut(BaseModel):
    date: date
    tasks: list[TaskOut]
    absences: list[PlanningAbsenceOut] = Field(default_factory=list)


class PlanningWeekOut(BaseModel):
    week_start: date
    week_end: date
    days: list[PlanningDayOut]
