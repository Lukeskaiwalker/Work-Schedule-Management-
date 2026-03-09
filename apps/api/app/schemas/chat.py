from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class ThreadCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    project_id: int | None = None
    site_id: int | None = None
    participant_user_ids: list[int] = Field(default_factory=list)
    participant_roles: list[str] = Field(default_factory=list)
    participant_group_ids: list[int] = Field(default_factory=list)


class ThreadUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    project_id: int | None = None
    participant_user_ids: list[int] | None = None
    participant_roles: list[str] | None = None
    participant_group_ids: list[int] | None = None


class ThreadOut(BaseModel):
    id: int
    name: str
    visibility: str = "public"
    status: str = "active"
    is_restricted: bool = False
    is_archived: bool = False
    created_by: int | None = None
    project_id: int | None = None
    project_name: str | None = None
    site_id: int | None = None
    icon_updated_at: datetime | None = None
    participant_user_ids: list[int] = Field(default_factory=list)
    participant_roles: list[str] = Field(default_factory=list)
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
