from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import AppSetting

INITIAL_ADMIN_BOOTSTRAP_COMPLETED_KEY = "initial_admin_bootstrap_completed"
OPENWEATHER_API_KEY = "openweather_api_key"
OPENAI_SETTINGS_KEY = "openai_settings"
SMTP_SETTINGS_KEY = "smtp_settings"
COMPANY_SETTINGS_KEY = "company_settings"
# Role and per-user permission overrides live in app.services.permission_store.

# v2.4.6: shared snapshot of any in-flight runner-mediated update so
# every admin's System tab can attach to the same job instead of each
# admin only seeing the job that THEIR own click initiated. Cleared
# when the runner reports the job has reached a terminal status.
ACTIVE_UPDATE_JOB_KEY = "active_update_job"
# v2.10: Werkstatt label printer (WAGO 258-5101 / Godex). Admin-editable so a
# DHCP-moved printer is a settings change, not a redeploy. Env vars remain the
# fallback for deployments configured the old way.
WERKSTATT_LABEL_PRINTER_KEY = "werkstatt_label_printer"
# Label printer calibration (2026-10): the calibration records plus the last
# no-paper apply, and the one calibration session (``{}`` when free). Kept
# apart from the configuration so a record or a lock write never bumps the
# configuration's revision. See docs/LABEL_PRINTER_CALIBRATION.md §3.
WERKSTATT_LABEL_PRINTER_STATE_KEY = "werkstatt_label_printer_state"
WERKSTATT_LABEL_PRINTER_LOCK_KEY = "werkstatt_label_printer_lock"

# Default model for ProjectLineItem extraction. Operators can switch to
# `gpt-4o` (more accurate, more expensive) or any other OpenAI Structured-
# Outputs-capable model from the admin UI without a code change.
OPENAI_DEFAULT_EXTRACTION_MODEL = "gpt-4o-mini"


def get_runtime_setting(db: Session, key: str) -> str | None:
    row = db.get(AppSetting, key)
    if not row:
        return None
    return row.value


def get_runtime_setting_for_update(db: Session, key: str) -> AppSetting | None:
    """The row under ``SELECT … FOR UPDATE`` (a plain read on SQLite, which
    has no row locks — like ``werkstatt_movements``), refreshed from the
    database rather than this session's identity map, so a read-modify-write
    acts on what the lock returned."""
    stmt = select(AppSetting).where(AppSetting.key == key).execution_options(populate_existing=True)
    dialect_name = str(db.bind.dialect.name if db.bind is not None else "").lower()
    if dialect_name != "sqlite":
        stmt = stmt.with_for_update()
    return db.scalars(stmt).first()


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


def get_active_update_job(db: Session) -> dict[str, Any] | None:
    """Return the snapshot of an in-flight runner-mediated update job,
    or None when no job is active.

    The shape mirrors the columns we store: ``job_id``, ``started_at``
    (UTC ISO-8601), ``started_by_user_id``, ``started_by_display_name``.
    Reads never raise on malformed JSON — a corrupt setting returns
    None, which the API treats the same as "no job," and the next
    successful dispatch will overwrite it with a fresh snapshot.
    """
    raw = get_runtime_setting(db, ACTIVE_UPDATE_JOB_KEY)
    if not raw:
        return None
    try:
        stored = json.loads(raw)
    except Exception:
        return None
    if not isinstance(stored, dict):
        return None
    job_id = (stored.get("job_id") or "").strip()
    if not job_id:
        return None
    return {
        "job_id": job_id,
        "started_at": stored.get("started_at"),
        "started_by_user_id": stored.get("started_by_user_id"),
        "started_by_display_name": (stored.get("started_by_display_name") or "").strip() or None,
    }


def set_active_update_job(
    db: Session,
    *,
    job_id: str,
    started_at: str,
    started_by_user_id: int | None,
    started_by_display_name: str | None,
) -> None:
    """Store the snapshot of an in-flight update job. Caller is
    responsible for committing the surrounding session."""
    set_runtime_setting(
        db,
        ACTIVE_UPDATE_JOB_KEY,
        json.dumps(
            {
                "job_id": (job_id or "").strip(),
                "started_at": started_at,
                "started_by_user_id": started_by_user_id,
                "started_by_display_name": (started_by_display_name or "").strip() or None,
            }
        ),
    )


def clear_active_update_job(db: Session) -> None:
    """Erase the active-update snapshot. Called when a polling read
    finds the runner has finished (succeeded / failed). Idempotent —
    no error if the row doesn't exist."""
    row = db.get(AppSetting, ACTIVE_UPDATE_JOB_KEY)
    if row is not None:
        db.delete(row)


def get_openai_settings(db: Session) -> dict[str, Any]:
    """Read the OpenAI runtime settings (api_key + extraction_model).

    Stored as a single JSON blob under ``OPENAI_SETTINGS_KEY`` so we can add
    fields (org id, base url, etc.) later without an alembic migration. The
    defaults are returned untouched whenever the row is missing or the JSON
    is malformed — never raise from a config read.
    """
    defaults: dict[str, Any] = {
        "api_key": "",
        "extraction_model": OPENAI_DEFAULT_EXTRACTION_MODEL,
    }
    raw = get_runtime_setting(db, OPENAI_SETTINGS_KEY)
    if not raw:
        return defaults
    try:
        stored = json.loads(raw)
    except Exception:
        return defaults
    if not isinstance(stored, dict):
        return defaults

    merged = {**defaults}
    if "api_key" in stored:
        merged["api_key"] = str(stored.get("api_key") or "").strip()
    if "extraction_model" in stored:
        model = str(stored.get("extraction_model") or "").strip()
        merged["extraction_model"] = model or defaults["extraction_model"]
    return merged


def set_openai_settings(
    db: Session,
    *,
    api_key: str,
    extraction_model: str,
) -> None:
    set_runtime_setting(
        db,
        OPENAI_SETTINGS_KEY,
        json.dumps(
            {
                "api_key": (api_key or "").strip(),
                "extraction_model": (extraction_model or "").strip()
                or OPENAI_DEFAULT_EXTRACTION_MODEL,
            }
        ),
    )


def get_smtp_settings(db: Session) -> dict[str, Any]:
    settings = get_settings()
    defaults: dict[str, Any] = {
        "host": (settings.smtp_host or "").strip(),
        "port": int(settings.smtp_port or 0) or 587,
        "username": (settings.smtp_username or "").strip(),
        "password": settings.smtp_password or "",
        "starttls": bool(settings.smtp_starttls),
        "ssl": bool(settings.smtp_ssl),
        "from_email": (settings.mail_from or "").strip(),
        "from_name": "",
    }
    raw = get_runtime_setting(db, SMTP_SETTINGS_KEY)
    if not raw:
        return defaults
    try:
        stored = json.loads(raw)
    except Exception:
        return defaults
    if not isinstance(stored, dict):
        return defaults

    merged = {**defaults}
    if "host" in stored:
        merged["host"] = str(stored.get("host") or "").strip()
    if "port" in stored:
        try:
            port = int(stored.get("port") or 0)
        except (TypeError, ValueError):
            port = defaults["port"]
        merged["port"] = port if 1 <= port <= 65535 else defaults["port"]
    if "username" in stored:
        merged["username"] = str(stored.get("username") or "").strip()
    if "password" in stored:
        merged["password"] = str(stored.get("password") or "")
    if "starttls" in stored:
        merged["starttls"] = bool(stored.get("starttls"))
    if "ssl" in stored:
        merged["ssl"] = bool(stored.get("ssl"))
    if "from_email" in stored:
        merged["from_email"] = str(stored.get("from_email") or "").strip()
    if "from_name" in stored:
        merged["from_name"] = str(stored.get("from_name") or "").strip()
    return merged


def set_smtp_settings(
    db: Session,
    *,
    host: str,
    port: int,
    username: str,
    password: str,
    starttls: bool,
    ssl: bool,
    from_email: str,
    from_name: str,
) -> None:
    set_runtime_setting(
        db,
        SMTP_SETTINGS_KEY,
        json.dumps(
            {
                "host": (host or "").strip(),
                "port": int(port or 0) or 587,
                "username": (username or "").strip(),
                "password": password or "",
                "starttls": bool(starttls),
                "ssl": bool(ssl),
                "from_email": (from_email or "").strip(),
                "from_name": (from_name or "").strip(),
            }
        ),
    )


def get_company_settings(db: Session) -> dict[str, Any]:
    defaults: dict[str, Any] = {
        "logo_url": "",
        "navigation_title": "SMPL",
        "company_name": "SMPL",
        "company_address": "",
        # Shown to partners in the portal as "Fragen? Büro anrufen".
        "company_phone": "",
        "company_email": "",
    }
    raw = get_runtime_setting(db, COMPANY_SETTINGS_KEY)
    if not raw:
        return defaults
    try:
        stored = json.loads(raw)
    except Exception:
        return defaults
    if not isinstance(stored, dict):
        return defaults

    merged = {**defaults}
    if "logo_url" in stored:
        merged["logo_url"] = str(stored.get("logo_url") or "").strip()
    if "navigation_title" in stored:
        navigation_title = str(stored.get("navigation_title") or "").strip()
        merged["navigation_title"] = navigation_title or defaults["navigation_title"]
    if "company_name" in stored:
        company_name = str(stored.get("company_name") or "").strip()
        merged["company_name"] = company_name or defaults["company_name"]
    if "company_address" in stored:
        merged["company_address"] = str(stored.get("company_address") or "").strip()
    if "company_phone" in stored:
        merged["company_phone"] = str(stored.get("company_phone") or "").strip()
    if "company_email" in stored:
        merged["company_email"] = str(stored.get("company_email") or "").strip()
    return merged


def set_company_settings(
    db: Session,
    *,
    logo_url: str,
    navigation_title: str,
    company_name: str,
    company_address: str,
    company_phone: str = "",
    company_email: str = "",
) -> None:
    set_runtime_setting(
        db,
        COMPANY_SETTINGS_KEY,
        json.dumps(
            {
                "logo_url": (logo_url or "").strip(),
                "navigation_title": (navigation_title or "").strip() or "SMPL",
                "company_name": (company_name or "").strip() or "SMPL",
                "company_address": (company_address or "").strip(),
                "company_phone": (company_phone or "").strip(),
                "company_email": (company_email or "").strip(),
            }
        ),
    )
