import { useMemo } from "react";
import { useAppContext } from "../../context/AppContext";
import { PROJECT_SITE_ACCESS_PRESETS } from "../../constants";
import {
  statusLabel,
  projectSiteAccessRequiresNote,
  projectSiteAccessLabel,
  isArchivedProjectStatus,
} from "../../utils/projects";
import { CustomerCombobox } from "../customers/CustomerCombobox";

function statusDotColor(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "active") return "#6EA54F";
  if (normalized === "planning") return "#F5B000";
  if (normalized === "on_hold" || normalized === "hold") return "#8FA2BA";
  if (normalized === "completed" || normalized === "done") return "#2F70B7";
  if (normalized === "archived") return "#9AAEC4";
  return "#2F70B7";
}

export function ProjectModal() {
  const {
    language,
    projectModalMode,
    projectForm,
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
    activeProject,
    unarchiveProject,
    customers,
    openCustomerModal,
  } = useAppContext();

  // Resolve the currently linked customer (if any) so we can render the
  // read-only Stammdaten summary below the combobox.
  const linkedCustomer = useMemo(() => {
    if (projectForm.customer_id === null) return null;
    return customers.find((row) => row.id === projectForm.customer_id) ?? null;
  }, [projectForm.customer_id, customers]);

  if (!projectModalMode) return null;

  const de = language === "de";
  const isEditMode = projectModalMode === "edit";
  const eyebrowLabel = isEditMode
    ? de
      ? "PROJEKT BEARBEITEN"
      : "EDIT PROJECT"
    : de
      ? "NEUES PROJEKT"
      : "NEW PROJECT";
  const projectRef = projectForm.project_number
    ? `#${projectForm.project_number}`
    : de
      ? "Neues Projekt"
      : "New project";
  const titleText = projectForm.name && projectForm.name.trim().length > 0
    ? projectForm.name
    : de
      ? "Neues Projekt"
      : "New project";

  return (
    <div
      className="modal-backdrop"
      onPointerDown={onProjectModalBackdropPointerDown}
      onPointerUp={onProjectModalBackdropPointerUp}
      onPointerCancel={resetProjectModalBackdropPointerState}
      onPointerLeave={resetProjectModalBackdropPointerState}
    >
      <div
        className="card modal-card task-modal-card project-modal-card"
        onClick={(event) => event.stopPropagation()}
      >
        <form className="task-modal-form" onSubmit={submitProjectForm}>
          <header className="task-modal-head">
            <div className="task-modal-eyebrow">
              <span className="task-modal-eyebrow-label">{eyebrowLabel}</span>
              <span aria-hidden="true" className="task-modal-eyebrow-sep">
                ·
              </span>
              <span className="task-modal-eyebrow-project">{projectRef}</span>
            </div>
            <h2 className="task-modal-title">{titleText}</h2>
          </header>

          {/* Project number / Project name / Status */}
          <section className="task-modal-section project-modal-grid-number-name-status">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Projektnummer" : "Project number"}
              </span>
              <input
                className="task-modal-input"
                value={projectForm.project_number}
                onChange={(event) => updateProjectFormField("project_number", event.target.value)}
                placeholder={de ? "z. B. 2026-104" : "e.g. 2026-104"}
                required
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Projektname" : "Project name"}</span>
              <input
                className="task-modal-input"
                value={projectForm.name}
                onChange={(event) => updateProjectFormField("name", event.target.value)}
                required
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Status" : "Status"}</span>
              <div className="task-modal-priority-wrap">
                <span
                  className="task-modal-priority-dot"
                  aria-hidden="true"
                  style={{ backgroundColor: statusDotColor(projectForm.status) }}
                />
                <select
                  className="task-modal-input task-modal-select task-modal-priority-select"
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
              </div>
            </label>
          </section>

          {/* Project classes */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "PROJEKTKLASSEN" : "PROJECT CLASSES"}
              </span>
              {projectClassTemplates.length === 0 && (
                <span className="task-modal-section-hint">
                  {de ? "Keine Klassen konfiguriert" : "No classes configured"}
                </span>
              )}
            </div>
            {projectClassTemplates.length > 0 ? (
              <div className="project-modal-class-chips">
                {projectClassTemplates.map((template) => {
                  const checked = projectForm.class_template_ids.includes(template.id);
                  return (
                    <button
                      key={`project-class-${template.id}`}
                      type="button"
                      className={`project-modal-class-chip${checked ? " project-modal-class-chip--active" : ""}`}
                      onClick={() => toggleProjectClassTemplate(template.id, !checked)}
                      aria-pressed={checked}
                    >
                      {checked && (
                        <span aria-hidden="true" className="project-modal-class-chip-check">
                          ✓
                        </span>
                      )}
                      <span>{template.name}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <small className="muted">
                {de
                  ? "Keine Klassen-Templates vorhanden. Bitte im Admin-Bereich CSV importieren."
                  : "No class templates available. Import a CSV in Admin tools."}
              </small>
            )}
          </section>

          {/* Internal note / Last state */}
          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Interne Notiz" : "Internal note"}
              </span>
              <textarea
                className="task-modal-input task-modal-textarea"
                value={projectForm.description}
                onChange={(event) => updateProjectFormField("description", event.target.value)}
                rows={4}
                placeholder={de ? "Interne Hinweise für das Team" : "Internal notes for the team"}
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Letzter Stand" : "Last state"}</span>
              <textarea
                className="task-modal-input task-modal-textarea"
                value={projectForm.last_state}
                onChange={(event) => updateProjectFormField("last_state", event.target.value)}
                rows={4}
                placeholder={de ? "Aktueller Fortschritt" : "Current progress"}
              />
            </label>
          </section>

          {/* ── Customer ──
              Replaces the old 5-input block (name/contact/email/phone/
              address). The combobox binds to `customer_id`; when a row is
              picked we copy its Stammdaten into the snapshot fields so the
              legacy payload still carries them. Free-text typing keeps
              `customer_id` null and writes to `customer_name` — the backend
              will match-or-create on save. */}
          <section className="task-modal-section task-modal-section--stack">
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Kunde" : "Customer"}</span>
              <CustomerCombobox
                language={de ? "de" : "en"}
                customers={customers}
                value={{
                  customerId: projectForm.customer_id,
                  customerName: projectForm.customer_name,
                }}
                onChange={(next) => {
                  if (next.customerId !== null) {
                    const picked = customers.find((row) => row.id === next.customerId);
                    if (picked) {
                      updateProjectFormField("customer_id", picked.id);
                      updateProjectFormField("customer_name", picked.name);
                      updateProjectFormField("customer_address", picked.address ?? "");
                      updateProjectFormField("customer_contact", picked.contact_person ?? "");
                      updateProjectFormField("customer_email", picked.email ?? "");
                      updateProjectFormField("customer_phone", picked.phone ?? "");
                      return;
                    }
                  }
                  // Free-text path — keep id null so backend does match-or-create.
                  updateProjectFormField("customer_id", null);
                  updateProjectFormField("customer_name", next.customerName);
                }}
                onRequestCreate={(prefillName) => {
                  openCustomerModal({
                    prefillName,
                    onSaved: (saved) => {
                      // Auto-select the freshly-created customer and copy
                      // the Stammdaten snapshot into the project draft.
                      updateProjectFormField("customer_id", saved.id);
                      updateProjectFormField("customer_name", saved.name);
                      updateProjectFormField("customer_address", saved.address ?? "");
                      updateProjectFormField("customer_contact", saved.contact_person ?? "");
                      updateProjectFormField("customer_email", saved.email ?? "");
                      updateProjectFormField("customer_phone", saved.phone ?? "");
                    },
                  });
                }}
              />
              {!linkedCustomer && projectForm.customer_name && (
                <small className="task-modal-field-hint">
                  {de
                    ? "Freitext: beim Speichern wird der Kunde erstellt oder verknüpft."
                    : "Free text: the backend will match or create the customer on save."}
                </small>
              )}
            </label>

            {linkedCustomer && (
              <div
                className="customer-snapshot"
                aria-label={de ? "Kunden-Stammdaten" : "Customer master data"}
              >
                <div className="customer-snapshot-head">
                  <span className="customer-snapshot-badge">
                    {de ? "Vom Kunden · Stammdaten" : "From customer · master data"}
                  </span>
                </div>
                <dl className="customer-snapshot-grid">
                  <div className="customer-snapshot-row">
                    <dt>{de ? "Adresse" : "Address"}</dt>
                    <dd>{linkedCustomer.address ?? "—"}</dd>
                  </div>
                  <div className="customer-snapshot-row">
                    <dt>{de ? "Ansprechpartner" : "Contact"}</dt>
                    <dd>{linkedCustomer.contact_person ?? "—"}</dd>
                  </div>
                  <div className="customer-snapshot-row">
                    <dt>{de ? "E-Mail" : "Email"}</dt>
                    <dd>{linkedCustomer.email ?? "—"}</dd>
                  </div>
                  <div className="customer-snapshot-row">
                    <dt>{de ? "Telefon" : "Phone"}</dt>
                    <dd>{linkedCustomer.phone ?? "—"}</dd>
                  </div>
                </dl>
              </div>
            )}

            {/* Advanced: separate construction-site address. Hidden until
                the user opts in — keeps the default flow simple. */}
            <label className="customer-site-toggle">
              <input
                type="checkbox"
                checked={projectForm.use_separate_site_address}
                onChange={(event) =>
                  updateProjectFormField(
                    "use_separate_site_address",
                    event.target.checked,
                  )
                }
              />
              <span className="customer-site-toggle-text">
                <strong className="customer-site-toggle-title">
                  {de
                    ? "Abweichende Projekt-/Baustellenadresse verwenden"
                    : "Use a separate project / construction site address"}
                </strong>
                <small className="customer-site-toggle-desc">
                  {projectForm.use_separate_site_address
                    ? de
                      ? "An — Projekt nutzt eine eigene Baustellenadresse."
                      : "On — project uses its own construction site address."
                    : de
                      ? "Aus — Projekt übernimmt Adresse des Kunden automatisch."
                      : "Off — project inherits the customer's address automatically."}
                </small>
              </span>
            </label>

            {projectForm.use_separate_site_address && (
              <label className="task-modal-field">
                <span className="task-modal-field-label">
                  {de ? "Baustellenadresse" : "Construction site address"}
                </span>
                <textarea
                  className="task-modal-input task-modal-textarea"
                  value={projectForm.construction_site_address}
                  onChange={(event) =>
                    updateProjectFormField(
                      "construction_site_address",
                      event.target.value,
                    )
                  }
                  rows={3}
                  placeholder={
                    de
                      ? "Straße und Nr., PLZ Ort, Land"
                      : "Street and number, ZIP City, Country"
                  }
                />
                <small className="task-modal-field-hint">
                  {de
                    ? "Wird für Karte und Wetter statt der Kundenadresse verwendet."
                    : "Used for map and weather instead of the customer address."}
                </small>
              </label>
            )}
          </section>

          {/* Site access / Last status update */}
          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Zugang zur Baustelle" : "Construction site access"}
              </span>
              <select
                className="task-modal-input task-modal-select"
                value={projectForm.site_access_type}
                onChange={(event) => updateProjectSiteAccessType(event.target.value)}
              >
                <option value="">{de ? "Bitte auswählen" : "Please select"}</option>
                {PROJECT_SITE_ACCESS_PRESETS.map((entry) => (
                  <option key={`project-site-access-${entry}`} value={entry}>
                    {projectSiteAccessLabel(entry, language)}
                  </option>
                ))}
              </select>
              {projectSiteAccessRequiresNote(projectForm.site_access_type) && (
                <div className="project-modal-access-note">
                  <input
                    className="project-modal-access-note-input"
                    value={projectForm.site_access_note}
                    onChange={(event) => updateProjectFormField("site_access_note", event.target.value)}
                    placeholder={
                      projectForm.site_access_type === "key_pickup"
                        ? de
                          ? "z. B. Hausverwaltung, Nachbar, Adresse"
                          : "e.g. building management, neighbor, address"
                        : projectForm.site_access_type === "code_access"
                          ? de
                            ? "z. B. Türcode, Hinweise"
                            : "e.g. door code, notes"
                          : de
                            ? "z. B. Position, Bedienhinweis"
                            : "e.g. location, handling note"
                    }
                  />
                </div>
              )}
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Letztes Status-Update" : "Last status update"}
              </span>
              <input
                className="task-modal-input"
                type="datetime-local"
                value={projectForm.last_status_at}
                onChange={(event) => updateProjectFormField("last_status_at", event.target.value)}
              />
            </label>
          </section>

          <footer className="task-modal-footer project-modal-footer">
            {isEditMode && (
              <button
                type="button"
                className="task-modal-btn project-modal-btn--danger"
                onClick={() => void deleteActiveProject()}
              >
                {de ? "Projekt löschen" : "Delete project"}
              </button>
            )}
            <div className="project-modal-footer-spacer" />
            {isEditMode && (() => {
              // Button flips between archive / unarchive based on the project's
              // current persisted status. We read from `activeProject` (the
              // saved record) instead of `projectForm.status` so mid-edit
              // status changes don't hide the unarchive affordance before the
              // user actually saves.
              const archived = isArchivedProjectStatus(activeProject?.status);
              return (
                <button
                  type="button"
                  className="task-modal-btn task-modal-btn--secondary"
                  onClick={() => {
                    if (archived && activeProject) {
                      void unarchiveProject(
                        activeProject.id,
                        activeProject.last_updated_at ?? null,
                      );
                      closeProjectModal();
                    } else {
                      void archiveActiveProject();
                    }
                  }}
                >
                  {archived
                    ? de ? "Wiederherstellen" : "Unarchive"
                    : de ? "Archivieren" : "Archive"}
                </button>
              );
            })()}
            <button
              type="button"
              className="task-modal-btn task-modal-btn--ghost"
              onClick={closeProjectModal}
            >
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button type="submit" className="task-modal-btn task-modal-btn--primary">
              {isEditMode
                ? de
                  ? "Änderungen speichern"
                  : "Save changes"
                : de
                  ? "Projekt erstellen"
                  : "Create project"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
