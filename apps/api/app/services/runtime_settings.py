from __future__ import annotations

import json

from sqlalchemy.orm import Session

from app.models.entities import AppSetting

INITIAL_ADMIN_BOOTSTRAP_COMPLETED_KEY = "initial_admin_bootstrap_completed"
OPENWEATHER_API_KEY = "openweather_api_key"
ROLE_PERMISSIONS_KEY = "role_permissions"


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
