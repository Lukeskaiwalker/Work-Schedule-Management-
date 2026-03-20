from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class EmployeeGroupMemberOut(BaseModel):
    user_id: int
    full_name: str
    display_name: str
    is_active: bool


class EmployeeGroupOut(BaseModel):
    id: int
    name: str
    can_update_recent_own_time_entries: bool = False
    member_user_ids: list[int] = Field(default_factory=list)
    members: list[EmployeeGroupMemberOut] = Field(default_factory=list)


class EmployeeGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    can_update_recent_own_time_entries: bool = False
    member_user_ids: list[int] = Field(default_factory=list)


class EmployeeGroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    can_update_recent_own_time_entries: bool | None = None
    member_user_ids: list[int] | None = None
