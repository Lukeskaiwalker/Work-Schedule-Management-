"""Role and per-user permission overrides: stored once, enforced by every process.

Production runs several processes against one database -- two uvicorn
workers and the api_worker -- and each keeps a copy of the overrides in
``app.core.permissions``. Until 2026-10-21 that copy was read at startup and
only the worker that handled an admin's save refreshed it: a deny saved on one
worker was not enforced on the other until it recycled, and a save built from
a stale copy overwrote what another admin had saved.

Storage, three ``app_settings`` rows:

* ``role_permissions``      ``{role: [permission, …]}`` for every role
* ``user_permissions``      ``{"<user id>": {"extra": […], "denied": […]}}``
* ``permissions_revision``  a random token, replaced in the same transaction
  as every change to the two rows above. Its row is also the write lock.

Reading: the auth resolvers (``get_current_user``, ``get_active_user_by_id``
and the WebDAV login) call :func:`refresh_permissions_if_changed` on every
request -- one primary-key read; on a different revision, one statement reads
all three rows and the process swaps its snapshot. A request that starts after
an admin's commit sees it in every process: no TTL window, and no notification
that a dropped connection could lose. A new way of authenticating a user must
call it too, as it must apply the partner-portal fence.

Writing: every change locks the revision row (``SELECT … FOR UPDATE``), reads
the stored JSON from the database -- never this process's copy, which may be
stale -- applies the change, writes a new revision and commits. Two admins
saving at once queue on the lock, and the second builds on the first's commit.

Whatever writes these rows by another route must replace the revision too, or
running processes keep their copy. A restored backup brings its own revision
row (or none), which differs from what the processes hold, so they reload.
"""

from __future__ import annotations

import json
import logging
import secrets
import threading
from typing import Any

from sqlalchemy import Select, select
from sqlalchemy.dialects import postgresql, sqlite
from sqlalchemy.orm import Session

from app.core.permissions import (
    ALL_PERMISSIONS,
    ALL_ROLES,
    PERMISSIONS_BY_ROLE,
    ROLE_ADMIN,
    get_effective_permissions,
    install_permission_snapshot,
    make_permission_snapshot,
    permission_snapshot,
)
from app.models.entities import AppSetting

logger = logging.getLogger("smpl.permissions")

ROLE_PERMISSIONS_KEY = "role_permissions"
USER_PERMISSIONS_KEY = "user_permissions"
PERMISSIONS_REVISION_KEY = "permissions_revision"
_STATE_KEYS = (PERMISSIONS_REVISION_KEY, ROLE_PERMISSIONS_KEY, USER_PERMISSIONS_KEY)

_INSERTS = {"postgresql": postgresql.insert, "sqlite": sqlite.insert}

# One reload at a time in this process, each reading the newest committed
# state: a reload that read an older state can then never be installed over a
# newer one that another thread installed meanwhile.
_reload_lock = threading.Lock()

RoleMap = dict[str, list[str]]
UserOverrides = dict[int, dict[str, list[str]]]


# ── Reading ───────────────────────────────────────────────────────────────────

def refresh_permissions_if_changed(db: Session) -> None:
    """Bring this process's copy up to the committed overrides if they changed.

    Called by every auth resolver, so it costs one primary-key read when
    nothing changed."""
    stored = db.execute(_value_of(PERMISSIONS_REVISION_KEY)).scalar_one_or_none() or ""
    if stored != permission_snapshot().revision:
        _reload(db)


def load_permissions_from_db(db: Session) -> None:
    """Startup: heal the stored role map, then load whatever is stored.

    v2.5.25 -- permission strings that are no longer in ``ALL_PERMISSIONS``
    (renamed or removed by a later release) are dropped from the stored role
    map, and the cleaned map is written back, so the next PUT, which validates
    against ``ALL_PERMISSIONS``, cannot trip over an entry the admin never saw.
    Steady-state startups find nothing to drop and write nothing."""
    if _role_map_has_unknown_entries(_read_json(db, ROLE_PERMISSIONS_KEY)):
        _lock(db)
        stored = _clean_role_map(_read_json(db, ROLE_PERMISSIONS_KEY))
        if stored is not None:
            _write_json(db, ROLE_PERMISSIONS_KEY, _full_role_map(stored))
        _commit_new_revision(db)
    _reload(db, force=True)


def _reload(db: Session, *, force: bool = False) -> None:
    with _reload_lock:
        # One statement is one snapshot: the revision and the maps it stamps.
        rows = dict(
            db.execute(
                select(AppSetting.key, AppSetting.value).where(AppSetting.key.in_(_STATE_KEYS))
            ).tuples().all()
        )
        revision = rows.get(PERMISSIONS_REVISION_KEY) or ""
        if not force and revision == permission_snapshot().revision:
            return  # another thread got there first
        stored_roles = _clean_role_map(_parse(rows.get(ROLE_PERMISSIONS_KEY), ROLE_PERMISSIONS_KEY))
        install_permission_snapshot(
            make_permission_snapshot(
                revision,
                None if stored_roles is None else _full_role_map(stored_roles),
                _clean_user_overrides(_parse(rows.get(USER_PERMISSIONS_KEY), USER_PERMISSIONS_KEY)),
            )
        )


# ── Writing ───────────────────────────────────────────────────────────────────

def save_role_permissions(db: Session, role: str, permissions: list[str]) -> RoleMap:
    """Set one role's permissions; return the effective map of every role.
    Unknown permission strings are dropped (v2.5.25, see load)."""
    if role not in ALL_ROLES:
        raise ValueError(f"Unknown role: {role}")
    _lock(db)
    stored = _clean_role_map(_read_json(db, ROLE_PERMISSIONS_KEY)) or {}
    updated = {**_full_role_map(stored), role: _known_permissions(permissions)}
    _write_json(db, ROLE_PERMISSIONS_KEY, updated)
    _commit_new_revision(db)
    return get_effective_permissions()


def reset_role_to_defaults(db: Session, role: str) -> RoleMap:
    """Put one role back on its hard-coded defaults; return the effective map."""
    _lock(db)
    stored = _clean_role_map(_read_json(db, ROLE_PERMISSIONS_KEY)) or {}
    remaining = {name: perms for name, perms in stored.items() if name != role}
    # Every role back on its defaults: no stored map at all.
    _write_json(db, ROLE_PERMISSIONS_KEY, remaining or None)
    _commit_new_revision(db)
    return get_effective_permissions()


def save_user_permissions_to_db(
    db: Session,
    user_id: int,
    extra: list[str],
    denied: list[str],
) -> dict[str, list[str]]:
    """Set one user's extra grants and denies; empty lists remove the user's
    entry."""
    override = {"extra": sorted(set(extra)), "denied": sorted(set(denied))}
    _lock(db)
    stored = _clean_user_overrides(_read_json(db, USER_PERMISSIONS_KEY))
    others = {uid: data for uid, data in stored.items() if uid != user_id}
    updated = {**others, user_id: override} if override["extra"] or override["denied"] else others
    _write_json(
        db,
        USER_PERMISSIONS_KEY,
        {str(uid): data for uid, data in sorted(updated.items())} or None,
    )
    _commit_new_revision(db)
    return override


def reset_user_permissions_from_db(db: Session, user_id: int) -> None:
    """Remove all per-user overrides for one user."""
    save_user_permissions_to_db(db, user_id, [], [])


def _lock(db: Session) -> None:
    """Take the permission write lock: the revision row, FOR UPDATE.

    The row is created first when this database never had one -- ON CONFLICT
    DO NOTHING, so two first saves cannot collide on its key. SQLite renders
    no FOR UPDATE; it serialises writers by itself, and the insert has already
    made this transaction one."""
    insert = _INSERTS[db.get_bind().dialect.name]
    db.execute(
        insert(AppSetting)
        .values(key=PERMISSIONS_REVISION_KEY, value="")
        .on_conflict_do_nothing(index_elements=[AppSetting.key])
    )
    db.execute(_value_of(PERMISSIONS_REVISION_KEY).with_for_update())


def _commit_new_revision(db: Session) -> None:
    """Stamp the change, commit it (releasing the lock) and load it here."""
    db.get(AppSetting, PERMISSIONS_REVISION_KEY, populate_existing=True).value = secrets.token_hex(16)
    db.commit()
    refresh_permissions_if_changed(db)


def _write_json(db: Session, key: str, value: Any | None) -> None:
    """Store ``value`` as JSON under ``key``; None removes the row."""
    # populate_existing: a row this session loaded before the lock may be stale.
    row = db.get(AppSetting, key, populate_existing=True)
    if value is None:
        if row is not None:
            db.delete(row)
    elif row is None:
        db.add(AppSetting(key=key, value=json.dumps(value)))
    else:
        row.value = json.dumps(value)


# ── Parsing ───────────────────────────────────────────────────────────────────

def _value_of(key: str) -> Select[tuple[str]]:
    # A column select, never db.get(): the identity map could answer from a
    # row this session loaded before another process committed.
    return select(AppSetting.value).where(AppSetting.key == key)


def _read_json(db: Session, key: str) -> Any:
    return _parse(db.execute(_value_of(key)).scalar_one_or_none(), key)


def _parse(raw: str | None, key: str) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        logger.error("app_settings[%s] is not valid JSON; read as no overrides", key)
        return None


def _known_permissions(permissions: Any) -> list[str]:
    if not isinstance(permissions, list):
        return []
    return sorted({p for p in permissions if isinstance(p, str) and p in ALL_PERMISSIONS})


def _role_map_has_unknown_entries(data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    return any(
        len(_known_permissions(perms)) != len(perms)
        for role, perms in data.items()
        if role in ALL_ROLES and isinstance(perms, list)
    )


def _clean_role_map(data: Any) -> RoleMap | None:
    """The stored role map without unknown roles or permissions; None when
    nothing (readable) is stored."""
    if not isinstance(data, dict):
        return None
    return {
        role: _known_permissions(perms)
        for role, perms in data.items()
        if role in ALL_ROLES and isinstance(perms, list)
    }


def _full_role_map(stored: RoleMap) -> RoleMap:
    """Every role: its stored list, else its defaults. Admin always gets the
    full built-in set (the admin role is not editable)."""
    return {
        role: sorted(PERMISSIONS_BY_ROLE[ROLE_ADMIN]) if role == ROLE_ADMIN
        else stored.get(role, sorted(PERMISSIONS_BY_ROLE.get(role, set())))
        for role in ALL_ROLES
    }


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return sorted({item for item in value if isinstance(item, str)})


def _clean_user_overrides(data: Any) -> UserOverrides:
    if not isinstance(data, dict):
        return {}
    parsed = {
        int(key): {"extra": _string_list(entry.get("extra")), "denied": _string_list(entry.get("denied"))}
        for key, entry in data.items()
        if str(key).isdigit() and isinstance(entry, dict)
    }
    return {uid: entry for uid, entry in parsed.items() if entry["extra"] or entry["denied"]}
