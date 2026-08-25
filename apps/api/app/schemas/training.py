"""Schemas for the Ausbildungsnachweis (apprentice weekly training report).

Own module rather than an addition to ``schemas/api.py``: that file carries
uncommitted work-in-progress from another feature, and this domain is
self-contained anyway.

Validation posture: hours are the only numbers on the sheet, and they are the
ones the IHK actually checks against the training contract — so they are
bounded here (0..24 per entry, quarter-steps not enforced). Text is the
apprentice's own record; it is length-capped but otherwise theirs.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

TrainingReportStatus = Literal["draft", "submitted", "signed"]
# The three columns of the IHK form.
TrainingEntryCategory = Literal["betrieb", "unterweisung", "schule"]


class TrainingDayEntry(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    hours: float = Field(ge=0, le=24)
    category: TrainingEntryCategory = "betrieb"

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, value: str) -> str:
        # min_length alone lets " " through; the router then strips it to ""
        # and the stored row fails response validation forever after — a
        # poisoned report that 500s every list. Reject at the boundary.
        stripped = value.strip()
        if not stripped:
            raise ValueError("Der Text darf nicht leer sein.")
        return stripped


class TrainingReportDay(BaseModel):
    day: date
    entries: list[TrainingDayEntry] = Field(default_factory=list, max_length=20)


class TrainingReportCreate(BaseModel):
    # Any day of the wanted week; normalized to its Monday server-side.
    week_start: date
    # None (not 1) so "field omitted" is distinguishable from "Jahr 1" — the
    # router falls back to computing the year from training_started_on, which
    # a truthy default would silently disable.
    ausbildungsjahr: int | None = Field(default=None, ge=1, le=5)
    days: list[TrainingReportDay] = Field(default_factory=list, max_length=7)
    remarks: str | None = Field(default=None, max_length=2000)


class TrainingReportUpdate(BaseModel):
    """Drafts only; the router enforces the status gate."""

    ausbildungsjahr: int | None = Field(default=None, ge=1, le=5)
    days: list[TrainingReportDay] | None = Field(default=None, max_length=7)
    remarks: str | None = Field(default=None, max_length=2000)


class TrainingSignPayload(BaseModel):
    # Data-URL of the drawn signature, same format the construction report
    # stores. Size-capped: a signature PNG is a few KB; megabytes is abuse.
    signature: str = Field(min_length=30, max_length=200_000)


class TrainingReportOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    user_id: int
    user_display_name: str | None = None
    week_start: date
    report_number: int
    ausbildungsjahr: int
    status: TrainingReportStatus
    days: list[TrainingReportDay]
    remarks: str | None = None
    total_hours: float = 0
    azubi_signed_at: datetime | None = None
    ausbilder_signed_at: datetime | None = None
    ausbilder_name: str | None = None
    # The signature images themselves are deliberately not echoed in list
    # responses — they only matter inside the PDF.
    created_at: datetime
    updated_at: datetime


class TrainingPrefillDay(BaseModel):
    day: date
    worked_hours: float = 0
    school_day: bool = False
    suggested_lines: list[str] = Field(default_factory=list)


class TrainingPrefillOut(BaseModel):
    week_start: date
    ausbildungsjahr: int
    days: list[TrainingPrefillDay]


class ApprenticeSettingsUpdate(BaseModel):
    is_apprentice: bool | None = None
    training_started_on: date | None = None
    # Distinguish "leave the date alone" (field omitted) from "clear it"
    # (explicit null) — same tri-state idea as the IDS password field.
    clear_training_started_on: bool = False


class ApprenticeOut(BaseModel):
    """One apprentice as the trainer's Ausbildung page lists them.

    Carries the two counts that decide what a trainer does next — how many
    sheets are waiting to be countersigned, and how many weeks are missing
    from the Heft — so the list is actionable without a request per row.
    """

    model_config = ConfigDict(from_attributes=True)

    id: int
    full_name: str
    display_name: str
    email: str
    is_apprentice: bool
    training_started_on: date | None = None
    report_count: int = 0
    pending_count: int = 0
    missing_week_count: int = 0
    last_week_start: date | None = None
