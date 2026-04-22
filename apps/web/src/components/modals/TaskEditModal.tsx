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
  taskStatusLabel,
} from "../../utils/tasks";
import { formatServerDateTime } from "../../utils/dates";
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

export function TaskEditModal() {
  const {
    language,
    taskEditModalOpen,
    taskEditForm,
    taskEditOverlapWarning,
    setTaskEditOverlapWarning,
    setTaskEditForm,
    taskEditMaterialRows,
    taskEditProjectClassTemplates,
    taskEditAssigneeSuggestions,
    taskEditExpectedUpdatedAt,
    assignableUsers,
    projects,
    taskStatusOptions,
    canManageTasks,
    closeTaskEditModal,
    saveTaskEdit,
    deleteTaskFromEdit,
    updateTaskEditField,
    updateTaskEditMaterialRow,
    addTaskEditMaterialRow,
    removeTaskEditMaterialRow,
    selectTaskEditClassTemplate,
    addTaskEditAssignee,
    removeTaskEditAssignee,
    addFirstMatchingTaskEditAssignee,
    enrichTaskEditMaterialRowFromCatalog,
    assigneeAvailabilityHint,
    menuUserNameById,
    taskProjectTitleParts,
    onTaskEditModalBackdropPointerDown,
    onTaskEditModalBackdropPointerUp,
    resetTaskEditModalBackdropPointerState,
    partners,
    openPartnerModal,
  } = useAppContext();

  const [partnerQuery, setPartnerQuery] = useState("");

  if (!taskEditModalOpen) return null;

  const de = language === "de";
  const priorityOptions: TaskPriority[] = ["low", "normal", "high", "urgent"];
  const activePriority = taskEditForm.priority ?? "normal";

  // Resolve the current project to show its label in the eyebrow, falling back
  // to the task's project_id lookup when no selected project helper exists.
  const projectForEyebrow = taskEditForm.project_id
    ? projects.find((project) => project.id === taskEditForm.project_id) ?? null
    : null;
  const eyebrowLabel = projectForEyebrow
    ? taskProjectTitleParts({
        project_id: projectForEyebrow.id,
      } as unknown as Parameters<typeof taskProjectTitleParts>[0]).title
    : de
      ? "Allgemeine Aufgabe"
      : "General task";

  return (
    <div
      className="modal-backdrop"
      onPointerDown={onTaskEditModalBackdropPointerDown}
      onPointerUp={onTaskEditModalBackdropPointerUp}
      onPointerCancel={resetTaskEditModalBackdropPointerState}
      onPointerLeave={resetTaskEditModalBackdropPointerState}
    >
      <div
        className="card modal-card task-modal-card"
        onClick={(event) => event.stopPropagation()}
      >
        <form
          className="task-modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveTaskEdit();
          }}
        >
          <header className="task-modal-head">
            <div className="task-modal-eyebrow">
              <span className="task-modal-eyebrow-label">
                {de ? "AUFGABE BEARBEITEN" : "EDIT TASK"}
              </span>
              <span aria-hidden="true" className="task-modal-eyebrow-sep">
                ·
              </span>
              <span className="task-modal-eyebrow-project">{eyebrowLabel}</span>
            </div>
            <h2 className="task-modal-title">
              {taskEditForm.title || (de ? "Aufgabe" : "Task")}
            </h2>
          </header>

          {/* Title + Information */}
          <section className="task-modal-section task-modal-section--stack">
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Titel" : "Title"}</span>
              <input
                className="task-modal-input"
                value={taskEditForm.title}
                onChange={(event) => updateTaskEditField("title", event.target.value)}
                placeholder={de ? "Aufgabentitel" : "Task title"}
                required
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Information" : "Information"}</span>
              <textarea
                className="task-modal-input task-modal-textarea"
                value={taskEditForm.description}
                onChange={(event) => updateTaskEditField("description", event.target.value)}
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
                value={taskEditForm.task_type}
                onChange={(event) =>
                  updateTaskEditField("task_type", normalizeTaskTypeValue(event.target.value))
                }
              >
                <option value="construction">{taskTypeLabel("construction", language)}</option>
                <option value="office">{taskTypeLabel("office", language)}</option>
                <option value="customer_appointment">
                  {taskTypeLabel("customer_appointment", language)}
                </option>
              </select>
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Projektklasse" : "Project class"}
              </span>
              <select
                className="task-modal-input task-modal-select"
                value={taskEditForm.class_template_id}
                onChange={(event) => selectTaskEditClassTemplate(event.target.value)}
              >
                <option value="">{de ? "Keine Klasse" : "No class"}</option>
                {taskEditProjectClassTemplates.map((entry) => (
                  <option key={`task-edit-class-template-${entry.id}`} value={String(entry.id)}>
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
                    checked={taskEditForm.has_storage_box}
                    onChange={(event) =>
                      setTaskEditForm((current) => ({
                        ...current,
                        has_storage_box: event.target.checked,
                        storage_box_number: event.target.checked ? current.storage_box_number : "",
                      }))
                    }
                  />
                  <span>{de ? "Box verwenden" : "Use box"}</span>
                </label>
                {taskEditForm.has_storage_box && (
                  <input
                    className="task-modal-input task-modal-storage-box-input"
                    type="number"
                    min={1}
                    step={1}
                    value={taskEditForm.storage_box_number}
                    onChange={(event) =>
                      updateTaskEditField("storage_box_number", event.target.value)
                    }
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
              <span className="task-modal-field-label">
                {de ? "Fälligkeitsdatum" : "Due date"}
              </span>
              <input
                className="task-modal-input"
                type="date"
                value={taskEditForm.due_date}
                onChange={(event) => updateTaskEditField("due_date", event.target.value)}
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
                value={taskEditForm.start_time}
                onChange={(event) =>
                  updateTaskEditField("start_time", formatTimeInputForTyping(event.target.value))
                }
                onBlur={(event) =>
                  updateTaskEditField("start_time", formatTimeInputForBlur(event.target.value))
                }
              />
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Dauer (h)" : "Duration (h)"}</span>
              <input
                className="task-modal-input"
                type="number"
                min={0.5}
                step={0.5}
                value={taskEditForm.estimated_hours}
                onChange={(event) =>
                  updateTaskEditField("estimated_hours", event.target.value)
                }
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
                    updateTaskEditField("priority", event.target.value as TaskPriority)
                  }
                >
                  {priorityOptions.map((value) => (
                    <option key={`task-edit-priority-${value}`} value={value}>
                      {priorityLabel(value, language)}
                    </option>
                  ))}
                </select>
              </div>
            </label>
          </section>

          {/* Status + Last edited */}
          <section className="task-modal-section task-modal-section--grid2">
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Status" : "Status"}</span>
              <select
                className="task-modal-input task-modal-select"
                value={taskEditForm.status}
                onChange={(event) => updateTaskEditField("status", event.target.value)}
                required
              >
                {taskStatusOptions.map((statusValue) => (
                  <option key={statusValue} value={statusValue}>
                    {taskStatusLabel(statusValue, language)}
                  </option>
                ))}
              </select>
            </label>
            <label className="task-modal-field">
              <span className="task-modal-field-label">
                {de ? "Zuletzt bearbeitet" : "Last edited"}
              </span>
              <input
                className="task-modal-input"
                type="text"
                value={
                  taskEditExpectedUpdatedAt
                    ? formatServerDateTime(taskEditExpectedUpdatedAt, language)
                    : de
                      ? "Unbekannt"
                      : "Unknown"
                }
                readOnly
              />
            </label>
          </section>

          {/* Sub-tasks */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "UNTERAUFGABEN" : "SUB-TASKS"}
              </span>
              <span className="task-modal-section-hint">
                {de ? "Eine pro Zeile" : "One per line"}
              </span>
            </div>
            <textarea
              className="task-modal-input task-modal-textarea"
              value={taskEditForm.subtasks_raw}
              onChange={(event) => updateTaskEditField("subtasks_raw", event.target.value)}
              placeholder={
                de ? "- Erste Unteraufgabe\n- Zweite Unteraufgabe" : "- First sub-task\n- Second sub-task"
              }
              rows={4}
            />
          </section>

          {/* Materials */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "MATERIALIEN" : "MATERIALS"}
              </span>
              <button
                type="button"
                className="task-modal-section-action"
                onClick={addTaskEditMaterialRow}
              >
                + {de ? "Material hinzufügen" : "Add material"}
              </button>
            </div>
            <div className="task-modal-materials">
              {taskEditMaterialRows.length === 0 && (
                <div className="task-modal-materials-empty muted">
                  {de ? "Noch kein Material hinzugefügt." : "No materials added yet."}
                </div>
              )}
              {taskEditMaterialRows.map((row, index) => (
                <div key={row.id} className="task-modal-material-row">
                  <input
                    className="task-modal-material-item"
                    value={row.item}
                    onChange={(event) =>
                      updateTaskEditMaterialRow(index, "item", event.target.value)
                    }
                    onBlur={() => {
                      void enrichTaskEditMaterialRowFromCatalog(index, "item");
                    }}
                    placeholder={de ? "z. B. Kabel NYM" : "e.g. cable NYM"}
                  />
                  <input
                    className="task-modal-material-qty"
                    value={row.qty}
                    onChange={(event) =>
                      updateTaskEditMaterialRow(index, "qty", event.target.value)
                    }
                    placeholder="1"
                  />
                  <input
                    className="task-modal-material-unit"
                    value={row.unit}
                    list="material-unit-options"
                    onChange={(event) =>
                      updateTaskEditMaterialRow(index, "unit", event.target.value)
                    }
                    placeholder={de ? "Stk" : "pcs"}
                  />
                  <input
                    className="task-modal-material-ref"
                    value={row.article_no}
                    onChange={(event) =>
                      updateTaskEditMaterialRow(index, "article_no", event.target.value)
                    }
                    onBlur={() => {
                      void enrichTaskEditMaterialRowFromCatalog(index, "article_no");
                    }}
                    placeholder="A-1001"
                  />
                  <button
                    type="button"
                    className="task-modal-material-remove"
                    onClick={() => removeTaskEditMaterialRow(index)}
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
              <span className="task-modal-section-label">
                {de ? "ZUGEWIESEN" : "ASSIGNEES"}
              </span>
            </div>
            <div className="task-modal-assignee-picker">
              <input
                className="task-modal-input"
                value={taskEditForm.assignee_query}
                onChange={(event) => updateTaskEditField("assignee_query", event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addFirstMatchingTaskEditAssignee();
                }}
                placeholder={de ? "Namen eingeben und auswählen" : "Type user name and select"}
              />
              {taskEditAssigneeSuggestions.length > 0 && (
                <div className="assignee-suggestions">
                  {taskEditAssigneeSuggestions.map((assignee) => {
                    const hint = assigneeAvailabilityHint(assignee.id, taskEditForm.due_date);
                    const displayName = menuUserNameById(
                      assignee.id,
                      assignee.display_name || assignee.full_name,
                    );
                    return (
                      <button
                        key={assignee.id}
                        type="button"
                        className="assignee-suggestion-btn task-assignee-suggestion-btn"
                        onClick={() => addTaskEditAssignee(assignee.id)}
                      >
                        <span className="assignee-primary-label">
                          {displayName} (#{assignee.id})
                        </span>
                        {hint ? (
                          <small className="assignee-availability-note">{hint}</small>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="task-modal-assignee-chip-list">
                {taskEditForm.assignee_ids.map((assigneeId) => {
                  const assignee = assignableUsers.find((entry) => entry.id === assigneeId);
                  const displayName = assignee
                    ? menuUserNameById(assignee.id, assignee.display_name || assignee.full_name)
                    : `#${assigneeId}`;
                  const hint = assignee
                    ? assigneeAvailabilityHint(assignee.id, taskEditForm.due_date)
                    : "";
                  return (
                    <button
                      key={assigneeId}
                      type="button"
                      className="task-modal-assignee-chip"
                      onClick={() => removeTaskEditAssignee(assigneeId)}
                      title={de ? "Entfernen" : "Remove"}
                    >
                      <span className="task-modal-assignee-avatar" aria-hidden="true">
                        {assigneeInitials(displayName)}
                      </span>
                      <span className="task-modal-assignee-name">{displayName}</span>
                      <span aria-hidden="true" className="task-modal-assignee-remove">
                        ×
                      </span>
                      {hint ? (
                        <small className="assignee-availability-note">{hint}</small>
                      ) : null}
                    </button>
                  );
                })}
                {taskEditForm.assignee_ids.length === 0 && (
                  <small className="muted">
                    {de ? "Noch keine Personen ausgewählt." : "No people selected yet."}
                  </small>
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
              value={taskEditForm.partner_ids}
              onAdd={(partnerId) => {
                setTaskEditForm((current) => {
                  if (current.partner_ids.includes(partnerId)) return current;
                  return { ...current, partner_ids: [...current.partner_ids, partnerId] };
                });
              }}
              onRemove={(partnerId) => {
                setTaskEditForm((current) => ({
                  ...current,
                  partner_ids: current.partner_ids.filter((id) => id !== partnerId),
                }));
              }}
              onRequestCreate={(prefillName) => {
                openPartnerModal({
                  prefillName,
                  onSaved: (created) => {
                    setTaskEditForm((current) => {
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

          {taskEditOverlapWarning && (
            <section className="task-modal-section task-modal-overlap-warning">
              <b>
                {de
                  ? "Zeitüberschneidung mit bestehenden Aufgaben"
                  : "Time overlap with existing tasks"}
              </b>
              <small>
                {de
                  ? "Die ausgewählten Personen haben in diesem Zeitraum bereits Aufgaben. Änderung trotzdem speichern?"
                  : "The selected people already have tasks in this time window. Save the change anyway?"}
              </small>
              <ul className="task-overlap-warning-list">
                {taskEditOverlapWarning.overlaps.map((overlap) => {
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
                    <li key={`task-edit-overlap-${overlap.task_id}`}>
                      <b>{overlap.title}</b>
                      <small>
                        {[
                          project
                            ? `${project.project_number} - ${project.name}`
                            : `#${overlap.project_id}`,
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
                      {overlap.overlap_type === "travel_overlap" &&
                      overlap.travel_minutes &&
                      overlap.end_time ? (
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
                  onClick={() => void saveTaskEdit(true)}
                >
                  {de ? "Trotzdem speichern" : "Save anyway"}
                </button>
                <button
                  type="button"
                  className="task-modal-btn task-modal-btn--ghost"
                  onClick={() => setTaskEditOverlapWarning(null)}
                >
                  {de ? "Zurück" : "Back"}
                </button>
              </div>
            </section>
          )}

          <footer className="task-modal-footer">
            {canManageTasks && (
              <button
                type="button"
                className="task-modal-btn project-modal-btn--danger"
                onClick={() => void deleteTaskFromEdit()}
              >
                {de ? "Löschen" : "Delete"}
              </button>
            )}
            <div className="project-modal-footer-spacer" />
            <button
              type="button"
              className="task-modal-btn task-modal-btn--ghost"
              onClick={closeTaskEditModal}
            >
              {de ? "Abbrechen" : "Cancel"}
            </button>
            <button type="submit" className="task-modal-btn task-modal-btn--primary">
              {de ? "Speichern" : "Save"}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
