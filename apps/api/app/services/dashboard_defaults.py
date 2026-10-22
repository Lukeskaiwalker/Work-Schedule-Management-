"""Built-in start pages per role and device (docs/DASHBOARD.md §5).

They apply when neither the user nor an admin has set a layout, and are
filtered per user at read time — so a default may name a widget some holders
of the role cannot see. Desktop and tablet rows are written to fill whole
rows on 3 and 2 columns.
"""

from __future__ import annotations

from typing import Any

from app.core.permissions import ROLE_ACCOUNTANT, ROLE_ADMIN, ROLE_CEO, ROLE_EMPLOYEE, ROLE_PLANNING
from app.services.dashboard_catalog import DashboardDevice

# Shortcut presets. FIELD is the overview's old tile set with the retired
# "materials" tile swapped for "werkstatt". The phone presets complement the
# bottom bar, which already has Start, Aufgaben, Werkstatt, Zeit and Profil.
FIELD = ("my_tasks", "planning", "construction", "werkstatt", "messages", "time", "wiki")
OFFICE = ("my_tasks", "planning", "projects_all", "customers", "calendar", "messages", "time", "wiki")
M_FIELD = ("construction", "planning", "messages", "wiki")
M_OFFICE = ("planning", "projects_all", "customers", "messages")

_SIZE = {"S": "small", "M": "medium", "L": "large"}

# One entry per widget: "id SIZE", and the shortcuts carry their preset.
_Row = tuple[str | tuple[str, tuple[str, ...]], ...]

_DEFAULTS: dict[str, dict[str, _Row]] = {
    ROLE_ADMIN: {
        "mobile": ("my_status M", ("shortcuts M", M_OFFICE), "my_tasks M", "vacation_approvals M", "clocked_in M", "critical_projects M"),
        "tablet": (
            ("shortcuts L", OFFICE), "my_status S", "clocked_in S", "my_tasks M", "vacation_approvals S",
            "absent_today S", "critical_projects S", "recent_reports S", "werkstatt_kpis M",
        ),
        "desktop": (
            ("shortcuts L", OFFICE), "my_status S", "clocked_in S", "vacation_approvals S", "my_tasks M",
            "absent_today S", "critical_projects S", "recent_reports S", "notifications S", "werkstatt_kpis M",
            "werkstatt_reorder S",
        ),
    },
    ROLE_CEO: {
        "mobile": (("shortcuts M", M_OFFICE), "critical_projects M", "vacation_approvals M", "my_tasks M", "unread_chats M"),
        "tablet": (
            ("shortcuts L", OFFICE), "critical_projects S", "vacation_approvals S", "my_tasks M", "clocked_in S",
            "absent_today S", "recent_reports S", "unread_chats S",
        ),
        "desktop": (
            ("shortcuts L", OFFICE), "critical_projects S", "clocked_in S", "vacation_approvals S", "my_tasks M",
            "absent_today S", "recent_reports S", "unread_chats S", "notifications S",
        ),
    },
    ROLE_ACCOUNTANT: {
        "mobile": (("shortcuts M", M_OFFICE), "my_tasks M", "clocked_in M", "unread_chats M"),
        "tablet": (
            ("shortcuts L", OFFICE), "clocked_in S", "absent_today S", "my_tasks M", "recent_reports S",
            "critical_projects S",
        ),
        "desktop": (
            ("shortcuts L", OFFICE), "clocked_in S", "absent_today S", "critical_projects S", "my_tasks M",
            "recent_reports S", "unread_chats S", "notifications S",
        ),
    },
    ROLE_PLANNING: {
        "mobile": (("shortcuts M", M_OFFICE), "planning_today M", "absent_today M", "my_tasks M", "unread_chats M"),
        "tablet": (
            ("shortcuts L", OFFICE), "planning_today M", "absent_today S", "critical_projects S", "my_tasks M",
            "recent_reports S", "unread_chats S",
        ),
        "desktop": (
            ("shortcuts L", OFFICE), "planning_today M", "absent_today S", "my_tasks M", "critical_projects S",
            "recent_reports S", "unread_chats S", "notifications S", "recent_panels S",
        ),
    },
    # Desktop starts with the old overview (shortcuts, status, reports,
    # projects, tasks), so the first impression after the release is familiar.
    ROLE_EMPLOYEE: {
        "mobile": ("my_status M", ("shortcuts M", M_FIELD), "my_tasks M", "planning_today M", "werkstatt_my_checkouts M"),
        "tablet": (
            ("shortcuts L", FIELD), "my_status M", "my_tasks M", "planning_today S", "my_projects S",
            "werkstatt_my_checkouts S", "recent_reports S",
        ),
        "desktop": (
            ("shortcuts L", FIELD), "my_status S", "recent_reports S", "my_projects S", "my_tasks M",
            "planning_today S", "werkstatt_my_checkouts S", "notifications S",
        ),
    },
}


def _widget(entry: str | tuple[str, tuple[str, ...]]) -> dict[str, Any]:
    spec, views = (entry, None) if isinstance(entry, str) else entry
    widget_id, size = spec.split(" ")
    item: dict[str, Any] = {"id": widget_id, "size": _SIZE[size]}
    if views is not None:
        item["settings"] = {"views": list(views)}
    return item


def builtin_widgets(role: str, device: DashboardDevice) -> list[dict[str, Any]]:
    """A fresh copy of the role's built-in layout; an unknown role gets the
    employee's (the least privileged internal role)."""
    by_device = _DEFAULTS.get(role, _DEFAULTS[ROLE_EMPLOYEE])
    return [_widget(entry) for entry in by_device[device]]
