import React, { useState, useEffect, useRef } from "react";
import { useAppContext } from "../context/AppContext";
import { IMAGE_INPUT_ACCEPT } from "../constants";
import { formatTimeInputForTyping, formatTimeInputForBlur } from "../utils/tasks";
import { formatProjectTitle } from "../utils/projects";
import { WorkerNameCombobox } from "../components/shared/WorkerNameCombobox";
import { SignaturePad } from "../components/shared/SignaturePad";
import { CustomerCombobox } from "../components/customers/CustomerCombobox";
import { apiFetch } from "../api/client";

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
    reportCustomerId,
    applyReportCustomerSelection,
    customers,
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
    // v2.5.18: status / distance / signature state for the redesigned PDF.
    reportStatus,
    setReportStatus,
    reportDistance,
    setReportDistance,
    reportSignatureSmpl,
    setReportSignatureSmpl,
    reportSignatureCustomer,
    setReportSignatureCustomer,
    flushReportDraft,
    setNotice,
    setError,
    token,
  } = useAppContext();

  // Project search combobox state (local — ephemeral UI only)
  const [projectSearch, setProjectSearch] = useState("");
  /** Bumped by the "↺ Auto" button to re-run the distance auto-fetch effect. */
  const [distanceRefreshNonce, setDistanceRefreshNonce] = useState(0);
  /** Ref-tracked so a re-focus cannot be closed by the previous blur's timer. */
  const projectBlurTimer = useRef<number | null>(null);
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

  // Reports are customer-first: once a customer is picked, only that customer's
  // projects are offered. Legacy projects that carry only the free-text
  // customer_name (no customer_id yet) are matched by name so they stay
  // reachable until every project is linked.
  const customerScopedProjects = (() => {
    if (reportCustomerId == null) return projects;
    const picked = customers.find((c) => c.id === reportCustomerId) ?? null;
    const pickedName = (picked?.name ?? "").trim().toLowerCase();
    return projects.filter(
      (p) =>
        p.customer_id === reportCustomerId ||
        (p.customer_id == null &&
          pickedName.length > 0 &&
          (p.customer_name ?? "").trim().toLowerCase() === pickedName),
    );
  })();

  const filteredProjects = customerScopedProjects.filter((p) => {
    if (!projectSearch.trim()) return true;
    const label = formatProjectTitle(p.project_number, p.customer_name, p.name, p.id).toLowerCase();
    return label.includes(projectSearch.toLowerCase());
  });

  // v2.5.18: auto-fetch the company→site round-trip distance whenever the
  // selected project changes. The endpoint is fast (geocoding cache hit
  // for repeat projects); we don't overwrite a manually-entered value
  // because reportDistance.source flips to "manual" the moment the
  // operator types in the field.
  useEffect(() => {
    if (!reportProjectId || !token) return;
    if (reportDistance.source === "manual") return; // respect operator override
    if (reportDistance.kilometers != null) return; // already have a value; don't churn
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch<{ kilometers: number | null; one_way_km: number | null; source: string }>(
          `/projects/${reportProjectId}/construction-reports/distance`,
          token,
        );
        if (cancelled) return;
        if (res.source === "auto" && typeof res.kilometers === "number") {
          setReportDistance({ kilometers: res.kilometers, source: "auto" });
        } else {
          // Unable to auto-fill (no api key, missing addresses, etc.) — leave
          // unset so the operator must fill it in. The form surfaces the
          // specific reason via a badge.
          setReportDistance({ kilometers: null, source: "unset" });
        }
      } catch {
        // Network failure or 404. Do NOT blank a value that is already on
        // screen — a blip on a rural link would otherwise erase a correct
        // auto-filled figure. Only fall back to "unset" when there is nothing
        // to lose, so the badge can prompt for manual entry.
        if (!cancelled && reportDistance.kilometers == null) {
          setReportDistance({ kilometers: null, source: "unset" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportProjectId, token, distanceRefreshNonce]);

  function selectProject(idStr: string) {
    // Selection is complete — get the keyboard out of the way.
    (document.activeElement as HTMLElement | null)?.blur();
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
          if (e.key !== "Enter") return;
          const target = e.target as HTMLElement;
          // The ONLY purpose of this handler is to suppress implicit form
          // submission, which single-line <input>s trigger on Enter. A
          // <textarea> needs Enter for line breaks and a <button> needs it to
          // activate — cancelling there is what made the Return key dead in all
          // five textareas on this page, including "Heute geleistete Arbeit".
          if (target.tagName !== "INPUT") return;
          e.preventDefault();
        }}
      >
        {/* Locks every control for the duration of the upload. Without this a
            worker could keep typing into a form whose draft is about to be
            deleted on success, silently losing the edit. <fieldset> is used
            rather than per-input disabled props so nothing can be missed —
            it carries no styling of its own (see .construction-report-fieldset). */}
        <fieldset className="construction-report-fieldset" disabled={reportSubmitting}>
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
        {/* ── Customer selector (first field — reports are customer-owned) ── */}
        <label className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de ? "Kunde" : "Customer"} *
          </span>
          <CustomerCombobox
            language={de ? "de" : "en"}
            customers={customers}
            value={{ customerId: reportCustomerId, customerName: reportDraft.customer }}
            onChange={(next) => applyReportCustomerSelection(next.customerId, next.customerName)}
            onRequestCreate={() => undefined}
            placeholder={de ? "Kunde suchen oder eintippen…" : "Search or type a customer…"}
          />
          {reportCustomerId == null && reportDraft.customer.trim().length > 0 && (
            <small className="construction-report-hint">
              {de
                ? "Nicht verknüpft — Bericht wird ohne Kundenakte gespeichert."
                : "Not linked — the report is saved without a customer record."}
            </small>
          )}
        </label>

        {/* ── Project selector (optional, scoped to the customer) ── */}
        <label className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de ? "Projekt (optional)" : "Project (optional)"}
          </span>
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
                onBlur={() => {
                  if (projectBlurTimer.current) window.clearTimeout(projectBlurTimer.current);
                  projectBlurTimer.current = window.setTimeout(
                    () => setProjectDropdownOpen(false),
                    150,
                  );
                }}
                onFocusCapture={() => {
                  if (projectBlurTimer.current) window.clearTimeout(projectBlurTimer.current);
                }}
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
                <button
                  type="button"
                  role="option"
                  aria-selected={!selectedProject}
                  className="construction-report-project-option"
                  // onMouseDown only suppresses the blur that would close the
                  // list; the actual selection is onClick, which touch fires
                  // reliably even after a little finger drift.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => selectProject("")}
                >
                  <em>
                    {de ? "Allgemeiner Bericht (ohne Projekt)" : "General report (no project)"}
                  </em>
                </button>
                {filteredProjects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={selectedProject?.id === p.id}
                    className="construction-report-project-option"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectProject(String(p.id))}
                  >
                    {formatProjectTitle(p.project_number, p.customer_name, p.name, p.id)}
                  </button>
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
              tabIndex={selectedReportProject ? -1 : undefined}
              aria-readonly={Boolean(selectedReportProject)}
              placeholder={de ? "Optional" : "Optional"}
            />
          </label>
        </div>

        {/* ── Project name ──
            The customer name lives in the customer picker at the top of the
            form (it writes the same reportDraft.customer the PDF renders), so
            it is not duplicated here. */}
        <div className="construction-report-grid construction-report-grid--2col">
          <label className="construction-report-field">
            <span className="construction-report-label">{de ? "Projektname" : "Project name"}</span>
            <input
              className="construction-report-input"
              name="project_name"
              value={selectedReportProject?.name ?? reportDraft.project_name}
              onChange={(event) => updateReportDraftField("project_name", event.target.value)}
              readOnly={Boolean(selectedReportProject)}
              tabIndex={selectedReportProject ? -1 : undefined}
              aria-readonly={Boolean(selectedReportProject)}
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
              autoComplete="off"
              autoCapitalize="words"
              autoCorrect="off"
              spellCheck={false}
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
              autoComplete="off"
              inputMode="email"
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
              type="tel"
              inputMode="tel"
              autoComplete="off"
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
                <WorkerNameCombobox
                  language={de ? "de" : "en"}
                  className="construction-report-input"
                  value={worker.name}
                  users={assignableUsers}
                  onChange={(name) => updateReportWorker(index, "name", name)}
                  placeholder={de ? "Mitarbeiter suchen oder eintippen" : "Search or type a worker"}
                  freeTextHint={
                    de
                      ? "Freitext — kein hinterlegter Mitarbeiter."
                      : "Free text — not an app user."
                  }
                />
                <input
                  className="construction-report-input"
                  value={worker.start_time}
                  aria-label={de ? "Startzeit" : "Start time"}
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
                  aria-label={de ? "Endzeit" : "End time"}
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
          </div>
        </div>

        {/* ── Materials used ── */}
        <div className="construction-report-section">
          <div className="construction-report-section-head">
            <span className="construction-report-section-label">
              {de ? "Verbrauchtes Material" : "Materials consumed"}
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
                    aria-label={de ? "Artikel" : "Item"}
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
                    aria-label={de ? "Menge" : "Quantity"}
                    inputMode="decimal"
                    placeholder={de ? "Menge" : "Qty"}
                    onChange={(event) => updateReportMaterialRow(index, "qty", event.target.value)}
                    onKeyDown={handleMaterialRowKeyDown}
                  />
                  <input
                    className="construction-report-input"
                    value={row.unit}
                    list="material-unit-options"
                    aria-label={de ? "Einheit" : "Unit"}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    placeholder={de ? "Einheit" : "Unit"}
                    onChange={(event) => updateReportMaterialRow(index, "unit", event.target.value)}
                    onKeyDown={handleMaterialRowKeyDown}
                  />
                  <input
                    className="construction-report-input"
                    value={row.article_no}
                    aria-label={de ? "Artikelnummer" : "Article no."}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
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
              {de ? "Materialbedarf (bitte bestellen)" : "Material to order"}
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
                  aria-label={de ? "Artikel" : "Item"}
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
                  aria-label={de ? "Menge" : "Quantity"}
                  inputMode="decimal"
                  placeholder={de ? "Menge" : "Qty"}
                  onChange={(event) =>
                    updateReportOfficeMaterialRow(index, "qty", event.target.value)
                  }
                />
                <input
                  className="construction-report-input"
                  value={row.unit}
                  list="material-unit-options"
                  aria-label={de ? "Einheit" : "Unit"}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder={de ? "Einheit" : "Unit"}
                  onChange={(event) =>
                    updateReportOfficeMaterialRow(index, "unit", event.target.value)
                  }
                />
                <input
                  className="construction-report-input"
                  value={row.article_no}
                  aria-label={de ? "Artikelnummer" : "Article no."}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
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

        {/* ── v2.5.18: Status checkboxes ── */}
        <div className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de ? "Status (bitte ankreuzen)" : "Status (check applicable)"}
          </span>
          <div className="construction-report-status">
            <label className="construction-report-status-row">
              <input
                type="checkbox"
                checked={reportStatus.arrival_completed}
                onChange={(e) =>
                  setReportStatus({ ...reportStatus, arrival_completed: e.target.checked })
                }
              />
              <span>{de ? "An- und Abfahrt erfolgt" : "Arrival/Departure completed"}</span>
            </label>
            <label className="construction-report-status-row">
              <input
                type="checkbox"
                checked={reportStatus.work_finished}
                onChange={(e) =>
                  setReportStatus({ ...reportStatus, work_finished: e.target.checked })
                }
              />
              <span>{de ? "Arbeiten abgeschlossen" : "Work finished"}</span>
            </label>
            <label className="construction-report-status-row">
              <input
                type="checkbox"
                checked={reportStatus.handed_over_clean}
                onChange={(e) =>
                  setReportStatus({ ...reportStatus, handed_over_clean: e.target.checked })
                }
              />
              <span>
                {de
                  ? "Anlage störungsfrei dem Kunden übergeben"
                  : "System handed over to customer without issues"}
              </span>
            </label>
            <label className="construction-report-status-row">
              <input
                type="checkbox"
                checked={reportStatus.further_work_needed}
                onChange={(e) =>
                  setReportStatus({ ...reportStatus, further_work_needed: e.target.checked })
                }
              />
              <span>{de ? "Weitere Arbeiten notwendig" : "Further work required"}</span>
            </label>
            <label className="construction-report-status-row">
              <input
                type="checkbox"
                checked={reportStatus.extra_material_used}
                onChange={(e) =>
                  setReportStatus({ ...reportStatus, extra_material_used: e.target.checked })
                }
              />
              <span>
                {de
                  ? "Mehrverbrauch an Material lt. beiliegendem Materialschein"
                  : "Extra material per attached Materialschein"}
              </span>
            </label>
            <label className="construction-report-status-note">
              <span className="construction-report-label" style={{ fontSize: "0.85rem" }}>
                {de ? "Bemerkung (optional)" : "Note (optional)"}
              </span>
              <textarea
                className="construction-report-input construction-report-textarea"
                rows={2}
                value={reportStatus.note}
                onChange={(e) => setReportStatus({ ...reportStatus, note: e.target.value })}
                placeholder={de ? "Zusätzliche Anmerkungen zum Status…" : "Additional status notes…"}
              />
            </label>
          </div>
        </div>

        {/* ── v2.5.18: Kilometer with auto-fill ── */}
        <div className="construction-report-field construction-report-field--full">
          <div className="construction-report-distance">
            <label htmlFor="report-km-input">
              {de ? "Kilometer (gesamt):" : "Kilometers (total):"}
            </label>
            <input
              id="report-km-input"
              // type="text", not "number": on a German keyboard "12,5" makes a
              // number input report an EMPTY value, which used to null the
              // kilometres AND latch source:"manual" — and the auto-fetch
              // effect returns early forever once the source is "manual".
              type="text"
              inputMode="numeric"
              enterKeyHint="done"
              value={reportDistance.kilometers ?? ""}
              onChange={(e) => {
                const raw = e.target.value.replace(",", ".").trim();
                if (raw === "") {
                  // Only latch to "manual" when the operator cleared a value
                  // that was actually there; an empty field they never filled
                  // must stay eligible for auto-fill.
                  setReportDistance({
                    kilometers: null,
                    source: reportDistance.kilometers != null ? "manual" : "unset",
                  });
                  return;
                }
                const parsed = Number(raw);
                if (Number.isFinite(parsed) && parsed >= 0) {
                  setReportDistance({ kilometers: Math.round(parsed), source: "manual" });
                }
                // Transient garbage ("12,"): keep the previous state rather
                // than nulling the value out from under the typist.
              }}
              placeholder="0"
            />
            <span>km</span>
            {reportDistance.source === "auto" && reportDistance.kilometers !== null ? (
              <span className="construction-report-distance-badge" title={de
                ? "Automatisch aus der Strecke Büro → Baustelle berechnet (Hin- und Rückweg). Bei Bedarf manuell überschreiben."
                : "Auto-calculated from the office → site route (round-trip). Override manually if needed."}>
                {de ? "automatisch berechnet" : "auto-calculated"}
              </span>
            ) : null}
            {reportDistance.source === "manual" ? (
              <>
                <span className="construction-report-distance-badge manual">
                  {de ? "manuell eingegeben" : "manually entered"}
                </span>
                <button
                  type="button"
                  className="construction-report-distance-reset"
                  onClick={() => {
                    setReportDistance({ kilometers: null, source: "unset" });
                    // Without bumping this, the auto-fetch effect never re-ran
                    // and the button did nothing but change a badge.
                    setDistanceRefreshNonce((n) => n + 1);
                  }}
                  title={de ? "Wieder automatisch berechnen" : "Re-fetch auto-calculation"}
                >
                  ↺ {de ? "Auto" : "Auto"}
                </button>
              </>
            ) : null}
            {reportDistance.source === "unset" ? (
              <span className="construction-report-distance-badge error" title={de
                ? "Auto-Berechnung nicht verfügbar (Projektadresse oder Firmenadresse fehlt, oder OpenWeather-API-Key nicht gesetzt)."
                : "Auto-calculation unavailable (project or company address missing, or OpenWeather API key not set)."}>
                {de ? "manuell eingeben" : "enter manually"}
              </span>
            ) : null}
          </div>
        </div>

        {/* ── v2.5.18: Signatures ── */}
        <div className="construction-report-field construction-report-field--full">
          <span className="construction-report-label">
            {de ? "Unterschriften" : "Signatures"}
          </span>
          <div className="construction-report-signatures">
            <div>
              <SignaturePad
                id="report-signature-smpl"
                label={de ? "Für SMPL" : "For SMPL"}
                value={reportSignatureSmpl.image_base64}
                onChange={(dataUrl) =>
                  setReportSignatureSmpl({ ...reportSignatureSmpl, image_base64: dataUrl })
                }
                placeholder={de ? "Hier unterschreiben" : "Sign here"}
                language={de ? "de" : "en"}
                required
              />
              <input
                type="text"
                className="construction-report-input"
                style={{ marginTop: 6, width: "100%" }}
                placeholder={de ? "Name (Mitarbeiter)" : "Employee name"}
                value={reportSignatureSmpl.name}
                onChange={(e) =>
                  setReportSignatureSmpl({ ...reportSignatureSmpl, name: e.target.value })
                }
              />
            </div>
            <div>
              <SignaturePad
                label={de ? "Für den Kunden (optional)" : "For the customer (optional)"}
                value={reportSignatureCustomer.image_base64}
                onChange={(dataUrl) =>
                  setReportSignatureCustomer({ ...reportSignatureCustomer, image_base64: dataUrl })
                }
                placeholder={de ? "Optional — Kunde unterschreibt" : "Optional — customer signs"}
                language={de ? "de" : "en"}
              />
              <input
                type="text"
                className="construction-report-input"
                style={{ marginTop: 6, width: "100%" }}
                placeholder={de ? "Name (Kunde)" : "Customer name"}
                value={reportSignatureCustomer.name}
                onChange={(e) =>
                  setReportSignatureCustomer({ ...reportSignatureCustomer, name: e.target.value })
                }
              />
            </div>
          </div>
        </div>

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
              // Was an alert asserting a save that may not have happened: the
              // 800ms autosave debounce might not have fired, and its
              // hasContent gate rejects a photos/signature-only report
              // outright. Actually write it, and report what really happened.
              const savedAt = flushReportDraft();
              if (savedAt) {
                setNotice(
                  de
                    ? `Entwurf gespeichert um ${new Date(savedAt).toLocaleTimeString("de-DE")}`
                    : `Draft saved at ${new Date(savedAt).toLocaleTimeString("en-GB")}`,
                );
              } else {
                setNotice(
                  de
                    ? "Nichts zu speichern — das Formular ist noch leer."
                    : "Nothing to save — the form is still empty.",
                );
              }
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
        </fieldset>
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
