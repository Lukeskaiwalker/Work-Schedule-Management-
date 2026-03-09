from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

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
    source_task_id: int | None = None
    completed_subtasks: list[str] = Field(default_factory=list)


class ConstructionReportCreate(BaseModel):
    project_id: int | None = None
    report_date: date
    payload: ConstructionReportPayload
    send_telegram: bool = False


class RecentConstructionReportOut(BaseModel):
    id: int
    project_id: int | None = None
    report_number: int | None = None
    user_id: int | None = None
    user_display_name: str | None = None
    project_number: str | None = None
    project_name: str | None = None
    report_date: date
    created_at: datetime
    processing_status: str
    attachment_file_name: str | None = None
    attachment_id: int | None = None
