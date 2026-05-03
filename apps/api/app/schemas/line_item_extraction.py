"""Pydantic shapes for the line-item extraction flow.

Two layers in this file:

1. **API surface** (Create / Out / status views) — what the FE talks to.
2. **OpenAI Structured-Outputs schema** (``ExtractedLineItem`` and
   ``ExtractedLineItemList``). These are passed verbatim to the OpenAI
   SDK as ``response_format={"type": "json_schema", ...}`` so the model
   *cannot* return malformed data — bad outputs are rejected at the API
   boundary, not after a parse-and-pray.

Keeping the structured-output schema in the same module as the API
shapes avoids a duplicate definition (the API simply re-shapes the
LLM's output before persisting). If the LLM schema needs to drift from
what the API exposes, split this file later.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


# ── OpenAI Structured-Outputs schema ────────────────────────────────────
# These models are sent to the SDK as the response_format spec. The model
# is forced to return JSON matching this exact shape; deviations raise
# at the API boundary. Field descriptions become inline guidance for the
# extraction model — keep them concrete and example-driven.

class ExtractedLineItem(BaseModel):
    """One row as the model produces it. Fields mirror ``ProjectLineItem``
    but stay separate because the LLM emits Python-friendly types and the
    operator may edit before persistence."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["material", "leistung", "sonstige"] = Field(
        description=(
            "Implicit classification: 'material' for physical goods like "
            "panels, cables, screws; 'leistung' for services / labour like "
            "'Inbetriebnahme' or 'DC-Verkabelung'; 'sonstige' as the catch-all."
        )
    )
    section_title: str | None = Field(
        default=None,
        description=(
            "Hierarchical group label from the source doc, e.g. "
            "'01 Baustelle' or 'Photovoltaikanlage'. Null if the doc has "
            "no section breakdown."
        ),
    )
    position: str | None = Field(
        default=None,
        description=(
            "Original position number verbatim, e.g. '01.01' or 'Pos. 7'. "
            "Preserve the supplier's exact format."
        ),
    )
    description: str = Field(
        description=(
            "Full item description as printed. Do NOT summarise or rewrite "
            "— operators search by exact strings."
        )
    )
    sku: str | None = Field(
        default=None,
        description=(
            "Manufacturer SKU if recognisable inside the description, e.g. "
            "'WST-485BD/X54-B2'. Null when no clear SKU is present."
        ),
    )
    manufacturer: str | None = Field(
        default=None,
        description="Brand / manufacturer name when stated, e.g. 'WINAICO'.",
    )
    quantity_required: float = Field(
        description=(
            "Quantity from the document (the 'Menge' column for AB / "
            "Bestellbestätigung; the delivered quantity for Lieferschein). "
            "Use a positive number; fractions are allowed (e.g. 8.5 for "
            "8.5m of cable)."
        )
    )
    unit: str | None = Field(
        default=None,
        description=(
            "Unit of measure, e.g. 'Stk', 'm', 'm2', 'pauschal'. "
            "Preserve the source-doc spelling."
        ),
    )
    unit_price_eur: float | None = Field(
        default=None,
        description=(
            "Net unit price in EUR if the document carries pricing "
            "(Auftragsbestätigung / Bestellbestätigung). Null for "
            "Lieferschein documents which never have prices."
        ),
    )
    total_price_eur: float | None = Field(
        default=None,
        description=(
            "Net total price in EUR (quantity × unit price). Null when "
            "pricing is not in the document."
        ),
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description=(
            "Self-assessed extraction confidence, 0.00–1.00. Use 0.95+ "
            "for clear table rows, 0.7–0.9 when fields are inferred from "
            "free text, ≤0.5 when the row is a guess from poor OCR."
        ),
    )


class ExtractedLineItemList(BaseModel):
    """Wrapper required by OpenAI Structured Outputs — top-level response
    must be an object, not a bare array."""

    model_config = ConfigDict(extra="forbid")

    items: list[ExtractedLineItem] = Field(
        default_factory=list,
        description=(
            "Every line item visible in the document, in source order. "
            "Skip header / footer / total rows. Skip empty positions. "
            "Return an empty list if no line items are present."
        ),
    )


# ── API request shapes ──────────────────────────────────────────────────

class LineItemExtractionEnqueueOut(BaseModel):
    """Returned by the create-job endpoint. Holds just enough for the FE
    to immediately route to the polling page; full status comes from the
    GET endpoint."""

    job_id: int
    status: str


class LineItemExtractionJobOut(BaseModel):
    """Read shape for a single extraction job. Mirrors the model row +
    the parsed extracted_items_json for review."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    doc_type: str
    source_kind: str
    source_filename: str | None
    status: str
    attempt_count: int
    max_attempts: int
    error_message: str | None
    started_at: datetime | None
    completed_at: datetime | None
    extracted_items_json: list[dict[str, Any]] = Field(default_factory=list)
    extracted_items_count: int
    extracted_by_model: str | None
    input_tokens: int | None
    output_tokens: int | None
    confirmed_at: datetime | None
    created_by: int | None
    created_at: datetime
    updated_at: datetime
