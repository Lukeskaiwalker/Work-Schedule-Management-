/**
 * "Aufgabe kopieren" — prefill the create modal from an existing task.
 *
 * Client-side on purpose. The copy has to land in the create form anyway,
 * because the operator sets the new date and crew before anything persists; a
 * server-side copy would create an undated orphan that could be forgotten.
 * Every field the api accepts on create is already a form field, so the copy
 * is one pure function with no new permission surface and no activity-log or
 * notification side effects to invent.
 *
 * Two sources feed the same copy: the stored Task row, and the edit modal's
 * LIVE form. "Kopieren" sits next to "Speichern" and reads as "take this", so
 * an operator who rewrote the description and then copies expects the rewrite
 * in the copy — the form is what they see, the row is what was saved.
 *
 * What is NOT copied, and why:
 *   status                 a copy starts open, whatever the original reached
 *   due_date / end_date    the whole point of the copy is a new date
 *   planning_status        our planner has not settled the new date yet
 *   construction_box_id    a crate is bound to one job and its materials are
 *                          settled per task (_validate_task_construction_box)
 *   confirmation fields    the customer said yes to the ORIGINAL date
 *   storage_box_number     legacy mirror of the crate slot, see above
 *   attachments            rows of their own, bound to the original's id; the
 *                          copy is a form, not a task yet, so nothing could
 *                          carry them — the notice says so instead
 */
import type { Task, TaskEditFormState, TaskModalState, TaskType } from "../types";
import { normalizeTaskTypeValue, subtasksToTextareaValue, formatTaskStartTime } from "./tasks";

/** The slice of a task a copy carries, in the strings the create form holds. */
export type TaskCopyFields = {
  title: string;
  description: string;
  subtasks_raw: string;
  materials_required: string;
  task_type: TaskType;
  class_template_id: string;
  /** "" for a project-less (customer-anchored) task. */
  project_id: string;
  customer_id: number | null;
  assignee_ids: number[];
  partner_ids: number[];
  start_time: string;
  estimated_hours: string;
};

/** What a stored Task row contributes to its copy. */
export function taskCopyFields(task: Task): TaskCopyFields {
  const assigneeIds =
    task.assignee_ids && task.assignee_ids.length > 0
      ? [...task.assignee_ids]
      : task.assignee_id
        ? [task.assignee_id]
        : [];
  return {
    title: task.title,
    description: task.description ?? "",
    // Checklist items are plain strings, so a copied list is inherently
    // "unchecked" — nothing to reset.
    subtasks_raw: subtasksToTextareaValue(task.subtasks),
    materials_required: task.materials_required ?? "",
    task_type: normalizeTaskTypeValue(task.task_type),
    class_template_id: task.class_template_id != null ? String(task.class_template_id) : "",
    project_id: task.project_id != null ? String(task.project_id) : "",
    customer_id: task.customer_id ?? null,
    assignee_ids: assigneeIds,
    partner_ids: task.partner_ids ? [...task.partner_ids] : [],
    start_time: task.start_time ? formatTaskStartTime(task.start_time) : "",
    estimated_hours: task.estimated_hours != null ? String(task.estimated_hours) : "",
  };
}

/**
 * What the edit modal's live form contributes to a copy — unsaved edits
 * included. The form already holds every field as the create form wants it
 * (strings, HH:MM, the checklist as textarea lines), so nothing is reparsed.
 */
export function editFormCopyFields(form: TaskEditFormState): TaskCopyFields {
  return {
    title: form.title,
    description: form.description,
    subtasks_raw: form.subtasks_raw,
    materials_required: form.materials_required,
    task_type: form.task_type,
    class_template_id: form.class_template_id,
    project_id: form.project_id != null ? String(form.project_id) : "",
    customer_id: form.customer_id ?? null,
    assignee_ids: [...form.assignee_ids],
    partner_ids: [...form.partner_ids],
    start_time: form.start_time,
    estimated_hours: form.estimated_hours,
  };
}

function copyStateFromFields(fields: TaskCopyFields, base: TaskModalState): TaskModalState {
  const hasProject = fields.project_id.length > 0;
  return {
    ...base,
    ...fields,
    project_query: hasProject ? base.project_query : "",
    // A customer-anchored original keeps its anchor; a project task carries
    // none (the project resolves it, as the server does).
    customer_id: hasProject ? null : fields.customer_id,
    due_date: "",
    end_date: "",
    planning_status: "",
    has_storage_box: false,
    storage_box_number: "",
    construction_box_id: "",
    create_project_from_task: false,
    new_project_name: "",
    new_project_number: "",
  };
}

/** The copy of a stored task row. */
export function buildTaskModalCopyState(task: Task, base: TaskModalState): TaskModalState {
  return copyStateFromFields(taskCopyFields(task), base);
}

/** The copy of the edit modal as the operator currently sees it. */
export function buildTaskModalCopyStateFromEditForm(
  form: TaskEditFormState,
  base: TaskModalState,
): TaskModalState {
  return copyStateFromFields(editFormCopyFields(form), base);
}

/**
 * The notice shown once the copy is in the create modal. Names the files the
 * copy leaves behind when the original had any: this is the moment the
 * operator would expect them in the copy, and finding the plan missing on
 * site is the failure to prevent.
 */
export function taskCopyNotice(title: string, language: "de" | "en", attachmentCount = 0): string {
  const prepared =
    language === "de"
      ? `Kopie von „${title}“ vorbereitet – Datum und Zuweisung prüfen`
      : `Copy of “${title}” prepared – check date and assignment`;
  if (attachmentCount <= 0) return prepared;
  return language === "de"
    ? `${prepared}. Anhänge werden nicht mitkopiert.`
    : `${prepared}. Attachments are not copied.`;
}
