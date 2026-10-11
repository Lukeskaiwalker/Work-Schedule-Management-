from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class ProjectFolderCreate(BaseModel):
    path: str = Field(min_length=1, max_length=500)


class ProjectFolderOut(BaseModel):
    path: str
    is_protected: bool = False
    # The files in it are readable by the project's partners in their portal
    # (the ``Partnerportal`` folder and everything below it).
    portal_shared: bool = False
