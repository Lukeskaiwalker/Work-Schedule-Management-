"""
workflow_notifications.py — Endpoints for the personal notification panel.

GET  /notifications          → list recent notifications for the current user
PATCH /notifications/read-all → mark all as read
PATCH /notifications/{id}/read → mark one as read
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.time import utcnow
from app.models.notification import Notification
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
        created_at=notif.created_at,
        actor_name=actor_name,
    )


@router.get("/notifications", response_model=list[NotificationOut])
def list_notifications(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[NotificationOut]:
    """Return the 50 most recent notifications for the authenticated user."""
    rows = (
        db.execute(
            select(Notification)
            .where(Notification.user_id == current_user.id)
            .order_by(Notification.created_at.desc())
            .limit(50)
        )
        .scalars()
        .all()
    )
    return [_enrich(n, db) for n in rows]


@router.patch("/notifications/read-all", response_model=dict)
def mark_all_read(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Mark all of the current user's unread notifications as read."""
    now = utcnow()
    unread = (
        db.execute(
            select(Notification).where(
                Notification.user_id == current_user.id,
                Notification.read_at.is_(None),
            )
        )
        .scalars()
        .all()
    )
    for notif in unread:
        notif.read_at = now
    db.commit()
    return {"marked_read": len(unread)}


@router.patch("/notifications/{notif_id}/read", response_model=NotificationOut)
def mark_one_read(
    notif_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> NotificationOut:
    """Mark a single notification as read. Returns 404 if not found or not owned."""
    notif = db.get(Notification, notif_id)
    if notif is None or notif.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Notification not found")
    if notif.read_at is None:
        notif.read_at = utcnow()
        db.commit()
    return _enrich(notif, db)
