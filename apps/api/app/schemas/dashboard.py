"""Request and response models of ``/api/dashboard`` (docs/DASHBOARD.md §11.1).

Input is closed sets only, with ``extra="forbid"`` and bounded lengths, so a
malformed body keeps FastAPI's 422 with a list ``detail``. What the shape
cannot express (catalog ids, duplicates, tiles) is checked by
``services.dashboard_layouts.clean_widgets``, which answers an object detail.
"""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SerializerFunctionWrapHandler, model_serializer

from app.services.dashboard_catalog import CATALOG, MAX_SHORTCUT_VIEWS, DashboardDevice, WidgetGroup, WidgetSize

AbsenceKind = Literal["vacation", "school", "training", "company_event", "holiday", "absent"]
LayoutSource = Literal["user", "role", "builtin"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DashboardWidgetSettings(_Strict):
    views: list[str] = Field(min_length=1, max_length=MAX_SHORTCUT_VIEWS)


class DashboardWidgetIn(_Strict):
    id: str = Field(min_length=1, max_length=64)
    size: WidgetSize
    settings: DashboardWidgetSettings | None = None


class DashboardLayoutIn(_Strict):
    version: Literal[1] = 1
    widgets: list[DashboardWidgetIn] = Field(max_length=len(CATALOG))


class DashboardWidgetOut(_Strict):
    id: str
    size: WidgetSize
    settings: DashboardWidgetSettings | None = None

    # No return annotation on purpose: pydantic would take it as the
    # serialization schema and the OpenAPI document would lose the fields.
    @model_serializer(mode="wrap")
    def _omit_empty_settings(self, handler: SerializerFunctionWrapHandler):
        # Only the shortcuts carry settings; every other item is {id, size},
        # as stored, instead of a `settings: null` on nineteen widgets.
        data = handler(self)
        if data.get("settings") is None:
            data.pop("settings", None)
        return data


class DashboardLayoutOut(_Strict):
    device: DashboardDevice
    version: Literal[1] = 1
    widgets: list[DashboardWidgetOut]
    source: LayoutSource
    updated_at: dt.datetime | None = None
    role_changed: bool = False


class DashboardOut(_Strict):
    layouts: dict[DashboardDevice, DashboardLayoutOut]
    available_widgets: list[str]
    default_sizes: dict[str, WidgetSize]


class AbsenceTodayOut(_Strict):
    user_id: int
    user_name: str
    type: AbsenceKind
    label: str


class AbsentTodayOut(_Strict):
    date: dt.date
    absences: list[AbsenceTodayOut]


class DashboardCatalogEntryOut(_Strict):
    id: str
    group: WidgetGroup
    default_size: WidgetSize
    requires: list[list[str]]


class DashboardRoleDefaultOut(_Strict):
    role: str
    device: DashboardDevice
    widgets: list[DashboardWidgetOut]
    source: Literal["role", "builtin"]
    hidden_for_role: list[str]
    updated_at: dt.datetime | None = None


class DashboardRoleDefaultsOut(_Strict):
    catalog: list[DashboardCatalogEntryOut]
    roles: list[str]
    defaults: list[DashboardRoleDefaultOut]
