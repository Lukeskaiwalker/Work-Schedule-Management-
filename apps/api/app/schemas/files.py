from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class ProjectFolderCreate(BaseModel):
    path: str = Field(min_length=1, max_length=500)


class ProjectFolderOut(BaseModel):
    path: str
    is_protected: bool = False
