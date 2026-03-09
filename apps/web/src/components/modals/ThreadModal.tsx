import { useAppContext } from "../../context/AppContext";
import { IMAGE_INPUT_ACCEPT } from "../../constants";
import { roleOptionLabel } from "../../utils/misc";

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

  return (
    <div className="modal-backdrop" onClick={closeThreadModal}>
      <div className="card modal-card modal-card-sm" onClick={(event) => event.stopPropagation()}>
        <h3>
          {threadModalMode === "edit"
            ? language === "de"
              ? "Thread bearbeiten"
              : "Edit thread"
            : language === "de"
              ? "Chat erstellen"
              : "Create chat thread"}
        </h3>
        <form className="modal-form" onSubmit={submitThreadModal}>
          <label>
            {language === "de" ? "Thread-Name" : "Thread name"}
            <input
              name="name"
              value={threadModalForm.name}
              onChange={(event) =>
                setThreadModalForm((current) => ({ ...current, name: event.target.value }))
              }
              placeholder={language === "de" ? "Thread-Name" : "Thread name"}
              required
              autoFocus
            />
          </label>
          <label>
            {language === "de" ? "Projekt (optional)" : "Project (optional)"}
            <select
              value={threadModalForm.project_id}
              onChange={(event) =>
                setThreadModalForm((current) => ({ ...current, project_id: event.target.value }))
              }
            >
              <option value="">{language === "de" ? "Allgemeiner Thread" : "General thread"}</option>
              {projects.map((project) => (
                <option key={`thread-project-${project.id}`} value={String(project.id)}>
                  {projectTitle(project)}
                </option>
              ))}
            </select>
          </label>
          <small className="muted">
            {language === "de"
              ? "Wenn du niemanden auswählst, ist der Chat für alle sichtbar."
              : "If you select nobody, the chat is visible to everyone."}
          </small>
          <div className="assignee-search-block">
            <b>{language === "de" ? "Nutzer (optional)" : "Users (optional)"}</b>
            <input
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
                language === "de"
                  ? "Namen eingeben und auswählen"
                  : "Type user name and select"
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
                    {menuUserNameById(entry.id, entry.display_name || entry.full_name)} (#{entry.id})
                  </button>
                ))}
              </div>
            )}
            <div className="assignee-chip-list">
              {threadModalSelectedUsers.map((entry) => (
                <button
                  key={`thread-user-chip-${entry.id}`}
                  type="button"
                  className="assignee-chip"
                  onClick={() => removeThreadModalUser(entry.id)}
                  title={language === "de" ? "Entfernen" : "Remove"}
                >
                  {entry.label}
                  {entry.archived ? ` (${language === "de" ? "archiviert" : "archived"})` : ""}
                  {" ×"}
                </button>
              ))}
              {threadModalSelectedUsers.length === 0 && (
                <small className="muted">
                  {language === "de"
                    ? "Noch keine Nutzer ausgewählt."
                    : "No users selected yet."}
                </small>
              )}
            </div>
          </div>
          <div className="assignee-search-block">
            <b>{language === "de" ? "Rollen (optional)" : "Roles (optional)"}</b>
            <input
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
              placeholder={
                language === "de"
                  ? "Rolle eingeben und auswählen"
                  : "Type role and select"
              }
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
            <div className="assignee-chip-list">
              {threadModalForm.participant_roles.map((role) => (
                <button
                  key={`thread-role-chip-${role}`}
                  type="button"
                  className="assignee-chip"
                  onClick={() => removeThreadModalRole(role)}
                  title={language === "de" ? "Entfernen" : "Remove"}
                >
                  {roleOptionLabel(role, language) + " ×"}
                </button>
              ))}
              {threadModalForm.participant_roles.length === 0 && (
                <small className="muted">
                  {language === "de"
                    ? "Noch keine Rollen ausgewählt."
                    : "No roles selected yet."}
                </small>
              )}
            </div>
          </div>
          {threadModalIsRestricted && (
            <small className="muted">
              {language === "de"
                ? "Sichtbar nur für ausgewählte Nutzer/Rollen."
                : "Visible only to selected users/roles."}
            </small>
          )}
          <label>
            {language === "de" ? "Thread-Bild" : "Thread picture"}
            <input type="file" accept={IMAGE_INPUT_ACCEPT} onChange={onThreadIconFileChange} />
          </label>
          {threadIconPreviewUrl && (
            <div className="thread-modal-icon-preview">
              <img src={threadIconPreviewUrl} alt="" />
            </div>
          )}
          <div className="row wrap">
            <button type="submit">
              {threadModalMode === "edit"
                ? language === "de"
                  ? "Speichern"
                  : "Save"
                : language === "de"
                  ? "Erstellen"
                  : "Create"}
            </button>
            <button type="button" onClick={closeThreadModal}>
              {language === "de" ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
