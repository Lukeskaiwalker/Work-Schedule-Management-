from __future__ import annotations
from sqlalchemy.orm import Session

from app.models.entities import AuditLog, User


def log_admin_action(
    db: Session,
    actor: User,
    action: str,
    target_type: str,
    target_id: str,
    details: dict | None = None,
) -> None:
    entry = AuditLog(
        actor_user_id=actor.id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        details=details or {},
    )
    db.add(entry)
    db.commit()
