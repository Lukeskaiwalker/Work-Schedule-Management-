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
        "time:approve_vacation",
        "time:manage_absences",
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
        "finance:view",
        "finance:manage",
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
    "time:approve_vacation": "Approve vacation requests",
    "time:manage_absences": "Manage absences / school dates",
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
    "finance:view": "View project finances",
    "finance:manage": "Edit project finances",
}

PERMISSION_DESCRIPTIONS: dict[str, str] = {
    "users:manage":        "Create, edit, deactivate users and change their roles.",
    "projects:manage":     "Create, edit, archive and delete projects; manage members and settings.",
    "projects:view":       "Browse the project list and open project detail pages.",
    "tasks:manage":        "Create, edit, reassign and delete tasks across all projects.",
    "tasks:view_all":      "See every task in the system regardless of assignment.",
    "tasks:view_own":      "See only tasks that are assigned to the current user.",
    "planning:manage":     "Access and edit the planning board and resource schedule.",
    "tickets:manage":      "Create, triage, assign and close support tickets.",
    "time:manage":         "Edit or delete any user's time entries and manage time settings.",
    "time:view_all":       "View time entries for all users across the organisation.",
    "time:clock":          "Clock in and out; log personal time entries.",
    "time:view_own":       "View only the current user's own time entries.",
    "time:approve_vacation": "Review, approve or reject employee vacation requests.",
    "time:manage_absences":  "Create, edit and delete absence records (sick leave, school, etc.).",
    "files:manage":        "Upload, rename, move and delete files across all projects.",
    "files:view":          "View and download files in all projects.",
    "files:view_project":  "View and download files only in projects the user is a member of.",
    "chat:manage":         "Create and delete chat threads; moderate messages from any user.",
    "chat:project":        "Post and read messages in project-linked chat threads.",
    "reports:manage":      "Review, approve and delete construction reports from all users.",
    "reports:view":        "View submitted construction reports from all users.",
    "reports:create":      "Submit new construction daily reports.",
    "wiki:manage":         "Create, edit and delete wiki pages.",
    "wiki:view":           "Read wiki pages.",
    "audit:view":          "Browse the admin audit log of all system actions.",
    "finance:view":        "View the finances tab on projects (order values, budgets, margins).",
    "finance:manage":      "Edit financial data on projects (order values, down payments, costs).",
}

# Logical groups of permissions for the admin UI matrix.
PERMISSION_GROUPS: list[dict] = [
    {"key": "users",    "label": "Users",    "permissions": ["users:manage"]},
    {"key": "projects", "label": "Projects", "permissions": ["projects:manage", "projects:view"]},
    {"key": "tasks",    "label": "Tasks",    "permissions": ["tasks:manage", "tasks:view_all", "tasks:view_own"]},
    {"key": "planning", "label": "Planning", "permissions": ["planning:manage"]},
    {"key": "tickets",  "label": "Tickets",  "permissions": ["tickets:manage"]},
    {"key": "time",     "label": "Time",     "permissions": ["time:manage", "time:view_all", "time:clock", "time:view_own", "time:approve_vacation", "time:manage_absences"]},
    {"key": "files",    "label": "Files",    "permissions": ["files:manage", "files:view", "files:view_project"]},
    {"key": "chat",     "label": "Chat",     "permissions": ["chat:manage", "chat:project"]},
    {"key": "reports",  "label": "Reports",  "permissions": ["reports:manage", "reports:view", "reports:create"]},
    {"key": "wiki",     "label": "Wiki",     "permissions": ["wiki:manage", "wiki:view"]},
    {"key": "audit",    "label": "Audit",    "permissions": ["audit:view"]},
    {"key": "finance",  "label": "Finance",  "permissions": ["finance:view", "finance:manage"]},
]

# Default permission map — the hard-coded baseline.  Never mutated at runtime.
PERMISSIONS_BY_ROLE: dict[str, set[str]] = {
    ROLE_ADMIN: {
        # Admin has every permission in the system
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
        "time:approve_vacation",
        "time:manage_absences",
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
        "finance:view",
        "finance:manage",
    },
    ROLE_CEO: {
        "projects:manage",
        "projects:view",
        "tasks:manage",
        "tasks:view_all",
        "tickets:manage",
        "time:view_all",
        "time:approve_vacation",
        "time:manage_absences",
        "files:manage",
        "chat:manage",
        "reports:manage",
        "wiki:manage",
        "wiki:view",
        "finance:view",
        "finance:manage",
    },
    ROLE_ACCOUNTANT: {
        "projects:view",
        "tasks:view_all",
        "time:view_all",
        "time:manage_absences",
        "files:view",
        "chat:project",
        "reports:view",
        "wiki:view",
        "finance:view",
        "finance:manage",
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

# ── Role-level runtime override ───────────────────────────────────────────────
# Replaced atomically by set_permissions_override() whenever the admin saves
# custom permissions to the database.  None means "use PERMISSIONS_BY_ROLE".
_override_map: dict[str, set[str]] | None = None
_override_lock = threading.Lock()

# ── User-level permission overrides ──────────────────────────────────────────
# Format: {user_id: {"extra": set[str], "denied": set[str]}}
# "extra"  → granted regardless of role
# "denied" → blocked regardless of role (takes precedence over extra)
_user_override_map: dict[int, dict[str, set[str]]] = {}
_user_override_lock = threading.Lock()


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


# ── User-level override helpers ───────────────────────────────────────────────

def set_user_permissions_override(
    overrides: dict[int, dict[str, list[str]]],
) -> None:
    """Replace the full user-level permission override map.  Thread-safe."""
    global _user_override_map
    with _user_override_lock:
        _user_override_map = {
            int(uid): {
                "extra": set(data.get("extra", [])),
                "denied": set(data.get("denied", [])),
            }
            for uid, data in overrides.items()
        }


def has_permission_for_user(user_id: int, role: str, permission: str) -> bool:
    """Check permission for a specific user, applying any user-level overrides.

    Resolution order (most restrictive wins):
      1. User-level deny  → False
      2. User-level grant → True
      3. Role-level check → has_permission(role, permission)
    """
    with _user_override_lock:
        override = _user_override_map.get(user_id)
    if override:
        if permission in override.get("denied", set()):
            return False
        if permission in override.get("extra", set()):
            return True
    return has_permission(role, permission)


def get_user_override(user_id: int) -> dict[str, list[str]]:
    """Return the stored extra/denied lists for one user (empty if none)."""
    with _user_override_lock:
        data = _user_override_map.get(user_id, {})
    return {
        "extra": sorted(data.get("extra", set())),
        "denied": sorted(data.get("denied", set())),
    }


def get_user_effective_permissions(user_id: int, role: str) -> list[str]:
    """Return the sorted list of all effective permissions for a user.

    Applies role-level permissions first, then user-level extra/denied overrides.
    """
    with _override_lock:
        effective = _override_map if _override_map is not None else PERMISSIONS_BY_ROLE
    role_perms = set(effective.get(role, set()))

    with _user_override_lock:
        override = _user_override_map.get(user_id, {})

    extra = override.get("extra", set())
    denied = override.get("denied", set())
    return sorted((role_perms | extra) - denied)


def get_all_user_overrides() -> dict[int, dict[str, list[str]]]:
    """Return all user-level overrides as {user_id: {extra, denied}}."""
    with _user_override_lock:
        return {
            uid: {
                "extra": sorted(data.get("extra", set())),
                "denied": sorted(data.get("denied", set())),
            }
            for uid, data in _user_override_map.items()
        }
