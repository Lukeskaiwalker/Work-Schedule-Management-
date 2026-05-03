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


class OpenAISettingsOut(BaseModel):
    """Read shape for the OpenAI runtime settings.

    The api_key is masked (last 4 chars only) so the admin UI can confirm a
    key is configured without leaking it. ``configured`` is a quick boolean
    for the green/grey dot on the settings page.
    """

    provider: str = "openai"
    configured: bool = False
    masked_api_key: str = ""
    extraction_model: str = "gpt-4o-mini"


class OpenAISettingsUpdate(BaseModel):
    """Write shape for the OpenAI runtime settings.

    ``clear_api_key`` lets the admin explicitly blank the stored key (e.g.
    after a leak). When False *and* ``api_key`` is empty the existing key is
    kept — preventing accidental wipes when the form is submitted with the
    masked placeholder still in the input.
    """

    api_key: str = ""
    clear_api_key: bool = False
    extraction_model: str = "gpt-4o-mini"


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


class SmtpTestRequest(BaseModel):
    """Admin-triggered test send. `to_email` is optional — when omitted, the
    test is sent to the admin's own account."""

    to_email: EmailStr | str | None = None


class SmtpTestResultOut(BaseModel):
    ok: bool
    error_type: str | None = None
    error_detail: str | None = None
    to_email: str


class CompanySettingsOut(BaseModel):
    logo_url: str = ""
    navigation_title: str = "SMPL"
    company_name: str = "SMPL"
    company_address: str = ""


class CompanySettingsUpdate(BaseModel):
    logo_url: str = ""
    navigation_title: str = "SMPL"
    company_name: str = "SMPL"
    company_address: str = ""


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
    # When the install was delegated to the update_runner sidecar, ``async_mode``
    # is True and ``job_id`` carries the runner-side handle the UI polls via
    # /admin/updates/progress/{job_id}. For dry runs and the legacy in-process
    # flow these fields stay None for backward compatibility.
    async_mode: bool = False
    job_id: str | None = None


class UpdateProgressOut(BaseModel):
    """Snapshot of an in-flight (or finished) update job, proxied from the
    update_runner sidecar. Status values mirror the runner's vocabulary:
    ``queued`` | ``running`` | ``succeeded`` | ``failed``.
    """

    job_id: str
    kind: str
    status: str
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    detail: str | None = None
    log_tail: str = ""


class ActiveUpdateJobOut(BaseModel):
    """v2.4.6 — cross-admin visibility snapshot for any in-flight
    runner-mediated update. ``job_id`` is null when no job is active;
    when set, the polling-progress endpoint above can be hit by ANY
    admin (not just the one who clicked Install) to attach to the
    same in-flight job. ``started_by_display_name`` lets the UI
    render "Lukas is installing v2.4.6…" rather than just "an update
    is in progress."
    """

    job_id: str | None = None
    started_at: str | None = None
    started_by_user_id: int | None = None
    started_by_display_name: str | None = None
