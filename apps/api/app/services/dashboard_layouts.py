"""Start-page layouts: validation, tolerant reads, the save merge, resolution
and storage (docs/DASHBOARD.md §2, §3, §6).

Two stores, no migration:

* a user's layouts live in ``users.preferences["dashboard_layouts"][device]``;
* role defaults live in one ``app_settings`` row per role and device,
  ``dashboard_default:{role}:{device}``, which keeps every row far below the
  2048-char column.

Resolution per device: the user's own layout, else the role default, else the
built-in default. Writes refuse only what cannot be stored; reads drop bad
items one by one, so a stale tab, a revoked permission or a renamed widget can
never produce a page that fails to load or a save that fails forever.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Collection, Iterable, Sequence
from copy import deepcopy
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.permissions import ALL_ROLES
from app.models.entities import AppSetting, User
from app.schemas.dashboard import DashboardWidgetIn
from app.services.dashboard_catalog import (
    CATALOG_BY_ID,
    DEVICES,
    MAX_SHORTCUT_VIEWS,
    SHORTCUT_VIEWS,
    WIDGET_SIZES,
    DashboardDevice,
    available_ids_for_user,
)
from app.services.dashboard_defaults import builtin_widgets
from app.services.runtime_settings import set_runtime_setting

logger = logging.getLogger(__name__)

USER_PREFERENCE_KEY = "dashboard_layouts"
ROLE_DEFAULT_KEY_PREFIX = "dashboard_default"
LAYOUT_VERSION = 1
# Defence in depth below the String(2048) column; the worst valid layout is
# about half of this (tests/test_dashboard_layouts.py holds it).
MAX_STORED_CHARS = 2000

_SHORTCUTS = "shortcuts"
_KNOWN_VIEWS = frozenset(SHORTCUT_VIEWS)


class DashboardLayoutError(ValueError):
    """A layout that cannot be stored. The router answers 422 with
    ``to_detail()``, an object the web can tell apart from FastAPI's list."""

    def __init__(self, code: str, message: str, ids: Sequence[str] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.ids: tuple[str, ...] = tuple(ids)

    def to_detail(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "ids": list(self.ids)}


@dataclass(frozen=True)
class StoredLayout:
    widgets: list[dict[str, Any]]
    updated_at: datetime | None
    role: str | None


@dataclass(frozen=True)
class ResolvedLayout:
    device: DashboardDevice
    widgets: list[dict[str, Any]]
    source: Literal["user", "role", "builtin"]
    updated_at: datetime | None
    role_changed: bool = False


# ── Small pure helpers ────────────────────────────────────────────────────────


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _repeated(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    repeated: list[str] = []
    for value in values:
        if value in seen and value not in repeated:
            repeated.append(value)
        seen.add(value)
    return repeated


def _item(widget_id: str, size: str, views: Sequence[str] | None) -> dict[str, Any]:
    item: dict[str, Any] = {"id": widget_id, "size": size}
    if views:
        item["settings"] = {"views": list(views)}
    return item


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return _as_utc(datetime.fromisoformat(value))
    except ValueError:
        return None


def iso_utc_now() -> str:
    # A string, never a datetime: the JSON column cannot serialise one and
    # the flush would fail.
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def role_default_key(role: str, device: DashboardDevice) -> str:
    return f"{ROLE_DEFAULT_KEY_PREFIX}:{role}:{device}"


def is_dashboard_role(role: str) -> bool:
    """Roles that have defaults: the internal ones. ``external`` never does."""
    return role in ALL_ROLES


# ── Write validation (§3.1 rules 2–5) ─────────────────────────────────────────


def clean_widgets(items: Sequence[DashboardWidgetIn]) -> list[dict[str, Any]]:
    """Plain storable items, or ``DashboardLayoutError``. No availability
    check: an id the caller may not see is stored and stays hidden (D7)."""
    ids = [item.id for item in items]
    unknown = _unique(widget_id for widget_id in ids if widget_id not in CATALOG_BY_ID)
    if unknown:
        raise DashboardLayoutError("unknown_widget", f"Widget „{unknown[0]}“ gibt es nicht.", unknown)
    duplicates = _repeated(ids)
    if duplicates:
        raise DashboardLayoutError("duplicate_widget", f"Widget „{duplicates[0]}“ ist doppelt.", duplicates)
    misplaced = [item.id for item in items if item.settings is not None and item.id != _SHORTCUTS]
    if misplaced:
        raise DashboardLayoutError("settings_not_allowed", "Einstellungen gibt es nur für den Schnellzugriff.", misplaced)
    # Duplicates are refused above, so these are the one shortcuts item's tiles.
    views = [view for item in items if item.settings is not None for view in item.settings.views]
    unknown_views = _unique(view for view in views if view not in _KNOWN_VIEWS)
    if unknown_views:
        raise DashboardLayoutError("unknown_view", f"Kachel „{unknown_views[0]}“ gibt es nicht.", unknown_views)
    repeated_views = _repeated(views)
    if repeated_views:
        raise DashboardLayoutError("duplicate_view", f"Kachel „{repeated_views[0]}“ ist doppelt.", repeated_views)
    return [_item(item.id, item.size, item.settings.views if item.settings else None) for item in items]


# ── Tolerant read (§3.2) ──────────────────────────────────────────────────────


def _stored_views(settings: object) -> list[str] | None:
    views = settings.get("views") if isinstance(settings, dict) else None
    if not isinstance(views, list):
        return None
    kept = _unique(view for view in views if isinstance(view, str) and view in _KNOWN_VIEWS)
    return kept[:MAX_SHORTCUT_VIEWS] or None


def _stored_items(raw_items: list[object]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_items:
        widget_id = raw.get("id") if isinstance(raw, dict) else None
        spec = CATALOG_BY_ID.get(widget_id) if isinstance(widget_id, str) else None
        if spec is None or spec.id in seen:
            continue
        seen.add(spec.id)
        size = raw.get("size")
        size = size if isinstance(size, str) and size in WIDGET_SIZES else spec.default_size
        views = _stored_views(raw.get("settings")) if spec.id == _SHORTCUTS else None
        cleaned.append(_item(spec.id, size, views))
    return cleaned


def parse_stored(raw: object) -> StoredLayout | None:
    """A stored layout (a dict from preferences or a JSON string from an
    ``app_settings`` row), cleaned item by item. ``None`` means "no layout":
    garbage, a wrong version or a ``widgets`` that is not a list."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, RecursionError):
            return None
    if not isinstance(raw, dict):
        return None
    version = raw.get("version")
    # `type(...) is int` keeps True and 1.0 out, which compare equal to 1.
    if type(version) is not int or version != LAYOUT_VERSION:
        return None
    widgets = raw.get("widgets")
    if not isinstance(widgets, list):
        return None
    role = raw.get("role")
    return StoredLayout(
        widgets=_stored_items(widgets),
        updated_at=_parse_timestamp(raw.get("updated_at")),
        role=role if isinstance(role, str) else None,
    )


# ── Save merge (§3.3, D6) ─────────────────────────────────────────────────────


def merge_hidden(
    incoming: list[dict[str, Any]],
    effective: list[dict[str, Any]],
    available: Collection[str],
) -> list[dict[str, Any]]:
    """Put the widgets the caller cannot see back where they were, so a
    revoked permission that returns brings its widget back in place, even
    after the user saved in between. Pure: returns new items."""
    incoming_ids = {item["id"] for item in incoming}
    hidden = [
        (index, item)
        for index, item in enumerate(effective)
        if item["id"] in CATALOG_BY_ID and item["id"] not in available and item["id"] not in incoming_ids
    ]
    merged = [deepcopy(item) for item in incoming]
    for index, item in hidden:  # ascending index
        merged.insert(min(index, len(merged)), deepcopy(item))
    return merged


def _only(widgets: list[dict[str, Any]], available: Collection[str]) -> list[dict[str, Any]]:
    allowed = frozenset(available)
    return [item for item in widgets if item["id"] in allowed]


# ── Resolution (§6) ───────────────────────────────────────────────────────────


def _user_layouts(user: User) -> dict[str, Any]:
    prefs = user.preferences
    layouts = prefs.get(USER_PREFERENCE_KEY) if isinstance(prefs, dict) else None
    return layouts if isinstance(layouts, dict) else {}


def _stored_user_layout(user: User, device: DashboardDevice) -> StoredLayout | None:
    raw = _user_layouts(user).get(device)
    if raw is None:
        return None
    stored = parse_stored(raw)
    if stored is None:
        # Ids only: layout content is personal and stays out of the logs.
        logger.warning("Ignoring an unreadable dashboard layout (user %s, device %s)", user.id, device)
    return stored


def _role_layout(row: AppSetting | None, role: str, device: DashboardDevice) -> ResolvedLayout:
    stored = parse_stored(row.value) if row is not None else None
    if row is not None and stored is None:
        logger.warning("Ignoring an unreadable dashboard role default (role %s, device %s)", role, device)
    if stored is None:
        return ResolvedLayout(device, builtin_widgets(role, device), "builtin", None)
    return ResolvedLayout(device, stored.widgets, "role", _as_utc(row.updated_at))


def resolve_role_default(db: Session, role: str, device: DashboardDevice) -> ResolvedLayout:
    """The role's layout for a device, unfiltered: stored default or built-in."""
    row = db.get(AppSetting, role_default_key(role, device)) if is_dashboard_role(role) else None
    return _role_layout(row, role, device)


def list_role_defaults(db: Session) -> list[tuple[str, ResolvedLayout]]:
    """All 15 role defaults, role order × device order, in one query."""
    keys = [role_default_key(role, device) for role in ALL_ROLES for device in DEVICES]
    rows = {row.key: row for row in db.scalars(select(AppSetting).where(AppSetting.key.in_(keys)))}
    return [
        (role, _role_layout(rows.get(role_default_key(role, device)), role, device))
        for role in ALL_ROLES
        for device in DEVICES
    ]


def resolve_layout(db: Session, user: User, device: DashboardDevice, *, filtered: bool = True) -> ResolvedLayout:
    stored = _stored_user_layout(user, device)
    if stored is None:
        resolved = resolve_role_default(db, user.role, device)
    else:
        role_changed = stored.role is not None and stored.role != user.role
        resolved = ResolvedLayout(device, stored.widgets, "user", stored.updated_at, role_changed)
    if not filtered:
        return resolved
    return replace(resolved, widgets=_only(resolved.widgets, available_ids_for_user(user)))


# ── User storage (§4.1) ───────────────────────────────────────────────────────
#
# Never change a nested dict in place: SQLAlchemy compares the old and new
# value of a plain JSON column with `==`, and a nested dict shared between
# them makes both sides equal, so no UPDATE is sent and the other device's
# save is silently lost. The row lock (Postgres; a no-op on SQLite) keeps a
# phone save and a desktop save from overwriting each other's device key.


def save_user_layout(
    db: Session, user: User, device: DashboardDevice, widgets: list[dict[str, Any]]
) -> ResolvedLayout:
    db.refresh(user, with_for_update=True)
    available = available_ids_for_user(user)
    effective = resolve_layout(db, user, device, filtered=False).widgets
    merged = merge_hidden(widgets, effective, available)
    stamp = iso_utc_now()
    entry = {"version": LAYOUT_VERSION, "role": user.role, "updated_at": stamp, "widgets": merged}
    prefs = user.preferences if isinstance(user.preferences, dict) else {}
    user.preferences = {**prefs, USER_PREFERENCE_KEY: {**_user_layouts(user), device: entry}}
    db.commit()
    return ResolvedLayout(device, _only(merged, available), "user", _parse_timestamp(stamp))


def clear_user_layout(db: Session, user: User, device: DashboardDevice) -> ResolvedLayout:
    db.refresh(user, with_for_update=True)
    layouts = _user_layouts(user)
    if device in layouts:
        remaining = {key: value for key, value in layouts.items() if key != device}
        user.preferences = {**user.preferences, USER_PREFERENCE_KEY: remaining}
    # Commit either way: it ends the transaction and releases the row lock.
    db.commit()
    return resolve_layout(db, user, device)


# ── Role-default storage (§2.3) ───────────────────────────────────────────────


def save_role_default(
    db: Session, role: str, device: DashboardDevice, widgets: list[dict[str, Any]]
) -> ResolvedLayout:
    value = json.dumps({"version": LAYOUT_VERSION, "widgets": widgets}, separators=(",", ":"))
    if len(value) > MAX_STORED_CHARS:
        raise DashboardLayoutError("too_large", "Die Startseite ist zu groß zum Speichern.")
    set_runtime_setting(db, role_default_key(role, device), value)
    db.commit()
    return resolve_role_default(db, role, device)


def clear_role_default(db: Session, role: str, device: DashboardDevice) -> ResolvedLayout:
    row = db.get(AppSetting, role_default_key(role, device))
    if row is not None:
        db.delete(row)
        db.commit()
    return ResolvedLayout(device, builtin_widgets(role, device), "builtin", None)
