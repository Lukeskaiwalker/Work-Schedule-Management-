from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class TaskCreate(BaseModel):
    project_id: int
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
    assignee_id: int | None = None
    assignee_ids: list[int] = Field(default_factory=list)
    week_start: date | None = None


class TaskUpdate(BaseModel):
    expected_updated_at: datetime | None = None
    title: str | None = None
    description: str | None = None
    subtasks: list[str] | None = None
    materials_required: str | None = None
    storage_box_number: int | None = Field(default=None, ge=1)
    task_type: str | None = None
    class_template_id: int | None = None
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
    subtasks: list[str] = Field(default_factory=list)
    materials_required: str | None = None
    storage_box_number: int | None = None
    task_type: str = "construction"
    class_template_id: int | None = None
    status: str
    is_overdue: bool = False
    due_date: date | None = None
    start_time: time | None = None
    assignee_id: int | None = None
    assignee_ids: list[int] = Field(default_factory=list)
    week_start: date | None = None
    updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


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
