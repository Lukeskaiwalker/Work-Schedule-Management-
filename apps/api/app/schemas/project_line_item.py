"""Pydantic schemas for ProjectLineItem.

Three external shapes:
  - ``ProjectLineItemCreate`` — payload for POST (manual create)
  - ``ProjectLineItemUpdate`` — payload for PATCH (partial update)
  - ``ProjectLineItemOut``    — server response (includes derived status)

The ``ProjectLineItemOut.status`` field is computed in ``model_validate``
from the quantity columns, mirroring the model property. Stored once at
serialization time so the frontend doesn't need to repeat the logic.
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

LineItemType = Literal["material", "leistung", "sonstige"]


class ProjectLineItemCreate(BaseModel):
    """Payload for manually creating a line item via POST.

    The extraction-driven path doesn't go through this — it goes through
    a different endpoint that bulk-creates from extracted data. This is
    purely the operator-typed-it-by-hand path."""

    type: LineItemType
    section_title: str | None = Field(default=None, max_length=255)
    position: str | None = Field(default=None, max_length=32)
    description: str = Field(min_length=1)
    sku: str | None = Field(default=None, max_length=255)
    manufacturer: str | None = Field(default=None, max_length=128)
    quantity_required: Decimal = Field(ge=0)
    quantity_ordered: Decimal = Field(default=Decimal("0"), ge=0)
    quantity_delivered: Decimal = Field(default=Decimal("0"), ge=0)
    quantity_at_site: Decimal = Field(default=Decimal("0"), ge=0)
    quantity_reserved: Decimal = Field(default=Decimal("0"), ge=0)
    unit: str | None = Field(default=None, max_length=32)
    unit_price_eur: Decimal | None = Field(default=None, ge=0)
    total_price_eur: Decimal | None = Field(default=None, ge=0)
    supplier_id: int | None = None
    source_doc_type: str | None = Field(default="manuell", max_length=64)
    source_doc_filename: str | None = Field(default=None, max_length=500)
    extracted_by_model: str | None = Field(default=None, max_length=128)
    extraction_confidence: Decimal | None = Field(default=None, ge=0, le=1)
    notes: str | None = None
    is_active: bool = True


class ProjectLineItemUpdate(BaseModel):
    """Partial-update payload. Every field is optional — operators
    edit one cell at a time in the UI grid, so only the changed
    field arrives. Using ``exclude_unset=True`` on the router side
    means an absent field is "leave alone", a null field is "clear it"."""

    type: LineItemType | None = None
    section_title: str | None = Field(default=None, max_length=255)
    position: str | None = Field(default=None, max_length=32)
    description: str | None = Field(default=None, min_length=1)
    sku: str | None = Field(default=None, max_length=255)
    manufacturer: str | None = Field(default=None, max_length=128)
    quantity_required: Decimal | None = Field(default=None, ge=0)
    quantity_ordered: Decimal | None = Field(default=None, ge=0)
    quantity_delivered: Decimal | None = Field(default=None, ge=0)
    quantity_at_site: Decimal | None = Field(default=None, ge=0)
    quantity_reserved: Decimal | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=32)
    unit_price_eur: Decimal | None = Field(default=None, ge=0)
    total_price_eur: Decimal | None = Field(default=None, ge=0)
    supplier_id: int | None = None
    notes: str | None = None
    is_active: bool | None = None


class ProjectLineItemOut(BaseModel):
    """Server response shape. Includes derived ``status`` and
    ``quantity_missing`` so the frontend never has to recompute them."""

    id: int
    project_id: int
    type: LineItemType
    section_title: str | None = None
    position: str | None = None
    description: str
    sku: str | None = None
    manufacturer: str | None = None
    quantity_required: Decimal
    quantity_ordered: Decimal
    quantity_delivered: Decimal
    quantity_at_site: Decimal
    quantity_reserved: Decimal
    quantity_missing: Decimal
    unit: str | None = None
    unit_price_eur: Decimal | None = None
    total_price_eur: Decimal | None = None
    supplier_id: int | None = None
    source_doc_type: str | None = None
    source_doc_filename: str | None = None
    extracted_by_model: str | None = None
    extraction_confidence: Decimal | None = None
    notes: str | None = None
    is_active: bool
    status: str  # computed; one of the STATUS_* constants in models/project_line_item.py
    created_by: int | None = None
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)

    @field_validator("status", mode="before")
    @classmethod
    def _ensure_status_present(cls, v, info):
        # When constructing from an ORM row via ``model_validate(row,
        # from_attributes=True)``, Pydantic reads ``row.status`` which
        # IS our computed property — so we're fine. This validator is
        # a defensive safety net for callers that pass plain dicts
        # (e.g. tests building the schema by hand) and forgot to
        # include status.
        return v if v is not None else "offen"
