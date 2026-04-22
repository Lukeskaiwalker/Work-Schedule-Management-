import { useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { HHMM_PATTERN } from "../../constants";
import type { TaskPriority } from "../../types";
import {
  taskTypeLabel,
  normalizeTaskTypeValue,
  formatTimeInputForTyping,
  formatTimeInputForBlur,
  addMinutesToHHMM,
} from "../../utils/tasks";
import { PartnerMultiSelect } from "../partners/PartnerMultiSelect";

function priorityLabel(value: TaskPriority, language: "de" | "en"): string {
  if (value === "low") return language === "de" ? "Niedrig" : "Low";
  if (value === "high") return language === "de" ? "Hoch" : "High";
  if (value === "urgent") return language === "de" ? "Dringend" : "Urgent";
  return language === "de" ? "Normal" : "Normal";
}

function priorityDotColor(value: TaskPriority): string {
  if (value === "urgent") return "#E34B4B";
  if (value === "high") return "#F5B000";
  if (value === "low") return "#6EA54F";
  return "#2F70B7";
}

function assigneeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    const first = parts[0] ?? "";
    return first.slice(0, 2).toUpperCase();
  }
  const first = parts[0] ?? "";
  const last = parts[parts.length - 1] ?? "";
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

export function TaskModal() {
  const {
    language,
    taskModalOpen,
    taskModalForm,
    taskModalOverlapWarning,
    setTaskModalOverlapWarning,
    setTaskModalForm,
    taskModalMaterialRows,
    taskModalProjectSuggestions,
    selectedTaskModalProject,
    taskModalProjectClassTemplates,
    taskModalAssigneeSuggestions,
    assignableUsers,
    projects,
    canCreateProject,
    closeTaskModal,
    createWeeklyPlanTask,
    updateTaskModalField,
    updateTaskModalMaterialRow,
    addTaskModalMaterialRow,
    removeTaskModalMaterialRow,
    selectTaskModalClassTemplate,
    addTaskModalAssignee,
    removeTaskModalAssignee,
    addFirstMatchingTaskModalAssignee,
    selectTaskModalProject,
    projectSearchLabel,
    enrichTaskModalMaterialRowFromCatalog,
    assigneeAvailabilityHint,
    menuUserNameById,
    onTaskModalBackdropPointerDown,
    onTaskModalBackdropPointerUp,
    resetTaskModalBackdropPointerState,
    partners,
    openPartnerModal,
  } = useAppContext();

  const [partnerQuery, setPartnerQuery] = useState("");

  if (!taskModalOpen) return null;

  const de = language === "de";
  const eyebrowProjectLabel = selectedTaskModalProject
    ? projectSearchLabel(selectedTaskModalProject)
    : de
      ? "Neues Projekt"
      : "New project";

  const priorityOptions: TaskPriority[] = ["low", "normal", "high", "urgent"];
  const activePriority = taskModalForm.priority ?? "normal";

  return (
    <div
      className="modal-backdrop"
      onPointerDown={onTaskModalBackdropPointerDown}
      onPointerUp={onTaskModalBackdropPointerUp}
      onPointerCancel={resetTaskModalBackdropPointerState}
      onPointerLeave={resetTaskModalBackdropPointerState}
    >
      <div className="card modal-card task-modal-card" onClick={(event) => event.stopPropagation()}>
        <form
          className="task-modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createWeeklyPlanTask();
          }}
        >
          <header className="task-modal-head">
            <div className="task-modal-eyebrow">
              <span className="task-modal-eyebrow-label">{de ? "AUFGABE ERSTELLEN" : "CREATE TASK"}</span>
              <span aria-hidden="true" className="task-modal-eyebrow-sep">
                ·
              </span>
              <span className="task-modal-eyebrow-project">{eyebrowProjectLabel}</span>
            </div>
            <h2 className="task-modal-title">{de ? "Neue Aufgabe" : "New task"}</h2>
          </header>

          {/* Title + Information */}
          <section className="task-modal-section task-modal-section--stack">
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Titel" : "Title"}</span>
              <input
                className="task-modal-input"
                value={taskModalForm.title}
                onChange={(event) => updateTaskModalField("title", event.target.value)}
                placeholder={de ? "Aufgabentitel" : "Task title"}
                required
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Information" : "Information"}</span>
              <textarea
                className="task-modal-input task-modal-textarea"
                value={taskModalForm.description}
                onChange={(event) => updateTaskModalField("description", event.target.value)}
                placeholder={de ? "Beschreibung der Aufgabe" : "Task description"}
                rows={3}
              />
            </label>
          </section>

          {/* Task type / Project class / Storage box */}
          <section className="task-modal-section task-modal-section--grid3">
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Aufgabentyp" : "Task type"}</span>
              <select
                className="task-modal-input task-modal-select"
                value={taskModalForm.task_type}
                onChange={(event) => updateTaskModalField("task_type", normalizeTaskTypeValue(event.target.value))}
              >
                <option value="construction">{taskTypeLabel("construction", language)}</option>
                <option value="office">{taskTypeLabel("office", language)}</option>
                <option value="customer_appointment">{taskTypeLabel("customer_appointment", language)}</option>
              </select>
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Projektklasse" : "Project class"}</span>
              <select
                className="task-modal-input task-modal-select"
                value={taskModalForm.class_template_id}
                onChange={(event) => selectTaskModalClassTemplate(event.target.value)}
              >
                <option value="">{de ? "Keine Klasse" : "No class"}</option>
                {taskModalProjectClassTemplates.map((entry) => (
                  <option key={`task-modal-class-template-${entry.id}`} value={String(entry.id)}>
                    {entry.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Lagerbox" : "Storage box"}</span>
              <div className="task-modal-storage-box">
                <label className="task-modal-storage-box-toggle">
                  <input
                    type="checkbox"
                    checked={taskModalForm.has_storage_box}
                    onChange={(event) =>
                      setTaskModalForm((current) => ({
                        ...current,
                        has_storage_box: event.target.checked,
                        storage_box_number: event.target.checked ? current.storage_box_number : "",
                      }))
                    }
                  />
                  <span>{de ? "Box verwenden" : "Use box"}</span>
                </label>
                {taskModalForm.has_storage_box && (
                  <input
                    className="task-modal-input task-modal-storage-box-input"
                    type="number"
                    min={1}
                    step={1}
                    value={taskModalForm.storage_box_number}
                    onChange={(event) => updateTaskModalField("storage_box_number", event.target.value)}
                    placeholder="Box 7-A"
                    required
                  />
                )}
              </div>
            </label>
          </section>

          {/* Due date / Start time / Duration / Priority */}
          <section className="task-modal-section task-modal-section--grid4">
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Fälligkeitsdatum" : "Due date"}</span>
              <input
                className="task-modal-input"
                type="date"
                value={taskModalForm.due_date}
                onChange={(event) => updateTaskModalField("due_date", event.target.value)}
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Startzeit" : "Start time"}</span>
              <input
                className="task-modal-input"
                type="text"
                inputMode="numeric"
                placeholder="HH:MM"
                pattern={HHMM_PATTERN}
                title="HH:MM (24h)"
                maxLength={5}
                value={taskModalForm.start_time}
                onChange={(event) => updateTaskModalField("start_time", formatTimeInputForTyping(event.target.value))}
                onBlur={(event) => updateTaskModalField("start_time", formatTimeInputForBlur(event.target.value))}
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Dauer (h)" : "Duration (h)"}</span>
              <input
                className="task-modal-input"
                type="number"
                min={0.5}
                step={0.5}
                value={taskModalForm.estimated_hours}
                onChange={(event) => updateTaskModalField("estimated_hours", event.target.value)}
                placeholder="1.5"
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Priorität" : "Priority"}</span>
              <div className="task-modal-priority-wrap">
                <span
                  className="task-modal-priority-dot"
                  aria-hidden="true"
                  style={{ backgroundColor: priorityDotColor(activePriority) }}
                />
                <select
                  className="task-modal-input task-modal-select task-modal-priority-select"
                  value={activePriority}
                  onChange={(event) =>
                    updateTaskModalField("priority", event.target.value as TaskPriority)
                  }
                >
                  {priorityOptions.map((value) => (
                    <option key={`task-priority-${value}`} value={value}>
                      {priorityLabel(value, language)}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          </section>

          {/* Project picker — kept for non-project-scoped openings */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">{de ? "PROJEKT" : "PROJECT"}</span>
            </div>
            <div className="task-modal-project-picker">
              <input
                className="task-modal-input"
                value={taskModalForm.project_query}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setTaskModalForm((current) => {
                    if (!current.project_id) return { ...current, project_query: nextQuery };
                    const currentProject = projects.find((project) => String(project.id) === current.project_id);
                    if (!currentProject) {
                      return { ...current, project_query: nextQuery, project_id: "", class_template_id: "" };
                    }
                    return projectSearchLabel(currentProject) === nextQuery
                      ? { ...current, project_query: nextQuery }
                      : { ...current, project_query: nextQuery, project_id: "", class_template_id: "" };
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const first = taskModalProjectSuggestions[0];
                  if (first) selectTaskModalProject(first);
                }}
                placeholder={de ? "Projektnummer, Kunde oder Projektname" : "Project number, customer, or project name"}
              />
              {taskModalProjectSuggestions.length > 0 && (
                <div className="assignee-suggestions">
                  {taskModalProjectSuggestions.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className="assignee-suggestion-btn"
                      onClick={() => selectTaskModalProject(project)}
                    >
                      {projectSearchLabel(project)}
                    </button>
                  ))}
                </div>
              )}
              <div className="assignee-chip-list">
                {selectedTaskModalProject ? (
                  <button
                    type="button"
                    className="assignee-chip"
                    onClick={() =>
                      setTaskModalForm((current) => ({
                        ...current,
                        project_id: "",
                        project_query: "",
                        class_template_id: "",
                      }))
                    }
                    title={de ? "Entfernen" : "Remove"}
                  >
                    {projectSearchLabel(selectedTaskModalProject) + " ×"}
                  </button>
                ) : (
                  <small className="muted">{de ? "Noch kein Projekt ausgewählt." : "No project selected yet."}</small>
                )}
              </div>
            </div>
            {!selectedTaskModalProject && canCreateProject && (
              <>
                <label className="checkbox-inline task-modal-create-project-toggle">
                  <input
                    type="checkbox"
                    checked={taskModalForm.create_project_from_task}
                    onChange={(event) => updateTaskModalField("create_project_from_task", event.target.checked)}
                  />
                  {de
                    ? "Falls nötig, neues Projekt aus dieser Aufgabe erstellen"
                    : "Create a new project from this task if needed"}
                </label>
                {taskModalForm.create_project_from_task && (
                  <div className="task-modal-section task-modal-section--grid2">
                    <label className="task-modal-field">
                      <span className="task-modal-field-label">{de ? "Projektname" : "Project name"}</span>
                      <input
                        className="task-modal-input"
                        value={taskModalForm.new_project_name}
                        onChange={(event) => updateTaskModalField("new_project_name", event.target.value)}
                        placeholder={de ? "Standard: Aufgabentitel" : "Default: task title"}
                      />
                    </label>
                    <label className="task-modal-field">
                      <span className="task-modal-field-label">{de ? "Projektnummer" : "Project number"}</span>
                      <input
                        className="task-modal-input"
                        value={taskModalForm.new_project_number}
                        onChange={(event) => updateTaskModalField("new_project_number", event.target.value)}
                        placeholder={de ? "Optional (auto: T...)" : "Optional (auto: T...)"}
                      />
                    </label>
                  </div>
                )}
              </>
            )}
          </section>

          {/* Sub-tasks */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">{de ? "UNTERAUFGABEN" : "SUB-TASKS"}</span>
              <span className="task-modal-section-hint">
                {de ? "Eine pro Zeile" : "One per line"}
              </span>
            </div>
            <textarea
              className="task-modal-input task-modal-textarea"
              value={taskModalForm.subtasks_raw}
              onChange={(event) => updateTaskModalField("subtasks_raw", event.target.value)}
              placeholder={de ? "- Erste Unteraufgabe\n- Zweite Unteraufgabe" : "- First sub-task\n- Second sub-task"}
              rows={4}
            />
          </section>

          {/* Materials */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">{de ? "MATERIALIEN" : "MATERIALS"}</span>
              <button
                type="button"
                className="task-modal-section-action"
                onClick={addTaskModalMaterialRow}
              >
                + {de ? "Material hinzufügen" : "Add material"}
              </button>
            </div>
            <div className="task-modal-materials">
              {taskModalMaterialRows.length === 0 && (
                <div className="task-modal-materials-empty muted">
                  {de ? "Noch kein Material hinzugefügt." : "No materials added yet."}
                </div>
              )}
              {taskModalMaterialRows.map((row, index) => (
                <div key={row.id} className="task-modal-material-row">
                  <input
                    className="task-modal-material-item"
                    value={row.item}
                    onChange={(event) => updateTaskModalMaterialRow(index, "item", event.target.value)}
                    onBlur={() => {
                      void enrichTaskModalMaterialRowFromCatalog(index, "item");
                    }}
                    placeholder={de ? "z. B. Kabel NYM" : "e.g. cable NYM"}
                  />
                  <input
                    className="task-modal-material-qty"
                    value={row.qty}
                    onChange={(event) => updateTaskModalMaterialRow(index, "qty", event.target.value)}
                    placeholder="1"
                  />
                  <input
                    className="task-modal-material-unit"
                    value={row.unit}
                    list="material-unit-options"
                    onChange={(event) => updateTaskModalMaterialRow(index, "unit", event.target.value)}
                    placeholder={de ? "Stk" : "pcs"}
                  />
                  <input
                    className="task-modal-material-ref"
                    value={row.article_no}
                    onChange={(event) => updateTaskModalMaterialRow(index, "article_no", event.target.value)}
                    onBlur={() => {
                      void enrichTaskModalMaterialRowFromCatalog(index, "article_no");
                    }}
                    placeholder="A-1001"
                  />
                  <button
                    type="button"
                    className="task-modal-material-remove"
                    onClick={() => removeTaskModalMaterialRow(index)}
                    aria-label={de ? "Entfernen" : "Remove"}
                    title={de ? "Entfernen" : "Remove"}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Assignees */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">{de ? "ZUGEWIESEN" : "ASSIGNEES"}</span>
            </div>
            <div className="task-modal-assignee-picker">
              <input
                className="task-modal-input"
                value={taskModalForm.assignee_query}
                onChange={(event) => updateTaskModalField("assignee_query", event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addFirstMatchingTaskModalAssignee();
                }}
                placeholder={de ? "Namen eingeben und auswählen" : "Type user name and select"}
              />
              {taskModalAssigneeSuggestions.length > 0 && (
                <div className="assignee-suggestions">
                  {taskModalAssigneeSuggestions.map((assignee) => {
                    const hint = assigneeAvailabilityHint(assignee.id, taskModalForm.due_date);
                    const displayName = menuUserNameById(
                      assignee.id,
                      assignee.display_name || assignee.full_name,
                    );
                    return (
                      <button
                        key={assignee.id}
                        type="button"
                        className="assignee-suggestion-btn task-assignee-suggestion-btn"
                        onClick={() => addTaskModalAssignee(assignee.id)}
                      >
                        <span className="assignee-primary-label">
                          {displayName} (#{assignee.id})
                        </span>
                        {hint ? <small className="assignee-availability-note">{hint}</small> : null}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="task-modal-assignee-chip-list">
                {taskModalForm.assignee_ids.map((assigneeId) => {
                  const assignee = assignableUsers.find((entry) => entry.id === assigneeId);
                  const displayName = assignee
                    ? menuUserNameById(assignee.id, assignee.display_name || assignee.full_name)
                    : `#${assigneeId}`;
                  const hint = assignee ? assigneeAvailabilityHint(assignee.id, taskModalForm.due_date) : "";
                  return (
                    <button
                      key={assigneeId}
                      type="button"
                      className="task-modal-assignee-chip"
                      onClick={() => removeTaskModalAssignee(assigneeId)}
                      title={de ? "Entfernen" : "Remove"}
                    >
                      <span className="task-modal-assignee-avatar" aria-hidden="true">
                        {assigneeInitials(displayName)}
                      </span>
                      <span className="task-modal-assignee-name">{displayName}</span>
                      <span aria-hidden="true" className="task-modal-assignee-remove">
                        ×
                      </span>
                      {hint ? <small className="assignee-availability-note">{hint}</small> : null}
                    </button>
                  );
                })}
                {taskModalForm.assignee_ids.length === 0 && (
                  <small className="muted">{de ? "Noch keine Personen ausgewählt." : "No people selected yet."}</small>
                )}
              </div>
            </div>
          </section>

          {/* Partner / External contractor */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "PARTNER / EXTERNE FIRMA" : "EXTERNAL CONTRACTOR"}
              </span>
              <span className="task-modal-section-hint">
                {de ? "Optional" : "Optional"}
              </span>
            </div>
            <PartnerMultiSelect
              language={de ? "de" : "en"}
              query={partnerQuery}
              onQueryChange={setPartnerQuery}
              partners={partners}
              value={taskModalForm.partner_ids}
              onAdd={(partnerId) => {
                setTaskModalForm((current) => {
                  if (current.partner_ids.includes(partnerId)) return current;
                  return { ...current, partner_ids: [...current.partner_ids, partnerId] };
                });
              }}
              onRemove={(partnerId) => {
                setTaskModalForm((current) => ({
                  ...current,
                  partner_ids: current.partner_ids.filter((id) => id !== partnerId),
                }));
              }}
              onRequestCreate={(prefillName) => {
                openPartnerModal({
                  prefillName,
                  onSaved: (created) => {
                    setTaskModalForm((current) => {
                      if (current.partner_ids.includes(created.id)) return current;
                      return {
                        ...current,
                        partner_ids: [...current.partner_ids, created.id],
                      };
                    });
                    setPartnerQuery("");
                  },
                });
              }}
            />
          </section>

          {taskModalOverlapWarning && (
            <section className="task-modal-section task-modal-overlap-warning">
              <b>{de ? "Zeitüberschneidung mit bestehenden Aufgaben" : "Time overlap with existing tasks"}</b>
              <small>
                {de
                  ? "Die ausgewählten Personen haben in diesem Zeitraum bereits Aufgaben. Aufgabe trotzdem erstellen?"
                  : "The selected people already have tasks in this time window. Create this task anyway?"}
              </small>
              <ul className="task-overlap-warning-list">
                {taskModalOverlapWarning.overlaps.map((overlap) => {
                  const project = projects.find((entry) => entry.id === overlap.project_id);
                  const sharedNames = overlap.shared_assignee_ids
                    .map((assigneeId) => {
                      const assignee = assignableUsers.find((entry) => entry.id === assigneeId);
                      return menuUserNameById(
                        assigneeId,
                        assignee?.display_name || assignee?.full_name || `#${assigneeId}`,
                      );
                    })
                    .join(", ");
                  return (
                    <li key={`task-overlap-${overlap.task_id}`}>
                      <b>{overlap.title}</b>
                      <small>
                        {[
                          project ? projectSearchLabel(project) : `#${overlap.project_id}`,
                          overlap.start_time && overlap.end_time
                            ? `${formatTimeInputForBlur(overlap.start_time)}-${formatTimeInputForBlur(overlap.end_time)}`
                            : "",
                          sharedNames,
                        ]
                          .filter((value) => value && value.length > 0)
                          .join(" · ")}
                      </small>
                      {overlap.overlap_type === "travel_overlap" && overlap.travel_minutes ? (
                        <small className="assignee-availability-note">
                          {de
                            ? `Zusätzliche Fahrzeit: ca. ${overlap.travel_minutes} Min.`
                            : `Additional travel time: about ${overlap.travel_minutes} min.`}
                        </small>
                      ) : null}
                      {overlap.overlap_type === "travel_overlap" && overlap.travel_minutes && overlap.end_time ? (
                        <small className="assignee-availability-note">
                          {de
                            ? `Frühester sinnvoller Start nach dieser Aufgabe: ${addMinutesToHHMM(overlap.end_time, overlap.travel_minutes)}`
                            : `Earliest sensible start after this task: ${addMinutesToHHMM(overlap.end_time, overlap.travel_minutes)}`}
                        </small>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <div className="row wrap">
                <button
                  type="button"
                  className="task-modal-btn task-modal-btn--primary"
                  onClick={() => void createWeeklyPlanTask(true)}
                >
                  {de ? "Trotzdem erstellen" : "Create anyway"}
                </button>
                <button
                  type="button"
                  className="task-modal-btn task-modal-btn--ghost"
                  onClick={() => setTaskModalOverlapWarning(null)}
                >
                  {de ? "Zurück" : "Back"}
                </button>
              </div>
            </section>
          )}

          <footer className="task-modal-footer">
            <button type="button" className="task-modal-btn task-modal-btn--ghost" onClick={closeTaskModal}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button type="button" className="task-modal-btn task-modal-btn--secondary" disabled>
              {de ? "Als Entwurf speichern" : "Save as draft"}
            </button>
            <button type="submit" className="task-modal-btn task-modal-btn--primary">
              {de ? "Aufgabe erstellen" : "Create task"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
