from __future__ import annotations
from sqlalchemy.orm import Session

from app.models.entities import AuditLog, User


def _infer_audit_category(action: str, target_type: str) -> str:
    prefix = (action or "").split(".", 1)[0]
    category_by_prefix = {
        "user": "users",
        "employee_group": "groups",
        "role_permissions": "permissions",
        "user_permissions": "permissions",
        "time": "time",
        "time_entry": "time",
        "vacation_request": "time",
        "school_absence": "time",
        "project": "projects",
        "project_class_template": "projects",
        "task": "tasks",
        "planning": "planning",
        "ticket": "tickets",
        "chat": "chat",
        "report": "reports",
        "wiki": "wiki",
        "settings": "settings",
        "system": "system",
        "backup": "system",
        "auth": "auth",
        "finance": "finance",
        "file": "files",
    }
    if prefix in category_by_prefix:
        return category_by_prefix[prefix]

    target_category_map = {
        "user": "users",
        "employee_group": "groups",
        "role": "permissions",
        "permission": "permissions",
        "clock_entry": "time",
        "vacation_request": "time",
        "school_absence": "time",
        "project": "projects",
        "task": "tasks",
        "ticket": "tickets",
        "thread": "chat",
        "message": "chat",
        "report": "reports",
        "wiki_page": "wiki",
        "settings": "settings",
        "backup": "system",
        "file": "files",
    }
    return target_category_map.get(target_type or "", "system")


def log_admin_action(
    db: Session,
    actor: User,
    action: str,
    target_type: str,
    target_id: str,
    details: dict | None = None,
    category: str | None = None,
) -> None:
    entry = AuditLog(
        actor_user_id=actor.id,
        category=category or _infer_audit_category(action, target_type),
        action=action,
        target_type=target_type,
        target_id=target_id,
        details=details or {},
    )
    db.add(entry)
    db.commit()
