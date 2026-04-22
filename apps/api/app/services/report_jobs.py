from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.time import utcnow
from app.models.entities import (
    Attachment,
    ConstructionReport,
    ConstructionReportJob,
    Project,
    ProjectFolder,
    User,
)
from app.services.construction_report_pdf import (
    build_report_filename,
    build_report_pdf_bytes,
    build_report_summary_text,
    compact_photo_for_pdf,
)
from app.services.files import read_encrypted_file, store_encrypted_file
from app.services.report_feed import post_report_to_feed_thread
from app.services.runtime_settings import get_company_settings
from app.services.telegram import send_telegram_report, telegram_enabled

logger = logging.getLogger(__name__)
settings = get_settings()

REPORT_PROCESSING_QUEUED = "queued"
REPORT_PROCESSING_PROCESSING = "processing"
REPORT_PROCESSING_COMPLETED = "completed"
REPORT_PROCESSING_FAILED = "failed"

REPORT_JOB_STATUS_QUEUED = "queued"
REPORT_JOB_STATUS_PROCESSING = "processing"
REPORT_JOB_STATUS_COMPLETED = "completed"
REPORT_JOB_STATUS_FAILED = "failed"


def queue_construction_report_job(
    db: Session,
    *,
    report_id: int,
    send_telegram: bool,
    max_attempts: int = 3,
) -> ConstructionReportJob:
    job = db.scalars(
        select(ConstructionReportJob).where(ConstructionReportJob.construction_report_id == report_id).limit(1)
    ).first()
    if job:
        job.send_telegram = bool(send_telegram)
        job.max_attempts = max(1, int(max_attempts))
        if job.status == REPORT_JOB_STATUS_FAILED:
            job.status = REPORT_JOB_STATUS_QUEUED
            job.completed_at = None
            job.error_message = None
    else:
        job = ConstructionReportJob(
            construction_report_id=report_id,
            send_telegram=bool(send_telegram),
            status=REPORT_JOB_STATUS_QUEUED,
            max_attempts=max(1, int(max_attempts)),
        )
        db.add(job)
        db.flush()
    return job


def claim_next_construction_report_job(db: Session) -> ConstructionReportJob | None:
    stmt = (
        select(ConstructionReportJob)
        .where(ConstructionReportJob.status == REPORT_JOB_STATUS_QUEUED)
        .order_by(ConstructionReportJob.created_at.asc(), ConstructionReportJob.id.asc())
        .limit(1)
    )
    dialect_name = str(db.bind.dialect.name if db.bind is not None else "").lower()
    if dialect_name != "sqlite":
        stmt = stmt.with_for_update(skip_locked=True)
    job = db.scalars(stmt).first()
    if not job:
        return None
    mark_construction_report_job_processing(db, job)
    db.commit()
    db.refresh(job)
    return job


def mark_construction_report_job_processing(db: Session, job: ConstructionReportJob) -> None:
    now = utcnow()
    job.status = REPORT_JOB_STATUS_PROCESSING
    job.started_at = now
    job.completed_at = None
    job.error_message = None
    job.attempt_count = int(job.attempt_count or 0) + 1
    report = db.get(ConstructionReport, job.construction_report_id)
    if report:
        report.processing_status = REPORT_PROCESSING_PROCESSING
        report.processing_error = None


def report_processing_payload(report: ConstructionReport) -> dict[str, Any]:
    return {
        "report_id": report.id,
        "project_id": report.project_id,
        "report_number": report.report_number,
        "processing_status": report.processing_status or REPORT_PROCESSING_QUEUED,
        "processing_error": report.processing_error,
        "processed_at": report.processed_at,
        "telegram_sent": bool(report.telegram_sent),
        "telegram_mode": report.telegram_mode or "stub",
        "attachment_file_name": report.pdf_file_name,
    }


def _register_project_folder_for_report(
    db: Session,
    *,
    project_id: int,
    folder_path: str,
    created_by: int | None,
) -> None:
    normalized = (folder_path or "").strip().strip("/")
    if not normalized:
        return
    cumulative: list[str] = []
    for segment in normalized.split("/"):
        clean = segment.strip()
        if not clean:
            continue
        cumulative.append(clean)
        current_path = "/".join(cumulative)
        exists = db.scalars(
            select(ProjectFolder.id).where(ProjectFolder.project_id == project_id, ProjectFolder.path == current_path)
        ).first()
        if exists:
            continue
        db.add(
            ProjectFolder(
                project_id=project_id,
                path=current_path,
                is_protected=False,
                created_by=created_by,
            )
        )


def _report_image_attachments(db: Session, report_id: int) -> list[Attachment]:
    rows = db.scalars(
        select(Attachment)
        .where(Attachment.construction_report_id == report_id)
        .order_by(Attachment.id.asc())
    ).all()
    output: list[Attachment] = []
    for row in rows:
        content_type = (row.content_type or "").strip().lower()
        if content_type.startswith("image/"):
            output.append(row)
            continue
        lower_name = (row.file_name or "").lower()
        if lower_name.endswith((".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif")):
            output.append(row)
    return output


def _latest_report_pdf_attachment(db: Session, report_id: int) -> Attachment | None:
    return db.scalars(
        select(Attachment)
        .where(
            Attachment.construction_report_id == report_id,
            Attachment.content_type == "application/pdf",
        )
        .order_by(Attachment.id.desc())
        .limit(1)
    ).first()


async def process_construction_report_job(db: Session, job_id: int) -> ConstructionReportJob | None:
    job = db.get(ConstructionReportJob, job_id)
    if not job:
        return None
    if job.status == REPORT_JOB_STATUS_COMPLETED:
        return job
    if job.status == REPORT_JOB_STATUS_FAILED and int(job.attempt_count or 0) >= max(1, int(job.max_attempts or 1)):
        return job
    if job.status != REPORT_JOB_STATUS_PROCESSING:
        mark_construction_report_job_processing(db, job)
        db.commit()
        db.refresh(job)
    report = db.get(ConstructionReport, job.construction_report_id)
    if not report:
        job.status = REPORT_JOB_STATUS_FAILED
        job.error_message = "Construction report no longer exists"
        job.completed_at = utcnow()
        db.commit()
        return job

    try:
        payload = dict(report.payload or {})
        project = db.get(Project, report.project_id) if report.project_id is not None else None
        submitted_by_user = db.get(User, report.user_id)
        submitted_by = submitted_by_user.display_name if submitted_by_user else "Unknown user"
        company_settings = get_company_settings(db)
        uploaded_by_user_id = submitted_by_user.id if submitted_by_user and submitted_by_user.id else report.user_id
        if not uploaded_by_user_id:
            raise RuntimeError("Report submitter missing")
        report_file_name = (report.pdf_file_name or "").strip() or build_report_filename(
            payload,
            report.report_date,
            report_number=report.report_number,
        )
        report.pdf_file_name = report_file_name

        pdf_attachment = _latest_report_pdf_attachment(db, report.id)
        if pdf_attachment:
            report_pdf = read_encrypted_file(pdf_attachment.stored_path)
        else:
            report_photos: list[tuple[str, bytes]] = []
            for image_attachment in _report_image_attachments(db, report.id):
                raw_image = read_encrypted_file(image_attachment.stored_path)
                if not raw_image:
                    continue
                report_photos.append((image_attachment.file_name, compact_photo_for_pdf(raw_image)))
            report_pdf = build_report_pdf_bytes(
                payload=payload,
                report_date=report.report_date,
                submitted_by=submitted_by,
                project_name=project.name if project else None,
                logo_path=settings.report_logo_path,
                company_name=str(company_settings.get("company_name") or "").strip() or "SMPL",
                photos=report_photos,
            )
            stored_path = store_encrypted_file(report_pdf, "pdf")
            pdf_attachment = Attachment(
                project_id=report.project_id,
                construction_report_id=report.id,
                uploaded_by=uploaded_by_user_id,
                folder_path="Berichte",
                file_name=report_file_name,
                content_type="application/pdf",
                stored_path=stored_path,
                is_encrypted=True,
            )
            db.add(pdf_attachment)
            if report.project_id is not None:
                _register_project_folder_for_report(
                    db,
                    project_id=report.project_id,
                    folder_path="Berichte",
                    created_by=uploaded_by_user_id,
                )
            db.flush()

        report_summary = build_report_summary_text(
            project_id=report.project_id,
            report_date=report.report_date,
            payload=payload,
            submitted_by=submitted_by,
        )
        telegram_sent = False
        telegram_mode = "stub"
        if job.send_telegram:
            if telegram_enabled():
                telegram_sent = await send_telegram_report(report_summary, report_pdf, report_file_name)
                telegram_mode = "live"
            else:
                telegram_mode = "stub"

        now = utcnow()
        report.telegram_sent = telegram_sent
        report.telegram_mode = telegram_mode
        report.processing_status = REPORT_PROCESSING_COMPLETED
        report.processing_error = None
        report.processed_at = now
        report.pdf_file_name = report_file_name
        try:
            post_report_to_feed_thread(
                db,
                report=report,
                pdf_attachment=pdf_attachment,
            )
        except Exception:  # pragma: no cover - report creation must not fail on feed-post issues
            logger.exception("Failed to post report %s into feed thread", report.id)
        job.status = REPORT_JOB_STATUS_COMPLETED
        job.error_message = None
        job.completed_at = now
        db.commit()
        db.refresh(job)
        return job
    except Exception as exc:  # pragma: no cover - exercised in integration tests
        db.rollback()
        logger.exception("Construction report job %s failed", job_id)
        job = db.get(ConstructionReportJob, job_id)
        report = db.get(ConstructionReport, job.construction_report_id) if job else None
        if not job:
            return None
        error_text = str(exc).strip() or exc.__class__.__name__
        if len(error_text) > 1000:
            error_text = error_text[:1000]
        retryable = int(job.attempt_count or 0) < max(1, int(job.max_attempts or 1))
        now = utcnow()
        job.status = REPORT_JOB_STATUS_QUEUED if retryable else REPORT_JOB_STATUS_FAILED
        job.error_message = error_text
        job.completed_at = None if retryable else now
        if report:
            report.processing_status = REPORT_PROCESSING_QUEUED if retryable else REPORT_PROCESSING_FAILED
            report.processing_error = error_text
            if not retryable:
                report.processed_at = now
        db.commit()
        db.refresh(job)
        return job
