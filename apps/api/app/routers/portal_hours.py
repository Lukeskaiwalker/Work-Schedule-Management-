"""Partner portal: reporting working hours, and taking a report back.

``POST /portal/hours`` — one day of one crew on a task of the partner's or on
a project they see; ``DELETE /portal/hours/{id}`` — the partner's own
company's entry, within ``PARTNER_DELETE_WINDOW`` (marked, not erased). Reading happens with the
task and project details (``routers/portal.py``), always narrowed to the
partner's own entries: another subcontractor's hours on the same task are
their business, not this one's.

Every report and removal is written to the task's (or project's) activity
log, so the office sees what changed even after a removal.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import register_portal_routes
from app.core.time import utcnow
from app.models.entities import PartnerTimeEntry, Project, Task
from app.routers.portal_common import PortalContext, get_portal_context
from app.routers.workflow_helpers import _record_project_activity
from app.routers.workflow_tasks import _record_task_activity
from app.schemas.portal import PortalHoursIn, PortalHoursOut
from app.services.partner_hours import (
    MAX_REPORTS_PER_DAY,
    activity_message,
    live_entry_or_none,
    partner_can_delete,
    portal_entries_out,
    reports_in_last_day,
    work_date_problem,
)
from app.services.partner_portal import partner_task_or_none, visible_project_ids

router = APIRouter(prefix="/portal", tags=["partner-portal"])


def _anchor(db: Session, ctx: PortalContext, payload: PortalHoursIn) -> tuple[Task | None, int | None]:
    """The task (if any) and the project the entry belongs to, or a 404/400."""
    if payload.task_id is not None:
        task = partner_task_or_none(db, ctx.partner.id, payload.task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="Task not found")
        if payload.project_id is not None and payload.project_id != task.project_id:
            raise HTTPException(status_code=400, detail="The task belongs to another project")
        return task, task.project_id
    project_id = int(payload.project_id or 0)
    if project_id not in visible_project_ids(db, ctx.partner.id) or db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return None, project_id


def _log(db: Session, ctx: PortalContext, entry: PartnerTimeEntry, task: Task | None, *, removed: bool) -> None:
    event_type = "partner.hours_deleted" if removed else "partner.hours_reported"
    message = activity_message(entry, ctx.partner.name, removed=removed)
    details = {
        "partner_id": ctx.partner.id,
        "entry_id": entry.id,
        "work_date": entry.work_date.isoformat(),
        "workers": entry.workers,
        "hours": float(entry.hours),
    }
    if task is not None:
        _record_task_activity(db, task, actor_user_id=ctx.user.id, event_type=event_type, message=message, details=details)
    elif entry.project_id is not None:
        _record_project_activity(
            db,
            project_id=entry.project_id,
            actor_user_id=ctx.user.id,
            event_type=event_type,
            message=message,
            details=details,
        )


@router.post("/hours", response_model=PortalHoursOut, status_code=201)
def portal_report_hours(
    payload: PortalHoursIn,
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
) -> PortalHoursOut:
    task, project_id = _anchor(db, ctx, payload)
    problem = work_date_problem(payload.work_date, date.today())
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    if reports_in_last_day(db, ctx.partner.id, utcnow()) >= MAX_REPORTS_PER_DAY:
        raise HTTPException(status_code=429, detail="Too many hour reports today; please call the office")
    entry = PartnerTimeEntry(
        partner_id=ctx.partner.id,
        project_id=project_id,
        task_id=task.id if task is not None else None,
        work_date=payload.work_date,
        workers=payload.workers,
        hours=payload.hours,
        note=payload.note,
        reported_by=ctx.user.id,
        created_at=utcnow(),
    )
    db.add(entry)
    db.flush()
    _log(db, ctx, entry, task, removed=False)
    db.commit()
    db.refresh(entry)
    return portal_entries_out(db, [entry], partner_id=ctx.partner.id, now=utcnow())[0]


@router.delete("/hours/{entry_id}", status_code=204)
def portal_delete_hours(
    entry_id: int,
    ctx: PortalContext = Depends(get_portal_context),
    db: Session = Depends(get_db),
):
    """Take one of the company's own reports back, for a week after filing it.

    Ownership and the window are the whole rule — not whether the partner
    still sees the task (the office may have moved the job meanwhile). The
    row is marked, not erased, and keeps counting toward the daily cap.
    """
    entry = live_entry_or_none(db, entry_id)
    if entry is None or entry.partner_id != ctx.partner.id:
        raise HTTPException(status_code=404, detail="Entry not found")
    now = utcnow()
    if not partner_can_delete(entry, ctx.partner.id, now):
        raise HTTPException(status_code=409, detail="Only the office can change this entry now")
    task = db.get(Task, entry.task_id) if entry.task_id is not None else None
    _log(db, ctx, entry, task, removed=True)
    entry.deleted_at = now
    entry.deleted_by = ctx.user.id
    db.add(entry)
    db.commit()
    return Response(status_code=204)


# Last: these routes, and only these, open to partner logins (app.core.deps).
register_portal_routes(router.routes)
