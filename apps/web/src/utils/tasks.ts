import { HHMM_REGEX } from "../constants";
import type {
  Language,
  PlanningStatus,
  Project,
  Task,
  TaskModalState,
  TaskType,
  ReportTaskChecklistItem,
} from "../types";
import { formatProjectTitle, projectLocationAddress } from "./projects";

// ── The customer anchor ───────────────────────────────────────────────────
//
// A task belongs to a project, a customer, or both. Every list used to label
// only the project and fall silent on a customer-only task — the office could
// not tell whose task it was without opening the customer. The api now sends
// the customer's name and address on the row (TaskOut.customer_name /
// customer_address, filled once per list); these helpers read them.

/** The customer columns a TaskOut carries; read here until `Task` lists them. */
export type TaskCustomerFields = {
  customer_name?: string | null;
  customer_address?: string | null;
};

/** What the anchor helpers need: the two ids and, when present, the name. */
export type TaskAnchorRef = Pick<Task, "project_id" | "customer_id"> & TaskCustomerFields;

/** Anchored to a customer and nothing else. A task with a project too is a
 *  project task for labelling — the project title already names its customer. */
export function isCustomerOnlyTask(task: TaskAnchorRef): boolean {
  return task.project_id == null && task.customer_id != null;
}

/** The customer's name as the api sent it on the row; "" when it did not. */
export function taskCustomerName(task: TaskAnchorRef): string {
  return String(task.customer_name ?? "").trim();
}

export function taskCustomerAddress(task: TaskAnchorRef): string {
  return String(task.customer_address ?? "").trim();
}

/** The last resort when neither the row nor the loaded customers name it. */
export function customerTaskFallbackLabel(task: TaskAnchorRef, language: Language): string {
  if (task.customer_id == null) return "";
  return `${language === "de" ? "Kunde" : "Customer"} #${task.customer_id}`;
}

/**
 * The anchor half of the create POST: exactly one of project / customer.
 *
 * The project wins when both are in the form (picking one clears the other,
 * but a stale copy could carry both), and ``customer_id`` is omitted rather
 * than nulled for a project task — the api accepts either anchor
 * (schemas/task.py:_require_anchor) and treats an absent key as "none".
 */
export function buildTaskAnchorPayload(
  form: Pick<TaskModalState, "customer_id">,
  projectId: number,
): { project_id: number | null; customer_id?: number } {
  if (projectId) return { project_id: projectId };
  if (form.customer_id != null) return { project_id: null, customer_id: form.customer_id };
  return { project_id: null };
}

export type TaskCalendarCustomer = { name: string; address: string };

export type TaskCalendarAnchor = {
  /** "2026-0412 - Zählerwechsel" / "Müller GmbH - Rückruf" / the bare title. */
  summaryBase: string;
  /** The Project:/Customer:/Address: lines of the event description. */
  anchorLines: string[];
  /** The VEVENT LOCATION: the site, else the customer's address. */
  location: string;
  /** Stem of the .ics file name. */
  fileNameSource: string;
};

/**
 * What the calendar event says about where a task belongs. A project task
 * names the project and its customer; a customer-only task names the
 * customer and puts the customer's address on the event, so the entry in the
 * fitter's phone can navigate there exactly as a project entry can.
 */
export function taskCalendarAnchor(
  task: Pick<Task, "id" | "title" | "project_id" | "customer_id">,
  project: Project | null | undefined,
  customer: TaskCalendarCustomer | null,
): TaskCalendarAnchor {
  if (project) {
    return {
      summaryBase: `${project.project_number} - ${task.title}`,
      anchorLines: [
        `Project: ${formatProjectTitle(project.project_number, project.customer_name, project.name, project.id)}`,
        project.customer_name ? `Customer: ${project.customer_name}` : "",
      ].filter((line) => line.length > 0),
      location: projectLocationAddress(project),
      fileNameSource: `${project.project_number}-${task.id}`,
    };
  }
  if (task.project_id == null && customer && customer.name) {
    return {
      summaryBase: `${customer.name} - ${task.title}`,
      anchorLines: [`Customer: ${customer.name}`, customer.address ? `Address: ${customer.address}` : ""].filter(
        (line) => line.length > 0,
      ),
      location: customer.address,
      fileNameSource: `kunde-${task.customer_id ?? 0}-${task.id}`,
    };
  }
  // A project task whose project is not loaded here: the id is all we have.
  return {
    summaryBase: task.title,
    anchorLines: task.project_id != null ? [`Project ID: ${task.project_id}`] : [],
    location: "",
    fileNameSource: `task-${task.id}`,
  };
}

/**
 * Canonical task statuses in display order. Every label, done-check and
 * dropdown goes through canonicalTaskStatus() first, so a legacy row that
 * stored "Offen" or "completed" cannot produce a second "Offen"/"Erledigt"
 * entry next to the canonical one.
 */
export const TASK_STATUS_ORDER: readonly string[] = ["open", "in_progress", "on_hold", "done"];

/** Legacy spellings the backend maps too — kept in sync with apps/api. */
const TASK_STATUS_ALIASES: Readonly<Record<string, string>> = {
  offen: "open",
  todo: "open",
  to_do: "open",
  new: "open",
  in_arbeit: "in_progress",
  in_bearbeitung: "in_progress",
  inprogress: "in_progress",
  pausiert: "on_hold",
  onhold: "on_hold",
  paused: "on_hold",
  erledigt: "done",
  fertig: "done",
  abgeschlossen: "done",
  completed: "done",
  complete: "done",
  finished: "done",
  closed: "done",
};

/**
 * Strip, lower-case, collapse spaces/hyphens to "_" and resolve the known
 * aliases. "overdue" and the canonical values pass through unchanged; an
 * unknown value comes back cleaned (so it still dedupes case-insensitively).
 */
export function canonicalTaskStatus(value: string | null | undefined): string {
  const cleaned = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (!cleaned) return "";
  return TASK_STATUS_ALIASES[cleaned] ?? cleaned;
}

/**
 * Deduplicated canonical option keys in a fixed order: open, in_progress,
 * on_hold, done, then "overdue" when requested, then any unknown leftovers
 * alphabetically. Blank inputs are dropped.
 */
export function buildTaskStatusOptions(
  values: Iterable<string | null | undefined>,
  options: { includeOverdue?: boolean } = {},
): string[] {
  const canonical = new Set<string>();
  for (const value of values) {
    const key = canonicalTaskStatus(value);
    if (key) canonical.add(key);
  }
  const ordered = TASK_STATUS_ORDER.filter((key) => canonical.has(key));
  const withOverdue = options.includeOverdue ? [...ordered, "overdue"] : ordered;
  const known = new Set<string>([...TASK_STATUS_ORDER, "overdue"]);
  const leftovers = [...canonical].filter((key) => !known.has(key)).sort((a, b) => a.localeCompare(b));
  return [...withOverdue, ...leftovers];
}

export function parseListLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseTaskSubtasks(rawValue: string) {
  const seen = new Set<string>();
  const rows: string[] = [];
  parseListLines(rawValue).forEach((line) => {
    const key = line.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(line);
  });
  return rows;
}

export function subtasksToTextareaValue(subtasks?: string[] | null) {
  return (subtasks ?? []).map((value) => String(value || "").trim()).filter((value) => value.length > 0).join("\n");
}

export function sameStringList(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function buildReportTaskChecklist(subtasks: string[]): ReportTaskChecklistItem[] {
  return subtasks.map((label, index) => ({
    id: `subtask-${index}-${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    label,
    done: false,
  }));
}

export function taskStartTimeMinutes(task: Task): number | null {
  const hhmm = formatTaskStartTime(task.start_time);
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return null;
  const [hoursText, minutesText] = hhmm.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

export function taskEstimatedMinutes(task: Task): number | null {
  if (task.estimated_hours == null) return null;
  const minutes = Math.round(Number(task.estimated_hours) * 60);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes;
}

export function taskEndTimeMinutes(task: Task): number | null {
  const explicitEnd = formatTaskStartTime(task.end_time);
  if (/^\d{2}:\d{2}$/.test(explicitEnd)) {
    const [hoursText, minutesText] = explicitEnd.split(":");
    const hours = Number(hoursText);
    const minutes = Number(minutesText);
    if (Number.isFinite(hours) && Number.isFinite(minutes)) return hours * 60 + minutes;
  }
  const startMinutes = taskStartTimeMinutes(task);
  const durationMinutes = taskEstimatedMinutes(task);
  if (startMinutes == null || durationMinutes == null) return null;
  return startMinutes + durationMinutes;
}

export function sortTasksByDueTime(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const leftDate = String(left.due_date ?? "");
    const rightDate = String(right.due_date ?? "");
    if (leftDate && rightDate && leftDate !== rightDate) return leftDate.localeCompare(rightDate);
    if (leftDate && !rightDate) return -1;
    if (!leftDate && rightDate) return 1;

    const leftStartMinutes = taskStartTimeMinutes(left);
    const rightStartMinutes = taskStartTimeMinutes(right);
    if (leftStartMinutes != null && rightStartMinutes != null && leftStartMinutes !== rightStartMinutes) {
      return leftStartMinutes - rightStartMinutes;
    }
    if (leftStartMinutes != null && rightStartMinutes == null) return -1;
    if (leftStartMinutes == null && rightStartMinutes != null) return 1;

    const titleCompare = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (titleCompare !== 0) return titleCompare;
    return left.id - right.id;
  });
}

export function isValidTimeHHMM(value: string) {
  return HHMM_REGEX.test(value.trim());
}

export function formatTimeInputForTyping(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const compact = raw.replace(/[^\d:]/g, "");
  const colonIndex = compact.indexOf(":");
  if (colonIndex >= 0) {
    const hours = compact.slice(0, colonIndex).replace(/\D/g, "").slice(0, 2);
    const minutes = compact.slice(colonIndex + 1).replace(/\D/g, "").slice(0, 2);
    if (!hours) return "";
    if (minutes.length === 0) return `${hours}:`;
    return `${hours}:${minutes}`;
  }
  const digits = compact.replace(/\D/g, "").slice(0, 4);
  if (raw.endsWith(":") && digits.length <= 2) return `${digits}:`;
  if (digits.length <= 2) return digits;
  if (digits.length === 3) {
    const leadingPair = Number(digits.slice(0, 2));
    if (Number.isFinite(leadingPair) && leadingPair <= 23) {
      return `${digits.slice(0, 2)}:${digits.slice(2)}`;
    }
    return `${digits.slice(0, 1)}:${digits.slice(1)}`;
  }
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

export function normalizeTimeHHMM(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const compact = raw.replace(/\D/g, "");
  if (compact.length === 3) {
    return `0${compact[0]}:${compact.slice(1)}`;
  }
  if (compact.length >= 4) {
    return `${compact.slice(0, 2)}:${compact.slice(2, 4)}`;
  }
  const match = raw.match(/^(\d{1,2}):(\d{1,2})$/);
  if (match) {
    return `${match[1].padStart(2, "0").slice(0, 2)}:${match[2].padStart(2, "0").slice(0, 2)}`;
  }
  return raw.slice(0, 5);
}

export function formatTimeInputForBlur(value?: string | null) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = normalizeTimeHHMM(raw);
  if (normalized && isValidTimeHHMM(normalized)) return normalized;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 1) {
    const candidate = `0${digits}:00`;
    if (isValidTimeHHMM(candidate)) return candidate;
  }
  if (digits.length === 2) {
    const asHour = Number(digits);
    if (Number.isFinite(asHour) && asHour >= 0 && asHour <= 23) return `${digits}:00`;
  }
  return raw.slice(0, 5);
}

export function taskDisplayStatus(task: Task, referenceIsoDate: string) {
  return isTaskOverdue(task, referenceIsoDate) ? "overdue" : canonicalTaskStatus(task.status);
}

export function isTaskDoneStatus(value: string | null | undefined) {
  return canonicalTaskStatus(value) === "done";
}

export function isTaskOverdue(task: Task, referenceIsoDate: string) {
  if (task.is_overdue === true) return true;
  const status = canonicalTaskStatus(task.status);
  if (status === "overdue") return true;
  if (isTaskDoneStatus(status)) return false;
  // Same rule as the api's _task_is_overdue: the LAST day decides, so day two
  // of a three-day job is not red.
  const lastDay = taskEndDate(task);
  if (!lastDay) return false;
  return lastDay < referenceIsoDate;
}

/** The last day of the task's window: end_date, else due_date, else "". */
export function taskEndDate(task: Pick<Task, "due_date" | "end_date">): string {
  const dueDate = String(task.due_date || "").trim();
  if (!dueDate) return "";
  const endDate = String(task.end_date || "").trim();
  return endDate && endDate > dueDate ? endDate : dueDate;
}

/** True when the ISO day lies inside [due_date, end_date]. Undated → false. */
export function taskSpansDay(task: Pick<Task, "due_date" | "end_date">, isoDay: string): boolean {
  const dueDate = String(task.due_date || "").trim();
  if (!dueDate || !isoDay) return false;
  return dueDate <= isoDay && isoDay <= taskEndDate(task);
}

function isoDayNumber(isoDate: string): number {
  // Whole days since the epoch, computed in UTC so DST never yields 0.96 days.
  return Math.round(Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  ) / 86_400_000);
}

/** Number of calendar days the task covers; 1 for a single day, 0 when undated. */
export function taskDayCount(task: Pick<Task, "due_date" | "end_date">): number {
  const dueDate = String(task.due_date || "").trim();
  if (!dueDate) return 0;
  const lastDay = taskEndDate(task);
  return Math.max(1, isoDayNumber(lastDay) - isoDayNumber(dueDate) + 1);
}

/**
 * "Tag 2/3" for the given day of a multi-day task; "" for a single-day task
 * or a day outside the window, so callers can render it unconditionally.
 */
export function taskDayIndexLabel(
  task: Pick<Task, "due_date" | "end_date">,
  isoDay: string,
  language: Language,
): string {
  const total = taskDayCount(task);
  if (total <= 1 || !taskSpansDay(task, isoDay)) return "";
  const index = isoDayNumber(isoDay) - isoDayNumber(String(task.due_date)) + 1;
  return `${language === "de" ? "Tag" : "Day"} ${index}/${total}`;
}

/**
 * The task's date(s) for a row: "2026-10-01" for a single day and
 * "2026-10-01 – 2026-10-03" for a window — ISO in both languages, on purpose.
 * Every list prints single days in ISO, so a dotted window would put two date
 * systems into one column, a one-day row directly above a three-day one.
 * "" when undated.
 */
export function formatTaskDateRange(task: Pick<Task, "due_date" | "end_date">): string {
  const dueDate = String(task.due_date || "").trim();
  if (!dueDate) return "";
  const lastDay = taskEndDate(task);
  return lastDay === dueDate ? dueDate : `${dueDate} – ${lastDay}`;
}

export function taskStatusLabel(value: string, language: Language) {
  const status = canonicalTaskStatus(value);
  if (status === "open") return language === "de" ? "Offen" : "Open";
  if (status === "in_progress") return language === "de" ? "In Arbeit" : "In progress";
  if (status === "overdue") return language === "de" ? "Überfällig" : "Overdue";
  if (status === "done") return language === "de" ? "Erledigt" : "Done";
  if (status === "on_hold") return language === "de" ? "Pausiert" : "On hold";
  return String(value || "").trim() || "-";
}

/**
 * Label for the internal planning certainty. Deliberately lower-case
 * ("in Planung" / "bestätigt") — it is a small pill next to the title, not
 * a heading. "" for null so callers can render it unconditionally.
 */
export function planningStatusLabel(value: PlanningStatus | null | undefined, language: Language) {
  if (value === "tentative") return language === "de" ? "in Planung" : "tentative";
  if (value === "confirmed") return language === "de" ? "bestätigt" : "confirmed";
  return "";
}

export function taskTypeLabel(taskType: TaskType, language: Language) {
  if (taskType === "customer_appointment") {
    return language === "de" ? "Kundentermin" : "Customer appointment";
  }
  if (taskType === "office") {
    return language === "de" ? "Büroaufgabe" : "Office task";
  }
  return language === "de" ? "Baustellenaufgabe" : "Construction task";
}

export function normalizeTaskTypeValue(value?: string | null): TaskType {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "customer_appointment" ||
    normalized === "customer-appointment" ||
    normalized === "customer appointment" ||
    normalized === "appointment" ||
    normalized === "kundentermin" ||
    normalized === "kundentermine" ||
    normalized === "termin"
  ) {
    return "customer_appointment";
  }
  if (normalized === "office" || normalized === "buero" || normalized === "büro") return "office";
  return "construction";
}

export function taskNotificationDigest(rows: Task[]) {
  const chunks = rows
    .map((task) => {
      const assigneeIds = [...(task.assignee_ids ?? [])].sort((a, b) => a - b).join(",");
      return [
        task.id,
        task.project_id,
        task.status || "",
        task.planning_status || "",
        task.due_date || "",
        task.end_date || "",
        task.start_time || "",
        task.end_time || "",
        task.estimated_hours ?? "",
        task.week_start || "",
        assigneeIds,
      ].join(":");
    })
    .sort();
  return chunks.join("|");
}

export function formatTaskStartTime(value?: string | null) {
  if (!value) return "";
  const text = String(value);
  if (text.length >= 5) return text.slice(0, 5);
  return text;
}

export function formatTaskTimeRange(task: Task) {
  const start = formatTaskStartTime(task.start_time);
  const end = formatTaskStartTime(task.end_time);
  if (start && end) return `${start}-${end}`;
  return start;
}

export function addMinutesToHHMM(value?: string | null, minutesToAdd = 0) {
  const hhmm = formatTaskStartTime(value);
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return "";
  const [hoursText, minutesText] = hhmm.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return "";
  const totalMinutes = (hours * 60) + minutes + minutesToAdd;
  if (totalMinutes < 0 || totalMinutes >= 24 * 60) return "";
  const nextHours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const nextMinutes = String(totalMinutes % 60).padStart(2, "0");
  return `${nextHours}:${nextMinutes}`;
}
