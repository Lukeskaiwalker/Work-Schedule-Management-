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
    customer_id: int | None = None,
    week_start: date | None = None,
    task_type: str | None = None,
    has_partners: bool | None = None,
    partner_id: int | None = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Task)
    if project_id:
        assert_project_access(db, current_user, project_id)
        stmt = stmt.where(Task.project_id == project_id)
    if customer_id:
        # No assert_customer_access yet — customer-tasks rely on
        # tasks:view_all / _my_task_filter for visibility, same as
        # any other unfiltered task list. The filter exists to support
        # the customer-detail-page "Tasks" panel introduced in v2.4.5.
        stmt = stmt.where(Task.customer_id == customer_id)

    # Respect the live permission map: only restrict to own tasks if the user
    # lacks tasks:view_all (e.g. default employee, or a role with that perm removed).
    own_tasks_only = not has_permission_for_user(current_user.id, current_user.role, "tasks:view_all")

    if view == "my":
        stmt = stmt.where(_my_task_filter(current_user.id))
        stmt = stmt.where(Task.status != "done")
    elif view == "all_open":
        stmt = stmt.where(Task.status != "done")
        if own_tasks_only:
            stmt = stmt.where(_my_task_filter(current_user.id))
    elif view == "completed":
        stmt = stmt.where(Task.status == "done")
        if own_tasks_only:
            stmt = stmt.where(_my_task_filter(current_user.id))
    elif view == "projects_overview":
        if own_tasks_only:
            stmt = stmt.where(_my_task_filter(current_user.id))

    if week_start:
        stmt = stmt.where(Task.week_start == week_start)
    if task_type:
        stmt = stmt.where(Task.task_type == _normalize_task_type(task_type))

    if partner_id is not None:
        stmt = stmt.where(
            Task.id.in_(select(TaskPartner.task_id).where(TaskPartner.partner_id == partner_id))
        )
    elif has_partners is True:
        stmt = stmt.where(Task.id.in_(select(TaskPartner.task_id)))
    elif has_partners is False:
        stmt = stmt.where(Task.id.notin_(select(TaskPartner.task_id)))

    tasks = list(db.scalars(stmt.order_by(Task.due_date.asc().nulls_last(), Task.id.desc())).all())
    return _tasks_out(db, tasks)

@router.post("/tasks", response_model=TaskOut)
def create_task(
    payload: TaskCreate,
    current_user: User = Depends(require_permission("tasks:manage")),
    db: Session = Depends(get_db),
):
    # v2.4.5 anchor handling: a task is project-scoped, customer-scoped,
    # or both. The Pydantic model_validator already rejected the
    # neither-set case, so reaching this point means at least one is
    # populated. The DB CHECK constraint is the last line of defence.
    if payload.project_id is not None:
        assert_project_access(db, current_user, payload.project_id, manage_required=True)
    if payload.customer_id is not None:
        _validate_customer_id(db, payload.customer_id)
    class_template: ProjectClassTemplate | None = None
    if payload.class_template_id is not None:
        if payload.project_id is None:
            raise HTTPException(
                status_code=400,
                detail="class_template_id requires a project_id",
            )
        class_template = _resolve_project_class_template(
            db, project_id=payload.project_id, class_template_id=payload.class_template_id
        )
    assignee_ids = _normalize_assignee_ids([*(payload.assignee_ids or []), payload.assignee_id])
    _validate_assignee_ids(db, assignee_ids)
    partner_ids = _normalize_partner_ids(list(payload.partner_ids or []))
    _validate_partner_ids(db, partner_ids)
    _validate_task_schedule(start_time=payload.start_time, estimated_hours=payload.estimated_hours)
    # Overlap detection is only meaningful when the task lives inside a
    # project (the helper scans tasks-in-same-project for the same
    # assignee). Customer-only tasks skip this; future work could add
    # cross-anchor overlap if needed.
    overlaps = (
        _find_task_overlaps(
            db,
            project_id=payload.project_id,
            due_date=payload.due_date,
            start_time=payload.start_time,
            estimated_hours=payload.estimated_hours,
            assignee_ids=assignee_ids,
        )
        if (not payload.confirm_overlap and payload.project_id is not None)
        else []
    )
    if overlaps:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "task_overlap",
                "message": "Task overlaps with an existing assignment",
                "overlaps": overlaps,
            },
        )
    task_data = payload.model_dump(
        exclude={
            "assignee_id",
            "assignee_ids",
            "partner_ids",
            "class_template_id",
            "subtasks",
            "confirm_overlap",
            # v2.5.0: handled separately below since it triggers an
            # email send rather than populating a Task column directly.
            "request_customer_confirmation",
        }
    )
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
    _sync_task_partners(db, task, partner_ids)
    _create_assignment_notifications(db, task, assignee_ids, current_user)
    # v2.5.5: ticking "Kundenbestätigung anfordern" sets status=pending
    # and mints a confirmation token, but does NOT send the email
    # automatically. The operator clicks the "E-Mail senden" button
    # inside the task modal when ready — explicit, never spam-on-save.
    if payload.request_customer_confirmation:
        set_task_confirmation_pending(task, reset_status=True)
    # Project-activity is project-scoped — only record when the task
    # actually has a project anchor. Customer-only tasks live without
    # one (audit trail belongs to the customer record itself).
    if task.project_id is not None:
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
    partner_rows = _load_partners_by_id(db, partner_ids)
    created = _task_out(
        task,
        assignee_ids,
        partner_ids=partner_ids,
        partners=[partner_rows[pid] for pid in partner_ids if pid in partner_rows],
    )
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
    existing_partner_ids = _task_partner_map(db, [task]).get(task.id, [])
    added_assignee_ids: list[int] = []
    previous_status = task.status
    previous_due_date = task.due_date.isoformat() if task.due_date else None
    previous_start_time = task.start_time.isoformat() if task.start_time else None
    previous_estimated_hours = task.estimated_hours
    previous_due_date_value = task.due_date
    previous_confirmation_status = task.customer_confirmation_status
    can_manage = has_permission_for_user(current_user.id, current_user.role, "tasks:manage")
    if not can_manage and current_user.id not in existing_assignee_ids:
        raise HTTPException(status_code=403, detail="Task access denied")
    if "expected_updated_at" in payload.model_fields_set:
        _assert_optimistic_timestamp(
            expected=payload.expected_updated_at,
            current=task.updated_at,
            conflict_detail="Task was updated by another user. Please reload and retry.",
        )

    if not can_manage:
        # v2.5.21: allow harmless meta-fields through the employee path.
        # ``expected_updated_at`` (optimistic-locking timestamp) and
        # ``confirm_overlap`` (overlap-check acknowledgement) are sent by
        # the frontend on every task update, including the simple
        # "mark this task as done" flow from the row-action button and the
        # status dropdown in TaskEditModal. Pre-v2.5.21 the check rejected
        # the request as a 403 because those fields counted as "illegal".
        # Result: employees would see the misleading error message
        # "Assigned employees can only mark tasks complete" while trying
        # to do exactly that. 20+ overdue tasks were stuck in this state.
        # ``expected_updated_at`` was validated above; ``confirm_overlap``
        # is consumed downstream by the overlap-detection logic, so both
        # are safe to include without granting any new data-mutation power
        # to non-managers.
        ALLOWED_EMPLOYEE_FIELDS = {"status", "expected_updated_at", "confirm_overlap"}
        illegal_fields = payload.model_fields_set.difference(ALLOWED_EMPLOYEE_FIELDS)
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
        # v2.5.0: explicit toggle of "request customer confirmation"
        # via the modal checkbox. True → flip to pending + auto-email.
        # False → clear status (no indicator shown).
        if (
            "request_customer_confirmation" in payload.model_fields_set
            and payload.request_customer_confirmation is not None
        ):
            if payload.request_customer_confirmation:
                # v2.5.5: set state to pending + mint token, but do NOT
                # send email here. Operator pushes "E-Mail senden" in
                # the modal to trigger the actual email.
                set_task_confirmation_pending(task, reset_status=True)
            else:
                # Clear all confirmation columns — operator opted out.
                task.customer_confirmation_status = None
                task.customer_confirmation_at = None
                task.customer_confirmation_method = None
                task.customer_confirmation_by_user_id = None
                task.customer_confirmation_notes = None
                task.customer_confirmation_token = None
                task.customer_confirmation_email_sent_at = None
        if "estimated_hours" in payload.model_fields_set:
            task.estimated_hours = payload.estimated_hours
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

        if "partner_ids" in payload.model_fields_set:
            next_partner_ids = _normalize_partner_ids(list(payload.partner_ids or []))
            _validate_partner_ids(db, next_partner_ids)
            _sync_task_partners(db, task, next_partner_ids)
            existing_partner_ids = next_partner_ids

        _validate_task_schedule(start_time=task.start_time, estimated_hours=task.estimated_hours)
        overlaps = (
            _find_task_overlaps(
                db,
                project_id=task.project_id,
                due_date=task.due_date,
                start_time=task.start_time,
                estimated_hours=task.estimated_hours,
                assignee_ids=existing_assignee_ids,
                exclude_task_id=task.id,
            )
            if task.status != "done" and not payload.confirm_overlap
            else []
        )
        if overlaps:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "task_overlap",
                    "message": "Task overlaps with an existing assignment",
                    "overlaps": overlaps,
                },
            )

    db.add(task)
    # v2.5.0: auto-resend confirmation email when due_date changed AND
    # the task was already in a confirmation flow (pending or confirmed)
    # AND the user didn't already explicitly toggle the request flag in
    # this same PATCH (which would have handled the email itself).
    due_date_changed = (
        can_manage
        and "due_date" in payload.model_fields_set
        and payload.due_date != previous_due_date_value
    )
    already_handled_via_toggle = (
        "request_customer_confirmation" in payload.model_fields_set
        and payload.request_customer_confirmation is not None
    )
    if (
        due_date_changed
        and not already_handled_via_toggle
        and previous_confirmation_status in {"pending", "confirmed"}
    ):
        # v2.5.5: when the date moves, the customer's previous "yes for
        # date X" is no longer valid for the new date. Reset to pending
        # so the operator knows to re-send. The actual email send is
        # still operator-driven — they click "E-Mail senden" once the
        # new schedule is locked.
        set_task_confirmation_pending(task, reset_status=True)
    if task.status != previous_status or (task.due_date.isoformat() if task.due_date else None) != previous_due_date or (
        task.start_time.isoformat() if task.start_time else None
    ) != previous_start_time or task.estimated_hours != previous_estimated_hours:
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
                "estimated_hours": task.estimated_hours,
            },
        )
    db.commit()
    db.refresh(task)
    partner_rows = _load_partners_by_id(db, existing_partner_ids)
    updated = _task_out(
        task,
        existing_assignee_ids,
        partner_ids=existing_partner_ids,
        partners=[partner_rows[pid] for pid in existing_partner_ids if pid in partner_rows],
    )
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
    for index, assignment in enumerate(assignments):
        assert_project_access(db, current_user, assignment.project_id)
        class_template: ProjectClassTemplate | None = None
        if assignment.class_template_id is not None:
            class_template = _resolve_project_class_template(
                db, project_id=assignment.project_id, class_template_id=assignment.class_template_id
            )
        assignee_ids = _normalize_assignee_ids([*(assignment.assignee_ids or []), assignment.assignee_id])
        _validate_assignee_ids(db, assignee_ids)
        partner_ids = _normalize_partner_ids(list(assignment.partner_ids or []))
        _validate_partner_ids(db, partner_ids)
        _validate_task_schedule(start_time=assignment.start_time, estimated_hours=assignment.estimated_hours)
        due_date = assignment.due_date or week_start
        overlaps = (
            _find_task_overlaps(
                db,
                project_id=assignment.project_id,
                due_date=due_date,
                start_time=assignment.start_time,
                estimated_hours=assignment.estimated_hours,
                assignee_ids=assignee_ids,
            )
            if not assignment.confirm_overlap
            else []
        )
        if overlaps:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "task_overlap",
                    "message": "Task overlaps with an existing assignment",
                    "assignment_index": index,
                    "overlaps": overlaps,
                },
            )
        assignment_data = assignment.model_dump(
            exclude={
                "week_start",
                "due_date",
                "assignee_id",
                "assignee_ids",
                "partner_ids",
                "status",
                "task_type",
                "class_template_id",
                "subtasks",
                "confirm_overlap",
                # v2.5.0: confirmation toggle is request-time-only; the
                # weekly-planning bulk-create path doesn't surface it
                # in the UI today, so we just drop the kwarg.
                "request_customer_confirmation",
            }
        )
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
        _sync_task_partners(db, task, partner_ids)
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

    if not has_permission_for_user(current_user.id, current_user.role, "tasks:view_all"):
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


# ── v2.5.0 customer confirmation endpoints ───────────────────────────────


@router.post(
    "/tasks/{task_id}/customer-confirmation/email",
    response_model=CustomerConfirmationEmailResult,
)
def send_task_customer_confirmation_email(
    task_id: int,
    current_user: User = Depends(require_permission("tasks:manage")),
    db: Session = Depends(get_db),
):
    """Operator-triggered (re)send of the confirmation email. Generates
    a fresh token, resets status to ``"pending"``, and dispatches the
    email. Surfacing the underlying SMTP error_detail to the FE so the
    operator sees ``"SMTP not configured"`` instead of a silent
    failure."""
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.project_id is not None:
        assert_project_access(db, current_user, task.project_id, manage_required=True)
    sent, error = dispatch_customer_confirmation_email(db, task=task, reset_status=True)
    db.commit()
    db.refresh(task)
    return CustomerConfirmationEmailResult(
        sent=sent,
        sent_at=task.customer_confirmation_email_sent_at if sent else None,
        error_detail=error,
    )


@router.post(
    "/tasks/{task_id}/customer-confirmation/manual",
    response_model=TaskOut,
)
def record_task_customer_confirmation_manual(
    task_id: int,
    payload: CustomerConfirmationManualRequest,
    current_user: User = Depends(require_permission("tasks:manage")),
    db: Session = Depends(get_db),
):
    """Operator-driven manual confirmation/decline (phone, in person).
    Stamps the timestamp + method + which operator did it + optional
    notes. Token-link no longer accepted after this — clears the
    token so a stale email tab can't undo the manual entry by
    accident."""
    task = db.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.project_id is not None:
        assert_project_access(db, current_user, task.project_id, manage_required=True)
    task.customer_confirmation_status = (
        "confirmed" if payload.action == "confirm" else "declined"
    )
    task.customer_confirmation_at = utcnow()
    task.customer_confirmation_method = payload.method
    task.customer_confirmation_by_user_id = current_user.id
    if payload.notes is not None:
        task.customer_confirmation_notes = (payload.notes or "").strip() or None
    # Burn the email link so it can't override the manual entry.
    task.customer_confirmation_token = None
    db.commit()
    db.refresh(task)
    return _tasks_out(db, [task])[0]


# ── v2.5.0 public (no-auth) confirmation surface ────────────────────────
#
# These two endpoints are reachable WITHOUT a JWT — the customer's
# browser hits them straight from the email link. Security relies on
# the 32-hex random token being computationally unguessable, plus an
# explicit expiry check against the task's due_date so a forwarded
# email can't be used months later.


public_confirmations_router = APIRouter(
    prefix="/public/customer-confirmations",
    tags=["public:customer-confirmations"],
)


def _public_task_view(
    db: Session, task: Task
) -> PublicCustomerConfirmationOut:
    customer = _resolve_task_customer_for_email(db, task)
    customer_name = (customer.name or "").strip() if customer else None
    raw_language = getattr(customer, "language", None) if customer else None
    language = "en" if (raw_language or "").strip().lower().startswith("en") else "de"
    assignee_ids = _task_assignee_map(db, [task]).get(task.id, [])
    worker_names = _worker_display_names_for_task(db, task, assignee_ids)
    return PublicCustomerConfirmationOut(
        customer_name=customer_name,
        task_title=task.title or "",
        task_description=task.description,
        due_date=task.due_date,
        start_time=task.start_time,
        estimated_hours=task.estimated_hours,
        worker_display_names=worker_names,
        language=language,
        confirmation_status=task.customer_confirmation_status,
        confirmation_at=task.customer_confirmation_at,
        expired=_task_confirmation_expired(task),
    )


@public_confirmations_router.get(
    "/{token}", response_model=PublicCustomerConfirmationOut
)
def get_public_customer_confirmation(
    token: str,
    db: Session = Depends(get_db),
):
    """Customer-facing GET: returns just the data the confirmation page
    needs to display (task summary). Validation here is light — even
    expired tokens get a response so the page can render a friendly
    "this link has expired, please call us" message instead of a bare
    404. Only completely unknown tokens 404."""
    if not (token or "").strip():
        raise HTTPException(status_code=404, detail="Confirmation not found")
    task = db.scalars(
        select(Task).where(Task.customer_confirmation_token == token.strip())
    ).first()
    if task is None:
        raise HTTPException(status_code=404, detail="Confirmation not found")
    return _public_task_view(db, task)


@public_confirmations_router.post(
    "/{token}", response_model=PublicCustomerConfirmationOut
)
def submit_public_customer_confirmation(
    token: str,
    payload: PublicCustomerConfirmationRequest,
    db: Session = Depends(get_db),
):
    """Customer-facing POST: record confirm/decline via the email link.

    Once accepted, the token is cleared so a second click (or a
    forwarded link from a different device) lands on the "already
    confirmed" steady state instead of toggling the action. Expired
    links return 410 Gone so the FE can show the right message
    without re-fetching the GET endpoint."""
    if not (token or "").strip():
        raise HTTPException(status_code=404, detail="Confirmation not found")
    task = db.scalars(
        select(Task).where(Task.customer_confirmation_token == token.strip())
    ).first()
    if task is None:
        raise HTTPException(status_code=404, detail="Confirmation not found")
    if _task_confirmation_expired(task):
        raise HTTPException(
            status_code=410,
            detail="This confirmation link has expired. Please contact us by phone.",
        )
    if task.customer_confirmation_status in {"confirmed", "declined"}:
        # Idempotent: a second click on an already-acted-on link returns
        # the current state without flipping it. The customer's page
        # will show "already confirmed" — exactly the right UX for the
        # common "I clicked it twice" case.
        return _public_task_view(db, task)
    task.customer_confirmation_status = (
        "confirmed" if payload.action == "confirm" else "declined"
    )
    task.customer_confirmation_at = utcnow()
    task.customer_confirmation_method = "email"
    task.customer_confirmation_by_user_id = None  # customer self-served
    # Burn the token so the link can only be used once.
    task.customer_confirmation_token = None
    db.commit()
    db.refresh(task)
    return _public_task_view(db, task)
