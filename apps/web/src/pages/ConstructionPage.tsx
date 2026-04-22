import React, { useState, useEffect } from "react";
import { useAppContext } from "../context/AppContext";
import { IMAGE_INPUT_ACCEPT } from "../constants";
import { formatTimeInputForTyping, formatTimeInputForBlur } from "../utils/tasks";
import { formatProjectTitle } from "../utils/projects";

export function ConstructionPage() {
  const {
    mainView,
    language,
    constructionFormRef,
    reportImageInputRef,
    reportTaskPrefill,
    reportSourceTaskId,
    reportTaskChecklist,
    toggleReportTaskChecklistItem,
    reportProjectId,
    applyReportProjectSelection,
    projects,
    reportDraft,
    updateReportDraftField,
    reportWorkDone,
    setReportWorkDone,
    reportIncidents,
    setReportIncidents,
    reportExtras,
    setReportExtras,
    reportOfficeRework,
    setReportOfficeRework,
    reportOfficeNextSteps,
    setReportOfficeNextSteps,
    reportDate,
    setReportDate,
    reportDrafts,
    activeDraftId,
    openReportDraft,
    deleteReportDraft,
    startNewReportDraft,
    selectedReportProject,
    reportWorkers,
    updateReportWorker,
    addReportWorkerRow,
    removeReportWorkerRow,
    assignableUsers,
    reportMaterialRows,
    updateReportMaterialRow,
    addReportMaterialRow,
    removeReportMaterialRow,
    enrichReportMaterialRowFromCatalog,
    reportOfficeMaterialRows,
    updateReportOfficeMaterialRow,
    addReportOfficeMaterialRow,
    removeReportOfficeMaterialRow,
    enrichReportOfficeMaterialRowFromCatalog,
    reportImageFiles,
    onReportImagesChange,
    onReportImageRemoveClick,
    reportSubmitting,
    reportUploadPercent,
    reportUploadPhase,
    submitConstructionReport,
    files,
    filePreviewUrl,
  } = useAppContext();

  // Project search combobox state (local — ephemeral UI only)
  const [projectSearch, setProjectSearch] = useState("");
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);

  const selectedProject = projects.find((p) => String(p.id) === reportProjectId) ?? null;

  // Sync the text input when a project is selected externally (e.g. draft restore or task prefill)
  useEffect(() => {
    if (selectedProject) {
      setProjectSearch(formatProjectTitle(selectedProject.project_number, selectedProject.customer_name, selectedProject.name, selectedProject.id));
    } else if (!reportProjectId) {
      setProjectSearch("");
    }
  }, [reportProjectId, selectedProject]);

  const filteredProjects = projects.filter((p) => {
    if (!projectSearch.trim()) return true;
    const label = formatProjectTitle(p.project_number, p.customer_name, p.name, p.id).toLowerCase();
    return label.includes(projectSearch.toLowerCase());
  });

  function selectProject(idStr: string) {
    applyReportProjectSelection(idStr);
    const p = projects.find((proj) => String(proj.id) === idStr);
    setProjectSearch(p ? formatProjectTitle(p.project_number, p.customer_name, p.name, p.id) : "");
    setProjectDropdownOpen(false);
  }

  function clearProject() {
    applyReportProjectSelection("");
    setProjectSearch("");
    setProjectDropdownOpen(false);
  }

  if (mainView !== "construction") return null;
  const de = language === "de";

  // Saved drafts filtered by the selected project; when no project is
  // chosen we show *all* drafts so a user can still discover orphan
  // drafts and pick where to resume.
  const visibleDrafts = reportProjectId
    ? reportDrafts.filter((d) => d.projectId === reportProjectId)
    : reportDrafts;

  return (
    <section className="construction-report">
      {/* ── Saved drafts list (replaces the old single-slot restore banner) ── */}
      {visibleDrafts.length > 0 && (
        <div className="construction-report-drafts-list">
          <div className="construction-report-drafts-head">
            <h3>{de ? "Gespeicherte Entwürfe" : "Saved drafts"}</h3>
            <button
              type="button"
              className="construction-report-btn construction-report-btn--ghost"
              onClick={startNewReportDraft}
              title={de ? "Leeres Formular" : "Empty form"}
            >
              + {de ? "Neuer Entwurf" : "New draft"}
            </button>
          </div>
          <ul className="construction-report-drafts-items">
            {visibleDrafts.map((draft) => {
              const isActive = draft.id === activeDraftId;
              const headline =
                draft.draft.customer.trim() ||
                (draft.projectId ? `#${draft.draft.project_number || draft.projectId}` : de ? "Neuer Entwurf" : "New draft");
              const savedDate = draft.savedAt ? new Date(draft.savedAt) : null;
              const savedLabel = savedDate
                ? savedDate.toLocaleString(de ? "de-DE" : "en-US")
                : "";
              return (
                <li
                  key={draft.id}
                  className={`construction-report-draft-row${isActive ? " is-active" : ""}`}
                >
                  <div className="construction-report-draft-row-main">
                    <strong>{headline}</strong>
                    <small>
                      {draft.draft.project_number && (
                        <span>#{draft.draft.project_number}</span>
                      )}
                      {savedLabel && (
                        <span>
                          {" · "}
                          {de ? "gespeichert" : "saved"} {savedLabel}
                        </span>
                      )}
                    </small>
                  </div>
                  <div className="construction-report-draft-row-actions">
                    {!isActive && (
                      <button
                        type="button"
                        className="construction-report-btn construction-report-btn--primary"
                        onClick={() => openReportDraft(draft.id)}
                      >
                        {de ? "Öffnen" : "Open"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="construction-report-btn construction-report-btn--danger"
                      onClick={() => {
                        const confirmed = window.confirm(
                          de
                            ? `Entwurf "${headline}" wirklich löschen?`
                            : `Really delete draft "${headline}"?`,
                        );
                        if (confirmed) deleteReportDraft(draft.id);
                      }}
                    >
                      {de ? "Löschen" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <form
        ref={constructionFormRef as React.RefObject<HTMLFormElement>}
        className="construction-report-form"
        onSubmit={submitConstructionReport}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const target = e.target as HTMLElement;
            const isSubmitButton =
              target.tagName === "BUTTON" && (target as HTMLButtonElement).type === "submit";
            if (!isSubmitButton) e.preventDefault();
          }
        }}
      >
        {reportTaskPrefill && (
          <div className="construction-report-task-prefill muted">
            {de
              ? `Vorlage aus Aufgabe #${reportTaskPrefill.task_id}`
              : `Template from task #${reportTaskPrefill.task_id}`}
          </div>
        )}
        {reportSourceTaskId && reportTaskChecklist.length > 0 && (
          <div className="report-subtask-checklist">
            <b>
              {language === "de"
                ? `Unteraufgaben aus Aufgabe #${reportSourceTaskId}`
                : `Sub-tasks from task #${reportSourceTaskId}`}
            </b>
            <small className="muted">
              {language === "de"
                ? "Abhaken, was erledigt wurde. Offene Punkte erzeugen automatisch eine neue, nicht zugewiesene Folgeaufgabe."
                : "Tick completed items. Open items will create a new unassigned follow-up task automatically."}
            </small>
            <div className="report-subtask-checklist-items">
              {reportTaskChecklist.map((entry) => (
                <label key={entry.id} className="report-subtask-item">
                  <input
                    type="checkbox"
                    checked={entry.done}
                    onChange={(event) => toggleReportTaskChecklistItem(entry.id, event.target.checked)}
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {/* ── Project selector ── */}
        <label className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">{de ? "Projekt" : "Project"}</span>
          <div className="construction-report-project-picker">
            <div className="construction-report-input-wrap">
              <svg
                className="construction-report-project-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M3.5 7.5a1.8 1.8 0 0 1 1.8-1.8h3.9l1.8 2.1h7.7a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Z"
                  stroke="#2f70b7"
                  strokeWidth="1.8"
                  strokeLinejoin="round"
                />
              </svg>
              <input
                className="construction-report-input construction-report-input--has-icon"
                type="text"
                autoComplete="off"
                placeholder={de ? "Projekt suchen…" : "Search project…"}
                value={projectSearch}
                onFocus={() => setProjectDropdownOpen(true)}
                onBlur={() => setTimeout(() => setProjectDropdownOpen(false), 150)}
                onChange={(e) => {
                  setProjectSearch(e.target.value);
                  setProjectDropdownOpen(true);
                  if (!e.target.value) applyReportProjectSelection("");
                }}
              />
              {(projectSearch || selectedProject) && (
                <button
                  type="button"
                  className="construction-report-input-clear"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    clearProject();
                  }}
                  aria-label={de ? "Projekt entfernen" : "Clear project"}
                >
                  ×
                </button>
              )}
            </div>
            {projectDropdownOpen && (
              <div className="construction-report-project-dropdown">
                <div
                  className="construction-report-project-option"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectProject("");
                  }}
                >
                  <em>
                    {de ? "Allgemeiner Bericht (ohne Projekt)" : "General report (no project)"}
                  </em>
                </div>
                {filteredProjects.map((p) => (
                  <div
                    key={p.id}
                    className="construction-report-project-option"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectProject(String(p.id));
                    }}
                  >
                    {formatProjectTitle(p.project_number, p.customer_name, p.name, p.id)}
                  </div>
                ))}
                {filteredProjects.length === 0 && (
                  <div className="construction-report-project-option construction-report-project-option--empty">
                    {de ? "Keine Projekte gefunden" : "No projects found"}
                  </div>
                )}
              </div>
            )}
          </div>
        </label>

        {/* ── Date ── */}
        <div className="construction-report-grid construction-report-grid--2col">
          <label className="construction-report-field">
            <span className="construction-report-label">{de ? "Datum" : "Date"}</span>
            <input
              type="date"
              className="construction-report-input"
              name="report_date"
              value={reportDate}
              onChange={(e) => setReportDate(e.target.value)}
              required
            />
          </label>
          <label className="construction-report-field">
            <span className="construction-report-label">
              {de ? "Projektnummer" : "Project number"}
            </span>
            <input
              className="construction-report-input"
              name="project_number"
              value={selectedReportProject?.project_number ?? reportDraft.project_number}
              onChange={(event) => updateReportDraftField("project_number", event.target.value)}
              readOnly={Boolean(selectedReportProject)}
              placeholder={de ? "Optional" : "Optional"}
            />
          </label>
        </div>

        {/* ── Customer / Project name ── */}
        <div className="construction-report-grid construction-report-grid--2col">
          <label className="construction-report-field">
            <span className="construction-report-label">{de ? "Kunde" : "Customer"}</span>
            <input
              className="construction-report-input"
              name="customer"
              value={reportDraft.customer}
              onChange={(event) => updateReportDraftField("customer", event.target.value)}
              placeholder={de ? "Kundenname" : "Customer name"}
            />
          </label>
          <label className="construction-report-field">
            <span className="construction-report-label">{de ? "Projektname" : "Project name"}</span>
            <input
              className="construction-report-input"
              name="project_name"
              value={selectedReportProject?.name ?? reportDraft.project_name}
              onChange={(event) => updateReportDraftField("project_name", event.target.value)}
              readOnly={Boolean(selectedReportProject)}
              placeholder={de ? "Optional bei allgemeinem Bericht" : "Optional for general report"}
            />
          </label>
        </div>

        {/* ── Contact person / Contact email ── */}
        <div className="construction-report-grid construction-report-grid--2col">
          <label className="construction-report-field">
            <span className="construction-report-label">
              {de ? "Kontaktperson" : "Contact person"}
            </span>
            <input
              className="construction-report-input"
              name="customer_contact"
              value={reportDraft.customer_contact}
              onChange={(event) => updateReportDraftField("customer_contact", event.target.value)}
              placeholder={de ? "Name" : "Name…"}
            />
          </label>
          <label className="construction-report-field">
            <span className="construction-report-label">{de ? "Kontakt E-Mail" : "Contact email"}</span>
            <input
              type="email"
              className="construction-report-input"
              name="customer_email"
              value={reportDraft.customer_email}
              onChange={(event) => updateReportDraftField("customer_email", event.target.value)}
              placeholder="email@…"
            />
          </label>
        </div>

        {/* ── Contact phone / Customer address ── */}
        <div className="construction-report-grid construction-report-grid--2col">
          <label className="construction-report-field">
            <span className="construction-report-label">
              {de ? "Kontakt Telefon" : "Contact phone"}
            </span>
            <input
              className="construction-report-input"
              name="customer_phone"
              value={reportDraft.customer_phone}
              onChange={(event) => updateReportDraftField("customer_phone", event.target.value)}
              placeholder={de ? "+49 …" : "+1 …"}
            />
          </label>
          <label className="construction-report-field">
            <span className="construction-report-label">
              {de ? "Kundenadresse" : "Customer address"}
            </span>
            <input
              className="construction-report-input"
              name="customer_address"
              value={reportDraft.customer_address}
              onChange={(event) => updateReportDraftField("customer_address", event.target.value)}
              placeholder={de ? "Straße, PLZ Ort" : "Street, ZIP City"}
            />
          </label>
        </div>

        {/* ── Workers on site ── */}
        <div className="construction-report-section">
          <div className="construction-report-section-head">
            <span className="construction-report-section-label">
              {de ? "Mitarbeiter vor Ort" : "Workers on site"}
            </span>
            <button
              type="button"
              className="construction-report-add-link"
              onClick={addReportWorkerRow}
            >
              + {de ? "Hinzufügen" : "Add"}
            </button>
          </div>
          <div className="construction-report-table construction-report-table--workers">
            <div className="construction-report-table-head">
              <span>{de ? "MITARBEITER" : "WORKER"}</span>
              <span>{de ? "START" : "START"}</span>
              <span>{de ? "ENDE" : "END"}</span>
              <span />
            </div>
            {reportWorkers.map((worker, index) => (
              <div key={`worker-${index}`} className="construction-report-table-row">
                <input
                  className="construction-report-input"
                  value={worker.name}
                  list="report-worker-options"
                  placeholder={de ? "Name suchen" : "Search name"}
                  onChange={(e) => updateReportWorker(index, "name", e.target.value)}
                />
                <input
                  className="construction-report-input"
                  value={worker.start_time}
                  placeholder="0730"
                  inputMode="numeric"
                  maxLength={5}
                  onChange={(e) =>
                    updateReportWorker(index, "start_time", formatTimeInputForTyping(e.target.value))
                  }
                  onBlur={(event) =>
                    updateReportWorker(index, "start_time", formatTimeInputForBlur(event.target.value))
                  }
                />
                <input
                  className="construction-report-input"
                  value={worker.end_time}
                  placeholder="1600"
                  inputMode="numeric"
                  maxLength={5}
                  onChange={(e) =>
                    updateReportWorker(index, "end_time", formatTimeInputForTyping(e.target.value))
                  }
                  onBlur={(event) =>
                    updateReportWorker(index, "end_time", formatTimeInputForBlur(event.target.value))
                  }
                />
                <button
                  type="button"
                  className="construction-report-row-remove"
                  onClick={() => removeReportWorkerRow(index)}
                  aria-label={de ? "Entfernen" : "Remove"}
                  title={de ? "Entfernen" : "Remove"}
                >
                  ×
                </button>
              </div>
            ))}
            <datalist id="report-worker-options">
              {assignableUsers.map((entry) => (
                <option key={`report-worker-option-${entry.id}`} value={entry.full_name} />
              ))}
            </datalist>
          </div>
        </div>

        {/* ── Materials used ── */}
        <div className="construction-report-section">
          <div className="construction-report-section-head">
            <span className="construction-report-section-label">
              {de ? "Verwendetes Material" : "Materials used"}
            </span>
            <button
              type="button"
              className="construction-report-add-link"
              onClick={addReportMaterialRow}
              disabled={reportSubmitting}
            >
              + {de ? "Hinzufügen" : "Add"}
            </button>
          </div>
          <div className="construction-report-table construction-report-table--materials">
            <div className="construction-report-table-head">
              <span>{de ? "ARTIKEL" : "ITEM"}</span>
              <span>{de ? "MENGE" : "QTY"}</span>
              <span>{de ? "EINHEIT" : "UNIT"}</span>
              <span>{de ? "ART.NR" : "ART.NR"}</span>
              <span />
            </div>
            {reportMaterialRows.map((row, index) => {
              const isLastRow = index === reportMaterialRows.length - 1;
              const handleMaterialRowKeyDown = (
                event: React.KeyboardEvent<HTMLInputElement>,
              ) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (isLastRow) {
                  addReportMaterialRow();
                  setTimeout(() => {
                    const rows = document.querySelectorAll<HTMLElement>(
                      ".construction-report-table--materials .construction-report-table-row",
                    );
                    const newRow = rows[rows.length - 1];
                    newRow?.querySelector<HTMLInputElement>("input")?.focus();
                  }, 0);
                }
              };
              return (
                <div key={row.id} className="construction-report-table-row">
                  <input
                    className="construction-report-input"
                    value={row.item}
                    placeholder={de ? "Artikel" : "Item"}
                    onChange={(event) => updateReportMaterialRow(index, "item", event.target.value)}
                    onKeyDown={handleMaterialRowKeyDown}
                    onBlur={() => {
                      void enrichReportMaterialRowFromCatalog(index, "item");
                    }}
                  />
                  <input
                    className="construction-report-input"
                    value={row.qty}
                    placeholder={de ? "Menge" : "Qty"}
                    onChange={(event) => updateReportMaterialRow(index, "qty", event.target.value)}
                    onKeyDown={handleMaterialRowKeyDown}
                  />
                  <input
                    className="construction-report-input"
                    value={row.unit}
                    list="material-unit-options"
                    placeholder={de ? "Einheit" : "Unit"}
                    onChange={(event) => updateReportMaterialRow(index, "unit", event.target.value)}
                    onKeyDown={handleMaterialRowKeyDown}
                  />
                  <input
                    className="construction-report-input"
                    value={row.article_no}
                    placeholder={de ? "ArtNr" : "Art.Nr"}
                    onChange={(event) =>
                      updateReportMaterialRow(index, "article_no", event.target.value)
                    }
                    onKeyDown={handleMaterialRowKeyDown}
                    onBlur={() => {
                      void enrichReportMaterialRowFromCatalog(index, "article_no");
                    }}
                  />
                  <button
                    type="button"
                    className="construction-report-row-remove"
                    onClick={() => removeReportMaterialRow(index)}
                    disabled={reportSubmitting}
                    aria-label={de ? "Entfernen" : "Remove"}
                    title={de ? "Entfernen" : "Remove"}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Work done ── */}
        <label className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de ? "Heute geleistete Arbeit" : "Work done today"}
          </span>
          <textarea
            className="construction-report-input construction-report-textarea"
            name="work_done"
            rows={3}
            value={reportWorkDone}
            onChange={(e) => setReportWorkDone(e.target.value)}
            placeholder={de ? "Was wurde heute gemacht?" : "What was completed today?"}
          />
        </label>

        {/* ── Incidents / agreements ── */}
        <label className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de ? "Vorfälle / Absprachen" : "Incidents / agreements"}
          </span>
          <textarea
            className="construction-report-input construction-report-textarea"
            name="incidents"
            rows={3}
            value={reportIncidents}
            onChange={(e) => setReportIncidents(e.target.value)}
            placeholder={de ? "Notizen zu Vorfällen oder Absprachen…" : "Notes on any incidents or agreements…"}
          />
        </label>

        {/* ── Extras ── */}
        <label className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de
              ? "Extras (eine Zeile: Beschreibung | Grund)"
              : "Extras (one line: Description | Reason)"}
          </span>
          <input
            className="construction-report-input"
            name="extras"
            value={reportExtras}
            onChange={(e) => setReportExtras(e.target.value)}
            placeholder={de ? "Zusatzarbeiten außerhalb des Umfangs…" : "Additional work outside scope…"}
          />
        </label>
        {/* ── OFFICE USE ONLY divider ── */}
        <div className="construction-report-office-divider">
          <span>{de ? "NUR FÜRS BÜRO" : "OFFICE USE ONLY"}</span>
        </div>

        {/* ── Office material needs ── */}
        <div className="construction-report-section">
          <div className="construction-report-section-head">
            <span className="construction-report-section-label">
              {de ? "Büro-Materialbedarf" : "Office material needs"}
            </span>
            <button
              type="button"
              className="construction-report-add-link"
              onClick={addReportOfficeMaterialRow}
              disabled={reportSubmitting}
            >
              + {de ? "Hinzufügen" : "Add"}
            </button>
          </div>
          <div className="construction-report-table construction-report-table--materials">
            <div className="construction-report-table-head">
              <span>{de ? "ARTIKEL" : "ITEM"}</span>
              <span>{de ? "MENGE" : "QTY"}</span>
              <span>{de ? "EINHEIT" : "UNIT"}</span>
              <span>{de ? "ART.NR" : "ART.NR"}</span>
              <span />
            </div>
            {reportOfficeMaterialRows.map((row, index) => (
              <div key={row.id} className="construction-report-table-row">
                <input
                  className="construction-report-input"
                  value={row.item}
                  placeholder={de ? "Artikel" : "Item"}
                  onChange={(event) =>
                    updateReportOfficeMaterialRow(index, "item", event.target.value)
                  }
                  onBlur={() => {
                    void enrichReportOfficeMaterialRowFromCatalog(index, "item");
                  }}
                />
                <input
                  className="construction-report-input"
                  value={row.qty}
                  placeholder={de ? "Menge" : "Qty"}
                  onChange={(event) =>
                    updateReportOfficeMaterialRow(index, "qty", event.target.value)
                  }
                />
                <input
                  className="construction-report-input"
                  value={row.unit}
                  list="material-unit-options"
                  placeholder={de ? "Einheit" : "Unit"}
                  onChange={(event) =>
                    updateReportOfficeMaterialRow(index, "unit", event.target.value)
                  }
                />
                <input
                  className="construction-report-input"
                  value={row.article_no}
                  placeholder={de ? "ArtNr" : "Art.Nr"}
                  onChange={(event) =>
                    updateReportOfficeMaterialRow(index, "article_no", event.target.value)
                  }
                  onBlur={() => {
                    void enrichReportOfficeMaterialRowFromCatalog(index, "article_no");
                  }}
                />
                <button
                  type="button"
                  className="construction-report-row-remove"
                  onClick={() => removeReportOfficeMaterialRow(index)}
                  disabled={reportSubmitting}
                  aria-label={de ? "Entfernen" : "Remove"}
                  title={de ? "Entfernen" : "Remove"}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* ── Office rework ── */}
        <label className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de ? "Büro-Nacharbeiten" : "Office rework"}
          </span>
          <textarea
            className="construction-report-input construction-report-textarea"
            name="office_rework"
            rows={3}
            value={reportOfficeRework}
            onChange={(e) => setReportOfficeRework(e.target.value)}
            placeholder={de ? "Nacharbeitsnotizen…" : "Rework notes…"}
          />
        </label>

        {/* ── Office next steps ── */}
        <label className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de ? "Büro nächste Schritte" : "Office next steps"}
          </span>
          <textarea
            className="construction-report-input construction-report-textarea"
            name="office_next_steps"
            rows={3}
            value={reportOfficeNextSteps}
            onChange={(e) => setReportOfficeNextSteps(e.target.value)}
            placeholder={de ? "Nächste Schritte fürs Büro…" : "Next steps for office…"}
          />
        </label>

        {/* ── Photos ── */}
        <div className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">{de ? "Fotos" : "Photos"}</span>
          <div className="construction-report-photos">
            <input
              ref={reportImageInputRef as React.RefObject<HTMLInputElement>}
              className="construction-report-photos-input"
              type="file"
              accept={IMAGE_INPUT_ACCEPT}
              multiple
              onChange={onReportImagesChange}
            />
            <button
              type="button"
              className="construction-report-photos-btn"
              onClick={() => reportImageInputRef.current?.click()}
              disabled={reportSubmitting}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="9" cy="11" r="1.8" fill="currentColor" />
                <path
                  d="m4.5 18 5-5 4 4 3-3 3 3"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {reportImageFiles.length > 0
                ? de
                  ? `Weitere Fotos (${reportImageFiles.length})`
                  : `Add more photos (${reportImageFiles.length})`
                : de
                  ? "Fotos hinzufügen (0)"
                  : "Add photos (0)"}
            </button>
            {reportImageFiles.length > 0 && (
              <div className="construction-report-photo-grid">
                {reportImageFiles.map((entry) => (
                  <div
                    key={entry.key}
                    className="construction-report-photo-tile"
                    title={entry.file.name}
                  >
                    <img src={entry.preview_url} alt={entry.file.name} />
                    <button
                      type="button"
                      className="construction-report-photo-remove"
                      onClick={(event) => onReportImageRemoveClick(event, entry.key)}
                      aria-label={de ? "Foto entfernen" : "Remove photo"}
                      title={de ? "Foto entfernen" : "Remove photo"}
                      disabled={reportSubmitting}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {reportSubmitting && (
          <div className="construction-report-upload-progress" role="status" aria-live="polite">
            <div className="construction-report-upload-track">
              <span
                className="construction-report-upload-fill"
                style={{ width: `${Math.max(0, Math.min(100, reportUploadPercent ?? 4))}%` }}
              />
            </div>
            <small className="muted">
              {reportUploadPhase === "processing"
                ? de
                  ? "Upload abgeschlossen, Bericht wird verarbeitet…"
                  : "Upload complete, report is being processed…"
                : de
                  ? `Upload läuft${reportUploadPercent != null ? `: ${reportUploadPercent}%` : "…"}`
                  : `Uploading${reportUploadPercent != null ? `: ${reportUploadPercent}%` : "…"}`}
            </small>
          </div>
        )}

        {/* ── Footer: Save draft + Submit report ── */}
        <footer className="construction-report-footer">
          <button
            type="button"
            className="construction-report-btn construction-report-btn--secondary"
            onClick={() => {
              // Draft is auto-persisted via the existing reportHasStoredDraft flow.
              // This button gives users an explicit "I'm done for now" affordance.
              window.alert(
                de
                  ? "Der Entwurf wird automatisch gespeichert."
                  : "Draft is saved automatically.",
              );
            }}
            disabled={reportSubmitting}
          >
            {de ? "Entwurf speichern" : "Save draft"}
          </button>
          <button
            type="submit"
            className="construction-report-btn construction-report-btn--primary"
            disabled={reportSubmitting}
          >
            {reportSubmitting
              ? de
                ? "Wird hochgeladen…"
                : "Uploading…"
              : de
                ? "Bericht senden"
                : "Submit report"}
          </button>
        </footer>
      </form>

      <div className="construction-report-files">
        <h3 className="construction-report-files-title">
          {reportProjectId
            ? de
              ? "Projektdateien (inkl. Berichte/Fotos)"
              : "Project files (reports/photos)"
            : de
              ? "Allgemeiner Berichtsordner"
              : "General reports folder"}
        </h3>
        <ul className="construction-report-files-list">
          {files.map((file) => (
            <li key={file.id}>
              <a href={filePreviewUrl(file.id)} target="_blank" rel="noreferrer">
                {file.file_name}
              </a>
            </li>
          ))}
          {files.length === 0 && (
            <li className="muted">
              {de ? "Keine Berichtsdateien vorhanden." : "No report files available."}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
