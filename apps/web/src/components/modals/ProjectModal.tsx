import { useAppContext } from "../../context/AppContext";
import {
  PROJECT_SITE_ACCESS_PRESETS,
  HHMM_PATTERN,
} from "../../constants";
import {
  statusLabel,
  projectSiteAccessRequiresNote,
  projectSiteAccessLabel,
} from "../../utils/projects";

export function ProjectModal() {
  const {
    language,
    projectModalMode,
    projectForm,
    projectFormBase,
    projectClassTemplates,
    submitProjectForm,
    closeProjectModal,
    updateProjectFormField,
    updateProjectSiteAccessType,
    toggleProjectClassTemplate,
    onProjectModalBackdropPointerDown,
    onProjectModalBackdropPointerUp,
    resetProjectModalBackdropPointerState,
    archiveActiveProject,
    deleteActiveProject,
    projectStatusSelectOptions,
  } = useAppContext();

  if (!projectModalMode) return null;

  return (
    <div
      className="modal-backdrop"
      onPointerDown={onProjectModalBackdropPointerDown}
      onPointerUp={onProjectModalBackdropPointerUp}
      onPointerCancel={resetProjectModalBackdropPointerState}
      onPointerLeave={resetProjectModalBackdropPointerState}
    >
      <div className="card modal-card" onClick={(event) => event.stopPropagation()}>
        <h3>
          {projectModalMode === "create"
            ? language === "de"
              ? "Neues Projekt"
              : "Create new project"
            : language === "de"
              ? "Projekt bearbeiten"
              : "Edit project"}
        </h3>
        <form className="modal-form" onSubmit={submitProjectForm}>
          <label>
            {language === "de" ? "Projektnummer" : "Project number"}
            <input
              value={projectForm.project_number}
              onChange={(event) => updateProjectFormField("project_number", event.target.value)}
              placeholder={language === "de" ? "z.B. 2026-104" : "e.g. 2026-104"}
              required
            />
          </label>
          <label>
            {language === "de" ? "Projektname" : "Project name"}
            <input
              value={projectForm.name}
              onChange={(event) => updateProjectFormField("name", event.target.value)}
              required
            />
          </label>
          <label>
            {language === "de" ? "Status" : "Status"}
            <select
              value={projectForm.status}
              onChange={(event) => updateProjectFormField("status", event.target.value)}
              required
            >
              {projectStatusSelectOptions.map((statusValue) => (
                <option key={statusValue} value={statusValue}>
                  {statusLabel(statusValue, language)}
                </option>
              ))}
            </select>
          </label>
          <div className="project-class-picker">
            <b>{language === "de" ? "Projektklassen" : "Project classes"}</b>
            {projectClassTemplates.length > 0 ? (
              <div className="project-class-grid">
                {projectClassTemplates.map((template) => {
                  const checked = projectForm.class_template_ids.includes(template.id);
                  return (
                    <label key={`project-class-template-${template.id}`} className="project-class-option">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggleProjectClassTemplate(template.id, event.target.checked)}
                      />
                      <span>{template.name}</span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <small className="muted">
                {language === "de"
                  ? "Keine Klassen-Templates vorhanden. Bitte im Admin-Bereich CSV importieren."
                  : "No class templates available. Import a CSV in Admin tools."}
              </small>
            )}
          </div>
          <label>
            {language === "de" ? "Interne Notiz" : "Internal note"}
            <textarea
              value={projectForm.description}
              onChange={(event) => updateProjectFormField("description", event.target.value)}
            />
          </label>
          <label>
            {language === "de" ? "Letzter Stand" : "Last state"}
            <textarea
              value={projectForm.last_state}
              onChange={(event) => updateProjectFormField("last_state", event.target.value)}
            />
          </label>
          <label>
            {language === "de" ? "Letztes Status-Datum" : "Last status update"}
            <input
              type="datetime-local"
              value={projectForm.last_status_at}
              onChange={(event) => updateProjectFormField("last_status_at", event.target.value)}
            />
          </label>
          <label>
            {language === "de" ? "Kunde" : "Customer name"}
            <input
              value={projectForm.customer_name}
              onChange={(event) => updateProjectFormField("customer_name", event.target.value)}
            />
          </label>
          <label>
            {language === "de" ? "Kundenadresse" : "Customer address"}
            <textarea
              value={projectForm.customer_address}
              onChange={(event) => updateProjectFormField("customer_address", event.target.value)}
              placeholder={
                language === "de"
                  ? "Strasse Hausnummer, PLZ Ort, Land"
                  : "Street and number, ZIP City, Country"
              }
            />
            <small className="muted">
              {language === "de"
                ? "Format: Strasse Hausnummer, PLZ Ort, Land"
                : "Format: Street and number, ZIP City, Country"}
            </small>
          </label>
          <label>
            {language === "de" ? "Kontaktperson" : "Contact person"}
            <input
              value={projectForm.customer_contact}
              onChange={(event) => updateProjectFormField("customer_contact", event.target.value)}
            />
          </label>
          <label>
            {language === "de" ? "Kontakt E-Mail" : "Contact email"}
            <input
              type="email"
              value={projectForm.customer_email}
              onChange={(event) => updateProjectFormField("customer_email", event.target.value)}
            />
          </label>
          <label>
            {language === "de" ? "Kontakt Telefon" : "Contact phone"}
            <input
              value={projectForm.customer_phone}
              onChange={(event) => updateProjectFormField("customer_phone", event.target.value)}
            />
          </label>
          <label>
            {language === "de" ? "Zugang zur Baustelle" : "Construction site access"}
            <select
              value={projectForm.site_access_type}
              onChange={(event) => updateProjectSiteAccessType(event.target.value)}
            >
              <option value="">{language === "de" ? "Bitte auswählen" : "Please select"}</option>
              {PROJECT_SITE_ACCESS_PRESETS.map((entry) => (
                <option key={`project-site-access-${entry}`} value={entry}>
                  {projectSiteAccessLabel(entry, language)}
                </option>
              ))}
            </select>
          </label>
          {projectSiteAccessRequiresNote(projectForm.site_access_type) && (
            <label>
              {language === "de" ? "Zusätzliche Info" : "Additional info"}
              <input
                value={projectForm.site_access_note}
                onChange={(event) => updateProjectFormField("site_access_note", event.target.value)}
                placeholder={
                  projectForm.site_access_type === "key_pickup"
                    ? language === "de"
                      ? "z.B. Hausverwaltung, Nachbar, Adresse"
                      : "e.g. building management, neighbor, address"
                    : projectForm.site_access_type === "code_access"
                      ? language === "de"
                        ? "z.B. Türcode, Hinweise"
                        : "e.g. door code, notes"
                      : language === "de"
                        ? "z.B. Position, Bedienhinweis"
                        : "e.g. location, handling note"
                }
              />
            </label>
          )}
          <div className="row wrap">
            <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
            {projectModalMode === "edit" && (
              <button type="button" onClick={() => void archiveActiveProject()}>
                {language === "de" ? "Archivieren" : "Archive"}
              </button>
            )}
            {projectModalMode === "edit" && (
              <button type="button" className="danger-btn" onClick={() => void deleteActiveProject()}>
                {language === "de" ? "Löschen" : "Delete"}
              </button>
            )}
            <button type="button" onClick={closeProjectModal}>
              {language === "de" ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
