from __future__ import annotations

from fastapi import APIRouter

from app.core.events import notify
from app.models.notification import Notification
from app.routers.workflow_helpers import *  # noqa: F401,F403

router = APIRouter(prefix="", tags=["tasks"])


def _create_assignment_notifications(
    db: Session,
    task: "Task",
    new_assignee_ids: list[int],
    actor: "User",
) -> None:
    """
    Write a Notification row for each newly added assignee.
    Skips the actor (no self-notifications).
    Call this BEFORE db.commit() so the notifications commit atomically
    with the task data, then call notify() for SSE after commit.
    """
    actor_display = actor.display_name or actor.full_name or actor.email
    for uid in new_assignee_ids:
        if uid == actor.id:
            continue
        db.add(
            Notification(
                user_id=uid,
                actor_user_id=actor.id,
                event_type="task.assigned",
                entity_type="task",
                entity_id=task.id,
                project_id=task.project_id,
                message=f"{actor_display} assigned you to \"{task.title}\"",
            )
        )


@router.get("/tasks", response_model=list[TaskOut])
def list_tasks(
    view: str = "all_open",
    project_id: int | None = None,
    week_start: date | None = None,
    task_type: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Task)
    if project_id:
        assert_project_access(db, current_user, project_id)
        stmt = stmt.where(Task.project_id == project_id)

    if view == "my":
        stmt = stmt.where(_my_task_filter(current_user.id))
        stmt = stmt.where(Task.status != "done")
    elif view == "all_open":
        stmt = stmt.where(Task.status != "done")
        if current_user.role == "employee":
            stmt = stmt.where(_my_task_filter(current_user.id))
    elif view == "completed":
        stmt = stmt.where(Task.status == "done")
        if current_user.role == "employee":
            stmt = stmt.where(_my_task_filter(current_user.id))
    elif view == "projects_overview":
        if current_user.role == "employee":
            stmt = stmt.where(_my_task_filter(current_user.id))

    if week_start:
        stmt = stmt.where(Task.week_start == week_start)
    if task_type:
        stmt = stmt.where(Task.task_type == _normalize_task_type(task_type))

    tasks = list(db.scalars(stmt.order_by(Task.due_date.asc().nulls_last(), Task.id.desc())).all())
    return _tasks_out(db, tasks)

@router.post("/tasks", response_model=TaskOut)
def create_task(
    payload: TaskCreate,
    current_user: User = Depends(require_permission("tasks:manage")),
    db: Session = Depends(get_db),
):
    assert_project_access(db, current_user, payload.project_id, manage_required=True)
    class_template: ProjectClassTemplate | None = None
    if payload.class_template_id is not None:
        class_template = _resolve_project_class_template(
            db, project_id=payload.project_id, class_template_id=payload.class_template_id
        )
    assignee_ids = _normalize_assignee_ids([*(payload.assignee_ids or []), payload.assignee_id])
    _validate_assignee_ids(db, assignee_ids)
    task_data = payload.model_dump(exclude={"assignee_id", "assignee_ids", "class_template_id", "subtasks"})
    task = Task(**task_data)
    task.subtasks = _normalize_task_subtasks(payload.subtasks)
    task.task_type = _normalize_task_type(payload.task_type, default="construction")
    task.class_template_id = class_template.id if class_template else None
    if class_template and not (task.materials_required or "").strip():
        task.materials_required = _class_template_materials_text(class_template) or None
    task.status = _normalize_task_status(payload.status, default="open")
    task.assignee_id = assignee_ids[0] if assignee_ids else None
    db.add(task)
    db.flush()
    _sync_task_assignments(db, task, assignee_ids)
    _create_assignment_notifications(db, task, assignee_ids, current_user)
    _record_project_activity(
        db,
        project_id=task.project_id,
        actor_user_id=current_user.id,
        event_type="task.created",
        message=f"Task created: {task.title}",
        details={"task_id": task.id, "status": task.status},
    )
    db.commit()
    db.refresh(task)
    created = _task_out(task, assignee_ids)
    notify(db, "task.created", created.model_dump(mode="json"))
    for uid in assignee_ids:
        if uid != current_user.id:
            notify(db, "notification.created", {"user_id": uid})
    return created

@router.patch("/tasks/{task_id}", response_model=TaskOut)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    existing_assignee_ids = _task_assignee_map(db, [task]).get(task.id, [])
    added_assignee_ids: list[int] = []
    previous_status = task.status
    previous_due_date = task.due_date.isoformat() if task.due_date else None
    previous_start_time = task.start_time.isoformat() if task.start_time else None
    can_manage = current_user.role in {"admin", "ceo", "planning"}
    if not can_manage and current_user.id not in existing_assignee_ids:
        raise HTTPException(status_code=403, detail="Task access denied")
    if "expected_updated_at" in payload.model_fields_set:
        _assert_optimistic_timestamp(
            expected=payload.expected_updated_at,
            current=task.updated_at,
            conflict_detail="Task was updated by another user. Please reload and retry.",
        )

    if not can_manage:
        illegal_fields = payload.model_fields_set.difference({"status"})
        if illegal_fields:
            raise HTTPException(status_code=403, detail="Assigned employees can only mark tasks complete")
        normalized_status = _normalize_task_status(payload.status, default="")
        if normalized_status != "done":
            raise HTTPException(status_code=403, detail="Assigned employees can only set status to done")
        task.status = "done"
    else:
        if "title" in payload.model_fields_set:
            task.title = payload.title or task.title
        if "description" in payload.model_fields_set:
            task.description = payload.description
        if "subtasks" in payload.model_fields_set:
            task.subtasks = _normalize_task_subtasks(payload.subtasks or [])
        if "materials_required" in payload.model_fields_set:
            task.materials_required = payload.materials_required
        if "storage_box_number" in payload.model_fields_set:
            task.storage_box_number = payload.storage_box_number
        if "task_type" in payload.model_fields_set:
            task.task_type = _normalize_task_type(payload.task_type, default=task.task_type)
        if "class_template_id" in payload.model_fields_set:
            if payload.class_template_id is None:
                task.class_template_id = None
            else:
                class_template = _resolve_project_class_template(
                    db, project_id=task.project_id, class_template_id=payload.class_template_id
                )
                task.class_template_id = class_template.id
                if "materials_required" not in payload.model_fields_set and not (task.materials_required or "").strip():
                    task.materials_required = _class_template_materials_text(class_template) or None
        if "status" in payload.model_fields_set:
            task.status = _normalize_task_status(payload.status, default=task.status)
        if "due_date" in payload.model_fields_set:
            task.due_date = payload.due_date
        if "start_time" in payload.model_fields_set:
            task.start_time = payload.start_time
        if "week_start" in payload.model_fields_set:
            task.week_start = payload.week_start

        if "assignee_ids" in payload.model_fields_set or "assignee_id" in payload.model_fields_set:
            next_assignee_candidates: list[int | None] = []
            if "assignee_ids" in payload.model_fields_set and payload.assignee_ids is not None:
                next_assignee_candidates.extend(payload.assignee_ids)
            if "assignee_id" in payload.model_fields_set:
                next_assignee_candidates.append(payload.assignee_id)
            next_assignee_ids = _normalize_assignee_ids(next_assignee_candidates)
            _validate_assignee_ids(db, next_assignee_ids)
            prev_assignee_ids: set[int] = set(existing_assignee_ids)
            _sync_task_assignments(db, task, next_assignee_ids)
            existing_assignee_ids = next_assignee_ids
            added_assignee_ids = list(set(next_assignee_ids) - prev_assignee_ids)
            _create_assignment_notifications(db, task, added_assignee_ids, current_user)

    db.add(task)
    if task.status != previous_status or (task.due_date.isoformat() if task.due_date else None) != previous_due_date or (
        task.start_time.isoformat() if task.start_time else None
    ) != previous_start_time:
        _record_project_activity(
            db,
            project_id=task.project_id,
            actor_user_id=current_user.id,
            event_type="task.updated",
            message=f"Task updated: {task.title}",
            details={
                "task_id": task.id,
                "status": task.status,
                "due_date": task.due_date.isoformat() if task.due_date else None,
                "start_time": task.start_time.isoformat() if task.start_time else None,
            },
        )
    db.commit()
    db.refresh(task)
    updated = _task_out(task, existing_assignee_ids)
    notify(db, "task.updated", updated.model_dump(mode="json"))
    for uid in added_assignee_ids:
        if uid != current_user.id:
            notify(db, "notification.created", {"user_id": uid})
    return updated

@router.delete("/tasks/{task_id}")
def delete_task(
    task_id: int,
    current_user: User = Depends(require_permission("tasks:manage")),
    db: Session = Depends(get_db),
):
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    assert_project_access(db, current_user, task.project_id, manage_required=True)
    _record_project_activity(
        db,
        project_id=task.project_id,
        actor_user_id=current_user.id,
        event_type="task.deleted",
        message=f"Task deleted: {task.title}",
        details={"task_id": task.id},
    )
    project_id = task.project_id
    db.delete(task)
    db.commit()
    notify(db, "task.deleted", {"id": task_id, "project_id": project_id})
    return {"ok": True}

@router.post("/planning/week/{week_start}")
def planning_assign_week(
    week_start: date,
    assignments: list[TaskCreate],
    current_user: User = Depends(require_permission("planning:manage")),
    db: Session = Depends(get_db),
):
    created_ids: list[int] = []
    for assignment in assignments:
        assert_project_access(db, current_user, assignment.project_id)
        class_template: ProjectClassTemplate | None = None
        if assignment.class_template_id is not None:
            class_template = _resolve_project_class_template(
                db, project_id=assignment.project_id, class_template_id=assignment.class_template_id
            )
        assignee_ids = _normalize_assignee_ids([*(assignment.assignee_ids or []), assignment.assignee_id])
        _validate_assignee_ids(db, assignee_ids)
        assignment_data = assignment.model_dump(
            exclude={
                "week_start",
                "due_date",
                "assignee_id",
                "assignee_ids",
                "status",
                "task_type",
                "class_template_id",
                "subtasks",
            }
        )
        due_date = assignment.due_date or week_start
        task = Task(
            **assignment_data,
            subtasks=_normalize_task_subtasks(assignment.subtasks),
            status=_normalize_task_status(assignment.status, default="open"),
            task_type=_normalize_task_type(assignment.task_type, default="construction"),
            class_template_id=class_template.id if class_template else None,
            due_date=due_date,
            week_start=week_start,
        )
        if class_template and not (task.materials_required or "").strip():
            task.materials_required = _class_template_materials_text(class_template) or None
        db.add(task)
        db.flush()
        _sync_task_assignments(db, task, assignee_ids)
        _record_project_activity(
            db,
            project_id=task.project_id,
            actor_user_id=current_user.id,
            event_type="task.created",
            message=f"Task created: {task.title}",
            details={"task_id": task.id, "status": task.status},
        )
        created_ids.append(task.id)
    db.commit()
    return {"ok": True, "created_task_ids": created_ids}

@router.get("/planning/week/{week_start}", response_model=PlanningWeekOut)
def planning_week_view(
    week_start: date,
    project_id: int | None = None,
    task_type: str | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Task).where(Task.week_start == week_start)
    if project_id is not None:
        assert_project_access(db, current_user, project_id)
        stmt = stmt.where(Task.project_id == project_id)

    if current_user.role == "employee":
        stmt = stmt.where(_my_task_filter(current_user.id))
    if task_type:
        stmt = stmt.where(Task.task_type == _normalize_task_type(task_type))

    tasks = list(db.scalars(stmt.order_by(Task.due_date.asc().nulls_last(), Task.id.asc())).all())
    task_out_rows = _tasks_out(db, tasks)
    by_day: dict[date, list[TaskOut]] = {}
    for task in task_out_rows:
        target_day = task.due_date if task.due_date else week_start
        by_day.setdefault(target_day, []).append(task)
    week_end = week_start + timedelta(days=6)
    absences_by_day = _planning_absences_by_day(
        db,
        current_user=current_user,
        week_start=week_start,
        week_end=week_end,
    )

    days = []
    for offset in range(7):
        day_date = week_start + timedelta(days=offset)
        days.append({"date": day_date, "tasks": by_day.get(day_date, []), "absences": absences_by_day.get(day_date, [])})

    return {
        "week_start": week_start,
        "week_end": week_end,
        "days": days,
    }
