"""LLM-assisted line-item extraction service (v2.4.0).

Mirrors the construction-report-job pattern in
``app/services/report_jobs.py``: a worker poll loop claims one queued
job at a time, runs the actual work (here: an OpenAI Structured-Outputs
call), persists the result, and either marks the job ``completed`` or
re-queues it for retry on transient failure.

The service is split into four sections for easy review:

1. **Status helpers** — copy of the FSM constants with a short alias.
2. **Queue / claim** — same pattern as report_jobs.claim_next_*.
3. **Input prep** — turn the stored PDF / image / text into the
   ``messages`` list OpenAI expects (multimodal for PDF / image, plain
   text for email_text).
4. **Process** — call OpenAI, parse the structured output, write items
   onto the job row, set status and counts.

Tests monkeypatch the ``_call_openai_structured`` indirection so they
never need a real OpenAI package, key, or network call.
"""
from __future__ import annotations

import base64
import io
import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.entities import LineItemExtractionJob
from app.models.line_item_extraction_job import (
    DOC_TYPE_AUFTRAGSBESTAETIGUNG,
    DOC_TYPE_BESTELLBESTAETIGUNG,
    DOC_TYPE_LIEFERSCHEIN,
    EXTRACTION_JOB_STATUS_COMPLETED,
    EXTRACTION_JOB_STATUS_FAILED,
    EXTRACTION_JOB_STATUS_PROCESSING,
    EXTRACTION_JOB_STATUS_QUEUED,
    SOURCE_KIND_EMAIL_TEXT,
    SOURCE_KIND_IMAGE,
    SOURCE_KIND_PDF,
)
from app.schemas.line_item_extraction import ExtractedLineItemList
from app.services.files import read_encrypted_file
from app.services.openai_client import (
    OpenAIClientNotConfigured,
    get_extraction_model,
    get_openai_client,
)

logger = logging.getLogger(__name__)


# ── 1. queue / claim ────────────────────────────────────────────────────

def queue_line_item_extraction_job(
    db: Session,
    *,
    project_id: int,
    doc_type: str,
    source_kind: str,
    source_filename: str | None,
    source_stored_path: str | None,
    source_text: str | None,
    created_by: int | None,
    max_attempts: int = 2,
) -> LineItemExtractionJob:
    """Insert a new queued job. Caller is responsible for committing
    the surrounding transaction; we only ``flush`` so the assigned id
    is available to the API response."""
    job = LineItemExtractionJob(
        project_id=project_id,
        doc_type=doc_type,
        source_kind=source_kind,
        source_filename=source_filename,
        source_stored_path=source_stored_path,
        source_text=source_text,
        status=EXTRACTION_JOB_STATUS_QUEUED,
        max_attempts=max(1, int(max_attempts)),
        extracted_items_json=[],
        extracted_items_count=0,
        created_by=created_by,
    )
    db.add(job)
    db.flush()
    return job


def claim_next_line_item_extraction_job(db: Session) -> LineItemExtractionJob | None:
    """Atomically claim the oldest queued job. Mirrors
    ``claim_next_construction_report_job`` — uses ``SELECT FOR UPDATE
    SKIP LOCKED`` on Postgres so multiple workers can run side by side
    without double-processing; falls back to a plain select on SQLite
    (test environment, single worker, no contention)."""
    stmt = (
        select(LineItemExtractionJob)
        .where(LineItemExtractionJob.status == EXTRACTION_JOB_STATUS_QUEUED)
        .order_by(LineItemExtractionJob.created_at.asc(), LineItemExtractionJob.id.asc())
        .limit(1)
    )
    dialect_name = str(db.bind.dialect.name if db.bind is not None else "").lower()
    if dialect_name != "sqlite":
        stmt = stmt.with_for_update(skip_locked=True)
    job = db.scalars(stmt).first()
    if not job:
        return None
    _mark_processing(job)
    db.commit()
    db.refresh(job)
    return job


def _mark_processing(job: LineItemExtractionJob) -> None:
    job.status = EXTRACTION_JOB_STATUS_PROCESSING
    job.started_at = utcnow()
    job.error_message = None
    job.attempt_count = int(job.attempt_count or 0) + 1


# ── 2. prompts ──────────────────────────────────────────────────────────

# Shared system prompt — establishes the extractor's role + universal
# rules. Per-doc-type guidance lives in _user_prompt_for() below.
_SYSTEM_PROMPT = (
    "You are a data-extraction assistant for a German PV / construction "
    "business. Extract every line item (Position) from the supplier "
    "document into the provided JSON schema.\n\n"
    "Rules (apply to all document types):\n"
    "1. Extract every numbered Position. Skip header rows, footer rows, "
    "subtotal rows, VAT rows, and shipping-summary rows.\n"
    "2. Preserve original numbering ('01.01', 'Pos. 7', etc.) and "
    "section titles ('01 Baustelle', 'Photovoltaikanlage') verbatim.\n"
    "3. Classify each row implicitly into 'material' (physical goods like "
    "panels, cables, mounting hardware), 'leistung' (services / labour "
    "like Inbetriebnahme, DC-Verkabelung, Montage), or 'sonstige' "
    "(everything else: transport, allowances, ...).\n"
    "4. SKU is the manufacturer part number when recognisable inside the "
    "description (e.g. 'WST-485BD/X54-B2'). Null when not present.\n"
    "5. Preserve descriptions verbatim — operators search by exact strings. "
    "Do not summarise, translate, or reformat.\n"
    "6. Use a confidence of 0.95+ for clean table rows, 0.7-0.9 for "
    "inferred fields, and ≤0.5 for OCR guesses.\n"
)


_USER_PROMPT_BY_DOC_TYPE: dict[str, str] = {
    DOC_TYPE_AUFTRAGSBESTAETIGUNG: (
        "This is an Auftragsbestätigung (sales-order confirmation). "
        "Extract every Position with: description, Menge (quantity), "
        "Einheit (unit), Einzelpreis (unit price net €), and "
        "Gesamtpreis (total price net €). Both prices are required when "
        "the table shows them."
    ),
    DOC_TYPE_BESTELLBESTAETIGUNG: (
        "This is a Bestellbestätigung (supplier order confirmation). "
        "Extract every ordered item with SKU, manufacturer, quantity, "
        "unit, and pricing. Pricing is usually present; null only if "
        "the row truly omits it."
    ),
    DOC_TYPE_LIEFERSCHEIN: (
        "This is a Lieferschein (delivery note). Extract every "
        "delivered item with SKU, manufacturer, quantity, and unit. "
        "Lieferscheine never carry pricing — leave unit_price_eur and "
        "total_price_eur as null."
    ),
}


def _user_prompt_for(doc_type: str) -> str:
    """Return the doc-type-specific user prompt, or a sensible default
    for unknown / 'manuell' inputs (these go through the manual path
    and shouldn't reach the worker, but we don't want to crash if they
    do)."""
    return _USER_PROMPT_BY_DOC_TYPE.get(
        doc_type,
        "Extract every line item visible in the document.",
    )


# ── 3. input prep ───────────────────────────────────────────────────────

def _pdf_pages_to_data_urls(pdf_bytes: bytes) -> list[str]:
    """Convert a PDF's pages to a list of base64 PNG data URLs ready to
    drop into an OpenAI vision message. Lazy-imports pdf2image so the
    api startup doesn't pay for poppler (installed via Dockerfile)."""
    from pdf2image import convert_from_bytes  # type: ignore[import-not-found]

    images = convert_from_bytes(pdf_bytes, dpi=200, fmt="png")
    out: list[str] = []
    for image in images:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        out.append(f"data:image/png;base64,{encoded}")
    return out


def _image_bytes_to_data_url(image_bytes: bytes, mime_type: str = "image/png") -> str:
    encoded = base64.b64encode(image_bytes).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def _build_messages(job: LineItemExtractionJob) -> list[dict[str, Any]]:
    """Build the OpenAI ``messages`` list for the job. Vision input for
    PDF / image jobs, plain user text for email_text jobs."""
    user_prompt = _user_prompt_for(job.doc_type)

    if job.source_kind == SOURCE_KIND_EMAIL_TEXT:
        body = (job.source_text or "").strip()
        if not body:
            raise ValueError("Email-text extraction job has empty source_text")
        return [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"{user_prompt}\n\nDocument body (verbatim):\n\n{body}"
                ),
            },
        ]

    if not job.source_stored_path:
        raise ValueError(
            f"Job {job.id} has source_kind={job.source_kind!r} "
            "but no source_stored_path"
        )

    raw = read_encrypted_file(job.source_stored_path)
    if not raw:
        raise ValueError(
            f"Stored source file at {job.source_stored_path!r} is empty "
            "or unreadable"
        )

    if job.source_kind == SOURCE_KIND_PDF:
        data_urls = _pdf_pages_to_data_urls(raw)
    elif job.source_kind == SOURCE_KIND_IMAGE:
        # Best-effort mime detection from filename; default to PNG.
        lower = (job.source_filename or "").lower()
        if lower.endswith(".jpg") or lower.endswith(".jpeg"):
            mime = "image/jpeg"
        elif lower.endswith(".webp"):
            mime = "image/webp"
        else:
            mime = "image/png"
        data_urls = [_image_bytes_to_data_url(raw, mime_type=mime)]
    else:
        raise ValueError(f"Unsupported source_kind: {job.source_kind!r}")

    image_parts: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": url}} for url in data_urls
    ]
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_prompt},
                *image_parts,
            ],
        },
    ]


# ── 4. process ──────────────────────────────────────────────────────────

# Indirection point for tests. The real call uses
# ``client.beta.chat.completions.parse`` (OpenAI Structured Outputs);
# tests monkeypatch this function to return a hard-coded
# ``ExtractedLineItemList`` instance plus token counts, side-stepping
# the SDK entirely.
def _call_openai_structured(
    client: Any,
    *,
    model: str,
    messages: list[dict[str, Any]],
) -> tuple[ExtractedLineItemList, int | None, int | None]:
    """Run a Structured Outputs call and return the parsed list + token
    counts. Raises if the model refuses or returns malformed content."""
    completion = client.beta.chat.completions.parse(
        model=model,
        messages=messages,
        response_format=ExtractedLineItemList,
    )
    parsed = completion.choices[0].message.parsed
    if parsed is None:
        # `refusal` is set when the model declined to comply with the
        # schema (rare with valid input but possible).
        refusal = getattr(completion.choices[0].message, "refusal", None) or "unknown"
        raise RuntimeError(f"OpenAI refused or returned no parsed content: {refusal}")
    usage = getattr(completion, "usage", None)
    input_tokens = getattr(usage, "prompt_tokens", None) if usage else None
    output_tokens = getattr(usage, "completion_tokens", None) if usage else None
    return parsed, input_tokens, output_tokens


def process_line_item_extraction_job(
    db: Session, job_id: int
) -> LineItemExtractionJob | None:
    """Run the actual extraction for one job.

    Mirrors ``process_construction_report_job`` semantics:

    - ``completed`` jobs are returned unchanged.
    - ``failed`` jobs over the retry budget are returned unchanged.
    - All other states fall through and execute the LLM call.
    - Exceptions roll back, append the error, and either re-queue (if
      attempts remain) or hard-fail.
    """
    job = db.get(LineItemExtractionJob, job_id)
    if not job:
        return None
    if job.status == EXTRACTION_JOB_STATUS_COMPLETED:
        return job
    if (
        job.status == EXTRACTION_JOB_STATUS_FAILED
        and int(job.attempt_count or 0) >= max(1, int(job.max_attempts or 1))
    ):
        return job
    if job.status != EXTRACTION_JOB_STATUS_PROCESSING:
        _mark_processing(job)
        db.commit()
        db.refresh(job)

    try:
        client = get_openai_client(db)
        model = get_extraction_model(db)
        messages = _build_messages(job)
        parsed, input_tokens, output_tokens = _call_openai_structured(
            client, model=model, messages=messages
        )

        # Persist the items on the job row for review. We dump them
        # through Pydantic so the JSON shape is stable across SDK
        # versions (the parsed object is a Pydantic instance).
        items_json = [item.model_dump(mode="json") for item in parsed.items]
        now = utcnow()
        job.extracted_items_json = items_json
        job.extracted_items_count = len(items_json)
        job.extracted_by_model = model
        job.input_tokens = input_tokens
        job.output_tokens = output_tokens
        job.status = EXTRACTION_JOB_STATUS_COMPLETED
        job.error_message = None
        job.completed_at = now
        db.commit()
        db.refresh(job)
        return job
    except OpenAIClientNotConfigured as exc:
        # Special case: don't retry when the operator hasn't saved a
        # key — this is a config issue, not a transient failure.
        return _fail_job(db, job_id, str(exc), retryable=False)
    except Exception as exc:  # pragma: no cover - exercised in tests
        logger.exception("Line-item extraction job %s failed", job_id)
        return _fail_job(db, job_id, str(exc) or exc.__class__.__name__, retryable=True)


def _fail_job(
    db: Session,
    job_id: int,
    error_text: str,
    *,
    retryable: bool,
) -> LineItemExtractionJob | None:
    db.rollback()
    job = db.get(LineItemExtractionJob, job_id)
    if not job:
        return None
    error_text = (error_text or "").strip() or "Unknown error"
    if len(error_text) > 1000:
        error_text = error_text[:1000]
    attempts = int(job.attempt_count or 0)
    max_attempts = max(1, int(job.max_attempts or 1))
    has_attempts_left = retryable and attempts < max_attempts
    now = utcnow()
    job.status = EXTRACTION_JOB_STATUS_QUEUED if has_attempts_left else EXTRACTION_JOB_STATUS_FAILED
    job.error_message = error_text
    job.completed_at = None if has_attempts_left else now
    db.commit()
    db.refresh(job)
    return job
