from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.entities import AppSetting

INITIAL_ADMIN_BOOTSTRAP_COMPLETED_KEY = "initial_admin_bootstrap_completed"
OPENWEATHER_API_KEY = "openweather_api_key"


def get_runtime_setting(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    if not row:
        return None
    return row.value


def set_runtime_setting(db: Session, key: str, value: str) -> None:
    row = db.get(AppSetting, key)
    if row:
        row.value = value
    else:
        row = AppSetting(key=key, value=value)
    db.add(row)


def is_initial_admin_bootstrap_completed(db: Session) -> bool:
    value = get_runtime_setting(db, INITIAL_ADMIN_BOOTSTRAP_COMPLETED_KEY)
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def mark_initial_admin_bootstrap_completed(db: Session) -> None:
    set_runtime_setting(db, INITIAL_ADMIN_BOOTSTRAP_COMPLETED_KEY, "true")


def get_openweather_api_key(db: Session) -> str:
    return (get_runtime_setting(db, OPENWEATHER_API_KEY) or "").strip()


def set_openweather_api_key(db: Session, value: str) -> None:
    set_runtime_setting(db, OPENWEATHER_API_KEY, (value or "").strip())
