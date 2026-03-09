from __future__ import annotations

from fastapi import APIRouter

from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["reports"])


@router.post("/projects/{project_id}/construction-reports")
async def create_construction_report(
    project_id: int,
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return await _create_construction_report_impl(
        request=request,
        current_user=current_user,
        db=db,
        forced_project_id=project_id,
    )

@router.post("/construction-reports")
async def create_construction_report_global(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return await _create_construction_report_impl(
        request=request,
        current_user=current_user,
        db=db,
        forced_project_id=None,
    )

@router.get("/projects/{project_id}/construction-reports")
def list_construction_reports(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, project_id)
    reports = db.scalars(
        select(ConstructionReport).where(ConstructionReport.project_id == project_id).order_by(ConstructionReport.id.desc())
    ).all()
    return [
        {
            "id": report.id,
            "project_id": report.project_id,
            "report_number": report.report_number,
            "user_id": report.user_id,
            "report_date": report.report_date,
            "payload": report.payload,
            "telegram_sent": report.telegram_sent,
            "telegram_mode": report.telegram_mode,
            "processing_status": report.processing_status,
            "processing_error": report.processing_error,
            "processed_at": report.processed_at,
            "attachment_file_name": report.pdf_file_name,
            "created_at": report.created_at,
        }
        for report in reports
    ]

@router.get("/construction-reports")
def list_global_or_project_reports(
    project_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if project_id is not None:
        assert_project_access(db, current_user, project_id)
        stmt = select(ConstructionReport).where(ConstructionReport.project_id == project_id)
    else:
        _assert_report_access(current_user, write=False)
        stmt = select(ConstructionReport).where(ConstructionReport.project_id.is_(None))
    reports = db.scalars(stmt.order_by(ConstructionReport.id.desc())).all()
    return [
        {
            "id": report.id,
            "project_id": report.project_id,
            "report_number": report.report_number,
            "user_id": report.user_id,
            "report_date": report.report_date,
            "payload": report.payload,
            "telegram_sent": report.telegram_sent,
            "telegram_mode": report.telegram_mode,
            "processing_status": report.processing_status,
            "processing_error": report.processing_error,
            "processed_at": report.processed_at,
            "attachment_file_name": report.pdf_file_name,
            "created_at": report.created_at,
        }
        for report in reports
    ]

@router.get("/construction-reports/recent", response_model=list[RecentConstructionReportOut])
def list_recent_construction_reports(
    limit: int = 10,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    _assert_report_access(current_user, write=False)
    safe_limit = max(1, min(int(limit or 10), 50))
    reports = db.scalars(
        select(ConstructionReport).order_by(ConstructionReport.created_at.desc(), ConstructionReport.id.desc()).limit(safe_limit)
    ).all()
    return [_recent_construction_report_out(db, report) for report in reports]

@router.get("/construction-reports/{report_id}/processing")
def get_construction_report_processing_status(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    report = db.get(ConstructionReport, report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Construction report not found")
    if report.project_id is not None:
        assert_project_access(db, current_user, report.project_id)
    else:
        _assert_report_access(current_user, write=False)
    return report_processing_payload(report)

@router.get("/construction-reports/files")
def list_construction_report_files(
    project_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Attachment).where(Attachment.construction_report_id.is_not(None))
    if project_id is not None:
        assert_project_access(db, current_user, project_id)
        stmt = stmt.where(Attachment.project_id == project_id)
    else:
        _assert_report_access(current_user, write=False)
        stmt = stmt.where(Attachment.project_id.is_(None))
    attachments = db.scalars(stmt.order_by(Attachment.created_at.desc())).all()
    return [_attachment_out(attachment) for attachment in attachments]
