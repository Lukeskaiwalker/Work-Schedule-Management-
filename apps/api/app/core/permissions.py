from __future__ import annotations

import threading

ROLE_ADMIN = "admin"
ROLE_CEO = "ceo"
ROLE_ACCOUNTANT = "accountant"
ROLE_PLANNING = "planning"
ROLE_EMPLOYEE = "employee"

ALL_ROLES = [ROLE_ADMIN, ROLE_CEO, ROLE_ACCOUNTANT, ROLE_PLANNING, ROLE_EMPLOYEE]

# Every permission string that the system recognises.  Used for input validation.
ALL_PERMISSIONS: frozenset[str] = frozenset(
    [
        "users:manage",
        "projects:manage",
        "projects:view",
        "tasks:manage",
        "tasks:view_all",
        "tasks:view_own",
        "planning:manage",
        "tickets:manage",
        "time:manage",
        "time:view_all",
        "time:clock",
        "time:view_own",
        "files:manage",
        "files:view",
        "files:view_project",
        "chat:manage",
        "chat:project",
        "reports:manage",
        "reports:view",
        "reports:create",
        "wiki:manage",
        "wiki:view",
        "audit:view",
    ]
)

# Human-readable labels used by the admin UI.  Keys are permission strings.
PERMISSION_LABELS: dict[str, str] = {
    "users:manage": "Manage users",
    "projects:manage": "Manage projects",
    "projects:view": "View projects",
    "tasks:manage": "Manage tasks",
    "tasks:view_all": "View all tasks",
    "tasks:view_own": "View own tasks",
    "planning:manage": "Manage planning",
    "tickets:manage": "Manage tickets",
    "time:manage": "Manage time tracking",
    "time:view_all": "View all time entries",
    "time:clock": "Clock in / out",
    "time:view_own": "View own time entries",
    "files:manage": "Manage files",
    "files:view": "View all files",
    "files:view_project": "View project files",
    "chat:manage": "Manage chat threads",
    "chat:project": "Project chat access",
    "reports:manage": "Manage reports",
    "reports:view": "View reports",
    "reports:create": "Create reports",
    "wiki:manage": "Manage wiki",
    "wiki:view": "View wiki",
    "audit:view": "View audit log",
}

# Logical groups of permissions for the admin UI matrix.
PERMISSION_GROUPS: list[dict] = [
    {"key": "users",    "label": "Users",    "permissions": ["users:manage"]},
    {"key": "projects", "label": "Projects", "permissions": ["projects:manage", "projects:view"]},
    {"key": "tasks",    "label": "Tasks",    "permissions": ["tasks:manage", "tasks:view_all", "tasks:view_own"]},
    {"key": "planning", "label": "Planning", "permissions": ["planning:manage"]},
    {"key": "tickets",  "label": "Tickets",  "permissions": ["tickets:manage"]},
    {"key": "time",     "label": "Time",     "permissions": ["time:manage", "time:view_all", "time:clock", "time:view_own"]},
    {"key": "files",    "label": "Files",    "permissions": ["files:manage", "files:view", "files:view_project"]},
    {"key": "chat",     "label": "Chat",     "permissions": ["chat:manage", "chat:project"]},
    {"key": "reports",  "label": "Reports",  "permissions": ["reports:manage", "reports:view", "reports:create"]},
    {"key": "wiki",     "label": "Wiki",     "permissions": ["wiki:manage", "wiki:view"]},
    {"key": "audit",    "label": "Audit",    "permissions": ["audit:view"]},
]

# Default permission map — the hard-coded baseline.  Never mutated at runtime.
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

# ── Runtime override ──────────────────────────────────────────────────────────
# Replaced atomically by set_permissions_override() whenever the admin saves
# custom permissions to the database.  None means "use PERMISSIONS_BY_ROLE".
_override_map: dict[str, set[str]] | None = None
_override_lock = threading.Lock()


def set_permissions_override(override: dict[str, list[str]] | None) -> None:
    """Replace the in-process permission map.  Thread-safe.
    Pass None to revert to the hard-coded defaults."""
    global _override_map
    with _override_lock:
        if override is None:
            _override_map = None
        else:
            _override_map = {
                role: set(perms)
                for role, perms in override.items()
                if role in ALL_ROLES
            }


def has_permission(role: str, permission: str) -> bool:
    with _override_lock:
        effective = _override_map if _override_map is not None else PERMISSIONS_BY_ROLE
    return permission in effective.get(role, set())


def get_effective_permissions() -> dict[str, list[str]]:
    """Return the current effective permission map as role → sorted list."""
    with _override_lock:
        effective = _override_map if _override_map is not None else PERMISSIONS_BY_ROLE
    return {role: sorted(effective.get(role, set())) for role in ALL_ROLES}
