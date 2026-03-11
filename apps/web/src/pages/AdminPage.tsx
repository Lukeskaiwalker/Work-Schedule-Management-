import { useState, useEffect, type FormEvent } from "react";
import { useAppContext } from "../context/AppContext";
import { AdminUpdateMenu } from "../components/shared/AdminUpdateMenu";
import type { User, EmployeeGroup } from "../types";

type AdminTab = "users" | "groups" | "roles" | "audit" | "settings" | "system";

const ALL_ROLES: User["role"][] = ["admin", "ceo", "accountant", "planning", "employee"];

function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

type GroupDraft = { name: string; memberIds: Set<number> };

export function AdminPage() {
  const {
    mainView,
    isAdmin,
    language,
    activeAdminUsers,
    archivedAdminUsers,
    adminUsersById,
    updateRole,
    requiredHoursDrafts,
    setRequiredHoursDrafts,
    updateRequiredDailyHours,
    sendInviteToUser,
    sendPasswordResetToUser,
    softDeleteUser,
    restoreArchivedUser,
    inviteCreateForm,
    setInviteCreateForm,
    submitCreateInvite,
    employeeGroups,
    employeeGroupsLoading,
    loadEmployeeGroups,
    createEmployeeGroup,
    updateEmployeeGroup,
    deleteEmployeeGroup,
    auditLogs,
    auditLogsLoading,
    loadAuditLogs,
    rolePermissionsMeta,
    rolePermissionsLoading,
    loadRolePermissions,
    setRolePermission,
    resetRoleToDefaults,
    weatherSettings,
    weatherApiKeyInput,
    setWeatherApiKeyInput,
    weatherSettingsSaving,
    saveWeatherSettings,
    backupExporting,
    exportEncryptedDatabaseBackup,
  } = useAppContext();

  const [tab, setTab] = useState<AdminTab>("users");
  const [showInvite, setShowInvite] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [groupDraft, setGroupDraft] = useState<GroupDraft | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [resettingRole, setResettingRole] = useState<string | null>(null);

  useEffect(() => {
    if (tab === "groups") void loadEmployeeGroups();
    if (tab === "audit") void loadAuditLogs();
    if (tab === "roles") void loadRolePermissions();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (mainView !== "admin" || !isAdmin) return null;

  const de = language === "de";

  const TABS: { id: AdminTab; label: string; count?: number }[] = [
    { id: "users",    label: de ? "Benutzer"       : "Users",     count: activeAdminUsers.length },
    { id: "groups",   label: de ? "Gruppen"        : "Groups" },
    { id: "roles",    label: de ? "Rollen"         : "Roles" },
    { id: "audit",    label: de ? "Protokoll"      : "Audit Log" },
    { id: "settings", label: de ? "Einstellungen"  : "Settings" },
    { id: "system",   label: "System" },
  ];

  // ── Group helpers ─────────────────────────────────────────────────────────

  const openNewGroup = () => {
    setEditingGroupId(null);
    setGroupDraft({ name: "", memberIds: new Set() });
  };

  const openEditGroup = (group: EmployeeGroup) => {
    setEditingGroupId(group.id);
    setGroupDraft({ name: group.name, memberIds: new Set(group.member_user_ids) });
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
      });
    } else {
      await createEmployeeGroup(groupDraft.name.trim(), memberIds);
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

  // ── Audit filter ──────────────────────────────────────────────────────────

  const filteredLogs = auditSearch.trim()
    ? auditLogs.filter((l) => {
        const q = auditSearch.toLowerCase();
        const actor = l.actor_user_id
          ? (adminUsersById.get(l.actor_user_id)?.display_name ?? String(l.actor_user_id))
          : "system";
        return l.action.toLowerCase().includes(q) || actor.toLowerCase().includes(q);
      })
    : auditLogs;

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <section className="card admin-center">
      <h3 className="admin-center-title">
        {de ? "Verwaltungszentrum" : "Admin Center"}
      </h3>

      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
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

      {/* ── Users ────────────────────────────────────────────────────────── */}
      {tab === "users" && (
        <div className="admin-tab-pane">
          {/* Stats */}
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

          {/* Invite form */}
          {!showInvite ? (
            <button type="button" onClick={() => setShowInvite(true)}>
              + {de ? "Benutzer einladen" : "Invite user"}
            </button>
          ) : (
            <form
              className="admin-form-section"
              onSubmit={(e: FormEvent<HTMLFormElement>) => {
                void submitCreateInvite(e);
                setShowInvite(false);
              }}
            >
              <h4 className="admin-form-title">{de ? "Neuer Benutzer" : "New user"}</h4>
              <div className="admin-form-row">
                <label>
                  {de ? "Name" : "Full name"}
                  <input
                    required
                    value={inviteCreateForm.full_name}
                    onChange={(e) =>
                      setInviteCreateForm({ ...inviteCreateForm, full_name: e.target.value })
                    }
                  />
                </label>
                <label>
                  Email
                  <input
                    type="email"
                    required
                    value={inviteCreateForm.email}
                    onChange={(e) =>
                      setInviteCreateForm({ ...inviteCreateForm, email: e.target.value })
                    }
                  />
                </label>
                <label>
                  {de ? "Rolle" : "Role"}
                  <select
                    value={inviteCreateForm.role}
                    onChange={(e) =>
                      setInviteCreateForm({
                        ...inviteCreateForm,
                        role: e.target.value as User["role"],
                      })
                    }
                  >
                    {ALL_ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row" style={{ gap: "0.5rem" }}>
                <button type="submit">
                  ✉ {de ? "Einladen & E-Mail senden" : "Invite & send email"}
                </button>
                <button type="button" onClick={() => setShowInvite(false)}>
                  {de ? "Abbrechen" : "Cancel"}
                </button>
              </div>
            </form>
          )}

          {/* Active user rows */}
          <div className="admin-user-list">
            {activeAdminUsers.map((u) => (
              <div key={u.id} className="admin-user-row">
                <div className="admin-user-avatar" aria-hidden="true">
                  {initials(u.full_name)}
                </div>

                <div className="admin-user-info">
                  <div className="admin-user-name">{u.full_name}</div>
                  <div className="admin-user-meta">
                    <span className="admin-user-email">{u.email}</span>
                    {u.invite_accepted_at == null && u.invite_sent_at != null && (
                      <span className="admin-badge admin-badge--warn">
                        {de ? "Einladung ausstehend" : "Invite pending"}
                      </span>
                    )}
                  </div>
                </div>

                <div className="admin-user-controls">
                  <select
                    value={u.role}
                    className="admin-role-select"
                    onChange={(e) => void updateRole(u.id, e.target.value as User["role"])}
                  >
                    {ALL_ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  <div className="row admin-hours-row">
                    <input
                      type="number"
                      min={1}
                      max={24}
                      step={0.25}
                      value={requiredHoursDrafts[u.id] ?? String(u.required_daily_hours ?? 8)}
                      onChange={(e) =>
                        setRequiredHoursDrafts({ ...requiredHoursDrafts, [u.id]: e.target.value })
                      }
                      className="admin-hours-input"
                      aria-label={de ? "Pflichtarbeitszeit h/Tag" : "Required h/day"}
                    />
                    <span className="muted" style={{ fontSize: "0.78rem" }}>h/d</span>
                    <button
                      type="button"
                      className="admin-save-btn"
                      onClick={() => void updateRequiredDailyHours(u.id)}
                    >
                      {de ? "Spch." : "Save"}
                    </button>
                  </div>
                </div>

                <div className="admin-user-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={de ? "Einladungs-E-Mail senden" : "Send invite email"}
                    onClick={() => void sendInviteToUser(u.id)}
                  >
                    ✉
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={de ? "Passwort zurücksetzen" : "Send password reset"}
                    onClick={() => void sendPasswordResetToUser(u.id)}
                  >
                    🔑
                  </button>
                  <button
                    type="button"
                    className="icon-btn admin-btn-danger"
                    title={de ? "Benutzer archivieren" : "Archive user"}
                    onClick={() => void softDeleteUser(u.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            {activeAdminUsers.length === 0 && (
              <p className="muted">{de ? "Keine aktiven Benutzer." : "No active users."}</p>
            )}
          </div>

          {/* Archived users */}
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
                    <div key={u.id} className="admin-user-row admin-user-row--archived">
                      <div className="admin-user-avatar admin-user-avatar--muted" aria-hidden="true">
                        {initials(u.full_name)}
                      </div>
                      <div className="admin-user-info">
                        <div className="admin-user-name">{u.full_name}</div>
                        <div className="admin-user-email">{u.email} · {u.role}</div>
                      </div>
                      <div />
                      <div className="admin-user-actions">
                        <button type="button" onClick={() => void restoreArchivedUser(u.id)}>
                          {de ? "Wiederherstellen" : "Restore"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Groups ───────────────────────────────────────────────────────── */}
      {tab === "groups" && (
        <div className="admin-tab-pane">
          <div className="row" style={{ marginBottom: "1rem" }}>
            {groupDraft === null && (
              <button type="button" onClick={openNewGroup}>
                + {de ? "Neue Gruppe" : "New group"}
              </button>
            )}
          </div>

          {/* Group form */}
          {groupDraft !== null && (
            <div className="admin-form-section">
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
              <div style={{ marginBottom: "0.75rem" }}>
                <div className="muted" style={{ fontSize: "0.82rem", marginBottom: "0.4rem" }}>
                  {de ? "Mitglieder" : "Members"} ({groupDraft.memberIds.size})
                </div>
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
              <div className="row" style={{ gap: "0.5rem" }}>
                <button type="button" onClick={() => void submitGroupDraft()}>
                  {de ? "Speichern" : "Save"}
                </button>
                <button type="button" onClick={cancelGroupDraft}>
                  {de ? "Abbrechen" : "Cancel"}
                </button>
              </div>
            </div>
          )}

          {/* Group list */}
          {employeeGroupsLoading && (
            <p className="muted">{de ? "Lädt…" : "Loading…"}</p>
          )}
          {!employeeGroupsLoading && employeeGroups.length === 0 && (
            <p className="muted">{de ? "Noch keine Gruppen vorhanden." : "No groups yet."}</p>
          )}
          {employeeGroups.map((group) => (
            <div key={group.id} className="admin-group-card">
              <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <b>{group.name}</b>
                  <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.84rem" }}>
                    {group.members.length}{" "}
                    {de ? "Mitglied(er)" : "member(s)"}
                  </span>
                </div>
                <div className="row" style={{ gap: "0.4rem" }}>
                  <button
                    type="button"
                    className="icon-btn"
                    title={de ? "Bearbeiten" : "Edit"}
                    onClick={() => openEditGroup(group)}
                  >
                    ✏
                  </button>
                  <button
                    type="button"
                    className="icon-btn admin-btn-danger"
                    title={de ? "Löschen" : "Delete"}
                    onClick={() => void deleteEmployeeGroup(group.id)}
                  >
                    ✕
                  </button>
                </div>
              </div>
              {group.members.length > 0 && (
                <div className="admin-group-members">
                  {group.members.map((m) => (
                    <span
                      key={m.user_id}
                      className={`admin-member-chip${m.is_active ? "" : " admin-member-chip--inactive"}`}
                    >
                      {m.display_name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Audit log ────────────────────────────────────────────────────── */}
      {tab === "audit" && (
        <div className="admin-tab-pane">
          <div className="row" style={{ marginBottom: "1rem", gap: "0.75rem", flexWrap: "wrap", alignItems: "center" }}>
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
                {auditSearch ? `/${auditLogs.length}` : ""}{" "}
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
                      ? `${log.target_type}${log.target_id != null ? ` #${log.target_id}` : ""}`
                      : "—";
                    return (
                      <tr key={log.id}>
                        <td className="muted" style={{ whiteSpace: "nowrap", fontSize: "0.8rem" }}>
                          {fmtTs(log.created_at)}
                        </td>
                        <td>{actor}</td>
                        <td>
                          <code className="admin-audit-code">{log.action}</code>
                        </td>
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

      {/* ── Roles ────────────────────────────────────────────────────────── */}
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
            <p className="muted" style={{ padding: "1rem 0" }}>
              {de ? "Lade…" : "Loading…"}
            </p>
          )}

          {rolePermissionsMeta && (() => {
            const { permissions, permission_groups, permission_labels, all_roles } = rolePermissionsMeta;

            // Capitalise role labels for display
            const roleLabel = (r: string) =>
              r.charAt(0).toUpperCase() + r.slice(1);

            // Check if a role's permissions differ from their defaults
            // (we don't track defaults in the meta, so we rely on the admin endpoint
            //  returning the full effective map — we just show a reset button always)
            const hasPermission = (role: string, perm: string) =>
              (permissions[role] ?? []).includes(perm);

            const groupAllEnabled = (group: { permissions: string[] }, role: string) =>
              group.permissions.every((p) => hasPermission(role, p));

            const toggleGroupForRole = (group: { permissions: string[] }, role: string, enable: boolean) => {
              group.permissions.forEach((perm) => {
                const current = hasPermission(role, perm);
                if (current !== enable) {
                  void setRolePermission(role, perm, enable);
                }
              });
            };

            const handleReset = async (role: string) => {
              setResettingRole(role);
              try {
                await resetRoleToDefaults(role);
              } finally {
                setResettingRole(null);
              }
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
                            <button
                              type="button"
                              className="perm-reset-btn"
                              title={de ? "Auf Standard zurücksetzen" : "Reset to defaults"}
                              disabled={resettingRole === role}
                              onClick={() => void handleReset(role)}
                            >
                              {resettingRole === role ? "…" : "↺"}
                            </button>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {permission_groups.map((group) => (
                      <>
                        {/* Group header row with toggle-all checkboxes */}
                        <tr key={`group-${group.key}`} className="perm-group-row">
                          <td className="perm-group-label">{group.label}</td>
                          {all_roles.map((role) => {
                            const allOn = groupAllEnabled(group, role);
                            return (
                              <td key={role} className="perm-cell perm-cell--group">
                                <label className="perm-toggle-label" title={allOn
                                  ? (de ? "Alle deaktivieren" : "Disable all")
                                  : (de ? "Alle aktivieren" : "Enable all")}>
                                  <input
                                    type="checkbox"
                                    className="perm-checkbox"
                                    checked={allOn}
                                    onChange={(e) => toggleGroupForRole(group, role, e.target.checked)}
                                  />
                                </label>
                              </td>
                            );
                          })}
                        </tr>
                        {/* Individual permission rows */}
                        {group.permissions.map((perm) => (
                          <tr key={perm} className="perm-perm-row">
                            <td className="perm-perm-label">
                              {permission_labels[perm] ?? perm}
                              <code className="perm-key">{perm}</code>
                            </td>
                            {all_roles.map((role) => (
                              <td key={role} className="perm-cell">
                                <label className="perm-toggle-label">
                                  <input
                                    type="checkbox"
                                    className="perm-checkbox"
                                    checked={hasPermission(role, perm)}
                                    onChange={(e) => void setRolePermission(role, perm, e.target.checked)}
                                  />
                                </label>
                              </td>
                            ))}
                          </tr>
                        ))}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })()}
        </div>
      )}

      {/* ── Settings ─────────────────────────────────────────────────────── */}
      {tab === "settings" && (
        <div className="admin-tab-pane">
          <div className="admin-settings-card">
            <h4>{de ? "Wetter-Integration" : "Weather integration"}</h4>
            <p className="muted" style={{ fontSize: "0.88rem", marginTop: "0.25rem" }}>
              {de
                ? "OpenWeather API-Schlüssel für die Baustellenwetter-Karte."
                : "OpenWeather API key used for the construction site weather widget."}
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
              <button
                type="submit"
                disabled={weatherSettingsSaving || weatherApiKeyInput.trim() === ""}
              >
                {weatherSettingsSaving
                  ? (de ? "Speichern…" : "Saving…")
                  : (de ? "Speichern" : "Save key")}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ── System ───────────────────────────────────────────────────────── */}
      {tab === "system" && (
        <div className="admin-tab-pane">
          <AdminUpdateMenu />
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
                {backupExporting
                  ? (de ? "Backup läuft…" : "Exporting…")
                  : (de ? "Backup erstellen" : "Create backup")}
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
