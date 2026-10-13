"""Shapes of the label-printer calibration API (docs/LABEL_PRINTER_CALIBRATION.md §6.4).

Input schemas that the admin edits (``MediaWebIO``, ``BaselineIn``,
``PrinterSettingsUpdate``, ``LabelMaterialUpdate``) carry TYPES only: a
pydantic range error would reach the user as FastAPI's English list, so
every range is checked in the service with the German texts. The session
inputs keep their constraints — the UI never lets them be violated.

The material/settings shapes that existed before (``LabelMaterialIn/Out``,
``LabelPrinterSettingsOut/Update``) stay in ``schemas/settings.py`` and
import the small shared models from here; nothing here imports that module.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

SensorMode = Literal["see_through", "reflective", "auto", "none"]
GuideSetting = Literal["max", "fit"]
FeedPath = Literal["internal", "external"]
Roller = Literal["258-5006", "258-5007"]
MediaType = Literal["gap", "mark", "continuous"]
WebSource = Literal["catalogue", "estimate", "measured"]
SessionMode = Literal["quick", "full"]
SessionPhase = Literal["open", "activated", "applied", "sensing", "sensed", "judged"]
Verdict = Literal["match", "mismatch", "other_material", "no_gap", "gap_on_continuous", "no_result", "unchecked", "printer_error"]
Freshness = Literal["busy_seen", "q_changed", "qd_changed", "none"]
SensorKind = Literal["see_through", "reflective", "unknown"]
Offer = Literal["save", "accept_anyway", "resense", "requery", "reapply", "switch_material"]
HintTopic = Literal["sensor_position", "sensor_mode", "geometry", "web", "roller", "printing"]


class MediaWebIO(BaseModel):  # ranges: "Rollenmaße ungültig" in validate_materials
    lanes: int = 1
    label_across_mm: float | None = None
    label_along_mm: float | None = None
    lane_gap_mm: float = 0.0
    liner_width_mm: float | None = None
    source: WebSource = "catalogue"


class OffsetLimitsOut(BaseModel):  # mm
    x_min: float
    x_max: float
    across_min: float
    across_max: float


class JobSettingsOut(BaseModel):
    darkness: int
    speed_ips: int
    stop_mm: int


class MaterialHintOut(BaseModel):
    topic: HintTopic
    text: str


class CalibrationSummaryOut(BaseModel):
    kind: SessionMode
    at: datetime
    by_name: str
    verdict: Verdict
    fresh: bool
    accepted: bool
    stale: bool  # derived: the profile's fingerprint changed since the record
    measured_length_mm: float | None
    measured_gap_mm: float | None
    notes: str = ""


class LastAppliedOut(BaseModel):
    material_id: str
    at: datetime
    by_name: str
    commands: list[str]
    confirmed: bool | None


class SessionInfoOut(BaseModel):
    """What anyone may see about the current session."""

    mode: SessionMode
    material_id: str
    user_name: str
    acquired_at: datetime
    expires_at: datetime
    mine: bool
    session_id: str | None = None  # only when mine


class LabelMaterialUpdate(BaseModel):
    """PUT …/materials/{id}; ``exclude_unset``; types only."""

    revision: int
    name: str | None = None
    part_no: str | None = None
    width_mm: float | None = None
    length_mm: float | None = None  # explicit null = continuous
    gap_mm: float | None = None
    x_offset_mm: float | None = None
    across_offset_mm: float | None = None
    darkness: int | None = None  # explicit null = baseline
    speed_ips: int | None = None  # explicit null = baseline
    stop_mm: int | None = None  # explicit null = baseline
    sensor_mode: SensorMode | None = None
    sensor_scale: float | None = None  # 0.5–5.5 and rounding in validate_materials
    guide: GuideSetting | None = None
    feed_path: FeedPath | None = None
    roller: Roller | None = None
    mark_width_mm: float | None = None  # explicit null = no black mark
    mark_offset_mm: float | None = None
    mark_inside: bool | None = None
    web: MediaWebIO | None = None  # replaces web as a whole
    reset_fields: list[str] = Field(default_factory=list)  # builtins only


class BaselineIn(BaseModel):  # exclude_unset; explicit null = back to the code default; types only
    darkness: int | None = None
    speed_ips: int | None = None
    stop_mm: int | None = None


class PrinterSettingsUpdate(BaseModel):  # PUT …/printer; exclude_unset; types only
    revision: int
    baseline: BaselineIn | None = None
    row_offset_dots: int | None = None  # explicit null = unpin
    label_calibration_staff_enabled: bool | None = None  # null/absent = keep


class PrinterWarningOut(BaseModel):
    code: Literal["row_offset_drift", "direct_thermal", "sensor_mismatch", "incomplete_reply", "resolution_unexpected", "error_pushed"]
    message: str


class PrinterConfigOut(BaseModel):
    complete: bool
    firmware: str | None = None
    sensor_kind: SensorKind = "unknown"
    sensor_line: str | None = None
    measured_length_dots: int | None = None
    measured_gap_dots: int | None = None
    measured_pitch_dots: int | None = None
    stored_q: str | None = None
    width_mm: float | None = None
    darkness: int | None = None
    speed_ips: int | None = None
    stop_mm: int | None = None
    left_margin_dots: int | None = None
    row_offset_dots: int | None = None
    print_mode: Literal["thermal_transfer", "direct_thermal"] | None = None
    resolution_dpi: int | None = None


class PrinterStatusOut(BaseModel):
    printer: str
    answered: bool
    code: str | None
    code_text: str
    action_text: str = ""
    ready: bool
    pending: int | None
    config: PrinterConfigOut | None = None  # full=true and CONFIG replied
    raw_config: str | None = None  # full=true, settings:manage only; ≤ 8000 chars
    warnings: list[PrinterWarningOut] = Field(default_factory=list)
    errors_seen: list[str] = Field(default_factory=list)


class SessionStartIn(BaseModel):
    mode: SessionMode
    material_id: str = Field(min_length=1, max_length=40)
    takeover: bool = False


class SessionOut(BaseModel):
    session_id: str
    mode: SessionMode
    material_id: str
    phase: SessionPhase
    user_name: str
    acquired_at: datetime
    expires_at: datetime
    applied: bool  # apply exists and apply.material_id == material_id
    sensed: bool  # a sensing run exists
    verdict: Verdict | None  # verify.verdict; null after activate / new autosense
    config_revision: int  # configuration revision after this call


class ActivateIn(BaseModel):
    material_id: str = Field(min_length=1, max_length=40)


class ApplyOut(BaseModel):
    printer: str
    commands: list[str]
    confirmed: bool | None
    mismatches: list[str] = Field(default_factory=list)
    config: PrinterConfigOut | None = None
    session: SessionOut


class FeedConfirmIn(BaseModel):
    confirm_feed: bool = False  # the server never assumes consent


class AutosenseIn(FeedConfirmIn):
    method: Literal["command", "button"] = "command"


class PresenseOut(BaseModel):
    stored_q: str | None
    measured_length_dots: int | None
    measured_gap_dots: int | None
    apply_confirmed: bool | None


class AutosenseOut(BaseModel):
    printer: str
    method: Literal["command", "button"]
    cost_hint: str
    status_answered: bool  # false only for method "button" with a silent STATUS
    presense: PresenseOut | None
    session: SessionOut


class SensePollOut(BaseModel):
    phase: Literal["sensing", "done", "error", "timeout"]
    answered: bool  # STATUS replied to this poll (replays: the stored result's)
    code: str | None
    code_text: str  # printer status text
    message: str = ""  # SMPL's own text: no reply, slow, timeout, unknown code
    saw_busy: bool
    elapsed_s: float
    session: SessionOut


class VerdictOut(BaseModel):
    material_id: str
    verdict: Verdict
    title: str
    detail: str
    notes: list[str] = Field(default_factory=list)
    fresh: bool
    freshness: Freshness  # latched.freshness whenever a latch exists
    from_latch: bool  # judged a measurement latched by an earlier verify
    dots_per_mm: float = 12.0
    expected_length_mm: float | None
    expected_gap_mm: float | None
    expected_pitch_mm: float | None
    measured_length_mm: float | None
    measured_gap_mm: float | None
    measured_pitch_mm: float | None
    measured_length_dots: int | None
    measured_gap_dots: int | None
    delta_length_mm: float | None
    delta_pitch_mm: float | None
    tolerance_mm: float | None
    sensor_kind: SensorKind
    sensor_expected: Literal["see_through", "reflective"] | None
    sensor_ok: bool | None
    suggested_material_ids: list[str] = Field(default_factory=list)
    status_code: str | None
    status_text: str
    offers: list[Offer]
    warnings: list[PrinterWarningOut] = Field(default_factory=list)
    session: SessionOut


class PatternGeometryOut(BaseModel):
    kind: Literal["diecut", "continuous"]
    width_mm: float
    length_mm: float
    inset_mm: float
    line_mm: float = 0.25
    letters: bool
    ruler_from_mm: int | None
    ruler_to_mm: int | None
    side_line_inset_mm: float | None
    bar_inset_mm: float | None
    feed_measurable: bool
    across_measurable: bool


class PatternOut(BaseModel):
    printer: str
    cost_hint: str
    geometry: PatternGeometryOut
    x_offset_mm: float
    across_offset_mm: float
    session: SessionOut


class PatternMeasurementsIn(BaseModel):
    lead_mm: float | None = Field(None, ge=0, le=30)
    trail_mm: float | None = Field(None, ge=0, le=30)
    left_mm: float | None = Field(None, ge=0, le=30)
    right_mm: float | None = Field(None, ge=0, le=30)
    ruler_nominal_mm: int | None = Field(None, ge=10, le=750)
    ruler_measured_mm: float | None = Field(None, gt=0, le=800)


class CalibrationSaveIn(BaseModel):
    notes: str = Field("", max_length=200)
    accept_verdict: bool = False
    pattern: PatternMeasurementsIn | None = None


class CalibrationRecordOut(BaseModel):
    """The stored record plus the derived ``stale``."""

    material_id: str
    kind: SessionMode
    at: datetime
    by_name: str
    verdict: Verdict
    fresh: bool
    freshness: Freshness
    accepted: bool
    stale: bool
    measured_length_dots: int | None
    measured_gap_dots: int | None
    measured_pitch_dots: int | None
    sensor_kind: SensorKind
    firmware: str | None
    row_offset_dots: int | None
    pattern: PatternMeasurementsIn | None
    changes: dict[str, dict[str, float | int | None]]
    notes: str
