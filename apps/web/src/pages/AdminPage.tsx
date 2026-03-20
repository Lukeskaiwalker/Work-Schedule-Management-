import { useState, useEffect, useRef, type FormEvent } from "react";
import { useAppContext } from "../context/AppContext";
import { AvatarBadge } from "../components/shared/AvatarBadge";
import { AdminUpdateMenu } from "../components/shared/AdminUpdateMenu";
import { MailIcon, KeyIcon, ArchiveUserIcon, ShieldIcon, ResetIcon } from "../components/icons";
import { schoolWeekdayLabel } from "../utils/dates";
import type { User, EmployeeGroup } from "../types";

type AdminTab = "users" | "groups" | "roles" | "tools" | "audit" | "settings" | "system";
type AuditPeriodFilter = "all" | "today" | "7d" | "30d" | "90d" | "custom";

const ALL_ROLES: User["role"][] = ["admin", "ceo", "accountant", "planning", "employee"];

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function formatAuditCategory(category: string, de: boolean): string {
  const labels: Record<string, string> = de
    ? {
        auth: "Anmeldung",
        chat: "Chat",
        files: "Dateien",
        finance: "Finanzen",
        groups: "Gruppen",
        permissions: "Berechtigungen",
        planning: "Planung",
        projects: "Projekte",
        reports: "Berichte",
        settings: "Einstellungen",
        system: "System",
        tasks: "Aufgaben",
        tickets: "Tickets",
        time: "Zeiterfassung",
        users: "Benutzer",
        wiki: "Wiki",
      }
    : {
        auth: "Auth",
        chat: "Chat",
        files: "Files",
        finance: "Finance",
        groups: "Groups",
        permissions: "Permissions",
        planning: "Planning",
        projects: "Projects",
        reports: "Reports",
        settings: "Settings",
        system: "System",
        tasks: "Tasks",
        tickets: "Tickets",
        time: "Time",
        users: "Users",
        wiki: "Wiki",
      };
  return labels[category] ?? category;
}

function formatAuditPeriodLabel(period: AuditPeriodFilter, de: boolean): string {
  switch (period) {
    case "today":
      return de ? "Heute" : "Today";
    case "7d":
      return de ? "Letzte 7 Tage" : "Last 7 days";
    case "30d":
      return de ? "Letzte 30 Tage" : "Last 30 days";
    case "90d":
      return de ? "Letzte 90 Tage" : "Last 90 days";
    case "custom":
      return de ? "Benutzerdefiniert" : "Custom";
    default:
      return de ? "Gesamter Zeitraum" : "All time";
  }
}

type GroupDraft = {
  name: string;
  memberIds: Set<number>;
  canUpdateRecentOwnTimeEntries: boolean;
};

export function AdminPage() {
  const {
    mainView,
    user,
    language,
    canManageUsers,
    canManagePermissions,
    canManageProjectImport,
    canManageSchoolAbsences,
    canViewAudit,
    canManageSettings,
    canManageSystem,
    canExportBackups,
    canAdjustRequiredHours,
    // Users tab
    activeAdminUsers,
    archivedAdminUsers,
    adminUsersById,
    updateRole,
    updateWorkspaceLock,
    requiredHoursDrafts,
    setRequiredHoursDrafts,
    updateRequiredDailyHours,
    vacationBalanceDrafts,
    setVacationBalanceDrafts,
    updateVacationBalance,
    sendInviteToUser,
    sendPasswordResetToUser,
    softDeleteUser,
    restoreArchivedUser,
    inviteCreateForm,
    setInviteCreateForm,
    submitCreateInvite,
    userAvatarVersionById,
    userHasAvatar,
    userInitialsById,
    // Groups tab
    employeeGroups,
    employeeGroupsLoading,
    loadEmployeeGroups,
    createEmployeeGroup,
    updateEmployeeGroup,
    deleteEmployeeGroup,
    // Roles tab
    rolePermissionsMeta,
    rolePermissionsLoading,
    loadRolePermissions,
    setRolePermission,
    resetRoleToDefaults,
    // User permissions tab
    userPermissionOverrides,
    loadUserPermissions,
    setUserPermissionOverride,
    resetUserPermissions,
    // Audit tab
    auditLogs,
    auditLogsLoading,
    loadAuditLogs,
    // Settings tab
    weatherSettings,
    weatherApiKeyInput,
    setWeatherApiKeyInput,
    weatherSettingsSaving,
    saveWeatherSettings,
    smtpSettings,
    smtpSettingsForm,
    setSmtpSettingsForm,
    smtpSettingsSaving,
    saveSmtpSettings,
    // System tab
    backupExporting,
    exportEncryptedDatabaseBackup,
    // Tools tab
    assignableUsers,
    menuUserNameById,
    schoolAbsenceForm,
    setSchoolAbsenceForm,
    submitSchoolAbsence,
    toggleSchoolRecurrenceWeekday,
    downloadProjectCsvTemplate,
    downloadProjectClassTemplateCsv,
    importProjectsCsv,
    importProjectClassTemplateCsv,
  } = useAppContext();

  const canAccess =
    canManageUsers ||
    canManagePermissions ||
    canManageProjectImport ||
    canManageSchoolAbsences ||
    canViewAudit ||
    canManageSettings ||
    canManageSystem ||
    canExportBackups;

  const toolsVisible = canManageProjectImport || canManageSchoolAbsences;
  const systemVisible = canManageSystem || canExportBackups;
  const availableTabs: AdminTab[] = [
    ...(canManageUsers ? (["users", "groups"] as AdminTab[]) : []),
    ...(canManagePermissions ? (["roles"] as AdminTab[]) : []),
    ...(toolsVisible ? (["tools"] as AdminTab[]) : []),
    ...(canViewAudit ? (["audit"] as AdminTab[]) : []),
    ...(canManageSettings ? (["settings"] as AdminTab[]) : []),
    ...(systemVisible ? (["system"] as AdminTab[]) : []),
  ];

  const [tab, setTab] = useState<AdminTab>(availableTabs[0] ?? "tools");
  const [showInvite, setShowInvite] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditCategoryFilters, setAuditCategoryFilters] = useState<string[]>([]);
  const [auditPeriodFilter, setAuditPeriodFilter] = useState<AuditPeriodFilter>("all");
  const [auditDateFrom, setAuditDateFrom] = useState("");
  const [auditDateTo, setAuditDateTo] = useState("");
  const [resettingRole, setResettingRole] = useState<string | null>(null);
  // Which user's permission panel is open (user id or null)
  const [expandedPermUserId, setExpandedPermUserId] = useState<number | null>(null);
  // Local draft for per-user permission overrides while editing
  const [permDraft, setPermDraft] = useState<{ extra: Set<string>; denied: Set<string> } | null>(null);
  const [permSaving, setPermSaving] = useState(false);
  const userPermPanelRefs = useRef<Record<number, HTMLDivElement | null>>({});
  // Floating tooltip for permission descriptions in the roles matrix
  const [permTooltip, setPermTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  // When the server returns fresh data for the open user, sync the draft.
  useEffect(() => {
    if (expandedPermUserId == null) return;
    const fresh = userPermissionOverrides[expandedPermUserId];
    if (fresh) {
      setPermDraft({
        extra: new Set(fresh.extra),
        denied: new Set(fresh.denied),
      });
    }
  }, [userPermissionOverrides, expandedPermUserId]);

  useEffect(() => {
    if (tab === "groups" && canManageUsers) void loadEmployeeGroups();
    if (tab === "audit" && canViewAudit) void loadAuditLogs();
    if (tab === "roles" && canManagePermissions) void loadRolePermissions();
    // user-level permissions are loaded lazily when a row panel is opened
  }, [tab, canManageUsers, canViewAudit, canManagePermissions]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!availableTabs.includes(tab)) {
      setTab(availableTabs[0] ?? "tools");
    }
  }, [availableTabs, tab]);

  useEffect(() => {
    if (canManagePermissions || inviteCreateForm.role === "employee") return;
    setInviteCreateForm({ ...inviteCreateForm, role: "employee" });
  }, [canManagePermissions, inviteCreateForm.role, setInviteCreateForm]);

  useEffect(() => {
    if (expandedPermUserId == null) return;
    const panel = userPermPanelRefs.current[expandedPermUserId];
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [expandedPermUserId, permDraft, rolePermissionsMeta]);

  if (mainView !== "admin" || !canAccess) return null;

  const de = language === "de";

  const ALL_TABS: { id: AdminTab; label: string; count?: number; visible: boolean }[] = [
    { id: "users",    label: de ? "Benutzer"      : "Users",     count: activeAdminUsers.length, visible: canManageUsers },
    { id: "groups",   label: de ? "Gruppen"       : "Groups",    visible: canManageUsers },
    { id: "roles",    label: de ? "Rollen"        : "Roles",     visible: canManagePermissions },
    { id: "tools",    label: de ? "Werkzeuge"     : "Tools",     visible: toolsVisible },
    { id: "audit",    label: de ? "Protokoll"     : "Audit Log", visible: canViewAudit },
    { id: "settings", label: de ? "Einstellungen" : "Settings",  visible: canManageSettings },
    { id: "system",   label: "System",                           visible: systemVisible },
  ];
  const TABS = ALL_TABS.filter((t) => t.visible);

  // ── Group helpers ──────────────────────────────────────────────────────────

  const openNewGroup = () => {
    setEditingGroupId(null);
    setGroupDraft({ name: "", memberIds: new Set(), canUpdateRecentOwnTimeEntries: false });
  };

  const openEditGroup = (group: EmployeeGroup) => {
    setEditingGroupId(group.id);
    setGroupDraft({
      name: group.name,
      memberIds: new Set(group.member_user_ids),
      canUpdateRecentOwnTimeEntries: group.can_update_recent_own_time_entries,
    });
  };

  const cancelGroupDraft = () => {
    setGroupDraft(null);
    setEditingGroupId(null);
  };

  const submitGroupDraft = async () => {
    if (!groupDraft || groupDraft.name.trim() === "") return;
    const memberIds = Array.from(groupDraft.memberIds);
    if (editingGroupId !== null) {
      await updateEmployeeGroup(editingGroupId, {
        name: groupDraft.name.trim(),
        member_user_ids: memberIds,
        can_update_recent_own_time_entries: groupDraft.canUpdateRecentOwnTimeEntries,
      });
    } else {
      await createEmployeeGroup(groupDraft.name.trim(), memberIds, groupDraft.canUpdateRecentOwnTimeEntries);
    }
    cancelGroupDraft();
  };

  const toggleGroupMember = (userId: number) => {
    if (!groupDraft) return;
    const next = new Set(groupDraft.memberIds);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    setGroupDraft({ ...groupDraft, memberIds: next });
  };

  // ── Per-user permission helpers ────────────────────────────────────────────

  const openUserPermPanel = (userId: number) => {
    if (expandedPermUserId === userId) {
      setExpandedPermUserId(null);
      setPermDraft(null);
      return;
    }
    // Start with cached data immediately (may be empty if not loaded yet).
    const existing = userPermissionOverrides[userId];
    setPermDraft({
      extra: new Set(existing?.extra ?? []),
      denied: new Set(existing?.denied ?? []),
    });
    setExpandedPermUserId(userId);
    if (!rolePermissionsMeta) {
      void loadRolePermissions();
    }
    // Fetch fresh data from the server; the useEffect above will sync the draft.
    void loadUserPermissions(userId);
  };

  const togglePermExtra = (perm: string) => {
    if (!permDraft) return;
    const extra = new Set(permDraft.extra);
    const denied = new Set(permDraft.denied);
    if (extra.has(perm)) {
      extra.delete(perm);
    } else {
      extra.add(perm);
      denied.delete(perm); // can't both grant and deny
    }
    setPermDraft({ extra, denied });
  };

  const togglePermDenied = (perm: string) => {
    if (!permDraft) return;
    const extra = new Set(permDraft.extra);
    const denied = new Set(permDraft.denied);
    if (denied.has(perm)) {
      denied.delete(perm);
    } else {
      denied.add(perm);
      extra.delete(perm); // can't both grant and deny
    }
    setPermDraft({ extra, denied });
  };

  const saveUserPermDraft = async (userId: number) => {
    if (!permDraft) return;
    setPermSaving(true);
    try {
      await setUserPermissionOverride(userId, Array.from(permDraft.extra), Array.from(permDraft.denied));
      setExpandedPermUserId(null);
      setPermDraft(null);
    } finally {
      setPermSaving(false);
    }
  };

  const handleResetUserPerms = async (userId: number) => {
    setPermSaving(true);
    try {
      await resetUserPermissions(userId);
      setExpandedPermUserId(null);
      setPermDraft(null);
    } finally {
      setPermSaving(false);
    }
  };

  // ── Audit filter ───────────────────────────────────────────────────────────

  const usersWithRecentTimeEditGroupAccess = new Set(
    employeeGroups
      .filter((group) => group.can_update_recent_own_time_entries)
      .flatMap((group) => group.member_user_ids),
  );
  const auditCategories = Array.from(new Set(auditLogs.map((log) => log.category).filter(Boolean))).sort();
  const hasCustomAuditDateRange = auditDateFrom.trim() !== "" || auditDateTo.trim() !== "";
  const hasAuditDateFilter = auditPeriodFilter !== "all" && (auditPeriodFilter !== "custom" || hasCustomAuditDateRange);
  const hasAuditFilters = auditCategoryFilters.length > 0 || hasAuditDateFilter;
  const activeAuditFilterCount =
    (auditCategoryFilters.length > 0 ? 1 : 0) +
    (hasAuditDateFilter ? 1 : 0);

  const toggleAuditCategoryFilter = (category: string) => {
    setAuditCategoryFilters((current) =>
      current.includes(category) ? current.filter((value) => value !== category) : [...current, category],
    );
  };

  const clearAuditFilters = () => {
    setAuditCategoryFilters([]);
    setAuditPeriodFilter("all");
    setAuditDateFrom("");
    setAuditDateTo("");
  };

  const isLogWithinAuditDateRange = (createdAt: string) => {
    if (!hasAuditDateFilter) return true;
    const created = new Date(createdAt);
    if (Number.isNaN(created.getTime())) return true;

    let start: Date | null = null;
    let end: Date | null = null;

    if (auditPeriodFilter === "custom") {
      if (auditDateFrom) {
        start = new Date(`${auditDateFrom}T00:00:00`);
      }
      if (auditDateTo) {
        end = new Date(`${auditDateTo}T23:59:59.999`);
      }
    } else {
      end = new Date();
      end.setHours(23, 59, 59, 999);

      start = new Date(end);
      start.setHours(0, 0, 0, 0);

      if (auditPeriodFilter === "7d") {
        start.setDate(start.getDate() - 6);
      } else if (auditPeriodFilter === "30d") {
        start.setDate(start.getDate() - 29);
      } else if (auditPeriodFilter === "90d") {
        start.setDate(start.getDate() - 89);
      }
    }

    if (start && !Number.isNaN(start.getTime()) && created < start) return false;
    if (end && !Number.isNaN(end.getTime()) && created > end) return false;
    return true;
  };

  const filteredLogs = auditLogs.filter((l) => {
    if (auditCategoryFilters.length > 0 && !auditCategoryFilters.includes(l.category)) {
      return false;
    }
    if (!isLogWithinAuditDateRange(l.created_at)) {
      return false;
    }
    if (!auditSearch.trim()) {
      return true;
    }
    const q = auditSearch.toLowerCase();
    const actor = l.actor_user_id
      ? (adminUsersById.get(l.actor_user_id)?.display_name ?? String(l.actor_user_id))
      : "system";
    return l.action.toLowerCase().includes(q) || actor.toLowerCase().includes(q);
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
    <section className="card admin-center">
      <h3 className="admin-center-title">
        {de ? "Verwaltungszentrum" : "Admin Center"}
      </h3>

      {/* ── Tab bar ────────────────────────────────────────────────────────── */}
      <nav className="admin-tabs" role="tablist" aria-label={de ? "Verwaltungsbereiche" : "Admin sections"}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "admin-tab-btn active" : "admin-tab-btn"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.count !== undefined && (
              <span className="admin-tab-count">{t.count}</span>
            )}
          </button>
        ))}
      </nav>

      {/* ── Users ──────────────────────────────────────────────────────────── */}
      {tab === "users" && (
        <div className="admin-tab-pane">
          <div className="admin-stats-row">
            <div className="admin-stat-chip">
              <b>{activeAdminUsers.length + archivedAdminUsers.length}</b>
              {de ? "Gesamt" : "Total"}
            </div>
            <div className="admin-stat-chip admin-stat-chip--ok">
              <b>{activeAdminUsers.length}</b>
              {de ? "Aktiv" : "Active"}
            </div>
            {archivedAdminUsers.length > 0 && (
              <div className="admin-stat-chip admin-stat-chip--muted">
                <b>{archivedAdminUsers.length}</b>
                {de ? "Archiviert" : "Archived"}
              </div>
            )}
          </div>

          {!showInvite ? (
            <button type="button" onClick={() => setShowInvite(true)}>
              + {de ? "Benutzer einladen" : "Invite user"}
            </button>
          ) : (
            <div className="admin-form-section">
              <h4 className="admin-form-title">{de ? "Neuer Benutzer" : "New user"}</h4>
              <form
                className="admin-invite-row"
                onSubmit={(e: FormEvent<HTMLFormElement>) => {
                  void submitCreateInvite(e);
                  setShowInvite(false);
                }}
              >
                <label>
                  {de ? "Name" : "Full name"}
                  <input
                    required
                    value={inviteCreateForm.full_name}
                    onChange={(e) => setInviteCreateForm({ ...inviteCreateForm, full_name: e.target.value })}
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    required
                    value={inviteCreateForm.email}
                    onChange={(e) => setInviteCreateForm({ ...inviteCreateForm, email: e.target.value })}
                  />
                </label>
                <label>
                  {de ? "Rolle" : "Role"}
                  <select
                    value={inviteCreateForm.role}
                    disabled={!canManagePermissions}
                    onChange={(e) =>
                      setInviteCreateForm({ ...inviteCreateForm, role: e.target.value as User["role"] })
                    }
                  >
                    {(canManagePermissions ? ALL_ROLES : ["employee"]).map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
                <div className="admin-invite-actions">
                  <button type="submit">
                    ✉ {de ? "Einladen & senden" : "Invite & send"}
                  </button>
                  <button type="button" onClick={() => setShowInvite(false)}>
                    {de ? "Abbrechen" : "Cancel"}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="admin-user-list">
            {activeAdminUsers.map((u) => (
              <div key={u.id} className="admin-user-row-wrap">
                <div className="admin-user-row">
                  <AvatarBadge
                    userId={u.id}
                    initials={userInitialsById(u.id)}
                    hasAvatar={userHasAvatar(u.id)}
                    versionKey={userAvatarVersionById(u.id)}
                    className="admin-avatar"
                  />
                  <div className="admin-user-info">
                    <div className="admin-user-name">{u.full_name}</div>
                    <div className="admin-user-meta">
                      <span className="admin-user-email">{u.email}</span>
                      {u.invite_accepted_at == null && u.invite_sent_at != null && (
                        <span className="admin-badge admin-badge--warn">
                          {de ? "Einladung ausstehend" : "Invite pending"}
                        </span>
                      )}
                      {(userPermissionOverrides[u.id]?.extra?.length > 0 ||
                        userPermissionOverrides[u.id]?.denied?.length > 0) && (
                        <span className="admin-badge" title={de ? "Individuelle Berechtigungen aktiv" : "Custom permissions active"}>
                          {de ? "Individuelle Rechte" : "Custom perms"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="admin-user-controls">
                    <div className="admin-user-control-row">
                      <span className="admin-user-control-label">{de ? "Rolle" : "Role"}</span>
                      <select
                        value={u.role}
                        className="admin-role-select"
                        aria-label={de ? `Rolle fuer ${u.full_name}` : `Role for ${u.full_name}`}
                        disabled={u.id === user?.id || !canManagePermissions}
                        title={
                          u.id === user?.id
                            ? (de ? "Eigene Rolle kann nicht geändert werden" : "Cannot change your own role")
                            : !canManagePermissions
                              ? (de ? "Rollenänderung erfordert Berechtigung zur Rechteverwaltung" : "Role changes require permission management access")
                              : undefined
                        }
                        onChange={(e) => void updateRole(u.id, e.target.value as User["role"])}
                      >
                        {ALL_ROLES.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                      </select>
                    </div>
                    <div className="admin-user-control-row">
                      <span className="admin-user-control-label">{de ? "Ansicht" : "View"}</span>
                      <select
                        value={u.workspace_lock ?? ""}
                        className="admin-role-select"
                        aria-label={de ? `Ansichtssperre für ${u.full_name}` : `View lock for ${u.full_name}`}
                        onChange={(e) => {
                          const val = e.target.value;
                          void updateWorkspaceLock(u.id, val === "" ? null : (val as "construction" | "office"));
                        }}
                      >
                        <option value="">{de ? "Frei wählbar" : "User's choice"}</option>
                        <option value="construction">{de ? "Nur Baustelle" : "Construction only"}</option>
                        <option value="office">{de ? "Nur Büro" : "Office only"}</option>
                      </select>
                    </div>
                    <div className="admin-user-control-row admin-hours-row">
                      <span className="admin-user-control-label">{de ? "Soll h/Tag" : "Req. h/day"}</span>
                      <input
                        type="number"
                        min={1}
                        max={24}
                        step={0.25}
                        value={requiredHoursDrafts[u.id] ?? String(u.required_daily_hours ?? 8)}
                        onChange={(e) => setRequiredHoursDrafts({ ...requiredHoursDrafts, [u.id]: e.target.value })}
                        className="admin-hours-input"
                        aria-label={de ? "Pflichtarbeitszeit h/Tag" : "Required h/day"}
                        disabled={!canAdjustRequiredHours}
                      />
                      <span className="admin-hours-unit muted">h/d</span>
                      <button
                        type="button"
                        className="admin-save-btn"
                        disabled={!canAdjustRequiredHours}
                        onClick={() => void updateRequiredDailyHours(u.id)}
                      >
                        {de ? "Spch." : "Save"}
                      </button>
                    </div>
                    <div className="admin-user-control-row admin-hours-row">
                      <span className="admin-user-control-label">{de ? "Urlaub" : "Vacation"}</span>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={vacationBalanceDrafts[u.id]?.perYear ?? String(u.vacation_days_per_year ?? 0)}
                        onChange={(e) =>
                          setVacationBalanceDrafts((current) => {
                            const previousPerYear = current[u.id]?.perYear ?? String(u.vacation_days_per_year ?? 0);
                            const previousAvailable = current[u.id]?.available ?? String(u.vacation_days_available ?? 0);
                            const previousCarryover = current[u.id]?.carryover ?? String(u.vacation_days_carryover ?? 0);
                            const initialAvailable = Number(u.vacation_days_available ?? 0);
                            const initialCarryover = Number(u.vacation_days_carryover ?? 0);
                            const isInitialSetup = initialAvailable <= 0 && initialCarryover <= 0;
                            const shouldAutofillAvailable =
                              isInitialSetup &&
                              (current[u.id] === undefined || previousAvailable === previousPerYear);
                            return {
                              ...current,
                              [u.id]: {
                                perYear: e.target.value,
                                available: shouldAutofillAvailable
                                  ? e.target.value
                                  : previousAvailable,
                                carryover: previousCarryover,
                              },
                            };
                          })
                        }
                        className="admin-hours-input"
                        aria-label={de ? "Urlaubstage pro Jahr" : "Vacation days per year"}
                      />
                      <span className="admin-hours-unit muted">{de ? "Jahr" : "year"}</span>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={vacationBalanceDrafts[u.id]?.available ?? String(u.vacation_days_available ?? 0)}
                        onChange={(e) =>
                          setVacationBalanceDrafts((current) => ({
                            ...current,
                            [u.id]: {
                              perYear: current[u.id]?.perYear ?? String(u.vacation_days_per_year ?? 0),
                              available: e.target.value,
                              carryover: current[u.id]?.carryover ?? String(u.vacation_days_carryover ?? 0),
                            },
                          }))
                        }
                        className="admin-hours-input"
                        aria-label={de ? "Verfügbare Urlaubstage" : "Available vacation days"}
                      />
                      <span className="admin-hours-unit muted">{de ? "offen" : "left"}</span>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={vacationBalanceDrafts[u.id]?.carryover ?? String(u.vacation_days_carryover ?? 0)}
                        onChange={(e) =>
                          setVacationBalanceDrafts((current) => ({
                            ...current,
                            [u.id]: {
                              perYear: current[u.id]?.perYear ?? String(u.vacation_days_per_year ?? 0),
                              available: current[u.id]?.available ?? String(u.vacation_days_available ?? 0),
                              carryover: e.target.value,
                            },
                          }))
                        }
                        className="admin-hours-input"
                        aria-label={de ? "Übertrag Urlaubstage" : "Vacation carryover days"}
                      />
                      <span className="admin-hours-unit muted">{de ? "Vorjahr" : "carry"}</span>
                      <button type="button" className="admin-save-btn" onClick={() => void updateVacationBalance(u.id)}>
                        {de ? "Spch." : "Save"}
                      </button>
                      <span className="admin-hours-unit muted" style={{ minWidth: "auto" }}>
                        {de ? "Gesamt offen" : "Total left"}:{" "}
                        {(
                          vacationBalanceDrafts[u.id]
                            ? Number(vacationBalanceDrafts[u.id]?.available ?? 0) +
                              Number(vacationBalanceDrafts[u.id]?.carryover ?? 0)
                            : Number(u.vacation_days_total_remaining ?? 0)
                        ).toFixed(1).replace(/\\.0$/, "")}
                      </span>
                    </div>
                  </div>
                  <div className="admin-user-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title={de ? "Einladungs-E-Mail senden" : "Send invite email"}
                      onClick={() => void sendInviteToUser(u.id)}
                    >
                      <MailIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title={de ? "Passwort zurücksetzen" : "Send password reset"}
                      onClick={() => void sendPasswordResetToUser(u.id)}
                    >
                      <KeyIcon />
                    </button>
                    <button
                      type="button"
                      className={`icon-btn${expandedPermUserId === u.id ? " active" : ""}`}
                      title={de ? "Individuelle Berechtigungen" : "Custom permissions"}
                      disabled={!canManagePermissions}
                      onClick={() => openUserPermPanel(u.id)}
                    >
                      <ShieldIcon />
                    </button>
                    <button
                      type="button"
                      className="icon-btn admin-btn-danger"
                      title={de ? "Benutzer archivieren" : "Archive user"}
                      disabled={u.id === user?.id}
                      onClick={() => void softDeleteUser(u.id)}
                    >
                      <ArchiveUserIcon />
                    </button>
                  </div>
                </div>

                {/* ── Per-user permission panel ─────────────────────────── */}
                {expandedPermUserId === u.id && permDraft && rolePermissionsMeta && (
                  <div
                    ref={(node) => { userPermPanelRefs.current[u.id] = node; }}
                    className="admin-user-perm-panel"
                  >
                    <div className="admin-user-perm-header">
                      <span className="admin-user-perm-title">
                        {de ? "Individuelle Berechtigungen" : "Custom permissions"}
                        {" — "}<em>{u.full_name}</em>
                      </span>
                      <small className="muted">
                        {de
                          ? "Grün = Zusätzlich gewährt · Rot = Verweigert (unabhängig von der Rolle)"
                          : "Green = Extra grant · Red = Deny (overrides role)"}
                      </small>
                    </div>
                    <div className="admin-perm-groups">
                      {rolePermissionsMeta.permission_groups.map((group) => (
                        <div key={group.key} className="admin-perm-group">
                          <div className="admin-perm-group-label">{group.label}</div>
                          <div className="admin-perm-items">
                            {group.permissions.map((perm) => {
                              const roleHas = (rolePermissionsMeta.permissions[u.role] ?? []).includes(perm);
                              const isExtra = permDraft.extra.has(perm);
                              const isDenied = permDraft.denied.has(perm);
                              const label = rolePermissionsMeta.permission_labels[perm] ?? perm;
                              return (
                                <div key={perm} className={`admin-perm-item${isExtra ? " admin-perm-item--extra" : isDenied ? " admin-perm-item--denied" : ""}`}>
                                  <span className="admin-perm-item-label">
                                    {label}
                                    {roleHas
                                      ? <span className="admin-perm-role-dot admin-perm-role-dot--on" title={de ? "Rolle hat diese Berechtigung" : "Role has this permission"} />
                                      : <span className="admin-perm-role-dot admin-perm-role-dot--off" title={de ? "Rolle hat diese Berechtigung nicht" : "Role doesn't have this permission"} />
                                    }
                                  </span>
                                  <div className="admin-perm-toggles">
                                    <label className="admin-perm-toggle-label admin-perm-toggle-label--extra" title={de ? "Zusätzlich gewähren" : "Extra grant"}>
                                      <input
                                        type="checkbox"
                                        checked={isExtra}
                                        onChange={() => togglePermExtra(perm)}
                                      />
                                      <span>{de ? "Gewähren" : "Grant"}</span>
                                    </label>
                                    <label className="admin-perm-toggle-label admin-perm-toggle-label--deny" title={de ? "Verweigern" : "Deny"}>
                                      <input
                                        type="checkbox"
                                        checked={isDenied}
                                        onChange={() => togglePermDenied(perm)}
                                      />
                                      <span>{de ? "Sperren" : "Deny"}</span>
                                    </label>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="row" style={{ gap: "0.5rem", marginTop: "0.85rem", flexWrap: "wrap" }}>
                      <button type="button" disabled={permSaving} onClick={() => void saveUserPermDraft(u.id)}>
                        {permSaving ? (de ? "Speichern…" : "Saving…") : (de ? "Speichern" : "Save")}
                      </button>
                      <button
                        type="button"
                        disabled={permSaving}
                        onClick={() => void handleResetUserPerms(u.id)}
                        style={{ color: "var(--danger)" }}
                      >
                        {de ? "Überschreibungen entfernen" : "Remove overrides"}
                      </button>
                      <button type="button" onClick={() => { setExpandedPermUserId(null); setPermDraft(null); }}>
                        {de ? "Abbrechen" : "Cancel"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {activeAdminUsers.length === 0 && (
              <p className="muted">{de ? "Keine aktiven Benutzer." : "No active users."}</p>
            )}
          </div>

          {archivedAdminUsers.length > 0 && (
            <div className="admin-archived-section">
              <button
                type="button"
                className="linklike"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived
                  ? (de ? "▾ Archiv ausblenden" : "▾ Hide archive")
                  : (de
                      ? `▸ Archiv anzeigen (${archivedAdminUsers.length})`
                      : `▸ Show archive (${archivedAdminUsers.length})`)}
              </button>
              {showArchived && (
                <div className="admin-user-list admin-archived-list">
                  {archivedAdminUsers.map((u) => (
                    <div key={u.id} className="admin-user-row-wrap">
                      <div className="admin-user-row admin-user-row--archived">
                        <AvatarBadge
                          userId={u.id}
                          initials={userInitialsById(u.id)}
                          hasAvatar={userHasAvatar(u.id)}
                          versionKey={userAvatarVersionById(u.id)}
                          className="admin-avatar admin-avatar--muted"
                        />
                        <div className="admin-user-info">
                          <div className="admin-user-name">{u.full_name}</div>
                          <div className="admin-user-email">
                            {u.email} · {u.role}
                            {usersWithRecentTimeEditGroupAccess.has(u.id) && (
                              <span className="muted" style={{ marginLeft: "0.5rem" }}>
                                · {de ? "Gruppe: letzte 3 Zeiteinträge" : "Group: last 3 time entries"}
                              </span>
                            )}
                          </div>
                        </div>
                        <div />
                        <div className="admin-user-actions">
                          <button type="button" onClick={() => void restoreArchivedUser(u.id)}>
                            {de ? "Wiederherstellen" : "Restore"}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Groups ─────────────────────────────────────────────────────────── */}
      {tab === "groups" && (
        <div className="admin-tab-pane">
          {groupDraft === null && (
            <button type="button" onClick={openNewGroup}>
              + {de ? "Neue Gruppe" : "New group"}
            </button>
          )}

          {groupDraft !== null && (
            <div className="admin-form-section admin-group-form">
              <h4 className="admin-form-title">
                {editingGroupId !== null
                  ? (de ? "Gruppe bearbeiten" : "Edit group")
                  : (de ? "Neue Gruppe" : "New group")}
              </h4>
              <label style={{ display: "block", marginBottom: "0.75rem" }}>
                {de ? "Gruppenname" : "Group name"}
                <input
                  autoFocus
                  value={groupDraft.name}
                  maxLength={120}
                  onChange={(e) => setGroupDraft({ ...groupDraft, name: e.target.value })}
                />
              </label>
              <div style={{ marginBottom: "0.85rem" }}>
                <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.35rem" }}>
                  {de ? "Gruppenrechte" : "Group permissions"}
                </p>
              <label className="admin-member-check-row" style={{ marginBottom: "0.85rem" }}>
                <input
                  type="checkbox"
                  checked={groupDraft.canUpdateRecentOwnTimeEntries}
                  onChange={(e) =>
                    setGroupDraft({ ...groupDraft, canUpdateRecentOwnTimeEntries: e.target.checked })
                  }
                />
                {de
                  ? "Darf die letzten 3 eigenen Zeiteinträge sehen und ändern"
                  : "Can view and update the last 3 own time entries"}
              </label>
              </div>
              <div className="admin-group-form-body">
                <p className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.4rem" }}>
                  {de ? "Mitglieder" : "Members"} ({groupDraft.memberIds.size})
                </p>
                <div className="admin-member-checklist">
                  {activeAdminUsers.map((u) => (
                    <label key={u.id} className="admin-member-check-row">
                      <input
                        type="checkbox"
                        checked={groupDraft.memberIds.has(u.id)}
                        onChange={() => toggleGroupMember(u.id)}
                      />
                      {u.display_name}
                      <span className="muted" style={{ fontSize: "0.78rem" }}>· {u.role}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="row admin-group-form-footer" style={{ gap: "0.5rem" }}>
                <button type="button" onClick={() => void submitGroupDraft()}>
                  {de ? "Speichern" : "Save"}
                </button>
                <button type="button" onClick={cancelGroupDraft}>
                  {de ? "Abbrechen" : "Cancel"}
                </button>
              </div>
            </div>
          )}

          {employeeGroupsLoading && <p className="muted">{de ? "Lädt…" : "Loading…"}</p>}
          {!employeeGroupsLoading && employeeGroups.length === 0 && (
            <p className="muted">{de ? "Noch keine Gruppen vorhanden." : "No groups yet."}</p>
          )}
          {employeeGroups.map((group) => (
            <div key={group.id} className="admin-group-card">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <b>{group.name}</b>
                  <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.84rem" }}>
                    {group.members.length} {de ? "Mitglied(er)" : "member(s)"}
                  </span>
                  {group.can_update_recent_own_time_entries && (
                    <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.84rem" }}>
                      · {de ? "letzte 3 Eigeneinträge sichtbar und editierbar" : "last 3 own entries visible and editable"}
                    </span>
                  )}
                </div>
                <div className="row" style={{ gap: "0.4rem" }}>
                  <button type="button" className="icon-btn" title={de ? "Bearbeiten" : "Edit"} onClick={() => openEditGroup(group)}>✏</button>
                  <button type="button" className="icon-btn admin-btn-danger" title={de ? "Löschen" : "Delete"} onClick={() => void deleteEmployeeGroup(group.id)}>✕</button>
                </div>
              </div>
              {group.members.length > 0 && (
                <div className="admin-group-members">
                  {group.members.map((m) => (
                    <span key={m.user_id} className={`admin-member-chip${m.is_active ? "" : " admin-member-chip--inactive"}`}>
                      {m.display_name}
                    </span>
                  ))}
                </div>
              )}
              <div className="admin-group-members" style={{ marginTop: "0.5rem" }}>
                <span className="admin-member-chip">
                  {group.can_update_recent_own_time_entries
                    ? (de ? "Recht: letzte 3 eigene Zeiteinträge sehen und bearbeiten" : "Permission: view and edit last 3 own time entries")
                    : (de ? "Kein zusätzliches Gruppenrecht" : "No extra group permission")}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Roles ──────────────────────────────────────────────────────────── */}
      {tab === "roles" && (
        <div className="admin-tab-pane">
          <div className="perm-header">
            <div>
              <h4 className="perm-heading">
                {de ? "Rollenberechtigungen" : "Role Permissions"}
              </h4>
              <p className="perm-subline muted">
                {de
                  ? "Legen Sie fest, welche Aktionen jede Rolle ausführen darf. Änderungen gelten sofort."
                  : "Define what each role is allowed to do. Changes take effect immediately."}
              </p>
            </div>
          </div>

          {rolePermissionsLoading && !rolePermissionsMeta && (
            <p className="muted" style={{ padding: "1rem 0" }}>{de ? "Lade…" : "Loading…"}</p>
          )}

          {rolePermissionsMeta && (() => {
            const { permissions, permission_groups, permission_labels, permission_descriptions, all_roles } = rolePermissionsMeta;

            const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);
            const hasPermission = (role: string, perm: string) => (permissions[role] ?? []).includes(perm);
            const groupAllEnabled = (group: { permissions: string[] }, role: string) =>
              group.permissions.every((p) => hasPermission(role, p));

            const toggleGroupForRole = (group: { permissions: string[] }, role: string, enable: boolean) => {
              group.permissions.forEach((perm) => {
                if (hasPermission(role, perm) !== enable) void setRolePermission(role, perm, enable);
              });
            };

            const handleReset = async (role: string) => {
              setResettingRole(role);
              try { await resetRoleToDefaults(role); }
              finally { setResettingRole(null); }
            };

            return (
              <div className="perm-matrix-wrapper">
                <table className="perm-matrix">
                  <thead>
                    <tr>
                      <th className="perm-col-label">{de ? "Berechtigung" : "Permission"}</th>
                      {all_roles.map((role) => (
                        <th key={role} className="perm-col-role">
                          <div className="perm-role-header">
                            <span className="perm-role-name">{roleLabel(role)}</span>
                            {role === "admin" ? (
                              <span className="perm-locked-badge" title={de ? "Admin-Rolle ist schreibgeschützt" : "Admin role is read-only"}>🔒</span>
                            ) : (
                              <button
                                type="button"
                                className="perm-reset-btn"
                                title={de ? "Auf Standard zurücksetzen" : "Reset to defaults"}
                                disabled={resettingRole === role}
                                onClick={() => void handleReset(role)}
                              >
                                <ResetIcon />
                              </button>
                            )}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {permission_groups.map((group) => (
                      <tr key={`group-${group.key}`} className="perm-group-row">
                        <td className="perm-group-label" colSpan={1}>{group.label}</td>
                        {all_roles.map((role) => {
                          const allOn = groupAllEnabled(group, role);
                          const isLocked = role === "admin";
                          return (
                            <td key={role} className="perm-cell perm-cell--group">
                              <label className="perm-toggle-label" title={
                                isLocked
                                  ? (de ? "Admin-Rolle ist schreibgeschützt" : "Admin role is read-only")
                                  : allOn ? (de ? "Alle deaktivieren" : "Disable all") : (de ? "Alle aktivieren" : "Enable all")
                              }>
                                <input
                                  type="checkbox"
                                  className="perm-checkbox"
                                  checked={allOn}
                                  disabled={isLocked}
                                  onChange={(e) => !isLocked && toggleGroupForRole(group, role, e.target.checked)}
                                />
                              </label>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {permission_groups.flatMap((group) =>
                      group.permissions.map((perm) => (
                        <tr key={perm} className="perm-perm-row">
                          <td
                            className="perm-perm-label"
                            onMouseEnter={(e) => {
                              const desc = permission_descriptions[perm];
                              if (!desc) return;
                              const rect = e.currentTarget.getBoundingClientRect();
                              setPermTooltip({ text: desc, x: rect.left + 16, y: rect.bottom + 6 });
                            }}
                            onMouseLeave={() => setPermTooltip(null)}
                          >
                            {permission_labels[perm] ?? perm}
                            <code className="perm-key">{perm}</code>
                          </td>
                          {all_roles.map((role) => {
                            const isLocked = role === "admin";
                            return (
                              <td key={role} className="perm-cell">
                                <label className="perm-toggle-label"
                                  title={isLocked ? (de ? "Admin-Rolle ist schreibgeschützt" : "Admin role is read-only") : undefined}>
                                  <input
                                    type="checkbox"
                                    className="perm-checkbox"
                                    checked={hasPermission(role, perm)}
                                    disabled={isLocked}
                                    onChange={(e) => !isLocked && void setRolePermission(role, perm, e.target.checked)}
                                  />
                                </label>
                              </td>
                            );
                          })}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Tools ──────────────────────────────────────────────────────────── */}
      {tab === "tools" && (
        <div className="admin-tab-pane">
          {canManageProjectImport && (
            <>
              <div className="admin-settings-card">
                <h4>{de ? "Projektklassen-Template" : "Project class template"}</h4>
                <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.25rem" }}>
                  {de
                    ? "CSV mit Projektklassen, Standard-Materialien und Aufgaben."
                    : "CSV containing project classes, default materials and tasks."}
                </p>
                <div className="row wrap" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <button type="button" onClick={downloadProjectClassTemplateCsv}>
                    {de ? "Template herunterladen" : "Download template"}
                  </button>
                </div>
                <form className="row wrap" style={{ gap: "0.5rem" }} onSubmit={importProjectClassTemplateCsv}>
                  <input type="file" name="file" accept=".csv,text/csv" required />
                  <button type="submit">{de ? "Importieren" : "Import"}</button>
                </form>
              </div>

              <div className="admin-settings-card">
                <h4>{de ? "Projekt-CSV Import" : "Project CSV import"}</h4>
                <div className="row wrap" style={{ gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <button type="button" onClick={downloadProjectCsvTemplate}>
                    {de ? "CSV-Template herunterladen" : "Download CSV template"}
                  </button>
                </div>
                <form className="row wrap" style={{ gap: "0.5rem" }} onSubmit={importProjectsCsv}>
                  <input type="file" name="file" accept=".csv,text/csv" required />
                  <button type="submit">{de ? "CSV importieren" : "Import CSV"}</button>
                </form>
              </div>
            </>
          )}

          {canManageSchoolAbsences && (
            <div className="admin-settings-card">
              <h4>{de ? "Berufsschule verwalten" : "Manage school dates"}</h4>
              <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.25rem" }}>
                {de
                  ? "Schulblöcke oder wiederkehrende Schultage für Mitarbeiter eintragen."
                  : "Add school blocks or recurring school days for employees."}
              </p>
              <form className="modal-form" onSubmit={submitSchoolAbsence}>
                <label>
                  {de ? "Mitarbeiter" : "Employee"}
                  <select
                    value={schoolAbsenceForm.user_id}
                    onChange={(e) => setSchoolAbsenceForm({ ...schoolAbsenceForm, user_id: e.target.value })}
                    required
                  >
                    <option value="">{de ? "Bitte auswählen" : "Please select"}</option>
                    {assignableUsers.map((u) => (
                      <option key={`tools-school-${u.id}`} value={String(u.id)}>
                        {menuUserNameById(u.id, u.display_name || u.full_name)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="row wrap">
                  <label>
                    {de ? "Start" : "Start"}
                    <input
                      type="date"
                      value={schoolAbsenceForm.start_date}
                      onChange={(e) => setSchoolAbsenceForm({ ...schoolAbsenceForm, start_date: e.target.value })}
                      required
                    />
                  </label>
                  <label>
                    {de ? "Ende" : "End"}
                    <input
                      type="date"
                      value={schoolAbsenceForm.end_date}
                      onChange={(e) => setSchoolAbsenceForm({ ...schoolAbsenceForm, end_date: e.target.value })}
                      required
                    />
                  </label>
                </div>
                <div className="weekday-checkbox-group">
                  <small>{de ? "Wiederholung (Mo–Fr)" : "Recurring days (Mon–Fri)"}</small>
                  <div className="weekday-checkbox-row">
                    {[0, 1, 2, 3, 4].map((day) => (
                      <label key={`tools-school-day-${day}`} className="weekday-checkbox-item">
                        <input
                          type="checkbox"
                          checked={schoolAbsenceForm.recurrence_weekdays.includes(day)}
                          onChange={(e) => toggleSchoolRecurrenceWeekday(day, e.target.checked)}
                        />
                        <span>{schoolWeekdayLabel(day, language)}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <label>
                  {de ? "Intervall bis (optional)" : "Recurring until (optional)"}
                  <input
                    type="date"
                    value={schoolAbsenceForm.recurrence_until}
                    onChange={(e) => setSchoolAbsenceForm({ ...schoolAbsenceForm, recurrence_until: e.target.value })}
                  />
                </label>
                <button type="submit">{de ? "Schulzeit speichern" : "Save school date"}</button>
              </form>
            </div>
          )}

          {!canManageProjectImport && !canManageSchoolAbsences && (
            <p className="muted">{de ? "Keine Werkzeuge verfügbar." : "No tools available."}</p>
          )}
        </div>
      )}

      {/* ── Audit log ──────────────────────────────────────────────────────── */}
      {tab === "audit" && (
        <div className="admin-tab-pane">
          <div className="row wrap" style={{ marginBottom: "1rem", gap: "0.75rem", alignItems: "center" }}>
            <details className="admin-audit-filters">
              <summary className="admin-audit-filters-summary">
                <span>{de ? "Filter" : "Filters"}</span>
                {activeAuditFilterCount > 0 && <span className="admin-audit-filter-count">{activeAuditFilterCount}</span>}
                <span className="admin-audit-filter-summary-text">
                  {auditCategoryFilters.length > 0
                    ? `${auditCategoryFilters.length} ${de ? "Kategorie(n)" : "categories"}`
                    : (de ? "Alle Kategorien" : "All categories")}
                  {" · "}
                  {formatAuditPeriodLabel(
                    hasAuditDateFilter ? auditPeriodFilter : "all",
                    de,
                  )}
                </span>
              </summary>
              <div className="admin-audit-filters-panel">
                <div className="admin-audit-filter-group">
                  <span className="admin-audit-filter-label">{de ? "Kategorien" : "Categories"}</span>
                  <div className="admin-audit-filter-options">
                    {auditCategories.map((category) => (
                      <label key={category} className="admin-audit-filter-pill">
                        <input
                          type="checkbox"
                          checked={auditCategoryFilters.includes(category)}
                          onChange={() => toggleAuditCategoryFilter(category)}
                        />
                        <span>{formatAuditCategory(category, de)}</span>
                      </label>
                    ))}
                  </div>
                </div>

                <div className="admin-audit-filter-grid">
                  <div className="admin-audit-filter-group">
                    <label className="admin-audit-filter-field">
                      <span className="admin-audit-filter-label">{de ? "Zeitraum" : "Period"}</span>
                      <select
                        value={auditPeriodFilter}
                        onChange={(e) => setAuditPeriodFilter(e.target.value as AuditPeriodFilter)}
                        aria-label={de ? "Zeitraum filtern" : "Filter by period"}
                      >
                        <option value="all">{de ? "Gesamter Zeitraum" : "All time"}</option>
                        <option value="today">{de ? "Heute" : "Today"}</option>
                        <option value="7d">{de ? "Letzte 7 Tage" : "Last 7 days"}</option>
                        <option value="30d">{de ? "Letzte 30 Tage" : "Last 30 days"}</option>
                        <option value="90d">{de ? "Letzte 90 Tage" : "Last 90 days"}</option>
                        <option value="custom">{de ? "Benutzerdefiniert" : "Custom"}</option>
                      </select>
                    </label>
                  </div>
                </div>

                {auditPeriodFilter === "custom" && (
                  <div className="admin-audit-filter-grid">
                    <label className="admin-audit-filter-field">
                      <span className="admin-audit-filter-label">{de ? "Von" : "From"}</span>
                      <input
                        type="date"
                        value={auditDateFrom}
                        onChange={(e) => setAuditDateFrom(e.target.value)}
                        aria-label={de ? "Startdatum" : "Start date"}
                      />
                    </label>
                    <label className="admin-audit-filter-field">
                      <span className="admin-audit-filter-label">{de ? "Bis" : "To"}</span>
                      <input
                        type="date"
                        value={auditDateTo}
                        onChange={(e) => setAuditDateTo(e.target.value)}
                        aria-label={de ? "Enddatum" : "End date"}
                      />
                    </label>
                  </div>
                )}

                <div className="admin-audit-filter-actions">
                  <button type="button" onClick={clearAuditFilters} disabled={!hasAuditFilters}>
                    {de ? "Filter zurücksetzen" : "Reset filters"}
                  </button>
                </div>
              </div>
            </details>
            <input
              type="search"
              placeholder={de ? "Suche nach Aktion oder Benutzer…" : "Search by action or user…"}
              value={auditSearch}
              onChange={(e) => setAuditSearch(e.target.value)}
              className="admin-audit-search"
            />
            <button type="button" onClick={() => void loadAuditLogs()}>
              {de ? "Aktualisieren" : "Refresh"}
            </button>
            {auditLogs.length > 0 && (
              <span className="muted" style={{ fontSize: "0.82rem" }}>
                {filteredLogs.length}
                {(auditSearch || hasAuditFilters) ? `/${auditLogs.length}` : ""}
                {" "}
                {de ? "Einträge" : "entries"}
              </span>
            )}
          </div>

          {auditLogsLoading && <p className="muted">{de ? "Lädt…" : "Loading…"}</p>}
          {!auditLogsLoading && auditLogs.length === 0 && (
            <p className="muted">{de ? "Keine Protokolleinträge." : "No audit log entries."}</p>
          )}

          {filteredLogs.length > 0 && (
            <div className="table-responsive">
              <table>
                <thead>
                  <tr>
                    <th>{de ? "Zeitpunkt" : "Time"}</th>
                    <th>{de ? "Kategorie" : "Category"}</th>
                    <th>{de ? "Benutzer" : "Actor"}</th>
                    <th>{de ? "Aktion" : "Action"}</th>
                    <th>{de ? "Ziel" : "Target"}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLogs.map((log) => {
                    const actor = log.actor_user_id
                      ? (adminUsersById.get(log.actor_user_id)?.display_name ?? `#${log.actor_user_id}`)
                      : (de ? "System" : "System");
                    const target = log.target_type
                      ? `${log.target_type}${log.target_id != null ? ` · ${log.target_id}` : ""}`
                      : "—";
                    return (
                      <tr key={log.id}>
                        <td className="muted" style={{ whiteSpace: "nowrap", fontSize: "0.8rem" }}>{fmtTs(log.created_at)}</td>
                        <td className="muted" style={{ fontSize: "0.84rem" }}>{formatAuditCategory(log.category, de)}</td>
                        <td>{actor}</td>
                        <td><code className="admin-audit-code">{log.action}</code></td>
                        <td className="muted" style={{ fontSize: "0.84rem" }}>{target}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Settings ───────────────────────────────────────────────────────── */}
      {tab === "settings" && (
        <div className="admin-tab-pane">
          <div className="admin-settings-card">
            <h4>{de ? "SMTP-Mailserver" : "SMTP mail server"}</h4>
            <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.25rem" }}>
              {de
                ? "Wird für Einladungen und Passwort-Reset-E-Mails verwendet."
                : "Used for invite and password reset emails."}
            </p>
            {smtpSettings && (
              <div className="muted" style={{ fontSize: "0.82rem", display: "grid", gap: "0.2rem", marginBottom: "0.75rem" }}>
                <div>
                  {de ? "Status:" : "Status:"}{" "}
                  <code>{smtpSettings.configured ? (de ? "konfiguriert" : "configured") : (de ? "nicht konfiguriert" : "not configured")}</code>
                </div>
                <div>
                  {de ? "Gespeicherter Host:" : "Saved host:"}{" "}
                  <code>{smtpSettings.host || (de ? "nicht gesetzt" : "not set")}</code>
                </div>
                <div>
                  {de ? "Gespeichertes Passwort:" : "Saved password:"}{" "}
                  <code>{smtpSettings.masked_password || (de ? "nicht gesetzt" : "not set")}</code>
                </div>
              </div>
            )}
            <form onSubmit={(e: FormEvent<HTMLFormElement>) => void saveSmtpSettings(e)}>
              <div className="admin-form-row">
                <label>
                  SMTP Host
                  <input
                    type="text"
                    value={smtpSettingsForm.host}
                    onChange={(e) => setSmtpSettingsForm({ ...smtpSettingsForm, host: e.target.value })}
                    placeholder={de ? "z. B. smtp.example.com" : "e.g. smtp.example.com"}
                    autoComplete="off"
                  />
                </label>
                <label>
                  Port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={smtpSettingsForm.port}
                    onChange={(e) => setSmtpSettingsForm({ ...smtpSettingsForm, port: e.target.value })}
                    placeholder="587"
                  />
                </label>
              </div>
              <div className="admin-form-row">
                <label>
                  {de ? "Benutzername" : "Username"}
                  <input
                    type="text"
                    value={smtpSettingsForm.username}
                    onChange={(e) => setSmtpSettingsForm({ ...smtpSettingsForm, username: e.target.value })}
                    placeholder={de ? "Optional" : "Optional"}
                    autoComplete="username"
                  />
                </label>
                <label>
                  {de ? "Neues Passwort" : "New password"}
                  <input
                    type="password"
                    value={smtpSettingsForm.password}
                    onChange={(e) => setSmtpSettingsForm({ ...smtpSettingsForm, password: e.target.value, clear_password: false })}
                    placeholder={de ? "Leer lassen zum Beibehalten" : "Leave blank to keep current"}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <div className="admin-form-row">
                <label>
                  {de ? "Absender-E-Mail" : "Sender email"}
                  <input
                    type="email"
                    value={smtpSettingsForm.from_email}
                    onChange={(e) => setSmtpSettingsForm({ ...smtpSettingsForm, from_email: e.target.value })}
                    placeholder="noreply@example.com"
                    autoComplete="email"
                  />
                </label>
                <label>
                  {de ? "Absender-Name" : "Sender name"}
                  <input
                    type="text"
                    value={smtpSettingsForm.from_name}
                    onChange={(e) => setSmtpSettingsForm({ ...smtpSettingsForm, from_name: e.target.value })}
                    placeholder={de ? "Optional" : "Optional"}
                    autoComplete="off"
                  />
                </label>
              </div>
              <div className="admin-form-row">
                <label className="admin-audit-filter-check">
                  <input
                    type="checkbox"
                    checked={smtpSettingsForm.starttls}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSmtpSettingsForm({
                        ...smtpSettingsForm,
                        starttls: checked,
                        ssl: checked ? false : smtpSettingsForm.ssl,
                      });
                    }}
                  />
                  <span>STARTTLS</span>
                </label>
                <label className="admin-audit-filter-check">
                  <input
                    type="checkbox"
                    checked={smtpSettingsForm.ssl}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSmtpSettingsForm({
                        ...smtpSettingsForm,
                        ssl: checked,
                        starttls: checked ? false : smtpSettingsForm.starttls,
                      });
                    }}
                  />
                  <span>SSL/TLS</span>
                </label>
                <label className="admin-audit-filter-check">
                  <input
                    type="checkbox"
                    checked={smtpSettingsForm.clear_password}
                    onChange={(e) => setSmtpSettingsForm({ ...smtpSettingsForm, clear_password: e.target.checked, password: e.target.checked ? "" : smtpSettingsForm.password })}
                  />
                  <span>{de ? "Gespeichertes Passwort löschen" : "Clear saved password"}</span>
                </label>
              </div>
              <button type="submit" disabled={smtpSettingsSaving}>
                {smtpSettingsSaving ? (de ? "Speichern…" : "Saving…") : (de ? "SMTP speichern" : "Save SMTP")}
              </button>
            </form>
          </div>

          <div className="admin-settings-card">
            <h4>{de ? "Wetter-Integration" : "Weather integration"}</h4>
            <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.25rem" }}>
              {de
                ? "OpenWeather API-Schlüssel für die Baustellenwetter-Karte."
                : "OpenWeather API key for the construction site weather widget."}
            </p>
            {weatherSettings && (
              <p className="muted" style={{ fontSize: "0.82rem" }}>
                {de ? "Aktueller Schlüssel:" : "Current key:"}{" "}
                <code>{weatherSettings.masked_api_key || (de ? "nicht gesetzt" : "not set")}</code>
              </p>
            )}
            <form onSubmit={(e: FormEvent<HTMLFormElement>) => void saveWeatherSettings(e)}>
              <div className="admin-form-row">
                <label>
                  {de ? "Neuer API-Schlüssel" : "New API key"}
                  <input
                    type="password"
                    value={weatherApiKeyInput}
                    onChange={(e) => setWeatherApiKeyInput(e.target.value)}
                    placeholder={de ? "OpenWeather-Schlüssel eingeben" : "Enter OpenWeather API key"}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <button type="submit" disabled={weatherSettingsSaving || weatherApiKeyInput.trim() === ""}>
                {weatherSettingsSaving ? (de ? "Speichern…" : "Saving…") : (de ? "Speichern" : "Save key")}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── System ─────────────────────────────────────────────────────────── */}
      {tab === "system" && (
        <div className="admin-tab-pane">
          <AdminUpdateMenu />
          {canExportBackups && (
            <div className="admin-settings-card">
              <h4>{de ? "Datenbank-Backup" : "Database backup"}</h4>
              <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.25rem" }}>
                {de
                  ? "AES-256-GCM verschlüsseltes Backup erstellen. Eine Schlüsseldatei wird zur Verschlüsselung benötigt."
                  : "Generate an AES-256-GCM encrypted backup. A key file is required for encryption."}
              </p>
              <form onSubmit={(e: FormEvent<HTMLFormElement>) => void exportEncryptedDatabaseBackup(e)}>
                <div className="admin-form-row">
                  <label>
                    {de ? "Schlüsseldatei" : "Key file"}
                    <input type="file" name="key_file" accept="*/*" required />
                  </label>
                </div>
                <button type="submit" disabled={backupExporting}>
                  {backupExporting ? (de ? "Backup läuft…" : "Exporting…") : (de ? "Backup erstellen" : "Create backup")}
                </button>
              </form>
            </div>
          )}
        </div>
      )}
    </section>

    {/* ── Permission description tooltip ─────────────────────────────────── */}
    {permTooltip && (
      <div
        className="perm-tooltip-popup"
        style={{ top: permTooltip.y, left: permTooltip.x }}
      >
        {permTooltip.text}
      </div>
    )}
    </>
  );
}
