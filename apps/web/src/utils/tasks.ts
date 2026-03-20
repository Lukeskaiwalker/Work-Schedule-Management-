import { HHMM_REGEX } from "../constants";
import type { Language, Task, TaskType, ReportTaskChecklistItem } from "../types";

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
  return isTaskOverdue(task, referenceIsoDate) ? "overdue" : String(task.status || "").trim();
}

export function isTaskDoneStatus(value: string | null | undefined) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return normalized === "done" || normalized === "completed";
}

export function isTaskOverdue(task: Task, referenceIsoDate: string) {
  if (task.is_overdue === true) return true;
  const rawStatus = String(task.status || "")
    .trim()
    .toLowerCase();
  if (rawStatus === "overdue") return true;
  if (isTaskDoneStatus(rawStatus)) return false;
  const dueDate = String(task.due_date || "").trim();
  if (!dueDate) return false;
  return dueDate < referenceIsoDate;
}

export function taskStatusLabel(value: string, language: Language) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "open") return language === "de" ? "Offen" : "Open";
  if (normalized === "in_progress") return language === "de" ? "In Arbeit" : "In progress";
  if (normalized === "overdue") return language === "de" ? "Überfällig" : "Overdue";
  if (normalized === "done" || normalized === "completed") return language === "de" ? "Erledigt" : "Done";
  if (normalized === "on_hold") return language === "de" ? "Pausiert" : "On hold";
  return String(value || "").trim() || "-";
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
        task.due_date || "",
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
