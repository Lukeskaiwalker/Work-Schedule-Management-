from __future__ import annotations

from datetime import date, datetime, time

from fastapi import APIRouter
from sqlalchemy import and_, or_

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
    since: date | None = None,
    until: date | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Recent construction reports.

    Default (no date params): the newest-N reports by submission time — this is
    what the Overview "latest reports" card uses, and it stays unchanged.

    With ``since`` / ``until``: a date-range history window (the "reports from the
    last N weeks" view), filtered and sorted by the site-visit ``report_date`` to
    match how the site calendar frames a window, with a larger result cap since a
    4-week window can hold more than the card's handful.
    """
    _assert_report_access(current_user, write=False)
    date_filtered = since is not None or until is not None
    if date_filtered:
        safe_limit = max(1, min(int(limit or 500), 500))
        stmt = select(ConstructionReport)
        # A report counts as "in the window" when EITHER its site-visit date
        # (report_date) OR its submission time (created_at) falls in the range.
        # Filtering on report_date alone hid reports that were filed recently but
        # carry an older visit date — from the operator's view the report simply
        # vanished after submitting it. Recent activity of either kind shows up.
        report_window = []
        created_window = []
        if since is not None:
            report_window.append(ConstructionReport.report_date >= since)
            created_window.append(ConstructionReport.created_at >= datetime.combine(since, time.min))
        if until is not None:
            report_window.append(ConstructionReport.report_date <= until)
            created_window.append(ConstructionReport.created_at <= datetime.combine(until, time.max))
        stmt = stmt.where(or_(and_(*report_window), and_(*created_window)))
        stmt = stmt.order_by(
            ConstructionReport.report_date.desc(),
            ConstructionReport.created_at.desc(),
            ConstructionReport.id.desc(),
        ).limit(safe_limit)
    else:
        safe_limit = max(1, min(int(limit or 10), 50))
        stmt = (
            select(ConstructionReport)
            .order_by(ConstructionReport.created_at.desc(), ConstructionReport.id.desc())
            .limit(safe_limit)
        )
    reports = db.scalars(stmt).all()
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


@router.get("/projects/{project_id}/construction-reports/distance")
def get_construction_report_distance(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """v2.5.18: returns the auto-calculated company → site round-trip
    driving distance for the given project. Used by the Baustellenbericht
    form to pre-fill the 'Kilometer (gesamt)' field on open.

    Response shape:
        {
          "kilometers": int | None,     # round-trip km (None when source != "auto")
          "one_way_km": float | None,   # for the explainer tooltip
          "source": str,                # "auto" / "no_api_key" / "no_company_address"
                                        # / "no_site_address" / "geocode_failed"
        }

    Frontend treats source="auto" with kilometers!=None as "pre-fill the
    field with this value and show the badge 'automatisch berechnet'".
    Any other source means auto-fill is unavailable and the operator must
    enter the value manually.
    """
    assert_project_access(db, current_user, project_id)
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    from app.services.distance import compute_company_to_site_distance, resolve_project_site_address
    from app.services.runtime_settings import get_company_settings

    company_settings = get_company_settings(db)
    # v2.5.26 — fall back to ``customer_address`` when the dedicated
    # ``construction_site_address`` is empty. Many real projects only
    # have customer_address populated (the customer's billing/home
    # address, which is often where the work happens for small
    # contractors), and v2.5.18 was silently giving up on those —
    # producing a "—" in the PDF's km row even though we *had* a
    # perfectly usable address to geocode.
    result = compute_company_to_site_distance(
        db,
        company_address=str(company_settings.get("company_address") or "").strip() or None,
        site_address=resolve_project_site_address(project),
    )
    return {
        "kilometers": result.round_trip_km,
        "one_way_km": result.one_way_km,
        "source": result.source,
    }
