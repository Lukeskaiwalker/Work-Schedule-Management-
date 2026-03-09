from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

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
    site_access_type: str | None = None
    site_access_note: str | None = None
    extra_attributes: dict[str, Any] = Field(default_factory=dict)
    class_template_ids: list[int] = Field(default_factory=list)


class ProjectUpdate(BaseModel):
    expected_last_updated_at: datetime | None = None
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
    site_access_type: str | None = None
    site_access_note: str | None = None
    extra_attributes: dict[str, Any] | None = None
    class_template_ids: list[int] | None = None


class ProjectOut(BaseModel):
    id: int
    project_number: str
    name: str
    description: str | None = None
    status: str
    last_state: str | None = None
    last_status_at: datetime | None = None
    last_updated_at: datetime | None = None
    customer_name: str | None = None
    customer_address: str | None = None
    customer_contact: str | None = None
    customer_email: str | None = None
    customer_phone: str | None = None
    site_access_type: str | None = None
    site_access_note: str | None = None
    extra_attributes: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(from_attributes=True)


class ProjectFinanceUpdate(BaseModel):
    expected_updated_at: datetime | None = None
    order_value_net: float | None = None
    down_payment_35: float | None = None
    main_components_50: float | None = None
    final_invoice_15: float | None = None
    planned_costs: float | None = None
    actual_costs: float | None = None
    contribution_margin: float | None = None
    planned_hours_total: float | None = Field(default=None, ge=0)


class ProjectFinanceOut(BaseModel):
    project_id: int
    order_value_net: float | None = None
    down_payment_35: float | None = None
    main_components_50: float | None = None
    final_invoice_15: float | None = None
    planned_costs: float | None = None
    actual_costs: float | None = None
    contribution_margin: float | None = None
    reported_hours_total: float = 0
    planned_hours_total: float | None = None
    updated_by: int | None = None
    updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class ProjectActivityOut(BaseModel):
    id: int
    project_id: int
    actor_user_id: int | None = None
    actor_name: str | None = None
    event_type: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class ProjectOfficeNoteOut(BaseModel):
    report_id: int
    report_number: int | None = None
    report_date: date
    created_at: datetime
    office_rework: str | None = None
    office_next_steps: str | None = None


class ProjectOverviewOut(BaseModel):
    project: ProjectOut
    open_tasks: int = 0
    my_open_tasks: int = 0
    finance: ProjectFinanceOut
    office_notes: list[ProjectOfficeNoteOut] = Field(default_factory=list)
    recent_changes: list[ProjectActivityOut] = Field(default_factory=list)


class ProjectWeatherDayOut(BaseModel):
    date: date
    temp_min: float | None = None
    temp_max: float | None = None
    description: str | None = None
    icon: str | None = None
    precipitation_probability: float | None = None
    wind_speed: float | None = None


class ProjectWeatherOut(BaseModel):
    project_id: int
    provider: str = "openweather"
    query_address: str
    fetched_at: datetime | None = None
    next_refresh_at: datetime | None = None
    stale: bool = False
    from_cache: bool = False
    can_refresh: bool = False
    message: str | None = None
    days: list[ProjectWeatherDayOut] = Field(default_factory=list)


class ProjectClassTaskTemplateOut(BaseModel):
    title: str
    description: str | None = None
    task_type: str = "construction"


class ProjectClassTemplateOut(BaseModel):
    id: int
    name: str
    materials_required: str | None = None
    tools_required: str | None = None
    task_templates: list[ProjectClassTaskTemplateOut] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class ProjectImportStatsOut(BaseModel):
    processed_rows: int
    created: int
    updated: int
    temporary_numbers: int
    duplicates_skipped: int
