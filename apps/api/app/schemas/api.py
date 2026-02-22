from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    full_name: str
    role: str = "employee"


class UserUpdate(BaseModel):
    full_name: str | None = None
    role: str | None = None
    is_active: bool | None = None
    required_daily_hours: float | None = Field(default=None, ge=1, le=24)


class UserOut(BaseModel):
    id: int
    email: str
    full_name: str
    role: str
    is_active: bool
    required_daily_hours: float = 8
    avatar_updated_at: datetime | None = None
    invite_sent_at: datetime | None = None
    invite_accepted_at: datetime | None = None
    password_reset_sent_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class AssignableUserOut(BaseModel):
    id: int
    full_name: str
    role: str
    required_daily_hours: float = 8
    avatar_updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class ProjectCreate(BaseModel):
    project_number: str = Field(min_length=1, max_length=64)
    name: str
    description: str | None = None
    status: str = "active"
    last_state: str | None = None
    last_status_at: datetime | None = None
    customer_name: str | None = None
    customer_address: str | None = None
    customer_contact: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    extra_attributes: dict[str, Any] = Field(default_factory=dict)


class ProjectUpdate(BaseModel):
    project_number: str | None = Field(default=None, min_length=1, max_length=64)
    name: str | None = None
    description: str | None = None
    status: str | None = None
    last_state: str | None = None
    last_status_at: datetime | None = None
    customer_name: str | None = None
    customer_address: str | None = None
    customer_contact: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    extra_attributes: dict[str, Any] | None = None


class ProjectOut(BaseModel):
    id: int
    project_number: str
    name: str
    description: str | None = None
    status: str
    last_state: str | None = None
    last_status_at: datetime | None = None
    customer_name: str | None = None
    customer_address: str | None = None
    customer_contact: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    extra_attributes: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(from_attributes=True)


class TaskCreate(BaseModel):
    project_id: int
    title: str
    description: str | None = None
    materials_required: str | None = None
    storage_box_number: int | None = Field(default=None, ge=1)
    status: str = "open"
    due_date: date | None = None
    start_time: time | None = None
    assignee_id: int | None = None
    assignee_ids: list[int] = Field(default_factory=list)
    week_start: date | None = None


class TaskUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    materials_required: str | None = None
    storage_box_number: int | None = Field(default=None, ge=1)
    status: str | None = None
    due_date: date | None = None
    start_time: time | None = None
    assignee_id: int | None = None
    assignee_ids: list[int] | None = None
    week_start: date | None = None


class TaskOut(BaseModel):
    id: int
    project_id: int
    title: str
    description: str | None = None
    materials_required: str | None = None
    storage_box_number: int | None = None
    status: str
    due_date: date | None = None
    start_time: time | None = None
    assignee_id: int | None = None
    assignee_ids: list[int] = Field(default_factory=list)
    week_start: date | None = None

    model_config = ConfigDict(from_attributes=True)


class ProjectFolderCreate(BaseModel):
    path: str = Field(min_length=1, max_length=500)


class ProjectFolderOut(BaseModel):
    path: str
    is_protected: bool = False


class ProjectImportStatsOut(BaseModel):
    processed_rows: int
    created: int
    updated: int
    temporary_numbers: int
    duplicates_skipped: int


class SiteCreate(BaseModel):
    name: str
    address: str


class SiteOut(BaseModel):
    id: int
    project_id: int
    name: str
    address: str

    model_config = ConfigDict(from_attributes=True)


class JobTicketCreate(BaseModel):
    site_id: int | None = None
    title: str
    site_address: str
    ticket_date: date
    assigned_crew: list[str] = []
    checklist: list[dict[str, Any]] = []
    notes: str | None = None


class JobTicketOut(BaseModel):
    id: int
    project_id: int
    site_id: int | None = None
    title: str
    site_address: str
    ticket_date: date
    assigned_crew: list[str]
    checklist: list[dict[str, Any]]
    notes: str | None = None

    model_config = ConfigDict(from_attributes=True)


class ThreadCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    project_id: int | None = None
    site_id: int | None = None


class ThreadUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    project_id: int | None = None


class ThreadOut(BaseModel):
    id: int
    name: str
    created_by: int | None = None
    project_id: int | None = None
    project_name: str | None = None
    site_id: int | None = None
    icon_updated_at: datetime | None = None
    message_count: int = 0
    unread_count: int = 0
    last_message_at: datetime | None = None
    last_message_preview: str | None = None
    can_edit: bool = False


class MessageCreate(BaseModel):
    body: str | None = None


class MessageAttachmentOut(BaseModel):
    id: int
    file_name: str
    content_type: str
    created_at: datetime


class MessageOut(BaseModel):
    id: int
    thread_id: int
    sender_id: int
    body: str | None = None
    created_at: datetime
    attachments: list[MessageAttachmentOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class WikiPageCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    category: str | None = Field(default=None, max_length=120)
    content: str = ""


class WikiPageUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    category: str | None = Field(default=None, max_length=120)
    content: str | None = None


class WikiPageOut(BaseModel):
    id: int
    title: str
    slug: str
    category: str | None = None
    content: str
    created_by: int | None = None
    updated_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class WikiLibraryFileOut(BaseModel):
    path: str
    brand: str
    folder: str
    stem: str
    extension: str
    file_name: str
    mime_type: str
    previewable: bool = False
    size_bytes: int
    modified_at: datetime


class ConstructionReportWorker(BaseModel):
    name: str
    start_time: str | None = None
    end_time: str | None = None


class ConstructionReportMaterial(BaseModel):
    item: str
    qty: str | None = None
    unit: str | None = None
    article_no: str | None = None


class ConstructionReportExtra(BaseModel):
    description: str
    reason: str | None = None


class ConstructionReportPayload(BaseModel):
    customer: str | None = None
    customer_address: str | None = None
    customer_contact: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    project_name: str | None = None
    project_number: str | None = None
    workers: list[ConstructionReportWorker] = Field(default_factory=list)
    materials: list[ConstructionReportMaterial] = Field(default_factory=list)
    extras: list[ConstructionReportExtra] = Field(default_factory=list)
    work_done: str | None = None
    incidents: str | None = None
    office_material_need: str | None = None
    office_rework: str | None = None
    office_next_steps: str | None = None


class ConstructionReportCreate(BaseModel):
    project_id: int | None = None
    report_date: date
    payload: ConstructionReportPayload
    send_telegram: bool = False


class ClockOut(BaseModel):
    clock_entry_id: int


class BreakAction(BaseModel):
    clock_entry_id: int


class TimesheetOut(BaseModel):
    user_id: int
    total_hours: float
    period_start: date
    period_end: date


class TimeCurrentOut(BaseModel):
    server_time: datetime
    clock_entry_id: int | None = None
    clock_in: datetime | None = None
    break_open: bool = False
    worked_hours_live: float = 0
    break_hours_live: float = 0
    required_break_hours_live: float = 0
    deducted_break_hours_live: float = 0
    net_hours_live: float = 0
    required_daily_hours: float = 8
    daily_net_hours: float = 0
    progress_percent_live: float = 0


class TimeEntryOut(BaseModel):
    id: int
    user_id: int
    clock_in: datetime
    clock_out: datetime | None = None
    is_open: bool
    break_hours: float
    required_break_hours: float
    deducted_break_hours: float
    net_hours: float


class TimeEntryUpdate(BaseModel):
    clock_in: datetime
    clock_out: datetime | None = None
    break_minutes: int = Field(default=0, ge=0, le=720)


class RequiredDailyHoursUpdate(BaseModel):
    required_daily_hours: float = Field(ge=1, le=24)


class RequiredDailyHoursOut(BaseModel):
    user_id: int
    required_daily_hours: float


class VacationRequestCreate(BaseModel):
    start_date: date
    end_date: date
    note: str | None = None


class VacationRequestReview(BaseModel):
    status: str = Field(pattern="^(approved|rejected)$")


class VacationRequestOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    start_date: date
    end_date: date
    note: str | None = None
    status: str
    reviewed_by: int | None = None
    reviewed_at: datetime | None = None
    created_at: datetime


class SchoolAbsenceCreate(BaseModel):
    user_id: int
    title: str = Field(default="Berufsschule", min_length=1, max_length=255)
    start_date: date
    end_date: date
    recurrence_weekday: int | None = Field(default=None, ge=0, le=6)
    recurrence_until: date | None = None


class SchoolAbsenceOut(BaseModel):
    id: int
    user_id: int
    user_name: str
    title: str
    start_date: date
    end_date: date
    recurrence_weekday: int | None = None
    recurrence_until: date | None = None
    created_by: int | None = None
    created_at: datetime


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


class ProfileUpdate(BaseModel):
    full_name: str | None = None
    email: EmailStr | None = None
    current_password: str | None = None
    new_password: str | None = Field(default=None, min_length=8)


class InviteCreate(BaseModel):
    email: EmailStr
    full_name: str
    role: str = "employee"


class InviteDispatchOut(BaseModel):
    ok: bool = True
    user_id: int
    email: str
    sent: bool
    invite_link: str
    expires_at: datetime


class PasswordResetDispatchOut(BaseModel):
    ok: bool = True
    user_id: int
    email: str
    sent: bool
    reset_link: str
    expires_at: datetime


class InviteAccept(BaseModel):
    token: str
    new_password: str = Field(min_length=8)
    full_name: str | None = None
    email: EmailStr | None = None


class PasswordResetConfirm(BaseModel):
    token: str
    new_password: str = Field(min_length=8)
