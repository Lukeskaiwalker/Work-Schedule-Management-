from __future__ import annotations
from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.partner import PartnerOut


# The German the modal shows verbatim. One source for both paths — the create
# schema (pydantic → 422) and the router's PATCH rule (400) — so the same rule
# never surfaces in two languages depending on which verb hit it.
TASK_DATE_RANGE_DETAIL = "Das Enddatum darf nicht vor dem Startdatum liegen"
TASK_END_WITHOUT_START_DETAIL = "Das Enddatum braucht ein Startdatum"


def validate_task_date_range(*, due_date: date | None, end_date: date | None) -> None:
    """The one rule for a task window on create: an end needs a start, and may
    not precede it. Raises ValueError so pydantic turns it into a 422 carrying
    the same German text the PATCH path answers with (TASK_DATE_RANGE_DETAIL).
    The router's update path folds a stray end onto None instead of refusing
    it, because there clearing "Von" is how a task goes back to undated."""
    if end_date is None:
        return
    if due_date is None:
        raise ValueError(TASK_END_WITHOUT_START_DETAIL)
    if end_date < due_date:
        raise ValueError(TASK_DATE_RANGE_DETAIL)


# The German a completion answers with when a new crate was asked for without
# a name. Router-level (400) rather than pydantic (422) because it is a rule
# about the choice, not about the shape of the request, and the dialog shows
# the sentence verbatim.
NEW_BOX_LABEL_REQUIRED_DETAIL = "Die neue Kiste braucht eine Bezeichnung"


class MaterialRemainderChoice(BaseModel):
    """What should happen to the material a finished job did not use up.

    Sent with the completing PATCH rather than as its own request so that
    "settle the crate" and "the task is done" cannot come apart: one
    transaction, or neither.

    ``shelf`` is the default for every client that does not ask — the task edit
    modal, the mobile status dropdown, anything external — because it is what
    completing a task has always done.
    """

    disposition: Literal["shelf", "same_box", "new_box"] = "shelf"
    # Required for ``new_box`` (checked in the router, which answers 400 with
    # NEW_BOX_LABEL_REQUIRED_DETAIL). A crate nobody named is a crate nobody
    # finds again on the rack.
    new_box_label: str | None = Field(default=None, max_length=160)


class TaskMaterialSettlementBoxOut(BaseModel):
    """The crate a completion is about to settle."""

    id: int
    box_number: str
    label: str
    status: str
    customer_name: str | None = None


class TaskMaterialSettlementLineOut(BaseModel):
    """One position: what went out, what was fitted, what is left."""

    id: int
    item_name: str
    unit: str | None = None
    quantity: int
    # None means nobody has reported on this line — then the whole line counts
    # as fitted, which is why ``remainder`` can be 0 while this is null.
    quantity_used: int | None = None
    remainder: int
    article_id: int | None = None


class TaskMaterialSettlementOut(BaseModel):
    """Preview of what completing this task would do to its crate.

    Read before the task is completed. ``needs_decision`` is false for the
    overwhelming majority of tasks (no crate, or nothing left over) — the
    client only asks the question when it is true, so completing stays one
    click everywhere else.
    """

    box: TaskMaterialSettlementBoxOut | None = None
    lines: list[TaskMaterialSettlementLineOut] = Field(default_factory=list)
    remainder_total: int = 0
    # The crate never had its handover booked — completing it books that too.
    handover_pending: bool = False
    needs_decision: bool = False


class TaskMaterialSettlementResultOut(BaseModel):
    """What the completion actually did with the rest.

    The outcome, not the choice: a ``same_box`` asked for on a crate whose last
    line disappeared between the preview and the PATCH empties the crate
    instead, and the client has to be able to say so. Only present on the
    response to the PATCH that settled a crate.
    """

    disposition: Literal["shelf", "same_box", "new_box"]
    remainder_box_id: int | None = None
    remainder_box_number: str | None = None
    # The crate had never been booked out — completing it booked the handover.
    handover_booked: bool = False


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
    # The real box link. `storage_box_number` stays free-typed legacy data;
    # when both arrive, this one wins and overwrites the mirror.
    construction_box_id: int | None = None
    task_type: str = "construction"
    class_template_id: int | None = None
    status: str = "open"
    # Internal planning certainty — a third axis next to ``status``
    # (execution) and the customer confirmation (external yes/no):
    # "tentative" shows as "in Planung", "confirmed" as "bestätigt", None is
    # an ordinary task. Manager-only; the weekly-plan bulk create reuses
    # this schema, so it carries the field too.
    planning_status: Literal["tentative", "confirmed"] | None = None
    due_date: date | None = None
    # Last day of a multi-day task; None = single-day. Needs a due_date and
    # may not lie before it — checked below so the client sees a 422 with a
    # message instead of the DB CHECK's opaque IntegrityError.
    end_date: date | None = None
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

    @model_validator(mode="after")
    def _validate_date_range(self) -> "TaskCreate":
        validate_task_date_range(due_date=self.due_date, end_date=self.end_date)
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
    # The real box link. `storage_box_number` stays free-typed legacy data;
    # when both arrive, this one wins and overwrites the mirror.
    construction_box_id: int | None = None
    task_type: str | None = None
    class_template_id: int | None = None
    status: str | None = None
    # Absent = unchanged; an explicit null clears it. The router reads
    # ``model_fields_set`` to tell the two apart, as it does for every other
    # nullable field here. Not in the employee allow-list: managers only.
    planning_status: Literal["tentative", "confirmed"] | None = None
    due_date: date | None = None
    # Absent = unchanged, explicit null clears (same model_fields_set contract
    # as planning_status). The cross-field rule against due_date is checked
    # in the router, because only there is the task's FINAL due_date known.
    end_date: date | None = None
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
    # Where the crate's leftovers go when this PATCH completes the task.
    # Absent means "shelf" — the behaviour every client had before the
    # question existed. Read only on the transition into "done"; sending it
    # with any other change is ignored rather than refused, because the task
    # modal ships the whole form on every save.
    material_remainder: MaterialRemainderChoice | None = None

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
    # Denormalised so task lists can label the crate without a second call.
    construction_box_id: int | None = None
    construction_box_number: str | None = None
    construction_box_label: str | None = None
    construction_box_status: str | None = None
    task_type: str = "construction"
    class_template_id: int | None = None
    status: str
    # "tentative" | "confirmed" | None — see Task.planning_status.
    planning_status: str | None = None
    is_overdue: bool = False
    due_date: date | None = None
    # Last day of the window; None = single-day. is_overdue is computed
    # against this day, not due_date.
    end_date: date | None = None
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

    # The crate's contents, copied onto the task when a box is selected.
    # Empty for a task with no box, which is most of them.
    materials: list["TaskMaterialOut"] = []
    # How many files hang on the task (attachments with this ``task_id``), for
    # the paperclip badge. Lists get it batched from one grouped query
    # (``services.task_attachments``); a single-task response fetches its one
    # count. The files themselves come from GET /tasks/{id}/files.
    attachment_count: int = 0
    # Set only on the PATCH that completed a task and settled its crate, so
    # the client can phrase its notice from what happened rather than from
    # what was asked for. Absent everywhere else, including the SSE payload.
    material_settlement: TaskMaterialSettlementResultOut | None = None

    model_config = ConfigDict(from_attributes=True)


# ── v2.5.0 customer confirmation API shapes ──────────────────────────────


class CustomerConfirmationManualRequest(BaseModel):
    """Operator-driven manual confirmation (phone call, in-person nod, etc.).

    ``action`` is required so the same endpoint handles both confirm and
    decline. ``notes`` is optional context the operator wants to record
    alongside the timestamp (e.g. "Sprach mit Hr. Schmidt, kommt um 8").

    A note belongs to the verdict it was written for. Omitting ``notes``
    (or sending it empty) records this verdict WITHOUT a note and clears
    whatever the previous round left behind — a "Passt nicht" from a
    decline must not end up attached to the later "zugesagt". Sending a
    note replaces the stored one."""

    action: Literal["confirm", "decline"]
    method: Literal["phone", "manual"] = "phone"
    notes: str | None = None


class CustomerConfirmationEmailResult(BaseModel):
    """Response for the send-email / resend-email endpoint."""

    sent: bool
    sent_at: datetime | None = None
    error_detail: str | None = None
    # The send writes and commits — a success mints a token and stamps
    # the send time, a failure keeps the fresh round — so the task's
    # optimistic-lock token generally moves. Handing the task's current
    # value back lets the still-open modal keep its
    # ``expected_updated_at`` in step instead of 409-ing on the
    # operator's next Save. Response-only — no column behind it.
    updated_at: datetime | None = None


class PublicCustomerConfirmationOut(BaseModel):
    """Snapshot of a task surfaced on the unauthenticated /confirm/:token
    page. Only contains data the customer needs to make their decision;
    no internal IDs, no other-tasks-on-the-same-project leakage."""

    customer_name: str | None = None
    task_title: str
    task_description: str | None = None
    due_date: date | None = None
    # Set only for a multi-day appointment; the page then reads "vom … bis …".
    end_date: date | None = None
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
class TaskMaterialOut(BaseModel):
    """One material line on a task: what to bring, and what came back."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    item_name: str
    article_no: str | None = None
    ean: str | None = None
    unit: str | None = None
    quantity: int
    # None until a report says otherwise. A reported zero means "came back
    # untouched"; None means nobody has said yet, and the two must not be
    # rendered the same way.
    quantity_used: int | None = None
    article_id: int | None = None
    source_box_id: int | None = None
    notes: str | None = None
    # Set once the task was completed and the stock movements were booked.
    settled_at: datetime | None = None
