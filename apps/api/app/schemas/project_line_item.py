"""Pydantic schemas for ProjectLineItem.

Three external shapes:
  - ``ProjectLineItemCreate`` — payload for POST (manual create)
  - ``ProjectLineItemUpdate`` — payload for PATCH (partial update)
  - ``ProjectLineItemOut``    — server response (includes derived status)

The ``ProjectLineItemOut.status`` field is computed in ``model_validate``
from the quantity columns, mirroring the model property. Stored once at
serialization time so the frontend doesn't need to repeat the logic.

Bounds (2026-10-10): every quantity and price lands in a ``Numeric(12, 2)``
column. A request value is finite, not negative, rounded to the column's two
decimals the way PostgreSQL rounds (half away from zero) and no larger than
the column holds -- quantities additionally no larger than
``MAX_STOCK_QUANTITY`` -- so it can never reach ``db.flush()`` as a "numeric
field overflow". The line total a row implies (quantity × unit price) has to
fit the total column as well; ``line_total_exceeds_column`` is the one check
the schemas, the PATCH route and the LLM extraction share.
"""
from __future__ import annotations

from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from app.core.limits import INT32_MAX, MAX_STOCK_QUANTITY, NUMERIC_12_2_MAX

LineItemType = Literal["material", "leistung", "sonstige"]

#: Scale of every ``Numeric(…, 2)`` column on ``project_line_items``.
_CENT = Decimal("0.01")

LINE_TOTAL_TOO_LARGE = (
    "quantity × unit price exceeds the largest storable total "
    f"({NUMERIC_12_2_MAX:,} EUR) - check the quantity or the price"
)


def round_to_cents(value: Decimal) -> Decimal:
    """Round to two decimals, half away from zero -- what PostgreSQL does to
    a ``Numeric(12, 2)`` value anyway, done before the value is stored. It
    also turns an exponent PostgreSQL refuses ("value overflows numeric
    format", e.g. ``1E-100000``) into ``0.00``.
    Runs after the bound check, so the result never has more digits than
    the decimal context holds."""
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


def line_total_exceeds_column(
    quantity: Decimal | None, unit_price: Decimal | None
) -> bool:
    """True when quantity × unit price would not fit the total column."""
    if quantity is None or unit_price is None:
        return False
    return quantity * unit_price > NUMERIC_12_2_MAX


#: A quantity on a line item: pieces, metres, hours.
LineItemQuantity = Annotated[
    Decimal,
    Field(ge=0, le=MAX_STOCK_QUANTITY, allow_inf_nan=False),
    AfterValidator(round_to_cents),
]
#: A price in EUR (unit or total): anything the column holds.
LineItemAmountEur = Annotated[
    Decimal,
    Field(ge=0, le=NUMERIC_12_2_MAX, allow_inf_nan=False),
    AfterValidator(round_to_cents),
]
#: The extraction model's self-assessed confidence, ``Numeric(4, 2)``.
LineItemConfidence = Annotated[
    Decimal,
    Field(ge=0, le=1, allow_inf_nan=False),
    AfterValidator(round_to_cents),
]
#: A ``werkstatt_suppliers`` id; the routes check that it exists.
LineItemSupplierId = Annotated[int, Field(ge=1, le=INT32_MAX)]

# NOT NULL columns a PATCH may change but never clear.
_NOT_NULL_FIELDS = (
    "type",
    "description",
    "quantity_required",
    "quantity_ordered",
    "quantity_delivered",
    "quantity_at_site",
    "quantity_reserved",
    "is_active",
)


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
    quantity_required: LineItemQuantity
    quantity_ordered: LineItemQuantity = Decimal("0")
    quantity_delivered: LineItemQuantity = Decimal("0")
    quantity_at_site: LineItemQuantity = Decimal("0")
    quantity_reserved: LineItemQuantity = Decimal("0")
    unit: str | None = Field(default=None, max_length=32)
    unit_price_eur: LineItemAmountEur | None = None
    total_price_eur: LineItemAmountEur | None = None
    supplier_id: LineItemSupplierId | None = None
    source_doc_type: str | None = Field(default="manuell", max_length=64)
    source_doc_filename: str | None = Field(default=None, max_length=500)
    extracted_by_model: str | None = Field(default=None, max_length=128)
    extraction_confidence: LineItemConfidence | None = None
    notes: str | None = None
    is_active: bool = True

    @model_validator(mode="after")
    def _line_total_fits(self) -> "ProjectLineItemCreate":
        if line_total_exceeds_column(self.quantity_required, self.unit_price_eur):
            raise ValueError(LINE_TOTAL_TOO_LARGE)
        return self


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
    quantity_required: LineItemQuantity | None = None
    quantity_ordered: LineItemQuantity | None = None
    quantity_delivered: LineItemQuantity | None = None
    quantity_at_site: LineItemQuantity | None = None
    quantity_reserved: LineItemQuantity | None = None
    unit: str | None = Field(default=None, max_length=32)
    unit_price_eur: LineItemAmountEur | None = None
    total_price_eur: LineItemAmountEur | None = None
    supplier_id: LineItemSupplierId | None = None
    notes: str | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def _no_null_for_not_null_columns(self) -> "ProjectLineItemUpdate":
        """An explicit null for a NOT NULL column would reach the flush
        as an IntegrityError (a 500). Absent stays "leave alone"."""
        cleared = sorted(
            name
            for name in _NOT_NULL_FIELDS
            if name in self.model_fields_set and getattr(self, name) is None
        )
        if cleared:
            raise ValueError(f"{', '.join(cleared)} cannot be null")
        return self


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
