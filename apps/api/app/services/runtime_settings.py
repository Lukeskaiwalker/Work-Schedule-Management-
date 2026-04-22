from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.entities import AppSetting

INITIAL_ADMIN_BOOTSTRAP_COMPLETED_KEY = "initial_admin_bootstrap_completed"
OPENWEATHER_API_KEY = "openweather_api_key"
SMTP_SETTINGS_KEY = "smtp_settings"
COMPANY_SETTINGS_KEY = "company_settings"
ROLE_PERMISSIONS_KEY = "role_permissions"
USER_PERMISSIONS_KEY = "user_permissions"


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
    return merged


def set_company_settings(
    db: Session,
    *,
    logo_url: str,
    navigation_title: str,
    company_name: str,
    company_address: str,
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
            }
        ),
    )


# ── Role permissions ──────────────────────────────────────────────────────────

def load_role_permissions_from_db(db: Session) -> None:
    """Read the stored role-permissions override from the DB and push it into
    the in-process cache in permissions.py.  Call once at startup and after
    every admin save."""
    from app.core.permissions import ALL_ROLES, PERMISSIONS_BY_ROLE, set_permissions_override

    raw = get_runtime_setting(db, ROLE_PERMISSIONS_KEY)
    if not raw:
        set_permissions_override(None)
        return
    try:
        data: dict[str, list[str]] = json.loads(raw)
    except Exception:
        set_permissions_override(None)
        return
    # Build a full map — start from defaults so roles not in the stored JSON
    # are still populated correctly.
    merged: dict[str, list[str]] = {role: sorted(PERMISSIONS_BY_ROLE.get(role, set())) for role in ALL_ROLES}
    for role, perms in data.items():
        if role in merged and isinstance(perms, list):
            merged[role] = sorted(set(perms))
    set_permissions_override(merged)


def save_role_permissions_to_db(
    db: Session, updated: dict[str, list[str]]
) -> dict[str, list[str]]:
    """Persist the full role-permissions map, reload the in-process cache,
    and return the effective map."""
    from app.core.permissions import ALL_ROLES, PERMISSIONS_BY_ROLE, set_permissions_override

    # Normalise: keep only known roles, deduplicate and sort each perm list.
    clean: dict[str, list[str]] = {}
    for role in ALL_ROLES:
        raw_perms = updated.get(role, sorted(PERMISSIONS_BY_ROLE.get(role, set())))
        clean[role] = sorted(set(raw_perms))

    set_runtime_setting(db, ROLE_PERMISSIONS_KEY, json.dumps(clean))
    db.commit()
    set_permissions_override(clean)
    return clean


def reset_role_to_defaults(db: Session, role: str) -> dict[str, list[str]]:
    """Reset one role to its hard-coded defaults, persist, and reload cache."""
    from app.core.permissions import ALL_ROLES, PERMISSIONS_BY_ROLE, set_permissions_override

    raw = get_runtime_setting(db, ROLE_PERMISSIONS_KEY)
    try:
        stored: dict[str, list[str]] = json.loads(raw) if raw else {}
    except Exception:
        stored = {}

    stored.pop(role, None)

    if not stored:
        # All roles are back to defaults — remove the setting entirely.
        row = db.get(AppSetting, ROLE_PERMISSIONS_KEY)
        if row:
            db.delete(row)
        db.commit()
        set_permissions_override(None)
    else:
        set_runtime_setting(db, ROLE_PERMISSIONS_KEY, json.dumps(stored))
        db.commit()
        # Rebuild full map from defaults + remaining overrides.
        merged: dict[str, list[str]] = {r: sorted(PERMISSIONS_BY_ROLE.get(r, set())) for r in ALL_ROLES}
        for r, perms in stored.items():
            if r in merged:
                merged[r] = sorted(set(perms))
        set_permissions_override(merged)

    from app.core.permissions import get_effective_permissions
    return get_effective_permissions()


# ── User-level permission overrides ──────────────────────────────────────────

def load_user_permissions_from_db(db: Session) -> None:
    """Load per-user permission overrides from the DB into the in-process cache."""
    from app.core.permissions import set_user_permissions_override

    raw = get_runtime_setting(db, USER_PERMISSIONS_KEY)
    if not raw:
        set_user_permissions_override({})
        return
    try:
        data: dict[str, dict] = json.loads(raw)
    except Exception:
        set_user_permissions_override({})
        return
    set_user_permissions_override({int(k): v for k, v in data.items()})


def save_user_permissions_to_db(
    db: Session,
    user_id: int,
    extra: list[str],
    denied: list[str],
) -> dict[str, list[str]]:
    """Persist per-user permission overrides and reload the in-process cache."""
    from app.core.permissions import get_all_user_overrides, set_user_permissions_override

    current = get_all_user_overrides()
    clean_extra = sorted(set(extra))
    clean_denied = sorted(set(denied))

    if clean_extra or clean_denied:
        current[user_id] = {"extra": clean_extra, "denied": clean_denied}
    else:
        current.pop(user_id, None)

    if current:
        set_runtime_setting(
            db, USER_PERMISSIONS_KEY,
            json.dumps({str(k): v for k, v in current.items()}),
        )
    else:
        row = db.get(AppSetting, USER_PERMISSIONS_KEY)
        if row:
            db.delete(row)

    db.commit()
    set_user_permissions_override(current)
    return {"extra": clean_extra, "denied": clean_denied}


def reset_user_permissions_from_db(db: Session, user_id: int) -> None:
    """Remove all per-user overrides for one user and reload the cache."""
    from app.core.permissions import get_all_user_overrides, set_user_permissions_override

    current = get_all_user_overrides()
    current.pop(user_id, None)

    if current:
        set_runtime_setting(
            db, USER_PERMISSIONS_KEY,
            json.dumps({str(k): v for k, v in current.items()}),
        )
    else:
        row = db.get(AppSetting, USER_PERMISSIONS_KEY)
        if row:
            db.delete(row)

    db.commit()
    set_user_permissions_override(current)
