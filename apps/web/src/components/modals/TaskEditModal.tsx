import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { HHMM_PATTERN } from "../../constants";
import type { PlanningStatus, Task, TaskPriority } from "../../types";
import {
  taskTypeLabel,
  normalizeTaskTypeValue,
  formatTimeInputForTyping,
  formatTimeInputForBlur,
  addMinutesToHHMM,
  taskStatusLabel,
  planningStatusLabel,
  formatTaskDateRange,
} from "../../utils/tasks";
import { formatServerDateTime } from "../../utils/dates";
import { PartnerMultiSelect } from "../partners/PartnerMultiSelect";
import { ConstructionBoxPicker } from "../tasks/ConstructionBoxPicker";
import { TaskMaterialList } from "../tasks/TaskMaterialList";
import "../../styles/tasks.css";

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
    taskEditSelectableBoxes,
    taskEditBoxesLoading,
    taskEditCustomerId,
    taskEditAssigneeSuggestions,
    taskEditFormBase,
    setTaskEditFormBase,
    taskEditExpectedUpdatedAt,
    // v2.14.x: the two confirmation endpoints below commit server-side and
    // bump Task.updated_at, which invalidates the timestamp captured when
    // the modal opened. Without refreshing it here the operator's next Save
    // 409s on a change they made themselves.
    setTaskEditExpectedUpdatedAt,
    assignableUsers,
    projects,
    taskStatusOptions,
    canManageTasks,
    closeTaskEditModal,
    saveTaskEdit,
    deleteTaskFromEdit,
    copyTaskFromEdit,
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

  /**
   * Which task this modal is editing right now, readable from inside an async
   * continuation.
   *
   * TaskEditModal is mounted for the whole session — it renders null when
   * closed rather than unmounting — so a POST that is still in flight when the
   * operator closes this task and opens the next one keeps running, and every
   * setter after its `await` would write THIS task's answer onto whatever task
   * is now on screen: its updated_at, its confirmation snapshot, its diff
   * baseline. The handler's own props cannot detect that; they were frozen at
   * the render that started the request. A ref, written after every commit,
   * can.
   */
  const activeTaskRef = useRef<{ open: boolean; id: number | null }>({
    open: taskEditModalOpen,
    id: taskEditForm.id ?? null,
  });
  useEffect(() => {
    activeTaskRef.current = { open: taskEditModalOpen, id: taskEditForm.id ?? null };
  });

  /** True while the modal is still showing the task a request was fired for. */
  function stillEditing(taskId: number): boolean {
    return activeTaskRef.current.open && activeTaskRef.current.id === taskId;
  }

  /**
   * Both endpoints below persist a confirmation flow server-side. The
   * "Kundenbestätigung anfordern" checkbox that asked for one is, from that
   * moment, no longer a pending change — and leaving it looking like one is a
   * live data-loss path: saveTaskEdit diffs the form against the snapshot
   * taken when the modal opened, so an unsaved tick still reaches the api as
   * request_customer_confirmation:true, and the api answers that with
   * set_task_confirmation_pending(reset_status=True). The operator's Save
   * would then undo the confirmation they had just recorded by phone, or mint
   * a new token and kill the link they had just emailed.
   *
   * Recording a phone confirmation on a task with no flow yet REQUIRES ticking
   * that box first (it is what puts the buttons on screen), so this is the
   * ordinary path through this panel, not a corner case. Align the form and
   * the diff baseline with what the server now holds; the checkbox stays
   * ticked, and it is simply no longer a change.
   *
   * Takes the task id its caller fired the request for and checks it against
   * the ref above: writing a baseline for a task the operator has already left
   * would tell the NEXT task's save that its own untouched checkbox is not a
   * change, which is the same data loss one task over.
   */
  function markCustomerConfirmationFlowPersisted(taskId: number) {
    if (!stillEditing(taskId)) return;
    setTaskEditForm((current) => ({
      ...current,
      request_customer_confirmation: true,
    }));
    if (taskEditFormBase) {
      setTaskEditFormBase({
        ...taskEditFormBase,
        request_customer_confirmation: true,
      });
    }
  }

  async function submitCustomerConfirmationEmail() {
    if (emailSubmitting) return;
    const taskId = taskEditForm.id;
    if (taskId == null) return;
    // Read BEFORE the await for the same reason taskId is: it is the version
    // this modal believes in, and the failure branch below needs it to tell
    // "the server left the task alone" from "the reset stands".
    const expectedBeforeSend = taskEditExpectedUpdatedAt;
    setEmailSubmitting(true);
    try {
      const result = await apiFetch<{
        sent: boolean;
        sent_at: string | null;
        error_detail: string | null;
        // The task's version after the call. Optional only so an older api
        // build degrades to "drop the lock" instead of throwing; when it is
        // there, both branches below adopt it.
        updated_at?: string | null;
      }>(`/tasks/${taskId}/customer-confirmation/email`, token, {
        method: "POST",
      });
      const serverUpdatedAt = result.updated_at ?? null;
      if (result.sent) {
        if (stillEditing(taskId)) {
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
          // The send committed and bumped Task.updated_at, so the expectation
          // captured when the modal opened is stale and the next Save would
          // 409 against the operator's own click, losing every other edit in
          // this modal. Adopt the version the endpoint reports; falling back
          // to null leaves this one save unguarded, which is still better
          // than leaving it guaranteed to fail.
          setTaskEditExpectedUpdatedAt(serverUpdatedAt);
          // A save that re-sent request_customer_confirmation:true here would
          // mint a second token and leave the customer holding a dead link.
          markCustomerConfirmationFlowPersisted(taskId);
        }
        setNotice(
          language === "de"
            ? "Bestätigungs-E-Mail gesendet"
            : "Confirmation email sent",
        );
      } else {
        // A failed send is not a no-op. dispatch_customer_confirmation_email
        // resets the round BEFORE it talks to SMTP and commits either way, so
        // "sent: false" covers two opposite server states, and the reported
        // version is what tells them apart:
        //
        //   version unchanged — the server rolled the round back, or never
        //     touched it at all: no address on file, no SMTP host, or a
        //     failure the api proved never reached the wire (a rejected
        //     login, a refused MAIL FROM). Note a refused *connection* is
        //     NOT in that group — it surfaces as "network", which the api
        //     conservatively treats as possibly-delivered, so it lands in
        //     the "version moved" case below. The panel is still right;
        //     leave it alone. Blanking
        //     the verdict here would re-create by hand exactly the data loss
        //     the api goes out of its way to avoid — and "kein Kunden-E-Mail"
        //     is the failure this office actually hits, on tasks whose
        //     confirmation was taken by phone.
        //
        //   version moved — the reset stands: status is "pending" again, the
        //     verdict and the send timestamp are gone server-side, and the
        //     panel is showing an answer the database no longer holds.
        if (stillEditing(taskId)) {
          setTaskEditExpectedUpdatedAt(serverUpdatedAt);
          const roundWasReset =
            serverUpdatedAt !== null &&
            expectedBeforeSend !== null &&
            serverUpdatedAt !== expectedBeforeSend;
          if (roundWasReset) {
            setTaskEditForm((current) => ({
              ...current,
              customer_confirmation_status: "pending",
              customer_confirmation_at: null,
              customer_confirmation_method: null,
              customer_confirmation_by_display_name: null,
              // Per-round, and this round's link never made it out.
              customer_confirmation_email_sent_at: null,
              // customer_confirmation_notes is NOT cleared: the api keeps it
              // across a reset, and the panel labels it "vorherige Runde".
            }));
            markCustomerConfirmationFlowPersisted(taskId);
          }
        }
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
    // Captured before the await, and checked again after it: by the time this
    // POST answers, the operator may be looking at a different task.
    const taskId = taskEditForm.id;
    if (taskId == null) return;
    setManualConfirmSubmitting(true);
    try {
      const updated = await apiFetch<Task>(
        `/tasks/${taskId}/customer-confirmation/manual`,
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
      if (stillEditing(taskId)) {
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
        // Same stale-lock problem as the email path, with a better answer:
        // this endpoint returns the full TaskOut, so the modal can adopt the
        // new updated_at and the operator's pending edits still save cleanly.
        setTaskEditExpectedUpdatedAt(updated.updated_at ?? null);
        // A save that re-sent request_customer_confirmation:true here would
        // reset the round and throw away the verdict recorded one line above.
        markCustomerConfirmationFlowPersisted(taskId);
        setManualConfirmNotes("");
      }
      setNotice(
        language === "de"
          ? action === "confirm"
            ? "Zusage des Kunden erfasst"
            : "Absage des Kunden erfasst"
          : action === "confirm"
            ? "Customer agreement recorded"
            : "Customer decline recorded",
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

  // ── Kundenbestätigung: who may record one, and is there anybody to ask? ──
  // Three conditions, all load-bearing:
  //
  //   canManageTasks — the endpoint behind the confirm/decline buttons
  //   requires tasks:manage, exactly like the Planungsstand select above it,
  //   so an employee's click can only ever come back 403.
  //
  //   a customer — 535 of the 562 tasks in this database are construction or
  //   office work with no customer at all. A full-width green "Kunde hat
  //   zugesagt" under a plain Baustellenaufgabe invites one click that records
  //   an agreement nobody ever made. This is the actual customer signal, and
  //   it is the same one the box picker uses: the task's own customer, else
  //   its project's.
  //
  //   a flow — the ticked request, or a status from a round that already ran
  //   (including one reset to pending by a moved date, which is why the
  //   controls survive the request flag being unticked afterwards).
  //
  // The flow alone used to stand in for the customer, and the hint below then
  // told the operator to tick "Kundenbestätigung anfordern" to unlock the
  // buttons — advice that, on a customerless task, walks them straight into
  // recording a confirmation for a customer that does not exist.
  const taskHasCustomer = taskEditCustomerId != null;
  const customerConfirmationFlowExists =
    Boolean(taskEditForm.customer_confirmation_status) ||
    taskEditForm.request_customer_confirmation;
  const canRecordCustomerConfirmation =
    canManageTasks &&
    taskEditForm.id != null &&
    taskHasCustomer &&
    customerConfirmationFlowExists;
  const customerConfirmationAnswered =
    taskEditForm.customer_confirmation_status === "confirmed" ||
    taskEditForm.customer_confirmation_status === "declined";
  const customerConfirmationPending =
    taskEditForm.customer_confirmation_status === "pending";
  // Per-round truth, straight from the column: the api clears
  // customer_confirmation_email_sent_at whenever it mints a new token, so a
  // timestamp here always belongs to the round on screen. (It used to survive
  // the reset, which is why this was a session-lived Set of "task ids we
  // emailed" — a Set that never expired and so kept vouching for rounds that
  // had long since been replaced.)
  const emailSentThisRound = Boolean(taskEditForm.customer_confirmation_email_sent_at);

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
              <span className="task-modal-field-label">
                {de ? "Baustellenkiste" : "Construction box"}
              </span>
              <ConstructionBoxPicker
                language={language}
                boxes={taskEditSelectableBoxes}
                loading={taskEditBoxesLoading}
                customerResolved={taskEditCustomerId != null}
                value={taskEditForm.construction_box_id}
                onChange={(next) => updateTaskEditField("construction_box_id", next)}
              />
              {/* Tasks written before the picker existed carry a hand-typed
                  number with no box behind it. Show it so nothing silently
                  disappears, and let the user retire it once a real crate is
                  linked. */}
              {taskEditForm.storage_box_number && !taskEditForm.construction_box_id && (
                <div className="task-modal-box-legacy">
                  <span>
                    {de ? "Alte Lagerbox-Nr." : "Legacy box no."}:{" "}
                    {taskEditForm.storage_box_number}
                  </span>
                  <button
                    type="button"
                    className="linklike"
                    onClick={() =>
                      setTaskEditForm((current) => ({
                        ...current,
                        has_storage_box: false,
                        storage_box_number: "",
                      }))
                    }
                  >
                    {de ? "Entfernen" : "Clear"}
                  </button>
                </div>
              )}
            </label>
          </section>

          {/* Box materials: imported by the server from the linked box.
              Read-only here — what was used comes back via the report. */}
          {taskEditForm.id != null && taskEditForm.materials.length > 0 && (
            <section className="task-modal-section task-modal-section--stack">
              <TaskMaterialList
                taskId={taskEditForm.id}
                materials={taskEditForm.materials}
                language={language}
              />
            </section>
          )}

          {/* Von / Bis / Start time / Duration — the daily slot repeats on
              every day of a multi-day window. */}
          <section className="task-modal-section task-modal-section--grid4">
            <label className="task-modal-field">
              <span className="task-modal-field-label">{de ? "Von" : "From"}</span>
              <input
                className="task-modal-input"
                type="date"
                value={taskEditForm.due_date}
                onChange={(event) => {
                  const nextDueDate = event.target.value;
                  setTaskEditOverlapWarning(null);
                  // Clearing Von clears Bis: an end without a start is meaningless.
                  setTaskEditForm((current) => ({
                    ...current,
                    due_date: nextDueDate,
                    end_date: nextDueDate ? current.end_date : "",
                  }));
                }}
              />
            </label>
            <label className="task-modal-field task-modal-field--bis">
              <span className="task-modal-field-label">{de ? "Bis" : "To"}</span>
              <input
                className="task-modal-input"
                type="date"
                value={taskEditForm.end_date}
                min={taskEditForm.due_date || undefined}
                placeholder={taskEditForm.due_date}
                disabled={!taskEditForm.due_date}
                onChange={(event) => updateTaskEditField("end_date", event.target.value)}
              />
              <span className="task-modal-field-hint">{de ? "leer = eintägig" : "empty = single day"}</span>
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
          </section>

          {/* Priority — moved off the date row when Bis arrived. */}
          <section className="task-modal-section task-modal-section--grid2">
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
                {taskEditForm.materials.length > 0 && (
                  <span className="task-material-list-hint">
                    {de ? "zusätzlich zum Kisteninhalt" : "in addition to the box contents"}
                  </span>
                )}
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

          {/* Termin & Kundenbestätigung — the two date axes, in one block.
              They are still two independent columns (see
              utils/terminBadge.ts), but a planner answering "is this date
              settled?" needs both answers in front of them: until v2.14.x the
              Planungsstand select sat ~300 lines up the modal and the customer
              controls down here, and the planner had to hunt.

              Top half = ours. Bottom half = the customer's, bound to a single
              checkbox that controls "is confirmation status non-null?". When
              checked + saved, the backend flips status to "pending" and mints
              a token; when unchecked + saved it clears the whole flow.

              Every CONTROL in here is manager-only, both halves: the api
              answers 403 to an employee token that sends planning_status or
              request_customer_confirmation at all, and a 403 takes the whole
              PATCH — every other edit in the modal — down with it. What an
              employee gets is the read-only status panel, which renders from
              the snapshot embedded in the form state. */}
          <section className="task-modal-section task-modal-section--stack">
            <div className="task-modal-section-head">
              <span className="task-modal-section-label">
                {de ? "TERMIN & KUNDENBESTÄTIGUNG" : "APPOINTMENT & CUSTOMER CONFIRMATION"}
              </span>
              <span className="task-modal-section-hint">
                {de ? "Optional" : "Optional"}
              </span>
            </div>
            {canManageTasks && (
              <>
                <label className="task-modal-field">
                  <span className="task-modal-field-label">{de ? "Planungsstand" : "Planning status"}</span>
                  <select
                    className="task-modal-input task-modal-select"
                    value={taskEditForm.planning_status}
                    onChange={(event) =>
                      updateTaskEditField("planning_status", event.target.value as "" | PlanningStatus)
                    }
                  >
                    <option value="">—</option>
                    <option value="tentative">{planningStatusLabel("tentative", language)}</option>
                    <option value="confirmed">{planningStatusLabel("confirmed", language)}</option>
                  </select>
                  <span className="task-modal-field-hint">
                    {de
                      ? "Intern: ist der Termin für uns schon fix? Unabhängig davon, was der Kunde sagt."
                      : "Internal: is the date fixed for us? Independent of what the customer says."}
                  </span>
                </label>
                {/* Separates the two halves, so it belongs to the same
                    manager-only block they both live in. */}
                <hr className="task-modal-termin-split" />
              </>
            )}
            {/* Manager-only, like the Planungsstand select above it:
                request_customer_confirmation is not in the api's
                ALLOWED_EMPLOYEE_FIELDS (status / expected_updated_at /
                confirm_overlap), so an employee who ticks it does not get a
                rejected checkbox — the whole PATCH comes back 403 and every
                other edit in the modal dies with it. The read-only status
                panel below stays visible to everyone. */}
            {canManageTasks && (
              <>
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
                    // Enabled in every state, including after the customer has
                    // answered. It was disabled there for one round, to stop a
                    // tick from calling
                    // set_task_confirmation_pending(reset_status=True) and
                    // voiding the verdict — but that also removed the only way
                    // to clear a confirmation recorded on the wrong task, and
                    // an answered task whose flag is off cannot be tidied at
                    // all. The api now makes the dangerous half a no-op: a
                    // tick on an already-answered task changes nothing. The
                    // useful half is unchanged — unticking still clears the
                    // flow, note included, which is exactly what undoing a
                    // mistaken entry means.
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
                {customerConfirmationAnswered && (
                  <small className="muted" style={{ display: "block", marginTop: 4 }}>
                    {de
                      ? "Der Kunde hat bereits geantwortet. Erneutes Ankreuzen ändert daran nichts — eine neue Runde startet von selbst, sobald der Termin verschoben wird. Wurde die Rückmeldung versehentlich erfasst: Häkchen entfernen und speichern, das löscht die Kundenbestätigung samt Notiz."
                      : "The customer has already answered. Ticking this again changes nothing — a fresh round starts on its own when the date moves. If the reply was recorded by mistake, untick and save: that clears the customer confirmation and its note."}
                  </small>
                )}
              </>
            )}
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
                  {/* Same split the row pill makes (utils/terminBadge.ts):
                      "pending" with no email ever sent is not the customer
                      being slow, it is us not having asked. Saying "wartet
                      auf Rückmeldung" there would contradict the "Kunde
                      fragen" pill on the board and point the operator at the
                      wrong person. */}
                  {taskEditForm.customer_confirmation_status === "confirmed"
                    ? de ? "Kunde hat zugesagt ✓" : "Customer agreed ✓"
                    : taskEditForm.customer_confirmation_status === "declined"
                      ? de ? "Kunde hat abgesagt ✕" : "Customer declined ✕"
                      : emailSentThisRound
                        ? de ? "Wartet auf Rückmeldung des Kunden…" : "Awaiting the customer's reply…"
                        : de
                          ? "Noch nicht gefragt — es ging keine Bestätigungs-E-Mail raus"
                          : "Not asked yet — no confirmation email has gone out"}
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
                {/* The note survives a reset by design — it is the only
                    record of what was agreed, and destroying it on a routine
                    reschedule was the bug that put it here. It therefore
                    describes the round that just ENDED whenever the status is
                    back to pending, and saying so is this panel's job:
                    presenting "Telefonat 14:32, Hr. Schmidt bestätigt" as the
                    current state of a task nobody has asked about the new date
                    is how an operator stops making the call. A note can only
                    be written by a manual confirm/decline, which leaves the
                    status answered — so a note seen next to "pending" is
                    always from before. (The api's other half of that rule: a
                    later verdict recorded without a note clears the old one,
                    so a note never silently attaches itself to an answer it
                    was not about.) */}
                {taskEditForm.customer_confirmation_notes && (
                  <div style={{ marginTop: 4, fontStyle: "italic" }}>
                    {customerConfirmationPending && (
                      <span className="muted" style={{ fontStyle: "normal" }}>
                        {de ? "vorherige Runde: " : "previous round: "}
                      </span>
                    )}
                    "{taskEditForm.customer_confirmation_notes}"
                  </div>
                )}
                {/* No such qualifier on the send timestamp: unlike the note it
                    is per-round. A reset mints a new token, which kills the
                    link the old timestamp described, so the api clears the
                    timestamp with it — and the one exception, a send that
                    provably never left, is restored wholesale. Whatever stands
                    here is about the round on screen. */}
                {taskEditForm.customer_confirmation_email_sent_at && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    {de ? "E-Mail zuletzt gesendet: " : "Email last sent: "}
                    {formatServerDateTime(
                      taskEditForm.customer_confirmation_email_sent_at,
                      de ? "de" : "en",
                    )}
                  </div>
                )}
                {/* token_expired is a plain `today >= due_date` check on the
                    server, true for every overdue pending task — so it needs
                    the send timestamp beside it, or an overdue task nobody
                    ever emailed would be told its (non-existent) link died. */}
                {taskEditForm.customer_confirmation_token_expired &&
                  customerConfirmationPending &&
                  emailSentThisRound && (
                    <div style={{ color: "#a16207", marginTop: 6, fontSize: 12 }}>
                      {de
                        ? "Link abgelaufen — bitte den Kunden anrufen oder die Aufgabe verschieben."
                        : "Link expired — please call the customer or move the task."}
                    </div>
                  )}
              </div>
            )}
            {/* Describes what the checkbox above will do on save, so it is
                pointless to anyone who cannot see the checkbox. */}
            {canManageTasks &&
              taskEditForm.request_customer_confirmation &&
              !taskEditForm.customer_confirmation_status && (
                <small className="muted" style={{ display: "block", marginTop: 4 }}>
                  {de
                    ? "Beim Speichern wird der Status auf 'wartet' gesetzt. Die E-Mail an den Kunden geht erst per Klick auf 'Bestätigungs-E-Mail senden' raus — kein automatischer Versand."
                    : "On save: status flips to pending. The email goes out only when you click 'Send confirmation email' — no auto-send."}
                </small>
              )}
            {/*
              v2.5.5: explicit email-send button. The checkbox above sets up
              the pending state on save; the actual email only goes out when
              the operator clicks here. Label flips to "erneut senden" /
              "Resend" once an email has been recorded so the operator knows
              nudging is safe.

              Gated to a manager (the endpoint requires tasks:manage, so an
              employee's click is a guaranteed 403) on a persisted task that is
              asking for confirmation and has not answered yet: re-mailing a
              customer who already answered is the one thing this button should
              not make easy.
            */}
            {canManageTasks &&
              taskEditForm.id != null &&
              taskEditForm.request_customer_confirmation &&
              !customerConfirmationAnswered && (
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    disabled={emailSubmitting || manualConfirmSubmitting}
                    onClick={() => void submitCustomerConfirmationEmail()}
                    style={{
                      width: "100%",
                      minHeight: 40,
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
                      : emailSentThisRound
                        ? de ? "E-Mail erneut senden" : "Resend email"
                        : de ? "Bestätigungs-E-Mail senden" : "Send confirmation email"}
                  </button>
                </div>
              )}
            {/*
              Manual confirm / decline. Available in EVERY confirmation state —
              pending, confirmed AND declined — because the api writes the
              confirmation columns directly and no pending round is required.

              These used to vanish the moment the status became "confirmed" or
              "declined", which made the most ordinary event of the week — the
              customer rings up and cancels an appointment they had already
              confirmed — impossible to record except by unticking the checkbox
              above, and unticking it clears every confirmation column
              including the phone note that proves what was agreed. That part
              stays.

              What they are gated on is WHO is looking and WHETHER there is a
              customer to record an answer FROM (canRecordCustomerConfirmation):
              manage rights because the endpoint answers 403 without them, a
              resolved customer because 535 of the 562 tasks here have nobody
              to ask, and a started flow because that is what says somebody
              means to ask them.

              They deliberately do NOT depend on the customer having an e-mail
              address on file: the customers you phone are precisely the ones
              without one — all three confirmations in production came in by
              phone. Only the "E-Mail senden" button above cares.

              The operator types an optional note ("Telefonat um 14:32, Herr
              Schmidt bestätigt") and clicks one of the two buttons; the api
              records timestamp + method=phone + by_user_id and burns the email
              token so a stale link can't undo the manual entry.
            */}
            {/* Why the buttons are not there. Two different reasons, and only
                one of them has a next step: telling the operator of a
                customerless Baustellenaufgabe to tick the box above would walk
                them into recording an agreement for a customer that does not
                exist. Order matters — no customer is the more fundamental
                fact, so it wins when both are true. */}
            {canManageTasks &&
              taskEditForm.id != null &&
              !canRecordCustomerConfirmation && (
                <small className="muted" style={{ display: "block", marginTop: 8 }}>
                  {!taskHasCustomer
                    ? de
                      ? "Diese Aufgabe hat keinen Kunden — eine Zu- oder Absage kann nicht erfasst werden."
                      : "This task has no customer — an agreement or a decline cannot be recorded."
                    : de
                      ? "Für diese Aufgabe läuft keine Kundenbestätigung. Zum Erfassen einer Zu- oder Absage zuerst oben 'Kundenbestätigung anfordern' ankreuzen."
                      : "No customer confirmation is running for this task. To record an agreement or a decline, tick 'Request customer confirmation' above first."}
                </small>
              )}
            {canRecordCustomerConfirmation && (
              <div style={{ marginTop: 12 }}>
                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    color: "#475569",
                    marginBottom: 4,
                  }}
                >
                  {de
                    ? "Notiz zur Rückmeldung des Kunden (optional)"
                    : "Note on the customer's reply (optional)"}
                </label>
                <input
                  className="task-modal-input"
                  type="text"
                  value={manualConfirmNotes}
                  onChange={(event) => setManualConfirmNotes(event.target.value)}
                  placeholder={
                    de
                      ? "z.B. Telefonat um 14:32, Herr Schmidt bestätigt"
                      : "e.g. Phone call at 14:32, Mr. Schmidt confirmed"
                  }
                  disabled={manualConfirmSubmitting}
                />
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  <button
                    type="button"
                    disabled={manualConfirmSubmitting}
                    onClick={() => void submitManualConfirmation("confirm")}
                    style={{
                      flex: "1 1 auto",
                      minHeight: 40,
                      padding: "8px 14px",
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#fff",
                      background: "#16a34a",
                      border: "none",
                      borderRadius: 6,
                      cursor: manualConfirmSubmitting ? "wait" : "pointer",
                    }}
                    title={
                      de
                        ? "Erfasst eine Zusage des Kunden (Telefon / persönlich). Ändert den Planungsstand nicht."
                        : "Records the customer agreeing (phone / in person). Does not change the planning status."
                    }
                  >
                    {manualConfirmSubmitting
                      ? de ? "Speichere…" : "Saving…"
                      : de ? "Kunde hat zugesagt" : "Customer agreed"}
                  </button>
                  <button
                    type="button"
                    disabled={manualConfirmSubmitting}
                    onClick={() => void submitManualConfirmation("decline")}
                    style={{
                      flex: "1 1 auto",
                      minHeight: 40,
                      padding: "8px 14px",
                      fontSize: 14,
                      fontWeight: 600,
                      color: "#991b1b",
                      background: "#fff",
                      border: "1px solid #fca5a5",
                      borderRadius: 6,
                      cursor: manualConfirmSubmitting ? "wait" : "pointer",
                    }}
                    title={
                      de
                        ? "Erfasst eine Absage des Kunden (Telefon / persönlich). Ändert den Planungsstand nicht."
                        : "Records the customer declining (phone / in person). Does not change the planning status."
                    }
                  >
                    {de ? "Kunde hat abgesagt" : "Customer declined"}
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
                          overlap.end_date ? formatTaskDateRange(overlap) : "",
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
            {canManageTasks && (
              <button
                type="button"
                className="task-modal-btn task-modal-btn--ghost"
                onClick={copyTaskFromEdit}
                title={de ? "Als neue Aufgabe kopieren (ohne Datum und Kiste)" : "Copy as a new task (without date and box)"}
              >
                {de ? "Kopieren" : "Copy"}
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
