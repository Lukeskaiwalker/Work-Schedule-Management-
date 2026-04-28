import { useState, useEffect, useRef, type FormEvent } from "react";
import { useAppContext } from "../context/AppContext";
import { AvatarBadge } from "../components/shared/AvatarBadge";
import { AdminUpdateMenu } from "../components/shared/AdminUpdateMenu";
import { AdminBackupsPanel } from "../components/admin/AdminBackupsPanel";
import { MailIcon, KeyIcon, ArchiveUserIcon, ShieldIcon, ResetIcon } from "../components/icons";
import { schoolWeekdayLabel } from "../utils/dates";
import type { User, EmployeeGroup } from "../types";

type AdminTab = "users" | "groups" | "roles" | "tools" | "audit" | "settings" | "system" | "backups";
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

function roleLabel(role: string, de: boolean): string {
  const labels: Record<string, { de: string; en: string }> = {
    admin: { de: "Admin", en: "Admin" },
    ceo: { de: "CEO", en: "CEO" },
    accountant: { de: "Buchhaltung", en: "Accountant" },
    planning: { de: "Planung", en: "Planning" },
    employee: { de: "Mitarbeiter", en: "Employee" },
  };
  return labels[role]?.[de ? "de" : "en"] ?? role;
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
    canManageBackups,
    canRestoreBackups,
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
    companySettingsForm,
    setCompanySettingsForm,
    companySettingsSaving,
    saveCompanySettings,
    smtpSettings,
    smtpSettingsForm,
    setSmtpSettingsForm,
    smtpSettingsSaving,
    saveSmtpSettings,
    sendSmtpTest,
    smtpTestSending,
    smtpTestLastResult,
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
    canExportBackups ||
    canManageBackups ||
    canRestoreBackups;

  const toolsVisible = canManageProjectImport || canManageSchoolAbsences;
  // The legacy "System" tab now hosts only update controls + the legacy
  // DB-only backup form. Full-archive backup management lives in its own tab
  // because the listing/upload/restore UI doesn't fit alongside the update menu.
  const systemVisible = canManageSystem || canExportBackups;
  const backupsVisible = canManageBackups || canRestoreBackups;
  const availableTabs: AdminTab[] = [
    ...(canManageUsers ? (["users", "groups"] as AdminTab[]) : []),
    ...(canManagePermissions ? (["roles"] as AdminTab[]) : []),
    ...(toolsVisible ? (["tools"] as AdminTab[]) : []),
    ...(canViewAudit ? (["audit"] as AdminTab[]) : []),
    ...(canManageSettings ? (["settings"] as AdminTab[]) : []),
    ...(systemVisible ? (["system"] as AdminTab[]) : []),
    ...(backupsVisible ? (["backups"] as AdminTab[]) : []),
  ];

  const [tab, setTab] = useState<AdminTab>(availableTabs[0] ?? "tools");
  const [showArchived, setShowArchived] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<number | null>(null);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditCategoryFilters, setAuditCategoryFilters] = useState<string[]>([]);
  const [auditPeriodFilter, setAuditPeriodFilter] = useState<AuditPeriodFilter>("all");
  const [auditDateFrom, setAuditDateFrom] = useState("");
  const [auditDateTo, setAuditDateTo] = useState("");
  const [resettingRole, setResettingRole] = useState<string | null>(null);
  const [expandedPermUserId, setExpandedPermUserId] = useState<number | null>(null);
  const [permDraft, setPermDraft] = useState<{ extra: Set<string>; denied: Set<string> } | null>(null);
  const [permSaving, setPermSaving] = useState(false);
  const userPermPanelRefs = useRef<Record<number, HTMLDivElement | null>>({});
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

  const ALL_TABS: { id: AdminTab; label: string; visible: boolean }[] = [
    { id: "users", label: de ? "Benutzer" : "Users", visible: canManageUsers },
    { id: "groups", label: de ? "Gruppen" : "Groups", visible: canManageUsers },
    { id: "roles", label: de ? "Rollen" : "Roles", visible: canManagePermissions },
    { id: "tools", label: de ? "Werkzeuge" : "Tools", visible: toolsVisible },
    { id: "audit", label: de ? "Protokoll" : "Audit", visible: canViewAudit },
    { id: "settings", label: de ? "Einstellungen" : "Settings", visible: canManageSettings },
    { id: "system", label: "System", visible: systemVisible },
    { id: "backups", label: de ? "Backups" : "Backups", visible: backupsVisible },
  ];
  const TABS = ALL_TABS.filter((t) => t.visible);

  // ── Group helpers ──────────────────────────────────────────────────────────

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
    const existing = userPermissionOverrides[userId];
    setPermDraft({
      extra: new Set(existing?.extra ?? []),
      denied: new Set(existing?.denied ?? []),
    });
    setExpandedPermUserId(userId);
    if (!rolePermissionsMeta) {
      void loadRolePermissions();
    }
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
      denied.delete(perm);
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
      extra.delete(perm);
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

  const auditCategories = Array.from(new Set(auditLogs.map((log) => log.category).filter(Boolean))).sort();
  const hasCustomAuditDateRange = auditDateFrom.trim() !== "" || auditDateTo.trim() !== "";
  const hasAuditDateFilter = auditPeriodFilter !== "all" && (auditPeriodFilter !== "custom" || hasCustomAuditDateRange);
  const hasAuditFilters = auditCategoryFilters.length > 0 || hasAuditDateFilter;

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
      if (auditDateFrom) start = new Date(`${auditDateFrom}T00:00:00`);
      if (auditDateTo) end = new Date(`${auditDateTo}T23:59:59.999`);
    } else {
      end = new Date();
      end.setHours(23, 59, 59, 999);
      start = new Date(end);
      start.setHours(0, 0, 0, 0);
      if (auditPeriodFilter === "7d") start.setDate(start.getDate() - 6);
      else if (auditPeriodFilter === "30d") start.setDate(start.getDate() - 29);
      else if (auditPeriodFilter === "90d") start.setDate(start.getDate() - 89);
    }

    if (start && !Number.isNaN(start.getTime()) && created < start) return false;
    if (end && !Number.isNaN(end.getTime()) && created > end) return false;
    return true;
  };

  const filteredLogs = auditLogs.filter((l) => {
    if (auditCategoryFilters.length > 0 && !auditCategoryFilters.includes(l.category)) return false;
    if (!isLogWithinAuditDateRange(l.created_at)) return false;
    if (!auditSearch.trim()) return true;
    const q = auditSearch.toLowerCase();
    const actor = l.actor_user_id
      ? (adminUsersById.get(l.actor_user_id)?.display_name ?? String(l.actor_user_id))
      : "system";
    return l.action.toLowerCase().includes(q) || actor.toLowerCase().includes(q);
  });

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <section className="admin-page">
        <h1 className="admin-page-title">{de ? "Verwaltungszentrum" : "Admin Center"}</h1>

        {/* ── Tab bar ────────────────────────────────────────────────────── */}
        <nav
          className="admin-page-tabs"
          role="tablist"
          aria-label={de ? "Verwaltungsbereiche" : "Admin sections"}
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "admin-page-tab active" : "admin-page-tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* ── Users ──────────────────────────────────────────────────────── */}
        {tab === "users" && (
          <div className="admin-page-layout admin-page-layout--users">
            <div className="admin-page-card admin-page-card--users-table">
              <div className="admin-users-table">
                <div className="admin-users-table-head">
                  <div className="admin-users-col admin-users-col--user">
                    {de ? "Benutzer" : "User"}
                  </div>
                  <div className="admin-users-col admin-users-col--role">
                    {de ? "Rolle" : "Role"}
                  </div>
                  <div className="admin-users-col admin-users-col--hours">
                    {de ? "Std./Tag" : "Hours / day"}
                  </div>
                  <div className="admin-users-col admin-users-col--vacation">
                    {de ? "Urlaubstage" : "Vacation days"}
                  </div>
                  <div className="admin-users-col admin-users-col--actions">
                    {de ? "Aktionen" : "Actions"}
                  </div>
                </div>
                <div className="admin-users-table-body">
                  {activeAdminUsers.map((u) => {
                    const isExpanded = expandedUserId === u.id;
                    const isSelf = u.id === user?.id;
                    const hoursDraft =
                      requiredHoursDrafts[u.id] ?? String(u.required_daily_hours ?? 8);
                    const hasHoursChanges =
                      requiredHoursDrafts[u.id] !== undefined &&
                      hoursDraft !== String(u.required_daily_hours ?? 8);
                    const vacDraft = vacationBalanceDrafts[u.id];
                    const vacPerYearValue =
                      vacDraft?.perYear ?? String(u.vacation_days_per_year ?? 0);
                    const vacAvailableValue =
                      vacDraft?.available ?? String(u.vacation_days_available ?? 0);
                    const vacCarryoverValue =
                      vacDraft?.carryover ?? String(u.vacation_days_carryover ?? 0);
                    const totalRemaining = vacDraft
                      ? Number(vacDraft.available ?? 0) + Number(vacDraft.carryover ?? 0)
                      : Number(u.vacation_days_total_remaining ?? 0);
                    const hasCustomPerms =
                      (userPermissionOverrides[u.id]?.extra?.length ?? 0) > 0 ||
                      (userPermissionOverrides[u.id]?.denied?.length ?? 0) > 0;
                    return (
                      <div key={u.id} className="admin-users-row-wrap">
                        <button
                          type="button"
                          className={`admin-users-row${isExpanded ? " admin-users-row--open" : ""}`}
                          onClick={() => setExpandedUserId(isExpanded ? null : u.id)}
                          aria-expanded={isExpanded}
                        >
                          <div className="admin-users-col admin-users-col--user">
                            <AvatarBadge
                              userId={u.id}
                              initials={userInitialsById(u.id)}
                              hasAvatar={userHasAvatar(u.id)}
                              versionKey={userAvatarVersionById(u.id)}
                              className="admin-users-avatar"
                            />
                            <div className="admin-users-user-text">
                              <span className="admin-users-user-name">{u.full_name}</span>
                              <span className="admin-users-user-email">{u.email}</span>
                            </div>
                          </div>
                          <div className="admin-users-col admin-users-col--role">
                            <span className={`admin-role-chip admin-role-chip--${u.role}`}>
                              {roleLabel(u.role, de)}
                            </span>
                          </div>
                          <div className="admin-users-col admin-users-col--hours">
                            {Number(u.required_daily_hours ?? 8).toFixed(1).replace(/\.0$/, "")}
                            <span className="admin-users-unit">h</span>
                          </div>
                          <div className="admin-users-col admin-users-col--vacation">
                            {totalRemaining.toFixed(1).replace(/\.0$/, "")}
                          </div>
                          <div className="admin-users-col admin-users-col--actions">
                            <span
                              className="admin-users-action-icon"
                              title={de ? "Einladungs-E-Mail senden" : "Send invite email"}
                              onClick={(event) => {
                                event.stopPropagation();
                                void sendInviteToUser(u.id);
                              }}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.stopPropagation();
                                  event.preventDefault();
                                  void sendInviteToUser(u.id);
                                }
                              }}
                            >
                              <MailIcon />
                            </span>
                            <span
                              className="admin-users-action-icon admin-users-action-icon--key"
                              title={de ? "Passwort zurücksetzen" : "Send password reset"}
                              onClick={(event) => {
                                event.stopPropagation();
                                void sendPasswordResetToUser(u.id);
                              }}
                              role="button"
                              tabIndex={0}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.stopPropagation();
                                  event.preventDefault();
                                  void sendPasswordResetToUser(u.id);
                                }
                              }}
                            >
                              <KeyIcon />
                            </span>
                          </div>
                        </button>

                        {isExpanded && (
                          <div className="admin-users-detail">
                            {u.invite_accepted_at == null && u.invite_sent_at != null && (
                              <div className="admin-users-detail-banner admin-users-detail-banner--warn">
                                {de ? "Einladung ausstehend" : "Invite pending"}
                              </div>
                            )}
                            {hasCustomPerms && (
                              <div className="admin-users-detail-banner">
                                {de ? "Individuelle Berechtigungen aktiv" : "Custom permissions active"}
                              </div>
                            )}

                            <div className="admin-users-detail-grid">
                              <label className="admin-users-field">
                                <span className="admin-users-field-label">
                                  {de ? "Rolle" : "Role"}
                                </span>
                                <select
                                  className="admin-users-select"
                                  value={u.role}
                                  disabled={isSelf || !canManagePermissions}
                                  onChange={(e) => void updateRole(u.id, e.target.value as User["role"])}
                                  title={
                                    isSelf
                                      ? de ? "Eigene Rolle kann nicht geändert werden" : "Cannot change your own role"
                                      : !canManagePermissions
                                        ? de ? "Rollenänderung erfordert Berechtigung" : "Role changes require permission"
                                        : undefined
                                  }
                                >
                                  {ALL_ROLES.map((r) => (
                                    <option key={r} value={r}>{roleLabel(r, de)}</option>
                                  ))}
                                </select>
                              </label>

                              <label className="admin-users-field">
                                <span className="admin-users-field-label">
                                  {de ? "Ansicht" : "Workspace lock"}
                                </span>
                                <select
                                  className="admin-users-select"
                                  value={u.workspace_lock ?? ""}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    void updateWorkspaceLock(
                                      u.id,
                                      val === "" ? null : (val as "construction" | "office"),
                                    );
                                  }}
                                >
                                  <option value="">{de ? "Frei wählbar" : "User's choice"}</option>
                                  <option value="construction">{de ? "Nur Baustelle" : "Construction only"}</option>
                                  <option value="office">{de ? "Nur Büro" : "Office only"}</option>
                                </select>
                              </label>

                              <div className="admin-users-field admin-users-field--span-2">
                                <span className="admin-users-field-label">
                                  {de ? "Pflichtarbeitszeit" : "Required hours per day"}
                                </span>
                                <div className="admin-users-inline-row">
                                  <input
                                    type="number"
                                    min={1}
                                    max={24}
                                    step={0.25}
                                    value={hoursDraft}
                                    disabled={!canAdjustRequiredHours}
                                    onChange={(e) =>
                                      setRequiredHoursDrafts({
                                        ...requiredHoursDrafts,
                                        [u.id]: e.target.value,
                                      })
                                    }
                                    className="admin-users-input admin-users-input--short"
                                  />
                                  <span className="admin-users-inline-unit">h/d</span>
                                  <button
                                    type="button"
                                    className="admin-users-inline-save"
                                    disabled={!canAdjustRequiredHours || !hasHoursChanges}
                                    onClick={() => void updateRequiredDailyHours(u.id)}
                                  >
                                    {de ? "Speichern" : "Save"}
                                  </button>
                                </div>
                              </div>

                              <div className="admin-users-field admin-users-field--span-2">
                                <span className="admin-users-field-label">
                                  {de ? "Urlaubstage" : "Vacation days"}
                                </span>
                                <div className="admin-users-inline-row admin-users-inline-row--vac">
                                  <label className="admin-users-vac-label">
                                    <span>{de ? "pro Jahr" : "per year"}</span>
                                    <input
                                      type="number"
                                      min={0}
                                      step={0.5}
                                      value={vacPerYearValue}
                                      className="admin-users-input admin-users-input--short"
                                      onChange={(e) =>
                                        setVacationBalanceDrafts((current) => {
                                          const previousPerYear =
                                            current[u.id]?.perYear ?? String(u.vacation_days_per_year ?? 0);
                                          const previousAvailable =
                                            current[u.id]?.available ?? String(u.vacation_days_available ?? 0);
                                          const previousCarryover =
                                            current[u.id]?.carryover ?? String(u.vacation_days_carryover ?? 0);
                                          const initialAvailable = Number(u.vacation_days_available ?? 0);
                                          const initialCarryover = Number(u.vacation_days_carryover ?? 0);
                                          const isInitialSetup =
                                            initialAvailable <= 0 && initialCarryover <= 0;
                                          const shouldAutofillAvailable =
                                            isInitialSetup &&
                                            (current[u.id] === undefined ||
                                              previousAvailable === previousPerYear);
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
                                    />
                                  </label>
                                  <label className="admin-users-vac-label">
                                    <span>{de ? "offen" : "left"}</span>
                                    <input
                                      type="number"
                                      min={0}
                                      step={0.5}
                                      value={vacAvailableValue}
                                      className="admin-users-input admin-users-input--short"
                                      onChange={(e) =>
                                        setVacationBalanceDrafts((current) => ({
                                          ...current,
                                          [u.id]: {
                                            perYear:
                                              current[u.id]?.perYear ?? String(u.vacation_days_per_year ?? 0),
                                            available: e.target.value,
                                            carryover:
                                              current[u.id]?.carryover ?? String(u.vacation_days_carryover ?? 0),
                                          },
                                        }))
                                      }
                                    />
                                  </label>
                                  <label className="admin-users-vac-label">
                                    <span>{de ? "Übertrag" : "carryover"}</span>
                                    <input
                                      type="number"
                                      min={0}
                                      step={0.5}
                                      value={vacCarryoverValue}
                                      className="admin-users-input admin-users-input--short"
                                      onChange={(e) =>
                                        setVacationBalanceDrafts((current) => ({
                                          ...current,
                                          [u.id]: {
                                            perYear:
                                              current[u.id]?.perYear ?? String(u.vacation_days_per_year ?? 0),
                                            available:
                                              current[u.id]?.available ?? String(u.vacation_days_available ?? 0),
                                            carryover: e.target.value,
                                          },
                                        }))
                                      }
                                    />
                                  </label>
                                  <button
                                    type="button"
                                    className="admin-users-inline-save"
                                    onClick={() => void updateVacationBalance(u.id)}
                                  >
                                    {de ? "Speichern" : "Save"}
                                  </button>
                                </div>
                              </div>
                            </div>

                            <div className="admin-users-detail-actions">
                              <button
                                type="button"
                                className={`admin-users-detail-btn${
                                  expandedPermUserId === u.id ? " admin-users-detail-btn--active" : ""
                                }`}
                                disabled={!canManagePermissions}
                                onClick={() => openUserPermPanel(u.id)}
                              >
                                <ShieldIcon />
                                <span>
                                  {de ? "Individuelle Berechtigungen" : "Custom permissions"}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="admin-users-detail-btn admin-users-detail-btn--danger"
                                disabled={isSelf}
                                onClick={() => void softDeleteUser(u.id)}
                              >
                                <ArchiveUserIcon />
                                <span>{de ? "Archivieren" : "Archive"}</span>
                              </button>
                            </div>

                            {expandedPermUserId === u.id && permDraft && rolePermissionsMeta && (
                              <div
                                ref={(node) => {
                                  userPermPanelRefs.current[u.id] = node;
                                }}
                                className="admin-users-perm-panel"
                              >
                                <div className="admin-users-perm-header">
                                  <b>
                                    {de ? "Individuelle Berechtigungen" : "Custom permissions"}
                                  </b>
                                  <small>
                                    {de
                                      ? "Grün = zusätzlich gewährt · Rot = verweigert"
                                      : "Green = extra grant · Red = deny"}
                                  </small>
                                </div>
                                <div className="admin-users-perm-groups">
                                  {rolePermissionsMeta.permission_groups.map((group) => (
                                    <div key={group.key} className="admin-users-perm-group">
                                      <div className="admin-users-perm-group-title">
                                        {group.label}
                                      </div>
                                      {group.permissions.map((perm) => {
                                        const roleHas = (
                                          rolePermissionsMeta.permissions[u.role] ?? []
                                        ).includes(perm);
                                        const isExtra = permDraft.extra.has(perm);
                                        const isDenied = permDraft.denied.has(perm);
                                        const label =
                                          rolePermissionsMeta.permission_labels[perm] ?? perm;
                                        return (
                                          <div
                                            key={perm}
                                            className={`admin-users-perm-row${
                                              isExtra
                                                ? " admin-users-perm-row--extra"
                                                : isDenied
                                                  ? " admin-users-perm-row--deny"
                                                  : ""
                                            }`}
                                          >
                                            <span className="admin-users-perm-label">
                                              {label}
                                              <span
                                                className={`admin-users-perm-dot admin-users-perm-dot--${
                                                  roleHas ? "on" : "off"
                                                }`}
                                              />
                                            </span>
                                            <div className="admin-users-perm-toggles">
                                              <label>
                                                <input
                                                  type="checkbox"
                                                  checked={isExtra}
                                                  onChange={() => togglePermExtra(perm)}
                                                />
                                                <span>{de ? "Gewähren" : "Grant"}</span>
                                              </label>
                                              <label>
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
                                  ))}
                                </div>
                                <div className="admin-users-perm-actions">
                                  <button
                                    type="button"
                                    className="admin-users-inline-save"
                                    disabled={permSaving}
                                    onClick={() => void saveUserPermDraft(u.id)}
                                  >
                                    {permSaving
                                      ? de ? "Speichern…" : "Saving…"
                                      : de ? "Speichern" : "Save"}
                                  </button>
                                  <button
                                    type="button"
                                    className="admin-users-inline-save admin-users-inline-save--ghost"
                                    disabled={permSaving}
                                    onClick={() => void handleResetUserPerms(u.id)}
                                  >
                                    {de ? "Überschreibungen entfernen" : "Remove overrides"}
                                  </button>
                                  <button
                                    type="button"
                                    className="admin-users-inline-save admin-users-inline-save--ghost"
                                    onClick={() => {
                                      setExpandedPermUserId(null);
                                      setPermDraft(null);
                                    }}
                                  >
                                    {de ? "Abbrechen" : "Cancel"}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {activeAdminUsers.length === 0 && (
                    <div className="admin-users-empty">
                      {de ? "Keine aktiven Benutzer." : "No active users."}
                    </div>
                  )}
                </div>
              </div>

              {archivedAdminUsers.length > 0 && (
                <div className="admin-users-archived">
                  <button
                    type="button"
                    className="admin-users-archived-toggle"
                    onClick={() => setShowArchived((v) => !v)}
                  >
                    {showArchived
                      ? (de ? "▾ Archiv ausblenden" : "▾ Hide archive")
                      : (de
                          ? `▸ Archiv anzeigen (${archivedAdminUsers.length})`
                          : `▸ Show archive (${archivedAdminUsers.length})`)}
                  </button>
                  {showArchived && (
                    <div className="admin-users-archived-list">
                      {archivedAdminUsers.map((u) => (
                        <div key={u.id} className="admin-users-archived-row">
                          <AvatarBadge
                            userId={u.id}
                            initials={userInitialsById(u.id)}
                            hasAvatar={userHasAvatar(u.id)}
                            versionKey={userAvatarVersionById(u.id)}
                            className="admin-users-avatar admin-users-avatar--muted"
                          />
                          <div className="admin-users-user-text">
                            <span className="admin-users-user-name">{u.full_name}</span>
                            <span className="admin-users-user-email">
                              {u.email} · {roleLabel(u.role, de)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="admin-users-inline-save admin-users-inline-save--ghost"
                            onClick={() => void restoreArchivedUser(u.id)}
                          >
                            {de ? "Wiederherstellen" : "Restore"}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <aside className="admin-page-card admin-page-card--invite">
              <h2 className="admin-page-card-title">
                {de ? "Neuen Benutzer einladen" : "Invite new user"}
              </h2>
              <form
                className="admin-invite-form"
                onSubmit={(e: FormEvent<HTMLFormElement>) => void submitCreateInvite(e)}
              >
                <label className="admin-invite-field">
                  <span className="admin-invite-field-label">
                    {de ? "Name" : "Full name"}
                  </span>
                  <input
                    required
                    className="admin-invite-input"
                    placeholder={de ? "z. B. Max Müller" : "e.g. Max Müller"}
                    value={inviteCreateForm.full_name}
                    onChange={(e) =>
                      setInviteCreateForm({ ...inviteCreateForm, full_name: e.target.value })
                    }
                  />
                </label>
                <label className="admin-invite-field">
                  <span className="admin-invite-field-label">Email</span>
                  <input
                    required
                    type="email"
                    className="admin-invite-input"
                    placeholder="max@company.de"
                    value={inviteCreateForm.email}
                    onChange={(e) =>
                      setInviteCreateForm({ ...inviteCreateForm, email: e.target.value })
                    }
                  />
                </label>
                <label className="admin-invite-field">
                  <span className="admin-invite-field-label">
                    {de ? "Rolle" : "Role"}
                  </span>
                  <select
                    className="admin-invite-input"
                    value={inviteCreateForm.role}
                    disabled={!canManagePermissions}
                    onChange={(e) =>
                      setInviteCreateForm({
                        ...inviteCreateForm,
                        role: e.target.value as User["role"],
                      })
                    }
                  >
                    {(canManagePermissions ? ALL_ROLES : ["employee"]).map((r) => (
                      <option key={r} value={r}>{roleLabel(r, de)}</option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="admin-invite-submit">
                  {de ? "Einladung senden" : "Send invite"}
                </button>
              </form>
            </aside>
          </div>
        )}

        {/* ── Groups ─────────────────────────────────────────────────────── */}
        {tab === "groups" && (
          <div className="admin-page-layout admin-page-layout--groups">
            <div className="admin-groups-main">
              {employeeGroupsLoading && (
                <div className="admin-page-card admin-page-card--muted">
                  {de ? "Lädt…" : "Loading…"}
                </div>
              )}
              {!employeeGroupsLoading && employeeGroups.length === 0 && (
                <div className="admin-page-card admin-page-card--muted">
                  {de ? "Noch keine Gruppen vorhanden." : "No groups yet."}
                </div>
              )}
              {employeeGroups.map((group) => (
                <div key={group.id} className="admin-page-card admin-group-card">
                  <div className="admin-group-card-head">
                    <h3 className="admin-group-card-title">{group.name}</h3>
                    <div className="admin-group-card-actions">
                      <button
                        type="button"
                        className="admin-group-edit-btn"
                        onClick={() => openEditGroup(group)}
                      >
                        {de ? "Bearbeiten" : "Edit"}
                      </button>
                      <button
                        type="button"
                        className="admin-group-delete-btn"
                        onClick={() => void deleteEmployeeGroup(group.id)}
                      >
                        {de ? "Löschen" : "Delete"}
                      </button>
                    </div>
                  </div>
                  {group.members.length > 0 ? (
                    <div className="admin-group-members">
                      {group.members.map((m) => {
                        const adminUser = adminUsersById.get(m.user_id);
                        return (
                          <span
                            key={m.user_id}
                            className={`admin-group-member-chip${
                              m.is_active ? "" : " admin-group-member-chip--inactive"
                            }`}
                          >
                            <AvatarBadge
                              userId={m.user_id}
                              initials={userInitialsById(m.user_id)}
                              hasAvatar={userHasAvatar(m.user_id)}
                              versionKey={userAvatarVersionById(m.user_id)}
                              className="admin-group-member-avatar"
                            />
                            <span>{adminUser?.display_name || m.display_name}</span>
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="admin-group-empty">
                      {de ? "Keine Mitglieder" : "No members"}
                    </div>
                  )}
                  <div className="admin-group-perm-line">
                    <span
                      className={`admin-group-perm-dot${
                        group.can_update_recent_own_time_entries ? " admin-group-perm-dot--on" : ""
                      }`}
                    />
                    {group.can_update_recent_own_time_entries
                      ? de
                        ? "Darf letzte eigene Zeiteinträge bearbeiten"
                        : "Can edit own recent time entries"
                      : de
                        ? "Keine eigenen Zeiteinträge editieren"
                        : "Cannot edit own time entries"}
                  </div>
                </div>
              ))}
            </div>

            <aside className="admin-page-card admin-page-card--group-form">
              <h2 className="admin-page-card-title">
                {editingGroupId !== null
                  ? de ? "Gruppe bearbeiten" : "Edit group"
                  : de ? "Neue Gruppe" : "New group"}
              </h2>
              <label className="admin-invite-field">
                <span className="admin-invite-field-label">
                  {de ? "Gruppenname" : "Group name"}
                </span>
                <input
                  className="admin-invite-input"
                  placeholder={de ? "z. B. Baustellenführer" : "e.g. Site Supervisors"}
                  value={groupDraft?.name ?? ""}
                  maxLength={120}
                  onChange={(e) => {
                    if (groupDraft) {
                      setGroupDraft({ ...groupDraft, name: e.target.value });
                    } else {
                      setGroupDraft({
                        name: e.target.value,
                        memberIds: new Set(),
                        canUpdateRecentOwnTimeEntries: false,
                      });
                    }
                  }}
                />
              </label>
              <div className="admin-group-form-section">
                <span className="admin-invite-field-label">
                  {de ? "Mitglieder" : "Members"}
                </span>
                <div className="admin-group-member-list">
                  {activeAdminUsers.map((u) => {
                    const checked = groupDraft?.memberIds.has(u.id) ?? false;
                    return (
                      <label key={u.id} className="admin-group-member-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            if (!groupDraft) {
                              setGroupDraft({
                                name: "",
                                memberIds: new Set([u.id]),
                                canUpdateRecentOwnTimeEntries: false,
                              });
                              return;
                            }
                            toggleGroupMember(u.id);
                          }}
                        />
                        <span>{u.display_name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <label className="admin-group-member-check admin-group-member-check--full">
                <input
                  type="checkbox"
                  checked={groupDraft?.canUpdateRecentOwnTimeEntries ?? false}
                  onChange={(e) => {
                    if (!groupDraft) {
                      setGroupDraft({
                        name: "",
                        memberIds: new Set(),
                        canUpdateRecentOwnTimeEntries: e.target.checked,
                      });
                      return;
                    }
                    setGroupDraft({
                      ...groupDraft,
                      canUpdateRecentOwnTimeEntries: e.target.checked,
                    });
                  }}
                />
                <span>
                  {de
                    ? "Darf eigene letzte Zeiteinträge bearbeiten"
                    : "Can edit own recent time entries"}
                </span>
              </label>
              <div className="admin-group-form-actions">
                {editingGroupId !== null && (
                  <button
                    type="button"
                    className="admin-invite-submit admin-invite-submit--ghost"
                    onClick={cancelGroupDraft}
                  >
                    {de ? "Abbrechen" : "Cancel"}
                  </button>
                )}
                <button
                  type="button"
                  className="admin-invite-submit"
                  disabled={!groupDraft || groupDraft.name.trim() === ""}
                  onClick={() => void submitGroupDraft()}
                >
                  {editingGroupId !== null
                    ? de ? "Gruppe speichern" : "Save group"
                    : de ? "Gruppe erstellen" : "Create group"}
                </button>
              </div>
            </aside>
          </div>
        )}

        {/* ── Roles ──────────────────────────────────────────────────────── */}
        {tab === "roles" && (
          <div className="admin-page-card admin-roles-card">
            {rolePermissionsLoading && !rolePermissionsMeta && (
              <p className="admin-page-muted">{de ? "Lade…" : "Loading…"}</p>
            )}
            {rolePermissionsMeta && (() => {
              const { permissions, permission_groups, permission_labels, permission_descriptions, all_roles } =
                rolePermissionsMeta;

              const hasPermission = (role: string, perm: string) =>
                (permissions[role] ?? []).includes(perm);

              const handleReset = async (role: string) => {
                setResettingRole(role);
                try {
                  await resetRoleToDefaults(role);
                } finally {
                  setResettingRole(null);
                }
              };

              return (
                <div className="admin-roles-table-wrap">
                  <table className="admin-roles-table">
                    <thead>
                      <tr>
                        <th className="admin-roles-head admin-roles-head--label">
                          {de ? "Berechtigung" : "Permission"}
                        </th>
                        {all_roles.map((role) => (
                          <th
                            key={role}
                            className={`admin-roles-head admin-roles-head--role admin-roles-head--${role}`}
                          >
                            <div className="admin-roles-head-inner">
                              <span>{roleLabel(role, de)}</span>
                              {role === "admin" ? (
                                <span className="admin-roles-lock" title={de ? "Admin-Rolle ist schreibgeschützt" : "Admin role is read-only"}>
                                  🔒
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  className="admin-roles-reset-btn"
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
                      {permission_groups.flatMap((group) =>
                        group.permissions.map((perm) => (
                          <tr key={perm} className="admin-roles-row">
                            <td
                              className="admin-roles-perm-cell"
                              onMouseEnter={(e) => {
                                const desc = permission_descriptions[perm];
                                if (!desc) return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                setPermTooltip({ text: desc, x: rect.left + 16, y: rect.bottom + 6 });
                              }}
                              onMouseLeave={() => setPermTooltip(null)}
                            >
                              <span className="admin-roles-perm-label">
                                {permission_labels[perm] ?? perm}
                              </span>
                              <code className="admin-roles-perm-key">{perm}</code>
                            </td>
                            {all_roles.map((role) => {
                              const isLocked = role === "admin";
                              const on = hasPermission(role, perm);
                              return (
                                <td key={role} className="admin-roles-cell">
                                  <button
                                    type="button"
                                    className={`admin-roles-check${on ? " admin-roles-check--on" : ""}`}
                                    aria-label={on ? "Enabled" : "Disabled"}
                                    disabled={isLocked}
                                    title={isLocked ? de ? "Schreibgeschützt" : "Read-only" : undefined}
                                    onClick={() => !isLocked && void setRolePermission(role, perm, !on)}
                                  >
                                    {on ? "✓" : "—"}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                </div>
              );
            })()}
          </div>
        )}

        {/* ── Tools ──────────────────────────────────────────────────────── */}
        {tab === "tools" && (
          <div className="admin-page-layout admin-page-layout--tools">
            {canManageProjectImport && (
              <>
                <div className="admin-page-card admin-tools-card">
                  <h2 className="admin-page-card-title">
                    {de ? "Projektklassen-Template" : "Project class template"}
                  </h2>
                  <p className="admin-tools-desc">
                    {de
                      ? "CSV mit Projektklassen, Standard-Materialien und Aufgaben. Template herunterladen, ausfüllen, importieren."
                      : "CSV containing project classes, default materials and tasks. Download the template, fill it in, then import."}
                  </p>
                  <div className="admin-tools-step">
                    <div className="admin-tools-step-label">
                      {de ? "Schritt 1 — Template herunterladen" : "Step 1 — Download template"}
                    </div>
                    <button
                      type="button"
                      className="admin-tools-step-btn"
                      onClick={downloadProjectClassTemplateCsv}
                    >
                      ↓ {de ? "Template herunterladen" : "Download template"}
                    </button>
                  </div>
                  <form className="admin-tools-step" onSubmit={importProjectClassTemplateCsv}>
                    <div className="admin-tools-step-label">
                      {de ? "Schritt 2 — Ausgefüllte CSV importieren" : "Step 2 — Import filled CSV"}
                    </div>
                    <div className="admin-tools-upload">
                      <div className="admin-tools-upload-icon">📄</div>
                      <div className="admin-tools-upload-text">
                        {de ? "CSV-Datei auswählen oder ablegen" : "Choose CSV file or drag & drop"}
                      </div>
                      <label className="admin-tools-upload-btn">
                        <span>{de ? "Datei wählen" : "Browse file"}</span>
                        <input type="file" name="file" accept=".csv,text/csv" required />
                      </label>
                    </div>
                    <button type="submit" className="admin-tools-step-primary">
                      {de ? "Importieren" : "Import"}
                    </button>
                  </form>
                </div>

                <div className="admin-page-card admin-tools-card">
                  <h2 className="admin-page-card-title">
                    {de ? "Projekt-CSV-Import" : "Project CSV import"}
                  </h2>
                  <p className="admin-tools-desc">
                    {de
                      ? "Projekte per CSV-Datei importieren. Template herunterladen, um das erwartete Spaltenformat zu sehen."
                      : "Bulk-import projects from a CSV file. Download the template to see the required column format."}
                  </p>
                  <div className="admin-tools-step">
                    <div className="admin-tools-step-label">
                      {de ? "Schritt 1 — Template herunterladen" : "Step 1 — Download template"}
                    </div>
                    <button
                      type="button"
                      className="admin-tools-step-btn"
                      onClick={downloadProjectCsvTemplate}
                    >
                      ↓ {de ? "CSV-Template herunterladen" : "Download CSV template"}
                    </button>
                  </div>
                  <form className="admin-tools-step" onSubmit={importProjectsCsv}>
                    <div className="admin-tools-step-label">
                      {de ? "Schritt 2 — CSV importieren" : "Step 2 — Import CSV"}
                    </div>
                    <div className="admin-tools-upload">
                      <div className="admin-tools-upload-icon">📄</div>
                      <div className="admin-tools-upload-text">
                        {de ? "CSV-Datei auswählen oder ablegen" : "Choose CSV file or drag & drop"}
                      </div>
                      <label className="admin-tools-upload-btn">
                        <span>{de ? "Datei wählen" : "Browse file"}</span>
                        <input type="file" name="file" accept=".csv,text/csv" required />
                      </label>
                    </div>
                    <button type="submit" className="admin-tools-step-primary">
                      {de ? "CSV importieren" : "Import CSV"}
                    </button>
                  </form>
                </div>
              </>
            )}

            {canManageSchoolAbsences && (
              <div className="admin-page-card admin-tools-card">
                <h2 className="admin-page-card-title">
                  {de ? "Berufsschul-Termine" : "Manage school dates"}
                </h2>
                <p className="admin-tools-desc">
                  {de
                    ? "Schulblöcke oder wiederkehrende Schultage für Auszubildende eintragen."
                    : "Add school blocks or recurring school days for apprentices and trainees."}
                </p>
                <form className="admin-tools-form" onSubmit={submitSchoolAbsence}>
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Mitarbeiter" : "Employee"}
                    </span>
                    <select
                      className="admin-invite-input"
                      value={schoolAbsenceForm.user_id}
                      onChange={(e) =>
                        setSchoolAbsenceForm({ ...schoolAbsenceForm, user_id: e.target.value })
                      }
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
                  <div className="admin-tools-form-row">
                    <label className="admin-invite-field">
                      <span className="admin-invite-field-label">Start</span>
                      <input
                        type="date"
                        className="admin-invite-input"
                        value={schoolAbsenceForm.start_date}
                        onChange={(e) =>
                          setSchoolAbsenceForm({ ...schoolAbsenceForm, start_date: e.target.value })
                        }
                        required
                      />
                    </label>
                    <label className="admin-invite-field">
                      <span className="admin-invite-field-label">End</span>
                      <input
                        type="date"
                        className="admin-invite-input"
                        value={schoolAbsenceForm.end_date}
                        onChange={(e) =>
                          setSchoolAbsenceForm({ ...schoolAbsenceForm, end_date: e.target.value })
                        }
                        required
                      />
                    </label>
                  </div>
                  <div className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Wochentage (Mo–Fr)" : "Recurring days (Mon–Fri)"}
                    </span>
                    <div className="admin-tools-weekday-row">
                      {[0, 1, 2, 3, 4].map((day) => {
                        const checked = schoolAbsenceForm.recurrence_weekdays.includes(day);
                        return (
                          <label
                            key={`tools-school-day-${day}`}
                            className={`admin-tools-weekday-pill${
                              checked ? " admin-tools-weekday-pill--on" : ""
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => toggleSchoolRecurrenceWeekday(day, e.target.checked)}
                            />
                            <span>{schoolWeekdayLabel(day, language)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Wiederholung bis (optional)" : "Recurring until (optional)"}
                    </span>
                    <input
                      type="date"
                      className="admin-invite-input"
                      placeholder={de ? "Leer für einmaligen Block" : "Leave empty for single block"}
                      value={schoolAbsenceForm.recurrence_until}
                      onChange={(e) =>
                        setSchoolAbsenceForm({
                          ...schoolAbsenceForm,
                          recurrence_until: e.target.value,
                        })
                      }
                    />
                  </label>
                  <button type="submit" className="admin-invite-submit">
                    {de ? "Schultermin speichern" : "Save school date"}
                  </button>
                </form>
              </div>
            )}

            {!canManageProjectImport && !canManageSchoolAbsences && (
              <div className="admin-page-card admin-page-card--muted">
                {de ? "Keine Werkzeuge verfügbar." : "No tools available."}
              </div>
            )}
          </div>
        )}

        {/* ── Audit ──────────────────────────────────────────────────────── */}
        {tab === "audit" && (
          <div className="admin-audit-wrap">
            <div className="admin-audit-toolbar">
              <div className="admin-audit-search-wrap">
                <input
                  type="search"
                  className="admin-audit-search"
                  placeholder={de ? "Ereignisse suchen…" : "Search events…"}
                  value={auditSearch}
                  onChange={(e) => setAuditSearch(e.target.value)}
                />
              </div>
              <select
                className="admin-audit-select"
                value={auditPeriodFilter}
                onChange={(e) => setAuditPeriodFilter(e.target.value as AuditPeriodFilter)}
              >
                <option value="all">{formatAuditPeriodLabel("all", de)}</option>
                <option value="today">{formatAuditPeriodLabel("today", de)}</option>
                <option value="7d">{formatAuditPeriodLabel("7d", de)}</option>
                <option value="30d">{formatAuditPeriodLabel("30d", de)}</option>
                <option value="90d">{formatAuditPeriodLabel("90d", de)}</option>
                <option value="custom">{formatAuditPeriodLabel("custom", de)}</option>
              </select>
              <select
                className="admin-audit-select"
                value={auditCategoryFilters[0] ?? "all"}
                onChange={(e) => {
                  const val = e.target.value;
                  setAuditCategoryFilters(val === "all" ? [] : [val]);
                }}
              >
                <option value="all">{de ? "Alle Kategorien" : "All categories"}</option>
                {auditCategories.map((category) => (
                  <option key={category} value={category}>
                    {formatAuditCategory(category, de)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="admin-audit-refresh"
                onClick={() => void loadAuditLogs()}
              >
                {de ? "Aktualisieren" : "Refresh"}
              </button>
              {hasAuditFilters && (
                <button
                  type="button"
                  className="admin-audit-refresh admin-audit-refresh--ghost"
                  onClick={clearAuditFilters}
                >
                  {de ? "Filter löschen" : "Clear filters"}
                </button>
              )}
            </div>

            {auditPeriodFilter === "custom" && (
              <div className="admin-audit-custom-range">
                <label>
                  <span>{de ? "Von" : "From"}</span>
                  <input
                    type="date"
                    value={auditDateFrom}
                    onChange={(e) => setAuditDateFrom(e.target.value)}
                  />
                </label>
                <label>
                  <span>{de ? "Bis" : "To"}</span>
                  <input
                    type="date"
                    value={auditDateTo}
                    onChange={(e) => setAuditDateTo(e.target.value)}
                  />
                </label>
              </div>
            )}

            <div className="admin-page-card admin-audit-card">
              <div className="admin-audit-table-head">
                <div className="admin-audit-col admin-audit-col--time">
                  {de ? "Zeitpunkt" : "Timestamp"}
                </div>
                <div className="admin-audit-col admin-audit-col--cat">
                  {de ? "Kategorie" : "Category"}
                </div>
                <div className="admin-audit-col admin-audit-col--user">
                  {de ? "Benutzer" : "User"}
                </div>
                <div className="admin-audit-col admin-audit-col--event">
                  {de ? "Ereignis" : "Event"}
                </div>
              </div>

              {auditLogsLoading && (
                <div className="admin-page-muted admin-audit-empty">
                  {de ? "Lädt…" : "Loading…"}
                </div>
              )}

              {!auditLogsLoading && filteredLogs.length === 0 && (
                <div className="admin-page-muted admin-audit-empty">
                  {de ? "Keine Einträge gefunden." : "No entries found."}
                </div>
              )}

              {filteredLogs.map((log) => {
                const actor = log.actor_user_id
                  ? (adminUsersById.get(log.actor_user_id)?.display_name ?? `#${log.actor_user_id}`)
                  : (de ? "System" : "System");
                return (
                  <div key={log.id} className="admin-audit-row">
                    <div className="admin-audit-col admin-audit-col--time">{fmtTs(log.created_at)}</div>
                    <div className="admin-audit-col admin-audit-col--cat">
                      <span className={`admin-audit-chip admin-audit-chip--${log.category}`}>
                        {formatAuditCategory(log.category, de)}
                      </span>
                    </div>
                    <div className="admin-audit-col admin-audit-col--user">{actor}</div>
                    <div className="admin-audit-col admin-audit-col--event">
                      <code className="admin-audit-code">{log.action}</code>
                      {log.target_type && (
                        <span className="admin-audit-target">
                          {log.target_type}
                          {log.target_id != null ? ` · ${log.target_id}` : ""}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Settings ───────────────────────────────────────────────────── */}
        {tab === "settings" && (
          <div className="admin-page-layout admin-page-layout--settings">
            <div className="admin-page-card admin-settings-block">
              <h2 className="admin-page-card-title">
                {de ? "Firma" : "Company"}
              </h2>
              <form
                className="admin-settings-form"
                onSubmit={(e: FormEvent<HTMLFormElement>) => void saveCompanySettings(e)}
              >
                <div className="admin-tools-form-row">
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Firmenname" : "Company name"}
                    </span>
                    <input
                      type="text"
                      className="admin-invite-input"
                      value={companySettingsForm.company_name}
                      onChange={(e) =>
                        setCompanySettingsForm({
                          ...companySettingsForm,
                          company_name: e.target.value,
                        })
                      }
                      placeholder="SMPL GmbH"
                    />
                  </label>
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Titel links oben" : "Top-left title"}
                    </span>
                    <input
                      type="text"
                      className="admin-invite-input"
                      value={companySettingsForm.navigation_title}
                      onChange={(e) =>
                        setCompanySettingsForm({
                          ...companySettingsForm,
                          navigation_title: e.target.value,
                        })
                      }
                      placeholder="SMPL"
                    />
                  </label>
                </div>
                <label className="admin-invite-field">
                  <span className="admin-invite-field-label">
                    {de ? "Adresse" : "Address"}
                  </span>
                  <input
                    type="text"
                    className="admin-invite-input"
                    value={companySettingsForm.company_address}
                    onChange={(e) =>
                      setCompanySettingsForm({
                        ...companySettingsForm,
                        company_address: e.target.value,
                      })
                    }
                    placeholder={de ? "Straße, PLZ Ort" : "Street, ZIP City"}
                  />
                </label>
                <label className="admin-invite-field">
                  <span className="admin-invite-field-label">
                    {de ? "Logo-URL oder Datei" : "Logo URL or file"}
                  </span>
                  <input
                    type="text"
                    className="admin-invite-input"
                    value={companySettingsForm.logo_url}
                    onChange={(e) =>
                      setCompanySettingsForm({
                        ...companySettingsForm,
                        logo_url: e.target.value,
                      })
                    }
                    placeholder={de ? "https://… oder Datei wählen" : "https://… or choose file"}
                  />
                </label>
                <div className="admin-tools-form-row">
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Logo hochladen" : "Upload logo"}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      className="admin-invite-input admin-invite-input--file"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          const result =
                            typeof reader.result === "string" ? reader.result : "";
                          setCompanySettingsForm({
                            ...companySettingsForm,
                            logo_url: result,
                          });
                        };
                        reader.readAsDataURL(file);
                      }}
                    />
                  </label>
                  <div className="admin-settings-logo-preview">
                    <img
                      src={companySettingsForm.logo_url.trim() || "/logo.jpeg"}
                      alt={de ? "Logovorschau" : "Logo preview"}
                    />
                  </div>
                </div>
                <button
                  type="submit"
                  className="admin-invite-submit"
                  disabled={companySettingsSaving}
                >
                  {companySettingsSaving
                    ? de ? "Speichern…" : "Saving…"
                    : de ? "Speichern" : "Save"}
                </button>
              </form>
            </div>

            <div className="admin-page-card admin-settings-block">
              <h2 className="admin-page-card-title">Weather API</h2>
              <p className="admin-tools-desc">
                {de
                  ? "OpenWeatherMap API-Schlüssel verbinden, um Live-Wetter auf Projektseiten anzuzeigen."
                  : "Connect an OpenWeatherMap API key to show live weather on project pages."}
              </p>
              <form
                className="admin-settings-form"
                onSubmit={(e: FormEvent<HTMLFormElement>) => void saveWeatherSettings(e)}
              >
                <label className="admin-invite-field">
                  <span className="admin-invite-field-label">API Key</span>
                  <input
                    type="password"
                    className="admin-invite-input"
                    value={weatherApiKeyInput}
                    onChange={(e) => setWeatherApiKeyInput(e.target.value)}
                    placeholder={
                      weatherSettings?.masked_api_key ||
                      (de ? "OpenWeather-Schlüssel eingeben" : "Enter OpenWeather API key")
                    }
                    autoComplete="new-password"
                  />
                </label>
                {weatherSettings?.masked_api_key && (
                  <div className="admin-settings-status">
                    <span className="admin-settings-status-dot admin-settings-status-dot--ok" />
                    {de
                      ? `Verbunden — aktueller Schlüssel ${weatherSettings.masked_api_key}`
                      : `Connected — current key ${weatherSettings.masked_api_key}`}
                  </div>
                )}
                <button
                  type="submit"
                  className="admin-invite-submit"
                  disabled={weatherSettingsSaving || weatherApiKeyInput.trim() === ""}
                >
                  {weatherSettingsSaving
                    ? de ? "Speichern…" : "Saving…"
                    : de ? "Speichern" : "Save"}
                </button>
              </form>
            </div>

            <div className="admin-page-card admin-settings-block">
              <h2 className="admin-page-card-title">Email (SMTP)</h2>
              <form
                className="admin-settings-form"
                onSubmit={(e: FormEvent<HTMLFormElement>) => void saveSmtpSettings(e)}
              >
                <div className="admin-tools-form-row">
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">Host</span>
                    <input
                      type="text"
                      className="admin-invite-input"
                      value={smtpSettingsForm.host}
                      onChange={(e) =>
                        setSmtpSettingsForm({ ...smtpSettingsForm, host: e.target.value })
                      }
                      placeholder="smtp.example.com"
                    />
                  </label>
                  <label className="admin-invite-field admin-invite-field--short">
                    <span className="admin-invite-field-label">Port</span>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      className="admin-invite-input"
                      value={smtpSettingsForm.port}
                      onChange={(e) =>
                        setSmtpSettingsForm({ ...smtpSettingsForm, port: e.target.value })
                      }
                      placeholder="587"
                    />
                  </label>
                </div>
                <div className="admin-tools-form-row">
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Benutzername" : "Username"}
                    </span>
                    <input
                      type="text"
                      className="admin-invite-input"
                      value={smtpSettingsForm.username}
                      onChange={(e) =>
                        setSmtpSettingsForm({ ...smtpSettingsForm, username: e.target.value })
                      }
                      placeholder="noreply@smpl.app"
                    />
                  </label>
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Passwort" : "Password"}
                    </span>
                    <input
                      type="password"
                      className="admin-invite-input"
                      value={smtpSettingsForm.password}
                      onChange={(e) =>
                        setSmtpSettingsForm({
                          ...smtpSettingsForm,
                          password: e.target.value,
                          clear_password: false,
                        })
                      }
                      placeholder={de ? "Leer lassen zum Beibehalten" : "Leave blank to keep current"}
                    />
                  </label>
                </div>
                <div className="admin-tools-form-row">
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Absender-E-Mail" : "Sender email"}
                    </span>
                    <input
                      type="email"
                      className="admin-invite-input"
                      value={smtpSettingsForm.from_email}
                      onChange={(e) =>
                        setSmtpSettingsForm({ ...smtpSettingsForm, from_email: e.target.value })
                      }
                      placeholder="noreply@example.com"
                    />
                  </label>
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Absender-Name" : "Sender name"}
                    </span>
                    <input
                      type="text"
                      className="admin-invite-input"
                      value={smtpSettingsForm.from_name}
                      onChange={(e) =>
                        setSmtpSettingsForm({ ...smtpSettingsForm, from_name: e.target.value })
                      }
                      placeholder="SMPL"
                    />
                  </label>
                </div>
                <div className="admin-settings-checkbox-row">
                  <label className="admin-settings-checkbox">
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
                  <label className="admin-settings-checkbox">
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
                  <label className="admin-settings-checkbox">
                    <input
                      type="checkbox"
                      checked={smtpSettingsForm.clear_password}
                      onChange={(e) =>
                        setSmtpSettingsForm({
                          ...smtpSettingsForm,
                          clear_password: e.target.checked,
                          password: e.target.checked ? "" : smtpSettingsForm.password,
                        })
                      }
                    />
                    <span>{de ? "Gespeichertes Passwort löschen" : "Clear saved password"}</span>
                  </label>
                </div>
                {smtpSettings && (
                  <div className="admin-settings-status admin-settings-status--muted">
                    <span
                      className={`admin-settings-status-dot${
                        smtpSettings.configured ? " admin-settings-status-dot--ok" : ""
                      }`}
                    />
                    {smtpSettings.configured
                      ? de ? "Konfiguriert" : "Configured"
                      : de ? "Nicht konfiguriert" : "Not configured"}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="submit"
                    className="admin-invite-submit"
                    disabled={smtpSettingsSaving}
                  >
                    {smtpSettingsSaving
                      ? de ? "Speichern…" : "Saving…"
                      : de ? "Speichern" : "Save"}
                  </button>
                  <button
                    type="button"
                    className="admin-invite-submit"
                    style={{ background: "#ffffff", color: "#14293d", border: "1px solid #c9d9ea" }}
                    disabled={smtpTestSending || !smtpSettings?.configured}
                    onClick={() => void sendSmtpTest()}
                    title={
                      !smtpSettings?.configured
                        ? de
                          ? "Bitte zuerst speichern und konfigurieren."
                          : "Save and configure SMTP first."
                        : de
                          ? "Sendet eine Testmail an deine eigene Adresse."
                          : "Sends a test email to your own address."
                    }
                  >
                    {smtpTestSending
                      ? de ? "Sende…" : "Sending…"
                      : de ? "Test senden" : "Send test"}
                  </button>
                </div>
                {smtpTestLastResult && (
                  <div
                    className="admin-settings-status admin-settings-status--muted"
                    style={{
                      color: smtpTestLastResult.ok ? "#1a7a45" : "#b91c1c",
                      fontWeight: 500,
                    }}
                  >
                    <span
                      className={`admin-settings-status-dot${
                        smtpTestLastResult.ok ? " admin-settings-status-dot--ok" : ""
                      }`}
                      style={{
                        background: smtpTestLastResult.ok ? "#1a7a45" : "#b91c1c",
                      }}
                    />
                    {smtpTestLastResult.ok
                      ? de
                        ? `Testmail an ${smtpTestLastResult.to_email} gesendet.`
                        : `Test email sent to ${smtpTestLastResult.to_email}.`
                      : (smtpTestLastResult.error_detail ||
                          (de ? "Unbekannter Fehler" : "Unknown error"))}
                  </div>
                )}
              </form>
            </div>
          </div>
        )}

        {/* ── System ─────────────────────────────────────────────────────── */}
        {tab === "system" && (
          <div className="admin-page-layout admin-page-layout--system">
            {canManageSystem && (
              <div className="admin-page-card admin-system-block">
                <h2 className="admin-page-card-title">
                  {de ? "App-Update" : "App update"}
                </h2>
                <AdminUpdateMenu />
              </div>
            )}
            {canExportBackups && (
              <div className="admin-page-card admin-system-block">
                <h2 className="admin-page-card-title">
                  {de ? "Datenbank-Backup" : "Database backup"}
                </h2>
                <p className="admin-tools-desc">
                  {de
                    ? "AES-256-GCM verschlüsseltes Backup der gesamten Datenbank erzeugen. Eine Schlüsseldatei ist erforderlich — separat und sicher aufbewahren."
                    : "Generate an AES-256-GCM encrypted backup of the full database. A key file is required for encryption — keep it in a safe place separate from the backup."}
                </p>
                <div className="admin-system-warning">
                  <span className="admin-system-warning-icon" aria-hidden="true">⚠</span>
                  <span>
                    {de
                      ? "Speichere die Backup-Datei und die Schlüsseldatei getrennt. Ohne Schlüssel kann das Backup nicht entschlüsselt werden."
                      : "Store the backup file and key file separately. The backup cannot be decrypted without the key."}
                  </span>
                </div>
                <form
                  className="admin-settings-form"
                  onSubmit={(e: FormEvent<HTMLFormElement>) =>
                    void exportEncryptedDatabaseBackup(e)
                  }
                >
                  <label className="admin-invite-field">
                    <span className="admin-invite-field-label">
                      {de ? "Schlüsseldatei" : "Key file"}
                    </span>
                    <input
                      type="file"
                      name="key_file"
                      accept="*/*"
                      required
                      className="admin-invite-input admin-invite-input--file"
                    />
                  </label>
                  <button
                    type="submit"
                    className="admin-invite-submit"
                    disabled={backupExporting}
                  >
                    {backupExporting
                      ? de ? "Backup läuft…" : "Exporting…"
                      : de ? "Backup erstellen" : "Create backup"}
                  </button>
                </form>
              </div>
            )}
          </div>
        )}

        {/* ── Backups (full encrypted-archive flow) ──────────────────────── */}
        {tab === "backups" && (
          <div className="admin-page-layout admin-page-layout--system">
            <AdminBackupsPanel />
          </div>
        )}
      </section>

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
