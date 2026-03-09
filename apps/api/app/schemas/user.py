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
    nickname: str | None = None
    display_name: str
    nickname_set_at: datetime | None = None
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
    nickname: str | None = None
    display_name: str
    role: str
    required_daily_hours: float = 8
    avatar_updated_at: datetime | None = None

    model_config = ConfigDict(from_attributes=True)


class ProfileUpdate(BaseModel):
    full_name: str | None = None
    email: EmailStr | None = None
    nickname: str | None = None
    current_password: str | None = None
    new_password: str | None = Field(default=None, min_length=8)


class NicknameAvailabilityOut(BaseModel):
    nickname: str
    available: bool
    locked: bool = False
    reason: str | None = None
