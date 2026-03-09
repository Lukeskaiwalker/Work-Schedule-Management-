from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

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
