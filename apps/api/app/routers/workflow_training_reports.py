"""Ausbildungsnachweise — endpoints for the apprentice weekly training report.

Gating summary (the part worth reading twice):

  * WRITING needs no permission at all — it needs the ``is_apprentice`` flag.
    The sheet is the apprentice's own legal record; being an apprentice is a
    fact about the person, not a grant.
  * READING someone else's report needs ``training:manage`` (the Ausbilder
    side). Reports name customers and are personal work records — a colleague
    has no business reading them.
  * COUNTERSIGNING needs ``training:manage`` AND a second person: the form
    carries two signatures precisely because one party alone cannot attest it.
  * Flagging WHO is an apprentice needs ``users:manage`` — it is user
    administration, and lives here rather than in admin.py only because that
    file carries unrelated uncommitted work (the required-hours PATCH in
    time_tracking.py set the precedent for per-user settings outside admin.py).

The status ladder — draft → submitted (apprentice signed) → signed (trainer
countersigned) — is enforced in every mutating endpoint. A signed report is
immutable; that is the whole point of a record the IHK inspects.
"""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import has_permission_for_user
from app.core.time import utcnow
from app.models.entities import SchoolAbsence, Task, TaskAssignment, TrainingWeekReport, User
from app.models.report import ConstructionReport
from app.routers.time_tracking import (
    _entries_overlapping_period,
    _entry_metrics_for_period,
    _local_period_bounds_utc,
    _work_summary,
)
from app.routers.workflow_helpers import _content_disposition, _expand_school_absence_days
from app.schemas.training import (
    ApprenticeOut,
    ApprenticeSettingsUpdate,
    TrainingPrefillDay,
    TrainingPrefillOut,
    TrainingReportCreate,
    TrainingReportOut,
    TrainingReportUpdate,
    TrainingSignPayload,
)
from app.services.audit import log_admin_action
from app.services.runtime_settings import get_company_settings
from app.services.training_report_pdf import build_training_heft_pdf, build_training_report_pdf

router = APIRouter(prefix="/training", tags=["training"])


# ──────────────────────────────────────────────────────────────────────────
# Small helpers
# ──────────────────────────────────────────────────────────────────────────


def _monday_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


def _assert_representable_week(week_start: date) -> None:
    """Refuse a week whose Saturday would fall outside ``date``'s range.

    ``week_start + 5 days`` is computed before any row is inspected, so a
    week_start near date.max raised an uncaught OverflowError and turned into
    a bare 500 — for a request whose body could be empty. Every other bad-week
    case in this module answers 400; this one should too.
    """

    try:
        week_start + timedelta(days=5)
    except OverflowError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Ungültige Kalenderwoche.",
        ) from None


def _can_review(user: User) -> bool:
    return has_permission_for_user(user.id, user.role, "training:manage")


def _require_apprentice(user: User) -> None:
    if not bool(user.is_apprentice):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Nur Auszubildende führen Ausbildungsnachweise.",
        )


def _ausbildungsjahr_for(user: User, week_start: date) -> int:
    """Training year at the given week, from the stored start date.

    Anniversary counting, not day/365 division — an Ausbildung that started
    2024-09-01 is in its 2nd year during August 2026, and flips to the 3rd on
    2026-09-01. Clamped to the schema's 1..5.
    """

    started = user.training_started_on
    if started is None:
        return 1
    years = week_start.year - started.year
    if (week_start.month, week_start.day) < (started.month, started.day):
        years -= 1
    return max(1, min(5, years + 1))


def _total_hours(days: list) -> float:
    total = 0.0
    for day in days or []:
        entries = day.get("entries") if isinstance(day, dict) else None
        for entry in entries or []:
            if isinstance(entry, dict):
                total += float(entry.get("hours") or 0)
    return round(total, 2)


def _normalized_days(payload_days: list, week_start: date) -> list:
    """Validate + canonicalize the JSON day rows against the report's week.

    A day outside the reported week would silently corrupt the sheet (the PDF
    renders Mo–Sa of `week_start`, so out-of-week rows would vanish from the
    printout while still counting toward totals) — refused instead. Duplicate
    day rows are refused for the same reason.
    """

    seen: set[str] = set()
    normalized: list = []
    # Mo–Sa, matching the PDF, the editor and the prefill. Accepting a Sunday
    # row here while the PDF renders six days would make the printed
    # Gesamtstunden disagree with the API total on a signed legal document.
    week_end = week_start + timedelta(days=5)
    for day_model in payload_days or []:
        day_value = day_model.day
        if not (week_start <= day_value <= week_end):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"Der Tag {day_value.isoformat()} liegt nicht in der berichteten "
                    "Woche (Mo–Sa) — der Nachweis führt Montag bis Samstag."
                ),
            )
        iso = day_value.isoformat()
        if iso in seen:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Der Tag {iso} kommt doppelt vor.",
            )
        seen.add(iso)
        normalized.append(
            {
                "day": iso,
                "entries": [
                    {"text": e.text.strip(), "hours": round(float(e.hours), 2), "category": e.category}
                    for e in day_model.entries
                    if e.text.strip()
                ],
            }
        )
    normalized.sort(key=lambda d: d["day"])
    return normalized


def _missing_weeks(reports: list[TrainingWeekReport]) -> list[date]:
    """Mondays with no sheet, between the first and last sheet that exist.

    "Lückenlos" is the admission requirement, so a gap is worth surfacing —
    but only *inside* the covered span. Counting forward from the training
    start would flag every week the apprentice has not reached yet, which is
    noise rather than a finding.
    """

    if len(reports) < 2:
        return []
    covered = {report.week_start for report in reports}
    first, last = min(covered), max(covered)
    missing: list[date] = []
    cursor = first
    while cursor < last:
        cursor += timedelta(days=7)
        if cursor not in covered and cursor != last:
            missing.append(cursor)
    return missing


def _report_out(db: Session, report: TrainingWeekReport) -> TrainingReportOut:
    owner = db.get(User, report.user_id)
    ausbilder = db.get(User, report.ausbilder_user_id) if report.ausbilder_user_id else None
    return TrainingReportOut(
        id=report.id,
        user_id=report.user_id,
        user_display_name=owner.display_name if owner else None,
        week_start=report.week_start,
        report_number=report.report_number,
        ausbildungsjahr=report.ausbildungsjahr,
        status=report.status,  # type: ignore[arg-type]
        days=report.days or [],
        remarks=report.remarks,
        total_hours=_total_hours(report.days or []),
        azubi_signed_at=report.azubi_signed_at,
        ausbilder_signed_at=report.ausbilder_signed_at,
        ausbilder_name=ausbilder.display_name if ausbilder else None,
        created_at=report.created_at,
        updated_at=report.updated_at,
    )


def _get_report(db: Session, report_id: int) -> TrainingWeekReport:
    report = db.get(TrainingWeekReport, report_id)
    if report is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nachweis nicht gefunden")
    return report


def _assert_read_access(report: TrainingWeekReport, user: User) -> None:
    if report.user_id == user.id:
        return
    if not _can_review(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Kein Zugriff auf diesen Nachweis")
    # A draft belongs to its author until they sign it. The list endpoint and
    # the Heft both withhold other people's drafts; without the same rule here
    # that promise is worth nothing, because report ids are a single global
    # sequence and this endpoint returns the full body and a rendered PDF.
    if report.status == "draft":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Entwürfe sind bis zur Unterschrift privat.",
        )


def _assert_owner(report: TrainingWeekReport, user: User) -> None:
    if report.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Kein Zugriff auf diesen Nachweis")


# ──────────────────────────────────────────────────────────────────────────
# Reports
# ──────────────────────────────────────────────────────────────────────────


@router.get("/reports", response_model=list[TrainingReportOut])
def list_reports(
    user_id: int | None = None,
    view: str = "own",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TrainingReportOut]:
    """Own reports by default. ``view=review`` (trainer) lists every
    apprentice's non-draft reports — drafts stay private until the apprentice
    signs; half-written sheets are nobody's business."""

    stmt = select(TrainingWeekReport)
    if view == "review":
        if not _can_review(current_user):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Keine Berechtigung")
        stmt = stmt.where(TrainingWeekReport.status != "draft")
    else:
        target_id = user_id if user_id is not None else current_user.id
        if target_id != current_user.id and not _can_review(current_user):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Keine Berechtigung")
        stmt = stmt.where(TrainingWeekReport.user_id == target_id)
        # Drafts are private to their author, whatever `view` says. Keying this
        # on the view name instead let ``?user_id=<other>`` (view defaulting to
        # "own") hand a trainer somebody's half-written sheets — the exact thing
        # the docstring above promises never happens.
        if target_id != current_user.id:
            stmt = stmt.where(TrainingWeekReport.status != "draft")

    reports = db.scalars(stmt.order_by(TrainingWeekReport.week_start.desc())).all()
    return [_report_out(db, report) for report in reports]


@router.get("/reports/{report_id}", response_model=TrainingReportOut)
def get_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrainingReportOut:
    report = _get_report(db, report_id)
    _assert_read_access(report, current_user)
    return _report_out(db, report)


@router.post("/reports", response_model=TrainingReportOut)
def create_report(
    payload: TrainingReportCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrainingReportOut:
    _require_apprentice(current_user)
    monday = _monday_of(payload.week_start)
    _assert_representable_week(monday)

    existing = db.scalar(
        select(TrainingWeekReport).where(
            TrainingWeekReport.user_id == current_user.id,
            TrainingWeekReport.week_start == monday,
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Für die Woche ab {monday.isoformat()} existiert bereits Nachweis Nr. {existing.report_number}.",
        )

    max_number = db.scalar(
        select(TrainingWeekReport.report_number)
        .where(TrainingWeekReport.user_id == current_user.id)
        .order_by(TrainingWeekReport.report_number.desc())
        .limit(1)
    )
    now = utcnow()
    report = TrainingWeekReport(
        user_id=current_user.id,
        week_start=monday,
        report_number=(max_number or 0) + 1,
        ausbildungsjahr=payload.ausbildungsjahr or _ausbildungsjahr_for(current_user, monday),
        status="draft",
        days=_normalized_days(payload.days, monday),
        remarks=payload.remarks,
        created_at=now,
        updated_at=now,
    )
    db.add(report)
    try:
        db.commit()
    except IntegrityError:
        # Two concurrent creates raced past the existence check (same week) or
        # read the same max number (any week). The DB constraints are the
        # arbiter; surface it as the conflict it is, not a 500.
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Der Nachweis wurde bereits angelegt — bitte die Liste aktualisieren.",
        )
    db.refresh(report)
    return _report_out(db, report)


@router.patch("/reports/{report_id}", response_model=TrainingReportOut)
def update_report(
    report_id: int,
    payload: TrainingReportUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrainingReportOut:
    report = _get_report(db, report_id)
    _assert_owner(report, current_user)
    if report.status != "draft":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Nur Entwürfe können bearbeitet werden — zuerst die Einreichung zurückziehen.",
        )

    fields = payload.model_dump(exclude_unset=True)
    if "ausbildungsjahr" in fields and payload.ausbildungsjahr is not None:
        report.ausbildungsjahr = payload.ausbildungsjahr
    if "days" in fields and payload.days is not None:
        report.days = _normalized_days(payload.days, report.week_start)
    if "remarks" in fields:
        report.remarks = payload.remarks
    report.updated_at = utcnow()
    db.add(report)
    db.commit()
    db.refresh(report)
    return _report_out(db, report)


@router.delete("/reports/{report_id}", status_code=204)
def delete_report(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    report = _get_report(db, report_id)
    _assert_owner(report, current_user)
    if report.status != "draft":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Eingereichte oder gegengezeichnete Nachweise können nicht gelöscht werden.",
        )
    db.delete(report)
    db.commit()
    return Response(status_code=204)


# ──────────────────────────────────────────────────────────────────────────
# Signatures
# ──────────────────────────────────────────────────────────────────────────


# A signature pad emits a few hundred kilopixels; anything past this is not a
# signature. The cap is what stops a decompression bomb — a ~20 KB PNG that
# claims 13000×13000 px would pass the byte-length check, then allocate
# hundreds of MB when the PDF renders it, inside a memory-capped container.
_MAX_SIGNATURE_PIXELS = 4_000_000


def _validated_signature(raw: str) -> str:
    """Accept only something that actually decodes as a small raster image.

    ``Image.open`` reads just the header (lazy), so the dimension check is
    safe even against a bomb — nothing is decoded until after the cap.
    """

    import base64
    import io

    from PIL import Image, UnidentifiedImageError

    cleaned = raw.strip()
    payload = cleaned.split(",", 1)[1] if cleaned.startswith("data:") else cleaned
    try:
        data = base64.b64decode(payload, validate=False)
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
            if width * height > _MAX_SIGNATURE_PIXELS:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Die Unterschrift ist ungültig (Bild zu groß).",
                )
    except HTTPException:
        raise
    except (UnidentifiedImageError, ValueError, OSError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Die Unterschrift konnte nicht als Bild gelesen werden.",
        )
    return cleaned


@router.post("/reports/{report_id}/sign-azubi", response_model=TrainingReportOut)
def sign_as_apprentice(
    report_id: int,
    payload: TrainingSignPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrainingReportOut:
    report = _get_report(db, report_id)
    _assert_owner(report, current_user)
    if report.status != "draft":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Der Nachweis ist bereits eingereicht.")

    report.azubi_signature = _validated_signature(payload.signature)
    report.azubi_signed_at = utcnow()
    report.status = "submitted"
    report.updated_at = utcnow()
    db.add(report)
    db.commit()
    db.refresh(report)
    return _report_out(db, report)


@router.post("/reports/{report_id}/withdraw", response_model=TrainingReportOut)
def withdraw_submission(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrainingReportOut:
    """Take a submitted report back for corrections — possible exactly until
    the trainer has countersigned. After that the record is fixed."""

    report = _get_report(db, report_id)
    _assert_owner(report, current_user)
    if report.status != "submitted":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Nur eingereichte, noch nicht gegengezeichnete Nachweise können zurückgezogen werden.",
        )
    report.status = "draft"
    report.azubi_signature = None
    report.azubi_signed_at = None
    report.updated_at = utcnow()
    db.add(report)
    db.commit()
    db.refresh(report)
    return _report_out(db, report)


@router.post("/reports/{report_id}/sign-ausbilder", response_model=TrainingReportOut)
def countersign_as_trainer(
    report_id: int,
    payload: TrainingSignPayload,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrainingReportOut:
    report = _get_report(db, report_id)
    if not _can_review(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Keine Berechtigung zum Gegenzeichnen")
    if report.user_id == current_user.id:
        # Dual signatures exist because one party alone cannot attest the
        # record — an apprentice who also holds training:manage must not
        # short-circuit that.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Der eigene Nachweis kann nicht selbst gegengezeichnet werden.",
        )
    if report.status != "submitted":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Nur eingereichte Nachweise können gegengezeichnet werden.",
        )

    report.ausbilder_signature = _validated_signature(payload.signature)
    report.ausbilder_signed_at = utcnow()
    report.ausbilder_user_id = current_user.id
    report.status = "signed"
    report.updated_at = utcnow()
    db.add(report)
    db.commit()
    db.refresh(report)
    log_admin_action(
        db,
        current_user,
        "training.report.countersign",
        "training_week_report",
        str(report.id),
        {"apprentice_user_id": report.user_id, "week_start": report.week_start.isoformat()},
    )
    return _report_out(db, report)


# ──────────────────────────────────────────────────────────────────────────
# PDF
# ──────────────────────────────────────────────────────────────────────────


@router.get("/reports/{report_id}/pdf")
def download_report_pdf(
    report_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    report = _get_report(db, report_id)
    _assert_read_access(report, current_user)

    owner = db.get(User, report.user_id)
    ausbilder = db.get(User, report.ausbilder_user_id) if report.ausbilder_user_id else None
    pdf_bytes = build_training_report_pdf(
        report,
        apprentice_name=owner.display_name if owner else "",
        ausbilder_name=ausbilder.display_name if ausbilder else None,
    )
    iso = report.week_start.isocalendar()
    filename = f"Ausbildungsnachweis_Nr{report.report_number}_KW{iso.week:02d}_{iso.year}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(filename, inline=False)},
    )


@router.get("/heft")
def download_heft_pdf(
    user_id: int | None = None,
    include_drafts: bool = False,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The whole Ausbildungsheft as one PDF: Deckblatt, index, every sheet.

    This is what the Kammer asks for at Prüfungsanmeldung — the collection,
    in order, not 150 separate downloads. Drafts are excluded by default so
    the exported Heft is the record as it stands; an apprentice reviewing
    their own progress can opt them in.
    """

    target_id = user_id if user_id is not None else current_user.id
    if target_id != current_user.id and not _can_review(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Keine Berechtigung")
    owner = db.get(User, target_id)
    if owner is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Benutzer nicht gefunden")

    stmt = select(TrainingWeekReport).where(TrainingWeekReport.user_id == target_id)
    # A trainer never sees somebody else's drafts, here or anywhere else.
    if not include_drafts or target_id != current_user.id:
        stmt = stmt.where(TrainingWeekReport.status != "draft")
    reports = list(db.scalars(stmt.order_by(TrainingWeekReport.week_start.asc())).all())

    ausbilder_names: dict[int, str] = {}
    for report in reports:
        if report.ausbilder_user_id:
            trainer = db.get(User, report.ausbilder_user_id)
            if trainer is not None:
                ausbilder_names[report.id] = trainer.display_name

    company = get_company_settings(db)
    pdf_bytes = build_training_heft_pdf(
        reports,
        apprentice_name=owner.display_name,
        training_started_on=owner.training_started_on,
        company_name=str(company.get("company_name") or "").strip() or None,
        missing_weeks=_missing_weeks(reports),
        ausbilder_names=ausbilder_names,
    )
    filename = f"Ausbildungsnachweise_{owner.display_name}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(filename, inline=False)},
    )


# ──────────────────────────────────────────────────────────────────────────
# Prefill from time tracking
# ──────────────────────────────────────────────────────────────────────────


@router.get("/prefill", response_model=TrainingPrefillOut)
def get_week_prefill(
    week_start: date,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TrainingPrefillOut:
    """A head start for the sheet: per weekday the net worked hours, whether
    it was a Berufsschule day, and the day's tasks/reports as suggested lines.

    Deliberately SELF-ONLY, with no user_id parameter: this is a drafting aid
    for the person writing their own record, not a supervision tool.
    """

    _require_apprentice(current_user)
    monday = _monday_of(week_start)
    _assert_representable_week(monday)
    saturday = monday + timedelta(days=5)
    week_days = [monday + timedelta(days=offset) for offset in range(6)]
    now = utcnow()

    # Net hours — the identical math the timesheet shows, so the sheet and the
    # time page can never disagree about a day.
    period_start, period_end = _local_period_bounds_utc(monday, saturday)
    entries = _entries_overlapping_period(db, current_user.id, period_start, period_end)
    hours_by_day: dict[date, float] = {}
    for day in week_days:
        day_start, day_end = _local_period_bounds_utc(day, day)
        net = sum(
            _entry_metrics_for_period(db, entry, day_start, day_end, now=now)["net_hours"]
            for entry in entries
        )
        hours_by_day[day] = round(net, 2)

    # Berufsschule days — via the canonical expansion, which is the only
    # helper that gets recurring school days right.
    school_days: set[date] = set()
    absences = db.scalars(
        select(SchoolAbsence).where(
            SchoolAbsence.user_id == current_user.id,
            SchoolAbsence.status == "approved",
            SchoolAbsence.absence_type == "school",
            SchoolAbsence.start_date <= saturday,
        )
    ).all()
    for absence in absences:
        school_days.update(_expand_school_absence_days(absence, period_start=monday, period_end=saturday))

    # Suggested lines — the week's tasks and construction reports, two queries
    # bucketed in Python.
    assigned_ids = select(TaskAssignment.task_id).where(TaskAssignment.user_id == current_user.id)
    tasks = db.scalars(
        select(Task).where(
            Task.due_date.between(monday, saturday),
            (Task.assignee_id == current_user.id) | (Task.id.in_(assigned_ids)),
        )
    ).all()
    reports = db.scalars(
        select(ConstructionReport).where(
            ConstructionReport.user_id == current_user.id,
            ConstructionReport.report_date.between(monday, saturday),
        )
    ).all()

    lines_by_day: dict[date, list[str]] = {day: [] for day in week_days}
    for task in tasks:
        if task.due_date in lines_by_day:
            lines_by_day[task.due_date].append(task.title)
    for construction_report in reports:
        summary = _work_summary(
            construction_report.payload if isinstance(construction_report.payload, dict) else {}
        )
        if summary and construction_report.report_date in lines_by_day:
            lines_by_day[construction_report.report_date].append(summary)

    return TrainingPrefillOut(
        week_start=monday,
        ausbildungsjahr=_ausbildungsjahr_for(current_user, monday),
        days=[
            TrainingPrefillDay(
                day=day,
                worked_hours=hours_by_day.get(day, 0.0),
                school_day=day in school_days,
                suggested_lines=lines_by_day.get(day, []),
            )
            for day in week_days
        ],
    )


# ──────────────────────────────────────────────────────────────────────────
# Apprentice administration
# ──────────────────────────────────────────────────────────────────────────


@router.get("/apprentices", response_model=list[ApprenticeOut])
def list_apprentices(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[ApprenticeOut]:
    """Every apprentice, for the trainer's side of the Ausbildung page.

    ``training:manage`` rather than ``users:manage``: this is the roster a
    trainer works from, not user administration.
    """

    if not _can_review(current_user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Keine Berechtigung")

    users = list(
        db.scalars(
            select(User).where(User.is_apprentice.is_(True), User.is_active.is_(True)).order_by(User.full_name)
        ).all()
    )
    if not users:
        return []

    # One query for every apprentice's sheets rather than one per row.
    rows = list(
        db.scalars(
            select(TrainingWeekReport)
            .where(TrainingWeekReport.user_id.in_([user.id for user in users]))
            .order_by(TrainingWeekReport.week_start.asc())
        ).all()
    )
    by_user: dict[int, list[TrainingWeekReport]] = {}
    for row in rows:
        by_user.setdefault(row.user_id, []).append(row)

    result: list[ApprenticeOut] = []
    for user in users:
        owned = by_user.get(user.id, [])
        # Drafts are the apprentice's own business; they are neither counted
        # as filed nor shown to the trainer as outstanding work.
        filed = [report for report in owned if report.status != "draft"]
        result.append(
            ApprenticeOut(
                id=user.id,
                full_name=user.full_name,
                display_name=user.display_name,
                email=user.email,
                is_apprentice=True,
                training_started_on=user.training_started_on,
                report_count=len(filed),
                pending_count=sum(1 for report in filed if report.status == "submitted"),
                missing_week_count=len(_missing_weeks(filed)),
                last_week_start=filed[-1].week_start if filed else None,
            )
        )
    return result


@router.patch("/apprentices/{user_id}")
def update_apprentice_settings(
    user_id: int,
    payload: ApprenticeSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Mark a user as apprentice / set their training start.

    Lives here rather than in the generic admin user PATCH: same
    ``users:manage`` gate, but this router owns the whole Ausbildung domain
    (and admin.py carries unrelated in-flight work).
    """

    if not has_permission_for_user(current_user.id, current_user.role, "users:manage"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not allowed")
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    before = {
        "is_apprentice": bool(target.is_apprentice),
        "training_started_on": target.training_started_on.isoformat() if target.training_started_on else None,
    }
    if payload.is_apprentice is not None:
        target.is_apprentice = payload.is_apprentice
    if payload.clear_training_started_on:
        target.training_started_on = None
    elif payload.training_started_on is not None:
        target.training_started_on = payload.training_started_on
    db.add(target)
    db.commit()
    db.refresh(target)

    after = {
        "is_apprentice": bool(target.is_apprentice),
        "training_started_on": target.training_started_on.isoformat() if target.training_started_on else None,
    }
    if before != after:
        log_admin_action(
            db,
            current_user,
            "user.apprentice_settings_update",
            "user",
            str(target.id),
            {"before": before, "after": after},
        )
    return {
        "user_id": target.id,
        "is_apprentice": bool(target.is_apprentice),
        "training_started_on": target.training_started_on.isoformat() if target.training_started_on else None,
    }
