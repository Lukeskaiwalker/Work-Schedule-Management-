"""Packliste PDF for one task — ``GET /tasks/{task_id}/packing-list.pdf``.

Access is "whoever may read the task", expressed with the same building
blocks the task endpoints use so the rule cannot drift: a user who sees every
task (``tasks:view_all``, the ``list_tasks`` scope) or manages tasks
(``tasks:manage``, the ``update_task`` gate) gets any task; everyone else
only a task they are assigned to, via ``_my_task_filter``. A task outside
that scope answers 404 exactly like a missing one — the response must not
say whether the id exists.

The list comes from the structured material rows. A task that never had a
box linked but carries the older free-text ``materials_required`` note still
gets a sheet, one row per line of the note, so nobody has to retype it.
"""

from __future__ import annotations

from datetime import timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.permissions import has_permission_for_user
from app.core.time import utcnow
from app.models.entities import Project, Task, User
from app.routers.workflow_helpers import (
    _content_disposition,
    _my_task_filter,
    _resolve_task_customer_for_email,
    _task_box_map,
)
from app.services.task_materials import task_materials
from app.services.task_packing_list import lines_from_free_text, render_packing_list

router = APIRouter(prefix="", tags=["tasks"])

_READ_ALL_PERMISSIONS = ("tasks:view_all", "tasks:manage")
_NOT_FOUND_DETAIL = "Task not found"
_NO_MATERIAL_DETAIL = "Keine Packliste: der Aufgabe ist kein Material zugeordnet."


def _may_read_every_task(user: User) -> bool:
    return any(
        has_permission_for_user(user.id, user.role, permission)
        for permission in _READ_ALL_PERMISSIONS
    )


def _readable_task_or_404(db: Session, user: User, task_id: int) -> Task:
    stmt = select(Task).where(Task.id == task_id)
    if not _may_read_every_task(user):
        stmt = stmt.where(_my_task_filter(user.id))
    task = db.scalars(stmt).first()
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NOT_FOUND_DETAIL)
    return task


def _customer_label(db: Session, task: Task, project: Project | None) -> str | None:
    customer = _resolve_task_customer_for_email(db, task)
    name = (customer.name or "").strip() if customer is not None else ""
    if name:
        return name
    # Legacy projects carry the customer as free text instead of a link.
    legacy = (project.customer_name or "").strip() if project is not None else ""
    return legacy or None


def _project_label(project: Project | None) -> str | None:
    if project is None:
        return None
    return f"{project.project_number} · {project.name}"


def _box_line(db: Session, task: Task) -> str | None:
    if task.construction_box_id is None:
        return None
    box = _task_box_map(db, [task]).get(task.construction_box_id)
    if box is None:
        return None
    return f"Baustellenkiste Nr. {box.box_number} — {box.label}"


def _generated_at_local():
    """The footer timestamp in the shop's own time zone, not the server's."""
    name = (get_settings().app_timezone or "UTC").strip() or "UTC"
    try:
        zone = ZoneInfo(name)
    except ZoneInfoNotFoundError:
        zone = ZoneInfo("UTC")
    return utcnow().replace(tzinfo=timezone.utc).astimezone(zone)


@router.get("/tasks/{task_id}/packing-list.pdf")
def task_packing_list_pdf(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """The task's Packliste as an inline PDF (A4, one tick box per line)."""
    task = _readable_task_or_404(db, current_user, task_id)
    lines = task_materials(db, task.id) or lines_from_free_text(task.materials_required)
    if not lines:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=_NO_MATERIAL_DETAIL)

    project = db.get(Project, task.project_id) if task.project_id is not None else None
    pdf = render_packing_list(
        task=task,
        materials=lines,
        customer_name=_customer_label(db, task, project),
        project_label=_project_label(project),
        box_label=_box_line(db, task),
        generated_at=_generated_at_local(),
    )
    file_name = f"Packliste-Aufgabe-{task.id}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": _content_disposition(file_name, inline=True)},
    )
