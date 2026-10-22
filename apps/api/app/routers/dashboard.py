"""``/api/dashboard`` — the personal start page (docs/DASHBOARD.md §4).

Every route authenticates through ``get_current_user``, so the partner fence
closes them all (tests/test_partner_portal_security.py walks the table).
The server owns widget access: reads come back filtered to what the caller
may see, while writes store any catalog id (D7) — hiding a widget is UX,
the data endpoints behind each widget enforce access themselves.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.deps import get_current_user, require_any_permission, require_permission
from app.core.permissions import ALL_ROLES
from app.models.entities import User
from app.schemas.dashboard import (
    AbsentTodayOut,
    DashboardCatalogEntryOut,
    DashboardLayoutIn,
    DashboardLayoutOut,
    DashboardOut,
    DashboardRoleDefaultOut,
    DashboardRoleDefaultsOut,
    DashboardWidgetOut,
)
from app.services.audit import log_admin_action
from app.services.dashboard_absences import absent_today
from app.services.dashboard_catalog import (
    CATALOG,
    DEVICES,
    DashboardDevice,
    available_ids_for_role,
    available_ids_for_user,
    default_sizes,
)
from app.services.dashboard_layouts import (
    DashboardLayoutError,
    ResolvedLayout,
    clean_widgets,
    clear_role_default,
    clear_user_layout,
    is_dashboard_role,
    list_role_defaults,
    resolve_layout,
    save_role_default,
    save_user_layout,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

# Role defaults are UI configuration, not a grant (D16). Making them
# admin-only is this one string: "permissions:manage".
ROLE_DEFAULTS_PERMISSION = "settings:manage"
AUDIT_TARGET = "dashboard_default"


def _cleaned(payload: DashboardLayoutIn) -> list[dict]:
    try:
        return clean_widgets(payload.widgets)
    except DashboardLayoutError as error:
        raise HTTPException(status_code=422, detail=error.to_detail()) from error


def _widgets_out(widgets: list[dict]) -> list[DashboardWidgetOut]:
    return [DashboardWidgetOut.model_validate(item) for item in widgets]


def _layout_out(resolved: ResolvedLayout) -> DashboardLayoutOut:
    return DashboardLayoutOut(
        device=resolved.device,
        widgets=_widgets_out(resolved.widgets),
        source=resolved.source,
        updated_at=resolved.updated_at,
        role_changed=resolved.role_changed,
    )


def _role_default_out(role: str, resolved: ResolvedLayout) -> DashboardRoleDefaultOut:
    visible = set(available_ids_for_role(role))
    return DashboardRoleDefaultOut(
        role=role,
        device=resolved.device,
        widgets=_widgets_out(resolved.widgets),
        source="role" if resolved.source == "role" else "builtin",
        hidden_for_role=[item["id"] for item in resolved.widgets if item["id"] not in visible],
        updated_at=resolved.updated_at,
    )


def _require_known_role(role: str) -> None:
    # `external` and anything not in ALL_ROLES have no defaults to manage.
    if not is_dashboard_role(role):
        raise HTTPException(status_code=404, detail="Unbekannte Rolle.")


def _audit_role_default(db: Session, actor: User, action: str, role: str, resolved: ResolvedLayout) -> None:
    log_admin_action(
        db,
        actor,
        action,
        AUDIT_TARGET,
        f"{role}:{resolved.device}",
        details={"widgets": [item["id"] for item in resolved.widgets]},
        category="settings",
    )


# ── The caller's own start page ───────────────────────────────────────────────


@router.get("", response_model=DashboardOut)
def get_dashboard(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardOut:
    return DashboardOut(
        layouts={device: _layout_out(resolve_layout(db, current_user, device)) for device in DEVICES},
        available_widgets=available_ids_for_user(current_user),
        default_sizes=default_sizes(),
    )


@router.put("/layouts/{device}", response_model=DashboardLayoutOut)
def put_layout(
    device: DashboardDevice,
    payload: DashboardLayoutIn,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardLayoutOut:
    # A personal UI preference: not audited.
    return _layout_out(save_user_layout(db, current_user, device, _cleaned(payload)))


@router.delete("/layouts/{device}", response_model=DashboardLayoutOut)
def delete_layout(
    device: DashboardDevice,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DashboardLayoutOut:
    # 200 with the resolved layout, not 204: the page renders it at once.
    return _layout_out(clear_user_layout(db, current_user, device))


@router.get("/absent-today", response_model=AbsentTodayOut)
def get_absent_today(
    # Checked before anything is read: the planning helper would otherwise
    # quietly answer with only the caller.
    current_user: User = Depends(require_any_permission("planning:manage", "time:view_all", "time:manage")),
    db: Session = Depends(get_db),
) -> AbsentTodayOut:
    return absent_today(db, current_user)


# ── Role defaults (admin) ─────────────────────────────────────────────────────


@router.get("/role-defaults", response_model=DashboardRoleDefaultsOut)
def get_role_defaults(
    _: User = Depends(require_permission(ROLE_DEFAULTS_PERMISSION)),
    db: Session = Depends(get_db),
) -> DashboardRoleDefaultsOut:
    return DashboardRoleDefaultsOut(
        catalog=[
            DashboardCatalogEntryOut(
                id=spec.id,
                group=spec.group,
                default_size=spec.default_size,
                requires=[list(group) for group in spec.requires],
            )
            for spec in CATALOG
        ],
        roles=list(ALL_ROLES),
        defaults=[_role_default_out(role, resolved) for role, resolved in list_role_defaults(db)],
    )


@router.put("/role-defaults/{role}/{device}", response_model=DashboardRoleDefaultOut)
def put_role_default(
    role: str,
    device: DashboardDevice,
    payload: DashboardLayoutIn,
    current_user: User = Depends(require_permission(ROLE_DEFAULTS_PERMISSION)),
    db: Session = Depends(get_db),
) -> DashboardRoleDefaultOut:
    _require_known_role(role)
    widgets = _cleaned(payload)
    try:
        resolved = save_role_default(db, role, device, widgets)
    except DashboardLayoutError as error:
        raise HTTPException(status_code=422, detail=error.to_detail()) from error
    _audit_role_default(db, current_user, "dashboard.role_default.update", role, resolved)
    return _role_default_out(role, resolved)


@router.delete("/role-defaults/{role}/{device}", response_model=DashboardRoleDefaultOut)
def delete_role_default(
    role: str,
    device: DashboardDevice,
    current_user: User = Depends(require_permission(ROLE_DEFAULTS_PERMISSION)),
    db: Session = Depends(get_db),
) -> DashboardRoleDefaultOut:
    _require_known_role(role)
    resolved = clear_role_default(db, role, device)
    _audit_role_default(db, current_user, "dashboard.role_default.reset", role, resolved)
    return _role_default_out(role, resolved)
