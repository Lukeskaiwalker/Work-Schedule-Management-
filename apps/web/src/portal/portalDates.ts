// Calendar words for the partner portal: which day-group a job falls into,
// what its time lane shows, and how dates, times and durations are written.
//
// All dates are the API's ISO day strings ("2026-10-09"), read as LOCAL days
// — never through `new Date("2026-10-09")`, which is UTC midnight and lands
// on the previous day west of Greenwich.

import type { PortalTask } from "./portalTypes";

const WEEKDAYS_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const WEEKDAYS_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTHS = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

export type TaskGroupKey = "overdue" | "today" | "week" | "later" | "undated";

export type TaskGroup = {
  key: TaskGroupKey;
  label: string;
  hint: string;
  tasks: PortalTask[];
};

function parseDay(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function isoDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function localTodayIso(now: Date = new Date()): string {
  return isoDay(now);
}

/** The day `days` away from `iso`, in local time ("yesterday" is shiftDayIso(today, -1)). */
export function shiftDayIso(iso: string, days: number): string {
  const day = parseDay(iso);
  return isoDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + days));
}

/** Sunday of the week (Monday–Sunday) that contains the given day. */
function endOfWeek(todayIso: string): string {
  const day = parseDay(todayIso);
  const weekday = day.getDay(); // 0 = Sunday
  const daysToSunday = weekday === 0 ? 0 : 7 - weekday;
  return isoDay(new Date(day.getFullYear(), day.getMonth(), day.getDate() + daysToSunday));
}

export function formatLongDate(iso: string): string {
  const day = parseDay(iso);
  return `${WEEKDAYS_LONG[day.getDay()]}, ${day.getDate()}. ${MONTHS[day.getMonth()]}`;
}

/** "2026-10-09…" → "9.10.2026" — a calendar day, no weekday. */
export function formatDayDate(iso: string): string {
  const day = parseDay(iso);
  return `${day.getDate()}.${day.getMonth() + 1}.${day.getFullYear()}`;
}

export function formatShortDate(iso: string): string {
  const day = parseDay(iso);
  return `${WEEKDAYS_SHORT[day.getDay()]} ${day.getDate()}.${day.getMonth() + 1}.`;
}

function weekdayShort(iso: string): string {
  return WEEKDAYS_SHORT[parseDay(iso).getDay()];
}

function dayMonth(iso: string): string {
  const day = parseDay(iso);
  return `${day.getDate()}.${day.getMonth() + 1}.`;
}

export function formatClock(value: string | null | undefined): string {
  if (!value) return "";
  const [h = "", m = ""] = value.split(":");
  return h && m ? `${h.padStart(2, "0")}:${m.padStart(2, "0")}` : "";
}

export function formatDuration(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return "";
  if (hours < 1) return `${Math.round(hours * 60)} Min.`;
  const rounded = Math.round(hours * 10) / 10;
  return `${String(rounded).replace(".", ",")} Std.`;
}

export function formatTimeRange(start: string | null | undefined, hours: number | null | undefined): string {
  const from = formatClock(start);
  if (!from) return "";
  if (hours == null || !Number.isFinite(hours) || hours <= 0) return `ab ${from}`;
  const [h, m] = from.split(":").map(Number);
  const endMinutes = h * 60 + m + Math.round(hours * 60);
  const endH = Math.floor(endMinutes / 60) % 24;
  const endM = endMinutes % 60;
  return `${from} – ${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

function coversDay(task: PortalTask, dayIso: string): boolean {
  if (!task.due_date) return false;
  const last = task.end_date || task.due_date;
  return task.due_date <= dayIso && dayIso <= last;
}

export function groupOpenTasks(tasks: PortalTask[], todayIso: string): TaskGroup[] {
  const weekEnd = endOfWeek(todayIso);
  const buckets: Record<TaskGroupKey, PortalTask[]> = { overdue: [], today: [], week: [], later: [], undated: [] };
  for (const task of tasks) {
    if (task.is_overdue) buckets.overdue.push(task);
    else if (!task.due_date) buckets.undated.push(task);
    else if (coversDay(task, todayIso) || task.due_date < todayIso) buckets.today.push(task);
    else if (task.due_date <= weekEnd) buckets.week.push(task);
    else buckets.later.push(task);
  }
  const meta: Array<[TaskGroupKey, string, string]> = [
    ["overdue", "Überfällig", "bitte erledigen oder im Büro melden"],
    ["today", "Heute", formatLongDate(todayIso)],
    ["week", "Diese Woche", `bis ${formatLongDate(weekEnd)}`],
    ["later", "Später", ""],
    ["undated", "Ohne Termin", ""],
  ];
  return meta
    .filter(([key]) => buckets[key].length > 0)
    .map(([key, label, hint]) => ({ key, label, hint, tasks: buckets[key] }));
}

export type TimeLane = { primary: string; secondary: string };

export function timeLane(task: PortalTask, todayIso: string): TimeLane {
  if (!task.due_date) return { primary: "—", secondary: "" };
  if (coversDay(task, todayIso)) {
    return { primary: formatClock(task.start_time) || "Heute", secondary: formatDuration(task.estimated_hours) };
  }
  return { primary: weekdayShort(task.due_date), secondary: dayMonth(task.due_date) };
}

export type WhenLines = { title: string; detail: string };

export function whenLines(task: PortalTask): WhenLines {
  if (!task.due_date) {
    return { title: "Noch kein Termin", detail: "Das Büro meldet sich mit einem Termin." };
  }
  const multiDay = Boolean(task.end_date && task.end_date !== task.due_date);
  const title = multiDay
    ? `${formatShortDate(task.due_date)} – ${formatShortDate(task.end_date as string)}`
    : formatLongDate(task.due_date);
  const range = formatTimeRange(task.start_time, task.estimated_hours);
  const duration = formatDuration(task.estimated_hours);
  const parts = [range ? `${multiDay ? "täglich " : ""}${range}` : "", duration ? `ca. ${duration}` : ""].filter(Boolean);
  return { title, detail: parts.join(" · ") };
}
