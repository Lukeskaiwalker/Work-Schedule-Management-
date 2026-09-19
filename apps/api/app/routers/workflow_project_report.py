"""The Projektbericht: one sheet with everything about the project.

Rendered live from the project's data for as long as the project runs
(``GET /projects/{id}/report/preview`` and its paged variant for engines
without a PDF viewer); stored as a PDF in the project's Berichte folder when
the project is marked abgeschlossen or archived (``POST …/report/finalize``,
also triggered by that status change in update_project).

Nothing is bookkept between previews: the report is derived, so "appending"
a note or a site report to it is nothing more than the next render.
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter

from app.core.events import notify
from app.routers.workflow_helpers import *  # noqa: F401,F403
from app.schemas.project import ProjectReportStateOut
from app.services.pdf_preview import (
    PAGE_MEDIA_TYPE,
    PdfPreviewBusy,
    PdfPreviewUnavailable,
    pdf_page_count,
    render_pdf_page,
)
from app.services.project_report_data import collect_project_report_data
from app.services.project_report_pdf import build_project_report_filename, render_project_report_pdf
from app.services.project_status import PROJECT_STATUS_ABGESCHLOSSEN, normalize_project_status
from app.services.runtime_settings import get_company_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="", tags=["project-report"])

# Where the stored copy lands — the folder the site reports already use, so
# the project's paperwork is in one place.
REPORT_FOLDER = "Berichte"
PDF_MEDIA_TYPE = "application/pdf"

# ── Reading ──────────────────────────────────────────────────────────────────


def _project_for_read(db: Session, current_user: User, project_id: int) -> Project:
    assert_project_access(db, current_user, project_id)
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _render(db: Session, project: Project, *, final: bool, generated_at: datetime) -> bytes:
    company = get_company_settings(db)
    return render_project_report_pdf(
        collect_project_report_data(db, project.id),
        final=final,
        generated_at=generated_at,
        logo_path=get_settings().report_logo_path,
        company_name=str(company.get("company_name") or "").strip() or None,
    )


def _pdf_response(pdf: bytes, file_name: str, *, inline: bool) -> Response:
    return Response(
        content=pdf,
        media_type=PDF_MEDIA_TYPE,
        headers={
            # The same hardening as a stored file's preview: nosniff so the
            # browser takes our word for the type, and a CSP that keeps the
            # engine's own PDF viewer working while forbidding scripts and
            # plugins (see _attachment_http_response for the history).
            "Content-Disposition": _content_disposition(file_name, inline=inline),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": (
                "script-src 'none'; object-src 'none'; base-uri 'none'; "
                "form-action 'none'; frame-ancestors 'self'"
            ),
            "Referrer-Policy": "no-referrer",
            # "Stand jetzt" must not come out of a cache.
            "Cache-Control": "no-store",
        },
    )


def project_report_state_out(db: Session, project: Project) -> ProjectReportStateOut:
    """Whether and where the stored copy is. The pointer is SET NULL when the
    file is deleted, so a stale id answers "not finalized" rather than 500."""
    attachment = db.get(Attachment, project.report_attachment_id) if project.report_attachment_id else None
    return ProjectReportStateOut(
        finalized_at=project.report_finalized_at if attachment is not None else None,
        attachment_id=attachment.id if attachment is not None else None,
        file_name=attachment.file_name if attachment is not None else None,
    )


@router.get("/projects/{project_id}/report", response_model=ProjectReportStateOut)
def get_project_report_state(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    project = _project_for_read(db, current_user, project_id)
    return project_report_state_out(db, project)


@router.get("/projects/{project_id}/report/preview")
def preview_project_report(
    project_id: int,
    download: bool = Query(False),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The report as of now, inline; ``?download=1`` saves it under its name."""
    project = _project_for_read(db, current_user, project_id)
    now = utcnow()
    pdf = _render(db, project, final=False, generated_at=now)
    return _pdf_response(pdf, build_project_report_filename(project.project_number, now), inline=not download)


@router.get("/projects/{project_id}/report/preview-pages")
def preview_project_report_page_count(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Page count for the paged preview — same contract as /files/{id}/preview-pages."""
    project = _project_for_read(db, current_user, project_id)
    pdf = _render(db, project, final=False, generated_at=utcnow())
    try:
        return {"page_count": pdf_page_count(pdf)}
    except PdfPreviewUnavailable:
        raise HTTPException(status_code=409, detail="PDF konnte nicht gelesen werden")


@router.get("/projects/{project_id}/report/preview-pages/{page}")
def preview_project_report_page(
    project_id: int,
    page: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """One page as PNG. Rendered once per request — the report is small next
    to the poppler call, and a cache would have to know when it went stale."""
    project = _project_for_read(db, current_user, project_id)
    pdf = _render(db, project, final=False, generated_at=utcnow())
    try:
        png = render_pdf_page(pdf, page)
    except PdfPreviewBusy:
        raise HTTPException(
            status_code=503,
            detail="Vorschau ist gerade ausgelastet — bitte kurz erneut versuchen.",
            headers={"Retry-After": "3"},
        )
    except PdfPreviewUnavailable as exc:
        # Past the last page is the pager iterating — 404; anything about the
        # document itself is a 409. Same split as the file preview.
        status_code = 404 if "existiert nicht" in str(exc) else 409
        raise HTTPException(status_code=status_code, detail="Seite nicht verfügbar")
    return Response(
        content=png,
        media_type=PAGE_MEDIA_TYPE,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": _content_disposition(f"seite-{page}.png", inline=True),
            "Cache-Control": "no-store",
        },
    )


# ── Finalizing ───────────────────────────────────────────────────────────────


def store_final_project_report(db: Session, project: Project, *, actor_user_id: int) -> Attachment:
    """Render the report as of this moment and file it under Berichte.

    Adds rows and sets the project's pointer on the session; the caller
    commits. A second call stores a second file and moves the pointer — the
    earlier copy stays in the folder, it is still a true record of its day.
    """
    # Rows the caller added but never flushed — the status change's activity,
    # typically — must be on the page. Sessions here do not autoflush.
    db.flush()
    now = utcnow()
    pdf = _render(db, project, final=True, generated_at=now)
    file_name = build_project_report_filename(project.project_number, now)
    stored_path = store_encrypted_file(pdf, "pdf")
    _register_project_folder(db, project_id=project.id, folder_path=REPORT_FOLDER, created_by=actor_user_id)
    attachment = Attachment(
        project_id=project.id,
        uploaded_by=actor_user_id,
        folder_path=REPORT_FOLDER,
        file_name=file_name,
        content_type=PDF_MEDIA_TYPE,
        stored_path=stored_path,
        is_encrypted=True,
        created_at=now,
    )
    db.add(attachment)
    db.flush()
    project.report_finalized_at = now
    project.report_attachment_id = attachment.id
    db.add(project)
    _record_project_activity(
        db,
        project_id=project.id,
        actor_user_id=actor_user_id,
        event_type="project.report_finalized",
        message=f"Projektbericht abgelegt: {file_name}",
        details={"attachment_id": attachment.id, "file_name": file_name},
    )
    return attachment


def _closes_project(status: str | None) -> bool:
    """abgeschlossen (any synonym) or the archive — the two ends of a project.
    The archive rule is the one _is_project_archived applies."""
    value = (status or "").strip().lower()
    if not value:
        return False
    if normalize_project_status(value) == PROJECT_STATUS_ABGESCHLOSSEN:
        return True
    return value in {"archived", "archiviert"} or "archiv" in value


def finalize_project_report_on_status_change(
    db: Session,
    project: Project,
    previous_status: str | None,
    next_status: str | None,
    actor_user_id: int,
) -> None:
    """Called by update_project after it recorded the status change; the
    caller commits.

    Edge-triggered: only the move INTO abgeschlossen or the archive files a
    report, so abgeschlossen → archived does not store a second copy, while
    re-opening and finishing again does. And it must never cost the status
    change itself: whatever goes wrong in rendering or storing is rolled back
    to a savepoint, logged, and left on the activity feed for the office.
    """
    if not _closes_project(next_status) or _closes_project(previous_status):
        return
    # The status change and its activity go to the database BEFORE the
    # savepoint opens, so rolling the savepoint back cannot take them along.
    db.flush()
    try:
        with db.begin_nested():
            store_final_project_report(db, project, actor_user_id=actor_user_id)
    except Exception as exc:  # noqa: BLE001 — the status change must survive anything here
        logger.exception("Projektbericht for project %s could not be stored on status change", project.id)
        _record_project_activity(
            db,
            project_id=project.id,
            actor_user_id=actor_user_id,
            event_type="project.report_finalize_failed",
            message=type(exc).__name__,
            details={"error": str(exc)[:200], "to": next_status or ""},
        )


@router.post("/projects/{project_id}/report/finalize", response_model=ProjectReportStateOut)
def finalize_project_report(
    project_id: int,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    """File the report now, whatever the status — for the manager who wants
    the sheet in the folder before the last invoice, or a fresh one after."""
    project = db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    assert_project_access(db, current_user, project_id, manage_required=True)
    store_final_project_report(db, project, actor_user_id=current_user.id)
    db.commit()
    db.refresh(project)
    # An open overview reloads on any project.* event — that is how the new
    # "Abschlussbericht vom …" line appears on a colleague's screen.
    notify(db, "project.updated", ProjectOut.model_validate(project).model_dump(mode="json"))
    return project_report_state_out(db, project)
