from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

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
