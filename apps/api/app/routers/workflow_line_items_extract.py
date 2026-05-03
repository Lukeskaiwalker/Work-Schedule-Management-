"""LLM extraction endpoints (v2.4.0).

Three endpoints:

- ``POST /projects/{id}/line-items/extract`` — enqueue an extraction
  job. Accepts either an uploaded PDF/image (multipart) or a JSON body
  with ``email_text`` for the text-only flow.
- ``GET  /projects/{id}/line-items/extract/{job_id}`` — poll status
  + parsed items for the importer UI.
- ``GET  /projects/{id}/line-items/extract`` — list recent jobs for
  the project (last 50). Useful for the importer UI's recent-jobs
  panel.

The actual LLM work happens in the worker; these endpoints only stage
the job row. See ``app/services/line_item_extraction.py``.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import require_permission
from app.core.time import utcnow
from app.models.entities import LineItemExtractionJob, Project, ProjectLineItem, User
from app.models.line_item_extraction_job import (
    DOC_TYPE_AUFTRAGSBESTAETIGUNG,
    DOC_TYPE_BESTELLBESTAETIGUNG,
    DOC_TYPE_LIEFERSCHEIN,
    EXTRACTION_JOB_STATUS_COMPLETED,
    SOURCE_KIND_EMAIL_TEXT,
    SOURCE_KIND_IMAGE,
    SOURCE_KIND_PDF,
)
from app.schemas.api import (
    ExtractionConfirmRequest,
    ExtractionConfirmResult,
    LineItemExtractionEnqueueOut,
    LineItemExtractionJobOut,
)
from app.services.audit import log_admin_action
from app.services.files import store_encrypted_file
from app.services.line_item_extraction import queue_line_item_extraction_job

router = APIRouter(tags=["line-items:extract"])

# Doc-type allowlist for the enqueue endpoint. ``manuell`` is intentionally
# excluded — manual rows go through the regular CRUD endpoint, not the
# extraction queue.
_ALLOWED_DOC_TYPES = {
    DOC_TYPE_AUFTRAGSBESTAETIGUNG,
    DOC_TYPE_BESTELLBESTAETIGUNG,
    DOC_TYPE_LIEFERSCHEIN,
}

# Filename-extension → source_kind + storage extension. Drives both
# encrypted-storage suffixing and worker input prep.
_PDF_EXTS = {".pdf"}
_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def _get_project_or_404(db: Session, project_id: int) -> Project:
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _serialize_job(job: LineItemExtractionJob) -> LineItemExtractionJobOut:
    return LineItemExtractionJobOut(
        id=job.id,
        project_id=job.project_id,
        doc_type=job.doc_type,
        source_kind=job.source_kind,
        source_filename=job.source_filename,
        status=job.status,
        attempt_count=job.attempt_count,
        max_attempts=job.max_attempts,
        error_message=job.error_message,
        started_at=job.started_at,
        completed_at=job.completed_at,
        extracted_items_json=list(job.extracted_items_json or []),
        extracted_items_count=job.extracted_items_count,
        extracted_by_model=job.extracted_by_model,
        input_tokens=job.input_tokens,
        output_tokens=job.output_tokens,
        confirmed_at=job.confirmed_at,
        created_by=job.created_by,
        created_at=job.created_at,
        updated_at=job.updated_at,
    )


@router.post(
    "/projects/{project_id}/line-items/extract",
    response_model=LineItemExtractionEnqueueOut,
    status_code=202,
)
async def create_extraction_job(
    project_id: int,
    doc_type: str = Form(...),
    file: UploadFile | None = File(default=None),
    email_text: str | None = Form(default=None),
    user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    """Enqueue an extraction job.

    Exactly one of ``file`` or ``email_text`` must be provided. The 202
    status code emphasises that the actual extraction is async — the
    client should poll the GET endpoint to see progress.
    """
    project = _get_project_or_404(db, project_id)

    if doc_type not in _ALLOWED_DOC_TYPES:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported doc_type {doc_type!r}. Use one of: "
                f"{', '.join(sorted(_ALLOWED_DOC_TYPES))}."
            ),
        )

    if (file is None) == (not (email_text or "").strip()):
        # XOR check: exactly one input must be set.
        raise HTTPException(
            status_code=400,
            detail="Provide exactly one of `file` or `email_text` — not both, not neither.",
        )

    source_kind: str
    source_filename: str | None = None
    source_stored_path: str | None = None
    source_text: str | None = None

    if file is not None:
        filename = (file.filename or "").strip()
        lower = filename.lower()
        if any(lower.endswith(ext) for ext in _PDF_EXTS):
            source_kind = SOURCE_KIND_PDF
            stored_extension = "pdf"
        elif any(lower.endswith(ext) for ext in _IMAGE_EXTS):
            source_kind = SOURCE_KIND_IMAGE
            # Strip the leading dot for store_encrypted_file's extension arg.
            stored_extension = next(
                (ext.lstrip(".") for ext in _IMAGE_EXTS if lower.endswith(ext)),
                "png",
            )
        else:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Uploaded file must be a PDF or image (PNG / JPG / "
                    "JPEG / WebP). Use the `email_text` field for raw "
                    "email bodies."
                ),
            )
        payload = await file.read()
        if not payload:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")
        source_filename = filename or None
        source_stored_path = store_encrypted_file(payload, stored_extension)
    else:
        source_kind = SOURCE_KIND_EMAIL_TEXT
        source_text = (email_text or "").strip()
        if len(source_text) > 50_000:
            # Hard cap to prevent absurd prompts; 50k chars is ~12k tokens.
            raise HTTPException(
                status_code=400,
                detail="Email body exceeds 50,000 characters; please paste the relevant section only.",
            )

    job = queue_line_item_extraction_job(
        db,
        project_id=project.id,
        doc_type=doc_type,
        source_kind=source_kind,
        source_filename=source_filename,
        source_stored_path=source_stored_path,
        source_text=source_text,
        created_by=user.id,
    )
    db.commit()
    db.refresh(job)

    log_admin_action(
        db,
        user,
        "project_line_item_extraction.enqueue",
        "projects",
        str(project.id),
        {
            "job_id": job.id,
            "doc_type": doc_type,
            "source_kind": source_kind,
            "source_filename": source_filename,
        },
    )

    return LineItemExtractionEnqueueOut(job_id=job.id, status=job.status)


@router.get(
    "/projects/{project_id}/line-items/extract/{job_id}",
    response_model=LineItemExtractionJobOut,
)
def get_extraction_job(
    project_id: int,
    job_id: int,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    """Polling endpoint for the importer UI."""
    job = db.get(LineItemExtractionJob, job_id)
    if job is None or job.project_id != project_id:
        # 404 (not 403) so we don't leak the existence of jobs in other
        # projects.
        raise HTTPException(status_code=404, detail="Extraction job not found")
    return _serialize_job(job)


@router.get(
    "/projects/{project_id}/line-items/extract",
    response_model=list[LineItemExtractionJobOut],
)
def list_extraction_jobs(
    project_id: int,
    _: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    """List the 50 most recent extraction jobs for the project."""
    _get_project_or_404(db, project_id)
    rows = db.scalars(
        select(LineItemExtractionJob)
        .where(LineItemExtractionJob.project_id == project_id)
        .order_by(LineItemExtractionJob.id.desc())
        .limit(50)
    ).all()
    return [_serialize_job(row) for row in rows]


@router.post(
    "/projects/{project_id}/line-items/extract/{job_id}/confirm",
    response_model=ExtractionConfirmResult,
)
def confirm_extraction_job(
    project_id: int,
    job_id: int,
    payload: ExtractionConfirmRequest,
    user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    """Promote the (operator-edited) extracted items into real
    ``ProjectLineItem`` rows.

    The flow:

    1. Validate the job belongs to this project and is ``completed``.
       Jobs in any other status (queued / processing / failed) cannot
       be confirmed — re-trigger extraction first.
    2. Reject re-confirm: ``confirmed_at`` must be null. We don't merge
       or de-duplicate — if the operator wants to re-import after a
       partial accept, they create a new extraction job.
    3. Build all rows in memory, then ``add_all`` + commit in one
       transaction. Either every item lands or none — no half-imports.
    4. Stamp ``confirmed_at`` on the job and audit-log the action with
       the count + job_id.

    Source attribution on each created row comes from the job
    (``source_doc_type``, ``source_doc_filename``, ``extracted_by_model``)
    so the trail back to the originating document is preserved even if
    the operator edited every field.
    """
    project = _get_project_or_404(db, project_id)

    job = db.get(LineItemExtractionJob, job_id)
    if job is None or job.project_id != project.id:
        raise HTTPException(status_code=404, detail="Extraction job not found")

    if job.status != EXTRACTION_JOB_STATUS_COMPLETED:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Extraction job is in status {job.status!r}; only "
                "'completed' jobs can be confirmed."
            ),
        )

    if job.confirmed_at is not None:
        raise HTTPException(
            status_code=409,
            detail="Extraction job has already been confirmed.",
        )

    rows: list[ProjectLineItem] = []
    for incoming in payload.items:
        rows.append(
            ProjectLineItem(
                project_id=project.id,
                type=incoming.type,
                section_title=incoming.section_title,
                position=incoming.position,
                description=incoming.description.strip(),
                sku=incoming.sku,
                manufacturer=incoming.manufacturer,
                quantity_required=incoming.quantity_required,
                # The four follow-on quantity columns default to 0
                # via the model defaults; only quantity_required carries
                # extracted data at confirmation time.
                unit=incoming.unit,
                unit_price_eur=incoming.unit_price_eur,
                total_price_eur=incoming.total_price_eur,
                source_doc_type=job.doc_type,
                source_doc_filename=job.source_filename,
                extracted_by_model=job.extracted_by_model,
                extraction_confidence=incoming.extraction_confidence,
                notes=incoming.notes,
                is_active=True,
                created_by=user.id,
            )
        )

    db.add_all(rows)
    job.confirmed_at = utcnow()
    db.commit()
    for row in rows:
        db.refresh(row)

    log_admin_action(
        db,
        user,
        "project_line_item_extraction.confirm",
        "projects",
        str(project.id),
        {
            "job_id": job.id,
            "doc_type": job.doc_type,
            "source_filename": job.source_filename,
            "created_count": len(rows),
        },
    )

    return ExtractionConfirmResult(
        job_id=job.id,
        created_count=len(rows),
        line_item_ids=[row.id for row in rows],
    )
