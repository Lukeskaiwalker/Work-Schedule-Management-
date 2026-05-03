"""LineItemExtractionJob — async LLM extraction job for ProjectLineItems.

The v2.4.0 plan splits the import flow into two phases so the operator
always reviews before persisting:

1. **Extract** (this job): the user uploads a PDF / image / email text;
   the worker calls OpenAI Structured Outputs with a strict Pydantic
   schema and stores the resulting array of items here under
   ``extracted_items_json``.

2. **Confirm** (iteration 3 endpoint): the user reviews the extracted
   table, fixes anything wrong, and then a separate endpoint creates the
   real ``ProjectLineItem`` rows from the (possibly edited) job payload.

Storing the LLM output on the job (not directly into ``project_line_items``)
keeps the LLM step idempotent — re-running the worker doesn't duplicate
inventory rows, and the operator can throw a job away without leaving
orphan items behind.

Status FSM mirrors ``ConstructionReportJob`` (queued → processing →
completed | failed) so the same worker poll loop in
``app/services/line_item_extraction.py`` can adopt the same retry-on-error
semantics with minimal new vocabulary to learn.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.time import utcnow


# Job-status FSM. The four values mirror ConstructionReportJob exactly
# so operators reading worker logs only have to learn one vocabulary.
EXTRACTION_JOB_STATUS_QUEUED = "queued"
EXTRACTION_JOB_STATUS_PROCESSING = "processing"
EXTRACTION_JOB_STATUS_COMPLETED = "completed"
EXTRACTION_JOB_STATUS_FAILED = "failed"

# Doc-type vocabulary. We accept whatever the user picks in the UI but
# the worker uses these values to select the right system prompt.
DOC_TYPE_AUFTRAGSBESTAETIGUNG = "auftragsbestaetigung"
DOC_TYPE_BESTELLBESTAETIGUNG = "bestellbestaetigung"
DOC_TYPE_LIEFERSCHEIN = "lieferschein"
DOC_TYPE_MANUELL = "manuell"

# Source-kind vocabulary. Drives whether the worker calls pdf2image,
# treats the bytes as a single image, or uses the stored text directly.
SOURCE_KIND_PDF = "pdf"
SOURCE_KIND_IMAGE = "image"
SOURCE_KIND_EMAIL_TEXT = "email_text"


class LineItemExtractionJob(Base):
    __tablename__ = "line_item_extraction_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
        index=True,
        nullable=False,
    )

    # ── what to extract ────────────────────────────────────────────────
    doc_type: Mapped[str] = mapped_column(String(64), nullable=False)
    """Selects the prompt template — see DOC_TYPE_* constants above."""

    source_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    """One of pdf / image / email_text. Drives input prep in the worker."""

    source_filename: Mapped[str | None] = mapped_column(String(500))
    """Original file name from the upload, for audit + UI breadcrumb."""

    source_stored_path: Mapped[str | None] = mapped_column(String(500))
    """Encrypted-attachment path (PDF / image jobs). Null for email_text."""

    source_text: Mapped[str | None] = mapped_column(Text)
    """Raw email/text body for email_text jobs. Null for PDF / image."""

    # ── job FSM ────────────────────────────────────────────────────────
    status: Mapped[str] = mapped_column(
        String(32), default=EXTRACTION_JOB_STATUS_QUEUED, nullable=False, index=True
    )
    attempt_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=2, nullable=False)
    """LLM calls are expensive — we retry once by default, not 3x like
    report jobs. Operators can re-trigger manually if both attempts fail."""
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)

    # ── extraction output ─────────────────────────────────────────────
    extracted_items_json: Mapped[Any] = mapped_column(JSON, default=list, nullable=False)
    """Array of dicts matching ExtractedLineItem (see schemas/line_item_extraction.py).
    Cleared back to [] on retry so a partial fail doesn't leak stale rows."""
    extracted_items_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    """Materialised len() of extracted_items_json so the UI list view
    doesn't have to deserialise the JSON to render a counter."""
    extracted_by_model: Mapped[str | None] = mapped_column(String(128))
    """Snapshot of the model name at extraction time (config can change)."""
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    """Token usage for cost tracking. Optional — older models or stub
    runs may not report usage."""

    # ── confirmation ──────────────────────────────────────────────────
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    """Set when iteration-3 confirm endpoint creates the real ProjectLineItem
    rows from this job's payload. Null while pending review."""

    # ── audit ─────────────────────────────────────────────────────────
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utcnow, onupdate=utcnow, nullable=False
    )
