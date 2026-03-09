from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

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
