from __future__ import annotations
from datetime import date, datetime, time
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.schemas.label_printer import (
    CalibrationSummaryOut,
    FeedPath,
    GuideSetting,
    JobSettingsOut,
    LastAppliedOut,
    MaterialHintOut,
    MediaType,
    MediaWebIO,
    OffsetLimitsOut,
    Roller,
    SensorMode,
    SessionInfoOut,
)

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
    company_phone: str = ""
    company_email: str = ""


class CompanySettingsUpdate(BaseModel):
    logo_url: str = ""
    navigation_title: str = "SMPL"
    company_name: str = "SMPL"
    company_address: str = ""
    # None keeps what is stored, so a client that predates these two fields
    # does not wipe them by saving the other four; "" clears.
    company_phone: str | None = Field(default=None, max_length=64)
    company_email: str | None = Field(default=None, max_length=255)


class LabelMaterialOut(BaseModel):
    """One printable stock the workshop owns, plus derived facts.

    ``darkness``/``speed_ips``/``stop_mm`` are the STORED overrides (None =
    the printer baseline); what jobs send is ``resolved``. Echoing this object
    back in a PATCH therefore cannot freeze the baseline into the profile.
    """

    id: str
    name: str
    part_no: str = ""
    width_mm: float
    length_mm: float | None = None  # None = continuous (tape, shrink tube)
    gap_mm: float = 3.0
    x_offset_mm: float = 2.0
    darkness: int | None = None
    builtin: bool = False
    tier: str = "mini"
    continuous: bool = False
    media_type: MediaType = "gap"
    across_offset_mm: float = 0.0
    speed_ips: int | None = None
    stop_mm: int | None = None
    resolved: JobSettingsOut
    mark_width_mm: float | None = None
    mark_offset_mm: float = 0.0
    mark_inside: bool = False
    sensor_mode: SensorMode
    sensor_scale: float  # reading on the housing scale, 0.5–5.5, 3.0 = centre
    guide: GuideSetting
    feed_path: FeedPath
    roller: Roller
    web: MediaWebIO
    web_width_mm: float
    overridden_fields: list[str] = Field(default_factory=list)
    hints: list[MaterialHintOut] = Field(default_factory=list)
    calibration: CalibrationSummaryOut | None = None
    autosense_cost_hint: str
    pattern_cost_hint: str  # "" when pattern_supported is false
    pattern_supported: bool
    offset_limits: OffsetLimitsOut


class LabelMaterialIn(BaseModel):
    """One item of the PATCH list; ``builtin``/``tier`` and the other derived
    fields are ignored. Types only — every range and length check is in
    ``validate_materials``, so the user reads it in German. Fields in
    ``model_fields_set`` are merged; an explicit null on a non-nullable field
    keeps the stored value."""

    id: str
    name: str
    part_no: str = ""
    width_mm: float
    length_mm: float | None = None
    gap_mm: float = 3.0
    x_offset_mm: float = 2.0
    darkness: int | None = None
    across_offset_mm: float | None = None
    speed_ips: int | None = None
    stop_mm: int | None = None
    mark_width_mm: float | None = None
    mark_offset_mm: float | None = None
    mark_inside: bool | None = None
    sensor_mode: SensorMode | None = None
    sensor_scale: float | None = None
    guide: GuideSetting | None = None
    feed_path: FeedPath | None = None
    roller: Roller | None = None
    web: MediaWebIO | None = None


class LabelPrinterSettingsOut(BaseModel):
    """Werkstatt label printer config as the admin UI sees it.

    ``source`` says where the effective address came from: ``runtime`` (set in
    this UI), ``env`` (deployment variables), or ``none`` (printing disabled).
    The active material mirrors what is physically loaded in the printer.
    """

    host: str = ""
    port: int = 9100
    configured: bool = False
    source: str = "none"
    materials: list[LabelMaterialOut] = Field(default_factory=list)
    active_material_id: str = ""
    active_material_name: str = ""
    active_tier: str = ""
    revision: int = 0
    baseline: JobSettingsOut
    baseline_overridden: list[str] = Field(default_factory=list)
    row_offset_dots: int | None = None
    label_calibration_staff_enabled: bool = False
    session: SessionInfoOut | None = None
    last_applied: LastAppliedOut | None = None


class LabelPrinterSettingsUpdate(BaseModel):
    """Every field optional: an omitted field keeps the stored value, so the
    address form and the material picker can PATCH independently without
    clobbering each other. ``host: ""`` clears the runtime address (falls back
    to env, if set). ``revision`` is an optional compare-and-set (old cached
    bundles send none; the revision still increments)."""

    host: str | None = None
    port: int | None = Field(default=None, ge=1, le=65535)
    materials: list[LabelMaterialIn] | None = None
    active_material_id: str | None = None
    revision: int | None = None


class LabelPrinterOverviewOut(BaseModel):
    """GET /api/werkstatt/label-printer — DB only, no printer I/O."""

    configured: bool
    printer: str  # "host:port" or ""
    active_material_id: str
    active_material_name: str
    materials: list[LabelMaterialOut]
    session: SessionInfoOut | None
    last_applied: LastAppliedOut | None
    can_full: bool  # caller holds settings:manage
    staff_enabled: bool  # label_calibration_staff_enabled


class LabelPrinterTestOut(BaseModel):
    ok: bool
    printer: str = ""
    detail: str = ""


class LabelFreetextPayload(BaseModel):
    """Free text for continuous stock (marking strips, shrink tube)."""

    text: str = Field(min_length=1, max_length=120)
    copies: int = Field(default=1, ge=1, le=50)

    @field_validator("text")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Text fehlt")
        return stripped


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
