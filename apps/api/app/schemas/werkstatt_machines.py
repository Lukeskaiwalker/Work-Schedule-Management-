"""Pydantic shapes for individually tracked machines.

Kept out of `schemas/werkstatt.py`, which is already past 800 lines — the
Werkstatt modules follow a per-persona file-size discipline and machines are a
domain of their own rather than another article variant.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


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
    last_inspected_at: datetime | None = None
    purchased_at: datetime | None = None
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
    booked_from: datetime | None = None
    booked_until: datetime | None = None
    for_today: bool = False
    notes: str | None = None


class MachineReturnPayload(BaseModel):
    to_location_id: int | None = None
    # Lets the person handing it back say "this came back broken" in the same
    # action, rather than it going on the shelf and failing for the next crew.
    status: str = "verfuegbar"
    notes: str | None = None


class MachineInspectionPayload(BaseModel):
    inspected_at: datetime | None = None
    interval_days: int | None = Field(default=None, ge=1, le=3650)
    passed: bool = True
    notes: str | None = None


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
