"""The start-page widget catalog — the server's half (docs/DASHBOARD.md §1, D5).

The server owns which widgets exist and who may see them (``requires``); the
web owns titles and components (``apps/web/src/types/dashboard.ts`` and
``widgetMeta.ts``). ``tests/test_dashboard_catalog_parity.py`` keeps the two id
lists identical, in order.

Hiding a widget is UX, not access control: every widget's data comes from an
endpoint that checks access itself (§13).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Literal

from app.core.permissions import get_effective_permissions, get_user_effective_permissions
from app.models.entities import User

DashboardDevice = Literal["mobile", "tablet", "desktop"]
WidgetSize = Literal["small", "medium", "large"]
WidgetGroup = Literal["shortcuts", "personal", "planning", "werkstatt", "office"]

DEVICES: tuple[DashboardDevice, ...] = ("mobile", "tablet", "desktop")
WIDGET_SIZES: tuple[WidgetSize, ...] = ("small", "medium", "large")


@dataclass(frozen=True)
class WidgetSpec:
    id: str
    group: WidgetGroup
    default_size: WidgetSize
    # AND of OR-groups: (("a", "b"), ("c",)) means (a or b) and c. Empty
    # means any signed-in internal user.
    requires: tuple[tuple[str, ...], ...] = ()


_TIME_VIEWERS = ("time:view_all", "time:manage")

# §1 order — the order of `available_widgets` and of the "add widget" list.
CATALOG: tuple[WidgetSpec, ...] = (
    WidgetSpec("shortcuts", "shortcuts", "large"),
    WidgetSpec("my_status", "personal", "medium", (("time:clock",),)),
    WidgetSpec("my_tasks", "personal", "medium"),
    WidgetSpec("my_vacation", "personal", "small", (("time:view_own",),)),
    WidgetSpec("notifications", "personal", "small"),
    WidgetSpec("planning_today", "planning", "medium"),
    WidgetSpec("my_projects", "planning", "small", (("projects:view",),)),
    WidgetSpec("critical_projects", "planning", "small", (("projects:view",),)),
    WidgetSpec("absent_today", "planning", "small", (("planning:manage", *_TIME_VIEWERS),)),
    # Werkstatt reads need only a login, as the nav does (owner answer Q3).
    WidgetSpec("werkstatt_kpis", "werkstatt", "medium"),
    WidgetSpec("werkstatt_reorder", "werkstatt", "small"),
    WidgetSpec("werkstatt_on_site", "werkstatt", "small"),
    WidgetSpec("werkstatt_my_checkouts", "werkstatt", "small"),
    WidgetSpec("werkstatt_boxes", "werkstatt", "small"),
    WidgetSpec("werkstatt_inspections", "werkstatt", "small"),
    WidgetSpec("recent_panels", "werkstatt", "small"),
    WidgetSpec("recent_reports", "office", "small", (("reports:view", "reports:manage", "reports:create"),)),
    # Without view rights the pending list holds only the caller's own
    # requests, and a widget titled "Offene Urlaubsanträge" would mislead.
    WidgetSpec("vacation_approvals", "office", "small", (("time:approve_vacation",), _TIME_VIEWERS)),
    WidgetSpec("clocked_in", "office", "small", (_TIME_VIEWERS,)),
    WidgetSpec("unread_chats", "office", "small", (("chat:project", "chat:manage"),)),
)

CATALOG_BY_ID: Mapping[str, WidgetSpec] = MappingProxyType({spec.id: spec for spec in CATALOG})

# Closed set of shortcut tiles. The retired "materials" view is not in it.
SHORTCUT_VIEWS: tuple[str, ...] = (
    "my_tasks",
    "planning",
    "calendar",
    "construction",
    "reports",
    "schaltplan",
    "werkstatt",
    "messages",
    "time",
    "wiki",
    "projects_all",
    "projects_map",
    "customers",
    "ausbildung",
)
MAX_SHORTCUT_VIEWS = 12


def is_available(spec: WidgetSpec, has_permission: Callable[[str], bool]) -> bool:
    return all(any(has_permission(permission) for permission in group) for group in spec.requires)


def available_ids_for_user(user: User) -> list[str]:
    """Catalog ids this user may see, with per-user overrides applied.

    Same resolution as ``has_permission_for_user`` (deny beats grant beats
    role; a partner holds nothing), but the permission map is built once
    instead of once per checked string.
    """
    granted = frozenset(get_user_effective_permissions(user.id, user.role))
    return [spec.id for spec in CATALOG if is_available(spec, granted.__contains__)]


def available_ids_for_role(role: str) -> list[str]:
    """Catalog ids a role may see at role level: admin overrides of the role
    count, per-user overrides do not. An unknown role sees nothing."""
    granted = frozenset(get_effective_permissions().get(role, ()))
    return [spec.id for spec in CATALOG if is_available(spec, granted.__contains__)]


def default_sizes() -> dict[str, WidgetSize]:
    return {spec.id: spec.default_size for spec in CATALOG}
