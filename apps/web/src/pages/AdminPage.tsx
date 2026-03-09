import { useAppContext } from "../context/AppContext";
import { AdminUpdateMenu } from "../components/shared/AdminUpdateMenu";
import { User } from "../types";

export function AdminPage() {
  const {
    mainView,
    isAdmin,
    language,
    activeAdminUsers,
    updateRole,
    requiredHoursDrafts,
    setRequiredHoursDrafts,
    updateRequiredDailyHours,
    applyTemplate,
    archivedAdminUsers,
    restoreArchivedUser,
  } = useAppContext();

  if (mainView !== "admin" || !isAdmin) return null;

  return (
    <section className="card">
      <h3>{language === "de" ? "Benutzerverwaltung" : "User administration"}</h3>
      <AdminUpdateMenu />
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>{language === "de" ? "Name" : "Name"}</th>
            <th>Email</th>
            <th>{language === "de" ? "Rolle" : "Role"}</th>
            <th>{language === "de" ? "Soll (h/Tag)" : "Required (h/day)"}</th>
            <th>{language === "de" ? "Template" : "Template"}</th>
          </tr>
        </thead>
        <tbody>
          {activeAdminUsers.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.full_name}</td>
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
            </tr>
          ))}
          {activeAdminUsers.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {language === "de" ? "Keine aktiven Benutzer." : "No active users."}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="admin-users-archive">
        <h4>{language === "de" ? "Benutzerarchiv" : "User archive"}</h4>
        <ul className="task-list">
          {archivedAdminUsers.map((u) => (
            <li key={`admin-view-archive-${u.id}`} className="archive-list-item admin-user-archive-item">
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
    </section>
  );
}
