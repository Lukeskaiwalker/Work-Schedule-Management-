"""Schemas for Verteilerpläne (panel schematics).

Validation posture: the document is site documentation written under a fuse
box, so text fields are generously capped and never content-checked — a
"Bezeichnung" of "Steckdose ??? (Altbau)" is a legitimate thing to record.
What *is* enforced is structure: device kinds must exist in the catalogue,
counts are bounded so one tablet cannot post a 40 MB document, and ids are
required because the topology derivation and the editor both key on them.

The bounds (120 rows × 96 devices) are far above any hand-drawn board — the
biggest Hauptverteiler on site is ~8 rows — and exist only as a
denial-of-service ceiling, not as a modelling opinion. 120 rather than 60
because a board in a cabinet gets one row per used DIN rail, and a full
five-field 1400 mm cabinet has about 45 of them (docs/PANEL_ENCLOSURE.md D15).

Two keys belong to the cabinet layer (docs/PANEL_ENCLOSURE.md):
``document.enclosure`` and ``device.supplied_by``, typed in
``schemas/panel_enclosure.py``. The release before the feature passed them
through opaque and size-capped, so that rolling the feature back is an image
swap; the types here accept nothing that release refused (the 64 KB ceiling
on the block stays), so a board the feature saved still saves after such a
rollback.
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.panel_enclosure import (
    CatalogEntryOut,
    DeviceSuppliedBy,
    EnclosureCatalogOut,
    PanelEnclosure,
    UncataloguedArticleOut,
)
from app.services.schaltplan_layout import DEVICE_KINDS, PANEL_STATUSES, PANEL_TYPES, SUPPLY_SYSTEMS

PanelType = Literal["main", "sub", "meter"]
PanelStatus = Literal["draft", "final"]
SupplySystem = Literal["TN-S", "TN-C-S", "TT", "IT"]
PhaseLabel = Literal["L1", "L2", "L3", "L1-L3", "L1/N", "N", "-"]

# Same constant as MAX_ROWS in apps/web/src/utils/schaltplanDevices.ts (a test
# reads both).
MAX_ROWS = 120
MAX_TERMINAL_OVERRIDES = 2000
MAX_DEVICES_PER_ROW = 96
# Ceiling of the cabinet block as stored (compact UTF-8 JSON). Kept from the
# release before the feature, which refuses anything larger (module docstring).
MAX_ENCLOSURE_JSON_BYTES = 64 * 1024


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
    # Kind "fuse" only: the Neozed/NH block feeds every device placed after
    # it on the rail, up to the next FI/SLS/Hauptschalter — it opens a group
    # the way an FI does. Off, a fuse is a plain circuit unless a circuit
    # names it via ``parent_id`` (see ``schaltplan_layout.opens_group``).
    feeds_following: bool = False
    # The outgoing ends on a WAGO Reihenklemme. Opt-in per device; only
    # MCB-protected outgoing kinds (LS, Wallbox, UV-Abgang, PV) read it and
    # an RCBO never does — see services/schaltplan_terminal_rules.py. Old
    # documents load with False, the same way feeds_following does.
    terminal_block: bool = False
    note: str = Field(default="", max_length=500)
    # Real mounted width in mm, when it is not `te` × the module pitch. The
    # BMK strip is cut to this, so a 70 mm Hager FI must not be labelled 72.
    width_mm: float | None = Field(default=None, gt=0, le=600)
    # This device came pre-fitted in a cabinet module (docs/PANEL_ENCLOSURE.md
    # §2.1): which module instance, which of its fittings.
    supplied_by: DeviceSuppliedBy | None = None

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
    # Marker-text overrides for the Reihenklemmen, "<device id>:<slot>" →
    # text (see services/schaltplan_terminals.override_key). A blank text
    # is "print nothing here"; a missing key is the derived default.
    terminal_labels: dict[str, str] = Field(default_factory=dict)
    # The cabinet the rows are mounted in (docs/PANEL_ENCLOSURE.md §2); null =
    # rails only.
    enclosure: PanelEnclosure | None = None

    @field_validator("terminal_labels")
    @classmethod
    def _bounded_overrides(cls, labels: dict[str, str]) -> dict[str, str]:
        if len(labels) > MAX_TERMINAL_OVERRIDES:
            raise ValueError("Zu viele Klemmenbeschriftungen")
        return {str(key)[:80]: str(value)[:40] for key, value in labels.items()}

    @field_validator("enclosure")
    @classmethod
    def _bounded_enclosure(cls, value: PanelEnclosure | None) -> PanelEnclosure | None:
        # Measured as it will be stored — compact UTF-8 JSON, defaults filled
        # in — because that is what an older image gets sent back after a
        # rollback. Unknown keys inside the block are kept, and this bounds them.
        if value is None:
            return None
        stored = value.model_dump()
        size = len(json.dumps(stored, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8"))
        if size > MAX_ENCLOSURE_JSON_BYTES:
            raise ValueError("Schrankdaten zu groß (max. 64 KB)")
        return value

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
    # The Vorsicherung column: the FI's pre-fuse, or the feeder fuse itself
    # for a circuit hanging off a Neozed block. "—" when there is none.
    pre_fuse: str = "—"
    note: str


class PanelFinding(BaseModel):
    level: str
    scope: str
    message: str
    # "encl.overlap", "vde.nar_sls", … for the cabinet findings
    # (docs/PANEL_ENCLOSURE.md §5); "" for every finding that predates them.
    rule: str = ""


class PanelPlanSummary(BaseModel):
    """List-view shape — no document, so the picker stays small on mobile."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    # "VT-0007" — see services/schaltplan_panel_numbers.py.
    panel_number: str
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


class PanelTerminalBomRow(BaseModel):
    """One line of the Reihenklemmen Stückliste: a WAGO part and how many the board needs."""

    part_id: str
    part_no: str
    name: str
    count: int
    # Rail footprint per the datasheet; ``verified`` is False for a part whose
    # width nobody could confirm (see services/schaltplan_terminal_rules.py).
    width_mm: float
    verified: bool


class PanelPlanOut(PanelPlanSummary):
    document: PanelDocument
    notes: str | None = None
    legend: list[PanelLegendRow] = Field(default_factory=list)
    findings: list[PanelFinding] = Field(default_factory=list)
    # The server-side Reihenklemmen derivation. The editor renders its own
    # twin; this is the truth a purchasing hook or a test compares against.
    terminal_bom: list[PanelTerminalBomRow] = Field(default_factory=list)
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


PrintTarget = Literal["bmk", "reihenklemmen"]


class PanelLabelsPrintRequest(BaseModel):
    """Print BMK labels for selected rails, on a chosen marking material.

    ``row_ids`` empty or absent means every rail. ``material_id`` defaults to
    the 2009-110 strip (one continuous strip per rail, cut marks between the
    devices); ``wago-210-805`` prints one 6 × 15 mm label per BMK instead.
    ``row_id`` is the pre-v2.15 single-rail form, still honoured.

    ``target="reihenklemmen"`` prints the WAGO terminal markers instead: one
    piece per strip — a Leiste (X1, 1.1, 1.2 …) or a Block label (name, X,
    N L1 L2 L3 PE) — ``strip_ids`` absent or null = every strip; an explicit
    empty list = no strip, refused with a 400, because the sheet sends
    exactly the ticked strips. Continuous stock only — a 5.2 mm terminal has
    no room for a 6 × 15 mm label.
    """

    row_ids: list[str] | None = Field(default=None, max_length=64)
    row_id: str | None = None
    material_id: str | None = Field(default=None, max_length=64)
    target: PrintTarget = "bmk"
    strip_ids: list[str] | None = Field(default=None, max_length=256)


class PanelTypeLabelInfoOut(BaseModel):
    """What the Schrank-Etikett will print for this panel — the dialog's
    prefill, resolved server-side so the screen and the printer agree."""

    # The DataMatrix bottom-left holds this.
    panel_number: str
    customer: str
    project_number: str | None = None
    project_name: str | None = None
    build_month: str
    url: str
    contact_lines: list[str]
    material: str
    material_ok: bool


class PanelTypeLabelPrintRequest(BaseModel):
    # "MM.YYYY"; absent or blank = the month of printing. Loose cap here so a
    # typo is answered by the service's German message, not a schema error.
    build_month: str | None = Field(default=None, max_length=32)
    copies: int = Field(default=1, ge=1, le=10)


class PanelTypeLabelOut(BaseModel):
    printer: str
    material: str
    sheets: int
    customer: str
    project_number: str | None = None
    build_month: str


class PanelStripOut(BaseModel):
    # A rail id for BMK strips, a terminal group id (the FI's device id or
    # "supply") for Reihenklemmen strips.
    row_id: str
    row_label: str
    # Length of the strip between its start and end cut lines, in mm.
    length_mm: float
    # Reihenklemmen only: every part of the group, end element included.
    part_count: int | None = None


class PanelLabelsPrintOut(BaseModel):
    # Labelled segments printed: one per BMK, on either material.
    printed: int
    # Devices that are Betriebsmittel but carry no BMK yet: silently printing
    # nothing for them would hide exactly the gap the strip exists to close.
    skipped_without_bmk: int
    printer: str
    material: str
    # One entry per continuous strip that went out; empty for die-cut labels.
    # Lengths count labelled devices only — blank covers take no strip.
    strips: list[PanelStripOut] = Field(default_factory=list)
    # The ONE font size (dots of the 300 dpi head, 11,81 per mm) every BMK on the board is
    # printed at — fitted over the whole board, not just the rails printed now.
    # None for die-cut labels, which are fitted one by one on their own stock.
    font_size_dots: int | None = None
    # BMK texts wider than their segment even at the minimum size: they print
    # at the clamped size and run past their cut marks, so say so.
    overflowing: list[str] = Field(default_factory=list)


# ── Materialliste / Kommissionierung ──────────────────────────────────────────
# The wire shape the panel editor, the Werkstatt "Verteiler" tab and the Regal
# station all read. Planned lines are derived from the document on every read
# (services/schaltplan_material.py); scanned quantities are sums over the
# Werkstatt ledger.

# "enclosure": the cabinet, its modules and accessories; "removed": a fitting
# taken out of a module, on its way back to the shelf (docs/PANEL_ENCLOSURE.md §6).
PanelMaterialLineKind = Literal["device", "terminal", "manual", "extra", "enclosure", "removed"]
PanelMaterialLineStatus = Literal["open", "done", "over", "unplanned"]
PanelMaterialArticleSource = Literal["mapping", "auto", "manual"]


class PanelMaterialArticleOut(BaseModel):
    """The stock article a line is ticked off against — the slim projection a
    list of forty lines can afford, not the full ``WerkstattArticleOut``."""

    id: int
    article_number: str
    item_name: str
    manufacturer: str | None = None
    unit: str | None = None
    internal_code: str | None = None
    stock_available: int = 0


class PanelMaterialLineOut(BaseModel):
    # "device:mcb:1p:b16" | "part:2003-7641" | "article:218" — also the mapping key.
    key: str
    kind: PanelMaterialLineKind
    label: str
    detail: str = ""
    planned: int = 0
    scanned: int = 0
    status: PanelMaterialLineStatus
    article: PanelMaterialArticleOut | None = None
    article_source: PanelMaterialArticleSource | None = None
    last_scanned_at: datetime | None = None
    # Set on a line added by hand ("manual:<id>") — the id to change or remove
    # it, and its note on its own (``detail`` falls back to "manuell").
    manual_id: int | None = None
    note: str | None = None


class PanelMaterialManualCreate(BaseModel):
    """A line added by hand: a shelf article or a free text (owner, 2026-10-09)."""

    article_id: int | None = Field(default=None, ge=1)
    label: str | None = Field(default=None, max_length=255)
    quantity: int = Field(default=1, ge=1, le=9999)
    note: str | None = Field(default=None, max_length=500)

    @field_validator("label", "note")
    @classmethod
    def _blank_is_none(cls, value: str | None) -> str | None:
        text = (value or "").strip()
        return text or None

    @model_validator(mode="after")
    def _article_or_text(self) -> "PanelMaterialManualCreate":
        if self.article_id is None and self.label is None:
            raise ValueError("article_id or label is required")
        return self


class PanelMaterialManualUpdate(BaseModel):
    quantity: int | None = Field(default=None, ge=1, le=9999)
    label: str | None = Field(default=None, max_length=255)
    note: str | None = Field(default=None, max_length=500)


class PanelMaterialPanelOut(BaseModel):
    id: int
    panel_number: str
    designation: str
    name: str
    panel_type: PanelType
    status: PanelStatus
    customer_id: int
    customer_name: str | None = None
    project_id: int | None = None
    project_number: str | None = None
    project_name: str | None = None
    updated_at: datetime


class PanelWorkSessionOut(BaseModel):
    """One stretch of one person's time on one board."""

    id: int
    panel_id: int
    panel_number: str | None = None
    user_id: int
    user_name: str
    started_at: datetime
    ended_at: datetime | None = None
    # Whole minutes; for a running session, so far. Integer on purpose: the
    # board shows hours, and sub-minute precision from a badge scan is noise.
    minutes: int = 0
    running: bool = False
    # "station" | "web"
    ended_via: str | None = None


class PanelLabourLineOut(BaseModel):
    """One person's position in a board's Arbeitszeit block.

    ``minutes`` counts CLOSED sessions only. A running session has no length
    yet; it is reported as ``running_since`` so the screen can say "läuft seit
    14:02" -- counting it would put a number on the board that grows by itself
    overnight whenever somebody forgets to scan out.
    """

    user_id: int
    name: str
    minutes: int = 0
    sessions: int = 0
    running_since: datetime | None = None
    running_session_id: int | None = None


class PanelWorkSessionEndRequest(BaseModel):
    """Ending a session by hand, after a forgotten clock-out.

    ``ended_at`` defaults to now, but the point of the field is the real time:
    "ended at 08:00 the next morning" is fifteen hours nobody worked.
    """

    ended_at: datetime | None = None


class PanelMaterialOut(BaseModel):
    panel: PanelMaterialPanelOut
    lines: list[PanelMaterialLineOut] = Field(default_factory=list)
    planned_total: int = 0
    scanned_total: int = 0
    open_lines: int = 0
    # Pieces of "removed" lines not yet booked back into stock. Returns are
    # not picks, so they stay out of the three totals above.
    returns_open: int = 0
    last_scanned_at: datetime | None = None
    # The Arbeitszeit block under the parts. Kept OUT of ``lines`` on purpose:
    # the totals above count pieces, and an hours row among them would quietly
    # turn "scanned_total: 47" into pieces plus hours.
    labour: list[PanelLabourLineOut] = Field(default_factory=list)
    labour_minutes: int = 0
    labour_running: int = 0


class PanelMaterialSummaryOut(BaseModel):
    """One row of the Werkstatt overview: a board and how far its picking is."""

    panel: PanelMaterialPanelOut
    planned_total: int = 0
    scanned_total: int = 0
    open_lines: int = 0
    returns_open: int = 0
    last_scanned_at: datetime | None = None


class PanelMaterialBookRequest(BaseModel):
    article_id: int
    quantity: int = Field(default=1, ge=1, le=10_000)


class PanelMaterialMappingRequest(BaseModel):
    key: str = Field(min_length=3, max_length=120)
    # None forgets the mapping.
    article_id: int | None = None


class PanelMaterialMappingOut(BaseModel):
    key: str
    article: PanelMaterialArticleOut | None = None


# The catalogue answer names PanelMaterialArticleOut, but schemas.panel_enclosure
# is imported above for the document parts, so its models are completed here
# once the article shape exists (the schemas.project/customer idiom).
for _model in (CatalogEntryOut, UncataloguedArticleOut, EnclosureCatalogOut):
    _model.model_rebuild(_types_namespace={"PanelMaterialArticleOut": PanelMaterialArticleOut})
