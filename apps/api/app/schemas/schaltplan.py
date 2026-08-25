"""Schemas for Verteilerpläne (panel schematics).

Validation posture: the document is site documentation written under a fuse
box, so text fields are generously capped and never content-checked — a
"Bezeichnung" of "Steckdose ??? (Altbau)" is a legitimate thing to record.
What *is* enforced is structure: device kinds must exist in the catalogue,
counts are bounded so one tablet cannot post a 40 MB document, and ids are
required because the topology derivation and the editor both key on them.

The bounds (60 rows × 96 devices) are far above any real board — the biggest
Hauptverteiler on site is ~8 rows — and exist only as a denial-of-service
ceiling, not as a modelling opinion.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.services.schaltplan_layout import DEVICE_KINDS, PANEL_STATUSES, PANEL_TYPES, SUPPLY_SYSTEMS

PanelType = Literal["main", "sub", "meter"]
PanelStatus = Literal["draft", "final"]
SupplySystem = Literal["TN-S", "TN-C-S", "TT", "IT"]
PhaseLabel = Literal["L1", "L2", "L3", "L1-L3", "L1/N", "N", "-"]

MAX_ROWS = 60
MAX_DEVICES_PER_ROW = 96


class PanelSupply(BaseModel):
    system: SupplySystem = "TN-S"
    voltage: str = Field(default="400/230 V", max_length=64)
    incoming: str = Field(default="", max_length=160)
    fuse: str = Field(default="", max_length=96)
    meter_number: str = Field(default="", max_length=96)
    note: str = Field(default="", max_length=500)


class PanelDevice(BaseModel):
    # Client-generated id. Required: `parent_id` overrides, the diagram's
    # selection state and React's keys all depend on a stable identity, and
    # minting one server-side would break the client's optimistic render.
    id: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=40)
    te: int = Field(default=1, ge=1, le=24)
    poles: int = Field(default=1, ge=1, le=4)
    designation: str = Field(default="", max_length=32)
    circuit: str = Field(default="", max_length=16)
    label: str = Field(default="", max_length=160)
    room: str = Field(default="", max_length=96)
    rating: str = Field(default="", max_length=32)
    residual_current: str = Field(default="", max_length=32)
    rcd_type: str = Field(default="", max_length=16)
    cable: str = Field(default="", max_length=96)
    phase: PhaseLabel = "-"
    parent_id: str | None = Field(default=None, max_length=64)
    note: str = Field(default="", max_length=500)

    @field_validator("kind")
    @classmethod
    def _known_kind(cls, value: str) -> str:
        if value not in DEVICE_KINDS:
            raise ValueError(f"Unbekannter Gerätetyp: {value}")
        return value


class PanelRow(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    label: str = Field(default="", max_length=64)
    slots: int = Field(default=12, ge=1, le=96)
    devices: list[PanelDevice] = Field(default_factory=list, max_length=MAX_DEVICES_PER_ROW)


class PanelDocument(BaseModel):
    version: int = 1
    supply: PanelSupply = Field(default_factory=PanelSupply)
    rows: list[PanelRow] = Field(default_factory=list, max_length=MAX_ROWS)

    @field_validator("rows")
    @classmethod
    def _unique_device_ids(cls, rows: list[PanelRow]) -> list[PanelRow]:
        # Duplicate ids make `parent_id` ambiguous and make the editor edit two
        # devices at once. Cheap to check here, impossible to untangle later.
        seen: set[str] = set()
        for row in rows:
            for device in row.devices:
                if device.id in seen:
                    raise ValueError(f"Doppelte Geräte-ID: {device.id}")
                seen.add(device.id)
        return rows


class PanelPlanCreate(BaseModel):
    customer_id: int
    project_id: int | None = None
    name: str = Field(min_length=1, max_length=160)
    designation: str = Field(min_length=1, max_length=32)
    panel_type: PanelType = "sub"
    location: str | None = Field(default=None, max_length=255)
    fed_from_panel_id: int | None = None
    notes: str | None = Field(default=None, max_length=4000)
    document: PanelDocument | None = None

    @field_validator("name", "designation")
    @classmethod
    def _not_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Pflichtfeld darf nicht leer sein.")
        return stripped


class PanelPlanUpdate(BaseModel):
    """Every field optional — the editor autosaves partial patches.

    ``project_id`` and ``fed_from_panel_id`` use a sentinel-free convention:
    the router distinguishes "omitted" from "explicitly null" via
    ``model_fields_set``, so a panel can be un-linked from its project.
    """

    project_id: int | None = None
    name: str | None = Field(default=None, min_length=1, max_length=160)
    designation: str | None = Field(default=None, min_length=1, max_length=32)
    panel_type: PanelType | None = None
    location: str | None = Field(default=None, max_length=255)
    fed_from_panel_id: int | None = None
    status: PanelStatus | None = None
    notes: str | None = Field(default=None, max_length=4000)
    document: PanelDocument | None = None
    # Client-supplied revision counter; the router only ever accepts a value
    # greater than the stored one so a stale tablet cannot roll it backwards.
    revision: int | None = Field(default=None, ge=1, le=100_000)


class PanelLegendRow(BaseModel):
    circuit: str
    designation: str
    label: str
    room: str
    device: str
    rating: str
    rcd: str
    cable: str
    phase: str
    group: str
    note: str


class PanelFinding(BaseModel):
    level: str
    scope: str
    message: str


class PanelPlanSummary(BaseModel):
    """List-view shape — no document, so the picker stays small on mobile."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    customer_id: int
    customer_name: str | None = None
    project_id: int | None = None
    project_number: str | None = None
    project_name: str | None = None
    name: str
    designation: str
    panel_type: PanelType
    location: str | None = None
    fed_from_panel_id: int | None = None
    fed_from_designation: str | None = None
    status: PanelStatus
    revision: int
    device_count: int = 0
    circuit_count: int = 0
    rcd_count: int = 0
    used_slots: int = 0
    total_slots: int = 0
    row_count: int = 0
    updated_at: datetime
    updated_by_name: str | None = None


class PanelPlanOut(PanelPlanSummary):
    document: PanelDocument
    notes: str | None = None
    legend: list[PanelLegendRow] = Field(default_factory=list)
    findings: list[PanelFinding] = Field(default_factory=list)
    created_at: datetime
    created_by_name: str | None = None


class DeviceCatalogEntry(BaseModel):
    """Served to the client so the palette cannot drift from the backend."""

    kind: str
    label: str
    short: str
    te: int
    poles: int
    group: bool
    circuit: bool
    symbol: str
    rating_hint: str
