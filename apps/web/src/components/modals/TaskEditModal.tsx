import { useState } from "react";
import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { HHMM_PATTERN } from "../../constants";
import type { Task, TaskPriority } from "../../types";
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
    // v2.5.1: needed for the inline manual-confirm POST against
    // /tasks/{id}/customer-confirmation/manual. apiFetch + token live
    // on context already; setError/setNotice surface the result.
    token,
    setError,
    setNotice,
  } = useAppContext();

  const [partnerQuery, setPartnerQuery] = useState("");
  // v2.5.1: notes + in-flight flag for the manual-confirm path. Local
  // state because they only matter while the modal is open — no need
  // to persist across reopens (the saved notes appear in the status
  // panel afterwards via taskEditForm.customer_confirmation_notes).
  const [manualConfirmNotes, setManualConfirmNotes] = useState("");
  const [manualConfirmSubmitting, setManualConfirmSubmitting] = useState(false);
  // v2.5.5: separate in-flight flag for the email button so the
  // operator can't double-click + spam the customer's inbox.
  const [emailSubmitting, setEmailSubmitting] = useState(false);

  async function submitCustomerConfirmationEmail() {
    if (emailSubmitting) return;
    if (taskEditForm.id == null) return;
    setEmailSubmitting(true);
    try {
      const result = await apiFetch<{
        sent: boolean;
        sent_at: string | null;
        error_detail: string | null;
      }>(`/tasks/${taskEditForm.id}/customer-confirmation/email`, token, {
        method: "POST",
      });
      if (result.sent) {
        setTaskEditForm((current) => ({
          ...current,
          customer_confirmation_status: "pending",
          customer_confirmation_email_sent_at: result.sent_at,
          // Token may have rotated server-side; clear stale FE-only
          // timestamps so the panel reflects the fresh state.
          customer_confirmation_at: null,
          customer_confirmation_method: null,
          customer_confirmation_by_display_name: null,
        }));
        setNotice(
          language === "de"
            ? "Bestätigungs-E-Mail gesendet"
            : "Confirmation email sent",
        );
      } else {
        // Backend surfaced a clean reason — typically "no customer
        // email on record" or an SMTP issue. Show it verbatim so the
        // operator knows what to fix.
        setError(
          (language === "de"
            ? "E-Mail konnte nicht gesendet werden: "
            : "Email could not be sent: ") + (result.error_detail || "?"),
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEmailSubmitting(false);
    }
  }

  async function submitManualConfirmation(action: "confirm" | "decline") {
    if (manualConfirmSubmitting) return;
    if (taskEditForm.id == null) return;
    setManualConfirmSubmitting(true);
    try {
      const updated = await apiFetch<Task>(
        `/tasks/${taskEditForm.id}/customer-confirmation/manual`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            action,
            method: "phone",
            notes: manualConfirmNotes.trim() || null,
          }),
        },
      );
      // Mirror the new state back into the form so the status panel
      // shows the recorded confirmation without closing the modal.
      // The eventual save-button click still works because all the
      // other form fields are untouched.
      setTaskEditForm((current) => ({
        ...current,
        customer_confirmation_status: updated.customer_confirmation_status ?? null,
        customer_confirmation_at: updated.customer_confirmation_at ?? null,
        customer_confirmation_method: updated.customer_confirmation_method ?? null,
        customer_confirmation_by_display_name:
          updated.customer_confirmation_by_display_name ?? null,
        customer_confirmation_notes: updated.customer_confirmation_notes ?? null,
        customer_confirmation_email_sent_at:
          updated.customer_confirmation_email_sent_at ?? null,
        customer_confirmation_token_expired:
          updated.customer_confirmation_token_expired ?? false,
      }));
      setManualConfirmNotes("");
      setNotice(
        language === "de"
          ? action === "confirm"
            ? "Manuell als bestätigt markiert"
            : "Manuell als abgelehnt markiert"
          : action === "confirm"
            ? "Manually marked as confirmed"
            : "Manually marked as declined",
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setManualConfirmSubmitting(false);
    }
  }

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

          {/* v2.5.0 customer-confirmation section. Bound to a single
              checkbox that controls "is confirmation status non-null?".
              When checked + saved, the backend flips status to "pending"
              and (if customer email exists) auto-sends the email. When
              unchecked + saved, the backend clears the whole flow.
              The status panel renders read-only from the snapshot
              embedded in the form state. */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "KUNDENBESTÄTIGUNG" : "CUSTOMER CONFIRMATION"}
              </span>
              <span className="task-modal-section-hint">
                {de ? "Optional" : "Optional"}
              </span>
            </div>
            <label
              // v2.5.4: reuse the same CSS pattern as the storage-box
              // checkbox so the layout matches its siblings. The
              // v2.5.1 version used inline-flex which let the label
              // grow past the modal column; this class is width:100%
              // with bounded flex children so the text stays inside
              // the section regardless of label length.
              className="task-modal-storage-box-toggle"
            >
              <input
                type="checkbox"
                checked={taskEditForm.request_customer_confirmation}
                onChange={(event) =>
                  updateTaskEditField(
                    "request_customer_confirmation",
                    event.target.checked,
                  )
                }
              />
              <span>
                {de
                  ? "Kundenbestätigung anfordern"
                  : "Request customer confirmation"}
              </span>
            </label>
            {taskEditForm.customer_confirmation_status && (
              <div
                style={{
                  marginTop: 8,
                  padding: 10,
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: 6,
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                <div>
                  <b>{de ? "Status: " : "Status: "}</b>
                  {taskEditForm.customer_confirmation_status === "confirmed"
                    ? de ? "Bestätigt ✓" : "Confirmed ✓"
                    : taskEditForm.customer_confirmation_status === "declined"
                      ? de ? "Abgelehnt ✕" : "Declined ✕"
                      : de ? "Wartet auf Bestätigung…" : "Awaiting confirmation…"}
                </div>
                {taskEditForm.customer_confirmation_at && (
                  <div>
                    <b>{de ? "Erfasst am: " : "Recorded at: "}</b>
                    {formatServerDateTime(
                      taskEditForm.customer_confirmation_at,
                      de ? "de" : "en",
                    )}
                  </div>
                )}
                {taskEditForm.customer_confirmation_method && (
                  <div>
                    <b>{de ? "Methode: " : "Method: "}</b>
                    {taskEditForm.customer_confirmation_method === "email"
                      ? de ? "E-Mail-Link" : "email link"
                      : taskEditForm.customer_confirmation_method === "phone"
                        ? de ? "Telefon" : "phone"
                        : de ? "Manuell" : "manual"}
                  </div>
                )}
                {taskEditForm.customer_confirmation_by_display_name && (
                  <div>
                    <b>{de ? "Durch: " : "By: "}</b>
                    {taskEditForm.customer_confirmation_by_display_name}
                  </div>
                )}
                {taskEditForm.customer_confirmation_notes && (
                  <div style={{ marginTop: 4, fontStyle: "italic" }}>
                    "{taskEditForm.customer_confirmation_notes}"
                  </div>
                )}
                {taskEditForm.customer_confirmation_email_sent_at && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {de ? "E-Mail zuletzt gesendet: " : "Email last sent: "}
                    {formatServerDateTime(
                      taskEditForm.customer_confirmation_email_sent_at,
                      de ? "de" : "en",
                    )}
                  </div>
                )}
                {taskEditForm.customer_confirmation_token_expired &&
                  taskEditForm.customer_confirmation_status === "pending" && (
                    <div style={{ color: "#a16207", marginTop: 6, fontSize: 12 }}>
                      {de
                        ? "Link abgelaufen — bitte den Kunden anrufen oder die Aufgabe verschieben."
                        : "Link expired — please call the customer or move the task."}
                    </div>
                  )}
              </div>
            )}
            {taskEditForm.request_customer_confirmation &&
              !taskEditForm.customer_confirmation_status && (
                <small className="muted" style={{ display: "block", marginTop: 4 }}>
                  {de
                    ? "Beim Speichern wird der Status auf 'wartet' gesetzt. Die E-Mail an den Kunden geht erst per Klick auf 'Bestätigungs-E-Mail senden' raus — kein automatischer Versand."
                    : "On save: status flips to pending. The email goes out only when you click 'Send confirmation email' — no auto-send."}
                </small>
              )}
            {/*
              v2.5.1: manual confirm / decline controls. Only shown when
              the task is in a non-terminal confirmation state (pending
              or just-saved with the checkbox on) AND the row already
              exists (taskEditForm.id != null — manual confirm needs a
              persisted task). The operator types optional notes
              ("called Mr. Schmidt at 14:32 — agreed") and clicks one
              of two buttons; the api endpoint records timestamp +
              method=phone + by_user_id and burns the email token so a
              stale link can't undo the manual entry.
            */}
            {taskEditForm.id != null &&
              taskEditForm.request_customer_confirmation &&
              taskEditForm.customer_confirmation_status !== "confirmed" &&
              taskEditForm.customer_confirmation_status !== "declined" && (
                <div style={{ marginTop: 12 }}>
                  {/*
                    v2.5.5: explicit email-send button. The checkbox above
                    sets up the pending state on save; the actual email
                    only goes out when the operator clicks here. Label
                    flips to "erneut senden" / "Resend" once an email
                    has been recorded so the operator knows nudging is
                    safe.
                  */}
                  <button
                    type="button"
                    disabled={emailSubmitting || manualConfirmSubmitting}
                    onClick={() => void submitCustomerConfirmationEmail()}
                    style={{
                      width: "100%",
                      padding: "8px 14px",
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#fff",
                      background: "#2563eb",
                      border: "none",
                      borderRadius: 6,
                      cursor:
                        emailSubmitting || manualConfirmSubmitting
                          ? "wait"
                          : "pointer",
                      marginBottom: 8,
                    }}
                    title={
                      de
                        ? "Sendet die Bestätigungs-E-Mail an den hinterlegten Kunden."
                        : "Sends the confirmation email to the customer on file."
                    }
                  >
                    {emailSubmitting
                      ? de ? "Sende…" : "Sending…"
                      : taskEditForm.customer_confirmation_email_sent_at
                        ? de ? "E-Mail erneut senden" : "Resend email"
                        : de ? "Bestätigungs-E-Mail senden" : "Send confirmation email"}
                  </button>
                  <label
                    style={{
                      display: "block",
                      fontSize: 12,
                      color: "#475569",
                      marginBottom: 4,
                    }}
                  >
                    {de
                      ? "Notiz zur manuellen Bestätigung (optional)"
                      : "Note for manual confirmation (optional)"}
                  </label>
                  <input
                    type="text"
                    value={manualConfirmNotes}
                    onChange={(event) => setManualConfirmNotes(event.target.value)}
                    placeholder={
                      de
                        ? "z.B. Telefonat um 14:32, Herr Schmidt bestätigt"
                        : "e.g. Phone call at 14:32, Mr. Schmidt confirmed"
                    }
                    disabled={manualConfirmSubmitting}
                    style={{
                      width: "100%",
                      padding: "6px 8px",
                      fontSize: 13,
                      border: "1px solid #cbd5e1",
                      borderRadius: 4,
                    }}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <button
                      type="button"
                      disabled={manualConfirmSubmitting}
                      onClick={() => void submitManualConfirmation("confirm")}
                      style={{
                        flex: "1 1 auto",
                        padding: "8px 14px",
                        fontSize: 14,
                        fontWeight: 600,
                        color: "#fff",
                        background: "#16a34a",
                        border: "none",
                        borderRadius: 6,
                        cursor: manualConfirmSubmitting ? "wait" : "pointer",
                      }}
                    >
                      {manualConfirmSubmitting
                        ? de ? "Speichere…" : "Saving…"
                        : de ? "Manuell bestätigen" : "Manually confirm"}
                    </button>
                    <button
                      type="button"
                      disabled={manualConfirmSubmitting}
                      onClick={() => void submitManualConfirmation("decline")}
                      style={{
                        flex: "0 0 auto",
                        padding: "8px 14px",
                        fontSize: 14,
                        color: "#991b1b",
                        background: "#fff",
                        border: "1px solid #fca5a5",
                        borderRadius: 6,
                        cursor: manualConfirmSubmitting ? "wait" : "pointer",
                      }}
                    >
                      {de ? "Manuell ablehnen" : "Manually decline"}
                    </button>
                  </div>
                </div>
              )}
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
