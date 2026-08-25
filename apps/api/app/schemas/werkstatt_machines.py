"""Pydantic shapes for individually tracked machines.

Kept out of `schemas/werkstatt.py`, which is already past 800 lines — the
Werkstatt modules follow a per-persona file-size discipline and machines are a
domain of their own rather than another article variant.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from app.core.time import to_naive_utc

# Inbound timestamps are normalised to naive UTC at the boundary rather than in
# each service. A browser sends `2026-08-11T18:00:00.000Z` (correctly — that is
# what `toISOString()` produces), the columns are naive, and every service
# compares against a naive `utcnow()`; without this the first booking with an
# explicit return time raises a TypeError deep inside `book_unit`.
#
# Output models keep the plain `datetime`: values coming out of the ORM are
# already naive UTC, and re-validating them would be a no-op with a cost.
NaiveUtcDatetime = Annotated[datetime, AfterValidator(to_naive_utc)]


class _OrmBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class MachineComponentOut(_OrmBase):
    """A sub-component, flattened — enough to show it in the parent's list."""

    id: int
    unit_number: str
    article_id: int
    article_name: str | None = None
    status: str
    serial_number: str | None = None
    next_inspection_due_at: datetime | None = None


class MachineOut(_OrmBase):
    id: int
    unit_number: str
    article_id: int
    # Denormalised for the list view so the client does not need the article
    # separately just to render a row.
    article_name: str | None = None
    manufacturer: str | None = None
    parent_unit_id: int | None = None
    serial_number: str | None = None
    status: str

    current_location_id: int | None = None
    current_location_name: str | None = None
    holder_user_id: int | None = None
    holder_name: str | None = None

    booked_from: datetime | None = None
    booked_until: datetime | None = None
    # True when booked_until is in the past and the machine is still out — the
    # single fact the "overdue" filter is built on, computed server-side so
    # every client agrees on what late means.
    is_overdue: bool = False

    inspection_required: bool = False
    inspection_interval_days: int | None = None
    last_inspected_at: datetime | None = None
    next_inspection_due_at: datetime | None = None
    inspection_overdue: bool = False

    purchased_at: datetime | None = None
    notes: str | None = None
    is_archived: bool = False
    created_at: datetime

    components: list[MachineComponentOut] = Field(default_factory=list)


class MachineCreatePayload(BaseModel):
    article_id: int
    serial_number: str | None = Field(default=None, max_length=120)
    parent_unit_id: int | None = None
    current_location_id: int | None = None
    inspection_required: bool | None = None
    inspection_interval_days: int | None = Field(default=None, ge=1, le=3650)
    last_inspected_at: NaiveUtcDatetime | None = None
    purchased_at: NaiveUtcDatetime | None = None
    notes: str | None = None


class MachineUpdatePayload(BaseModel):
    serial_number: str | None = Field(default=None, max_length=120)
    parent_unit_id: int | None = None
    current_location_id: int | None = None
    status: str | None = None
    inspection_required: bool | None = None
    inspection_interval_days: int | None = Field(default=None, ge=1, le=3650)
    notes: str | None = None
    is_archived: bool | None = None


class MachineBookPayload(BaseModel):
    """Hand a machine to a person, a vehicle, or both.

    `for_today` is what the scanner sends: the overwhelmingly common case is
    "I am taking this now and bringing it back tonight", and making that the
    one-tap default is the difference between the log being kept and not.
    """

    holder_user_id: int | None = None
    to_location_id: int | None = None
    booked_from: NaiveUtcDatetime | None = None
    booked_until: NaiveUtcDatetime | None = None
    for_today: bool = False
    notes: str | None = None


class MachineReturnPayload(BaseModel):
    to_location_id: int | None = None
    # Lets the person handing it back say "this came back broken" in the same
    # action, rather than it going on the shelf and failing for the next crew.
    status: str = "verfuegbar"
    notes: str | None = None


class MachineInspectionPayload(BaseModel):
    inspected_at: NaiveUtcDatetime | None = None
    interval_days: int | None = Field(default=None, ge=1, le=3650)
    passed: bool = True
    notes: str | None = None


class MachineLabelPrintOut(BaseModel):
    """Confirmation that a label job left for the printer.

    `printer` is the "host:port" actually used — surfaced so a wrong IP is
    diagnosable from the client instead of being a silent misprint elsewhere.
    """

    unit_number: str
    printer: str


class MachineLabelBatchItem(BaseModel):
    unit_id: int
    # "gross" = one full sheet; "klein" = quarter label, packed 4-per-sheet.
    format: Literal["gross", "klein"] = "klein"


class MachineLabelBatchPayload(BaseModel):
    """The print queue: what the workshop collected before hitting Drucken."""

    items: list[MachineLabelBatchItem] = Field(min_length=1, max_length=40)


class MachineLabelBatchOut(BaseModel):
    sheets: int
    labels: int
    printer: str


class MachineLabelCapabilitiesOut(BaseModel):
    """What the ACTIVE printer material can carry — drives honest buttons."""

    material_id: str
    material_name: str
    tier: str
    gross: bool
    klein: bool = True
    hint: str | None = None


class MachineMovementOut(_OrmBase):
    """One line of a machine's custody log."""

    id: int
    movement_type: str
    from_location_id: int | None = None
    from_location_name: str | None = None
    to_location_id: int | None = None
    to_location_name: str | None = None
    user_id: int
    user_name: str | None = None
    assignee_user_id: int | None = None
    assignee_name: str | None = None
    expected_return_at: datetime | None = None
    notes: str | None = None
    created_at: datetime
