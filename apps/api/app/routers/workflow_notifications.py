"""
workflow_notifications.py — Endpoints for the personal notification panel.

GET  /notifications              → list recent, non-dismissed notifications
PATCH /notifications/read-all    → mark all as read (clears the bell badge)
PATCH /notifications/{id}/read   → mark one as read
PATCH /notifications/{id}/dismiss → remove one from the panel for good

"Read" and "dismissed" are deliberately separate: opening the panel marks
everything read (so the badge clears) but must not wipe the list the user is
looking at. Clicking a single entry dismisses it — that is the state that
makes it disappear, and it survives a reload because it is a column, not
client state.

Every endpoint here returns a JSON body with a 200. None of them is declared
``status_code=204``: FastAPI sends ``content-type: application/json`` on 204
responses even though the body is empty, which makes a client that parses the
body throw on an action that actually succeeded.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.time import utcnow
from app.models.notification import Notification
from app.models.task import Task
from app.models.user import User
from app.schemas.notification import NotificationOut

router = APIRouter()


def _enrich(notif: Notification, db: Session) -> NotificationOut:
    """Resolve actor display name from the actor_user_id foreign key."""
    actor_name: str | None = None
    if notif.actor_user_id is not None:
        actor = db.get(User, notif.actor_user_id)
        if actor:
            actor_name = actor.display_name or actor.full_name or actor.email
    return NotificationOut(
        id=notif.id,
        event_type=notif.event_type,
        entity_type=notif.entity_type,
        entity_id=notif.entity_id,
        project_id=notif.project_id,
        message=notif.message,
        read_at=notif.read_at,
        dismissed_at=notif.dismissed_at,
        created_at=notif.created_at,
        actor_name=actor_name,
    )


def _is_notification_visible(notif: Notification, db: Session) -> bool:
    """
    Second line of defence against notifications that outlived their subject.

    ``workflow_tasks`` resolves task notifications the moment the task is
    completed or deleted, so in the normal flow they are already dismissed
    when this runs. This check still stays: it covers rows written before
    that resolution existed, and any future write path that completes a task
    without going through ``PATCH /tasks/{id}``.
    """
    if notif.entity_type == "task" and notif.entity_id is not None:
        task = db.get(Task, notif.entity_id)
        if task is None:
            return False
        if (task.status or "").strip().lower() == "done":
            return False
    return True


@router.get("/notifications", response_model=list[NotificationOut])
def list_notifications(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[NotificationOut]:
    """Return the 50 most recent, non-dismissed notifications for the user."""
    rows = (
        db.execute(
            select(Notification)
            .where(
                Notification.user_id == current_user.id,
                Notification.dismissed_at.is_(None),
            )
            .order_by(Notification.created_at.desc())
            .limit(50)
        )
        .scalars()
        .all()
    )
    return [_enrich(n, db) for n in rows if _is_notification_visible(n, db)]


@router.patch("/notifications/read-all", response_model=dict)
def mark_all_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Mark all of the current user's unread, listed notifications as read."""
    now = utcnow()
    unread = (
        db.execute(
            select(Notification).where(
                Notification.user_id == current_user.id,
                Notification.read_at.is_(None),
                Notification.dismissed_at.is_(None),
            )
        )
        .scalars()
        .all()
    )
    for notif in unread:
        notif.read_at = now
    db.commit()
    return {"marked_read": len(unread)}


def _load_owned_notification(
    notif_id: int, current_user: User, db: Session
) -> Notification:
    """Fetch a notification or raise 404 — never leak another user's rows."""
    notif = db.get(Notification, notif_id)
    if notif is None or notif.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Notification not found")
    return notif


@router.patch("/notifications/{notif_id}/read", response_model=NotificationOut)
def mark_one_read(
    notif_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationOut:
    """Mark a single notification as read. Returns 404 if not found or not owned."""
    notif = _load_owned_notification(notif_id, current_user, db)
    if notif.read_at is None:
        notif.read_at = utcnow()
        db.commit()
    return _enrich(notif, db)


@router.patch("/notifications/{notif_id}/dismiss", response_model=NotificationOut)
def dismiss_one(
    notif_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationOut:
    """
    Dismiss a single notification — this is what "clicking it" does.

    Idempotent: dismissing an already dismissed entry keeps the original
    timestamp and still answers 200, so a double click or a retry after a
    flaky connection never turns into an error the user has to interpret.
    Dismissing also marks the entry read; an entry the user has clicked
    away must not keep the bell badge lit.
    """
    notif = _load_owned_notification(notif_id, current_user, db)
    if notif.dismissed_at is None:
        now = utcnow()
        notif.dismissed_at = now
        if notif.read_at is None:
            notif.read_at = now
        db.commit()
    return _enrich(notif, db)
