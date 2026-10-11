"""The office's view of partner hours (reported in the partner portal).

Included from ``workflow.py`` under ``/api``:

  GET    /tasks/{id}/partner-hours       every partner's hours on the task
  GET    /projects/{id}/partner-hours    every partner's hours on the project
  DELETE /partner-hours/{id}             remove one (``projects:manage``)

Reading follows the task or the project — whoever may open it sees what the
partners reported there. Removing is a correction of what the office pays
for, so it needs ``projects:manage`` (and manage access to the project) and
is written to the activity log and the admin audit log.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import assert_project_access, get_current_user, require_permission
from app.core.time import utcnow
from app.models.entities import Partner, Project, Task, User
from app.routers.workflow_helpers import _record_project_activity
from app.routers.workflow_task_files import _assert_task_visible
from app.routers.workflow_tasks import _record_task_activity
from app.schemas.portal import PartnerHoursOut
from app.services.audit import log_admin_action
from app.services.partner_hours import (
    activity_message,
    entries_for_project,
    entries_for_task,
    live_entry_or_none,
    office_entries_out,
)

router = APIRouter(prefix="", tags=["partner-hours"])


@router.get("/tasks/{task_id}/partner-hours", response_model=list[PartnerHoursOut])
def list_task_partner_hours(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PartnerHoursOut]:
    task = db.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    _assert_task_visible(db, current_user, task)
    return office_entries_out(db, entries_for_task(db, task.id))


@router.get("/projects/{project_id}/partner-hours", response_model=list[PartnerHoursOut])
def list_project_partner_hours(
    project_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[PartnerHoursOut]:
    assert_project_access(db, current_user, project_id)
    if db.get(Project, project_id) is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return office_entries_out(db, entries_for_project(db, project_id))


@router.delete("/partner-hours/{entry_id}", status_code=204)
def delete_partner_hours(
    entry_id: int,
    current_user: User = Depends(require_permission("projects:manage")),
    db: Session = Depends(get_db),
):
    entry = live_entry_or_none(db, entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    if entry.project_id is not None:
        assert_project_access(db, current_user, entry.project_id, manage_required=True)
    partner = db.get(Partner, entry.partner_id)
    task = db.get(Task, entry.task_id) if entry.task_id is not None else None
    if entry.project_id is None and task is not None:
        _assert_task_visible(db, current_user, task)  # a customer-only task
    message = activity_message(entry, partner.name if partner else f"Partner #{entry.partner_id}", removed=True)
    details = {"partner_id": entry.partner_id, "entry_id": entry.id, "work_date": entry.work_date.isoformat()}
    if task is not None:
        _record_task_activity(
            db, task, actor_user_id=current_user.id, event_type="partner.hours_deleted", message=message, details=details
        )
    elif entry.project_id is not None:
        _record_project_activity(
            db,
            project_id=entry.project_id,
            actor_user_id=current_user.id,
            event_type="partner.hours_deleted",
            message=message,
            details=details,
        )
    # Marked, not erased: the row stays the record of what the partner sent.
    entry.deleted_at = utcnow()
    entry.deleted_by = current_user.id
    db.add(entry)
    db.commit()
    log_admin_action(db, current_user, "partner.hours_delete", "partner_time_entry", str(entry_id), details)
    return Response(status_code=204)
