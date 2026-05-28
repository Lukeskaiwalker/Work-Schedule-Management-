import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";

/**
 * v2.5.36 — Project Team tab.
 *
 * Manage a project's explicit members: list them, add via a user
 * picker, toggle ``can_manage`` (project-level admin), and remove.
 *
 * Context: the project-member system existed in the DB + one POST
 * endpoint from the start, but had no list/delete endpoints and no UI,
 * so projects (especially imported ones) ended up with zero members —
 * which locked task-assigned employees out until the v2.5.34/35
 * task-assignment access fallback. This tab finally exposes the
 * feature.
 *
 * Access model surfaced to the operator:
 *   - Explicit members listed here always have project access.
 *   - Employees with a *task* assigned in the project ALSO get read
 *     access automatically (v2.5.34) without appearing here — we note
 *     that in the hint so admins don't double-add people unnecessarily.
 *   - Add/remove/can_manage controls render only for users who can
 *     manage projects (projects:manage). Everyone else sees a
 *     read-only roster. The API enforces the same.
 */
export function ProjectTeamTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    projectMembers,
    addProjectMember,
    updateProjectMemberCanManage,
    removeProjectMember,
    assignableUsers,
    canCreateProject,
  } = useAppContext();

  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [grantManage, setGrantManage] = useState(false);

  const de = language === "de";

  // Users not already members — candidates for the add picker.
  const memberIds = useMemo(
    () => new Set(projectMembers.map((m) => m.user_id)),
    [projectMembers],
  );
  const addableUsers = useMemo(
    () => assignableUsers.filter((u) => !memberIds.has(u.id)),
    [assignableUsers, memberIds],
  );

  if (mainView !== "project" || !activeProject || projectTab !== "team") return null;

  function roleLabel(role: string): string {
    const labels: Record<string, { de: string; en: string }> = {
      admin: { de: "Admin", en: "Admin" },
      ceo: { de: "Geschäftsführung", en: "CEO" },
      accountant: { de: "Buchhaltung", en: "Accountant" },
      planning: { de: "Planung", en: "Planning" },
      employee: { de: "Mitarbeiter", en: "Employee" },
    };
    const entry = labels[role];
    return entry ? (de ? entry.de : entry.en) : role;
  }

  async function handleAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userId = Number(selectedUserId);
    if (!Number.isFinite(userId) || userId <= 0) return;
    await addProjectMember(userId, grantManage);
    setSelectedUserId("");
    setGrantManage(false);
  }

  async function handleRemove(userId: number, displayName: string) {
    const confirmed = window.confirm(
      de
        ? `"${displayName}" aus dem Projekt entfernen? Falls dieser Person eine Aufgabe im Projekt zugewiesen ist, behält sie Lesezugriff, bis die Aufgabe entfernt wird.`
        : `Remove "${displayName}" from the project? If they have a task assigned here, they keep read access until the task is unassigned.`,
    );
    if (!confirmed) return;
    await removeProjectMember(userId);
  }

  return (
    <section className="project-team-tab">
      <header className="project-team-head">
        <h2 className="project-team-title">{de ? "Projektteam" : "Project team"}</h2>
        <p className="project-team-hint muted">
          {de
            ? "Mitglieder haben Zugriff auf dieses Projekt. Mitarbeiter mit einer hier zugewiesenen Aufgabe erhalten automatisch Lesezugriff – sie müssen nicht zusätzlich hinzugefügt werden."
            : "Members have access to this project. Employees with a task assigned here automatically get read access — they don't need to be added separately."}
        </p>
      </header>

      {/* ── Add member (managers only) ─────────────────────────────── */}
      {canCreateProject && (
        <form className="project-team-add" onSubmit={handleAdd}>
          <label className="project-team-add-field">
            <span>{de ? "Mitglied hinzufügen" : "Add member"}</span>
            <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
              <option value="">{de ? "Person auswählen…" : "Select a person…"}</option>
              {addableUsers.map((u) => (
                <option key={u.id} value={String(u.id)}>
                  {u.display_name} · {roleLabel(u.role)}
                </option>
              ))}
            </select>
          </label>
          <label className="project-team-add-manage">
            <input
              type="checkbox"
              checked={grantManage}
              onChange={(e) => setGrantManage(e.target.checked)}
            />
            <span>{de ? "Darf verwalten" : "Can manage"}</span>
          </label>
          <button type="submit" disabled={!selectedUserId}>
            {de ? "Hinzufügen" : "Add"}
          </button>
        </form>
      )}

      {/* ── Member list ────────────────────────────────────────────── */}
      {projectMembers.length === 0 ? (
        <p className="project-team-empty muted">
          {de
            ? "Noch keine expliziten Mitglieder. Admins und Geschäftsführung haben ohnehin Zugriff auf alle Projekte."
            : "No explicit members yet. Admins and CEOs can access every project regardless."}
        </p>
      ) : (
        <ul className="project-team-list">
          {projectMembers.map((m) => (
            <li key={m.user_id} className="project-team-row">
              <div className="project-team-row-main">
                <strong className="project-team-row-name">{m.display_name}</strong>
                <span className="project-team-role-badge">{roleLabel(m.role)}</span>
                {m.can_manage && (
                  <span className="project-team-manage-badge">
                    {de ? "Verwalter" : "Manager"}
                  </span>
                )}
              </div>
              {canCreateProject && (
                <div className="project-team-row-actions">
                  <label className="project-team-row-toggle">
                    <input
                      type="checkbox"
                      checked={m.can_manage}
                      onChange={(e) =>
                        void updateProjectMemberCanManage(m.user_id, e.target.checked)
                      }
                    />
                    <span>{de ? "Darf verwalten" : "Can manage"}</span>
                  </label>
                  <button
                    type="button"
                    className="project-team-remove-btn"
                    onClick={() => void handleRemove(m.user_id, m.display_name)}
                  >
                    {de ? "Entfernen" : "Remove"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
