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
    reportHasStoredDraft,
    restoreReportDraft,
    discardReportDraft,
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

  return (
    <section className="grid">
      {/* ── Draft restore banner ── */}
      {reportHasStoredDraft && (
        <div className="report-draft-banner">
          <span>
            {language === "de"
              ? "Es gibt einen gespeicherten Entwurf von Ihrer letzten Sitzung."
              : "There is a saved draft from your last session."}
          </span>
          <button type="button" onClick={restoreReportDraft}>
            {language === "de" ? "Entwurf wiederherstellen" : "Restore draft"}
          </button>
          <button type="button" className="linklike" onClick={discardReportDraft}>
            {language === "de" ? "Verwerfen" : "Discard"}
          </button>
        </div>
      )}
      <form ref={constructionFormRef as React.RefObject<HTMLFormElement>} className="card report-form" onSubmit={submitConstructionReport}>
        <h3>{language === "de" ? "Baustellenbericht" : "Construction report"}</h3>
        {reportTaskPrefill && (
          <small className="muted">
            {language === "de"
              ? `Vorlage aus Aufgabe #${reportTaskPrefill.task_id}`
              : `Template from task #${reportTaskPrefill.task_id}`}
          </small>
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
        <label>
          {language === "de" ? "Projekt" : "Project"}
          <div className="employee-search-wrap">
            <div className="employee-search-input-row">
              <input
                className="employee-search-input"
                type="text"
                autoComplete="off"
                placeholder={language === "de" ? "Projekt suchen…" : "Search project…"}
                value={projectSearch}
                onFocus={() => setProjectDropdownOpen(true)}
                onBlur={() => setTimeout(() => setProjectDropdownOpen(false), 150)}
                onChange={(e) => {
                  setProjectSearch(e.target.value);
                  setProjectDropdownOpen(true);
                  // If the user clears the text, also deselect the project
                  if (!e.target.value) applyReportProjectSelection("");
                }}
              />
              {(projectSearch || selectedProject) && (
                <button
                  type="button"
                  className="employee-search-clear"
                  onMouseDown={(e) => { e.preventDefault(); clearProject(); }}
                  aria-label="Clear"
                >
                  ×
                </button>
              )}
            </div>
            {projectDropdownOpen && (
              <div className="employee-search-dropdown">
                {/* "No project" option */}
                <div
                  className="employee-search-option"
                  onMouseDown={(e) => { e.preventDefault(); selectProject(""); }}
                >
                  <em>{language === "de" ? "Allgemeiner Bericht (ohne Projekt)" : "General report (no project)"}</em>
                </div>
                {filteredProjects.map((p) => (
                  <div
                    key={p.id}
                    className="employee-search-option"
                    onMouseDown={(e) => { e.preventDefault(); selectProject(String(p.id)); }}
                  >
                    {formatProjectTitle(p.project_number, p.customer_name, p.name, p.id)}
                  </div>
                ))}
                {filteredProjects.length === 0 && (
                  <div className="employee-search-option" style={{ color: "var(--muted)", pointerEvents: "none" }}>
                    {language === "de" ? "Keine Projekte gefunden" : "No projects found"}
                  </div>
                )}
              </div>
            )}
          </div>
        </label>
        <label>
          {language === "de" ? "Datum" : "Date"}
          <input
            type="date"
            name="report_date"
            value={reportDate}
            onChange={(e) => setReportDate(e.target.value)}
            required
          />
        </label>
        <label>
          {language === "de" ? "Kunde" : "Customer"}
          <input
            name="customer"
            value={reportDraft.customer}
            onChange={(event) => updateReportDraftField("customer", event.target.value)}
            placeholder={language === "de" ? "Kundenname" : "Customer name"}
          />
        </label>
        <label>
          {language === "de" ? "Kundenadresse" : "Customer address"}
          <textarea
            name="customer_address"
            value={reportDraft.customer_address}
            onChange={(event) => updateReportDraftField("customer_address", event.target.value)}
          />
        </label>
        <label>
          {language === "de" ? "Kontaktperson" : "Contact person"}
          <input
            name="customer_contact"
            value={reportDraft.customer_contact}
            onChange={(event) => updateReportDraftField("customer_contact", event.target.value)}
          />
        </label>
        <label>
          {language === "de" ? "Kontakt E-Mail" : "Contact email"}
          <input
            type="email"
            name="customer_email"
            value={reportDraft.customer_email}
            onChange={(event) => updateReportDraftField("customer_email", event.target.value)}
          />
        </label>
        <label>
          {language === "de" ? "Kontakt Telefon" : "Contact phone"}
          <input
            name="customer_phone"
            value={reportDraft.customer_phone}
            onChange={(event) => updateReportDraftField("customer_phone", event.target.value)}
          />
        </label>
        <label>
          {language === "de" ? "Projektname" : "Project name"}
          <input
            name="project_name"
            value={selectedReportProject?.name ?? reportDraft.project_name}
            onChange={(event) => updateReportDraftField("project_name", event.target.value)}
            readOnly={Boolean(selectedReportProject)}
            placeholder={language === "de" ? "Optional bei allgemeinem Bericht" : "Optional for general report"}
          />
        </label>
        <label>
          {language === "de" ? "Projektnummer" : "Project number"}
          <input
            name="project_number"
            value={selectedReportProject?.project_number ?? reportDraft.project_number}
            onChange={(event) => updateReportDraftField("project_number", event.target.value)}
            readOnly={Boolean(selectedReportProject)}
            placeholder={language === "de" ? "Optional bei allgemeinem Bericht" : "Optional for general report"}
          />
        </label>

        <label>
          {language === "de" ? "Arbeiten" : "Work done"}
          <textarea
            name="work_done"
            value={reportWorkDone}
            onChange={(e) => setReportWorkDone(e.target.value)}
            placeholder={language === "de" ? "Was wurde gemacht?" : "What was completed?"}
          />
        </label>

        <label>
          {language === "de" ? "Vorkommnisse / Absprachen" : "Incidents / agreements"}
          <textarea
            name="incidents"
            value={reportIncidents}
            onChange={(e) => setReportIncidents(e.target.value)}
          />
        </label>

        <div className="worker-grid">
          <div className="worker-grid-head">
            <b>{language === "de" ? "Mitarbeiter" : "Worker"}</b>
            <b>{language === "de" ? "Start" : "Start"}</b>
            <b>{language === "de" ? "Ende" : "End"}</b>
            <span />
          </div>
          {reportWorkers.map((worker, index) => (
            <div key={`worker-${index}`} className="worker-grid-row">
              <input
                value={worker.name}
                list="report-worker-options"
                placeholder={language === "de" ? "Name suchen" : "Search name"}
                onChange={(e) => updateReportWorker(index, "name", e.target.value)}
              />
              <input
                value={worker.start_time}
                placeholder="0730"
                inputMode="numeric"
                maxLength={5}
                onChange={(e) => updateReportWorker(index, "start_time", formatTimeInputForTyping(e.target.value))}
                onBlur={(event) => updateReportWorker(index, "start_time", formatTimeInputForBlur(event.target.value))}
              />
              <input
                value={worker.end_time}
                placeholder="1600"
                inputMode="numeric"
                maxLength={5}
                onChange={(e) => updateReportWorker(index, "end_time", formatTimeInputForTyping(e.target.value))}
                onBlur={(event) => updateReportWorker(index, "end_time", formatTimeInputForBlur(event.target.value))}
              />
              <button type="button" onClick={() => removeReportWorkerRow(index)}>
                {language === "de" ? "Entfernen" : "Remove"}
              </button>
            </div>
          ))}
          <datalist id="report-worker-options">
            {assignableUsers.map((entry) => (
              <option key={`report-worker-option-${entry.id}`} value={entry.full_name} />
            ))}
          </datalist>
          <button type="button" onClick={addReportWorkerRow}>
            {language === "de" ? "Mitarbeiter hinzufügen" : "Add worker"}
          </button>
          <small className="muted">
            {language === "de"
              ? "Tipp: Mitarbeitende über Namenssuche wählen, Zeiten als 4 Ziffern eingeben (z. B. 0730)."
              : "Tip: search workers by name and enter times as 4 digits (for example 0730)."}
          </small>
        </div>

        <div className="report-material-block">
          <b>{language === "de" ? "Material" : "Materials"}</b>
          <div className="report-material-grid">
            <div className="report-material-grid-head">
              <b>{language === "de" ? "Artikel" : "Item"}</b>
              <b>{language === "de" ? "Menge" : "Qty"}</b>
              <b>{language === "de" ? "Einheit" : "Unit"}</b>
              <b>{language === "de" ? "ArtNr" : "Article"}</b>
              <span />
            </div>
            {reportMaterialRows.map((row, index) => {
              const isLastRow = index === reportMaterialRows.length - 1;
              // Pressing Enter in any material-row input: prevent form submission.
              // When in the last row, also add a new empty row and move focus to it.
              const handleMaterialRowKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (isLastRow) {
                  addReportMaterialRow();
                  setTimeout(() => {
                    const rows = document.querySelectorAll<HTMLElement>(".report-material-grid-row");
                    const newRow = rows[rows.length - 1];
                    newRow?.querySelector<HTMLInputElement>("input")?.focus();
                  }, 0);
                }
              };
              return (
              <div key={row.id} className="report-material-grid-row">
                <input
                  value={row.item}
                  placeholder={language === "de" ? "Artikel" : "Item"}
                  onChange={(event) => updateReportMaterialRow(index, "item", event.target.value)}
                  onKeyDown={handleMaterialRowKeyDown}
                  onBlur={() => {
                    void enrichReportMaterialRowFromCatalog(index, "item");
                  }}
                />
                <input
                  value={row.qty}
                  placeholder={language === "de" ? "Menge" : "Qty"}
                  onChange={(event) => updateReportMaterialRow(index, "qty", event.target.value)}
                  onKeyDown={handleMaterialRowKeyDown}
                />
                <input
                  value={row.unit}
                  list="material-unit-options"
                  placeholder={language === "de" ? "Einheit" : "Unit"}
                  onChange={(event) => updateReportMaterialRow(index, "unit", event.target.value)}
                  onKeyDown={handleMaterialRowKeyDown}
                />
                <input
                  value={row.article_no}
                  placeholder={language === "de" ? "ArtNr" : "Article"}
                  onChange={(event) => updateReportMaterialRow(index, "article_no", event.target.value)}
                  onKeyDown={handleMaterialRowKeyDown}
                  onBlur={() => {
                    void enrichReportMaterialRowFromCatalog(index, "article_no");
                  }}
                />
                <button type="button" onClick={() => removeReportMaterialRow(index)} disabled={reportSubmitting}>
                  {language === "de" ? "Entfernen" : "Remove"}
                </button>
              </div>
              );
            })}
            <button type="button" onClick={addReportMaterialRow} disabled={reportSubmitting}>
              {language === "de" ? "Materialzeile hinzufügen" : "Add material row"}
            </button>
            <small className="muted">
              {language === "de"
                ? "Einheiten aus der Vorschlagsliste wählen oder frei eingeben."
                : "Pick a unit from the dropdown suggestions or type your own."}
            </small>
          </div>
        </div>
        <label>
          {language === "de" ? "Zusatzarbeiten (eine Zeile: Beschreibung|Grund)" : "Extras (one line: Description|Reason)"}
          <textarea
            name="extras"
            value={reportExtras}
            onChange={(e) => setReportExtras(e.target.value)}
          />
        </label>
        <div className="report-material-block">
          <b>{language === "de" ? "Büro Materialbedarf" : "Office material need"}</b>
          <div className="report-material-grid">
            <div className="report-material-grid-head">
              <b>{language === "de" ? "Artikel" : "Item"}</b>
              <b>{language === "de" ? "Menge" : "Qty"}</b>
              <b>{language === "de" ? "Einheit" : "Unit"}</b>
              <b>{language === "de" ? "ArtNr" : "Article"}</b>
              <span />
            </div>
            {reportOfficeMaterialRows.map((row, index) => (
              <div key={row.id} className="report-material-grid-row">
                <input
                  value={row.item}
                  placeholder={language === "de" ? "Artikel" : "Item"}
                  onChange={(event) => updateReportOfficeMaterialRow(index, "item", event.target.value)}
                  onBlur={() => {
                    void enrichReportOfficeMaterialRowFromCatalog(index, "item");
                  }}
                />
                <input
                  value={row.qty}
                  placeholder={language === "de" ? "Menge" : "Qty"}
                  onChange={(event) => updateReportOfficeMaterialRow(index, "qty", event.target.value)}
                />
                <input
                  value={row.unit}
                  list="material-unit-options"
                  placeholder={language === "de" ? "Einheit" : "Unit"}
                  onChange={(event) => updateReportOfficeMaterialRow(index, "unit", event.target.value)}
                />
                <input
                  value={row.article_no}
                  placeholder={language === "de" ? "ArtNr" : "Article"}
                  onChange={(event) => updateReportOfficeMaterialRow(index, "article_no", event.target.value)}
                  onBlur={() => {
                    void enrichReportOfficeMaterialRowFromCatalog(index, "article_no");
                  }}
                />
                <button type="button" onClick={() => removeReportOfficeMaterialRow(index)} disabled={reportSubmitting}>
                  {language === "de" ? "Entfernen" : "Remove"}
                </button>
              </div>
            ))}
            <button type="button" onClick={addReportOfficeMaterialRow} disabled={reportSubmitting}>
              {language === "de" ? "Büro-Materialzeile hinzufügen" : "Add office material row"}
            </button>
            <small className="muted">
              {language === "de"
                ? "Einheiten aus der Vorschlagsliste wählen oder frei eingeben."
                : "Pick a unit from the dropdown suggestions or type your own."}
            </small>
          </div>
        </div>
        <label>
          {language === "de" ? "Büro Nacharbeiten" : "Office rework"}
          <textarea
            name="office_rework"
            value={reportOfficeRework}
            onChange={(e) => setReportOfficeRework(e.target.value)}
          />
        </label>
        <label>
          {language === "de" ? "Büro nächste Schritte" : "Office next steps"}
          <textarea
            name="office_next_steps"
            value={reportOfficeNextSteps}
            onChange={(e) => setReportOfficeNextSteps(e.target.value)}
          />
        </label>
        <label>
          {language === "de" ? "Fotos" : "Photos"}
          <div className="report-image-upload">
            <input
              ref={reportImageInputRef as React.RefObject<HTMLInputElement>}
              className="report-image-input"
              type="file"
              accept={IMAGE_INPUT_ACCEPT}
              multiple
              onChange={onReportImagesChange}
            />
            <button
              type="button"
              className={reportImageFiles.length ? "report-image-add has-files" : "report-image-add"}
              onClick={() => reportImageInputRef.current?.click()}
              disabled={reportSubmitting}
            >
              {reportImageFiles.length > 0
                ? language === "de"
                  ? "Weitere Fotos hinzufügen"
                  : "Add more photos"
                : language === "de"
                  ? "Fotos auswählen"
                  : "Select photos"}
            </button>
            {reportImageFiles.length > 0 && (
              <>
                <small className="muted">
                  {language === "de"
                    ? `${reportImageFiles.length} Datei(en) ausgewählt`
                    : `${reportImageFiles.length} file(s) selected`}
                </small>
                <div className="report-image-list">
                  {reportImageFiles.map((entry) => {
                    return (
                      <div key={entry.key} className="report-image-item" title={entry.file.name}>
                        <img className="report-image-thumb" src={entry.preview_url} alt={entry.file.name} />
                        <button
                          type="button"
                          className="report-image-remove"
                          onClick={(event) => onReportImageRemoveClick(event, entry.key)}
                          aria-label={language === "de" ? "Foto entfernen" : "Remove photo"}
                          title={language === "de" ? "Foto entfernen" : "Remove photo"}
                          disabled={reportSubmitting}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </label>
        <label className="report-send-option">
          <span className="report-send-head">
            <input type="checkbox" name="send_telegram" />
            {language === "de"
              ? "Per Telegram Bot senden (optional)"
              : "Send via Telegram bot (optional)"}
          </span>
          <small className="muted">
            {language === "de"
              ? "Ohne lokale Bot-Konfiguration bleibt der Versand im Stub-Modus."
              : "Without local bot configuration, sending stays in stub mode."}
          </small>
        </label>
        {reportSubmitting && (
          <div className="report-upload-progress" role="status" aria-live="polite">
            <div className="report-upload-progress-track">
              <span
                className="report-upload-progress-fill"
                style={{
                  width: `${Math.max(0, Math.min(100, reportUploadPercent ?? 4))}%`,
                }}
              />
            </div>
            <small className="muted">
              {reportUploadPhase === "processing"
                ? language === "de"
                  ? "Upload abgeschlossen, Bericht wird verarbeitet..."
                  : "Upload complete, report is being processed..."
                : language === "de"
                  ? `Upload läuft${reportUploadPercent != null ? `: ${reportUploadPercent}%` : "..."}`
                  : `Uploading${reportUploadPercent != null ? `: ${reportUploadPercent}%` : "..."}`}
            </small>
          </div>
        )}
        <button type="submit" disabled={reportSubmitting}>
          {reportSubmitting
            ? language === "de"
              ? "Wird hochgeladen..."
              : "Uploading..."
            : language === "de"
              ? "Bericht speichern"
              : "Save report"}
        </button>
      </form>

      <div className="card">
        <h3>
          {reportProjectId
            ? language === "de"
              ? "Projektdateien (inkl. Berichte/Fotos)"
              : "Project files (reports/photos)"
            : language === "de"
              ? "Allgemeiner Berichtsordner"
              : "General reports folder"}
        </h3>
        <ul>
          {files.map((file) => (
            <li key={file.id}>
              <a href={filePreviewUrl(file.id)} target="_blank" rel="noreferrer">
                {file.file_name}
              </a>
            </li>
          ))}
          {files.length === 0 && (
            <li className="muted">
              {language === "de" ? "Keine Berichtsdateien vorhanden." : "No report files available."}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
