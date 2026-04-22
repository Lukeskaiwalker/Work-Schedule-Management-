import { useAppContext } from "../../context/AppContext";
import { IMAGE_INPUT_ACCEPT } from "../../constants";
import { roleOptionLabel } from "../../utils/misc";

function chipInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const first = parts[0] ?? "";
    return first.slice(0, 2).toUpperCase();
  }
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function ThreadModal() {
  const {
    language,
    threadModalMode,
    mainView,
    threadModalForm,
    setThreadModalForm,
    threadModalUserSuggestions,
    threadModalRoleSuggestions,
    threadModalSelectedUsers,
    threadModalIsRestricted,
    threadIconPreviewUrl,
    projects,
    closeThreadModal,
    submitThreadModal,
    addThreadModalUser,
    removeThreadModalUser,
    addFirstMatchingThreadModalUser,
    addThreadModalRole,
    removeThreadModalRole,
    addFirstMatchingThreadModalRole,
    onThreadIconFileChange,
    menuUserNameById,
    projectTitle,
  } = useAppContext();

  if (!threadModalMode || mainView !== "messages") return null;
  const de = language === "de";
  const isEdit = threadModalMode === "edit";

  return (
    <div className="modal-backdrop" onClick={closeThreadModal}>
      <div
        className="card modal-card task-modal-card"
        onClick={(event) => event.stopPropagation()}
      >
        <form className="task-modal-form" onSubmit={submitThreadModal}>
          <header className="task-modal-head">
            <div className="task-modal-eyebrow">
              <span className="task-modal-eyebrow-label">
                {isEdit
                  ? de
                    ? "THREAD BEARBEITEN"
                    : "EDIT THREAD"
                  : de
                    ? "NEUER CHAT"
                    : "NEW CHAT THREAD"}
              </span>
            </div>
            <h2 className="task-modal-title">
              {threadModalForm.name || (de ? "Neuer Thread" : "New thread")}
            </h2>
          </header>

          {/* Name + Project */}
          <section className="task-modal-section task-modal-section--stack">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Thread-Name" : "Thread name"}
              </span>
              <input
                className="task-modal-input"
                name="name"
                value={threadModalForm.name}
                onChange={(event) =>
                  setThreadModalForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder={de ? "z. B. 2024-021 Schmidt" : "e.g. 2024-021 Schmidt"}
                required
                autoFocus
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Projekt (optional)" : "Project (optional)"}
              </span>
              <select
                className="task-modal-input task-modal-select"
                value={threadModalForm.project_id}
                onChange={(event) =>
                  setThreadModalForm((current) => ({
                    ...current,
                    project_id: event.target.value,
                  }))
                }
              >
                <option value="">{de ? "Allgemeiner Thread" : "General thread"}</option>
                {projects.map((project) => (
                  <option key={`thread-project-${project.id}`} value={String(project.id)}>
                    {projectTitle(project)}
                  </option>
                ))}
              </select>
            </label>
            <small className="task-modal-section-hint">
              {de
                ? "Wenn du niemanden auswählst, ist der Chat für alle sichtbar."
                : "If you select nobody, the chat is visible to everyone."}
            </small>
          </section>

          {/* Users */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "NUTZER (OPTIONAL)" : "USERS (OPTIONAL)"}
              </span>
            </div>
            <div className="task-modal-assignee-picker">
              <input
                className="task-modal-input"
                value={threadModalForm.participant_user_query}
                onChange={(event) =>
                  setThreadModalForm((current) => ({
                    ...current,
                    participant_user_query: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addFirstMatchingThreadModalUser();
                }}
                placeholder={
                  de ? "Namen eingeben und auswählen" : "Type user name and select"
                }
              />
              {threadModalUserSuggestions.length > 0 && (
                <div className="assignee-suggestions">
                  {threadModalUserSuggestions.map((entry) => (
                    <button
                      key={`thread-user-suggestion-${entry.id}`}
                      type="button"
                      className="assignee-suggestion-btn"
                      onClick={() => addThreadModalUser(entry.id)}
                    >
                      {menuUserNameById(entry.id, entry.display_name || entry.full_name)} (#
                      {entry.id})
                    </button>
                  ))}
                </div>
              )}
              <div className="task-modal-assignee-chip-list">
                {threadModalSelectedUsers.map((entry) => (
                  <button
                    key={`thread-user-chip-${entry.id}`}
                    type="button"
                    className="task-modal-assignee-chip"
                    onClick={() => removeThreadModalUser(entry.id)}
                    title={de ? "Entfernen" : "Remove"}
                  >
                    <span className="task-modal-assignee-avatar" aria-hidden="true">
                      {chipInitials(entry.label)}
                    </span>
                    <span className="task-modal-assignee-name">
                      {entry.label}
                      {entry.archived
                        ? ` (${de ? "archiviert" : "archived"})`
                        : ""}
                    </span>
                    <span aria-hidden="true" className="task-modal-assignee-remove">
                      ×
                    </span>
                  </button>
                ))}
                {threadModalSelectedUsers.length === 0 && (
                  <small className="muted">
                    {de ? "Noch keine Nutzer ausgewählt." : "No users selected yet."}
                  </small>
                )}
              </div>
            </div>
          </section>

          {/* Roles */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "ROLLEN (OPTIONAL)" : "ROLES (OPTIONAL)"}
              </span>
            </div>
            <div className="task-modal-assignee-picker">
              <input
                className="task-modal-input"
                value={threadModalForm.participant_role_query}
                onChange={(event) =>
                  setThreadModalForm((current) => ({
                    ...current,
                    participant_role_query: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addFirstMatchingThreadModalRole();
                }}
                placeholder={de ? "Rolle eingeben und auswählen" : "Type role and select"}
              />
              {threadModalRoleSuggestions.length > 0 && (
                <div className="assignee-suggestions">
                  {threadModalRoleSuggestions.map((role) => (
                    <button
                      key={`thread-role-suggestion-${role}`}
                      type="button"
                      className="assignee-suggestion-btn"
                      onClick={() => addThreadModalRole(role)}
                    >
                      {roleOptionLabel(role, language)}
                    </button>
                  ))}
                </div>
              )}
              <div className="task-modal-assignee-chip-list">
                {threadModalForm.participant_roles.map((role) => (
                  <button
                    key={`thread-role-chip-${role}`}
                    type="button"
                    className="task-modal-assignee-chip"
                    onClick={() => removeThreadModalRole(role)}
                    title={de ? "Entfernen" : "Remove"}
                  >
                    <span className="task-modal-assignee-name">
                      {roleOptionLabel(role, language)}
                    </span>
                    <span aria-hidden="true" className="task-modal-assignee-remove">
                      ×
                    </span>
                  </button>
                ))}
                {threadModalForm.participant_roles.length === 0 && (
                  <small className="muted">
                    {de ? "Noch keine Rollen ausgewählt." : "No roles selected yet."}
                  </small>
                )}
              </div>
            </div>
            {threadModalIsRestricted && (
              <small className="task-modal-section-hint">
                {de
                  ? "Sichtbar nur für ausgewählte Nutzer/Rollen."
                  : "Visible only to selected users/roles."}
              </small>
            )}
          </section>

          {/* Thread icon */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "THREAD-BILD" : "THREAD PICTURE"}
              </span>
            </div>
            <div className="thread-modal-icon-picker">
              {threadIconPreviewUrl ? (
                <div className="thread-modal-icon-preview">
                  <img src={threadIconPreviewUrl} alt="" />
                </div>
              ) : (
                <div className="thread-modal-icon-placeholder" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <rect
                      x="3"
                      y="5"
                      width="18"
                      height="14"
                      rx="2"
                      stroke="#8fa2ba"
                      strokeWidth="1.6"
                    />
                    <circle cx="9" cy="11" r="1.8" fill="#8fa2ba" />
                    <path
                      d="m4.5 18 5-5 4 4 3-3 3 3"
                      stroke="#8fa2ba"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              )}
              <label className="thread-modal-icon-upload">
                <span>{de ? "Bild wählen" : "Choose image"}</span>
                <input
                  type="file"
                  accept={IMAGE_INPUT_ACCEPT}
                  onChange={onThreadIconFileChange}
                />
              </label>
            </div>
          </section>

          <footer className="task-modal-footer">
            <button
              type="button"
              className="task-modal-btn task-modal-btn--ghost"
              onClick={closeThreadModal}
            >
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button type="submit" className="task-modal-btn task-modal-btn--primary">
              {isEdit
                ? de
                  ? "Speichern"
                  : "Save"
                : de
                  ? "Thread erstellen"
                  : "Create thread"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
