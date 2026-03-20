from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field

class WeatherSettingsOut(BaseModel):
    provider: str = "openweather"
    configured: bool = False
    masked_api_key: str = ""


class WeatherSettingsUpdate(BaseModel):
    api_key: str = ""


class SmtpSettingsOut(BaseModel):
    host: str = ""
    port: int = 587
    username: str = ""
    has_password: bool = False
    masked_password: str = ""
    starttls: bool = True
    ssl: bool = False
    from_email: str = ""
    from_name: str = ""
    configured: bool = False


class SmtpSettingsUpdate(BaseModel):
    host: str = ""
    port: int = Field(default=587, ge=1, le=65535)
    username: str = ""
    password: str = ""
    clear_password: bool = False
    starttls: bool = True
    ssl: bool = False
    from_email: EmailStr | str = ""
    from_name: str = ""


class UpdateStatusOut(BaseModel):
    repository: str
    branch: str
    current_version: str | None = None
    current_commit: str | None = None
    latest_version: str | None = None
    latest_commit: str | None = None
    latest_published_at: datetime | None = None
    latest_url: str | None = None
    update_available: bool | None = None
    install_supported: bool = False
    install_mode: str = "manual"
    install_steps: list[str] = Field(default_factory=list)
    message: str | None = None


class UpdateInstallRequest(BaseModel):
    dry_run: bool = False


class UpdateInstallOut(BaseModel):
    ok: bool = False
    mode: str = "manual"
    detail: str
    ran_steps: list[str] = Field(default_factory=list)
    dry_run: bool = False
