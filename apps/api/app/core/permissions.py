from __future__ import annotations

import threading
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field, replace

ROLE_ADMIN = "admin"
ROLE_CEO = "ceo"
ROLE_ACCOUNTANT = "accountant"
ROLE_PLANNING = "planning"
ROLE_EMPLOYEE = "employee"

ALL_ROLES = [ROLE_ADMIN, ROLE_CEO, ROLE_ACCOUNTANT, ROLE_PLANNING, ROLE_EMPLOYEE]

# A login for a subcontractor's person (roofer, plumber, groundworks), bound to
# a Partner. Deliberately NOT in ALL_ROLES: nothing that lists, assigns or
# edits roles — the permission matrix, the user form, chat role groups — may
# ever offer it, and no permission map or per-user override applies to it.
# Such a login reaches the partner portal (/api/portal) and nothing else; the
# fence is enforced in app.core.deps.get_current_user, not by permissions.
ROLE_EXTERNAL = "external"


def is_external_role(role: str | None) -> bool:
    return (role or "").strip().lower() == ROLE_EXTERNAL

# Every permission string that the system recognises.  Used for input validation.
ALL_PERMISSIONS: frozenset[str] = frozenset(
    [
        "users:manage",
        "projects:manage",
        "projects:view",
        "projects:import",
        "projects:mark_critical",
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
        "files:view_protected",
        "chat:manage",
        "chat:project",
        "reports:manage",
        "reports:view",
        "reports:create",
        "wiki:manage",
        "wiki:view",
        "permissions:manage",
        "audit:view",
        "settings:manage",
        "system:manage",
        "backups:export",
        "backups:restore",
        "backups:manage",
        "finance:view",
        "finance:manage",
        "werkstatt:manage",
        # Granular machine-register grants. `werkstatt:manage` remains the
        # umbrella and still implies both, so adding these takes nothing away
        # from anyone who already had it — see require_any_permission.
        "werkstatt:machines_create",
        "werkstatt:machines_edit",
        # Ausbildung: review + countersign apprentice weekly reports.
        "training:manage",
    ]
)

# Human-readable labels used by the admin UI.  Keys are permission strings.
#
# German is the product's language: the plain maps are what the Rollen matrix
# shows. The *_EN twins are for the SPA's English mode only — the admin UI
# picks one by its language and never shows a bare permission string.
PERMISSION_LABELS: dict[str, str] = {
    "users:manage": "Benutzer verwalten",
    "projects:manage": "Projekte verwalten",
    "projects:view": "Projekte ansehen",
    "projects:import": "Projekte und Klassenvorlagen importieren",
    "projects:mark_critical": "Projekte als kritisch markieren",
    "tasks:manage": "Aufgaben verwalten",
    "tasks:view_all": "Alle Aufgaben ansehen",
    "tasks:view_own": "Eigene Aufgaben ansehen",
    "planning:manage": "Planung verwalten",
    "tickets:manage": "Tickets verwalten",
    "time:manage": "Zeiterfassung verwalten",
    "time:view_all": "Alle Zeiteinträge ansehen",
    "time:clock": "Ein- und ausstempeln",
    "time:view_own": "Eigene Zeiteinträge ansehen",
    "time:approve_vacation": "Urlaubsanträge genehmigen",
    "time:manage_absences": "Abwesenheiten / Berufsschule verwalten",
    "files:manage": "Dateien verwalten",
    "files:view": "Alle Dateien ansehen",
    "files:view_project": "Projektdateien ansehen",
    "files:view_protected": "Geschützte Projektordner öffnen",
    "chat:manage": "Chat-Threads verwalten",
    "chat:project": "Projekt-Chat nutzen",
    "reports:manage": "Berichte verwalten",
    "reports:view": "Berichte ansehen",
    "reports:create": "Berichte erstellen",
    "wiki:manage": "Wiki verwalten",
    "wiki:view": "Wiki lesen",
    "permissions:manage": "Berechtigungen verwalten",
    "audit:view": "Protokoll ansehen",
    "settings:manage": "Einstellungen verwalten",
    "system:manage": "Systemupdates verwalten",
    "backups:export": "Verschlüsselte Backups exportieren",
    "backups:restore": "Aus verschlüsseltem Backup wiederherstellen",
    "backups:manage": "Verschlüsselte Backups auflisten und löschen",
    "finance:view": "Projektfinanzen ansehen",
    "finance:manage": "Projektfinanzen bearbeiten",
    "werkstatt:manage": "Werkstatt verwalten (Lagerbestand)",
    "werkstatt:machines_create": "Neue Maschinen erfassen",
    "werkstatt:machines_edit": "Maschinenstammdaten bearbeiten",
    "training:manage": "Ausbildungsnachweise prüfen",
}

PERMISSION_DESCRIPTIONS: dict[str, str] = {
    "users:manage":        "Benutzer anlegen, bearbeiten, deaktivieren und ihre Rolle ändern.",
    "projects:manage":     "Projekte anlegen, bearbeiten, archivieren und löschen; Mitglieder und Einstellungen pflegen.",
    "projects:view":       "Die Projektliste durchsuchen und Projektseiten öffnen.",
    "projects:import":     "Projekte und Projektklassen-Vorlagen im Verwaltungszentrum aus CSV importieren.",
    "projects:mark_critical": "Projekte als kritisch kennzeichnen oder die Markierung entfernen.",
    "tasks:manage":        "Aufgaben in allen Projekten anlegen, bearbeiten, neu zuweisen und löschen.",
    "tasks:view_all":      "Jede Aufgabe im System sehen, unabhängig von der Zuweisung.",
    "tasks:view_own":      "Nur die Aufgaben sehen, die dem eigenen Benutzer zugewiesen sind.",
    "planning:manage":     "Wochenplanung und Ressourcenplanung öffnen und bearbeiten.",
    "tickets:manage":      "Tickets anlegen, sichten, zuweisen und schließen.",
    "time:manage":         "Zeiteinträge aller Benutzer bearbeiten oder löschen und die Zeiterfassung einstellen.",
    "time:view_all":       "Zeiteinträge aller Benutzer im Unternehmen ansehen.",
    "time:clock":          "Ein- und ausstempeln; eigene Zeiteinträge erfassen.",
    "time:view_own":       "Nur die eigenen Zeiteinträge ansehen.",
    "time:approve_vacation": "Urlaubsanträge von Mitarbeitern prüfen, genehmigen oder ablehnen.",
    "time:manage_absences":  "Abwesenheiten (Krankheit, Berufsschule usw.) anlegen, bearbeiten und löschen.",
    "files:manage":        "Dateien in allen Projekten hochladen, umbenennen, verschieben und löschen.",
    "files:view":          "Dateien in allen Projekten ansehen und herunterladen.",
    "files:view_project":  "Dateien nur in Projekten ansehen und herunterladen, in denen der Benutzer Mitglied ist.",
    "files:view_protected": "Dateien in geschützten Projektordnern wie „Verwaltung“ öffnen und hochladen.",
    "chat:manage":         "Chat-Threads anlegen und löschen; Nachrichten aller Benutzer moderieren.",
    "chat:project":        "Nachrichten in projektbezogenen Chat-Threads lesen und schreiben.",
    "reports:manage":      "Baustellenberichte aller Benutzer prüfen, freigeben und löschen.",
    "reports:view":        "Eingereichte Baustellenberichte aller Benutzer ansehen.",
    "reports:create":      "Neue Baustellenberichte (Tagesberichte) einreichen.",
    "wiki:manage":         "Wiki-Seiten anlegen, bearbeiten und löschen.",
    "wiki:view":           "Wiki-Seiten lesen.",
    "permissions:manage":  "Rollenberechtigungen und individuelle Berechtigungen einzelner Benutzer im Verwaltungszentrum bearbeiten.",
    "audit:view":          "Das Protokoll aller Systemaktionen im Verwaltungszentrum durchsuchen.",
    "settings:manage":     "Anwendungseinstellungen wie die Zugangsdaten des Wetterdienstes verwalten.",
    "system:manage":       "Den Update-Status ansehen und Systemupdates ausführen.",
    "backups:export":      "Verschlüsselte Datenbank-Backups exportieren.",
    "backups:restore":     "Die Anwendung aus einer verschlüsselten Backup-Datei wiederherstellen. Destruktiv — ersetzt die aktuelle Datenbank und alle hochgeladenen Dateien.",
    "backups:manage":      "Backup-Dateien auf dem Server auflisten und löschen; ein extern gespeichertes Backup wieder ins System hochladen.",
    "finance:view":        "Den Finanzen-Tab in Projekten sehen (Auftragswerte, Budgets, Margen).",
    "finance:manage":      "Finanzdaten in Projekten bearbeiten (Auftragswerte, Anzahlungen, Kosten).",
    "werkstatt:manage":    "Werkstatt-Artikel, Lieferanten, Kategorien und Lagerorte anlegen, bearbeiten und archivieren sowie Datanorm-Kataloge importieren. Schließt beide Maschinen-Berechtigungen unten ein.",
    "werkstatt:machines_create": "Neue Maschinen im Maschinenregister erfassen und ihnen Komponenten hinzufügen. Erlaubt NICHT, bestehende Maschinen zu bearbeiten.",
    "werkstatt:machines_edit":   "Seriennummer, Standort, Status, Notizen und Prüfintervall einer bestehenden Maschine bearbeiten und sie archivieren. Erlaubt NICHT, neue Maschinen zu erfassen.",
    "training:manage":  "Die Ausbildungsnachweise (Wochenberichte) aller Auszubildenden sehen und als Ausbilder gegenzeichnen. Auszubildende schreiben ihre eigenen Nachweise ohne Berechtigung — diese Berechtigung ist nur für die Seite des Ausbilders.",
}

PERMISSION_LABELS_EN: dict[str, str] = {
    "users:manage": "Manage users",
    "projects:manage": "Manage projects",
    "projects:view": "View projects",
    "projects:import": "Import projects and class templates",
    "projects:mark_critical": "Mark projects as critical",
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
    "files:view_protected": "Access protected project folders",
    "chat:manage": "Manage chat threads",
    "chat:project": "Project chat access",
    "reports:manage": "Manage reports",
    "reports:view": "View reports",
    "reports:create": "Create reports",
    "wiki:manage": "Manage wiki",
    "wiki:view": "View wiki",
    "permissions:manage": "Manage permissions",
    "audit:view": "View audit log",
    "settings:manage": "Manage settings",
    "system:manage": "Manage system updates",
    "backups:export": "Export encrypted backups",
    "backups:restore": "Restore from encrypted backups",
    "backups:manage": "List and delete encrypted backups",
    "finance:view": "View project finances",
    "finance:manage": "Edit project finances",
    "werkstatt:manage": "Manage Werkstatt (workshop inventory)",
    "werkstatt:machines_create": "Register new machines",
    "werkstatt:machines_edit": "Edit machine master data",
    "training:manage": "Review apprentice training reports",
}

PERMISSION_DESCRIPTIONS_EN: dict[str, str] = {
    "users:manage":        "Create, edit, deactivate users and change their roles.",
    "projects:manage":     "Create, edit, archive and delete projects; manage members and settings.",
    "projects:view":       "Browse the project list and open project detail pages.",
    "projects:import":     "Import projects and project class templates from CSV in the admin center.",
    "projects:mark_critical": "Flag projects as critical / clear the critical flag.",
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
    "files:view_protected": "Open and upload files in protected project folders such as Verwaltung.",
    "chat:manage":         "Create and delete chat threads; moderate messages from any user.",
    "chat:project":        "Post and read messages in project-linked chat threads.",
    "reports:manage":      "Review, approve and delete construction reports from all users.",
    "reports:view":        "View submitted construction reports from all users.",
    "reports:create":      "Submit new construction daily reports.",
    "wiki:manage":         "Create, edit and delete wiki pages.",
    "wiki:view":           "Read wiki pages.",
    "permissions:manage":  "Edit role permissions and per-user permission overrides in the admin center.",
    "audit:view":          "Browse the admin audit log of all system actions.",
    "settings:manage":     "Manage application settings such as weather provider credentials.",
    "system:manage":       "View update status and run system updates.",
    "backups:export":      "Export encrypted database backups.",
    "backups:restore":     "Restore the application from an encrypted backup file. Destructive — replaces the current database and uploads.",
    "backups:manage":      "List and delete backup files on disk; upload an externally-stored backup back into the system.",
    "finance:view":        "View the finances tab on projects (order values, budgets, margins).",
    "finance:manage":      "Edit financial data on projects (order values, down payments, costs).",
    "werkstatt:manage":    "Create, edit and archive Werkstatt articles, suppliers, categories, locations and import Datanorm catalogs. Also implies both machine permissions below.",
    "werkstatt:machines_create": "Register new machines in the machine register and add components to them. Does NOT allow editing existing machines.",
    "werkstatt:machines_edit":   "Edit an existing machine's serial number, location, status, notes and inspection cycle, and archive it. Does NOT allow registering new machines.",
    "training:manage":  "See every apprentice's Ausbildungsnachweise (weekly training reports) and countersign them as the Ausbilder. Apprentices write their own reports without any permission — this grant is for the trainer side only.",
}

# Logical groups of permissions for the admin UI matrix. ``label`` is German,
# ``label_en`` the English twin (see PERMISSION_LABELS above).
PERMISSION_GROUPS: list[dict] = [
    {"key": "users",    "label": "Benutzer",       "label_en": "Users",       "permissions": ["users:manage"]},
    {"key": "permissions", "label": "Berechtigungen", "label_en": "Permissions", "permissions": ["permissions:manage"]},
    {"key": "projects", "label": "Projekte",       "label_en": "Projects",    "permissions": ["projects:manage", "projects:view", "projects:import", "projects:mark_critical"]},
    {"key": "tasks",    "label": "Aufgaben",       "label_en": "Tasks",       "permissions": ["tasks:manage", "tasks:view_all", "tasks:view_own"]},
    {"key": "planning", "label": "Planung",        "label_en": "Planning",    "permissions": ["planning:manage"]},
    {"key": "tickets",  "label": "Tickets",        "label_en": "Tickets",     "permissions": ["tickets:manage"]},
    {"key": "time",     "label": "Zeiterfassung",  "label_en": "Time",        "permissions": ["time:manage", "time:view_all", "time:clock", "time:view_own", "time:approve_vacation", "time:manage_absences"]},
    {"key": "files",    "label": "Dateien",        "label_en": "Files",       "permissions": ["files:manage", "files:view", "files:view_project", "files:view_protected"]},
    {"key": "chat",     "label": "Chat",           "label_en": "Chat",        "permissions": ["chat:manage", "chat:project"]},
    {"key": "reports",  "label": "Berichte",       "label_en": "Reports",     "permissions": ["reports:manage", "reports:view", "reports:create"]},
    {"key": "wiki",     "label": "Wiki",           "label_en": "Wiki",        "permissions": ["wiki:manage", "wiki:view"]},
    {"key": "audit",    "label": "Protokoll",      "label_en": "Audit",       "permissions": ["audit:view"]},
    {"key": "settings", "label": "Einstellungen",  "label_en": "Settings",    "permissions": ["settings:manage"]},
    {"key": "system",   "label": "System",         "label_en": "System",      "permissions": ["system:manage", "backups:export", "backups:restore", "backups:manage"]},
    {"key": "finance",  "label": "Finanzen",       "label_en": "Finance",     "permissions": ["finance:view", "finance:manage"]},
    {"key": "werkstatt","label": "Werkstatt",      "label_en": "Werkstatt",   "permissions": ["werkstatt:manage", "werkstatt:machines_create", "werkstatt:machines_edit"]},
    {"key": "training", "label": "Ausbildung",     "label_en": "Training",    "permissions": ["training:manage"]},
]

# Default permission map — the hard-coded baseline.  Never mutated at runtime.
PERMISSIONS_BY_ROLE: dict[str, set[str]] = {
    ROLE_ADMIN: {
        # Admin has every permission in the system
        "users:manage",
        "projects:manage",
        "projects:view",
        "projects:import",
        "projects:mark_critical",
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
        "files:view_protected",
        "chat:manage",
        "chat:project",
        "reports:manage",
        "reports:view",
        "reports:create",
        "wiki:manage",
        "wiki:view",
        "permissions:manage",
        "audit:view",
        "settings:manage",
        "system:manage",
        "backups:export",
        "backups:restore",
        "backups:manage",
        "finance:view",
        "finance:manage",
        "werkstatt:manage",
        "werkstatt:machines_create",
        "werkstatt:machines_edit",
        "training:manage",
    },
    ROLE_CEO: {
        "projects:manage",
        "projects:view",
        "projects:import",
        "projects:mark_critical",
        "tasks:manage",
        "tasks:view_all",
        "tickets:manage",
        "time:manage",
        "time:view_all",
        "time:approve_vacation",
        "time:manage_absences",
        "files:manage",
        "files:view_protected",
        "chat:manage",
        "reports:manage",
        "wiki:manage",
        "wiki:view",
        "settings:manage",
        "system:manage",
        "finance:view",
        "finance:manage",
    },
    ROLE_ACCOUNTANT: {
        "projects:view",
        "projects:mark_critical",
        "tasks:view_all",
        "time:view_all",
        "time:manage_absences",
        "files:view",
        "files:view_protected",
        "chat:project",
        "reports:view",
        "wiki:view",
        "finance:view",
        "finance:manage",
    },
    ROLE_PLANNING: {
        "projects:view",
        "projects:mark_critical",
        "tasks:manage",
        "tasks:view_all",
        "planning:manage",
        "tickets:manage",
        "files:view",
        "files:view_protected",
        "chat:manage",
        "reports:manage",
        "wiki:manage",
        "wiki:view",
    },
    ROLE_EMPLOYEE: {
        "projects:view",
        "projects:mark_critical",
        "tasks:view_own",
        "time:clock",
        "time:view_own",
        "files:view_project",
        "chat:project",
        "reports:create",
        "wiki:view",
        "finance:view",
    },
}

TEMPLATES: dict[str, dict[str, set[str]]] = {
    "default": PERMISSIONS_BY_ROLE,
}

# ── Runtime overrides: this process's copy ────────────────────────────────────
# Role- and user-level overrides are stored in the database
# (app.services.permission_store). Every process -- each uvicorn worker, the
# api_worker -- keeps its own copy here: ONE immutable snapshot, replaced
# whole, tagged with the stored revision it was read at. The auth resolvers
# call permission_store.refresh_permissions_if_changed(db) on every request,
# which compares that tag with the database and reloads on any difference, so
# a deny saved by another process is enforced from this process's next
# request on. Readers take `_snapshot` once per check, so a check never mixes
# one reload's role map with another's user overrides.


@dataclass(frozen=True)
class PermissionSnapshot:
    # The stored revision this copy was read at. None: not read from the
    # database (a fresh process, or a copy set by hand), so the next freshness
    # check reloads whatever the database holds.
    revision: str | None = None
    # role → permissions. None means "use PERMISSIONS_BY_ROLE".
    roles: Mapping[str, frozenset[str]] | None = None
    # user id → {"extra": …, "denied": …}
    # "extra"  → granted regardless of role
    # "denied" → blocked regardless of role (takes precedence over extra)
    users: Mapping[int, Mapping[str, frozenset[str]]] = field(default_factory=dict)


_snapshot = PermissionSnapshot()
_snapshot_lock = threading.Lock()  # serialises replacements; readers need none


def make_permission_snapshot(
    revision: str | None,
    roles: Mapping[str, Iterable[str]] | None,
    users: Mapping[int, Mapping[str, Iterable[str]]],
) -> PermissionSnapshot:
    return PermissionSnapshot(
        revision=revision,
        roles=None if roles is None else {
            role: frozenset(perms) for role, perms in roles.items() if role in ALL_ROLES
        },
        users={
            int(uid): {
                "extra": frozenset(data.get("extra", [])),
                "denied": frozenset(data.get("denied", [])),
            }
            for uid, data in users.items()
        },
    )


def permission_snapshot() -> PermissionSnapshot:
    """This process's current copy (immutable)."""
    return _snapshot


def install_permission_snapshot(snapshot: PermissionSnapshot) -> None:
    """Replace this process's copy. Only permission_store's reload installs
    what it read from the database; tests use it to stand in for a process
    that still holds an older copy."""
    global _snapshot
    with _snapshot_lock:
        _snapshot = snapshot


def clear_permission_cache() -> None:
    """Forget every override; the next freshness check reloads from the DB."""
    install_permission_snapshot(PermissionSnapshot())


def _effective_role_permissions_map(snapshot: PermissionSnapshot) -> dict[str, set[str]]:
    effective = snapshot.roles if snapshot.roles is not None else PERMISSIONS_BY_ROLE
    return {
        # Admin always keeps the full built-in permission set, even if older
        # stored role overrides predate newer permissions.
        role: set(PERMISSIONS_BY_ROLE[ROLE_ADMIN]) if role == ROLE_ADMIN
        else set(effective.get(role, PERMISSIONS_BY_ROLE.get(role, set())))
        for role in ALL_ROLES
    }


def set_permissions_override(override: dict[str, list[str]] | None) -> None:
    """Replace the role overrides in this process's copy by hand. Thread-safe.
    Pass None to revert to the hard-coded defaults.

    The copy then matches no stored revision, so the next request's freshness
    check replaces it with what the database holds: persist through
    app.services.permission_store instead."""
    global _snapshot
    with _snapshot_lock:
        _snapshot = replace(
            _snapshot,
            revision=None,
            roles=make_permission_snapshot(None, override, {}).roles,
        )


def has_permission(role: str, permission: str) -> bool:
    return _role_has_permission(_snapshot, role, permission)


def _role_has_permission(snapshot: PermissionSnapshot, role: str, permission: str) -> bool:
    if is_external_role(role):
        return False
    return permission in _effective_role_permissions_map(snapshot).get(role, set())


def get_effective_permissions() -> dict[str, list[str]]:
    """Return the current effective permission map as role → sorted list."""
    effective = _effective_role_permissions_map(_snapshot)
    return {role: sorted(effective.get(role, set())) for role in ALL_ROLES}


# ── User-level override helpers ───────────────────────────────────────────────

def set_user_permissions_override(
    overrides: dict[int, dict[str, list[str]]],
) -> None:
    """Replace the user-level overrides in this process's copy by hand.
    Thread-safe. Like set_permissions_override, the next request's freshness
    check replaces it with what the database holds."""
    global _snapshot
    with _snapshot_lock:
        _snapshot = replace(
            _snapshot,
            revision=None,
            users=make_permission_snapshot(None, None, overrides).users,
        )


def has_permission_for_user(user_id: int, role: str, permission: str) -> bool:
    """Check permission for a specific user, applying any user-level overrides.

    Resolution order (most restrictive wins):
      1. User-level deny  → False
      2. User-level grant → True
      3. Role-level check → has_permission(role, permission)

    A partner login holds nothing, whatever an override says: an admin
    granting it ``projects:view`` by hand would otherwise open every project
    in the company to a subcontractor.
    """
    if is_external_role(role):
        return False
    snapshot = _snapshot
    override = snapshot.users.get(user_id)
    if override:
        if permission in override.get("denied", frozenset()):
            return False
        if permission in override.get("extra", frozenset()):
            return True
    return _role_has_permission(snapshot, role, permission)


def has_global_project_access(user_id: int, role: str, *, manage_required: bool = False) -> bool:
    """Return True when the user may bypass per-project membership checks.

    `projects:manage` always grants global access. Read-only global access via
    `projects:view` is reserved for non-employee roles; employees remain scoped
    to their explicit project memberships.
    """
    if is_external_role(role):
        return False
    if has_permission_for_user(user_id, role, "projects:manage"):
        return True
    if manage_required or role == ROLE_EMPLOYEE:
        return False
    return has_permission_for_user(user_id, role, "projects:view")


def get_user_override(user_id: int) -> dict[str, list[str]]:
    """Return the stored extra/denied lists for one user (empty if none)."""
    data = _snapshot.users.get(user_id, {})
    return {
        "extra": sorted(data.get("extra", set())),
        "denied": sorted(data.get("denied", set())),
    }


def get_user_effective_permissions(user_id: int, role: str) -> list[str]:
    """Return the sorted list of all effective permissions for a user.

    Applies role-level permissions first, then user-level extra/denied overrides.
    """
    if is_external_role(role):
        return []
    snapshot = _snapshot
    role_perms = _effective_role_permissions_map(snapshot).get(role, set())
    override = snapshot.users.get(user_id, {})

    extra = override.get("extra", frozenset())
    denied = override.get("denied", frozenset())
    return sorted((role_perms | extra) - denied)


def get_all_user_overrides() -> dict[int, dict[str, list[str]]]:
    """Return all user-level overrides as {user_id: {extra, denied}}."""
    return {
        uid: {
            "extra": sorted(data.get("extra", frozenset())),
            "denied": sorted(data.get("denied", frozenset())),
        }
        for uid, data in _snapshot.users.items()
    }
