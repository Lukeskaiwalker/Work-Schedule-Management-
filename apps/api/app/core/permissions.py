from __future__ import annotations
ROLE_ADMIN = "admin"
ROLE_CEO = "ceo"
ROLE_ACCOUNTANT = "accountant"
ROLE_PLANNING = "planning"
ROLE_EMPLOYEE = "employee"

ALL_ROLES = [ROLE_ADMIN, ROLE_CEO, ROLE_ACCOUNTANT, ROLE_PLANNING, ROLE_EMPLOYEE]

PERMISSIONS_BY_ROLE: dict[str, set[str]] = {
    ROLE_ADMIN: {
        "users:manage",
        "projects:manage",
        "projects:view",
        "tasks:manage",
        "tasks:view_all",
        "planning:manage",
        "tickets:manage",
        "time:manage",
        "time:view_all",
        "files:manage",
        "chat:manage",
        "reports:manage",
        "wiki:manage",
        "wiki:view",
        "audit:view",
    },
    ROLE_CEO: {
        "projects:manage",
        "projects:view",
        "tasks:manage",
        "tasks:view_all",
        "tickets:manage",
        "time:view_all",
        "files:manage",
        "chat:manage",
        "reports:manage",
        "wiki:manage",
        "wiki:view",
    },
    ROLE_ACCOUNTANT: {
        "projects:view",
        "tasks:view_all",
        "time:view_all",
        "files:view",
        "chat:project",
        "reports:view",
        "wiki:view",
    },
    ROLE_PLANNING: {
        "projects:view",
        "tasks:manage",
        "tasks:view_all",
        "planning:manage",
        "tickets:manage",
        "files:view",
        "chat:manage",
        "reports:manage",
        "wiki:manage",
        "wiki:view",
    },
    ROLE_EMPLOYEE: {
        "projects:view",
        "tasks:view_own",
        "time:clock",
        "time:view_own",
        "files:view_project",
        "chat:project",
        "reports:create",
        "wiki:view",
    },
}

TEMPLATES: dict[str, dict[str, set[str]]] = {
    "default": PERMISSIONS_BY_ROLE,
}


def has_permission(role: str, permission: str) -> bool:
    role_permissions = PERMISSIONS_BY_ROLE.get(role, set())
    return permission in role_permissions
