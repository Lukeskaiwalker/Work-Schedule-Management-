import { useAppContext } from "../context/AppContext";
import { AvatarBadge } from "../components/shared/AvatarBadge";
import { AdminUpdateMenu } from "../components/shared/AdminUpdateMenu";
import { formatServerDateTime } from "../utils/dates";
import { schoolWeekdayLabel } from "../utils/dates";
import { User } from "../types";

export function ProfilePage() {
  const {
    mainView,
    language,
    user,
    openAvatarModal,
    menuUserNameById,
    userInitials,
    avatarVersionKey,
    profileSettingsForm,
    setProfileSettingsForm,
    saveProfileSettings,
    isAdmin,
    nicknameCheckState,
    nicknameCheckMessage,
    setNicknameCheckState,
    setNicknameCheckMessage,
    canManageProjectImport,
    canManageSchoolAbsences,
    submitCreateInvite,
    inviteCreateForm,
    setInviteCreateForm,
    backupExporting,
    exportEncryptedDatabaseBackup,
    weatherSettings,
    weatherApiKeyInput,
    setWeatherApiKeyInput,
    weatherSettingsSaving,
    saveWeatherSettings,
    downloadProjectClassTemplateCsv,
    importProjectClassTemplateCsv,
    downloadProjectCsvTemplate,
    importProjectsCsv,
    schoolAbsenceForm,
    setSchoolAbsenceForm,
    submitSchoolAbsence,
    assignableUsers,
    toggleSchoolRecurrenceWeekday,
    openAdminViewFromMenu,
    activeAdminUsers,
    updateRole,
    requiredHoursDrafts,
    setRequiredHoursDrafts,
    updateRequiredDailyHours,
    applyTemplate,
    sendInviteToUser,
    sendPasswordResetToUser,
    softDeleteUser,
    archivedAdminUsers,
    restoreArchivedUser,
    adminUserMenuOpenId,
    setAdminUserMenuOpenId,
  } = useAppContext();

  if (mainView !== "profile" || !user) return null;

  return (
    <section className="profile-layout">
      <div className="profile-left-stack">
        <div className="card profile-settings-card">
          <h3>{language === "de" ? "Profil & Einstellungen" : "Profile & settings"}</h3>
          <div className="row wrap profile-head-row">
            <button
              type="button"
              className="profile-avatar-trigger"
              onClick={openAvatarModal}
              aria-label={language === "de" ? "Profilbild ändern" : "Change profile picture"}
              title={language === "de" ? "Profilbild ändern" : "Change profile picture"}
            >
              <AvatarBadge
                userId={user.id}
                initials={userInitials}
                hasAvatar={Boolean(user.avatar_updated_at)}
                versionKey={avatarVersionKey}
                className="profile-avatar"
              />
              <span className="profile-avatar-overlay">{language === "de" ? "Ändern" : "Change"}</span>
            </button>
            <div className="metric-stack">
              <b>{menuUserNameById(user.id, user.display_name || user.full_name)}</b>
              <small>{user.email}</small>
              <small>Role: {user.role}</small>
            </div>
          </div>
          <form className="modal-form" onSubmit={saveProfileSettings}>
            <label>
              {language === "de" ? "Name" : "Name"}
              <input
                value={profileSettingsForm.full_name}
                onChange={(event) =>
                  setProfileSettingsForm({ ...profileSettingsForm, full_name: event.target.value })
                }
                required
              />
            </label>
            <label>
              {language === "de" ? "E-Mail" : "Email"}
              <input
                type="email"
                value={profileSettingsForm.email}
                onChange={(event) =>
                  setProfileSettingsForm({ ...profileSettingsForm, email: event.target.value })
                }
                required
              />
            </label>
            {isAdmin && (
              <label>
                {language === "de" ? "Nickname (optional)" : "Nickname (optional)"}
                <input
                  value={profileSettingsForm.nickname}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setProfileSettingsForm({ ...profileSettingsForm, nickname: nextValue });
                    setNicknameCheckState("idle");
                    setNicknameCheckMessage("");
                  }}
                  placeholder={language === "de" ? "z. B. SiteWolf" : "for example SiteWolf"}
                />
                <small className="muted">
                  {language === "de"
                    ? "Wird in Berichten und Exporten statt des echten Namens verwendet. Leer lassen, um den Nickname zu entfernen."
                    : "Used in reports and exports instead of the real name. Leave empty to remove nickname."}
                </small>
                {nicknameCheckState !== "idle" && nicknameCheckMessage && (
                  <small className="muted">{nicknameCheckMessage}</small>
                )}
              </label>
            )}
            <label>
              {language === "de" ? "Aktuelles Passwort" : "Current password"}
              <input
                type="password"
                value={profileSettingsForm.current_password}
                onChange={(event) =>
                  setProfileSettingsForm({ ...profileSettingsForm, current_password: event.target.value })
                }
                placeholder={language === "de" ? "Nur für E-Mail/Passwort Änderung" : "Needed for email/password changes"}
              />
            </label>
            <label>
              {language === "de" ? "Neues Passwort" : "New password"}
              <input
                type="password"
                minLength={8}
                value={profileSettingsForm.new_password}
                onChange={(event) =>
                  setProfileSettingsForm({ ...profileSettingsForm, new_password: event.target.value })
                }
                placeholder={language === "de" ? "Leer lassen für keine Änderung" : "Leave empty to keep current"}
              />
            </label>
            <div className="row wrap">
              <button type="submit">{language === "de" ? "Profil speichern" : "Save profile"}</button>
            </div>
          </form>
          <small className="muted">
            {language === "de"
              ? "Sprachwechsel und Abmelden sind unten in der Seitenleiste."
              : "Language switch and sign-out are available in the sidebar footer."}
          </small>
        </div>

        {(canManageProjectImport || canManageSchoolAbsences || isAdmin) && (
          <div className="card">
            <h3>{language === "de" ? "Admin Werkzeuge" : "Admin tools"}</h3>
            <AdminUpdateMenu />
            {isAdmin && (
              <div className="metric-stack">
                <b>{language === "de" ? "Einladung senden" : "Send invite"}</b>
                <form className="modal-form" onSubmit={submitCreateInvite}>
                  <label>
                    {language === "de" ? "Name" : "Name"}
                    <input
                      value={inviteCreateForm.full_name}
                      onChange={(event) =>
                        setInviteCreateForm({ ...inviteCreateForm, full_name: event.target.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    {language === "de" ? "E-Mail" : "Email"}
                    <input
                      type="email"
                      value={inviteCreateForm.email}
                      onChange={(event) =>
                        setInviteCreateForm({ ...inviteCreateForm, email: event.target.value })
                      }
                      required
                    />
                  </label>
                  <label>
                    {language === "de" ? "Rolle" : "Role"}
                    <select
                      value={inviteCreateForm.role}
                      onChange={(event) =>
                        setInviteCreateForm({
                          ...inviteCreateForm,
                          role: event.target.value as User["role"],
                        })
                      }
                    >
                      <option value="admin">admin</option>
                      <option value="ceo">ceo</option>
                      <option value="accountant">accountant</option>
                      <option value="planning">planning</option>
                      <option value="employee">employee</option>
                    </select>
                  </label>
                  <button type="submit">{language === "de" ? "Einladung senden" : "Send invite"}</button>
                </form>
              </div>
            )}
            {isAdmin && (
              <div className="metric-stack">
                <b>{language === "de" ? "Datenbank-Backup exportieren" : "Export database backup"}</b>
                <small className="muted">
                  {language === "de"
                    ? "Die Sicherung ist verschlüsselt und kann nur mit derselben Schlüsseldatei entschlüsselt werden."
                    : "Backup is encrypted and can only be decrypted with the same key file."}
                </small>
                <form className="row wrap" onSubmit={exportEncryptedDatabaseBackup}>
                  <input type="file" name="key_file" required />
                  <button type="submit" disabled={backupExporting}>
                    {backupExporting
                      ? language === "de"
                        ? "Export läuft..."
                        : "Exporting..."
                      : language === "de"
                        ? "Backup herunterladen"
                        : "Download backup"}
                  </button>
                </form>
              </div>
            )}
            {canManageProjectImport && (
              <div className="metric-stack">
                <b>{language === "de" ? "OpenWeather API" : "OpenWeather API"}</b>
                  <small className="muted">
                    {language === "de"
                      ? "Schlüssel für die 5-Tage-Projektwettervorhersage."
                      : "Key for 5-day project weather forecast."}
                  </small>
                <small className="muted">
                  {language === "de" ? "Aktuell" : "Current"}:{" "}
                  {weatherSettings?.configured
                    ? weatherSettings.masked_api_key || (language === "de" ? "gesetzt" : "configured")
                    : language === "de"
                      ? "nicht konfiguriert"
                      : "not configured"}
                </small>
                <form className="row wrap" onSubmit={saveWeatherSettings}>
                  <input
                    type="password"
                    value={weatherApiKeyInput}
                    onChange={(event) => setWeatherApiKeyInput(event.target.value)}
                    placeholder={
                      language === "de"
                        ? "Neuen API-Schlüssel eingeben (leer = entfernen)"
                        : "Enter new API key (empty = clear)"
                    }
                  />
                  <button type="submit" disabled={weatherSettingsSaving}>
                    {weatherSettingsSaving
                      ? language === "de"
                        ? "Speichern..."
                        : "Saving..."
                      : language === "de"
                        ? "Speichern"
                        : "Save"}
                  </button>
                </form>
              </div>
            )}
            {canManageProjectImport && (
              <div className="metric-stack">
                <b>{language === "de" ? "Projektklassen-Template" : "Project class template"}</b>
                <small className="muted">
                  {language === "de"
                    ? "CSV mit Projektklassen, Standard-Materialien/Werkzeugen und Aufgaben."
                    : "CSV containing project classes, default materials/tools, and tasks."}
                </small>
                <div className="row wrap">
                  <button type="button" onClick={downloadProjectClassTemplateCsv}>
                    {language === "de" ? "Template herunterladen" : "Download template"}
                  </button>
                </div>
                <form className="row wrap" onSubmit={importProjectClassTemplateCsv}>
                  <input type="file" name="file" accept=".csv,text/csv" required />
                  <button type="submit">{language === "de" ? "Template importieren" : "Import template"}</button>
                </form>
              </div>
            )}
            {canManageProjectImport && (
              <div className="metric-stack">
                <b>{language === "de" ? "Projekt-CSV Import" : "Project CSV import"}</b>
                <div className="row wrap">
                  <button type="button" onClick={downloadProjectCsvTemplate}>
                    {language === "de" ? "CSV-Template herunterladen" : "Download CSV template"}
                  </button>
                </div>
                <form className="row wrap" onSubmit={importProjectsCsv}>
                  <input type="file" name="file" accept=".csv,text/csv" required />
                  <button type="submit">{language === "de" ? "CSV importieren" : "Import CSV"}</button>
                </form>
              </div>
            )}
            {canManageSchoolAbsences && (
              <div className="metric-stack">
                <b>{language === "de" ? "Berufsschule verwalten" : "Manage school dates"}</b>
                <small className="muted">
                  {language === "de"
                    ? "Sie können Schulblöcke oder wiederkehrende Schultage hinzufügen."
                    : "You can add school blocks or recurring school days."}
                </small>
                <form className="modal-form" onSubmit={submitSchoolAbsence}>
                  <label>
                    {language === "de" ? "Mitarbeiter" : "Employee"}
                    <select
                      value={schoolAbsenceForm.user_id}
                      onChange={(event) =>
                        setSchoolAbsenceForm({ ...schoolAbsenceForm, user_id: event.target.value })
                      }
                      required
                    >
                      <option value="">{language === "de" ? "Bitte auswählen" : "Please select"}</option>
                      {assignableUsers.map((entry) => (
                        <option key={`profile-school-user-${entry.id}`} value={String(entry.id)}>
                          {menuUserNameById(entry.id, entry.display_name || entry.full_name)} (#{entry.id})
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="row wrap">
                    <label>
                      {language === "de" ? "Start" : "Start"}
                      <input
                        type="date"
                        value={schoolAbsenceForm.start_date}
                        onChange={(event) =>
                          setSchoolAbsenceForm({ ...schoolAbsenceForm, start_date: event.target.value })
                        }
                        required
                      />
                    </label>
                    <label>
                      {language === "de" ? "Ende" : "End"}
                      <input
                        type="date"
                        value={schoolAbsenceForm.end_date}
                        onChange={(event) =>
                          setSchoolAbsenceForm({ ...schoolAbsenceForm, end_date: event.target.value })
                        }
                        required
                      />
                    </label>
                  </div>
                  <div className="weekday-checkbox-group">
                    <small>{language === "de" ? "Wiederholung (Mo-Fr)" : "Recurring days (Mon-Fri)"}</small>
                    <div className="weekday-checkbox-row">
                      {[0, 1, 2, 3, 4].map((day) => (
                        <label key={`profile-school-day-${day}`} className="weekday-checkbox-item">
                          <input
                            type="checkbox"
                            checked={schoolAbsenceForm.recurrence_weekdays.includes(day)}
                            onChange={(event) => toggleSchoolRecurrenceWeekday(day, event.target.checked)}
                          />
                          <span>{schoolWeekdayLabel(day, language)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <label>
                    {language === "de" ? "Intervall bis (optional)" : "Recurring until (optional)"}
                    <input
                      type="date"
                      value={schoolAbsenceForm.recurrence_until}
                      onChange={(event) =>
                        setSchoolAbsenceForm({ ...schoolAbsenceForm, recurrence_until: event.target.value })
                      }
                    />
                  </label>
                  <button type="submit">{language === "de" ? "Schulzeit speichern" : "Save school date"}</button>
                </form>
              </div>
            )}
          </div>
        )}
      </div>
      {isAdmin && (
        <div className="card profile-admin-center-card">
          <div className="row wrap" style={{ justifyContent: "space-between", alignItems: "center", gap: "0.75rem" }}>
            <div className="metric-stack">
              <h3 style={{ margin: 0 }}>{language === "de" ? "Benutzerverwaltung" : "User administration"}</h3>
              <small className="muted">
                {language === "de"
                  ? "Rollenrechte, Gruppen, Protokoll und Systemeinstellungen sind im vollständigen Admin Center."
                  : "Role permissions, groups, audit log, and system settings are in the full Admin Center."}
              </small>
            </div>
            <button type="button" onClick={openAdminViewFromMenu}>
              {language === "de" ? "Vollständiges Admin Center" : "Open full Admin Center"}
            </button>
          </div>
          <div className="table-responsive">
            <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>{language === "de" ? "Name" : "Name"}</th>
                <th>Email</th>
                <th>{language === "de" ? "Rolle" : "Role"}</th>
                <th>{language === "de" ? "Soll (h/Tag)" : "Required (h/day)"}</th>
                <th>{language === "de" ? "Template" : "Template"}</th>
                <th>{language === "de" ? "Einladung" : "Invite"}</th>
                <th>{language === "de" ? "Aktionen" : "Actions"}</th>
              </tr>
            </thead>
            <tbody>
              {activeAdminUsers.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>
                    <div className="metric-stack">
                      <span>{u.full_name}</span>
                    </div>
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <select value={u.role} onChange={(e) => updateRole(u.id, e.target.value as User["role"])}>
                      <option value="admin">admin</option>
                      <option value="ceo">ceo</option>
                      <option value="accountant">accountant</option>
                      <option value="planning">planning</option>
                      <option value="employee">employee</option>
                    </select>
                  </td>
                  <td>
                    <div className="row wrap admin-required-hours-cell">
                      <input
                        type="number"
                        min={1}
                        max={24}
                        step={0.25}
                        value={requiredHoursDrafts[u.id] ?? String(u.required_daily_hours ?? 8)}
                        onChange={(event) =>
                          setRequiredHoursDrafts({ ...requiredHoursDrafts, [u.id]: event.target.value })
                        }
                      />
                      <button type="button" onClick={() => void updateRequiredDailyHours(u.id)}>
                        {language === "de" ? "Speichern" : "Save"}
                      </button>
                    </div>
                  </td>
                  <td>
                    <button onClick={() => applyTemplate(u.id)}>
                      {language === "de" ? "Default anwenden" : "Apply default"}
                    </button>
                  </td>
                  <td>
                    <small>
                      {u.invite_sent_at
                        ? formatServerDateTime(u.invite_sent_at, language)
                        : "-"}
                    </small>
                    <br />
                    <small className="muted">
                      {u.invite_accepted_at
                        ? language === "de"
                          ? "Angenommen"
                          : "Accepted"
                        : language === "de"
                          ? "Offen"
                          : "Pending"}
                    </small>
                  </td>
                  <td>
                    <div className="admin-actions-menu-wrap">
                      <button
                        type="button"
                        className="admin-actions-trigger"
                        aria-haspopup="menu"
                        aria-expanded={adminUserMenuOpenId === u.id}
                        aria-label={language === "de" ? "Benutzeraktionen öffnen" : "Open user actions"}
                        onClick={() =>
                          setAdminUserMenuOpenId(adminUserMenuOpenId === u.id ? null : u.id)
                        }
                      >
                        &#8942;
                      </button>
                      {adminUserMenuOpenId === u.id && (
                        <div className="admin-actions-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void sendInviteToUser(u.id)}
                          >
                            {u.invite_sent_at
                              ? language === "de"
                                ? "Einladung erneut senden"
                                : "Resend invite"
                              : language === "de"
                                ? "Einladung senden"
                                : "Send invite"}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void sendPasswordResetToUser(u.id)}
                          >
                            {language === "de" ? "Passwort-Reset senden" : "Send reset link"}
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="danger"
                            disabled={u.id === user.id}
                            onClick={() => void softDeleteUser(u.id)}
                          >
                            {language === "de" ? "Benutzer löschen" : "Delete user"}
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {activeAdminUsers.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    {language === "de" ? "Keine aktiven Benutzer." : "No active users."}
                  </td>
                </tr>
              )}
            </tbody>
            </table>
          </div>
          <div className="admin-users-archive">
            <h4>{language === "de" ? "Benutzerarchiv" : "User archive"}</h4>
            <ul className="task-list">
              {archivedAdminUsers.map((u) => (
                <li key={`admin-archive-${u.id}`} className="archive-list-item admin-user-archive-item">
                  <div className="metric-stack">
                    <b>
                      {u.full_name} (#{u.id})
                    </b>
                    <small>{u.email}</small>
                    <small>{u.role}</small>
                  </div>
                  <button type="button" onClick={() => void restoreArchivedUser(u.id)}>
                    {language === "de" ? "Wiederherstellen" : "Restore"}
                  </button>
                </li>
              ))}
              {archivedAdminUsers.length === 0 && (
                <li className="muted">{language === "de" ? "Keine archivierten Benutzer." : "No archived users."}</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
