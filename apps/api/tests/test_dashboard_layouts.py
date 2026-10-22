"""The personal start page — catalog, validation, tolerant read and save merge.

Unit tests without an HTTP client (docs/DASHBOARD.md §3, §5, §12 A2):

* a write is refused only for what cannot be stored — an unknown id, a
  duplicate, settings on a widget that has none, an unknown or repeated tile —
  each with its code, a German message and the offending ids;
* the worst-case layout stays under the ``app_settings`` column limit;
* a stored layout is read tolerantly, item by item, and garbage counts as
  "no layout";
* the save merge puts hidden widgets back where they were;
* every built-in default is itself a valid layout.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone

import pytest

from app.core.db import SessionLocal
from app.core.permissions import ALL_PERMISSIONS, ALL_ROLES
from app.models.entities import AppSetting
from app.schemas.dashboard import DashboardWidgetIn
from app.services import dashboard_layouts as layouts
from app.services.dashboard_catalog import (
    CATALOG,
    CATALOG_BY_ID,
    DEVICES,
    MAX_SHORTCUT_VIEWS,
    SHORTCUT_VIEWS,
    available_ids_for_role,
    default_sizes,
    is_available,
)
from app.services.dashboard_defaults import builtin_widgets
from app.services.dashboard_layouts import DashboardLayoutError, clean_widgets, merge_hidden, parse_stored

CATALOG_ORDER = [
    "shortcuts",
    "my_status",
    "my_tasks",
    "my_vacation",
    "notifications",
    "planning_today",
    "my_projects",
    "critical_projects",
    "absent_today",
    "werkstatt_kpis",
    "werkstatt_reorder",
    "werkstatt_on_site",
    "werkstatt_my_checkouts",
    "werkstatt_boxes",
    "werkstatt_inspections",
    "recent_panels",
    "recent_reports",
    "vacation_approvals",
    "clocked_in",
    "unread_chats",
]


def _item(widget_id: str, size: str = "medium", views: list[str] | None = None) -> DashboardWidgetIn:
    payload: dict = {"id": widget_id, "size": size}
    if views is not None:
        payload["settings"] = {"views": views}
    return DashboardWidgetIn.model_validate(payload)


def _refused(items: list[DashboardWidgetIn]) -> DashboardLayoutError:
    with pytest.raises(DashboardLayoutError) as caught:
        clean_widgets(items)
    return caught.value


# ── Catalog ───────────────────────────────────────────────────────────────────


def test_the_catalog_lists_the_twenty_widgets_in_contract_order() -> None:
    assert [spec.id for spec in CATALOG] == CATALOG_ORDER
    assert set(CATALOG_BY_ID) == set(CATALOG_ORDER)
    assert DEVICES == ("mobile", "tablet", "desktop")
    sizes = default_sizes()
    assert list(sizes) == CATALOG_ORDER
    assert set(sizes.values()) <= {"small", "medium", "large"}
    assert sizes["shortcuts"] == "large"
    assert sizes["my_status"] == "medium"
    assert sizes["my_tasks"] == "medium"


def test_every_requires_string_is_a_known_permission() -> None:
    for spec in CATALOG:
        for group in spec.requires:
            assert group, spec.id
            for permission in group:
                assert permission in ALL_PERMISSIONS, (spec.id, permission)


def test_requires_is_an_and_of_or_groups() -> None:
    spec = CATALOG_BY_ID["vacation_approvals"]
    assert is_available(spec, lambda p: p in {"time:approve_vacation", "time:manage"})
    assert not is_available(spec, lambda p: p == "time:approve_vacation")
    assert not is_available(spec, lambda p: p == "time:view_all")
    assert is_available(CATALOG_BY_ID["my_tasks"], lambda p: False)


def test_the_employee_role_cannot_see_the_office_widgets() -> None:
    available = available_ids_for_role("employee")
    for hidden in ("clocked_in", "vacation_approvals", "absent_today"):
        assert hidden not in available
    assert "my_status" in available and "shortcuts" in available
    assert available_ids_for_role("admin") == CATALOG_ORDER


def test_the_shortcut_views_are_the_closed_set_without_materials() -> None:
    assert SHORTCUT_VIEWS == (
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
    assert "materials" not in SHORTCUT_VIEWS
    assert MAX_SHORTCUT_VIEWS == 12


def test_the_dashboard_key_is_hidden_from_user_responses() -> None:
    # Owned by part A1 (schemas/user.py); asserted here because the dashboard
    # API is the key's only reader (D19).
    from app.schemas.user import HIDDEN_PREFERENCE_KEYS

    assert "dashboard_layouts" in HIDDEN_PREFERENCE_KEYS


# ── Write validation (rules 2–5) ──────────────────────────────────────────────


def test_an_empty_layout_is_valid() -> None:
    assert clean_widgets([]) == []


def test_a_valid_layout_comes_back_as_plain_items_in_order() -> None:
    cleaned = clean_widgets(
        [_item("my_tasks", "large"), _item("shortcuts", "small", ["time", "wiki"]), _item("my_status", "small")]
    )
    assert cleaned == [
        {"id": "my_tasks", "size": "large"},
        {"id": "shortcuts", "size": "small", "settings": {"views": ["time", "wiki"]}},
        {"id": "my_status", "size": "small"},
    ]


def test_an_unknown_widget_is_refused() -> None:
    error = _refused([_item("my_tasks"), _item("weather")])
    assert error.code == "unknown_widget"
    assert error.message == "Widget „weather“ gibt es nicht."
    assert error.ids == ("weather",)
    assert error.to_detail() == {"code": "unknown_widget", "message": error.message, "ids": ["weather"]}


def test_a_duplicate_widget_is_refused() -> None:
    error = _refused([_item("my_tasks"), _item("my_status"), _item("my_tasks", "small")])
    assert error.code == "duplicate_widget"
    assert error.message == "Widget „my_tasks“ ist doppelt."
    assert error.ids == ("my_tasks",)


def test_settings_are_refused_on_every_widget_but_the_shortcuts() -> None:
    error = _refused([_item("my_tasks", views=["time"])])
    assert error.code == "settings_not_allowed"
    assert error.message == "Einstellungen gibt es nur für den Schnellzugriff."
    assert error.ids == ("my_tasks",)


def test_an_unknown_tile_is_refused() -> None:
    error = _refused([_item("shortcuts", views=["time", "materials"])])
    assert error.code == "unknown_view"
    assert error.message == "Kachel „materials“ gibt es nicht."
    assert error.ids == ("materials",)


def test_a_repeated_tile_is_refused() -> None:
    error = _refused([_item("shortcuts", views=["time", "wiki", "time"])])
    assert error.code == "duplicate_view"
    assert error.message == "Kachel „time“ ist doppelt."
    assert error.ids == ("time",)


# ── Storage bound ─────────────────────────────────────────────────────────────


def test_the_worst_case_layout_fits_the_settings_column() -> None:
    longest_views = sorted(SHORTCUT_VIEWS, key=len, reverse=True)[:MAX_SHORTCUT_VIEWS]
    items = [
        _item(spec.id, "medium", longest_views if spec.id == "shortcuts" else None) for spec in CATALOG
    ]
    stored = json.dumps({"version": 1, "widgets": clean_widgets(items)}, separators=(",", ":"))
    assert len(stored) < layouts.MAX_STORED_CHARS == 2000


def test_a_role_default_above_the_limit_is_refused_and_not_stored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(layouts, "MAX_STORED_CHARS", 40)
    with SessionLocal() as db:
        with pytest.raises(DashboardLayoutError) as caught:
            layouts.save_role_default(db, "employee", "desktop", [{"id": "my_tasks", "size": "medium"}, {"id": "my_status", "size": "small"}])
        assert caught.value.code == "too_large"
        assert db.get(AppSetting, layouts.role_default_key("employee", "desktop")) is None


def test_keys_and_timestamps_have_the_documented_shape() -> None:
    assert layouts.role_default_key("planning", "desktop") == "dashboard_default:planning:desktop"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", layouts.iso_utc_now())


# ── Tolerant read ─────────────────────────────────────────────────────────────


def test_parse_stored_cleans_item_by_item() -> None:
    stored = parse_stored(
        {
            "version": 1,
            "role": "employee",
            "updated_at": "2026-10-21T18:40:12Z",
            "widgets": [
                {"id": "weather", "size": "small"},
                {"id": "my_tasks", "size": "large"},
                {"id": "my_tasks", "size": "small"},
                {"id": "my_status", "size": "gigantic"},
                "not an item",
                {"size": "small"},
                {"id": "notifications", "size": "small", "settings": {"views": ["time"]}},
                {"id": "shortcuts", "size": "medium", "settings": {"views": ["materials", "time", "time", "wiki"]}},
            ],
        }
    )
    assert stored is not None
    assert stored.role == "employee"
    assert stored.updated_at == datetime(2026, 10, 21, 18, 40, 12, tzinfo=timezone.utc)
    assert stored.widgets == [
        {"id": "my_tasks", "size": "large"},
        {"id": "my_status", "size": CATALOG_BY_ID["my_status"].default_size},
        {"id": "notifications", "size": "small"},
        {"id": "shortcuts", "size": "medium", "settings": {"views": ["time", "wiki"]}},
    ]


def test_parse_stored_drops_settings_whose_tiles_all_vanished() -> None:
    stored = parse_stored({"version": 1, "widgets": [{"id": "shortcuts", "size": "large", "settings": {"views": ["materials"]}}]})
    assert stored is not None
    assert stored.widgets == [{"id": "shortcuts", "size": "large"}]
    assert stored.role is None
    assert stored.updated_at is None


def test_parse_stored_reads_a_role_default_row() -> None:
    stored = parse_stored('{"version":1,"widgets":[{"id":"my_tasks","size":"small"}]}')
    assert stored is not None
    assert stored.widgets == [{"id": "my_tasks", "size": "small"}]


def test_parse_stored_keeps_an_empty_layout() -> None:
    stored = parse_stored({"version": 1, "widgets": []})
    assert stored is not None and stored.widgets == []


@pytest.mark.parametrize(
    "raw",
    [
        None,
        42,
        "not json",
        "{",
        "[]",
        [],
        {"widgets": []},
        {"version": 2, "widgets": []},
        {"version": "1", "widgets": []},
        {"version": 1, "widgets": "my_tasks"},
        {"version": 1},
    ],
)
def test_parse_stored_treats_garbage_as_absent(raw: object) -> None:
    assert parse_stored(raw) is None


# ── Save merge ────────────────────────────────────────────────────────────────


def test_merge_hidden_puts_hidden_widgets_back_at_their_old_index() -> None:
    effective = [
        {"id": "shortcuts", "size": "large"},
        {"id": "my_status", "size": "small"},
        {"id": "my_tasks", "size": "medium"},
        {"id": "clocked_in", "size": "small"},
    ]
    incoming = [{"id": "my_tasks", "size": "large"}, {"id": "shortcuts", "size": "small"}]
    before = json.dumps([effective, incoming])
    merged = merge_hidden(incoming, effective, available={"shortcuts", "my_tasks"})
    assert merged == [
        {"id": "my_tasks", "size": "large"},
        {"id": "my_status", "size": "small"},
        {"id": "shortcuts", "size": "small"},
        {"id": "clocked_in", "size": "small"},
    ]
    assert json.dumps([effective, incoming]) == before
    assert merged is not incoming


def test_merge_hidden_clamps_to_the_new_length() -> None:
    effective = [{"id": f, "size": "small"} for f in ("my_tasks", "notifications", "recent_reports", "clocked_in")]
    merged = merge_hidden([], effective, available={"my_tasks", "notifications", "recent_reports"})
    assert merged == [{"id": "clocked_in", "size": "small"}]


def test_merge_hidden_never_duplicates_and_never_restores_what_the_user_removed() -> None:
    effective = [
        {"id": "clocked_in", "size": "small"},
        {"id": "my_tasks", "size": "medium"},
        {"id": "weather", "size": "small"},
    ]
    incoming = [{"id": "clocked_in", "size": "large"}]
    merged = merge_hidden(incoming, effective, available={"my_tasks"})
    # clocked_in is hidden but came in → kept once, as sent; my_tasks is
    # visible and was removed → gone; an unknown id is never resurrected.
    assert merged == [{"id": "clocked_in", "size": "large"}]


# ── Built-in defaults ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("role", ALL_ROLES)
@pytest.mark.parametrize("device", ["mobile", "tablet", "desktop"])
def test_every_builtin_default_is_a_valid_layout(role: str, device: str) -> None:
    widgets = builtin_widgets(role, device)
    assert widgets, (role, device)
    assert clean_widgets([DashboardWidgetIn.model_validate(item) for item in widgets]) == widgets


def test_builtin_widgets_returns_a_fresh_copy_and_falls_back_to_employee() -> None:
    first = builtin_widgets("employee", "desktop")
    first[0]["settings"]["views"].append("customers")
    first.append({"id": "clocked_in", "size": "small"})
    assert builtin_widgets("employee", "desktop") != first
    assert builtin_widgets("someone-new", "mobile") == builtin_widgets("employee", "mobile")


def test_the_employee_desktop_default_starts_with_todays_page() -> None:
    ids = [item["id"] for item in builtin_widgets("employee", "desktop")]
    assert ids[:5] == ["shortcuts", "my_status", "recent_reports", "my_projects", "my_tasks"]
    shortcuts = builtin_widgets("employee", "desktop")[0]
    assert shortcuts["settings"]["views"] == ["my_tasks", "planning", "construction", "werkstatt", "messages", "time", "wiki"]
    assert builtin_widgets("employee", "mobile")[1] == {
        "id": "shortcuts",
        "size": "medium",
        "settings": {"views": ["construction", "planning", "messages", "wiki"]},
    }
