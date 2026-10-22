"""Role and per-user permission overrides: stored once, enforced by every process.

Production runs several processes against one database -- two uvicorn
workers and the api_worker -- and each keeps a copy of the overrides in
``app.core.permissions``. Until 2026-10-21 that copy was read at startup and
only the worker that handled an admin's save refreshed it: a deny saved on one
worker was not enforced on the other until it recycled, and a save built from
a stale copy overwrote what another admin had saved.

Storage, three ``app_settings`` rows:

* ``role_permissions``      ``{role: [permission, …]}`` for every role, plus
  ``"_revision": n``, the ``ROLE_PERMISSION_UPGRADES`` the lists include
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

Upgrades (2026-10-21, docs/DASHBOARD.md Q1): a stored role list replaces that
role's defaults, so a permission later added to ``PERMISSIONS_BY_ROLE`` never
reached it. ``ROLE_PERMISSION_UPGRADES`` (app.core.permissions) names what each
upgrade added; every read grants the upgrades newer than the map's
``"_revision"`` stamp to the roles the map stores, the startup load writes that
back once, and every write stamps the map, so a box an admin unticks later
stays unticked. Not a role, so every loop over roles -- and every release
before the stamp -- skips the key.
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
    ROLE_PERMISSION_UPGRADES,
    ROLE_PERMISSIONS_REVISION,
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
# Inside the role_permissions JSON: which ROLE_PERMISSION_UPGRADES its lists
# already include (see the module docstring). Not PERMISSIONS_REVISION_KEY.
ROLE_PERMISSIONS_REVISION_FIELD = "_revision"
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

    2026-10-21 -- a map stamped before the newest ``ROLE_PERMISSION_UPGRADES``
    is written back with what the newer upgrades grant (every read applies
    them already) and stamped, so the grant is stored once per install.

    Steady-state startups find nothing to heal and write nothing."""
    if _role_map_needs_healing(_read_json(db, ROLE_PERMISSIONS_KEY)):
        _lock(db)
        # Again under the lock: a process starting alongside may have healed it.
        stored = _read_json(db, ROLE_PERMISSIONS_KEY)
        if _role_map_needs_healing(stored):
            healed = _current_role_map(stored) or {}
            _write_json(db, ROLE_PERMISSIONS_KEY, _stamped(_full_role_map(healed)))
            _commit_new_revision(db)
        else:
            db.commit()  # releases the lock; nothing to write
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
        stored_roles = _current_role_map(_parse(rows.get(ROLE_PERMISSIONS_KEY), ROLE_PERMISSIONS_KEY))
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
    # Upgraded before the stamp goes on: the other roles' stored lists may
    # predate an upgrade (a restored backup) and must not be stamped without it.
    stored = _current_role_map(_read_json(db, ROLE_PERMISSIONS_KEY)) or {}
    updated = {**_full_role_map(stored), role: _known_permissions(permissions)}
    _write_json(db, ROLE_PERMISSIONS_KEY, _stamped(updated))
    _commit_new_revision(db)
    return get_effective_permissions()


def reset_role_to_defaults(db: Session, role: str) -> RoleMap:
    """Put one role back on its hard-coded defaults; return the effective map."""
    _lock(db)
    stored = _current_role_map(_read_json(db, ROLE_PERMISSIONS_KEY)) or {}
    remaining = {name: perms for name, perms in stored.items() if name != role}
    # Every role back on its defaults: no stored map at all -- the stamp alone
    # is no customisation worth a row.
    _write_json(db, ROLE_PERMISSIONS_KEY, _stamped(remaining) if remaining else None)
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


def _upgrade_level(data: Any) -> int:
    """The newest ROLE_PERMISSION_UPGRADES the stored lists include. A missing
    or garbled stamp means "written before any upgrade existed"."""
    level = data.get(ROLE_PERMISSIONS_REVISION_FIELD) if isinstance(data, dict) else None
    return level if isinstance(level, int) and not isinstance(level, bool) else 0


def _current_role_map(data: Any) -> RoleMap | None:
    """The stored role map, cleaned, with what the upgrades newer than its
    stamp added to the defaults of the roles it stores; a role it does not
    store follows the defaults anyway. None when nothing (readable) is stored."""
    stored = _clean_role_map(data)
    if stored is None:
        return None
    level = _upgrade_level(data)
    upgraded = dict(stored)
    for revision, grants in ROLE_PERMISSION_UPGRADES:
        if revision <= level:
            continue
        for role, granted in grants.items():
            if role in upgraded:
                upgraded[role] = sorted(set(upgraded[role]) | granted)
    return upgraded


def _role_map_needs_healing(data: Any) -> bool:
    """Unknown entries to drop, or an upgrade that changes a stored list."""
    return _role_map_has_unknown_entries(data) or _current_role_map(data) != _clean_role_map(data)


def _stamped(role_map: RoleMap) -> dict[str, Any]:
    return {**role_map, ROLE_PERMISSIONS_REVISION_FIELD: ROLE_PERMISSIONS_REVISION}


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
