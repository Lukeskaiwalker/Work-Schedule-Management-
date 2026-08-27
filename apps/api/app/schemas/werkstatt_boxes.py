"""Pydantic schemas for construction boxes (Baustellenkisten).

Kept in its own module rather than appended to ``schemas/werkstatt.py``: that
file is fenced per-persona by WERKSTATT_CONTRACT.md and already ~750 lines, and
boxes are a cross-persona concept.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict

BoxStatus = Literal["offen", "gepackt", "zugewiesen", "zurueck"]
BoxItemSource = Literal["article", "catalog", "manual"]


class WerkstattBoxItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    box_id: int
    source: str
    article_id: int | None = None
    catalog_external_key: str | None = None
    item_name: str
    article_no: str | None = None
    ean: str | None = None
    unit: str | None = None
    quantity: int
    notes: str | None = None


class WerkstattBoxOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    box_number: str
    label: str
    # 1..8 for the fixed workshop boxes, null for ad-hoc ones.
    slot: int | None = None
    status: str
    customer_id: int | None = None
    customer_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    item_count: int = 0
    packed_at: datetime | None = None
    assigned_at: datetime | None = None
    returned_at: datetime | None = None
    notes: str | None = None
    created_at: datetime | None = None
    items: list[WerkstattBoxItemOut] = []


class WerkstattBoxCreate(BaseModel):
    label: str
    customer_id: int | None = None
    project_id: int | None = None
    notes: str | None = None


class WerkstattBoxUpdate(BaseModel):
    label: str | None = None
    project_id: int | None = None
    notes: str | None = None


class WerkstattBoxStatusPayload(BaseModel):
    status: BoxStatus


class WerkstattBoxAssignPayload(BaseModel):
    customer_id: int
    project_id: int | None = None


class WerkstattBoxItemCreate(BaseModel):
    """Add a line. Supply an ``article_id`` for stocked items, a
    ``catalog_external_key`` for Datanorm-only items, or just a name."""

    source: BoxItemSource | None = None
    article_id: int | None = None
    catalog_external_key: str | None = None
    item_name: str | None = None
    article_no: str | None = None
    ean: str | None = None
    unit: str | None = None
    quantity: int = 1
    notes: str | None = None


class WerkstattBoxItemUpdate(BaseModel):
    item_name: str | None = None
    unit: str | None = None
    quantity: int | None = None
    notes: str | None = None


# How a hit matched the query. Everything except "partial" is an exact match
# on a scannable identifier, which is what makes a scan safe to auto-add.
ItemMatchKind = Literal[
    "exact_internal_code",
    "exact_ean",
    "exact_article_no",
    "exact_supplier_no",
    "partial",
]


class WerkstattItemSearchHit(BaseModel):
    """One row in the unified article + Datanorm-catalog search."""

    source: BoxItemSource
    article_id: int | None = None
    catalog_external_key: str | None = None
    item_name: str
    article_no: str | None = None
    ean: str | None = None
    unit: str | None = None
    # Only meaningful for stocked articles; catalog hits render as "not in stock".
    stock_available: int | None = None
    match: ItemMatchKind = "partial"
    # Set when the hit came from a supplier's own article number — e.g. the
    # Unielektro number for an article we hold under our own SP-number.
    supplier_name: str | None = None
    supplier_article_no: str | None = None


class WerkstattBoxSelectableOut(BaseModel):
    """A box as offered by the task form's picker.

    Deliberately not ``WerkstattBoxOut``: it carries the server-computed
    ``group`` (so all three task forms sort and label identically without
    duplicating the merge logic), and it is built from batched queries rather
    than ``_box_out``'s per-row lookups.
    """

    id: int
    box_number: str
    label: str
    slot: int | None = None
    status: str
    item_count: int = 0
    customer_id: int | None = None
    customer_name: str | None = None
    project_id: int | None = None
    project_name: str | None = None
    # customer = already belongs to the task's customer; free = in the rack,
    # unclaimed; other = at a different customer (search-only).
    group: Literal["customer", "free", "other"]
