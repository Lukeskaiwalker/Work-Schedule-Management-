import { ChangeEvent, FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";

import { apiFetch } from "./api/client";

type Language = "en" | "de";

type User = {
  id: number;
  email: string;
  full_name: string;
  role: "admin" | "ceo" | "accountant" | "planning" | "employee";
  is_active: boolean;
  required_daily_hours: number;
  avatar_updated_at?: string | null;
  invite_sent_at?: string | null;
  invite_accepted_at?: string | null;
  password_reset_sent_at?: string | null;
};

type Project = {
  id: number;
  project_number: string;
  name: string;
  description?: string;
  status: string;
  last_state?: string | null;
  last_status_at?: string | null;
  customer_name?: string | null;
  customer_address?: string | null;
  customer_contact?: string | null;
  customer_email?: string | null;
  customer_phone?: string | null;
  extra_attributes?: Record<string, any> | null;
};

type Task = {
  id: number;
  project_id: number;
  title: string;
  description?: string | null;
  materials_required?: string | null;
  storage_box_number?: number | null;
  status: string;
  due_date?: string | null;
  start_time?: string | null;
  assignee_id?: number | null;
  assignee_ids?: number[];
  week_start?: string | null;
};

type AssignableUser = {
  id: number;
  full_name: string;
  role: string;
  required_daily_hours: number;
  avatar_updated_at?: string | null;
};

type WikiLibraryFile = {
  path: string;
  brand: string;
  folder: string;
  stem: string;
  extension: string;
  file_name: string;
  mime_type: string;
  previewable: boolean;
  size_bytes: number;
  modified_at: string;
};

type Ticket = { id: number; title: string; site_address: string; ticket_date: string };

type Thread = {
  id: number;
  name: string;
  created_by?: number | null;
  project_id?: number | null;
  project_name?: string | null;
  site_id?: number | null;
  icon_updated_at?: string | null;
  message_count: number;
  unread_count: number;
  last_message_at?: string | null;
  last_message_preview?: string | null;
  can_edit?: boolean;
};

type MessageAttachment = {
  id: number;
  file_name: string;
  content_type: string;
  created_at: string;
};

type Message = {
  id: number;
  body?: string | null;
  sender_id: number;
  created_at: string;
  attachments: MessageAttachment[];
};

type ChatRenderRow =
  | {
      kind: "day";
      key: string;
      label: string;
    }
  | {
      kind: "message";
      key: string;
      message: Message;
      mine: boolean;
      showAvatar: boolean;
      showSenderName: boolean;
      timeLabel: string;
    };

type TimeCurrent = {
  server_time: string;
  clock_entry_id?: number | null;
  clock_in?: string | null;
  break_open: boolean;
  worked_hours_live: number;
  break_hours_live: number;
  required_break_hours_live: number;
  deducted_break_hours_live: number;
  net_hours_live: number;
  required_daily_hours: number;
  daily_net_hours: number;
  progress_percent_live: number;
};

type TimeEntry = {
  id: number;
  user_id: number;
  clock_in: string;
  clock_out?: string | null;
  is_open: boolean;
  break_hours: number;
  required_break_hours: number;
  deducted_break_hours: number;
  net_hours: number;
};

type TimesheetSummary = {
  user_id: number;
  total_hours: number;
  period_start: string;
  period_end: string;
};

type MonthWeekRange = {
  weekStart: string;
  weekEnd: string;
  weekNumber: number;
  weekYear: number;
  weekdaysInWeek: number;
};

type MonthWeekHours = MonthWeekRange & {
  workedHours: number;
  requiredHours: number;
};

type PlanningDay = {
  date: string;
  tasks: Task[];
  absences?: PlanningAbsence[];
};

type PlanningWeek = {
  week_start: string;
  week_end: string;
  days: PlanningDay[];
};

type PlanningAbsence = {
  type: "vacation" | "school";
  user_id: number;
  user_name: string;
  label: string;
  status?: string | null;
};

type ProjectFolder = {
  path: string;
  is_protected: boolean;
};

type ProjectFile = {
  id: number;
  project_id: number;
  folder?: string;
  path?: string;
  file_name: string;
  content_type: string;
  created_at: string;
};

type VacationRequest = {
  id: number;
  user_id: number;
  user_name: string;
  start_date: string;
  end_date: string;
  note?: string | null;
  status: string;
  reviewed_by?: number | null;
  reviewed_at?: string | null;
  created_at: string;
};

type SchoolAbsence = {
  id: number;
  user_id: number;
  user_name: string;
  title: string;
  start_date: string;
  end_date: string;
  recurrence_weekday?: number | null;
  recurrence_until?: string | null;
  created_by?: number | null;
  created_at: string;
};

type InviteDispatchResponse = {
  ok: boolean;
  user_id: number;
  email: string;
  sent: boolean;
  invite_link: string;
  expires_at: string;
};

type PasswordResetDispatchResponse = {
  ok: boolean;
  user_id: number;
  email: string;
  sent: boolean;
  reset_link: string;
  expires_at: string;
};

type ReportWorker = {
  name: string;
  start_time: string;
  end_time: string;
};

type ReportDraft = {
  customer: string;
  customer_address: string;
  customer_contact: string;
  customer_email: string;
  customer_phone: string;
  project_name: string;
  project_number: string;
};

type TaskReportPrefill = {
  task_id: number;
  report_date: string;
  work_done: string;
  incidents: string;
  materials: string;
};

type ProjectFormState = {
  project_number: string;
  name: string;
  description: string;
  status: string;
  last_state: string;
  last_status_at: string;
  customer_name: string;
  customer_address: string;
  customer_contact: string;
  customer_email: string;
  customer_phone: string;
};

type ProjectTaskFormState = {
  title: string;
  description: string;
  materials_required: string;
  has_storage_box: boolean;
  storage_box_number: string;
  due_date: string;
  start_time: string;
  assignee_query: string;
  assignee_ids: number[];
};

type TaskModalState = {
  title: string;
  description: string;
  materials_required: string;
  has_storage_box: boolean;
  storage_box_number: string;
  project_id: string;
  project_query: string;
  due_date: string;
  start_time: string;
  assignee_query: string;
  assignee_ids: number[];
  create_project_from_task: boolean;
  new_project_name: string;
  new_project_number: string;
};

type TaskEditFormState = {
  id: number | null;
  title: string;
  description: string;
  materials_required: string;
  has_storage_box: boolean;
  storage_box_number: string;
  status: string;
  due_date: string;
  start_time: string;
  assignee_query: string;
  assignee_ids: number[];
  week_start: string;
};

type MainView =
  | "overview"
  | "projects_all"
  | "projects_archive"
  | "my_tasks"
  | "project"
  | "planning"
  | "construction"
  | "wiki"
  | "messages"
  | "time"
  | "profile"
  | "admin";
type ProjectTab = "tasks" | "tickets" | "files";

const MAIN_LABELS: Record<Language, Record<MainView, string>> = {
  en: {
    overview: "Overview",
    projects_all: "All Projects",
    projects_archive: "Project Archive",
    my_tasks: "My Tasks",
    project: "Project",
    planning: "Weekly Planning",
    construction: "Construction Report",
    wiki: "Wiki",
    messages: "Chat",
    time: "Time Tracking",
    profile: "Profile",
    admin: "Admin",
  },
  de: {
    overview: "Übersicht",
    projects_all: "Alle Projekte",
    projects_archive: "Projektarchiv",
    my_tasks: "Meine Aufgaben",
    project: "Projekt",
    planning: "Wochenplanung",
    construction: "Baustellenbericht",
    wiki: "Wiki",
    messages: "Chat",
    time: "Zeiterfassung",
    profile: "Profil",
    admin: "Admin",
  },
};

const TAB_LABELS: Record<Language, Record<ProjectTab, string>> = {
  en: {
    tasks: "Tasks",
    tickets: "Job Tickets",
    files: "Files",
  },
  de: {
    tasks: "Aufgaben",
    tickets: "Job Tickets",
    files: "Dateien",
  },
};

const PROJECT_STATUS_PRESETS = [
  "active",
  "archived",
  "on_hold",
  "completed",
  "Anfrage erhalten",
  "Angebot erstellen",
  "Angebot abgeschickt",
  "Kundentermin angefragt",
  "Kundentermin vereinbart",
  "Auftrag angenommen",
  "In Durchführung",
  "Rechnung erstellen",
  "Rückfragen klären",
];

const HHMM_PATTERN = "^([01]\\d|2[0-3]):[0-5]\\d$";
const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function initialsFromName(name: string, fallback: string) {
  const parts = (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function chatDayKey(value: string, index: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return `unknown-${index}`;
  return date.toISOString().slice(0, 10);
}

function formatChatDayLabel(value: string, language: Language) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatChatTimeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function SidebarNavIcon({ view }: { view: MainView }) {
  if (view === "overview") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M3 11.5 12 4l9 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6 10.5v9h12v-9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (view === "my_tasks") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M7 7h14M7 12h14M7 17h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="m3.5 7.2 1.5 1.5 2.4-2.8m-3.9 6.9 1.5 1.5 2.4-2.8m-3.9 6.9 1.5 1.5 2.4-2.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (view === "planning") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <rect x="3.5" y="5.5" width="17" height="15" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 3.5v4M16 3.5v4M3.5 10h17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "construction") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <rect x="6" y="3.5" width="12" height="17" rx="2.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M9 8h6M9 12h6M9 16h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "wiki") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M5 4.5h11a3 3 0 0 1 3 3V19a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 19V6.5a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M8 8h7M8 11.5h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  if (view === "messages") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
        <path d="M4.5 6.5h15a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-8l-4 3v-3h-3a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="nav-icon">
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.8v4.7l3 1.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <path
        d="M4 20h4.2L19 9.2a1.4 1.4 0 0 0 0-2L16.8 5a1.4 1.4 0 0 0-2 0L4 15.8V20Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m13.8 6 4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <path
        d="M15.5 5.5 8.5 12l7 6.5M9 12h11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="task-edit-pen-icon">
      <circle cx="11" cy="11" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m15.6 15.6 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function parseListLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isoToLocalDateTimeInput(value?: string | null) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

function localDateTimeInputToIso(value: string) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function formatDateISOLocal(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfWeekISO(source: Date) {
  const monday = new Date(source);
  monday.setHours(12, 0, 0, 0);
  const diff = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - diff);
  return formatDateISOLocal(monday);
}

function addDaysISO(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setDate(d.getDate() + days);
  return formatDateISOLocal(d);
}

function normalizeWeekStartISO(isoDate: string) {
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return startOfWeekISO(d);
}

function isoWeekInfo(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map((part) => Number(part));
  if (!year || !month || !day) return { week: 0, year: 0 };
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayOfWeek);
  const weekYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { week, year: weekYear };
}

function formatDayLabel(dateIso: string, language: Language) {
  const d = new Date(`${dateIso}T00:00:00`);
  return d.toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

function schoolWeekdayLabel(dayIndex: number, language: Language) {
  const en = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const de = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"];
  if (dayIndex < 0 || dayIndex > 4) return String(dayIndex);
  return language === "de" ? de[dayIndex] : en[dayIndex];
}

function formatDayMonth(isoDate: string) {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.`;
}

function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function weekdaysBetweenIso(startIso: string, endIso: string) {
  const start = new Date(`${startIso}T12:00:00`);
  const end = new Date(`${endIso}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0;
  const cursor = new Date(start);
  let count = 0;
  while (cursor <= end) {
    const day = cursor.getDay();
    if (day >= 1 && day <= 5) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function monthWeekRanges(reference: Date): MonthWeekRange[] {
  const year = reference.getFullYear();
  const monthIndex = reference.getMonth();
  const monthStart = new Date(year, monthIndex, 1, 12, 0, 0, 0);
  const monthEnd = new Date(year, monthIndex, daysInMonth(year, monthIndex), 12, 0, 0, 0);
  const monthStartIso = formatDateISOLocal(monthStart);
  const monthEndIso = formatDateISOLocal(monthEnd);

  const weekCursor = new Date(monthStart);
  const diffToMonday = (weekCursor.getDay() + 6) % 7;
  weekCursor.setDate(weekCursor.getDate() - diffToMonday);

  const ranges: MonthWeekRange[] = [];
  while (weekCursor <= monthEnd) {
    const weekStart = formatDateISOLocal(weekCursor);
    const weekEnd = addDaysISO(weekStart, 6);
    const info = isoWeekInfo(weekStart);
    ranges.push({
      weekStart,
      weekEnd,
      weekNumber: info.week,
      weekYear: info.year,
      weekdaysInWeek: weekdaysBetweenIso(weekStart, weekEnd),
    });
    weekCursor.setDate(weekCursor.getDate() + 7);
  }
  return ranges;
}

function shiftMonthStart(source: Date, delta: number) {
  return new Date(source.getFullYear(), source.getMonth() + delta, 1);
}

function formatHours(hours: number) {
  return `${hours.toFixed(2)}h`;
}

function statusLabel(value: string, language: Language) {
  const raw = String(value || "").trim();
  const normalized = raw
    .trim()
    .toLowerCase();
  if (normalized === "active") return language === "de" ? "Aktiv" : "Active";
  if (normalized === "on_hold") return language === "de" ? "Pausiert" : "On hold";
  if (normalized === "completed") return language === "de" ? "Abgeschlossen" : "Completed";
  return raw || (language === "de" ? "Aktiv" : "Active");
}

function formatTaskStartTime(value?: string | null) {
  if (!value) return "";
  const text = String(value);
  if (text.length >= 5) return text.slice(0, 5);
  return text;
}

function isValidTimeHHMM(value: string) {
  return HHMM_REGEX.test(value.trim());
}

function normalizeTimeHHMM(value?: string | null) {
  return String(value || "")
    .trim()
    .slice(0, 5);
}

function projectUpdatedTimestamp(project: Project) {
  const direct = project.last_status_at ? Date.parse(project.last_status_at) : Number.NaN;
  if (Number.isFinite(direct)) return direct;
  const fromExtra = project.extra_attributes?.["Letzter Status Datum"];
  if (typeof fromExtra === "string") {
    const parsed = Date.parse(fromExtra);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseTimestampValue(value: unknown) {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isArchivedProjectStatus(value: string | null | undefined) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return normalized === "archived" || normalized === "archiviert" || normalized.includes("archiv");
}

function taskNotificationDigest(rows: Task[]) {
  const chunks = rows
    .map((task) => {
      const assigneeIds = [...(task.assignee_ids ?? [])].sort((a, b) => a - b).join(",");
      return [
        task.id,
        task.project_id,
        task.status || "",
        task.due_date || "",
        task.start_time || "",
        task.week_start || "",
        assigneeIds,
      ].join(":");
    })
    .sort();
  return chunks.join("|");
}

function isLikelyJwtToken(value: string) {
  return /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(value.trim());
}

function readStoredToken() {
  try {
    const raw = localStorage.getItem("smpl_token");
    if (!raw) return null;
    const clean = raw.trim();
    if (!clean || !isLikelyJwtToken(clean)) {
      localStorage.removeItem("smpl_token");
      return null;
    }
    return clean;
  } catch {
    return null;
  }
}

function detectPublicAuthMode() {
  const normalizedPath = window.location.pathname.replace(/\/+$/, "");
  if (normalizedPath === "/invite") return "invite" as const;
  if (normalizedPath === "/reset-password") return "reset" as const;
  return null;
}

function readPublicTokenParam() {
  try {
    const params = new URLSearchParams(window.location.search);
    return (params.get("token") || "").trim();
  } catch {
    return "";
  }
}

function toIcsUtcDateTime(value: Date) {
  const yyyy = value.getUTCFullYear();
  const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(value.getUTCDate()).padStart(2, "0");
  const hh = String(value.getUTCHours()).padStart(2, "0");
  const mi = String(value.getUTCMinutes()).padStart(2, "0");
  const ss = String(value.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

function toIcsDate(value: Date) {
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const dd = String(value.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function escapeIcs(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function WorkHoursGauge({
  language,
  netHours,
  requiredHours,
  compact = false,
}: {
  language: Language;
  netHours: number;
  requiredHours: number;
  compact?: boolean;
}) {
  const required = requiredHours > 0 ? requiredHours : 8;
  const worked = Math.max(netHours, 0);
  const progressPercent = required > 0 ? (worked / required) * 100 : 0;
  const ringPercent = progressPercent >= 100 ? 100 : clamp(progressPercent, 0, 100);
  const overtimeBlend = clamp((progressPercent - 100) / 100, 0, 1);
  const overtimeColor = `rgb(${Math.round(47 + (180 - 47) * overtimeBlend)}, ${Math.round(111 + (54 - 111) * overtimeBlend)}, ${Math.round(127 + (65 - 127) * overtimeBlend)})`;
  const ringFillBackground =
    progressPercent > 100
      ? `conic-gradient(from -90deg, #2f6f7f 0%, ${overtimeColor} 100%)`
      : `conic-gradient(#2f6f7f ${ringPercent}%, #f1ece3 ${ringPercent}% 100%)`;
  const remaining = Math.max(required - worked, 0);
  const overtime = Math.max(worked - required, 0);

  return (
    <div className={compact ? "work-gauge compact" : "work-gauge"}>
      <div className="work-gauge-head">
        <b>{language === "de" ? "Tagesziel" : "Daily target"}</b>
        <span>{progressPercent.toFixed(0)}%</span>
      </div>
      <div
        className="work-gauge-ring"
        role="meter"
        aria-valuemin={0}
        aria-valuenow={progressPercent}
        aria-valuetext={`${progressPercent.toFixed(0)}%`}
        style={{ background: ringFillBackground }}
      >
        <div className="work-gauge-ring-inner">
          <strong className="work-gauge-value">{formatHours(worked)}</strong>
          <small>{language === "de" ? "heute" : "today"}</small>
        </div>
      </div>
      <div className="work-gauge-meta">
        <small>
          {language === "de" ? "Geleistet" : "Worked"}: {formatHours(worked)}
        </small>
        <small>
          {language === "de" ? "Soll" : "Required"}: {formatHours(required)}
        </small>
        <small>
          {overtime > 0
            ? `${language === "de" ? "Überstunden" : "Overtime"}: ${formatHours(overtime)}`
            : `${language === "de" ? "Rest" : "Remaining"}: ${formatHours(remaining)}`}
        </small>
      </div>
    </div>
  );
}

function WeeklyHoursGauge({
  language,
  row,
}: {
  language: Language;
  row: MonthWeekHours;
}) {
  const percent = row.requiredHours > 0 ? (row.workedHours / row.requiredHours) * 100 : 0;
  const fillPercent = clamp(percent, 0, 100);
  const rangeLabel = `${formatDayMonth(row.weekStart)} - ${formatDayMonth(row.weekEnd)}`;
  return (
    <div className={row.weekStart === startOfWeekISO(new Date()) ? "weekly-hours-row current" : "weekly-hours-row"}>
      <div className="weekly-hours-head">
        <b>
          <span className="weekly-week-number">KW {row.weekNumber}</span> {rangeLabel}
        </b>
        <div className="weekly-hours-values">
          <span>{formatHours(row.workedHours)}</span>
          <span className="weekly-hours-separator">|</span>
          <span>{formatHours(row.requiredHours)}</span>
        </div>
      </div>
      <div className="weekly-hours-track" role="meter" aria-valuemin={0} aria-valuenow={percent} aria-valuetext={`${percent.toFixed(0)}%`}>
        <div className="weekly-hours-fill" style={{ width: `${fillPercent}%` }} />
      </div>
      <small className="muted">
        {language === "de" ? "Ist / Soll" : "Worked / Required"}: {percent.toFixed(0)}%
      </small>
    </div>
  );
}

function MonthlyHoursGauge({
  language,
  workedHours,
  requiredHours,
}: {
  language: Language;
  workedHours: number;
  requiredHours: number;
}) {
  const required = requiredHours > 0 ? requiredHours : 1;
  const percent = (workedHours / required) * 100;
  const shownPercent = clamp(percent, 0, 100);
  const radius = 102;
  const arcLength = Math.PI * radius;
  const filledLength = (shownPercent / 100) * arcLength;
  return (
    <div className="monthly-gauge-wrap">
      <svg viewBox="0 0 260 160" className="monthly-gauge" role="meter" aria-valuemin={0} aria-valuenow={percent} aria-valuetext={`${percent.toFixed(0)}%`}>
        <path
          d={`M 28 132 A ${radius} ${radius} 0 0 1 232 132`}
          className="monthly-gauge-track"
          pathLength={arcLength}
          strokeDasharray={`${arcLength} ${arcLength}`}
        />
        <path
          d={`M 28 132 A ${radius} ${radius} 0 0 1 232 132`}
          className="monthly-gauge-fill"
          pathLength={arcLength}
          strokeDasharray={`${filledLength} ${arcLength}`}
        />
      </svg>
      <div className="monthly-gauge-center">
        <strong>{formatHours(workedHours)}</strong>
        <small>{formatHours(Math.max(requiredHours, 0))}</small>
      </div>
    </div>
  );
}

function reportDraftFromProject(project: Project | null): ReportDraft {
  if (!project) return { ...EMPTY_REPORT_DRAFT };
  return {
    customer: project.customer_name ?? "",
    customer_address: project.customer_address ?? "",
    customer_contact: project.customer_contact ?? "",
    customer_email: project.customer_email ?? "",
    customer_phone: project.customer_phone ?? "",
    project_name: project.name ?? "",
    project_number: project.project_number ?? "",
  };
}

const EMPTY_PROJECT_FORM: ProjectFormState = {
  project_number: "",
  name: "",
  description: "",
  status: "active",
  last_state: "",
  last_status_at: "",
  customer_name: "",
  customer_address: "",
  customer_contact: "",
  customer_email: "",
  customer_phone: "",
};

function buildEmptyProjectTaskFormState(): ProjectTaskFormState {
  return {
    title: "",
    description: "",
    materials_required: "",
    has_storage_box: false,
    storage_box_number: "",
    due_date: "",
    start_time: "",
    assignee_query: "",
    assignee_ids: [],
  };
}

function buildTaskModalFormState(defaults?: {
  projectId?: number | null;
  dueDate?: string;
  projectQuery?: string;
}): TaskModalState {
  return {
    title: "",
    description: "",
    materials_required: "",
    has_storage_box: false,
    storage_box_number: "",
    project_id: defaults?.projectId ? String(defaults.projectId) : "",
    project_query: defaults?.projectQuery ?? "",
    due_date: defaults?.dueDate ?? "",
    start_time: "",
    assignee_query: "",
    assignee_ids: [],
    create_project_from_task: false,
    new_project_name: "",
    new_project_number: "",
  };
}

function buildTaskEditFormState(task?: Task | null): TaskEditFormState {
  const assigneeIds =
    task?.assignee_ids && task.assignee_ids.length > 0
      ? task.assignee_ids
      : task?.assignee_id
        ? [task.assignee_id]
        : [];
  return {
    id: task?.id ?? null,
    title: task?.title ?? "",
    description: task?.description ?? "",
    materials_required: task?.materials_required ?? "",
    has_storage_box: task?.storage_box_number != null,
    storage_box_number: task?.storage_box_number != null ? String(task.storage_box_number) : "",
    status: task?.status ?? "open",
    due_date: task?.due_date ?? "",
    start_time: task?.start_time ? formatTaskStartTime(task.start_time) : "",
    assignee_query: "",
    assignee_ids: assigneeIds,
    week_start: task?.week_start ?? "",
  };
}

const EMPTY_REPORT_DRAFT: ReportDraft = {
  customer: "",
  customer_address: "",
  customer_contact: "",
  customer_email: "",
  customer_phone: "",
  project_name: "",
  project_number: "",
};

type ThreadModalState = {
  name: string;
  project_id: string;
};

type AvatarUploadResponse = {
  ok: boolean;
  avatar_updated_at?: string | null;
};

type AvatarImageSize = {
  width: number;
  height: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image could not be loaded"));
    img.src = source;
  });
}

async function buildAvatarCropDataUrl(
  source: string,
  zoom: number,
  offsetXPercent: number,
  offsetYPercent: number,
  outputSize = 320,
): Promise<string> {
  const img = await loadImage(source);
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");

  const baseCropSize = Math.min(img.width, img.height);
  const safeZoom = clamp(zoom, 1, 3);
  const cropSize = baseCropSize / safeZoom;
  const maxShiftX = Math.max(0, (img.width - cropSize) / 2);
  const maxShiftY = Math.max(0, (img.height - cropSize) / 2);
  const targetCenterX = img.width / 2 + clamp(offsetXPercent, -100, 100) * (maxShiftX / 100);
  const targetCenterY = img.height / 2 + clamp(offsetYPercent, -100, 100) * (maxShiftY / 100);
  const sx = clamp(targetCenterX - cropSize / 2, 0, img.width - cropSize);
  const sy = clamp(targetCenterY - cropSize / 2, 0, img.height - cropSize);

  ctx.drawImage(img, sx, sy, cropSize, cropSize, 0, 0, outputSize, outputSize);
  return canvas.toDataURL("image/jpeg", 0.92);
}

function avatarStageMetrics(
  imageSize: AvatarImageSize | null,
  stageSize: number,
  zoom: number,
  offsetXPercent: number,
  offsetYPercent: number,
) {
  if (!imageSize || stageSize <= 0) {
    return { maxPanX: 0, maxPanY: 0, translateX: 0, translateY: 0 };
  }
  const coverScale = Math.max(stageSize / imageSize.width, stageSize / imageSize.height);
  const renderedWidth = imageSize.width * coverScale * zoom;
  const renderedHeight = imageSize.height * coverScale * zoom;
  const maxPanX = Math.max(0, (renderedWidth - stageSize) / 2);
  const maxPanY = Math.max(0, (renderedHeight - stageSize) / 2);
  const translateX = (clamp(offsetXPercent, -100, 100) / 100) * maxPanX;
  const translateY = (clamp(offsetYPercent, -100, 100) / 100) * maxPanY;
  return { maxPanX, maxPanY, translateX, translateY };
}

function AvatarBadge({
  userId,
  initials,
  hasAvatar,
  versionKey,
  className,
}: {
  userId: number;
  initials: string;
  hasAvatar: boolean;
  versionKey: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const classNames = className ? `sidebar-user-avatar ${className}` : "sidebar-user-avatar";

  useEffect(() => {
    setFailed(false);
  }, [userId, hasAvatar, versionKey]);

  return (
    <div className={classNames} aria-hidden="true">
      {hasAvatar && !failed && (
        <img
          src={`/api/users/${userId}/avatar?v=${encodeURIComponent(versionKey)}`}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
      <span>{initials}</span>
    </div>
  );
}

function threadInitials(name: string) {
  const parts = (name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "T";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function ThreadIconBadge({
  threadId,
  initials,
  hasIcon,
  versionKey,
  className,
}: {
  threadId: number;
  initials: string;
  hasIcon: boolean;
  versionKey: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const classNames = className ? `thread-avatar ${className}` : "thread-avatar";

  useEffect(() => {
    setFailed(false);
  }, [threadId, hasIcon, versionKey]);

  return (
    <div className={classNames} aria-hidden="true">
      {hasIcon && !failed && (
        <img
          src={`/api/threads/${threadId}/icon?v=${encodeURIComponent(versionKey)}`}
          alt=""
          onError={() => setFailed(true)}
        />
      )}
      <span>{initials}</span>
    </div>
  );
}

export function App() {
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [language, setLanguage] = useState<Language>(() =>
    localStorage.getItem("smpl_language") === "de" ? "de" : "en",
  );
  const [now, setNow] = useState<Date>(new Date());

  const [user, setUser] = useState<User | null>(null);
  const [mainView, setMainView] = useState<MainView>("overview");
  const [overviewShortcutBackVisible, setOverviewShortcutBackVisible] = useState(false);
  const [projectTab, setProjectTab] = useState<ProjectTab>("tasks");
  const [error, setError] = useState<string>("");
  const [notice, setNotice] = useState<string>("");

  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("ChangeMe123!");
  const [publicAuthMode, setPublicAuthMode] = useState<"invite" | "reset" | null>(() => detectPublicAuthMode());
  const [publicToken, setPublicToken] = useState(() => readPublicTokenParam());
  const [publicFullName, setPublicFullName] = useState("");
  const [publicEmail, setPublicEmail] = useState("");
  const [publicNewPassword, setPublicNewPassword] = useState("");
  const [publicConfirmPassword, setPublicConfirmPassword] = useState("");

  const [users, setUsers] = useState<User[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectSidebarSearchOpen, setProjectSidebarSearchOpen] = useState(false);
  const [projectSidebarSearchQuery, setProjectSidebarSearchQuery] = useState("");
  const [overview, setOverview] = useState<any[]>([]);
  const [overviewStatusFilter, setOverviewStatusFilter] = useState<string>("all");
  const [projectsAllSearch, setProjectsAllSearch] = useState<string>("");
  const [projectsAllStateFilter, setProjectsAllStateFilter] = useState<string>("all");
  const [projectsAllEditedFilter, setProjectsAllEditedFilter] = useState<string>("all");

  const [taskView, setTaskView] = useState<"my" | "all_open">("my");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expandedMyTaskId, setExpandedMyTaskId] = useState<number | null>(null);
  const [myTasksBackProjectId, setMyTasksBackProjectId] = useState<number | null>(null);
  const [hasTaskNotifications, setHasTaskNotifications] = useState(false);

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [projectFolders, setProjectFolders] = useState<ProjectFolder[]>([]);
  const [fileUploadFolder, setFileUploadFolder] = useState("");
  const [newProjectFolderPath, setNewProjectFolderPath] = useState("");
  const [wikiFiles, setWikiFiles] = useState<WikiLibraryFile[]>([]);
  const [wikiSearch, setWikiSearch] = useState("");
  const [activeWikiPath, setActiveWikiPath] = useState<string | null>(null);

  const [planningWeekStart, setPlanningWeekStart] = useState<string>(() => startOfWeekISO(new Date()));
  const [planningWeek, setPlanningWeek] = useState<PlanningWeek | null>(null);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messageBody, setMessageBody] = useState("");
  const [messageAttachment, setMessageAttachment] = useState<File | null>(null);
  const messageAttachmentInputRef = useRef<HTMLInputElement | null>(null);

  const [timeCurrent, setTimeCurrent] = useState<TimeCurrent | null>(null);
  const [timeEntries, setTimeEntries] = useState<TimeEntry[]>([]);
  const [timeMonthRows, setTimeMonthRows] = useState<MonthWeekHours[]>([]);
  const [vacationRequests, setVacationRequests] = useState<VacationRequest[]>([]);
  const [schoolAbsences, setSchoolAbsences] = useState<SchoolAbsence[]>([]);
  const [vacationRequestForm, setVacationRequestForm] = useState({
    start_date: formatDateISOLocal(new Date()),
    end_date: formatDateISOLocal(new Date()),
    note: "",
  });
  const [schoolAbsenceForm, setSchoolAbsenceForm] = useState({
    user_id: "",
    title: "Berufsschule",
    start_date: formatDateISOLocal(new Date()),
    end_date: formatDateISOLocal(new Date()),
    recurrence_weekdays: [] as number[],
    recurrence_until: "",
  });
  const [profileSettingsForm, setProfileSettingsForm] = useState({
    full_name: "",
    email: "",
    current_password: "",
    new_password: "",
  });
  const [inviteCreateForm, setInviteCreateForm] = useState({
    email: "",
    full_name: "",
    role: "employee" as User["role"],
  });
  const [backupExporting, setBackupExporting] = useState(false);
  const [timeMonthCursor, setTimeMonthCursor] = useState<Date>(() => {
    const current = new Date();
    return new Date(current.getFullYear(), current.getMonth(), 1);
  });
  const [timeInfoOpen, setTimeInfoOpen] = useState(false);
  const [timeTargetUserId, setTimeTargetUserId] = useState<string>("");
  const [requiredHoursDrafts, setRequiredHoursDrafts] = useState<Record<number, string>>({});

  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<number | null>(null);
  const [fileQuery, setFileQuery] = useState("");
  const [projectModalMode, setProjectModalMode] = useState<"create" | "edit" | null>(null);
  const [projectForm, setProjectForm] = useState<ProjectFormState>(EMPTY_PROJECT_FORM);
  const [projectTaskForm, setProjectTaskForm] = useState<ProjectTaskFormState>(() =>
    buildEmptyProjectTaskFormState(),
  );
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [taskModalForm, setTaskModalForm] = useState<TaskModalState>(() =>
    buildTaskModalFormState({ dueDate: planningWeekStart }),
  );
  const [taskEditModalOpen, setTaskEditModalOpen] = useState(false);
  const [taskEditForm, setTaskEditForm] = useState<TaskEditFormState>(() => buildTaskEditFormState());
  const [projectBackView, setProjectBackView] = useState<MainView | null>(null);
  const [reportProjectId, setReportProjectId] = useState<string>("");
  const [reportDraft, setReportDraft] = useState<ReportDraft>(EMPTY_REPORT_DRAFT);
  const [reportTaskPrefill, setReportTaskPrefill] = useState<TaskReportPrefill | null>(null);
  const [constructionBackView, setConstructionBackView] = useState<MainView | null>(null);
  const [fileUploadModalOpen, setFileUploadModalOpen] = useState(false);
  const [avatarModalOpen, setAvatarModalOpen] = useState(false);
  const [avatarSourceUrl, setAvatarSourceUrl] = useState("");
  const [avatarZoom, setAvatarZoom] = useState(1);
  const [avatarOffsetX, setAvatarOffsetX] = useState(0);
  const [avatarOffsetY, setAvatarOffsetY] = useState(0);
  const [avatarNaturalSize, setAvatarNaturalSize] = useState<AvatarImageSize | null>(null);
  const [avatarStageSize, setAvatarStageSize] = useState(260);
  const [avatarIsDragging, setAvatarIsDragging] = useState(false);
  const [avatarPreviewDataUrl, setAvatarPreviewDataUrl] = useState("");
  const [avatarVersionKey, setAvatarVersionKey] = useState<string>(String(Date.now()));
  const [preUserMenuOpen, setPreUserMenuOpen] = useState(false);
  const [adminUserMenuOpenId, setAdminUserMenuOpenId] = useState<number | null>(null);
  const avatarObjectUrlRef = useRef<string | null>(null);
  const avatarCropStageRef = useRef<HTMLDivElement | null>(null);
  const preUserMenuRef = useRef<HTMLDivElement | null>(null);
  const timeInfoRef = useRef<HTMLDivElement | null>(null);
  const avatarDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);
  const [threadModalMode, setThreadModalMode] = useState<"create" | "edit" | null>(null);
  const [threadModalForm, setThreadModalForm] = useState<ThreadModalState>({ name: "", project_id: "" });
  const [threadIconFile, setThreadIconFile] = useState<File | null>(null);
  const [threadIconPreviewUrl, setThreadIconPreviewUrl] = useState<string>("");
  const threadIconObjectUrlRef = useRef<string | null>(null);
  const messageListRef = useRef<HTMLUListElement | null>(null);
  const constructionFormRef = useRef<HTMLFormElement | null>(null);
  const taskNotificationSnapshotRef = useRef("");
  const shouldFollowMessagesRef = useRef(true);
  const forceScrollToBottomRef = useRef(false);

  const [reportWorkers, setReportWorkers] = useState<ReportWorker[]>([{ name: "", start_time: "", end_time: "" }]);

  const isAdmin = user?.role === "admin";
  const canAdjustRequiredHours = user ? ["admin", "ceo"].includes(user.role) : false;
  const canCreateProject = user ? ["admin", "ceo"].includes(user.role) : false;
  const canManageTasks = user ? ["admin", "ceo", "planning"].includes(user.role) : false;
  const isTimeManager = user ? ["admin", "ceo", "accountant", "planning"].includes(user.role) : false;
  const canApproveVacation = user ? ["admin", "ceo"].includes(user.role) : false;
  const canManageSchoolAbsences = user ? ["admin", "ceo", "accountant"].includes(user.role) : false;
  const canManageProjectImport = user ? ["admin", "ceo"].includes(user.role) : false;
  const canUseProtectedFolders = user ? ["admin", "ceo", "planning", "accountant"].includes(user.role) : false;
  const mainLabels = MAIN_LABELS[language];
  const tabLabels = TAB_LABELS[language];

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const activeProjectHeaderTitle = useMemo(() => {
    if (!activeProject) return "";
    const customer = (activeProject.customer_name ?? "").trim();
    if (customer) return customer;
    return activeProject.project_number;
  }, [activeProject]);
  const activeProjectLastState = useMemo(() => {
    if (!activeProject) return "";
    const direct = (activeProject.last_state ?? "").trim();
    if (direct) return direct;
    const fallback = activeProject.extra_attributes?.Notiz;
    return typeof fallback === "string" ? fallback.trim() : "";
  }, [activeProject]);
  const activeProjectLastStatusAtLabel = useMemo(() => {
    if (!activeProject?.last_status_at) return "";
    const parsed = new Date(activeProject.last_status_at);
    if (Number.isNaN(parsed.getTime())) return String(activeProject.last_status_at);
    return parsed.toLocaleString(language === "de" ? "de-DE" : "en-US");
  }, [activeProject?.last_status_at, language]);
  const activeProjectAddress = useMemo(() => {
    if (!activeProject) return "";
    const address = (activeProject.customer_address ?? "").trim();
    if (address) return address;
    return "";
  }, [activeProject]);
  const activeProjectMapQuery = useMemo(() => {
    if (!activeProjectAddress) return "";
    const parts = [
      activeProjectAddress,
      (activeProject.customer_name ?? "").trim(),
      (activeProject.name ?? "").trim(),
    ].filter((part) => part.length > 0);
    return parts.join(", ");
  }, [activeProjectAddress, activeProject?.customer_name, activeProject?.name]);
  const activeProjectMapEmbedUrl = useMemo(() => {
    if (!activeProjectMapQuery) return "";
    return `https://maps.google.com/maps?q=${encodeURIComponent(activeProjectMapQuery)}&z=14&output=embed`;
  }, [activeProjectMapQuery]);
  const activeProjectMapOpenUrl = useMemo(() => {
    if (!activeProjectMapQuery) return "";
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(activeProjectMapQuery)}`;
  }, [activeProjectMapQuery]);
  const projectStatusOptions = useMemo(() => {
    const values = new Set(PROJECT_STATUS_PRESETS);
    projects.forEach((project) => {
      const status = String(project.status ?? "").trim();
      if (status) values.add(status);
    });
    return Array.from(values);
  }, [projects]);
  const projectStatusSelectOptions = useMemo(() => {
    const values = new Set(projectStatusOptions);
    const current = projectForm.status.trim();
    if (current) values.add(current);
    return Array.from(values);
  }, [projectStatusOptions, projectForm.status]);
  const overviewStatusOptions = useMemo(() => {
    const values = new Set<string>();
    projects.forEach((project) => {
      const status = String(project.status ?? "").trim();
      if (status) values.add(status);
    });
    overview.forEach((row) => {
      const status = String(row.status ?? "").trim();
      if (status) values.add(status);
    });
    return Array.from(values).sort((a, b) =>
      a.localeCompare(b, language === "de" ? "de-DE" : "en-US", { sensitivity: "base" }),
    );
  }, [projects, overview, language]);
  const projectsById = useMemo(
    () => new Map<number, Project>(projects.map((project) => [project.id, project])),
    [projects],
  );
  const filteredSidebarProjects = useMemo(() => {
    const query = projectSidebarSearchQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => {
      const searchable = [
        project.project_number,
        project.name,
        project.customer_name ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(query);
    });
  }, [projects, projectSidebarSearchQuery]);
  const archivedProjects = useMemo(
    () => projects.filter((project) => isArchivedProjectStatus(project.status)),
    [projects],
  );
  const detailedOverviewRows = useMemo(() => {
    return overview
      .map((row) => {
        const projectId = Number(row.project_id);
        const project = projectsById.get(projectId);
        const customerName = String(row.customer_name ?? project?.customer_name ?? "").trim() || "-";
        const projectName = String(row.name ?? project?.name ?? "").trim();
        const projectNumber = String(row.project_number ?? project?.project_number ?? row.project_id ?? "-");
        const lastState =
          String(row.last_state ?? project?.last_state ?? project?.extra_attributes?.Notiz ?? "").trim() || "-";
        const lastStatusRaw =
          String(
            row.last_status_at ??
              project?.last_status_at ??
              project?.extra_attributes?.["Letzter Status Datum"] ??
              "",
          ).trim() || null;
        const lastStatusTimestamp = parseTimestampValue(lastStatusRaw);
        return {
          ...row,
          project_id: projectId,
          project_name: projectName,
          project_number: projectNumber,
          customer_name: customerName,
          last_state: lastState,
          last_status_at: lastStatusRaw,
          last_status_timestamp: lastStatusTimestamp,
        };
      })
      .sort((a, b) => {
        const tsDiff = b.last_status_timestamp - a.last_status_timestamp;
        if (tsDiff !== 0) return tsDiff;
        return Number(b.project_id || 0) - Number(a.project_id || 0);
      });
  }, [overview, projectsById]);
  const filteredDetailedOverview = useMemo(() => {
    if (overviewStatusFilter === "all") return detailedOverviewRows;
    return detailedOverviewRows.filter((row) => String(row.status ?? "").trim() === overviewStatusFilter);
  }, [detailedOverviewRows, overviewStatusFilter]);
  const filteredProjectsAll = useMemo(() => {
    const needle = projectsAllSearch.trim().toLowerCase();
    const nowTs = now.getTime();
    return detailedOverviewRows.filter((row) => {
      const status = String(row.status ?? "").trim();
      if (projectsAllStateFilter !== "all" && status !== projectsAllStateFilter) return false;
      if (projectsAllEditedFilter !== "all") {
        const ts = Number(row.last_status_timestamp ?? 0);
        if (projectsAllEditedFilter === "missing") {
          if (ts > 0) return false;
        } else {
          if (ts <= 0) return false;
          const ageDays = (nowTs - ts) / 86_400_000;
          if (projectsAllEditedFilter === "7d" && ageDays > 7) return false;
          if (projectsAllEditedFilter === "30d" && ageDays > 30) return false;
          if (projectsAllEditedFilter === "90d" && ageDays > 90) return false;
          if (projectsAllEditedFilter === "older" && ageDays <= 90) return false;
        }
      }
      if (!needle) return true;
      const searchable = [
        String(row.project_number ?? ""),
        String(row.customer_name ?? ""),
        String(row.project_name ?? ""),
        String(row.last_state ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      return searchable.includes(needle);
    });
  }, [detailedOverviewRows, projectsAllSearch, projectsAllStateFilter, projectsAllEditedFilter, now]);
  const recentAssignedProjects = useMemo(() => {
    const assignedIds = new Set<number>();
    tasks.forEach((task) => {
      if (task.project_id) assignedIds.add(task.project_id);
    });
    return Array.from(assignedIds)
      .map((projectId) => projectsById.get(projectId))
      .filter((project): project is Project => Boolean(project))
      .sort((a, b) => {
        const delta = projectUpdatedTimestamp(b) - projectUpdatedTimestamp(a);
        if (delta !== 0) return delta;
        return b.id - a.id;
      })
      .slice(0, 10);
  }, [projectsById, tasks]);
  const overviewActionCards = useMemo(
    () =>
      [
        { view: "construction", label: mainLabels.construction },
        { view: "time", label: mainLabels.time },
        { view: "wiki", label: mainLabels.wiki },
      ] as const,
    [mainLabels],
  );
  const overviewActionCardWidth = useMemo(() => {
    const longestWordLength = overviewActionCards.reduce((maxValue, action) => {
      const longestWord = action.label
        .split(/\s+/)
        .reduce((longest, word) => (word.length > longest.length ? word : longest), "");
      return Math.max(maxValue, longestWord.length);
    }, 10);
    return `${Math.max(12, longestWordLength + 4)}ch`;
  }, [overviewActionCards]);
  const projectTaskAssigneeSuggestions = useMemo(() => {
    const query = projectTaskForm.assignee_query.trim().toLowerCase();
    if (!query) return [];
    return assignableUsers
      .filter((assignee) => !projectTaskForm.assignee_ids.includes(assignee.id))
      .filter(
        (assignee) =>
          assignee.full_name.toLowerCase().includes(query) || String(assignee.id).includes(query),
      )
      .slice(0, 8);
  }, [assignableUsers, projectTaskForm.assignee_ids, projectTaskForm.assignee_query]);
  const taskModalAssigneeSuggestions = useMemo(() => {
    const query = taskModalForm.assignee_query.trim().toLowerCase();
    if (!query) return [];
    return assignableUsers
      .filter((assignee) => !taskModalForm.assignee_ids.includes(assignee.id))
      .filter(
        (assignee) =>
          assignee.full_name.toLowerCase().includes(query) || String(assignee.id).includes(query),
      )
      .slice(0, 8);
  }, [assignableUsers, taskModalForm.assignee_ids, taskModalForm.assignee_query]);
  const taskEditAssigneeSuggestions = useMemo(() => {
    const query = taskEditForm.assignee_query.trim().toLowerCase();
    if (!query) return [];
    return assignableUsers
      .filter((assignee) => !taskEditForm.assignee_ids.includes(assignee.id))
      .filter(
        (assignee) =>
          assignee.full_name.toLowerCase().includes(query) || String(assignee.id).includes(query),
      )
      .slice(0, 8);
  }, [assignableUsers, taskEditForm.assignee_ids, taskEditForm.assignee_query]);
  const taskModalProjectSuggestions = useMemo(() => {
    const query = taskModalForm.project_query.trim().toLowerCase();
    const selectedId = Number(taskModalForm.project_id);
    const rows = projects
      .filter((project) => project.id !== selectedId)
      .filter((project) => {
        if (!query) return true;
        const searchable = [
          project.project_number,
          project.name,
          project.customer_name ?? "",
          project.customer_address ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return searchable.includes(query);
      });
    return rows.slice(0, 8);
  }, [projects, taskModalForm.project_id, taskModalForm.project_query]);
  const selectedTaskModalProject = useMemo(
    () => projects.find((project) => String(project.id) === taskModalForm.project_id) ?? null,
    [projects, taskModalForm.project_id],
  );
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const hasUnreadThreads = useMemo(
    () => threads.some((thread) => Number(thread.unread_count ?? 0) > 0),
    [threads],
  );
  const assignableUsersById = useMemo(
    () => new Map(assignableUsers.map((entry) => [entry.id, entry])),
    [assignableUsers],
  );
  const adminUsersById = useMemo(
    () => new Map(users.map((entry) => [entry.id, entry])),
    [users],
  );
  const hasMessageText = messageBody.trim().length > 0;
  const canSendMessage = hasMessageText || Boolean(messageAttachment);
  const chatRenderRows = useMemo<ChatRenderRow[]>(() => {
    const rows: ChatRenderRow[] = [];
    let previousDay = "";
    let previousSender: number | null = null;

    messages.forEach((message, index) => {
      const dayKey = chatDayKey(message.created_at, index);
      if (dayKey !== previousDay) {
        rows.push({
          kind: "day",
          key: `day-${dayKey}-${index}`,
          label: formatChatDayLabel(message.created_at, language),
        });
        previousDay = dayKey;
        previousSender = null;
      }

      const mine = message.sender_id === user?.id;
      const showAvatar = !mine && previousSender !== message.sender_id;
      rows.push({
        kind: "message",
        key: `message-${message.id}`,
        message,
        mine,
        showAvatar,
        showSenderName: showAvatar,
        timeLabel: formatChatTimeLabel(message.created_at),
      });
      previousSender = message.sender_id;
    });

    return rows;
  }, [messages, language, user?.id]);
  const showOverviewBackButton = useMemo(
    () =>
      overviewShortcutBackVisible &&
      (mainView === "construction" || mainView === "time" || mainView === "wiki"),
    [overviewShortcutBackVisible, mainView],
  );
  const selectedReportProject = useMemo(
    () => projects.find((project) => String(project.id) === reportProjectId) ?? null,
    [projects, reportProjectId],
  );
  const planningWeekInfo = useMemo(() => isoWeekInfo(planningWeekStart), [planningWeekStart]);
  const taskStatusOptions = useMemo(() => {
    const values = new Set<string>(["open", "in_progress", "done", "on_hold"]);
    tasks.forEach((task) => {
      const status = String(task.status ?? "").trim();
      if (status) values.add(status);
    });
    const current = taskEditForm.status.trim();
    if (current) values.add(current);
    return Array.from(values);
  }, [tasks, taskEditForm.status]);

  const navViews = useMemo<MainView[]>(() => {
    const views: MainView[] = ["overview", "my_tasks", "planning", "messages"];
    return views;
  }, []);

  const projectTabs = useMemo<ProjectTab[]>(() => ["tasks", "tickets", "files"], []);

  const fileRows = useMemo(
    () =>
      files.filter((file) => {
        if (!fileQuery.trim()) return true;
        const query = fileQuery.trim().toLowerCase();
        return (
          String(file.file_name).toLowerCase().includes(query) ||
          String(file.folder || "").toLowerCase().includes(query) ||
          String(file.path || "").toLowerCase().includes(query)
        );
      }),
    [files, fileQuery],
  );

  const wikiRows = useMemo(() => {
    const query = wikiSearch.trim().toLowerCase();
    const filtered = wikiFiles.filter((entry) => {
      if (!query) return true;
      const haystack = [
        entry.path,
        entry.file_name,
        entry.stem,
        entry.brand,
        entry.folder,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });

    const brands = new Map<
      string,
      {
        name: string;
        folders: Map<
          string,
          {
            path: string;
            name: string;
            docs: Map<string, { key: string; label: string; variants: WikiLibraryFile[] }>;
          }
        >;
      }
    >();

    for (const file of filtered) {
      const brandKey = file.brand.trim() || "-";
      let brand = brands.get(brandKey);
      if (!brand) {
        brand = { name: brandKey, folders: new Map() };
        brands.set(brandKey, brand);
      }

      const folderPath = file.folder.trim();
      let folder = brand.folders.get(folderPath);
      if (!folder) {
        const folderParts = folderPath ? folderPath.split("/") : [];
        folder = {
          path: folderPath,
          name: folderParts.length > 0 ? folderParts[folderParts.length - 1] : language === "de" ? "Hauptordner" : "Root",
          docs: new Map(),
        };
        brand.folders.set(folderPath, folder);
      }

      const docKey = file.stem.toLowerCase();
      let doc = folder.docs.get(docKey);
      if (!doc) {
        doc = { key: docKey, label: file.stem || file.file_name, variants: [] };
        folder.docs.set(docKey, doc);
      }
      doc.variants.push(file);
    }

    return Array.from(brands.values())
      .sort((a, b) => a.name.localeCompare(b.name, language === "de" ? "de-DE" : "en-US"))
      .map((brand) => ({
        name: brand.name,
        folders: Array.from(brand.folders.values())
          .sort((a, b) => a.path.localeCompare(b.path, language === "de" ? "de-DE" : "en-US"))
          .map((folder) => ({
            path: folder.path,
            name: folder.name,
            documents: Array.from(folder.docs.values())
              .sort((a, b) => a.label.localeCompare(b.label, language === "de" ? "de-DE" : "en-US"))
              .map((doc) => ({
                ...doc,
                variants: [...doc.variants].sort((left, right) => {
                  const order = (ext: string) => {
                    if (ext === "html" || ext === "htm") return 0;
                    if (ext === "pdf") return 1;
                    return 2;
                  };
                  const first = order(left.extension);
                  const second = order(right.extension);
                  if (first !== second) return first - second;
                  return left.extension.localeCompare(right.extension, language === "de" ? "de-DE" : "en-US");
                }),
              })),
          })),
      }));
  }, [wikiFiles, wikiSearch, language]);

  const activeWikiFile = useMemo(
    () => wikiFiles.find((entry) => entry.path === activeWikiPath) ?? null,
    [wikiFiles, activeWikiPath],
  );
  const activeProjectTicketDate = useMemo(() => {
    if (!activeProject?.last_status_at) return formatDateISOLocal(new Date());
    const parsed = new Date(activeProject.last_status_at);
    if (Number.isNaN(parsed.getTime())) return formatDateISOLocal(new Date());
    return formatDateISOLocal(parsed);
  }, [activeProject?.last_status_at]);
  const activeProjectTicketAddress = useMemo(() => {
    const address = (activeProject?.customer_address ?? "").trim();
    if (address) return address;
    const fallback = [(activeProject?.customer_name ?? "").trim(), (activeProject?.name ?? "").trim()]
      .filter((part) => part.length > 0)
      .join(", ");
    return fallback || "-";
  }, [activeProject?.customer_address, activeProject?.customer_name, activeProject?.name]);
  const userInitials = useMemo(() => initialsFromName(user?.full_name ?? "", "U"), [user?.full_name]);
  const todayIso = useMemo(() => formatDateISOLocal(now), [now]);
  const timeTargetUser = useMemo(
    () => assignableUsers.find((entry) => String(entry.id) === timeTargetUserId) ?? null,
    [assignableUsers, timeTargetUserId],
  );
  const requiredDailyHours = timeCurrent?.required_daily_hours ?? user?.required_daily_hours ?? 8;
  const dailyNetHours = timeCurrent?.daily_net_hours ?? 0;
  const gaugeNetHours = dailyNetHours;
  const monthWeekDefs = useMemo(
    () => monthWeekRanges(timeMonthCursor),
    [timeMonthCursor.getFullYear(), timeMonthCursor.getMonth()],
  );
  const monthCursorLabel = useMemo(
    () =>
      timeMonthCursor.toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
        month: "long",
        year: "numeric",
      }),
    [timeMonthCursor, language],
  );
  const monthlyWorkedHours = useMemo(
    () => Number(timeMonthRows.reduce((sum, row) => sum + row.workedHours, 0).toFixed(2)),
    [timeMonthRows],
  );
  const monthlyRequiredHours = useMemo(() => {
    const required = requiredDailyHours > 0 ? requiredDailyHours : 8;
    const monthStart = new Date(timeMonthCursor.getFullYear(), timeMonthCursor.getMonth(), 1, 12, 0, 0, 0);
    const monthEnd = new Date(
      timeMonthCursor.getFullYear(),
      timeMonthCursor.getMonth(),
      daysInMonth(timeMonthCursor.getFullYear(), timeMonthCursor.getMonth()),
      12,
      0,
      0,
      0,
    );
    const weekdays = weekdaysBetweenIso(formatDateISOLocal(monthStart), formatDateISOLocal(monthEnd));
    return Number((weekdays * required).toFixed(2));
  }, [requiredDailyHours, timeMonthCursor]);
  const viewingOwnTime = !isTimeManager || !timeTargetUserId || Number(timeTargetUserId) === user?.id;
  const pendingVacationRequests = useMemo(
    () => vacationRequests.filter((row) => row.status === "pending"),
    [vacationRequests],
  );
  const approvedVacationRequests = useMemo(
    () => vacationRequests.filter((row) => row.status === "approved"),
    [vacationRequests],
  );
  const sidebarNowLabel = useMemo(
    () =>
      now.toLocaleString(language === "de" ? "de-DE" : "en-US", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    [language, now],
  );
  const avatarStageState = useMemo(
    () => avatarStageMetrics(avatarNaturalSize, avatarStageSize, avatarZoom, avatarOffsetX, avatarOffsetY),
    [avatarNaturalSize, avatarStageSize, avatarZoom, avatarOffsetX, avatarOffsetY],
  );
  const firmwareBuild = useMemo(() => {
    const build = String(import.meta.env.VITE_APP_BUILD ?? "").trim();
    if (build) return build;
    const mode = String(import.meta.env.MODE ?? "").trim();
    return mode ? `local-${mode}` : "local";
  }, []);

  useEffect(() => {
    if (assignableUsers.length === 0) return;
    setRequiredHoursDrafts((current) => {
      const next: Record<number, string> = { ...current };
      assignableUsers.forEach((entry) => {
        if (next[entry.id] === undefined) {
          next[entry.id] = String(entry.required_daily_hours ?? 8);
        }
      });
      return next;
    });
  }, [assignableUsers]);

  useEffect(() => {
    localStorage.setItem("smpl_language", language);
  }, [language]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (overviewStatusFilter === "all") return;
    if (overviewStatusOptions.includes(overviewStatusFilter)) return;
    setOverviewStatusFilter("all");
  }, [overviewStatusFilter, overviewStatusOptions]);

  useEffect(() => {
    if (projectsAllStateFilter === "all") return;
    if (overviewStatusOptions.includes(projectsAllStateFilter)) return;
    setProjectsAllStateFilter("all");
  }, [projectsAllStateFilter, overviewStatusOptions]);

  useEffect(() => {
    if (!preUserMenuOpen) return;
    const onPointerOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !preUserMenuRef.current) return;
      if (!preUserMenuRef.current.contains(target)) setPreUserMenuOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerOutside);
    document.addEventListener("touchstart", onPointerOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerOutside);
      document.removeEventListener("touchstart", onPointerOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [preUserMenuOpen]);

  useEffect(() => {
    if (!timeInfoOpen) return;
    const onPointerOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !timeInfoRef.current) return;
      if (!timeInfoRef.current.contains(target)) setTimeInfoOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTimeInfoOpen(false);
    };
    document.addEventListener("mousedown", onPointerOutside);
    document.addEventListener("touchstart", onPointerOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerOutside);
      document.removeEventListener("touchstart", onPointerOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [timeInfoOpen]);

  useEffect(() => {
    if (adminUserMenuOpenId === null) return;
    const onPointerOutside = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".admin-actions-menu-wrap")) return;
      setAdminUserMenuOpenId(null);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAdminUserMenuOpenId(null);
    };
    document.addEventListener("mousedown", onPointerOutside);
    document.addEventListener("touchstart", onPointerOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onPointerOutside);
      document.removeEventListener("touchstart", onPointerOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [adminUserMenuOpenId]);

  useEffect(() => {
    if (mainView !== "time" && timeInfoOpen) setTimeInfoOpen(false);
  }, [mainView, timeInfoOpen]);

  useEffect(() => {
    if (user?.avatar_updated_at) setAvatarVersionKey(user.avatar_updated_at);
  }, [user?.id, user?.avatar_updated_at]);

  useEffect(() => {
    if (!user) return;
    setProfileSettingsForm({
      full_name: user.full_name ?? "",
      email: user.email ?? "",
      current_password: "",
      new_password: "",
    });
  }, [user?.id, user?.full_name, user?.email]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (avatarObjectUrlRef.current) {
        URL.revokeObjectURL(avatarObjectUrlRef.current);
      }
      if (threadIconObjectUrlRef.current) {
        URL.revokeObjectURL(threadIconObjectUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!avatarSourceUrl) {
      setAvatarPreviewDataUrl("");
      return;
    }
    let canceled = false;
    buildAvatarCropDataUrl(avatarSourceUrl, avatarZoom, avatarOffsetX, avatarOffsetY)
      .then((dataUrl) => {
        if (!canceled) setAvatarPreviewDataUrl(dataUrl);
      })
      .catch(() => {
        if (!canceled) setAvatarPreviewDataUrl("");
      });
    return () => {
      canceled = true;
    };
  }, [avatarSourceUrl, avatarZoom, avatarOffsetX, avatarOffsetY]);

  useEffect(() => {
    if (!avatarSourceUrl) {
      setAvatarNaturalSize(null);
      return;
    }
    let canceled = false;
    loadImage(avatarSourceUrl)
      .then((img) => {
        if (canceled) return;
        setAvatarNaturalSize({
          width: img.naturalWidth || img.width,
          height: img.naturalHeight || img.height,
        });
      })
      .catch(() => {
        if (!canceled) setAvatarNaturalSize(null);
      });
    return () => {
      canceled = true;
    };
  }, [avatarSourceUrl]);

  useEffect(() => {
    if (!avatarModalOpen || !avatarSourceUrl) return;
    const node = avatarCropStageRef.current;
    if (!node) return;
    const syncSize = () => setAvatarStageSize(node.clientWidth || 260);
    syncSize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, [avatarModalOpen, avatarSourceUrl]);

  useEffect(() => {
    if (!token) {
      setUser(null);
      return;
    }
    apiFetch<User>("/auth/me", token)
      .then((u) => setUser(u))
      .catch(() => {
        setToken(null);
        localStorage.removeItem("smpl_token");
      });
  }, [token]);

  useEffect(() => {
    if (!token || !user) return;
    void loadBaseData();
  }, [token, user]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "project") return;
    if (!activeProjectId) return;

    if (projectTab === "tasks") void loadTasks(taskView, activeProjectId);
    if (projectTab === "tickets") void loadSitesAndTickets(activeProjectId);
    if (projectTab === "files") {
      void loadFiles(activeProjectId);
      void loadProjectFolders(activeProjectId);
    }
  }, [mainView, projectTab, activeProjectId, token, user, taskView]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "planning") return;
    void loadPlanningWeek(null, planningWeekStart);
  }, [mainView, token, user, planningWeekStart]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "construction") return;
    const targetProjectId = Number(reportProjectId);
    void loadConstructionReportFiles(targetProjectId > 0 ? targetProjectId : null);
  }, [mainView, token, user, reportProjectId]);

  useEffect(() => {
    if (!reportProjectId) return;
    const isValid = projects.some((project) => String(project.id) === reportProjectId);
    if (isValid) return;
    setReportProjectId("");
    setReportDraft({ ...EMPTY_REPORT_DRAFT });
  }, [projects, reportProjectId]);

  useEffect(() => {
    if (mainView !== "construction" || !reportTaskPrefill) return;
    const form = constructionFormRef.current;
    if (!form) return;
    const reportDateInput = form.elements.namedItem("report_date") as HTMLInputElement | null;
    const workDoneInput = form.elements.namedItem("work_done") as HTMLTextAreaElement | null;
    const incidentsInput = form.elements.namedItem("incidents") as HTMLTextAreaElement | null;
    const materialsInput = form.elements.namedItem("materials") as HTMLTextAreaElement | null;
    if (reportDateInput) reportDateInput.value = reportTaskPrefill.report_date;
    if (workDoneInput) workDoneInput.value = reportTaskPrefill.work_done;
    if (incidentsInput) incidentsInput.value = reportTaskPrefill.incidents;
    if (materialsInput) materialsInput.value = reportTaskPrefill.materials;
    setReportTaskPrefill(null);
  }, [mainView, reportTaskPrefill]);

  useEffect(() => {
    setProjectTaskForm(buildEmptyProjectTaskFormState());
  }, [activeProjectId]);

  useEffect(() => {
    if (expandedMyTaskId === null) return;
    if (tasks.some((task) => task.id === expandedMyTaskId)) return;
    setExpandedMyTaskId(null);
  }, [tasks, expandedMyTaskId]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "overview" && mainView !== "my_tasks") return;
    void loadTasks("my", null);
  }, [mainView, token, user]);

  useEffect(() => {
    if (mainView === "my_tasks" || mainView === "planning") {
      setHasTaskNotifications(false);
    }
  }, [mainView]);

  useEffect(() => {
    if (!token || !user) {
      taskNotificationSnapshotRef.current = "";
      return;
    }
    let canceled = false;
    const pollMyTaskChanges = async () => {
      try {
        const taskRows = await apiFetch<Task[]>("/tasks?view=my", token);
        if (canceled) return;
        const nextDigest = taskNotificationDigest(taskRows);
        const currentDigest = taskNotificationSnapshotRef.current;
        if (currentDigest && currentDigest !== nextDigest && mainView !== "my_tasks" && mainView !== "planning") {
          setHasTaskNotifications(true);
        }
        taskNotificationSnapshotRef.current = nextDigest;
      } catch {
        // keep UX silent for background indicator polling
      }
    };
    void pollMyTaskChanges();
    const interval = window.setInterval(() => {
      void pollMyTaskChanges();
    }, 10000);
    return () => {
      canceled = true;
      window.clearInterval(interval);
    };
  }, [token, user, mainView]);

  useEffect(() => {
    if (!token || !user) return;
    if (mainView !== "wiki") return;
    void loadWikiLibraryFiles();
  }, [mainView, token, user]);

  useEffect(() => {
    if (!wikiFiles.length) {
      setActiveWikiPath(null);
      return;
    }
    if (activeWikiPath && wikiFiles.some((entry) => entry.path === activeWikiPath)) return;
    const preferred =
      wikiFiles.find((entry) => entry.extension === "html" || entry.extension === "htm") ||
      wikiFiles.find((entry) => entry.extension === "pdf") ||
      wikiFiles.find((entry) => entry.previewable) ||
      wikiFiles[0];
    setActiveWikiPath(preferred?.path ?? null);
  }, [wikiFiles, activeWikiPath]);

  useEffect(() => {
    if (!token || !user) return;
    void loadThreads();
    const poll = window.setInterval(() => {
      void loadThreads();
    }, mainView === "messages" ? 4000 : 12000);
    return () => window.clearInterval(poll);
  }, [token, user, mainView, activeThreadId]);

  useEffect(() => {
    if (!token || mainView !== "messages" || !activeThreadId) return;
    void loadMessages(activeThreadId);
    const poll = window.setInterval(() => {
      void loadMessages(activeThreadId);
    }, 4000);
    return () => window.clearInterval(poll);
  }, [token, mainView, activeThreadId]);

  useEffect(() => {
    if (mainView !== "messages" || !activeThreadId) return;
    shouldFollowMessagesRef.current = true;
    forceScrollToBottomRef.current = true;
  }, [mainView, activeThreadId]);

  useEffect(() => {
    if (mainView !== "messages" || !activeThreadId) return;
    if (!forceScrollToBottomRef.current && !shouldFollowMessagesRef.current) return;
    const raf = window.requestAnimationFrame(() => {
      scrollMessageListToBottom();
      forceScrollToBottomRef.current = false;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [messages, mainView, activeThreadId]);

  useEffect(() => {
    if (!token || (mainView !== "time" && mainView !== "overview")) return;
    void refreshTimeData();
    const poll = window.setInterval(() => {
      void refreshTimeData();
    }, 5000);
    return () => window.clearInterval(poll);
  }, [token, mainView, timeTargetUserId, isTimeManager, monthWeekDefs]);

  async function loadBaseData() {
    try {
      const [projectData, projectOverview] = await Promise.all([
        apiFetch<Project[]>("/projects", token),
        apiFetch<any[]>("/projects-overview", token),
      ]);
      setProjects(projectData);
      setOverview(projectOverview);
      if (projectData.length > 0) {
        const hasActive = activeProjectId ? projectData.some((project) => project.id === activeProjectId) : false;
        if (!hasActive) setActiveProjectId(projectData[0].id);
      }
      setReportProjectId((current) => {
        if (current && projectData.some((project) => String(project.id) === current)) return current;
        return "";
      });
      try {
        const assignables = await apiFetch<AssignableUser[]>("/users/assignable", token);
        setAssignableUsers(assignables);
      } catch {
        setAssignableUsers([]);
      }
      if (isAdmin) {
        const userData = await apiFetch<User[]>("/admin/users", token);
        setUsers(userData);
      }
      if (mainView === "project" && activeProjectId) {
        if (projectTab === "tasks") await loadTasks(taskView, activeProjectId);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to load data");
    }
  }

  async function loadTasks(mode: "my" | "all_open", projectId: number | null) {
    const projectQuery = projectId ? `&project_id=${projectId}` : "";
    try {
      const taskData = await apiFetch<Task[]>(`/tasks?view=${mode}${projectQuery}`, token);
      setTasks(taskData);
    } catch (err: any) {
      setError(err.message ?? "Failed to load tasks");
    }
  }

  async function loadPlanningWeek(projectId: number | null, weekStart: string) {
    const query = projectId ? `?project_id=${projectId}` : "";
    try {
      const week = await apiFetch<PlanningWeek>(`/planning/week/${weekStart}${query}`, token);
      setPlanningWeek(week);
    } catch (err: any) {
      setError(err.message ?? "Failed to load weekly planning");
    }
  }

  async function loadSitesAndTickets(projectId: number) {
    try {
      const ticketData = await apiFetch<Ticket[]>(`/projects/${projectId}/job-tickets`, token);
      setTickets(ticketData);
    } catch (err: any) {
      setError(err.message ?? "Failed to load tickets");
    }
  }

  async function loadFiles(projectId: number) {
    try {
      setFiles(await apiFetch<ProjectFile[]>(`/projects/${projectId}/files`, token));
    } catch (err: any) {
      setError(err.message ?? "Failed to load files");
    }
  }

  async function loadProjectFolders(projectId: number) {
    try {
      const rows = await apiFetch<ProjectFolder[]>(`/projects/${projectId}/folders`, token);
      setProjectFolders(rows);
      setFileUploadFolder((current) => {
        if (current && rows.some((folder) => folder.path === current)) return current;
        const fallback = rows.find((folder) => canUseProtectedFolders || !folder.is_protected);
        return fallback?.path ?? "";
      });
    } catch (err: any) {
      setProjectFolders([]);
      setError(err.message ?? "Failed to load project folders");
    }
  }

  async function loadConstructionReportFiles(projectId: number | null) {
    const query = projectId ? `?project_id=${projectId}` : "";
    try {
      setFiles(await apiFetch<ProjectFile[]>(`/construction-reports/files${query}`, token));
    } catch (err: any) {
      setError(err.message ?? "Failed to load report files");
    }
  }

  async function loadWikiLibraryFiles(search?: string) {
    try {
      const query = search && search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "";
      const files = await apiFetch<WikiLibraryFile[]>(`/wiki/library/files${query}`, token);
      setWikiFiles(files);
    } catch (err: any) {
      setError(err.message ?? "Failed to load wiki files");
    }
  }

  async function loadThreads() {
    try {
      const data = await apiFetch<Thread[]>("/threads", token);
      setThreads(data);
      if (data.length > 0 && !data.some((x) => x.id === activeThreadId)) {
        setActiveThreadId(data[0].id);
      }
      if (data.length === 0) setActiveThreadId(null);
    } catch (err: any) {
      if (err?.status === 403 && mainView !== "messages") return;
      setError(err.message ?? "Failed to load threads");
    }
  }

  async function loadMessages(threadId: number) {
    try {
      setMessages(await apiFetch<Message[]>(`/threads/${threadId}/messages`, token));
    } catch (err: any) {
      setError(err.message ?? "Failed to load messages");
    }
  }

  async function refreshTimeData() {
    try {
      const useManagerFilter = mainView === "time" && isTimeManager && timeTargetUserId;
      const userQuery = useManagerFilter ? `&user_id=${Number(timeTargetUserId)}` : "";
      const currentQuery = useManagerFilter ? `?user_id=${Number(timeTargetUserId)}` : "";
      const vacationQuery = useManagerFilter ? `?user_id=${Number(timeTargetUserId)}` : "";
      const schoolQuery = useManagerFilter ? `?user_id=${Number(timeTargetUserId)}` : "";
      const timesheetRequests =
        mainView === "time"
          ? monthWeekDefs.map((row) =>
              apiFetch<TimesheetSummary>(`/time/timesheet?period=weekly&day=${row.weekStart}${userQuery}`, token),
            )
          : [];
      const [current, entries, vacationRows, schoolRows, ...timesheetRows] = await Promise.all([
        apiFetch<TimeCurrent>(`/time/current${currentQuery}`, token),
        apiFetch<TimeEntry[]>(`/time/entries?period=weekly${userQuery}`, token),
        apiFetch<VacationRequest[]>(`/time/vacation-requests${vacationQuery}`, token),
        apiFetch<SchoolAbsence[]>(`/time/school-absences${schoolQuery}`, token),
        ...timesheetRequests,
      ]);
      setTimeCurrent(current);
      setTimeEntries(entries);
      setVacationRequests(vacationRows);
      setSchoolAbsences(schoolRows);
      if (mainView === "time") {
        const requiredHours = current.required_daily_hours > 0 ? current.required_daily_hours : 8;
        const rows = monthWeekDefs.map((row, index) => {
          const timesheet = timesheetRows[index] as TimesheetSummary | undefined;
          const workedHours = Number(timesheet?.total_hours ?? 0);
          return {
            ...row,
            workedHours: Number(workedHours.toFixed(2)),
            requiredHours: Number((row.weekdaysInWeek * requiredHours).toFixed(2)),
          };
        });
        setTimeMonthRows(rows);
      } else {
        setTimeMonthRows([]);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to load time data");
    }
  }

  async function onLogin(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    try {
      try {
        const stale = localStorage.getItem("smpl_token");
        if (stale && !isLikelyJwtToken(stale)) localStorage.removeItem("smpl_token");
      } catch {
        // no-op
      }

      const body = JSON.stringify({ email: email.trim(), password });
      const requestInit: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        credentials: "include",
      };

      let response: Response;
      try {
        response = await fetch("/api/auth/login", requestInit);
      } catch (innerErr: any) {
        const message = String(innerErr?.message ?? "");
        if (message.toLowerCase().includes("expected pattern")) {
          const absoluteLoginUrl = `${window.location.protocol}//${window.location.host}/api/auth/login`;
          response = await fetch(absoluteLoginUrl, requestInit);
        } else {
          throw innerErr;
        }
      }
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail ?? "Login failed");
      }
      const newToken = response.headers.get("X-Access-Token");
      if (!newToken) throw new Error("No access token returned");
      const cleanToken = newToken.trim();
      if (!isLikelyJwtToken(cleanToken)) {
        throw new Error(
          language === "de" ? "Ungültiges Token vom Server empfangen" : "Received invalid token from server",
        );
      }
      setToken(cleanToken);
      localStorage.setItem("smpl_token", cleanToken);
      const me = (await response.json()) as User;
      setUser(me);
    } catch (err: any) {
      const message = String(err?.message ?? "");
      if (message.toLowerCase().includes("expected pattern")) {
        setError(
          language === "de"
            ? "Anmeldung fehlgeschlagen (Browser-URL-Fehler). Bitte Seite neu laden und erneut versuchen."
            : "Login failed (browser URL pattern error). Please reload and try again.",
        );
      } else {
        setError(message || "Login failed");
      }
    }
  }

  function resetPublicAuthRoute() {
    setPublicAuthMode(null);
    setPublicToken("");
    setPublicFullName("");
    setPublicEmail("");
    setPublicNewPassword("");
    setPublicConfirmPassword("");
    if (window.location.pathname !== "/") {
      window.history.replaceState({}, "", "/");
    }
  }

  async function submitPublicInviteAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publicToken) {
      setError(language === "de" ? "Einladungstoken fehlt." : "Invite token is missing.");
      return;
    }
    if (publicNewPassword.length < 8) {
      setError(language === "de" ? "Passwort muss mindestens 8 Zeichen haben." : "Password must be at least 8 characters.");
      return;
    }
    if (publicNewPassword !== publicConfirmPassword) {
      setError(language === "de" ? "Passwörter stimmen nicht überein." : "Passwords do not match.");
      return;
    }
    try {
      const accepted = await apiFetch<User>("/auth/invites/accept", null, {
        method: "POST",
        body: JSON.stringify({
          token: publicToken,
          new_password: publicNewPassword,
          full_name: publicFullName.trim() || null,
          email: publicEmail.trim() || null,
        }),
      });
      setEmail(accepted.email);
      setPassword("");
      resetPublicAuthRoute();
      setNotice(language === "de" ? "Einladung akzeptiert. Bitte anmelden." : "Invite accepted. Please sign in.");
    } catch (err: any) {
      setError(err.message ?? "Failed to accept invite");
    }
  }

  async function submitPublicPasswordReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publicToken) {
      setError(language === "de" ? "Reset-Token fehlt." : "Reset token is missing.");
      return;
    }
    if (publicNewPassword.length < 8) {
      setError(language === "de" ? "Passwort muss mindestens 8 Zeichen haben." : "Password must be at least 8 characters.");
      return;
    }
    if (publicNewPassword !== publicConfirmPassword) {
      setError(language === "de" ? "Passwörter stimmen nicht überein." : "Passwords do not match.");
      return;
    }
    try {
      await apiFetch("/auth/password-reset/confirm", null, {
        method: "POST",
        body: JSON.stringify({
          token: publicToken,
          new_password: publicNewPassword,
        }),
      });
      resetPublicAuthRoute();
      setNotice(language === "de" ? "Passwort aktualisiert. Bitte anmelden." : "Password updated. Please sign in.");
    } catch (err: any) {
      setError(err.message ?? "Failed to reset password");
    }
  }

  function openCreateProjectModal() {
    setProjectForm(EMPTY_PROJECT_FORM);
    setProjectModalMode("create");
  }

  function openEditProjectModal(project: Project) {
    setProjectForm({
      project_number: project.project_number ?? "",
      name: project.name ?? "",
      description: project.description ?? "",
      status: project.status ?? "active",
      last_state:
        project.last_state ??
        (typeof project.extra_attributes?.Notiz === "string" ? project.extra_attributes.Notiz : ""),
      last_status_at: isoToLocalDateTimeInput(project.last_status_at),
      customer_name: project.customer_name ?? "",
      customer_address: project.customer_address ?? "",
      customer_contact: project.customer_contact ?? "",
      customer_email: project.customer_email ?? "",
      customer_phone: project.customer_phone ?? "",
    });
    setProjectModalMode("edit");
  }

  function closeProjectModal() {
    setProjectModalMode(null);
  }

  function getTaskAssigneeIds(task: Task): number[] {
    if (Array.isArray(task.assignee_ids) && task.assignee_ids.length > 0) return task.assignee_ids;
    if (task.assignee_id) return [task.assignee_id];
    return [];
  }

  function isTaskAssignedToCurrentUser(task: Task): boolean {
    if (!user) return false;
    return getTaskAssigneeIds(task).includes(user.id);
  }

  function getTaskAssigneeLabel(task: Task): string {
    const ids = getTaskAssigneeIds(task);
    if (ids.length === 0) return "-";
    return ids
      .map((id) => assignableUsers.find((userEntry) => userEntry.id === id)?.full_name ?? `#${id}`)
      .join(", ");
  }

  function projectSearchLabel(project: Project): string {
    const customer = (project.customer_name ?? "").trim();
    const customerPrefix = customer ? `${customer} | ` : "";
    return `${customerPrefix}${project.project_number} - ${project.name}`;
  }

  async function exportTaskCalendar(task: Task) {
    const taskAssignees = getTaskAssigneeIds(task);
    if (!taskAssignees.includes(user.id)) {
      setError(language === "de" ? "Nur zugewiesene Mitarbeiter können den Termin exportieren" : "Only assigned users can export this task");
      return;
    }

    const project = projectsById.get(task.project_id);
    const dueDateIso = task.due_date || formatDateISOLocal(new Date());
    const startTime = formatTaskStartTime(task.start_time || "") || "";
    const dtStamp = toIcsUtcDateTime(new Date());
    const uid = `task-${task.id}-${Date.now()}@smpl.local`;

    let eventDateLines = "";
    if (startTime) {
      const startAt = new Date(`${dueDateIso}T${startTime}:00`);
      const endAt = new Date(startAt.getTime() + 60 * 60 * 1000);
      eventDateLines = `DTSTART:${toIcsUtcDateTime(startAt)}\r\nDTEND:${toIcsUtcDateTime(endAt)}`;
    } else {
      const startDay = new Date(`${dueDateIso}T00:00:00`);
      const endDay = new Date(startDay);
      endDay.setDate(endDay.getDate() + 1);
      eventDateLines = `DTSTART;VALUE=DATE:${toIcsDate(startDay)}\r\nDTEND;VALUE=DATE:${toIcsDate(endDay)}`;
    }

    const summaryBase = project ? `${project.project_number} - ${task.title}` : task.title;
    const lines: string[] = [
      `Task ID: #${task.id}`,
      `Status: ${task.status}`,
      project ? `Project: ${project.project_number} - ${project.name}` : `Project ID: ${task.project_id}`,
      project?.customer_name ? `Customer: ${project.customer_name}` : "",
      `Due: ${task.due_date ?? "-"}`,
      startTime ? `Start: ${startTime}` : "",
      task.description ? `Info: ${task.description}` : "",
      task.materials_required ? `Materials: ${task.materials_required}` : "",
      task.storage_box_number ? `Storage box: ${task.storage_box_number}` : "",
      `Assignees: ${getTaskAssigneeLabel(task)}`,
    ].filter((line) => line.length > 0);

    const location = (project?.customer_address ?? "").trim();
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//SMPL//Workflow//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${dtStamp}`,
      eventDateLines,
      `SUMMARY:${escapeIcs(summaryBase)}`,
      `DESCRIPTION:${escapeIcs(lines.join("\n"))}`,
      location ? `LOCATION:${escapeIcs(location)}` : "",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter((line) => line.length > 0)
      .join("\r\n");

    const fileNameSource = `${project?.project_number ?? "task"}-${task.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${fileNameSource}.ics`;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setNotice(language === "de" ? "Kalenderdatei exportiert" : "Calendar file exported");
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function userNameById(userId: number): string {
    if (userId === user.id) return language === "de" ? "Ich" : "Me";
    return (
      assignableUsersById.get(userId)?.full_name ??
      adminUsersById.get(userId)?.full_name ??
      `#${userId}`
    );
  }

  function userInitialsById(userId: number) {
    if (userId === user.id) return userInitials;
    return initialsFromName(userNameById(userId), "U");
  }

  function userAvatarVersionById(userId: number) {
    if (userId === user.id) return user.avatar_updated_at || avatarVersionKey;
    return (
      assignableUsersById.get(userId)?.avatar_updated_at ||
      adminUsersById.get(userId)?.avatar_updated_at ||
      "0"
    );
  }

  function userHasAvatar(userId: number) {
    if (userId === user.id) return Boolean(user.avatar_updated_at);
    return Boolean(assignableUsersById.get(userId)?.avatar_updated_at || adminUsersById.get(userId)?.avatar_updated_at);
  }

  function openTaskModal(defaults?: { projectId?: number | null; dueDate?: string }) {
    const fallbackProjectId = defaults?.projectId ?? activeProjectId ?? projects[0]?.id ?? null;
    const fallbackDueDate = defaults?.dueDate ?? planningWeekStart;
    const fallbackProject = projects.find((project) => project.id === fallbackProjectId) ?? null;
    setTaskModalForm(
      buildTaskModalFormState({
        projectId: fallbackProjectId,
        dueDate: fallbackDueDate,
        projectQuery: fallbackProject ? projectSearchLabel(fallbackProject) : "",
      }),
    );
    setTaskModalOpen(true);
  }

  function closeTaskModal() {
    setTaskModalOpen(false);
  }

  function updateTaskModalField<K extends keyof TaskModalState>(field: K, value: TaskModalState[K]) {
    setTaskModalForm((current) => ({ ...current, [field]: value }));
  }

  function addTaskModalAssignee(assigneeId: number) {
    setTaskModalForm((current) => {
      if (current.assignee_ids.includes(assigneeId)) {
        return { ...current, assignee_query: "" };
      }
      return {
        ...current,
        assignee_ids: [...current.assignee_ids, assigneeId],
        assignee_query: "",
      };
    });
  }

  function removeTaskModalAssignee(assigneeId: number) {
    setTaskModalForm((current) => ({
      ...current,
      assignee_ids: current.assignee_ids.filter((id) => id !== assigneeId),
    }));
  }

  function addFirstMatchingTaskModalAssignee() {
    const first = taskModalAssigneeSuggestions[0];
    if (!first) return;
    addTaskModalAssignee(first.id);
  }

  function openTaskEditModal(task: Task) {
    setTaskEditForm(buildTaskEditFormState(task));
    setTaskEditModalOpen(true);
  }

  function closeTaskEditModal() {
    setTaskEditModalOpen(false);
    setTaskEditForm(buildTaskEditFormState());
  }

  function updateTaskEditField<K extends keyof TaskEditFormState>(field: K, value: TaskEditFormState[K]) {
    setTaskEditForm((current) => ({ ...current, [field]: value }));
  }

  function addTaskEditAssignee(assigneeId: number) {
    setTaskEditForm((current) => {
      if (current.assignee_ids.includes(assigneeId)) {
        return { ...current, assignee_query: "" };
      }
      return {
        ...current,
        assignee_ids: [...current.assignee_ids, assigneeId],
        assignee_query: "",
      };
    });
  }

  function removeTaskEditAssignee(assigneeId: number) {
    setTaskEditForm((current) => ({
      ...current,
      assignee_ids: current.assignee_ids.filter((id) => id !== assigneeId),
    }));
  }

  function addFirstMatchingTaskEditAssignee() {
    const first = taskEditAssigneeSuggestions[0];
    if (!first) return;
    addTaskEditAssignee(first.id);
  }

  function selectTaskModalProject(project: Project) {
    setTaskModalForm((current) => ({
      ...current,
      project_id: String(project.id),
      project_query: projectSearchLabel(project),
      create_project_from_task: false,
      new_project_name: "",
      new_project_number: "",
    }));
  }

  function updateProjectFormField(field: keyof ProjectFormState, value: string) {
    setProjectForm((current) => ({ ...current, [field]: value }));
  }

  function validateTimeInputOrSetError(value: string, required: boolean): string | null {
    const normalized = normalizeTimeHHMM(value);
    if (!normalized) {
      if (required) {
        setError(language === "de" ? "Startzeit ist erforderlich" : "Start time is required");
      }
      return null;
    }
    if (!isValidTimeHHMM(normalized)) {
      setError(language === "de" ? "Bitte Zeit im Format HH:MM eingeben" : "Please use time format HH:MM");
      return null;
    }
    return normalized;
  }

  function updateProjectTaskFormField<K extends keyof ProjectTaskFormState>(
    field: K,
    value: ProjectTaskFormState[K],
  ) {
    setProjectTaskForm((current) => ({ ...current, [field]: value }));
  }

  function addProjectTaskAssignee(assigneeId: number) {
    setProjectTaskForm((current) => {
      if (current.assignee_ids.includes(assigneeId)) {
        return { ...current, assignee_query: "" };
      }
      return {
        ...current,
        assignee_ids: [...current.assignee_ids, assigneeId],
        assignee_query: "",
      };
    });
  }

  function removeProjectTaskAssignee(assigneeId: number) {
    setProjectTaskForm((current) => ({
      ...current,
      assignee_ids: current.assignee_ids.filter((id) => id !== assigneeId),
    }));
  }

  function addFirstMatchingProjectTaskAssignee() {
    const first = projectTaskAssigneeSuggestions[0];
    if (!first) return;
    addProjectTaskAssignee(first.id);
  }

  async function submitProjectForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = {
      project_number: projectForm.project_number.trim(),
      name: projectForm.name.trim(),
      description: projectForm.description.trim(),
      status: projectForm.status.trim() || "active",
      last_state: projectForm.last_state.trim() || null,
      last_status_at: localDateTimeInputToIso(projectForm.last_status_at),
      customer_name: projectForm.customer_name.trim(),
      customer_address: projectForm.customer_address.trim(),
      customer_contact: projectForm.customer_contact.trim(),
      customer_email: projectForm.customer_email.trim(),
      customer_phone: projectForm.customer_phone.trim(),
    };
    if (!payload.project_number || !payload.name) {
      setError(language === "de" ? "Projektnummer und Name sind erforderlich" : "Project number and name are required");
      return;
    }

    try {
      if (projectModalMode === "create") {
        const createdProject = await apiFetch<Project>("/projects", token, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setActiveProjectId(createdProject.id);
        setProjectBackView(null);
        setMainView("project");
        setProjectTab("tasks");
        setNotice(language === "de" ? "Projekt erstellt" : "Project created");
      } else if (projectModalMode === "edit" && activeProjectId) {
        await apiFetch<Project>(`/projects/${activeProjectId}`, token, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        setNotice(language === "de" ? "Projekt aktualisiert" : "Project updated");
      }

      closeProjectModal();
      await loadBaseData();
    } catch (err: any) {
      setError(err.message ?? "Failed to save project");
    }
  }

  async function archiveActiveProject() {
    if (!activeProjectId) return;
    try {
      await apiFetch<Project>(`/projects/${activeProjectId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: "archived" }),
      });
      setNotice(language === "de" ? "Projekt archiviert" : "Project archived");
      closeProjectModal();
      await loadBaseData();
    } catch (err: any) {
      setError(err.message ?? "Failed to archive project");
    }
  }

  async function deleteActiveProject() {
    if (!activeProjectId) return;
    const confirmed = window.confirm(
      language === "de"
        ? "Projekt wirklich dauerhaft löschen? Diese Aktion kann nicht rückgängig gemacht werden."
        : "Delete this project permanently? This action cannot be undone.",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/projects/${activeProjectId}`, token, { method: "DELETE" });
      setNotice(language === "de" ? "Projekt gelöscht" : "Project deleted");
      closeProjectModal();
      setActiveProjectId(null);
      setProjectBackView(null);
      setMainView("overview");
      await loadBaseData();
    } catch (err: any) {
      setError(err.message ?? "Failed to delete project");
    }
  }

  async function unarchiveProject(projectId: number) {
    if (!canCreateProject) return;
    try {
      await apiFetch<Project>(`/projects/${projectId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: "active" }),
      });
      setNotice(language === "de" ? "Projekt wiederhergestellt" : "Project restored");
      await loadBaseData();
    } catch (err: any) {
      setError(err.message ?? "Failed to restore project");
    }
  }

  async function deleteProjectById(projectId: number) {
    if (!canCreateProject) return;
    const confirmed = window.confirm(
      language === "de"
        ? "Projekt wirklich dauerhaft löschen? Diese Aktion kann nicht rückgängig gemacht werden."
        : "Delete this project permanently? This action cannot be undone.",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/projects/${projectId}`, token, { method: "DELETE" });
      setNotice(language === "de" ? "Projekt gelöscht" : "Project deleted");
      if (activeProjectId === projectId) {
        setActiveProjectId(null);
        setMainView("overview");
      }
      await loadBaseData();
    } catch (err: any) {
      setError(err.message ?? "Failed to delete project");
    }
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) return;
    if (!projectTaskForm.title.trim()) {
      setError(language === "de" ? "Aufgabentitel ist erforderlich" : "Task title is required");
      return;
    }
    const dueDate = projectTaskForm.due_date.trim() || null;
    const storageBoxNumber =
      projectTaskForm.has_storage_box && projectTaskForm.storage_box_number.trim()
        ? Number(projectTaskForm.storage_box_number)
        : null;
    if (
      storageBoxNumber !== null &&
      (!Number.isFinite(storageBoxNumber) || !Number.isInteger(storageBoxNumber) || storageBoxNumber <= 0)
    ) {
      setError(language === "de" ? "Bitte eine gültige Lagerbox-Nummer angeben" : "Please enter a valid storage box number");
      return;
    }
    const startTime =
      projectTaskForm.start_time.trim().length > 0
        ? validateTimeInputOrSetError(projectTaskForm.start_time, false)
        : null;
    if (projectTaskForm.start_time.trim().length > 0 && !startTime) return;
    try {
      await apiFetch("/tasks", token, {
        method: "POST",
        body: JSON.stringify({
          project_id: activeProjectId,
          title: projectTaskForm.title.trim(),
          description: projectTaskForm.description.trim() || null,
          materials_required: projectTaskForm.materials_required.trim() || null,
          storage_box_number: storageBoxNumber,
          status: "open",
          due_date: dueDate,
          start_time: startTime,
          assignee_ids: projectTaskForm.assignee_ids,
          week_start: dueDate ? normalizeWeekStartISO(dueDate) : null,
        }),
      });
      setProjectTaskForm(buildEmptyProjectTaskFormState());
      await loadTasks(taskView, activeProjectId);
      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart);
      }
      setOverview(await apiFetch<any[]>("/projects-overview", token));
      setNotice(language === "de" ? "Aufgabe gespeichert" : "Task saved");
    } catch (err: any) {
      setError(err.message ?? "Failed to create task");
    }
  }

  async function createWeeklyPlanTask() {
    if (!taskModalForm.title.trim()) {
      setError(language === "de" ? "Aufgabentitel ist erforderlich" : "Task title is required");
      return;
    }
    const dueDate = taskModalForm.due_date.trim() || null;
    const storageBoxNumber =
      taskModalForm.has_storage_box && taskModalForm.storage_box_number.trim()
        ? Number(taskModalForm.storage_box_number)
        : null;
    if (
      storageBoxNumber !== null &&
      (!Number.isFinite(storageBoxNumber) || !Number.isInteger(storageBoxNumber) || storageBoxNumber <= 0)
    ) {
      setError(language === "de" ? "Bitte eine gültige Lagerbox-Nummer angeben" : "Please enter a valid storage box number");
      return;
    }
    if (!dueDate) {
      setError(language === "de" ? "Fälligkeitsdatum ist erforderlich" : "Due date is required");
      return;
    }
    const startTime = validateTimeInputOrSetError(taskModalForm.start_time, true);
    if (!startTime) return;
    const targetWeekStart = normalizeWeekStartISO(dueDate);

    let projectId = Number(taskModalForm.project_id);
    try {
      if (!projectId && taskModalForm.create_project_from_task) {
        if (!canCreateProject) {
          setError(language === "de" ? "Keine Berechtigung zum Erstellen von Projekten" : "No permission to create projects");
          return;
        }
        const projectName = taskModalForm.new_project_name.trim() || taskModalForm.title.trim();
        if (!projectName) {
          setError(language === "de" ? "Projektname ist erforderlich" : "Project name is required");
          return;
        }
        const numberInput = taskModalForm.new_project_number.trim();
        const generatedProjectNumber = numberInput || `T${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now().toString().slice(-5)}`;
        const createdProject = await apiFetch<Project>("/projects", token, {
          method: "POST",
          body: JSON.stringify({
            project_number: generatedProjectNumber,
            name: projectName,
            description: taskModalForm.description.trim() || "",
            status: "active",
            last_state: null,
            last_status_at: null,
            customer_name: "",
            customer_address: "",
            customer_contact: "",
            customer_email: "",
            customer_phone: "",
          }),
        });
        projectId = createdProject.id;
      }

      if (!projectId) {
        setError(language === "de" ? "Projekt ist erforderlich" : "Project is required");
        return;
      }

      await apiFetch(`/planning/week/${targetWeekStart}`, token, {
        method: "POST",
        body: JSON.stringify([
          {
            project_id: projectId,
            title: taskModalForm.title.trim(),
            description: taskModalForm.description.trim() || null,
            materials_required: taskModalForm.materials_required.trim() || null,
            storage_box_number: storageBoxNumber,
            status: "open",
            assignee_ids: taskModalForm.assignee_ids,
            due_date: dueDate,
            start_time: startTime,
            week_start: targetWeekStart,
          },
        ]),
      });
      closeTaskModal();
      await loadBaseData();
      setPlanningWeekStart(targetWeekStart);
      await loadPlanningWeek(null, targetWeekStart);
      setNotice(
        language === "de"
          ? `Wochenaufgabe gespeichert (${formatDayLabel(dueDate, "de")})`
          : `Weekly task saved (${formatDayLabel(dueDate, "en")})`,
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to assign weekly plan");
    }
  }

  async function saveTaskEdit() {
    if (!taskEditForm.id) return;
    if (!taskEditForm.title.trim()) {
      setError(language === "de" ? "Aufgabentitel ist erforderlich" : "Task title is required");
      return;
    }
    const dueDate = taskEditForm.due_date.trim() || null;
    const storageBoxNumber =
      taskEditForm.has_storage_box && taskEditForm.storage_box_number.trim()
        ? Number(taskEditForm.storage_box_number)
        : null;
    if (
      storageBoxNumber !== null &&
      (!Number.isFinite(storageBoxNumber) || !Number.isInteger(storageBoxNumber) || storageBoxNumber <= 0)
    ) {
      setError(language === "de" ? "Bitte eine gültige Lagerbox-Nummer angeben" : "Please enter a valid storage box number");
      return;
    }

    const startTime =
      taskEditForm.start_time.trim().length > 0
        ? validateTimeInputOrSetError(taskEditForm.start_time, false)
        : null;
    if (taskEditForm.start_time.trim().length > 0 && !startTime) return;
    const weekStartValue = taskEditForm.week_start.trim() || (dueDate ? normalizeWeekStartISO(dueDate) : null);
    try {
      await apiFetch(`/tasks/${taskEditForm.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          title: taskEditForm.title.trim(),
          description: taskEditForm.description.trim() || null,
          materials_required: taskEditForm.materials_required.trim() || null,
          storage_box_number: storageBoxNumber,
          status: taskEditForm.status.trim() || "open",
          due_date: dueDate,
          start_time: startTime,
          assignee_ids: taskEditForm.assignee_ids,
          week_start: weekStartValue,
        }),
      });
      closeTaskEditModal();
      if (mainView === "project" && activeProjectId) {
        await loadTasks(taskView, activeProjectId);
      }
      if (mainView === "my_tasks" || mainView === "overview") {
        await loadTasks("my", null);
      }
      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart);
      }
      setOverview(await apiFetch<any[]>("/projects-overview", token));
      setNotice(language === "de" ? "Aufgabe aktualisiert" : "Task updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update task");
    }
  }

  function openConstructionReportFromTask(task: Task, sourceView: MainView | null = "my_tasks") {
    const project = projectsById.get(task.project_id) ?? null;
    const projectIdValue = project ? String(project.id) : "";
    const taskAssignees = getTaskAssigneeIds(task);
    const workerRows = taskAssignees
      .map((assigneeId) => {
        const fullName =
          assignableUsersById.get(assigneeId)?.full_name ?? adminUsersById.get(assigneeId)?.full_name ?? "";
        return fullName.trim();
      })
      .filter((name) => name.length > 0)
      .map((name) => ({ name, start_time: "", end_time: "" }));
    setReportWorkers(workerRows.length > 0 ? workerRows : [{ name: "", start_time: "", end_time: "" }]);

    applyReportProjectSelection(projectIdValue);
    setReportTaskPrefill({
      task_id: task.id,
      report_date: task.due_date || formatDateISOLocal(new Date()),
      work_done: [
        `${language === "de" ? "Aufgabe" : "Task"} #${task.id}: ${task.title}`,
        task.description
          ? `${language === "de" ? "Information" : "Information"}: ${task.description}`
          : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
      incidents:
        task.storage_box_number != null
          ? `${language === "de" ? "Lagerbox" : "Storage box"}: ${task.storage_box_number}`
          : "",
      materials: task.materials_required ?? "",
    });
    setOverviewShortcutBackVisible(false);
    setConstructionBackView(sourceView);
    setMainView("construction");
  }

  async function markTaskDone(
    taskId: number,
    options?: { openReportFromTask?: Task; reportBackView?: MainView | null },
  ) {
    try {
      await apiFetch(`/tasks/${taskId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status: "done" }),
      });
      if (mainView === "project" && activeProjectId) {
        await loadTasks(taskView, activeProjectId);
      }
      if (mainView === "my_tasks" || mainView === "overview") {
        await loadTasks("my", null);
      }
      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart);
      }
      if (options?.openReportFromTask) {
        openConstructionReportFromTask(
          { ...options.openReportFromTask, status: "done" },
          options.reportBackView ?? "my_tasks",
        );
      }
      setNotice(language === "de" ? "Aufgabe abgeschlossen" : "Task marked complete");
    } catch (err: any) {
      setError(err.message ?? "Failed to complete task");
    }
  }

  async function deleteTaskFromEdit() {
    if (!taskEditForm.id) return;
    const confirmed = window.confirm(
      language === "de"
        ? "Aufgabe wirklich löschen?"
        : "Delete this task permanently?",
    );
    if (!confirmed) return;
    try {
      await apiFetch(`/tasks/${taskEditForm.id}`, token, { method: "DELETE" });
      closeTaskEditModal();
      if (mainView === "project" && activeProjectId) {
        await loadTasks(taskView, activeProjectId);
      }
      if (mainView === "my_tasks" || mainView === "overview") {
        await loadTasks("my", null);
      }
      if (mainView === "planning") {
        await loadPlanningWeek(null, planningWeekStart);
      }
      setOverview(await apiFetch<any[]>("/projects-overview", token));
      setNotice(language === "de" ? "Aufgabe gelöscht" : "Task deleted");
    } catch (err: any) {
      setError(err.message ?? "Failed to delete task");
    }
  }

  function openProjectFromTask(task: Task) {
    setMyTasksBackProjectId(null);
    setProjectBackView("my_tasks");
    setActiveProjectId(task.project_id);
    setTaskView("my");
    setProjectTab("tasks");
    setMainView("project");
  }

  function openTaskFromProject(task: Task) {
    if (!isTaskAssignedToCurrentUser(task)) return;
    setProjectBackView(null);
    setExpandedMyTaskId(task.id);
    setMyTasksBackProjectId(activeProjectId ?? task.project_id);
    setMainView("my_tasks");
  }

  function openTaskFromPlanning(task: Task) {
    if (!isTaskAssignedToCurrentUser(task)) return;
    setMyTasksBackProjectId(null);
    setExpandedMyTaskId(task.id);
    setMainView("my_tasks");
  }

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await apiFetch(`/projects/${activeProjectId}/job-tickets`, token, {
        method: "POST",
        body: JSON.stringify({
          site_id: null,
          title: String(form.get("title")),
          site_address: activeProjectTicketAddress,
          ticket_date: activeProjectTicketDate,
          assigned_crew: String(form.get("assigned_crew") || "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          checklist: [{ label: "Safety check", done: false }],
          notes: String(form.get("notes") || ""),
        }),
      });
      formElement.reset();
      await loadSitesAndTickets(activeProjectId);
    } catch (err: any) {
      setError(err.message ?? "Failed to create ticket");
    }
  }

  async function uploadTicketAttachment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const ticketId = Number(form.get("ticket_id"));
    if (!ticketId) return;
    try {
      await apiFetch(`/projects/${activeProjectId}/job-tickets/${ticketId}/attachments`, token, {
        method: "POST",
        body: form,
      });
      formElement.reset();
      setNotice(language === "de" ? "Anhang hochgeladen" : "Attachment uploaded");
    } catch (err: any) {
      setError(err.message ?? "Failed to upload ticket attachment");
    }
  }

  async function clockIn() {
    try {
      await apiFetch("/time/clock-in", token, { method: "POST" });
      await refreshTimeData();
    } catch (err: any) {
      setError(err.message ?? "Clock in failed");
    }
  }

  async function clockOut() {
    try {
      await apiFetch("/time/clock-out", token, { method: "POST" });
      await refreshTimeData();
    } catch (err: any) {
      setError(err.message ?? "Clock out failed");
    }
  }

  async function startBreak() {
    try {
      await apiFetch("/time/break-start", token, { method: "POST" });
      await refreshTimeData();
    } catch (err: any) {
      setError(err.message ?? "Break start failed");
    }
  }

  async function endBreak() {
    try {
      await apiFetch("/time/break-end", token, { method: "POST" });
      await refreshTimeData();
    } catch (err: any) {
      setError(err.message ?? "Break end failed");
    }
  }

  async function updateTimeEntry(event: FormEvent<HTMLFormElement>, entryId: number) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const clockInIso = localDateTimeInputToIso(String(form.get("clock_in") || ""));
    const clockOutIso = localDateTimeInputToIso(String(form.get("clock_out") || ""));
    const breakMinutes = Number(form.get("break_minutes") || 0);
    if (!clockInIso) return;
    try {
      await apiFetch(`/time/entries/${entryId}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          clock_in: clockInIso,
          clock_out: clockOutIso,
          break_minutes: breakMinutes,
        }),
      });
      await refreshTimeData();
      setNotice(language === "de" ? "Zeitbuchung aktualisiert" : "Time entry updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update time entry");
    }
  }

  function openCreateThreadModal() {
    setThreadModalForm({ name: "", project_id: "" });
    setThreadIconFile(null);
    setThreadIconPreviewUrl("");
    setThreadModalMode("create");
  }

  function openEditThreadModal(thread: Thread) {
    setThreadModalForm({ name: thread.name ?? "", project_id: thread.project_id ? String(thread.project_id) : "" });
    setThreadIconFile(null);
    setThreadIconPreviewUrl("");
    setThreadModalMode("edit");
  }

  function closeThreadModal() {
    setThreadModalMode(null);
    setThreadModalForm({ name: "", project_id: "" });
    setThreadIconFile(null);
    setThreadIconPreviewUrl("");
    if (threadIconObjectUrlRef.current) {
      URL.revokeObjectURL(threadIconObjectUrlRef.current);
      threadIconObjectUrlRef.current = null;
    }
  }

  function onThreadIconFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setThreadIconFile(null);
      setThreadIconPreviewUrl("");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setError(language === "de" ? "Bitte eine Bilddatei wählen." : "Please select an image file.");
      return;
    }
    if (threadIconObjectUrlRef.current) {
      URL.revokeObjectURL(threadIconObjectUrlRef.current);
    }
    const objectUrl = URL.createObjectURL(file);
    threadIconObjectUrlRef.current = objectUrl;
    setThreadIconFile(file);
    setThreadIconPreviewUrl(objectUrl);
  }

  async function submitThreadModal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = threadModalForm.name.trim();
    const selectedProjectId = threadModalForm.project_id ? Number(threadModalForm.project_id) : null;
    if (!name) {
      setError(language === "de" ? "Thread-Name ist erforderlich" : "Thread name is required");
      return;
    }
    if (threadModalForm.project_id && (!Number.isInteger(selectedProjectId) || Number(selectedProjectId) <= 0)) {
      setError(language === "de" ? "Bitte ein gültiges Projekt wählen." : "Please select a valid project.");
      return;
    }

    try {
      let targetThreadId: number | null = null;
      if (threadModalMode === "create") {
        const created = await apiFetch<Thread>("/threads", token, {
          method: "POST",
          body: JSON.stringify({ name, project_id: selectedProjectId }),
        });
        targetThreadId = created.id;
      } else if (threadModalMode === "edit" && activeThreadId) {
        const updated = await apiFetch<Thread>(`/threads/${activeThreadId}`, token, {
          method: "PATCH",
          body: JSON.stringify({ name, project_id: selectedProjectId }),
        });
        targetThreadId = updated.id;
      }

      if (threadIconFile && targetThreadId) {
        const form = new FormData();
        form.set("file", threadIconFile);
        await apiFetch(`/threads/${targetThreadId}/icon`, token, {
          method: "POST",
          body: form,
        });
      }

      closeThreadModal();
      await loadThreads();
      if (targetThreadId) {
        setActiveThreadId(targetThreadId);
        await loadMessages(targetThreadId);
      }
      setNotice(
        threadModalMode === "edit"
          ? language === "de"
            ? "Thread aktualisiert"
            : "Thread updated"
          : language === "de"
            ? "Thread erstellt"
            : "Thread created",
      );
    } catch (err: any) {
      setError(err.message ?? (threadModalMode === "edit" ? "Failed to update thread" : "Failed to create thread"));
    }
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeThreadId) return;
    const form = new FormData();
    const text = messageBody.trim();
    const selectedAttachment = messageAttachment ?? messageAttachmentInputRef.current?.files?.[0] ?? null;
    if (text) form.set("body", text);
    if (selectedAttachment) {
      form.set("attachment", selectedAttachment);
    }
    if (!text && !selectedAttachment) return;
    try {
      await apiFetch(`/threads/${activeThreadId}/messages`, token, {
        method: "POST",
        body: form,
      });
      shouldFollowMessagesRef.current = true;
      forceScrollToBottomRef.current = true;
      setMessageBody("");
      setMessageAttachment(null);
      if (messageAttachmentInputRef.current) {
        messageAttachmentInputRef.current.value = "";
      }
      window.requestAnimationFrame(() => {
        scrollMessageListToBottom();
      });
      await loadMessages(activeThreadId);
      await loadThreads();
    } catch (err: any) {
      setError(err.message ?? "Failed to send message");
    }
  }

  async function uploadFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeProjectId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (fileUploadFolder) {
      form.set("folder", fileUploadFolder);
    }
    try {
      await apiFetch(`/projects/${activeProjectId}/files`, token, { method: "POST", body: form });
      formElement.reset();
      setFileUploadModalOpen(false);
      setNewProjectFolderPath("");
      await loadFiles(activeProjectId);
      await loadProjectFolders(activeProjectId);
    } catch (err: any) {
      setError(err.message ?? "File upload failed");
    }
  }

  async function createProjectFolderFromInput() {
    if (!activeProjectId) return;
    const folderPath = newProjectFolderPath.trim();
    if (!folderPath) return;
    try {
      const created = await apiFetch<ProjectFolder>(`/projects/${activeProjectId}/folders`, token, {
        method: "POST",
        body: JSON.stringify({ path: folderPath }),
      });
      setNewProjectFolderPath("");
      await loadProjectFolders(activeProjectId);
      setFileUploadFolder(created.path);
      setNotice(language === "de" ? "Ordner erstellt" : "Folder created");
    } catch (err: any) {
      setError(err.message ?? "Failed to create folder");
    }
  }

  function openAvatarModal() {
    setAvatarModalOpen(true);
    setAvatarZoom(1);
    setAvatarOffsetX(0);
    setAvatarOffsetY(0);
  }

  function onMessageAttachmentChange(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setMessageAttachment(selected);
  }

  function scrollMessageListToBottom() {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }

  function clearMessageAttachment() {
    setMessageAttachment(null);
    if (messageAttachmentInputRef.current) {
      messageAttachmentInputRef.current.value = "";
    }
  }

  function onMessageListScroll() {
    const list = messageListRef.current;
    if (!list) return;
    const distanceToBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    shouldFollowMessagesRef.current = distanceToBottom <= 48;
  }

  function closeAvatarModal() {
    setAvatarModalOpen(false);
    setAvatarZoom(1);
    setAvatarOffsetX(0);
    setAvatarOffsetY(0);
    setAvatarNaturalSize(null);
    setAvatarIsDragging(false);
    avatarDragRef.current = null;
    setAvatarPreviewDataUrl("");
    setAvatarSourceUrl("");
    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current);
      avatarObjectUrlRef.current = null;
    }
  }

  function onAvatarFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(language === "de" ? "Bitte eine Bilddatei wählen." : "Please select an image file.");
      return;
    }
    if (avatarObjectUrlRef.current) {
      URL.revokeObjectURL(avatarObjectUrlRef.current);
    }
    const objectUrl = URL.createObjectURL(file);
    avatarObjectUrlRef.current = objectUrl;
    setAvatarSourceUrl(objectUrl);
    setAvatarZoom(1);
    setAvatarOffsetX(0);
    setAvatarOffsetY(0);
    setAvatarIsDragging(false);
    avatarDragRef.current = null;
  }

  function onAvatarDragStart(event: PointerEvent<HTMLDivElement>) {
    if (!avatarSourceUrl) return;
    avatarDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startOffsetX: avatarOffsetX,
      startOffsetY: avatarOffsetY,
    };
    setAvatarIsDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onAvatarDragMove(event: PointerEvent<HTMLDivElement>) {
    const drag = avatarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const node = avatarCropStageRef.current;
    const stageSize = node?.clientWidth || avatarStageSize || 260;
    const metrics = avatarStageMetrics(avatarNaturalSize, stageSize, avatarZoom, 0, 0);
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    const nextOffsetX = metrics.maxPanX > 0 ? drag.startOffsetX + (deltaX / metrics.maxPanX) * 100 : 0;
    const nextOffsetY = metrics.maxPanY > 0 ? drag.startOffsetY + (deltaY / metrics.maxPanY) * 100 : 0;
    setAvatarOffsetX(clamp(nextOffsetX, -100, 100));
    setAvatarOffsetY(clamp(nextOffsetY, -100, 100));
  }

  function onAvatarDragEnd(event: PointerEvent<HTMLDivElement>) {
    const drag = avatarDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    avatarDragRef.current = null;
    setAvatarIsDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  async function saveAvatar() {
    if (!avatarPreviewDataUrl) {
      setError(language === "de" ? "Bitte zuerst ein Bild auswählen." : "Please choose an image first.");
      return;
    }
    try {
      const previewResponse = await fetch(avatarPreviewDataUrl);
      const blob = await previewResponse.blob();
      const form = new FormData();
      form.set("file", new File([blob], "avatar.jpg", { type: "image/jpeg" }));
      const result = await apiFetch<AvatarUploadResponse>("/users/me/avatar", token, {
        method: "POST",
        body: form,
      });
      setAvatarVersionKey(result.avatar_updated_at || String(Date.now()));
      setUser(await apiFetch<User>("/auth/me", token));
      setNotice(language === "de" ? "Profilbild aktualisiert" : "Profile picture updated");
      closeAvatarModal();
    } catch (err: any) {
      setError(err.message ?? "Avatar upload failed");
    }
  }

  function fileDownloadUrl(fileId: number) {
    return `/api/files/${fileId}/download`;
  }

  function filePreviewUrl(fileId: number) {
    return `/api/files/${fileId}/preview`;
  }

  function isPreviewable(file: any) {
    const contentType = String(file?.content_type ?? "");
    return (
      contentType.startsWith("image/") ||
      contentType === "application/pdf" ||
      contentType.startsWith("text/")
    );
  }

  function wikiFileUrl(path: string, download = false) {
    const normalized = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `/api/wiki/library/raw/${normalized}${download ? "?download=1" : ""}`;
  }

  function formatFileSize(sizeBytes: number) {
    if (sizeBytes < 1024) return `${sizeBytes} B`;
    if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function updateReportWorker(index: number, field: keyof ReportWorker, value: string) {
    setReportWorkers((current) => {
      const next = [...current];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  }

  function addReportWorkerRow() {
    setReportWorkers((current) => [...current, { name: "", start_time: "", end_time: "" }]);
  }

  function removeReportWorkerRow(index: number) {
    setReportWorkers((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
  }

  function applyReportProjectSelection(nextProjectId: string) {
    setReportProjectId(nextProjectId);
    const selected = projects.find((project) => String(project.id) === nextProjectId) ?? null;
    setReportDraft(reportDraftFromProject(selected));
  }

  function updateReportDraftField(field: keyof ReportDraft, value: string) {
    setReportDraft((current) => ({ ...current, [field]: value }));
  }

  async function submitConstructionReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const rawProjectId = String(form.get("project_id") || reportProjectId || "").trim();
    const parsedProjectId = rawProjectId ? Number(rawProjectId) : NaN;
    let targetProjectId: number | null = null;
    if (rawProjectId) {
      if (!Number.isFinite(parsedProjectId) || parsedProjectId <= 0) {
        setError(language === "de" ? "Ungültige Projekt-ID" : "Invalid project ID");
        return;
      }
      targetProjectId = parsedProjectId;
    }
    const targetProject = targetProjectId ? projects.find((project) => project.id === targetProjectId) : null;

    const workers = reportWorkers
      .map((worker) => ({
        name: worker.name.trim(),
        start_time: normalizeTimeHHMM(worker.start_time) || null,
        end_time: normalizeTimeHHMM(worker.end_time) || null,
      }))
      .filter((worker) => worker.name.length > 0);
    const invalidWorkerIndex = workers.findIndex(
      (worker) =>
        (worker.start_time && !isValidTimeHHMM(worker.start_time)) ||
        (worker.end_time && !isValidTimeHHMM(worker.end_time)),
    );
    if (invalidWorkerIndex >= 0) {
      setError(
        language === "de"
          ? `Bitte Zeiten im Format HH:MM eintragen (Mitarbeiter Zeile ${invalidWorkerIndex + 1}).`
          : `Please use HH:MM for worker times (worker row ${invalidWorkerIndex + 1}).`,
      );
      return;
    }

    const materials = parseListLines(String(form.get("materials") || "")).map((line) => {
      const [item, qty, unit, article_no] = line.split("|").map((x) => x.trim());
      return { item: item || "-", qty: qty || null, unit: unit || null, article_no: article_no || null };
    });
    const extras = parseListLines(String(form.get("extras") || "")).map((line) => {
      const [description, reason] = line.split("|").map((x) => x.trim());
      return { description: description || "-", reason: reason || null };
    });

    const payload = {
      customer: reportDraft.customer.trim() || null,
      customer_address: reportDraft.customer_address.trim() || null,
      customer_contact: reportDraft.customer_contact.trim() || null,
      customer_email: reportDraft.customer_email.trim() || null,
      customer_phone: reportDraft.customer_phone.trim() || null,
      project_name: (targetProject?.name || reportDraft.project_name || "").trim() || null,
      project_number: (targetProject?.project_number || reportDraft.project_number || "").trim() || null,
      workers,
      materials,
      extras,
      work_done: String(form.get("work_done") || ""),
      incidents: String(form.get("incidents") || ""),
      office_material_need: String(form.get("office_material_need") || ""),
      office_rework: String(form.get("office_rework") || ""),
      office_next_steps: String(form.get("office_next_steps") || ""),
    };

    const multipart = new FormData();
    multipart.set("report_date", String(form.get("report_date")));
    multipart.set("send_telegram", form.get("send_telegram") === "on" ? "true" : "false");
    multipart.set("payload", JSON.stringify(payload));
    if (targetProjectId) multipart.set("project_id", String(targetProjectId));

    const imageInput = formElement.querySelector<HTMLInputElement>('input[name="images"]');
    const imageFiles = imageInput?.files ? Array.from(imageInput.files) : [];
    for (const file of imageFiles) {
      multipart.append("images", file);
    }

    try {
      const reportEndpoint = targetProjectId ? `/projects/${targetProjectId}/construction-reports` : "/construction-reports";
      await apiFetch(reportEndpoint, token, {
        method: "POST",
        body: multipart,
      });
      formElement.reset();
      setReportDraft(reportDraftFromProject(targetProject ?? null));
      setReportWorkers([{ name: "", start_time: "", end_time: "" }]);
      setNotice(language === "de" ? "Baustellenbericht gespeichert" : "Construction report saved");
      await loadConstructionReportFiles(targetProjectId);
    } catch (err: any) {
      setError(err.message ?? "Failed to submit report");
    }
  }

  async function applyTemplate(userId: number) {
    try {
      await apiFetch(`/admin/users/${userId}/apply-template`, token, { method: "POST" });
      setNotice(language === "de" ? "Rollen-Template angewendet" : "Permission template applied");
    } catch (err: any) {
      setError(err.message ?? "Failed to apply template");
    }
  }

  async function updateRole(userId: number, role: User["role"]) {
    try {
      await apiFetch(`/admin/users/${userId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      setUsers(await apiFetch<User[]>("/admin/users", token));
    } catch (err: any) {
      setError(err.message ?? "Failed to update role");
    }
  }

  async function updateRequiredDailyHours(targetUserId: number) {
    const targetHours = Number(requiredHoursDrafts[targetUserId]);
    if (!targetUserId || !Number.isFinite(targetHours) || targetHours < 1 || targetHours > 24) {
      setError(language === "de" ? "Bitte gültige Stunden zwischen 1 und 24 angeben" : "Please enter valid hours between 1 and 24");
      return;
    }
    try {
      await apiFetch(`/time/required-hours/${targetUserId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ required_daily_hours: targetHours }),
      });
      setAssignableUsers((current) =>
        current.map((entry) =>
          entry.id === targetUserId ? { ...entry, required_daily_hours: targetHours } : entry,
        ),
      );
      setRequiredHoursDrafts((current) => ({ ...current, [targetUserId]: String(targetHours) }));
      setUsers((current) =>
        current.map((entry) =>
          entry.id === targetUserId ? { ...entry, required_daily_hours: targetHours } : entry,
        ),
      );
      if (user && user.id === targetUserId) {
        setUser({ ...user, required_daily_hours: targetHours });
      }
      await refreshTimeData();
      setNotice(language === "de" ? "Sollstunden aktualisiert" : "Required hours updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update required hours");
    }
  }

  async function saveProfileSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fullName = profileSettingsForm.full_name.trim();
    const emailValue = profileSettingsForm.email.trim();
    const payload: Record<string, string> = {};
    if (fullName) payload.full_name = fullName;
    if (emailValue) payload.email = emailValue;
    if (profileSettingsForm.current_password.trim()) {
      payload.current_password = profileSettingsForm.current_password;
    }
    if (profileSettingsForm.new_password.trim()) {
      payload.new_password = profileSettingsForm.new_password;
    }

    try {
      const updated = await apiFetch<User>("/auth/me", token, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setUser(updated);
      setProfileSettingsForm({
        full_name: updated.full_name,
        email: updated.email,
        current_password: "",
        new_password: "",
      });
      if (isAdmin) {
        setUsers(await apiFetch<User[]>("/admin/users", token));
      }
      setNotice(language === "de" ? "Profil gespeichert" : "Profile updated");
    } catch (err: any) {
      setError(err.message ?? "Failed to update profile");
    }
  }

  function formatActionLinkNotice(
    result: InviteDispatchResponse | PasswordResetDispatchResponse,
    type: "invite" | "reset",
  ) {
    if (result.sent) {
      return type === "invite"
        ? language === "de"
          ? "Einladung per E-Mail versendet"
          : "Invitation email sent"
        : language === "de"
          ? "Passwort-Reset per E-Mail versendet"
          : "Password reset email sent";
    }
    const linkValue = type === "invite" ? result.invite_link : result.reset_link;
    return language === "de"
      ? `Kein SMTP aktiv. Link lokal erzeugt: ${linkValue}`
      : `SMTP not configured. Generated local link: ${linkValue}`;
  }

  async function sendInviteToUser(targetUserId: number) {
    setAdminUserMenuOpenId(null);
    try {
      const result = await apiFetch<InviteDispatchResponse>(`/admin/users/${targetUserId}/send-invite`, token, {
        method: "POST",
      });
      setUsers(await apiFetch<User[]>("/admin/users", token));
      setNotice(formatActionLinkNotice(result, "invite"));
    } catch (err: any) {
      setError(err.message ?? "Failed to send invite");
    }
  }

  async function sendPasswordResetToUser(targetUserId: number) {
    setAdminUserMenuOpenId(null);
    try {
      const result = await apiFetch<PasswordResetDispatchResponse>(
        `/admin/users/${targetUserId}/send-password-reset`,
        token,
        {
          method: "POST",
        },
      );
      setUsers(await apiFetch<User[]>("/admin/users", token));
      setNotice(formatActionLinkNotice(result, "reset"));
    } catch (err: any) {
      setError(err.message ?? "Failed to send password reset");
    }
  }

  async function softDeleteUser(targetUserId: number) {
    if (user && user.id === targetUserId) {
      setError(language === "de" ? "Eigenes Konto kann nicht gelöscht werden." : "You cannot delete your own account.");
      return;
    }
    const confirmed = window.confirm(
      language === "de"
        ? "Benutzer deaktivieren? Die Daten bleiben für Auswertungen erhalten."
        : "Deactivate user? Historical data remains available for reporting.",
    );
    if (!confirmed) return;

    setAdminUserMenuOpenId(null);
    try {
      const result = await apiFetch<{ ok: boolean; user_id: number; deleted: boolean }>(
        `/admin/users/${targetUserId}`,
        token,
        {
          method: "DELETE",
        },
      );
      setUsers(await apiFetch<User[]>("/admin/users", token));
      setAssignableUsers(await apiFetch<AssignableUser[]>("/users/assignable", token));
      setNotice(
        result.deleted
          ? language === "de"
            ? "Benutzer deaktiviert"
            : "User deactivated"
          : language === "de"
            ? "Benutzer war bereits deaktiviert"
            : "User already deactivated",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to delete user");
    }
  }

  async function submitCreateInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const emailValue = inviteCreateForm.email.trim();
    const nameValue = inviteCreateForm.full_name.trim();
    if (!emailValue || !nameValue) {
      setError(language === "de" ? "Bitte Name und E-Mail angeben." : "Please provide name and email.");
      return;
    }
    try {
      const result = await apiFetch<InviteDispatchResponse>("/admin/invites", token, {
        method: "POST",
        body: JSON.stringify({
          email: emailValue,
          full_name: nameValue,
          role: inviteCreateForm.role,
        }),
      });
      setInviteCreateForm({ email: "", full_name: "", role: "employee" });
      setUsers(await apiFetch<User[]>("/admin/users", token));
      setNotice(formatActionLinkNotice(result, "invite"));
    } catch (err: any) {
      setError(err.message ?? "Failed to create invite");
    }
  }

  async function exportEncryptedDatabaseBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const keyFile = formData.get("key_file");
    if (!(keyFile instanceof File) || keyFile.size <= 0) {
      setError(language === "de" ? "Bitte eine Schlüsseldatei auswählen." : "Please select a key file.");
      return;
    }

    setBackupExporting(true);
    try {
      const headers: HeadersInit = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetch("/api/admin/backups/database", {
        method: "POST",
        headers,
        body: formData,
        credentials: "include",
      });
      if (!response.ok) {
        let detail = response.statusText;
        try {
          const payload = await response.json();
          detail = payload.detail ?? detail;
        } catch {
          // no-op
        }
        throw new Error(detail || "Backup export failed");
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileNameMatch = disposition.match(/filename\*?=(?:UTF-8''|\"|)([^\";]+)/i);
      const rawFileName = fileNameMatch?.[1]?.trim() || "smpl-db-backup.smplbak";
      const normalizedRawFileName = rawFileName.replace(/\"/g, "");
      let fileName = normalizedRawFileName;
      try {
        fileName = decodeURIComponent(normalizedRawFileName);
      } catch {
        fileName = normalizedRawFileName;
      }
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
      form.reset();
      setNotice(
        language === "de"
          ? "Verschlüsseltes Datenbank-Backup wurde heruntergeladen."
          : "Encrypted database backup downloaded.",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to export backup");
    } finally {
      setBackupExporting(false);
    }
  }

  async function submitVacationRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const startDate = vacationRequestForm.start_date;
    const endDate = vacationRequestForm.end_date;
    if (!startDate || !endDate) {
      setError(language === "de" ? "Bitte Start- und Enddatum angeben." : "Please select start and end date.");
      return;
    }
    try {
      await apiFetch<VacationRequest>("/time/vacation-requests", token, {
        method: "POST",
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate,
          note: vacationRequestForm.note.trim() || null,
        }),
      });
      setVacationRequestForm({
        start_date: formatDateISOLocal(new Date()),
        end_date: formatDateISOLocal(new Date()),
        note: "",
      });
      await refreshTimeData();
      setNotice(language === "de" ? "Urlaubsantrag gesendet" : "Vacation request submitted");
    } catch (err: any) {
      setError(err.message ?? "Failed to submit vacation request");
    }
  }

  async function reviewVacationRequest(requestId: number, status: "approved" | "rejected") {
    try {
      await apiFetch<VacationRequest>(`/time/vacation-requests/${requestId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await refreshTimeData();
      setNotice(
        status === "approved"
          ? language === "de"
            ? "Urlaubsantrag genehmigt"
            : "Vacation request approved"
          : language === "de"
            ? "Urlaubsantrag abgelehnt"
            : "Vacation request rejected",
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to review vacation request");
    }
  }

  async function submitSchoolAbsence(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetUserId = Number(schoolAbsenceForm.user_id);
    if (!targetUserId || !Number.isFinite(targetUserId)) {
      setError(language === "de" ? "Bitte Mitarbeiter auswählen." : "Please choose an employee.");
      return;
    }
    const title = schoolAbsenceForm.title.trim() || "Berufsschule";
    const selectedWeekdays = [...schoolAbsenceForm.recurrence_weekdays].sort((a, b) => a - b);
    const recurrenceUntil = schoolAbsenceForm.recurrence_until || schoolAbsenceForm.end_date || null;
    try {
      if (selectedWeekdays.length > 0) {
        await Promise.all(
          selectedWeekdays.map((day) =>
            apiFetch<SchoolAbsence>("/time/school-absences", token, {
              method: "POST",
              body: JSON.stringify({
                user_id: targetUserId,
                title,
                start_date: schoolAbsenceForm.start_date,
                end_date: schoolAbsenceForm.start_date,
                recurrence_weekday: day,
                recurrence_until: recurrenceUntil,
              }),
            }),
          ),
        );
      } else {
        await apiFetch<SchoolAbsence>("/time/school-absences", token, {
          method: "POST",
          body: JSON.stringify({
            user_id: targetUserId,
            title,
            start_date: schoolAbsenceForm.start_date,
            end_date: schoolAbsenceForm.end_date,
            recurrence_weekday: null,
            recurrence_until: null,
          }),
        });
      }
      setSchoolAbsenceForm({
        user_id: "",
        title: "Berufsschule",
        start_date: formatDateISOLocal(new Date()),
        end_date: formatDateISOLocal(new Date()),
        recurrence_weekdays: [],
        recurrence_until: "",
      });
      await refreshTimeData();
      setNotice(language === "de" ? "Schulzeit gespeichert" : "School date saved");
    } catch (err: any) {
      setError(err.message ?? "Failed to save school absence");
    }
  }

  function toggleSchoolRecurrenceWeekday(day: number, checked: boolean) {
    setSchoolAbsenceForm((current) => {
      const existing = new Set(current.recurrence_weekdays);
      if (checked) {
        existing.add(day);
      } else {
        existing.delete(day);
      }
      return {
        ...current,
        recurrence_weekdays: [...existing].sort((a, b) => a - b),
      };
    });
  }

  async function removeSchoolAbsence(absenceId: number) {
    try {
      await apiFetch(`/time/school-absences/${absenceId}`, token, { method: "DELETE" });
      await refreshTimeData();
      setNotice(language === "de" ? "Schulzeit gelöscht" : "School date deleted");
    } catch (err: any) {
      setError(err.message ?? "Failed to delete school absence");
    }
  }

  async function downloadProjectCsvTemplate() {
    try {
      const response = await fetch("/api/admin/projects/import-template.csv", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(response.statusText || "Template download failed");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "projects-import-template.csv";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to download CSV template");
    }
  }

  async function importProjectsCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0) {
      setError(language === "de" ? "Bitte eine CSV-Datei auswählen." : "Please select a CSV file.");
      return;
    }
    const payload = new FormData();
    payload.set("file", file);
    try {
      const result = await apiFetch<{
        processed_rows: number;
        created: number;
        updated: number;
        temporary_numbers: number;
        duplicates_skipped: number;
      }>("/admin/projects/import-csv", token, {
        method: "POST",
        body: payload,
      });
      await loadBaseData();
      setNotice(
        language === "de"
          ? `CSV importiert: ${result.processed_rows} Zeilen, ${result.created} neu, ${result.updated} aktualisiert`
          : `CSV imported: ${result.processed_rows} rows, ${result.created} created, ${result.updated} updated`,
      );
      event.currentTarget.reset();
    } catch (err: any) {
      setError(err.message ?? "Failed to import CSV");
    }
  }

  function openProfileViewFromMenu() {
    setProjectBackView(null);
    setOverviewShortcutBackVisible(false);
    setMainView("profile");
    setPreUserMenuOpen(false);
  }

  function signOut() {
    localStorage.removeItem("smpl_token");
    setToken(null);
    setPreUserMenuOpen(false);
  }

  async function copyToClipboard(value: string, label: "all" | "project") {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = value;
        fallback.setAttribute("readonly", "true");
        fallback.style.position = "absolute";
        fallback.style.left = "-9999px";
        document.body.appendChild(fallback);
        fallback.select();
        document.execCommand("copy");
        document.body.removeChild(fallback);
      }
      setNotice(
        language === "de"
          ? label === "all"
            ? "WebDAV-Link (alle Projekte) kopiert"
            : "WebDAV-Link (aktuelles Projekt) kopiert"
          : label === "all"
            ? "WebDAV link (all projects) copied"
            : "WebDAV link (current project) copied",
      );
    } catch {
      setError(language === "de" ? "Link konnte nicht kopiert werden" : "Failed to copy link");
    }
  }

  if (!user) {
    const isPublicTokenFlow = publicAuthMode === "invite" || publicAuthMode === "reset";
    return (
      <main className="login-shell">
        {isPublicTokenFlow ? (
          <form
            className="card auth-card"
            onSubmit={publicAuthMode === "invite" ? submitPublicInviteAccept : submitPublicPasswordReset}
          >
            <img src="/logo.jpeg" alt="Company logo" className="brand-logo large" />
            <h1>SMPL Workflow</h1>
            <p>
              {publicAuthMode === "invite"
                ? language === "de"
                  ? "Einladung annehmen"
                  : "Accept invitation"
                : language === "de"
                  ? "Passwort zurücksetzen"
                  : "Reset password"}
            </p>
            <label>
              Token
              <input value={publicToken} onChange={(event) => setPublicToken(event.target.value)} required />
            </label>
            {publicAuthMode === "invite" && (
              <>
                <label>
                  {language === "de" ? "Name (optional)" : "Name (optional)"}
                  <input value={publicFullName} onChange={(event) => setPublicFullName(event.target.value)} />
                </label>
                <label>
                  {language === "de" ? "E-Mail (optional)" : "Email (optional)"}
                  <input
                    type="email"
                    value={publicEmail}
                    onChange={(event) => setPublicEmail(event.target.value)}
                  />
                </label>
              </>
            )}
            <label>
              {language === "de" ? "Neues Passwort" : "New password"}
              <input
                type="password"
                minLength={8}
                value={publicNewPassword}
                onChange={(event) => setPublicNewPassword(event.target.value)}
                required
              />
            </label>
            <label>
              {language === "de" ? "Passwort bestätigen" : "Confirm password"}
              <input
                type="password"
                minLength={8}
                value={publicConfirmPassword}
                onChange={(event) => setPublicConfirmPassword(event.target.value)}
                required
              />
            </label>
            <div className="row wrap">
              <button type="submit">
                {publicAuthMode === "invite"
                  ? language === "de"
                    ? "Einladung bestätigen"
                    : "Accept invite"
                  : language === "de"
                    ? "Passwort setzen"
                    : "Set password"}
              </button>
              <button type="button" onClick={resetPublicAuthRoute}>
                {language === "de" ? "Zur Anmeldung" : "Back to sign in"}
              </button>
              <button type="button" onClick={() => setLanguage(language === "de" ? "en" : "de")}>
                {language === "de" ? "EN" : "DE"}
              </button>
            </div>
            {error && <div className="error">{error}</div>}
            {notice && <div className="notice">{notice}</div>}
          </form>
        ) : (
          <form className="card auth-card" onSubmit={onLogin}>
            <img src="/logo.jpeg" alt="Company logo" className="brand-logo large" />
            <h1>SMPL Workflow</h1>
            <p>{language === "de" ? "Private, selbst gehostete Workflow-App" : "Private self-hosted workflow app"}</p>
            <label>
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              {language === "de" ? "Passwort" : "Password"}
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <div className="row">
              <button type="submit">{language === "de" ? "Anmelden" : "Sign in"}</button>
              <button type="button" onClick={() => setLanguage(language === "de" ? "en" : "de")}>
                {language === "de" ? "EN" : "DE"}
              </button>
            </div>
            {error && <div className="error">{error}</div>}
            {notice && <div className="notice">{notice}</div>}
          </form>
        )}
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-main">
          <div className="brand-block">
            <img src="/logo.jpeg" alt="Company logo" className="brand-logo" />
            <div>
              <h2>SMPL</h2>
              <small className="role">{language === "de" ? "Workflow-App" : "Workflow app"}</small>
            </div>
          </div>

          <nav className="main-nav">
            {navViews.map((item) => (
              <button
                key={item}
                className={item === mainView ? "active" : ""}
                onClick={() => {
                  setProjectBackView(null);
                  setOverviewShortcutBackVisible(false);
                  setConstructionBackView(null);
                  if (item === "my_tasks") setMyTasksBackProjectId(null);
                  setMainView(item);
                }}
              >
                <span className="nav-item-content">
                  <span className="nav-icon-wrap">
                    <SidebarNavIcon view={item} />
                    {item === "messages" && hasUnreadThreads && <span className="nav-unread-dot" />}
                    {(item === "my_tasks" || item === "planning") && hasTaskNotifications && (
                      <span className="nav-unread-dot" />
                    )}
                  </span>
                  <span>{mainLabels[item]}</span>
                </span>
              </button>
            ))}
          </nav>

          <div className="project-list">
            <div className="project-list-title-row">
              <div className="project-list-title-group">
                <div className="project-list-title">{language === "de" ? "Projekte" : "Projects"}</div>
                <button
                  type="button"
                  className={projectSidebarSearchOpen ? "icon-btn project-search-toggle active" : "icon-btn project-search-toggle"}
                  onClick={() => {
                    setProjectSidebarSearchOpen((current) => !current);
                    if (projectSidebarSearchOpen) {
                      setProjectSidebarSearchQuery("");
                    }
                  }}
                  aria-label={language === "de" ? "Projekt-Suche" : "Project search"}
                  title={language === "de" ? "Projekt-Suche" : "Project search"}
                >
                  <SearchIcon />
                </button>
              </div>
              {canCreateProject && (
                <button
                  type="button"
                  className="create-new-btn"
                  onClick={openCreateProjectModal}
                  aria-label={language === "de" ? "Neues Projekt erstellen" : "Create new project"}
                  title={language === "de" ? "Neues Projekt erstellen" : "Create new project"}
                >
                  +
                </button>
              )}
            </div>
            {projectSidebarSearchOpen && (
              <input
                className="project-sidebar-search-input"
                value={projectSidebarSearchQuery}
                onChange={(event) => setProjectSidebarSearchQuery(event.target.value)}
                placeholder={language === "de" ? "Projekt suchen..." : "Search project..."}
                aria-label={language === "de" ? "Projekt suchen" : "Search project"}
              />
            )}
            <div className={projectSidebarSearchOpen ? "project-list-scroll with-search" : "project-list-scroll"}>
              {filteredSidebarProjects.map((project) => (
                <button
                  key={project.id}
                  className={project.id === activeProjectId && mainView === "project" ? "active project-item" : "project-item"}
                  onClick={() => {
                    setActiveProjectId(project.id);
                    setProjectTab("tasks");
                    setProjectBackView(null);
                    setOverviewShortcutBackVisible(false);
                    setConstructionBackView(null);
                    setMainView("project");
                  }}
                >
                  <span className="project-item-main">
                    <b>
                      {(project.customer_name ?? "").trim() || "-"} | {project.project_number}
                    </b>
                    <small>{project.name}</small>
                  </span>
                </button>
              ))}
              {filteredSidebarProjects.length === 0 && (
                <small>{projectSidebarSearchQuery ? (language === "de" ? "Keine Treffer" : "No matching projects") : language === "de" ? "Keine Projekte" : "No projects"}</small>
              )}
              <div className="project-list-archive-entry">
                <div className="project-list-divider" />
                <button
                  type="button"
                  className={mainView === "projects_archive" ? "project-archive-btn active" : "project-archive-btn"}
                  onClick={() => {
                    setProjectBackView(null);
                    setOverviewShortcutBackVisible(false);
                    setConstructionBackView(null);
                    setMainView("projects_archive");
                  }}
                >
                  {language === "de" ? "Projektarchiv" : "Project archive"}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="sidebar-footer">
          <div className="pre-user-menu-wrap" ref={preUserMenuRef}>
            {preUserMenuOpen && (
              <div className="pre-user-menu-popup">
                <div className="row lang-row lang-row-small pre-user-lang">
                  <button
                    type="button"
                    onClick={() => setLanguage("de")}
                    className={language === "de" ? "active" : ""}
                  >
                    DE
                  </button>
                  <button
                    type="button"
                    onClick={() => setLanguage("en")}
                    className={language === "en" ? "active" : ""}
                  >
                    EN
                  </button>
                </div>
                <button type="button" className="pre-user-action" onClick={openProfileViewFromMenu}>
                  {language === "de" ? "Benutzerdaten" : "User data"}
                </button>
                <button type="button" className="pre-user-action" onClick={signOut}>
                  {language === "de" ? "Abmelden" : "Sign out"}
                </button>
                <div className="pre-user-meta">
                  <small>
                    {language === "de" ? "Firmware-Build" : "Firmware build"}: <b>{firmwareBuild}</b>
                  </small>
                  <small>
                    {language === "de" ? "Mitarbeiter-ID" : "Employee ID"}: <b>{user.id}</b>
                  </small>
                </div>
              </div>
            )}
            <button
              type="button"
              className={mainView === "profile" ? "sidebar-user-btn active" : "sidebar-user-btn"}
              onClick={() => setPreUserMenuOpen((open) => !open)}
              aria-expanded={preUserMenuOpen}
              aria-label={language === "de" ? "Benutzermenü öffnen" : "Open user menu"}
            >
              <div className="sidebar-user">
                <AvatarBadge
                  userId={user.id}
                  initials={userInitials}
                  hasAvatar={Boolean(user.avatar_updated_at)}
                  versionKey={avatarVersionKey}
                />
                <div className="sidebar-user-meta">
                  <b>{user.full_name}</b>
                  <small className="role">Role: {user.role}</small>
                </div>
              </div>
            </button>
          </div>
          <div className="sidebar-now">
            <small>{sidebarNowLabel}</small>
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="workspace-header">
          <div className="workspace-header-main">
            {showOverviewBackButton && (
              <button
                type="button"
                className="icon-btn header-back-btn"
                onClick={() => {
                  setOverviewShortcutBackVisible(false);
                  setMainView("overview");
                }}
              >
                <BackIcon />
                <span>{language === "de" ? "Zurück" : "Back"}</span>
              </button>
            )}
            <div>
              {mainView === "project" && activeProject ? (
                <>
                  <h1>{activeProjectHeaderTitle}</h1>
                  <small>{activeProject.name}</small>
                </>
              ) : (
                <h1>{mainLabels[mainView]}</h1>
              )}
              {mainView === "project" && activeProject && (
                <small>
                  #{activeProject.project_number} | {language === "de" ? "Status" : "Status"}:{" "}
                  {statusLabel(activeProject.status, language)}
                </small>
              )}
            </div>
          </div>
          <div className="header-tools">
            {mainView === "planning" && canManageTasks && (
              <button type="button" onClick={() => openTaskModal({ dueDate: planningWeekStart })}>
                {language === "de" ? "Neue Aufgabe" : "Add task"}
              </button>
            )}
            {mainView === "construction" && constructionBackView && (
              <button
                type="button"
                className="icon-btn header-back-btn"
                onClick={() => {
                  if (constructionBackView === "project") {
                    setProjectTab("tasks");
                  }
                  setMainView(constructionBackView);
                  setConstructionBackView(null);
                }}
              >
                <BackIcon />
                <span>{language === "de" ? "Zurück" : "Back"}</span>
              </button>
            )}
            {mainView === "project" && projectBackView === "my_tasks" && (
              <button
                type="button"
                onClick={() => {
                  setMainView("my_tasks");
                }}
              >
                {language === "de" ? "Zurück zu Meine Aufgaben" : "Back to My Tasks"}
              </button>
            )}
            {mainView === "project" && projectBackView === "projects_all" && (
              <button
                type="button"
                onClick={() => {
                  setMainView("projects_all");
                }}
              >
                {language === "de" ? "Zurück zu Alle Projekte" : "Back to All Projects"}
              </button>
            )}
            {canCreateProject && mainView === "project" && activeProject && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => openEditProjectModal(activeProject)}
                aria-label={language === "de" ? "Projekt bearbeiten" : "Edit project"}
                title={language === "de" ? "Projekt bearbeiten" : "Edit project"}
              >
                <PenIcon />
              </button>
            )}
          </div>
        </header>

        {mainView === "project" && activeProject && (
          <div className="top-tabs">
            {projectTabs.map((tab) => (
              <button key={tab} className={tab === projectTab ? "active" : ""} onClick={() => setProjectTab(tab)}>
                {tabLabels[tab]}
              </button>
            ))}
          </div>
        )}
        {mainView === "project" && activeProject && (
          <section className="card project-summary-card">
            <div className="project-summary-layout">
              <div className="project-summary-info">
                <div className="project-summary-grid">
                  <small>
                    {language === "de" ? "Kunde" : "Customer"}: <b>{(activeProject.customer_name ?? "").trim() || "-"}</b>
                  </small>
                  <small>
                    {language === "de" ? "Projektnummer" : "Project number"}: <b>{activeProject.project_number}</b>
                  </small>
                  <small>
                    {language === "de" ? "Status" : "Status"}: <b>{statusLabel(activeProject.status, language)}</b>
                  </small>
                </div>
                <small>
                  {language === "de" ? "Letzter Stand" : "Last state"}: <b>{activeProjectLastState || "-"}</b>
                </small>
                <small>
                  {language === "de" ? "Letztes Status-Datum" : "Last status update"}: <b>{activeProjectLastStatusAtLabel || "-"}</b>
                </small>
              </div>
              {projectTab === "tasks" && (
                <aside className="project-map-card">
                  <div className="project-map-head">
                    <b>{language === "de" ? "Projektadresse" : "Project location"}</b>
                  </div>
                  {activeProjectMapEmbedUrl ? (
                    <>
                      <iframe
                        title={language === "de" ? "Projektkarte" : "Project map"}
                        className="project-map-frame"
                        src={activeProjectMapEmbedUrl}
                        loading="lazy"
                        referrerPolicy="no-referrer-when-downgrade"
                      />
                      <a className="linklike" target="_blank" rel="noreferrer" href={activeProjectMapOpenUrl}>
                        {language === "de" ? "In Karten öffnen" : "Open in maps"}
                      </a>
                    </>
                  ) : (
                    <small className="muted">
                      {language === "de" ? "Keine Projektadresse hinterlegt." : "No project address available."}
                    </small>
                  )}
                </aside>
              )}
            </div>
          </section>
        )}

        {error && (
          <div className="error" onClick={() => setError("")}>
            {error}
          </div>
        )}
        {notice && (
          <div className="notice" onClick={() => setNotice("")}>
            {notice}
          </div>
        )}

        {projectModalMode && (
          <div className="modal-backdrop" onClick={closeProjectModal}>
            <div className="card modal-card" onClick={(event) => event.stopPropagation()}>
              <h3>
                {projectModalMode === "create"
                  ? language === "de"
                    ? "Neues Projekt"
                    : "Create new project"
                  : language === "de"
                    ? "Projekt bearbeiten"
                    : "Edit project"}
              </h3>
              <form className="modal-form" onSubmit={submitProjectForm}>
                <label>
                  {language === "de" ? "Projektnummer" : "Project number"}
                  <input
                    value={projectForm.project_number}
                    onChange={(event) => updateProjectFormField("project_number", event.target.value)}
                    placeholder={language === "de" ? "z.B. 2026-104" : "e.g. 2026-104"}
                    required
                  />
                </label>
                <label>
                  {language === "de" ? "Projektname" : "Project name"}
                  <input
                    value={projectForm.name}
                    onChange={(event) => updateProjectFormField("name", event.target.value)}
                    required
                  />
                </label>
                <label>
                  {language === "de" ? "Status" : "Status"}
                  <select
                    value={projectForm.status}
                    onChange={(event) => updateProjectFormField("status", event.target.value)}
                    required
                  >
                    {projectStatusSelectOptions.map((statusValue) => (
                      <option key={statusValue} value={statusValue}>
                        {statusLabel(statusValue, language)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {language === "de" ? "Interne Notiz" : "Internal note"}
                  <textarea
                    value={projectForm.description}
                    onChange={(event) => updateProjectFormField("description", event.target.value)}
                  />
                </label>
                <label>
                  {language === "de" ? "Letzter Stand" : "Last state"}
                  <textarea
                    value={projectForm.last_state}
                    onChange={(event) => updateProjectFormField("last_state", event.target.value)}
                  />
                </label>
                <label>
                  {language === "de" ? "Letztes Status-Datum" : "Last status update"}
                  <input
                    type="datetime-local"
                    value={projectForm.last_status_at}
                    onChange={(event) => updateProjectFormField("last_status_at", event.target.value)}
                  />
                </label>
                <label>
                  {language === "de" ? "Kunde" : "Customer name"}
                  <input
                    value={projectForm.customer_name}
                    onChange={(event) => updateProjectFormField("customer_name", event.target.value)}
                  />
                </label>
                <label>
                  {language === "de" ? "Kundenadresse" : "Customer address"}
                  <textarea
                    value={projectForm.customer_address}
                    onChange={(event) => updateProjectFormField("customer_address", event.target.value)}
                  />
                </label>
                <label>
                  {language === "de" ? "Kontaktperson" : "Contact person"}
                  <input
                    value={projectForm.customer_contact}
                    onChange={(event) => updateProjectFormField("customer_contact", event.target.value)}
                  />
                </label>
                <label>
                  {language === "de" ? "Kontakt E-Mail" : "Contact email"}
                  <input
                    type="email"
                    value={projectForm.customer_email}
                    onChange={(event) => updateProjectFormField("customer_email", event.target.value)}
                  />
                </label>
                <label>
                  {language === "de" ? "Kontakt Telefon" : "Contact phone"}
                  <input
                    value={projectForm.customer_phone}
                    onChange={(event) => updateProjectFormField("customer_phone", event.target.value)}
                  />
                </label>
                <div className="row wrap">
                  <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
                  {projectModalMode === "edit" && (
                    <button type="button" onClick={() => void archiveActiveProject()}>
                      {language === "de" ? "Archivieren" : "Archive"}
                    </button>
                  )}
                  {projectModalMode === "edit" && (
                    <button type="button" className="danger-btn" onClick={() => void deleteActiveProject()}>
                      {language === "de" ? "Löschen" : "Delete"}
                    </button>
                  )}
                  <button type="button" onClick={closeProjectModal}>
                    {language === "de" ? "Abbrechen" : "Cancel"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {taskModalOpen && (
          <div className="modal-backdrop" onClick={closeTaskModal}>
            <div className="card modal-card" onClick={(event) => event.stopPropagation()}>
              <h3>{language === "de" ? "Neue Wochenaufgabe" : "New weekly task"}</h3>
              <form
                className="modal-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createWeeklyPlanTask();
                }}
              >
                <label>
                  {language === "de" ? "Titel" : "Title"}
                  <input
                    value={taskModalForm.title}
                    onChange={(event) => updateTaskModalField("title", event.target.value)}
                    placeholder={language === "de" ? "Aufgabentitel" : "Task title"}
                    required
                  />
                </label>
                <label>
                  {language === "de" ? "Information" : "Information"}
                  <textarea
                    value={taskModalForm.description}
                    onChange={(event) => updateTaskModalField("description", event.target.value)}
                    placeholder={language === "de" ? "Beschreibung der Aufgabe" : "Task description"}
                  />
                </label>
                <label>
                  {language === "de" ? "Benötigte Materialien" : "Required materials"}
                  <textarea
                    value={taskModalForm.materials_required}
                    onChange={(event) => updateTaskModalField("materials_required", event.target.value)}
                    placeholder={
                      language === "de"
                        ? "z.B. Kabel, Wechselrichter, Montagematerial"
                        : "e.g. cables, inverter, mounting kit"
                    }
                  />
                </label>
                <label className="checkbox-inline">
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
                  {language === "de" ? "Material aus Lagerbox verwenden" : "Use materials from warehouse box"}
                </label>
                {taskModalForm.has_storage_box && (
                  <label>
                    {language === "de" ? "Lagerbox-Nummer" : "Storage box number"}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={taskModalForm.storage_box_number}
                      onChange={(event) => updateTaskModalField("storage_box_number", event.target.value)}
                      required
                    />
                  </label>
                )}
                <div className="assignee-search-block">
                  <b>{language === "de" ? "Projekt zuweisen" : "Assign project"}</b>
                  <input
                    value={taskModalForm.project_query}
                    onChange={(event) => {
                      const nextQuery = event.target.value;
                      setTaskModalForm((current) => {
                        if (!current.project_id) return { ...current, project_query: nextQuery };
                        const currentProject = projects.find((project) => String(project.id) === current.project_id);
                        if (!currentProject) return { ...current, project_query: nextQuery, project_id: "" };
                        return projectSearchLabel(currentProject) === nextQuery
                          ? { ...current, project_query: nextQuery }
                          : { ...current, project_query: nextQuery, project_id: "" };
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      const first = taskModalProjectSuggestions[0];
                      if (first) selectTaskModalProject(first);
                    }}
                    placeholder={
                      language === "de"
                        ? "Projektnummer, Kunde oder Projektname"
                        : "Project number, customer, or project name"
                    }
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
                          }))
                        }
                        title={language === "de" ? "Entfernen" : "Remove"}
                      >
                        {projectSearchLabel(selectedTaskModalProject) + " ×"}
                      </button>
                    ) : (
                      <small className="muted">
                        {language === "de" ? "Noch kein Projekt ausgewählt." : "No project selected yet."}
                      </small>
                    )}
                  </div>
                </div>
                {!selectedTaskModalProject && canCreateProject && (
                  <>
                    <label className="checkbox-inline">
                      <input
                        type="checkbox"
                        checked={taskModalForm.create_project_from_task}
                        onChange={(event) => updateTaskModalField("create_project_from_task", event.target.checked)}
                      />
                      {language === "de"
                        ? "Falls nötig, neues Projekt aus dieser Aufgabe erstellen"
                        : "Create a new project from this task if needed"}
                    </label>
                    {taskModalForm.create_project_from_task && (
                      <div className="row wrap modal-subgrid">
                        <label>
                          {language === "de" ? "Projektname" : "Project name"}
                          <input
                            value={taskModalForm.new_project_name}
                            onChange={(event) => updateTaskModalField("new_project_name", event.target.value)}
                            placeholder={language === "de" ? "Standard: Aufgabentitel" : "Default: task title"}
                          />
                        </label>
                        <label>
                          {language === "de" ? "Projektnummer" : "Project number"}
                          <input
                            value={taskModalForm.new_project_number}
                            onChange={(event) => updateTaskModalField("new_project_number", event.target.value)}
                            placeholder={language === "de" ? "Optional (auto: T...)" : "Optional (auto: T...)"}
                          />
                        </label>
                      </div>
                    )}
                  </>
                )}
                <div className="row wrap">
                  <label>
                    {language === "de" ? "Fälligkeitsdatum" : "Due date"}
                    <input
                      type="date"
                      value={taskModalForm.due_date}
                      onChange={(event) => updateTaskModalField("due_date", event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    {language === "de" ? "Startzeit" : "Start time"}
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="HH:MM"
                      pattern={HHMM_PATTERN}
                      title="HH:MM (24h)"
                      maxLength={5}
                      value={taskModalForm.start_time}
                      onChange={(event) => updateTaskModalField("start_time", event.target.value)}
                      required
                    />
                  </label>
                </div>
                <div className="assignee-search-block">
                  <b>{language === "de" ? "Personen zuweisen" : "Assign people"}</b>
                  <input
                    value={taskModalForm.assignee_query}
                    onChange={(event) => updateTaskModalField("assignee_query", event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addFirstMatchingTaskModalAssignee();
                    }}
                    placeholder={
                      language === "de"
                        ? "Namen eingeben und auswählen"
                        : "Type user name and select"
                    }
                  />
                  {taskModalAssigneeSuggestions.length > 0 && (
                    <div className="assignee-suggestions">
                      {taskModalAssigneeSuggestions.map((assignee) => (
                        <button
                          key={assignee.id}
                          type="button"
                          className="assignee-suggestion-btn"
                          onClick={() => addTaskModalAssignee(assignee.id)}
                        >
                          {assignee.full_name} (#{assignee.id})
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="assignee-chip-list">
                    {taskModalForm.assignee_ids.map((assigneeId) => {
                      const assignee = assignableUsers.find((entry) => entry.id === assigneeId);
                      return (
                        <button
                          key={assigneeId}
                          type="button"
                          className="assignee-chip"
                          onClick={() => removeTaskModalAssignee(assigneeId)}
                          title={language === "de" ? "Entfernen" : "Remove"}
                        >
                          {(assignee?.full_name ?? `#${assigneeId}`) + " ×"}
                        </button>
                      );
                    })}
                    {taskModalForm.assignee_ids.length === 0 && (
                      <small className="muted">
                        {language === "de"
                          ? "Noch keine Personen ausgewählt."
                          : "No people selected yet."}
                      </small>
                    )}
                  </div>
                </div>
                <div className="row wrap">
                  <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
                  <button type="button" onClick={closeTaskModal}>
                    {language === "de" ? "Abbrechen" : "Cancel"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {taskEditModalOpen && (
          <div className="modal-backdrop" onClick={closeTaskEditModal}>
            <div className="card modal-card" onClick={(event) => event.stopPropagation()}>
              <h3>{language === "de" ? "Aufgabe bearbeiten" : "Edit task"}</h3>
              <form
                className="modal-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveTaskEdit();
                }}
              >
                <label>
                  {language === "de" ? "Titel" : "Title"}
                  <input
                    value={taskEditForm.title}
                    onChange={(event) => updateTaskEditField("title", event.target.value)}
                    placeholder={language === "de" ? "Aufgabentitel" : "Task title"}
                    required
                  />
                </label>
                <label>
                  {language === "de" ? "Information" : "Information"}
                  <textarea
                    value={taskEditForm.description}
                    onChange={(event) => updateTaskEditField("description", event.target.value)}
                    placeholder={language === "de" ? "Beschreibung der Aufgabe" : "Task description"}
                  />
                </label>
                <label>
                  {language === "de" ? "Benötigte Materialien" : "Required materials"}
                  <textarea
                    value={taskEditForm.materials_required}
                    onChange={(event) => updateTaskEditField("materials_required", event.target.value)}
                    placeholder={
                      language === "de"
                        ? "z.B. Kabel, Wechselrichter, Montagematerial"
                        : "e.g. cables, inverter, mounting kit"
                    }
                  />
                </label>
                <label className="checkbox-inline">
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
                  {language === "de" ? "Material aus Lagerbox verwenden" : "Use materials from warehouse box"}
                </label>
                {taskEditForm.has_storage_box && (
                  <label>
                    {language === "de" ? "Lagerbox-Nummer" : "Storage box number"}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={taskEditForm.storage_box_number}
                      onChange={(event) => updateTaskEditField("storage_box_number", event.target.value)}
                      required
                    />
                  </label>
                )}
                <div className="row wrap">
                  <label>
                    {language === "de" ? "Status" : "Status"}
                    <select
                      value={taskEditForm.status}
                      onChange={(event) => updateTaskEditField("status", event.target.value)}
                      required
                    >
                      {taskStatusOptions.map((statusValue) => (
                        <option key={statusValue} value={statusValue}>
                          {statusValue}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {language === "de" ? "Wochenstart (Montag)" : "Week start (Monday)"}
                    <input
                      type="date"
                      value={taskEditForm.week_start}
                      onChange={(event) =>
                        updateTaskEditField(
                          "week_start",
                          event.target.value ? normalizeWeekStartISO(event.target.value) : "",
                        )
                      }
                    />
                  </label>
                </div>
                <div className="row wrap">
                  <label>
                    {language === "de" ? "Fälligkeitsdatum" : "Due date"}
                    <input
                      type="date"
                      value={taskEditForm.due_date}
                      onChange={(event) => updateTaskEditField("due_date", event.target.value)}
                    />
                  </label>
                  <label>
                    {language === "de" ? "Startzeit" : "Start time"}
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="HH:MM"
                      pattern={HHMM_PATTERN}
                      title="HH:MM (24h)"
                      maxLength={5}
                      value={taskEditForm.start_time}
                      onChange={(event) => updateTaskEditField("start_time", event.target.value)}
                    />
                  </label>
                </div>
                <div className="assignee-search-block">
                  <b>{language === "de" ? "Personen zuweisen" : "Assign people"}</b>
                  <input
                    value={taskEditForm.assignee_query}
                    onChange={(event) => updateTaskEditField("assignee_query", event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addFirstMatchingTaskEditAssignee();
                    }}
                    placeholder={
                      language === "de" ? "Namen eingeben und auswählen" : "Type user name and select"
                    }
                  />
                  {taskEditAssigneeSuggestions.length > 0 && (
                    <div className="assignee-suggestions">
                      {taskEditAssigneeSuggestions.map((assignee) => (
                        <button
                          key={assignee.id}
                          type="button"
                          className="assignee-suggestion-btn"
                          onClick={() => addTaskEditAssignee(assignee.id)}
                        >
                          {assignee.full_name} (#{assignee.id})
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="assignee-chip-list">
                    {taskEditForm.assignee_ids.map((assigneeId) => {
                      const assignee = assignableUsers.find((entry) => entry.id === assigneeId);
                      return (
                        <button
                          key={assigneeId}
                          type="button"
                          className="assignee-chip"
                          onClick={() => removeTaskEditAssignee(assigneeId)}
                          title={language === "de" ? "Entfernen" : "Remove"}
                        >
                          {(assignee?.full_name ?? `#${assigneeId}`) + " ×"}
                        </button>
                      );
                    })}
                    {taskEditForm.assignee_ids.length === 0 && (
                      <small className="muted">
                        {language === "de" ? "Noch keine Personen ausgewählt." : "No people selected yet."}
                      </small>
                    )}
                  </div>
                </div>
                <div className="row wrap">
                  <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
                  {canManageTasks && (
                    <button type="button" className="danger-btn" onClick={() => void deleteTaskFromEdit()}>
                      {language === "de" ? "Löschen" : "Delete"}
                    </button>
                  )}
                  <button type="button" onClick={closeTaskEditModal}>
                    {language === "de" ? "Abbrechen" : "Cancel"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {mainView === "overview" && (
          <section className="overview-layout">
            <div className="overview-shortcuts">
              {overviewActionCards.map((action) => (
                <button
                  key={action.view}
                  type="button"
                  className="overview-shortcut-card"
                  style={{ width: overviewActionCardWidth }}
                  onClick={() => {
                    setProjectBackView(null);
                    setOverviewShortcutBackVisible(true);
                    setConstructionBackView(null);
                    setMainView(action.view);
                  }}
                >
                  <SidebarNavIcon view={action.view} />
                  <span>{action.label}</span>
                </button>
              ))}
            </div>

            <div className="overview-main-grid">
              <div className="card overview-card overview-status-card">
                <h3>{language === "de" ? "Mein aktueller Status" : "My current status"}</h3>
                <small className="muted">
                  {language === "de" ? "Aktuelle Uhrzeit" : "Current time"}:{" "}
                  <b>{now.toLocaleTimeString(language === "de" ? "de-DE" : "en-US")}</b>
                </small>
                <WorkHoursGauge
                  language={language}
                  netHours={gaugeNetHours}
                  requiredHours={requiredDailyHours}
                  compact
                />
                {timeCurrent?.clock_entry_id ? (
                  <div className="overview-status-running-row">
                    <small className="muted">
                      {language === "de" ? "Schicht seit" : "Shift since"}:{" "}
                      {new Date(timeCurrent.clock_in || "").toLocaleTimeString(language === "de" ? "de-DE" : "en-US")}
                    </small>
                    <button onClick={clockOut}>{language === "de" ? "Ausstempeln" : "Clock out"}</button>
                  </div>
                ) : (
                  <div className="overview-status-actions">
                    <small className="muted">{language === "de" ? "Keine offene Schicht." : "No open shift."}</small>
                    <button onClick={clockIn}>{language === "de" ? "Einstempeln" : "Clock in"}</button>
                  </div>
                )}
              </div>

              <div className="card overview-card">
                <h3>{language === "de" ? "Meine Projekte" : "My projects"}</h3>
                <ul className="overview-list">
                  {recentAssignedProjects.map((project) => (
                    <li key={project.id}>
                      <button
                        className="linklike overview-list-item"
                        onClick={() => {
                          setActiveProjectId(project.id);
                          setProjectTab("tasks");
                          setProjectBackView(null);
                          setMainView("project");
                        }}
                      >
                        <b>
                          {(project.customer_name ?? "").trim() || "-"} | {project.project_number}
                        </b>
                        <small>{project.name}</small>
                      </button>
                    </li>
                  ))}
                  {recentAssignedProjects.length === 0 && (
                    <li className="muted">
                      {language === "de" ? "Keine zugewiesenen Projekte." : "No assigned projects."}
                    </li>
                  )}
                </ul>
              </div>

              <div className="card overview-card">
                <div className="overview-filter-row">
                  <div className="overview-filter-title-row">
                    <h3>{language === "de" ? "Projektübersicht" : "Projects overview"}</h3>
                    <button
                      type="button"
                      className="icon-btn overview-open-full-btn"
                      onClick={() => {
                        setProjectBackView(null);
                        setMainView("projects_all");
                      }}
                      aria-label={language === "de" ? "Alle Projekte öffnen" : "Open all projects"}
                      title={language === "de" ? "Alle Projekte öffnen" : "Open all projects"}
                    >
                      <span aria-hidden>≡</span>
                      <span>{language === "de" ? "Liste" : "List"}</span>
                    </button>
                  </div>
                  <div className="overview-state-filter">
                    <span>{language === "de" ? "Status" : "State"}</span>
                    <select
                      aria-label={language === "de" ? "Status auswählen" : "Select state"}
                      value={overviewStatusFilter}
                      onChange={(event) => setOverviewStatusFilter(event.target.value)}
                    >
                      <option value="all">{language === "de" ? "Alle Status" : "All states"}</option>
                      {overviewStatusOptions.map((statusValue) => (
                        <option key={statusValue} value={statusValue}>
                          {statusLabel(statusValue, language)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <ul className="overview-list">
                  {filteredDetailedOverview.map((row) => {
                    const projectId = Number(row.project_id);
                    const customerName = String(row.customer_name ?? "").trim() || "-";
                    const projectNumber = row.project_number ?? row.project_id;
                    return (
                      <li key={row.project_id}>
                        <button
                          className="linklike overview-list-item"
                          onClick={() => {
                            if (!projectId) return;
                            setActiveProjectId(projectId);
                            setProjectTab("tasks");
                            setProjectBackView(null);
                            setMainView("project");
                          }}
                        >
                          <b>
                            {projectNumber} | {customerName}
                          </b>
                          <small>
                            {language === "de" ? "Offene Aufgaben" : "Open tasks"}: {row.open_tasks} |{" "}
                            {language === "de" ? "Standorte" : "Sites"}: {row.sites} |{" "}
                            {statusLabel(String(row.status ?? ""), language)}
                          </small>
                        </button>
                      </li>
                    );
                  })}
                  {filteredDetailedOverview.length === 0 && (
                    <li className="muted">
                      {language === "de" ? "Keine Projekte in diesem Status." : "No projects in this state."}
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </section>
        )}

        {mainView === "projects_all" && (
          <section className="card projects-all-card">
            <div className="projects-all-head">
              <button
                type="button"
                onClick={() => {
                  setProjectBackView(null);
                  setMainView("overview");
                }}
              >
                {language === "de" ? "Zur Übersicht" : "Back to overview"}
              </button>
            </div>
            <div className="projects-all-filters">
              <label className="projects-all-search">
                {language === "de" ? "Projektsuche" : "Project search"}
                <input
                  value={projectsAllSearch}
                  onChange={(event) => setProjectsAllSearch(event.target.value)}
                  placeholder={language === "de" ? "Nummer, Kunde oder Projektname" : "Number, customer, or project name"}
                />
              </label>
              <label>
                {language === "de" ? "Status" : "State"}
                <select
                  value={projectsAllStateFilter}
                  onChange={(event) => setProjectsAllStateFilter(event.target.value)}
                >
                  <option value="all">{language === "de" ? "Alle Status" : "All states"}</option>
                  {overviewStatusOptions.map((statusValue) => (
                    <option key={statusValue} value={statusValue}>
                      {statusLabel(statusValue, language)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {language === "de" ? "Letzte Änderung" : "Last edited"}
                <select
                  value={projectsAllEditedFilter}
                  onChange={(event) => setProjectsAllEditedFilter(event.target.value)}
                >
                  <option value="all">{language === "de" ? "Alle" : "Any time"}</option>
                  <option value="7d">{language === "de" ? "Letzte 7 Tage" : "Last 7 days"}</option>
                  <option value="30d">{language === "de" ? "Letzte 30 Tage" : "Last 30 days"}</option>
                  <option value="90d">{language === "de" ? "Letzte 90 Tage" : "Last 90 days"}</option>
                  <option value="older">{language === "de" ? "Älter als 90 Tage" : "Older than 90 days"}</option>
                  <option value="missing">{language === "de" ? "Ohne Datum" : "Without date"}</option>
                </select>
              </label>
            </div>

            <ul className="overview-list projects-all-list">
              {filteredProjectsAll.map((row) => {
                const projectId = Number(row.project_id);
                const lastEditedLabel =
                  row.last_status_at && Number(row.last_status_timestamp) > 0
                    ? new Date(row.last_status_at).toLocaleString(language === "de" ? "de-DE" : "en-US")
                    : "-";
                return (
                  <li key={`all-project-${row.project_id}`}>
                    <button
                      className="linklike overview-list-item"
                      onClick={() => {
                        if (!projectId) return;
                        setActiveProjectId(projectId);
                        setProjectTab("tasks");
                        setProjectBackView("projects_all");
                        setMainView("project");
                      }}
                    >
                      <b>
                        {row.project_number} | {row.customer_name}
                      </b>
                      <small>
                        {language === "de" ? "Offene Aufgaben" : "Open tasks"}: {row.open_tasks} |{" "}
                        {language === "de" ? "Standorte" : "Sites"}: {row.sites} |{" "}
                        {statusLabel(String(row.status ?? ""), language)}
                      </small>
                      <small>
                        {language === "de" ? "Letzter Stand" : "Last state"}: {row.last_state} |{" "}
                        {language === "de" ? "Letzte Änderung" : "Last edited"}: {lastEditedLabel}
                      </small>
                    </button>
                  </li>
                );
              })}
              {filteredProjectsAll.length === 0 && (
                <li className="muted">
                  {language === "de" ? "Keine Projekte mit diesem Filter." : "No projects for this filter."}
                </li>
              )}
            </ul>
          </section>
        )}

        {mainView === "projects_archive" && (
          <section className="card">
            <h3>{language === "de" ? "Projektarchiv" : "Project archive"}</h3>
            <ul className="overview-list">
              {archivedProjects.map((project) => {
                const lastEditedLabel = project.last_status_at
                  ? new Date(project.last_status_at).toLocaleString(language === "de" ? "de-DE" : "en-US")
                  : "-";
                return (
                  <li key={`archive-project-${project.id}`}>
                    <div className="overview-list-item archive-list-item">
                      <b>
                        {project.project_number} | {(project.customer_name ?? "").trim() || "-"}
                      </b>
                      <small>{project.name}</small>
                      <small>
                        {language === "de" ? "Letzter Stand" : "Last state"}: {project.last_state || "-"} |{" "}
                        {language === "de" ? "Letzte Änderung" : "Last edited"}: {lastEditedLabel}
                      </small>
                      <div className="row wrap task-actions task-actions-left">
                        {canCreateProject ? (
                          <>
                            <button type="button" onClick={() => void unarchiveProject(project.id)}>
                              {language === "de" ? "Wiederherstellen" : "Unarchive"}
                            </button>
                            <button
                              type="button"
                              className="danger-btn"
                              onClick={() => void deleteProjectById(project.id)}
                            >
                              {language === "de" ? "Löschen" : "Delete"}
                            </button>
                          </>
                        ) : (
                          <small className="muted">
                            {language === "de"
                              ? "Keine Rechte zum Bearbeiten des Archivs."
                              : "No permission to modify archive entries."}
                          </small>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
              {archivedProjects.length === 0 && (
                <li className="muted">{language === "de" ? "Keine archivierten Projekte." : "No archived projects."}</li>
              )}
            </ul>
          </section>
        )}

        {mainView === "my_tasks" && (
          <section className="card my-tasks-section">
            <div className="tasks-list-head tasks-header-row">
              <h3>{language === "de" ? "Meine Aufgaben" : "My tasks"}</h3>
              {myTasksBackProjectId && (
                <button
                  type="button"
                  className="icon-btn header-back-btn"
                  onClick={() => {
                    setActiveProjectId(myTasksBackProjectId);
                    setProjectTab("tasks");
                    setProjectBackView(null);
                    setMainView("project");
                    setMyTasksBackProjectId(null);
                  }}
                >
                  <BackIcon />
                  <span>{language === "de" ? "Zurück zum Projekt" : "Back to project"}</span>
                </button>
              )}
            </div>
            <ul className="task-list">
              {tasks.map((task) => {
                const isMine = isTaskAssignedToCurrentUser(task);
                const expanded = expandedMyTaskId === task.id;
                const taskProject = projectsById.get(task.project_id);
                return (
                  <li key={task.id} className={isMine ? "task-list-item task-list-item-mine" : "task-list-item"}>
                    <div className="task-list-main">
                      <button
                        type="button"
                        className="task-expand-header"
                        onClick={() => setExpandedMyTaskId(expanded ? null : task.id)}
                        aria-expanded={expanded}
                      >
                        <b>
                          #{task.id} {task.title}
                        </b>
                        <span className="task-expand-chevron" aria-hidden="true">
                          {expanded ? "▾" : "▸"}
                        </span>
                      </button>
                      <small>
                        {language === "de" ? "Fällig" : "Due"}: {task.due_date ?? "-"}
                        {task.start_time ? ` ${language === "de" ? "um" : "at"} ${formatTaskStartTime(task.start_time)}` : ""} |{" "}
                        {language === "de" ? "Status" : "Status"}: {task.status}
                      </small>
                      {expanded && (
                        <div className="task-expanded-content">
                          <small>
                            {language === "de" ? "Projekt" : "Project"}:{" "}
                            <b>{taskProject ? `${taskProject.project_number} - ${taskProject.name}` : `#${task.project_id}`}</b>
                          </small>
                          <small>
                            {language === "de" ? "Mitarbeiter" : "Assignees"}: <b>{getTaskAssigneeLabel(task)}</b>
                          </small>
                          <small>
                            {language === "de" ? "Information" : "Information"}: <b>{task.description || "-"}</b>
                          </small>
                          <small>
                            {language === "de" ? "Material" : "Materials"}: <b>{task.materials_required || "-"}</b>
                          </small>
                          <small>
                            {language === "de" ? "Lagerbox" : "Storage box"}: <b>{task.storage_box_number ?? "-"}</b>
                          </small>
                        </div>
                      )}
                    </div>
                    <div className="row wrap task-actions">
                      {canManageTasks && (
                        <button
                          type="button"
                          className="icon-btn task-edit-icon-btn"
                          onClick={() => openTaskEditModal(task)}
                          aria-label={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                          title={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                        >
                          <PenIcon />
                        </button>
                      )}
                      <button type="button" onClick={() => openProjectFromTask(task)}>
                        {language === "de" ? "Zum Projekt" : "Go to project"}
                      </button>
                      {isMine && (
                        <button type="button" onClick={() => void exportTaskCalendar(task)}>
                          {language === "de" ? "Kalender" : "Calendar"}
                        </button>
                      )}
                      {isMine && (
                        <button
                          type="button"
                          onClick={() =>
                            task.status !== "done"
                              ? void markTaskDone(task.id, { openReportFromTask: task, reportBackView: "my_tasks" })
                              : openConstructionReportFromTask(task, "my_tasks")
                          }
                        >
                          {language === "de" ? "Bericht aus Aufgabe" : "Report from task"}
                        </button>
                      )}
                      {isMine && task.status !== "done" && (
                        <button type="button" onClick={() => void markTaskDone(task.id)}>
                          {language === "de" ? "Als erledigt markieren" : "Mark complete"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
              {tasks.length === 0 && <li className="muted">{language === "de" ? "Keine Aufgaben." : "No tasks."}</li>}
            </ul>
          </section>
        )}

        {mainView === "project" && !activeProject && (
          <section className="card">
            <h3>{language === "de" ? "Kein Projekt ausgewählt" : "No project selected"}</h3>
            <p>
              {language === "de"
                ? "Waehle links ein Projekt aus."
                : "Select a project from the left list."}
            </p>
          </section>
        )}

        {mainView === "project" && activeProject && projectTab === "tasks" && (
          <section className="grid">
            {canManageTasks && (
              <form className="card project-task-create-card" onSubmit={createTask}>
                <h3>{language === "de" ? "Aufgabe erstellen" : "Create task"}</h3>
                <label>
                  {language === "de" ? "Titel" : "Title"}
                  <input
                    value={projectTaskForm.title}
                    onChange={(event) => updateProjectTaskFormField("title", event.target.value)}
                    placeholder={language === "de" ? "Aufgabentitel" : "Task title"}
                    required
                  />
                </label>
                <label>
                  {language === "de" ? "Information" : "Information"}
                  <textarea
                    value={projectTaskForm.description}
                    onChange={(event) => updateProjectTaskFormField("description", event.target.value)}
                    placeholder={language === "de" ? "Beschreibung der Aufgabe" : "Task description"}
                  />
                </label>
                <label>
                  {language === "de" ? "Benötigte Materialien" : "Required materials"}
                  <textarea
                    value={projectTaskForm.materials_required}
                    onChange={(event) => updateProjectTaskFormField("materials_required", event.target.value)}
                    placeholder={
                      language === "de"
                        ? "z.B. Kabel, Wechselrichter, Montagematerial"
                        : "e.g. cables, inverter, mounting kit"
                    }
                  />
                </label>
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={projectTaskForm.has_storage_box}
                    onChange={(event) =>
                      setProjectTaskForm((current) => ({
                        ...current,
                        has_storage_box: event.target.checked,
                        storage_box_number: event.target.checked ? current.storage_box_number : "",
                      }))
                    }
                  />
                  {language === "de"
                    ? "Material aus Lagerbox verwenden"
                    : "Use materials from warehouse box"}
                </label>
                {projectTaskForm.has_storage_box && (
                  <label>
                    {language === "de" ? "Lagerbox-Nummer" : "Storage box number"}
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={projectTaskForm.storage_box_number}
                      onChange={(event) => updateProjectTaskFormField("storage_box_number", event.target.value)}
                      required
                    />
                  </label>
                )}
                <div className="row wrap">
                  <label>
                    {language === "de" ? "Fälligkeitsdatum" : "Due date"}
                    <input
                      type="date"
                      value={projectTaskForm.due_date}
                      onChange={(event) => updateProjectTaskFormField("due_date", event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    {language === "de" ? "Startzeit" : "Start time"}
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="HH:MM"
                      pattern={HHMM_PATTERN}
                      title="HH:MM (24h)"
                      maxLength={5}
                      value={projectTaskForm.start_time}
                      onChange={(event) => updateProjectTaskFormField("start_time", event.target.value)}
                      required
                    />
                  </label>
                </div>
                <div className="assignee-search-block">
                  <b>{language === "de" ? "Personen zuweisen" : "Assign people"}</b>
                  <input
                    value={projectTaskForm.assignee_query}
                    onChange={(event) => updateProjectTaskFormField("assignee_query", event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addFirstMatchingProjectTaskAssignee();
                    }}
                    placeholder={
                      language === "de"
                        ? "Namen eingeben und auswählen"
                        : "Type user name and select"
                    }
                  />
                  {projectTaskAssigneeSuggestions.length > 0 && (
                    <div className="assignee-suggestions">
                      {projectTaskAssigneeSuggestions.map((assignee) => (
                        <button
                          key={assignee.id}
                          type="button"
                          className="assignee-suggestion-btn"
                          onClick={() => addProjectTaskAssignee(assignee.id)}
                        >
                          {assignee.full_name} (#{assignee.id})
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="assignee-chip-list">
                    {projectTaskForm.assignee_ids.map((assigneeId) => {
                      const assignee = assignableUsers.find((entry) => entry.id === assigneeId);
                      return (
                        <button
                          key={assigneeId}
                          type="button"
                          className="assignee-chip"
                          onClick={() => removeProjectTaskAssignee(assigneeId)}
                          title={language === "de" ? "Entfernen" : "Remove"}
                        >
                          {(assignee?.full_name ?? `#${assigneeId}`) + " ×"}
                        </button>
                      );
                    })}
                    {projectTaskForm.assignee_ids.length === 0 && (
                      <small className="muted">
                        {language === "de"
                          ? "Noch keine Personen ausgewählt."
                          : "No people selected yet."}
                      </small>
                    )}
                  </div>
                </div>
                <button type="submit">{language === "de" ? "Speichern" : "Save"}</button>
              </form>
            )}
            <div className="card tasks-list-card">
              <div className="tasks-list-head">
                <h3>{language === "de" ? "Aufgaben" : "Tasks"}</h3>
              </div>
              <div className="row wrap task-view-toggle">
                <button
                  type="button"
                  className={taskView === "my" ? "active" : ""}
                  onClick={() => setTaskView("my")}
                >
                  {language === "de" ? "Meine Aufgaben" : "My tasks"}
                </button>
                <button
                  type="button"
                  className={taskView === "all_open" ? "active" : ""}
                  onClick={() => setTaskView("all_open")}
                >
                  {language === "de" ? "Alle offenen Aufgaben" : "All open tasks"}
                </button>
              </div>
              <ul>
                {tasks.map((task) => {
                  const isMine = isTaskAssignedToCurrentUser(task);
                  return (
                    <li
                      key={task.id}
                      className={
                        isMine
                          ? "task-list-item task-list-item-mine task-list-item-clickable"
                          : "task-list-item"
                      }
                      onClick={isMine ? () => openTaskFromProject(task) : undefined}
                      onKeyDown={
                        isMine
                          ? (event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openTaskFromProject(task);
                              }
                            }
                          : undefined
                      }
                      role={isMine ? "button" : undefined}
                      tabIndex={isMine ? 0 : undefined}
                    >
                      <div className="task-list-main">
                        <b>
                          #{task.id} {task.title} [{task.status}]
                        </b>
                        <small>
                          {language === "de" ? "Fällig" : "Due"}: {task.due_date ?? "-"}
                          {task.start_time ? ` ${language === "de" ? "um" : "at"} ${formatTaskStartTime(task.start_time)}` : ""} |{" "}
                          {language === "de" ? "Mitarbeiter" : "Assignees"}: {getTaskAssigneeLabel(task)}
                        </small>
                        {(task.description || task.materials_required || task.storage_box_number) && (
                          <small>
                            {task.description ? `${language === "de" ? "Info" : "Info"}: ${task.description}` : ""}
                            {task.description && (task.materials_required || task.storage_box_number) ? " | " : ""}
                            {task.materials_required
                              ? `${language === "de" ? "Material" : "Materials"}: ${task.materials_required}`
                              : ""}
                            {task.storage_box_number
                              ? ` | ${language === "de" ? "Lagerbox" : "Storage box"}: ${task.storage_box_number}`
                              : ""}
                          </small>
                        )}
                      </div>
                      <div className="row wrap task-actions">
                        {canManageTasks && (
                          <button
                            type="button"
                            className="icon-btn task-edit-icon-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              openTaskEditModal(task);
                            }}
                            aria-label={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                            title={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                          >
                            <PenIcon />
                          </button>
                        )}
                        {getTaskAssigneeIds(task).includes(user.id) && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void exportTaskCalendar(task);
                            }}
                          >
                            {language === "de" ? "Kalender" : "Calendar"}
                          </button>
                        )}
                        {getTaskAssigneeIds(task).includes(user.id) && task.status !== "done" && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void markTaskDone(task.id);
                            }}
                          >
                            {language === "de" ? "Erledigt" : "Complete"}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        )}

        {mainView === "planning" && (
          <section className="card planning-only">
            <div className="row wrap planning-toolbar">
              <h3>{language === "de" ? "Kalenderansicht" : "Calendar view"}</h3>
              <div className="row planning-week-nav" role="group" aria-label={language === "de" ? "Wochenwechsel" : "Week switch"}>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={language === "de" ? "Vorherige Woche" : "Previous week"}
                  title={language === "de" ? "Vorherige Woche" : "Previous week"}
                  onClick={() => setPlanningWeekStart((current) => normalizeWeekStartISO(addDaysISO(current, -7)))}
                >
                  ←
                </button>
                <div className="planning-week-number">
                  {language === "de" ? "KW" : "CW"} {planningWeekInfo.week}/{planningWeekInfo.year}
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={language === "de" ? "Nächste Woche" : "Next week"}
                  title={language === "de" ? "Nächste Woche" : "Next week"}
                  onClick={() => setPlanningWeekStart((current) => normalizeWeekStartISO(addDaysISO(current, 7)))}
                >
                  →
                </button>
              </div>
              <label className="planning-week-picker">
                {language === "de" ? "Wochenstart (Montag)" : "Week start (Monday)"}
                <input
                  type="date"
                  value={planningWeekStart}
                  onChange={(e) => setPlanningWeekStart(normalizeWeekStartISO(e.target.value))}
                  required
                />
              </label>
            </div>
            <div className="planning-calendar-scroll">
              <div className="planning-calendar">
              {(planningWeek?.days ?? []).map((day) => (
                <div key={day.date} className={day.date === todayIso ? "planning-day planning-day-today" : "planning-day"}>
                  <div className="planning-day-head">{formatDayLabel(day.date, language)}</div>
                  <ul>
                    {(day.absences ?? []).map((absence, index) => (
                      <li key={`absence-${day.date}-${absence.type}-${absence.user_id}-${index}`} className="planning-absence">
                        <b>
                          {absence.user_name}: {absence.label}
                        </b>
                        <small>
                          {absence.type === "vacation"
                            ? language === "de"
                              ? "Urlaub"
                              : "Vacation"
                            : language === "de"
                              ? "Schule"
                              : "School"}
                        </small>
                      </li>
                    ))}
                    {day.tasks.map((task) => {
                      const isMine = isTaskAssignedToCurrentUser(task);
                      return (
                        <li
                          key={task.id}
                          className={isMine ? "planning-task planning-task-mine planning-task-clickable" : "planning-task"}
                          onClick={isMine ? () => openTaskFromPlanning(task) : undefined}
                          onKeyDown={
                            isMine
                              ? (event) => {
                                  if (event.key === "Enter" || event.key === " ") {
                                    event.preventDefault();
                                    openTaskFromPlanning(task);
                                  }
                                }
                              : undefined
                          }
                          role={isMine ? "button" : undefined}
                          tabIndex={isMine ? 0 : undefined}
                        >
                          <b>{task.title}</b>
                          <small>
                            #{task.id} |{" "}
                            {projects.find((project) => project.id === task.project_id)?.project_number ??
                              projects.find((project) => project.id === task.project_id)?.name ??
                              task.project_id}{" "}
                            {task.start_time ? ` | ${formatTaskStartTime(task.start_time)}` : ""} | {getTaskAssigneeLabel(task)}
                          </small>
                          <div className="row wrap task-actions task-actions-left">
                            {canManageTasks && (
                              <button
                                type="button"
                                className="icon-btn task-edit-icon-btn"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openTaskEditModal(task);
                                }}
                                aria-label={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                                title={language === "de" ? "Aufgabe bearbeiten" : "Edit task"}
                              >
                                <PenIcon />
                              </button>
                            )}
                            {isMine && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void exportTaskCalendar(task);
                                }}
                              >
                                {language === "de" ? "Kalender" : "Calendar"}
                              </button>
                            )}
                            {isMine && task.status !== "done" && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void markTaskDone(task.id);
                                }}
                              >
                                {language === "de" ? "Erledigt" : "Complete"}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                    {day.tasks.length === 0 && (day.absences ?? []).length === 0 && <li className="muted">-</li>}
                  </ul>
                </div>
              ))}
              </div>
            </div>
          </section>
        )}

        {mainView === "project" && activeProject && projectTab === "tickets" && (
          <section className="grid">
            <form className="card" onSubmit={createTicket}>
              <h3>{language === "de" ? "Job Ticket erstellen" : "Create job ticket"}</h3>
              <input name="title" placeholder="Title" required />
              <small className="muted">
                {language === "de" ? "Projektadresse" : "Project address"}: <b>{activeProjectTicketAddress}</b>
              </small>
              <small className="muted">
                {language === "de" ? "Projektdatum" : "Project date"}: <b>{activeProjectTicketDate}</b>
              </small>
              <input
                name="assigned_crew"
                placeholder={language === "de" ? "Team (kommagetrennt)" : "Crew (comma separated)"}
              />
              <textarea name="notes" placeholder={language === "de" ? "Notizen" : "Notes"} />
              <button type="submit">{language === "de" ? "Ticket speichern" : "Save ticket"}</button>
            </form>
            <div className="card">
              <h3>Tickets</h3>
              <ul>
                {tickets.map((ticket) => (
                  <li key={ticket.id}>
                    <span>
                      {ticket.title} ({ticket.ticket_date})
                    </span>
                    <a target="_blank" rel="noreferrer" href={`/api/projects/${activeProjectId}/job-tickets/${ticket.id}/print`}>
                      {language === "de" ? "Drucken" : "Print"}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <form className="card" onSubmit={uploadTicketAttachment}>
              <h3>{language === "de" ? "Ticket-Anhang" : "Ticket attachment"}</h3>
              <input type="number" name="ticket_id" placeholder="Ticket ID" required />
              <input type="file" name="file" required />
              <button type="submit">{language === "de" ? "Hochladen" : "Upload"}</button>
            </form>
          </section>
        )}

        {mainView === "project" && activeProject && projectTab === "files" && (
          <section className="grid files-grid">
            <div className="card">
              <div className="file-explorer-head">
                <h3>{language === "de" ? "Online Datei-Explorer" : "Online file explorer"}</h3>
                <div className="row">
                  <input
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    placeholder={language === "de" ? "Datei suchen" : "Search file"}
                  />
                  <button
                    type="button"
                    className="icon-btn upload-arrow-btn"
                    aria-label={language === "de" ? "Datei hochladen" : "Upload file"}
                    title={language === "de" ? "Datei hochladen" : "Upload file"}
                    onClick={() => {
                      if (!fileUploadFolder) {
                        const fallback = projectFolders.find((folder) => canUseProtectedFolders || !folder.is_protected);
                        if (fallback) setFileUploadFolder(fallback.path);
                      }
                      setFileUploadModalOpen(true);
                    }}
                  >
                    ↑
                  </button>
                  <div className="webdav-help">
                    <button type="button" className="icon-btn" aria-label="WebDAV info">
                      ⚙
                    </button>
                    <div className="webdav-tooltip">
                      <p>
                        {language === "de"
                          ? "Dateien wie in SharePoint per WebDAV im Betriebssystem einbinden:"
                          : "SharePoint-like OS integration via WebDAV:"}
                      </p>
                      <small>{language === "de" ? "Alle Projekte:" : "All projects:"}</small>
                      <div className="webdav-copy-row">
                        <code>{`${window.location.origin}/api/dav/projects/`}</code>
                        <button
                          type="button"
                          className="webdav-copy-btn"
                          onClick={() => void copyToClipboard(`${window.location.origin}/api/dav/projects/`, "all")}
                        >
                          {language === "de" ? "Kopieren" : "Copy"}
                        </button>
                      </div>
                      <small>{language === "de" ? "Nur aktuelles Projekt:" : "Current project only:"}</small>
                      <div className="webdav-copy-row">
                        <code>{`${window.location.origin}/api/dav/projects/${activeProjectId}/`}</code>
                        <button
                          type="button"
                          className="webdav-copy-btn"
                          onClick={() =>
                            void copyToClipboard(`${window.location.origin}/api/dav/projects/${activeProjectId}/`, "project")
                          }
                        >
                          {language === "de" ? "Kopieren" : "Copy"}
                        </button>
                      </div>
                      <small>
                        {language === "de"
                          ? "macOS Finder: Gehe zu > Mit Server verbinden (Cmd+K). Anmeldung mit App-E-Mail + Passwort."
                          : "macOS Finder: Go > Connect to Server (Cmd+K). Sign in with app email + password."}
                      </small>
                      <small>
                        {language === "de"
                          ? "Wichtig: URL mit abschließendem / verwenden. Für andere Geräte im LAN: http://<SERVER-LAN-IP>/api/dav/projects/PROJEKT-ID/"
                          : "Important: use URL with trailing /. For other devices on LAN: http://<SERVER-LAN-IP>/api/dav/projects/PROJECT-ID/"}
                      </small>
                      <small>
                        {language === "de"
                          ? "Wenn HTTPS-Zertifikat auf fremden Geräten fehlschlägt, LAN-HTTP nur im vertrauenswürdigen Netzwerk nutzen."
                          : "If HTTPS certificate trust fails on other devices, use LAN HTTP only on trusted networks."}
                      </small>
                    </div>
                  </div>
                </div>
              </div>
              <div className="file-explorer">
                <div className="file-row file-row-head">
                  <b>{language === "de" ? "Datei" : "File"}</b>
                  <b>{language === "de" ? "Ordner" : "Folder"}</b>
                  <b>{language === "de" ? "Typ" : "Type"}</b>
                  <b>{language === "de" ? "Hochgeladen" : "Uploaded"}</b>
                  <b>{language === "de" ? "Aktion" : "Action"}</b>
                </div>
                {fileRows.map((file) => (
                  <div key={file.id} className="file-row">
                    <span>{file.file_name}</span>
                    <small>{file.folder || "/"}</small>
                    <small>{file.content_type}</small>
                    <small>{new Date(file.created_at).toLocaleString(language === "de" ? "de-DE" : "en-US")}</small>
                    <div className="row wrap">
                      {isPreviewable(file) && (
                        <a href={filePreviewUrl(file.id)} target="_blank" rel="noreferrer">
                          {language === "de" ? "Vorschau" : "Preview"}
                        </a>
                      )}
                      <a href={fileDownloadUrl(file.id)} target="_blank" rel="noreferrer">
                        {language === "de" ? "Download" : "Download"}
                      </a>
                    </div>
                  </div>
                ))}
                {fileRows.length === 0 && <small className="muted">{language === "de" ? "Keine Treffer" : "No files found"}</small>}
              </div>
            </div>
          </section>
        )}
        {fileUploadModalOpen && mainView === "project" && activeProject && projectTab === "files" && (
          <div className="modal-backdrop" onClick={() => setFileUploadModalOpen(false)}>
            <div className="card modal-card modal-card-sm" onClick={(event) => event.stopPropagation()}>
              <h3>{language === "de" ? "Datei hochladen" : "Upload file"}</h3>
              <form className="modal-form" onSubmit={uploadFile}>
                <label>
                  {language === "de" ? "Zielordner" : "Target folder"}
                  <select value={fileUploadFolder} onChange={(event) => setFileUploadFolder(event.target.value)}>
                    {projectFolders
                      .filter((folder) => canUseProtectedFolders || !folder.is_protected)
                      .map((folder) => (
                        <option key={folder.path} value={folder.path}>
                          {folder.path}
                        </option>
                      ))}
                  </select>
                </label>
                <div className="row wrap">
                  <input
                    value={newProjectFolderPath}
                    onChange={(event) => setNewProjectFolderPath(event.target.value)}
                    placeholder={language === "de" ? "Neuer Ordnerpfad (z.B. Bilder/Tag2)" : "New folder path (e.g. Bilder/Tag2)"}
                  />
                  <button type="button" onClick={() => void createProjectFolderFromInput()}>
                    {language === "de" ? "Ordner anlegen" : "Create folder"}
                  </button>
                </div>
                <input type="file" name="file" required />
                <div className="row wrap">
                  <button type="submit">{language === "de" ? "Hochladen" : "Upload"}</button>
                  <button type="button" onClick={() => setFileUploadModalOpen(false)}>
                    {language === "de" ? "Abbrechen" : "Cancel"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {avatarModalOpen && (
          <div className="modal-backdrop" onClick={closeAvatarModal}>
            <div className="card modal-card modal-card-sm" onClick={(event) => event.stopPropagation()}>
              <h3>{language === "de" ? "Profilbild anpassen" : "Adjust profile picture"}</h3>
              <label>
                {language === "de" ? "Bilddatei" : "Image file"}
                <input type="file" accept="image/*" onChange={onAvatarFileChange} />
              </label>
              {!avatarSourceUrl && (
                <small className="muted">
                  {language === "de"
                    ? "Bild auswählen, dann Bild mit der Maus/Finger verschieben und Zoom anpassen."
                    : "Choose an image, then drag the picture and adjust zoom."}
                </small>
              )}
              {avatarSourceUrl && (
                <div className="avatar-crop-section">
                  <div className="avatar-crop-editor">
                    <div
                      className={avatarIsDragging ? "avatar-crop-stage dragging" : "avatar-crop-stage"}
                      ref={avatarCropStageRef}
                      onPointerDown={onAvatarDragStart}
                      onPointerMove={onAvatarDragMove}
                      onPointerUp={onAvatarDragEnd}
                      onPointerCancel={onAvatarDragEnd}
                    >
                      <img
                        src={avatarSourceUrl}
                        alt=""
                        className="avatar-crop-image"
                        draggable={false}
                        style={{
                          transform: `translate(${avatarStageState.translateX}px, ${avatarStageState.translateY}px) scale(${avatarZoom})`,
                        }}
                      />
                      <div className="avatar-crop-focus" />
                    </div>
                    <div className="avatar-crop-preview-wrap">
                      {avatarPreviewDataUrl ? (
                        <img src={avatarPreviewDataUrl} alt="" className="avatar-crop-preview" />
                      ) : (
                        <div className="avatar-crop-preview avatar-crop-placeholder" />
                      )}
                    </div>
                  </div>
                  <div className="avatar-crop-controls">
                    <label>
                      {language === "de" ? "Zoom" : "Zoom"}
                      <input
                        type="range"
                        min={1}
                        max={3}
                        step={0.05}
                        value={avatarZoom}
                        onChange={(event) => setAvatarZoom(Number(event.target.value))}
                      />
                    </label>
                  </div>
                </div>
              )}
              <div className="row wrap">
                <button type="button" onClick={() => void saveAvatar()} disabled={!avatarPreviewDataUrl}>
                  {language === "de" ? "Speichern" : "Save"}
                </button>
                <button type="button" onClick={closeAvatarModal}>
                  {language === "de" ? "Abbrechen" : "Cancel"}
                </button>
              </div>
            </div>
          </div>
        )}

        {threadModalMode && mainView === "messages" && (
          <div className="modal-backdrop" onClick={closeThreadModal}>
            <div className="card modal-card modal-card-sm" onClick={(event) => event.stopPropagation()}>
              <h3>
                {threadModalMode === "edit"
                  ? language === "de"
                    ? "Thread bearbeiten"
                    : "Edit thread"
                  : language === "de"
                    ? "Chat erstellen"
                    : "Create chat thread"}
              </h3>
              <form className="modal-form" onSubmit={submitThreadModal}>
                <label>
                  {language === "de" ? "Thread-Name" : "Thread name"}
                  <input
                    name="name"
                    value={threadModalForm.name}
                    onChange={(event) =>
                      setThreadModalForm((current) => ({ ...current, name: event.target.value }))
                    }
                    placeholder={language === "de" ? "Thread-Name" : "Thread name"}
                    required
                    autoFocus
                  />
                </label>
                <label>
                  {language === "de" ? "Projekt (optional)" : "Project (optional)"}
                  <select
                    value={threadModalForm.project_id}
                    onChange={(event) =>
                      setThreadModalForm((current) => ({ ...current, project_id: event.target.value }))
                    }
                  >
                    <option value="">{language === "de" ? "Allgemeiner Thread" : "General thread"}</option>
                    {projects.map((project) => (
                      <option key={`thread-project-${project.id}`} value={String(project.id)}>
                        {project.project_number} | {(project.customer_name ?? "").trim() || project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {language === "de" ? "Thread-Bild" : "Thread picture"}
                  <input type="file" accept="image/*" onChange={onThreadIconFileChange} />
                </label>
                {threadIconPreviewUrl && (
                  <div className="thread-modal-icon-preview">
                    <img src={threadIconPreviewUrl} alt="" />
                  </div>
                )}
                <div className="row wrap">
                  <button type="submit">
                    {threadModalMode === "edit"
                      ? language === "de"
                        ? "Speichern"
                        : "Save"
                      : language === "de"
                        ? "Erstellen"
                        : "Create"}
                  </button>
                  <button type="button" onClick={closeThreadModal}>
                    {language === "de" ? "Abbrechen" : "Cancel"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {mainView === "construction" && (
          <section className="grid">
            <form ref={constructionFormRef} className="card report-form" onSubmit={submitConstructionReport}>
              <h3>{language === "de" ? "Baustellenbericht" : "Construction report"}</h3>
              {reportTaskPrefill && (
                <small className="muted">
                  {language === "de"
                    ? `Vorlage aus Aufgabe #${reportTaskPrefill.task_id}`
                    : `Template from task #${reportTaskPrefill.task_id}`}
                </small>
              )}
              <label>
                {language === "de" ? "Projekt" : "Project"}
                <select
                  name="project_id"
                  value={reportProjectId}
                  onChange={(event) => applyReportProjectSelection(event.target.value)}
                >
                  <option value="">
                    {language === "de"
                      ? "Allgemeiner Bericht (ohne Projekt)"
                      : "General report (without project)"}
                  </option>
                  {projects.map((project) => (
                    <option key={project.id} value={String(project.id)}>
                      {project.project_number} - {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {language === "de" ? "Datum" : "Date"}
                <input type="date" name="report_date" defaultValue={todayIso} required />
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
                <textarea name="work_done" placeholder={language === "de" ? "Was wurde gemacht?" : "What was completed?"} />
              </label>

              <label>
                {language === "de" ? "Vorkommnisse / Absprachen" : "Incidents / agreements"}
                <textarea name="incidents" />
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
                      placeholder={language === "de" ? "Name" : "Name"}
                      onChange={(e) => updateReportWorker(index, "name", e.target.value)}
                    />
                    <input
                      value={worker.start_time}
                      placeholder="07:30"
                      inputMode="numeric"
                      pattern={HHMM_PATTERN}
                      title="HH:MM (24h)"
                      maxLength={5}
                      onChange={(e) => updateReportWorker(index, "start_time", e.target.value)}
                    />
                    <input
                      value={worker.end_time}
                      placeholder="16:00"
                      inputMode="numeric"
                      pattern={HHMM_PATTERN}
                      title="HH:MM (24h)"
                      maxLength={5}
                      onChange={(e) => updateReportWorker(index, "end_time", e.target.value)}
                    />
                    <button type="button" onClick={() => removeReportWorkerRow(index)}>
                      {language === "de" ? "Entfernen" : "Remove"}
                    </button>
                  </div>
                ))}
                <button type="button" onClick={addReportWorkerRow}>
                  {language === "de" ? "Mitarbeiter hinzufügen" : "Add worker"}
                </button>
              </div>

              <label>
                {language === "de" ? "Material (eine Zeile: Artikel|Menge|Einheit|ArtNr)" : "Materials (one line: Item|Qty|Unit|Article)"}
                <textarea name="materials" />
              </label>
              <label>
                {language === "de" ? "Zusatzarbeiten (eine Zeile: Beschreibung|Grund)" : "Extras (one line: Description|Reason)"}
                <textarea name="extras" />
              </label>
              <label>
                {language === "de" ? "Büro Materialbedarf" : "Office material need"}
                <textarea name="office_material_need" />
              </label>
              <label>
                {language === "de" ? "Büro Nacharbeiten" : "Office rework"}
                <textarea name="office_rework" />
              </label>
              <label>
                {language === "de" ? "Büro nächste Schritte" : "Office next steps"}
                <textarea name="office_next_steps" />
              </label>
              <label>
                {language === "de" ? "Fotos" : "Photos"}
                <input type="file" name="images" accept="image/*" multiple />
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
              <button type="submit">{language === "de" ? "Bericht speichern" : "Save report"}</button>
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
        )}

        {mainView === "wiki" && (
          <section className="grid wiki-grid wiki-library-grid">
            <div className="card wiki-library-card">
              <div className="row wrap wiki-library-head">
                <h3>{language === "de" ? "Lokale Wiki-Dateien" : "Local wiki files"}</h3>
                <input
                  value={wikiSearch}
                  onChange={(event) => setWikiSearch(event.target.value)}
                  placeholder={language === "de" ? "Datei, Marke oder Ordner suchen" : "Search file, brand, or folder"}
                />
                <button type="button" onClick={() => void loadWikiLibraryFiles()}>
                  {language === "de" ? "Neu laden" : "Refresh"}
                </button>
              </div>
              <small className="muted">
                {language === "de" ? "Dateien gesamt" : "Total files"}: {wikiFiles.length}
              </small>
              <div className="wiki-library-scroll">
                {wikiRows.map((brand) => (
                  <details key={brand.name} className="wiki-brand-group" open>
                    <summary>
                      <b>{brand.name}</b>
                      <small>{brand.folders.length}</small>
                    </summary>
                    {brand.folders.map((folder) => (
                      <details key={`${brand.name}-${folder.path || "__root"}`} className="wiki-folder-group" open>
                        <summary>
                          <span>{folder.path || "/"}</span>
                        </summary>
                        <ul className="wiki-doc-list">
                          {folder.documents.map((document) => (
                            <li key={`${brand.name}-${folder.path}-${document.key}`} className="wiki-doc-item">
                              <div className="wiki-doc-main">
                                <b>{document.label}</b>
                                <small>{document.variants.length} {language === "de" ? "Varianten" : "variants"}</small>
                              </div>
                              <div className="row wrap wiki-doc-actions">
                                {document.variants.map((variant) => (
                                  <button
                                    key={variant.path}
                                    type="button"
                                    className={activeWikiPath === variant.path ? "active" : ""}
                                    onClick={() => setActiveWikiPath(variant.path)}
                                  >
                                    {variant.extension ? variant.extension.toUpperCase() : language === "de" ? "DATEI" : "FILE"}
                                  </button>
                                ))}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ))}
                  </details>
                ))}
                {wikiRows.length === 0 && (
                  <p className="muted">
                    {language === "de"
                      ? "Keine Wiki-Dateien für diese Suche gefunden."
                      : "No wiki files found for this search."}
                  </p>
                )}
              </div>
            </div>

            <div className="card wiki-preview-card">
              <div className="row wrap wiki-preview-head">
                <h3>{language === "de" ? "Vorschau" : "Preview"}</h3>
                {activeWikiFile && (
                  <div className="row wrap">
                    <a href={wikiFileUrl(activeWikiFile.path)} target="_blank" rel="noreferrer">
                      {language === "de" ? "In neuem Tab öffnen" : "Open in new tab"}
                    </a>
                    <a href={wikiFileUrl(activeWikiFile.path, true)} target="_blank" rel="noreferrer">
                      {language === "de" ? "Download" : "Download"}
                    </a>
                  </div>
                )}
              </div>
              {!activeWikiFile && (
                <p className="muted">
                  {language === "de"
                    ? "Bitte links eine Datei auswählen."
                    : "Please select a file on the left."}
                </p>
              )}
              {activeWikiFile && (
                <>
                  <div className="wiki-preview-meta">
                    <b>{activeWikiFile.file_name}</b>
                    <small>{activeWikiFile.path}</small>
                    <small>
                      {formatFileSize(activeWikiFile.size_bytes)} |{" "}
                      {new Date(activeWikiFile.modified_at).toLocaleString(language === "de" ? "de-DE" : "en-US")}
                    </small>
                  </div>
                  {activeWikiFile.previewable ? (
                    <iframe
                      key={activeWikiFile.path}
                      src={wikiFileUrl(activeWikiFile.path)}
                      title={activeWikiFile.file_name}
                      className="wiki-preview-frame"
                    />
                  ) : (
                    <p className="muted">
                      {language === "de"
                        ? "Dateityp nicht direkt im Browser darstellbar. Bitte herunterladen."
                        : "This file type is not directly previewable. Please download it."}
                    </p>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {mainView === "messages" && (
          <section className="chat-layout">
            <aside className="thread-panel">
              <div className="row thread-panel-head">
                <h3>{language === "de" ? "Threads" : "Threads"}</h3>
                <button
                  type="button"
                  className="create-new-btn thread-create-btn"
                  onClick={openCreateThreadModal}
                  aria-label={language === "de" ? "Thread erstellen" : "Create thread"}
                  title={language === "de" ? "Thread erstellen" : "Create thread"}
                >
                  +
                </button>
              </div>
              <ul className="thread-list">
                {threads.map((thread) => (
                  <li key={thread.id}>
                    <button
                      className={activeThreadId === thread.id ? "active thread-item" : "thread-item"}
                      onClick={() => setActiveThreadId(thread.id)}
                    >
                      <ThreadIconBadge
                        threadId={thread.id}
                        initials={threadInitials(thread.name)}
                        hasIcon={Boolean(thread.icon_updated_at)}
                        versionKey={thread.icon_updated_at || "0"}
                        className="thread-avatar-sm"
                      />
                      <span className="thread-item-main">
                        <span className="thread-title-row">
                          <b>{thread.name}</b>
                          {thread.unread_count > 0 && <span className="thread-unread-badge">{thread.unread_count}</span>}
                        </span>
                        <small>
                          {thread.project_name ? `${thread.project_name} | ` : ""}
                          {thread.last_message_preview ?? "-"}
                        </small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>

            <div className="chat-panel">
              {!activeThread && (
                <div className="chat-empty">{language === "de" ? "Bitte einen Thread wählen." : "Please select a thread."}</div>
              )}
              {activeThread && (
                <>
                  <div className="chat-panel-head">
                    <div className="chat-thread-meta">
                      <ThreadIconBadge
                        threadId={activeThread.id}
                        initials={threadInitials(activeThread.name)}
                        hasIcon={Boolean(activeThread.icon_updated_at)}
                        versionKey={activeThread.icon_updated_at || "0"}
                      />
                      <div>
                        <b>{activeThread.name}</b>
                        <small>{activeThread.project_name ?? (language === "de" ? "Allgemein" : "General")}</small>
                      </div>
                    </div>
                    {activeThread.can_edit && (
                      <button
                        type="button"
                        className="icon-btn thread-edit-btn"
                        onClick={() => openEditThreadModal(activeThread)}
                        aria-label={language === "de" ? "Thread bearbeiten" : "Edit thread"}
                        title={language === "de" ? "Thread bearbeiten" : "Edit thread"}
                      >
                        ✎
                      </button>
                    )}
                  </div>

                  <ul ref={messageListRef} onScroll={onMessageListScroll} className="message-list">
                    {chatRenderRows.map((row) => {
                      if (row.kind === "day") {
                        return (
                          <li key={row.key} className="message-day-divider">
                            <span>{row.label}</span>
                          </li>
                        );
                      }
                      const message = row.message;
                      const senderId = message.sender_id;
                      const senderName = userNameById(senderId);
                      return (
                        <li key={row.key} className={row.mine ? "message-row mine" : "message-row other"}>
                          {!row.mine && (
                            <span className="message-avatar-slot" aria-hidden="true">
                              {row.showAvatar ? (
                                <AvatarBadge
                                  userId={senderId}
                                  initials={userInitialsById(senderId)}
                                  hasAvatar={userHasAvatar(senderId)}
                                  versionKey={String(userAvatarVersionById(senderId))}
                                  className="message-sender-avatar"
                                />
                              ) : (
                                <span className="message-avatar-placeholder" />
                              )}
                            </span>
                          )}
                          <div className={row.mine ? "message-bubble mine" : "message-bubble other"}>
                            {row.showSenderName && <small className="message-sender-name">{senderName}</small>}
                            {message.body && <p>{message.body}</p>}
                            {message.attachments.map((attachment) => (
                              <div key={attachment.id} className="chat-attachment">
                                {attachment.content_type.startsWith("image/") && (
                                  <img src={filePreviewUrl(attachment.id)} alt={attachment.file_name} />
                                )}
                                <div className="row wrap">
                                  <a href={filePreviewUrl(attachment.id)} target="_blank" rel="noreferrer">
                                    {language === "de" ? "Vorschau" : "Preview"}
                                  </a>
                                  <a href={fileDownloadUrl(attachment.id)}>{attachment.file_name}</a>
                                </div>
                              </div>
                            ))}
                            <small className={row.mine ? "message-time mine" : "message-time other"}>{row.timeLabel}</small>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  <form onSubmit={sendMessage} className="chat-compose">
                    <label
                      className={messageAttachment ? "chat-attach-btn has-file" : "chat-attach-btn"}
                      aria-label={language === "de" ? "Datei anhängen" : "Attach file"}
                      title={language === "de" ? "Datei anhängen" : "Attach file"}
                    >
                      <span>+</span>
                      <input ref={messageAttachmentInputRef} type="file" name="attachment" onChange={onMessageAttachmentChange} />
                    </label>
                    <div className="chat-compose-main">
                      <input
                        name="body"
                        value={messageBody}
                        onChange={(event) => setMessageBody(event.target.value)}
                        placeholder={language === "de" ? "Nachricht eingeben" : "Type message"}
                      />
                      {messageAttachment && (
                        <div className="chat-pending-attachment">
                          <small title={messageAttachment.name}>{messageAttachment.name}</small>
                          <button
                            type="button"
                            className="chat-attachment-remove"
                            onClick={clearMessageAttachment}
                            aria-label={language === "de" ? "Anhang entfernen" : "Remove attachment"}
                            title={language === "de" ? "Anhang entfernen" : "Remove attachment"}
                          >
                            ×
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      type="submit"
                      className={canSendMessage ? "chat-send-btn" : "chat-send-btn is-muted"}
                      disabled={!canSendMessage}
                      aria-label={language === "de" ? "Senden" : "Send"}
                      title={language === "de" ? "Senden" : "Send"}
                    >
                      <span className="chat-send-arrow">➤</span>
                    </button>
                  </form>
                </>
              )}
            </div>
          </section>
        )}

        {mainView === "time" && (
          <section className="grid time-grid">
            <div className="card time-current-card">
              <div className="row wrap time-current-head">
                <h3>{language === "de" ? "Aktuelle Schicht" : "Current shift"}</h3>
                <div ref={timeInfoRef} className={timeInfoOpen ? "time-info-wrap open" : "time-info-wrap"}>
                  <button
                    type="button"
                    className="time-info-trigger"
                    onClick={() => setTimeInfoOpen((current) => !current)}
                    aria-expanded={timeInfoOpen}
                    aria-label={language === "de" ? "Schichtdetails anzeigen" : "Show shift details"}
                  >
                    <small className="muted">
                      {language === "de" ? "Aktuelle Uhrzeit" : "Current time"}:{" "}
                      <b>{now.toLocaleTimeString(language === "de" ? "de-DE" : "en-US")}</b>
                    </small>
                  </button>
                  <div className="time-info-popover">
                    {timeCurrent?.clock_entry_id ? (
                      <div className="metric-grid time-info-metrics">
                        <div><b>{language === "de" ? "Schicht-ID" : "Shift ID"}:</b> {timeCurrent.clock_entry_id}</div>
                        <div>
                          <b>{language === "de" ? "Eingestempelt" : "Clocked in"}:</b>{" "}
                          {new Date(timeCurrent.clock_in || "").toLocaleString(language === "de" ? "de-DE" : "en-US")}
                        </div>
                        <div><b>{language === "de" ? "Arbeitszeit" : "Worked"}:</b> {timeCurrent.worked_hours_live}h</div>
                        <div><b>{language === "de" ? "Pause" : "Break"}:</b> {timeCurrent.break_hours_live}h</div>
                        <div><b>{language === "de" ? "Gesetzliche Pause" : "Legal break"}:</b> {timeCurrent.required_break_hours_live}h</div>
                        <div><b>{language === "de" ? "Nettozeit Schicht" : "Net shift hours"}:</b> {timeCurrent.net_hours_live}h</div>
                      </div>
                    ) : (
                      <p className="muted">{language === "de" ? "Keine offene Schicht." : "No open shift."}</p>
                    )}
                    <small className="muted">
                      {language === "de"
                        ? "Gesetzliche Pause: über 6h = 30 Min, über 9h = 45 Min."
                        : "German legal break defaults: over 6h = 30m, over 9h = 45m."}
                    </small>
                  </div>
                </div>
              </div>
              <div className="time-current-main">
                <WorkHoursGauge language={language} netHours={gaugeNetHours} requiredHours={requiredDailyHours} />
              </div>
              <div className="row wrap time-current-actions">
                {timeCurrent?.clock_entry_id ? (
                  <button onClick={clockOut} disabled={!viewingOwnTime}>
                    {language === "de" ? "Ausstempeln" : "Clock out"}
                  </button>
                ) : (
                  <button onClick={clockIn} disabled={!viewingOwnTime}>
                    {language === "de" ? "Einstempeln" : "Clock in"}
                  </button>
                )}
                {Boolean(timeCurrent?.clock_entry_id) &&
                  (timeCurrent?.break_open ? (
                    <button onClick={endBreak} disabled={!viewingOwnTime}>
                      {language === "de" ? "Pause Ende" : "Break end"}
                    </button>
                  ) : (
                    <button onClick={startBreak} disabled={!viewingOwnTime}>
                      {language === "de" ? "Pause Start" : "Break start"}
                    </button>
                  ))}
                <a
                  href={`/api/time/timesheet/export.csv${isTimeManager && timeTargetUserId ? `?user_id=${Number(timeTargetUserId)}` : ""}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {language === "de" ? "CSV Export" : "CSV export"}
                </a>
              </div>
              {!viewingOwnTime && (
                <small className="muted">
                  {language === "de"
                    ? "Sie sehen die Zeitdaten eines Mitarbeiters. Clock-In/Out ist deaktiviert."
                    : "You are viewing another employee. Clock actions are disabled."}
                </small>
              )}
            </div>

            <div className="card time-month-card">
              <h3>{language === "de" ? "Monats- und Wochenstunden" : "Monthly and weekly hours"}</h3>
              <div className="time-month-nav">
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setTimeMonthCursor((current) => shiftMonthStart(current, -1))}
                  aria-label={language === "de" ? "Vorheriger Monat" : "Previous month"}
                >
                  ←
                </button>
                <b>{monthCursorLabel}</b>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setTimeMonthCursor((current) => shiftMonthStart(current, 1))}
                  aria-label={language === "de" ? "Nächster Monat" : "Next month"}
                >
                  →
                </button>
              </div>
              <MonthlyHoursGauge
                language={language}
                workedHours={monthlyWorkedHours}
                requiredHours={monthlyRequiredHours}
              />
              {monthlyWorkedHours > monthlyRequiredHours && (
                <small className="muted">
                  {language === "de" ? "Überstunden" : "Overtime"}: {formatHours(monthlyWorkedHours - monthlyRequiredHours)}
                </small>
              )}
              <div className="weekly-hours-list">
                {timeMonthRows.map((row) => (
                  <WeeklyHoursGauge key={`${row.weekYear}-${row.weekNumber}-${row.weekStart}`} language={language} row={row} />
                ))}
              </div>
            </div>

            <div className="card time-entries-card">
              <div className="row wrap">
                <h3>{language === "de" ? "Wochenbuchungen" : "Weekly entries"}</h3>
                {isTimeManager && (
                  <input
                    type="number"
                    placeholder={language === "de" ? "Mitarbeiter-ID filtern" : "Filter by user ID"}
                    value={timeTargetUserId}
                    onChange={(e) => setTimeTargetUserId(e.target.value)}
                  />
                )}
                {isTimeManager && timeTargetUser && (
                  <small className="muted">
                    {language === "de" ? "Filter aktiv" : "Filter active"}: {timeTargetUser.full_name}
                  </small>
                )}
              </div>
              <div className="time-entry-list">
                {timeEntries.map((entry) => (
                  <form key={entry.id} className="time-entry" onSubmit={(event) => updateTimeEntry(event, entry.id)}>
                    <div className="row wrap">
                      <b>#{entry.id}</b>
                      <span>user {entry.user_id}</span>
                      <span>{entry.net_hours}h</span>
                    </div>
                    <div className="grid compact">
                      <label>
                        Clock in
                        <input type="datetime-local" name="clock_in" required defaultValue={isoToLocalDateTimeInput(entry.clock_in)} />
                      </label>
                      <label>
                        Clock out
                        <input type="datetime-local" name="clock_out" defaultValue={isoToLocalDateTimeInput(entry.clock_out)} />
                      </label>
                      <label>
                        Break min
                        <input type="number" name="break_minutes" min={0} defaultValue={Math.round(entry.break_hours * 60)} />
                      </label>
                    </div>
                    <div className="row wrap">
                      <small>
                        break: {entry.break_hours}h | legal: {entry.required_break_hours}h | deducted: {entry.deducted_break_hours}h
                      </small>
                      <button type="submit">{language === "de" ? "Ändern" : "Update"}</button>
                    </div>
                  </form>
                ))}
              </div>
            </div>

            <div className="card time-requests-card">
              <h3>{language === "de" ? "Urlaubsanträge" : "Vacation requests"}</h3>
              <form className="modal-form" onSubmit={submitVacationRequest}>
                <div className="row wrap">
                  <label>
                    {language === "de" ? "Von" : "From"}
                    <input
                      type="date"
                      value={vacationRequestForm.start_date}
                      onChange={(event) =>
                        setVacationRequestForm((current) => ({ ...current, start_date: event.target.value }))
                      }
                      required
                    />
                  </label>
                  <label>
                    {language === "de" ? "Bis" : "Until"}
                    <input
                      type="date"
                      value={vacationRequestForm.end_date}
                      onChange={(event) =>
                        setVacationRequestForm((current) => ({ ...current, end_date: event.target.value }))
                      }
                      required
                    />
                  </label>
                </div>
                <label>
                  {language === "de" ? "Notiz" : "Note"}
                  <textarea
                    value={vacationRequestForm.note}
                    onChange={(event) =>
                      setVacationRequestForm((current) => ({ ...current, note: event.target.value }))
                    }
                  />
                </label>
                <button type="submit">{language === "de" ? "Antrag senden" : "Submit request"}</button>
              </form>

              {canApproveVacation && (
                <div className="metric-stack">
                  <b>{language === "de" ? "Offene Anträge" : "Pending requests"}</b>
                  <ul className="overview-list">
                    {pendingVacationRequests.map((row) => (
                      <li key={`vacation-pending-${row.id}`} className="task-list-item">
                        <div className="task-list-main">
                          <b>{row.user_name}</b>
                          <small>
                            {row.start_date} - {row.end_date}
                          </small>
                          {row.note && <small>{row.note}</small>}
                        </div>
                        <div className="row wrap task-actions">
                          <button type="button" onClick={() => void reviewVacationRequest(row.id, "approved")}>
                            {language === "de" ? "Genehmigen" : "Approve"}
                          </button>
                          <button type="button" onClick={() => void reviewVacationRequest(row.id, "rejected")}>
                            {language === "de" ? "Ablehnen" : "Reject"}
                          </button>
                        </div>
                      </li>
                    ))}
                    {pendingVacationRequests.length === 0 && (
                      <li className="muted">{language === "de" ? "Keine offenen Anträge." : "No pending requests."}</li>
                    )}
                  </ul>
                </div>
              )}

              <div className="metric-stack">
                <b>{language === "de" ? "Genehmigter Urlaub" : "Approved vacation"}</b>
                <ul className="overview-list">
                  {approvedVacationRequests.map((row) => (
                    <li key={`vacation-approved-${row.id}`}>
                      <small>
                        {row.user_name}: {row.start_date} - {row.end_date}
                      </small>
                    </li>
                  ))}
                  {approvedVacationRequests.length === 0 && (
                    <li className="muted">{language === "de" ? "Keine genehmigten Urlaube." : "No approved vacations."}</li>
                  )}
                </ul>
              </div>
            </div>

            <div className="card time-school-card">
              <h3>{language === "de" ? "Schulzeiten / Abwesenheiten" : "School dates / absences"}</h3>
              {canManageSchoolAbsences && (
                <form className="modal-form" onSubmit={submitSchoolAbsence}>
                  <label>
                    {language === "de" ? "Mitarbeiter" : "Employee"}
                    <select
                      value={schoolAbsenceForm.user_id}
                      onChange={(event) =>
                        setSchoolAbsenceForm((current) => ({ ...current, user_id: event.target.value }))
                      }
                      required
                    >
                      <option value="">{language === "de" ? "Bitte auswählen" : "Please select"}</option>
                      {assignableUsers.map((entry) => (
                        <option key={`school-user-${entry.id}`} value={String(entry.id)}>
                          {entry.full_name} (#{entry.id})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {language === "de" ? "Titel" : "Title"}
                    <input
                      value={schoolAbsenceForm.title}
                      onChange={(event) =>
                        setSchoolAbsenceForm((current) => ({ ...current, title: event.target.value }))
                      }
                      required
                    />
                  </label>
                  <div className="row wrap">
                    <label>
                      {language === "de" ? "Start" : "Start"}
                      <input
                        type="date"
                        value={schoolAbsenceForm.start_date}
                        onChange={(event) =>
                          setSchoolAbsenceForm((current) => ({ ...current, start_date: event.target.value }))
                        }
                        required
                      />
                    </label>
                    <label>
                      {language === "de" ? "Ende" : "End"}
                      <input
                        type="date"
                        value={schoolAbsenceForm.end_date}
                        onChange={(event) =>
                          setSchoolAbsenceForm((current) => ({ ...current, end_date: event.target.value }))
                        }
                        required
                      />
                    </label>
                  </div>
                  <div className="row wrap">
                    <div className="weekday-checkbox-group">
                      <small>{language === "de" ? "Wiederholung (Mo-Fr)" : "Recurring days (Mon-Fri)"}</small>
                      <div className="weekday-checkbox-row">
                        {[0, 1, 2, 3, 4].map((day) => (
                          <label key={`school-day-${day}`} className="weekday-checkbox-item">
                            <input
                              type="checkbox"
                              checked={schoolAbsenceForm.recurrence_weekdays.includes(day)}
                              onChange={(event) => toggleSchoolRecurrenceWeekday(day, event.target.checked)}
                            />
                            <span>{schoolWeekdayLabel(day, language)}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <label>
                      {language === "de" ? "Intervall bis (optional)" : "Recurring until (optional)"}
                      <input
                        type="date"
                        value={schoolAbsenceForm.recurrence_until}
                        onChange={(event) =>
                          setSchoolAbsenceForm((current) => ({ ...current, recurrence_until: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <button type="submit">{language === "de" ? "Schulzeit speichern" : "Save school date"}</button>
                </form>
              )}
              <ul className="overview-list">
                {schoolAbsences.map((row) => (
                  <li key={`school-${row.id}`} className="task-list-item">
                    <div className="task-list-main">
                      <b>{row.user_name}</b>
                      <small>
                        {row.title}: {row.start_date} - {row.end_date}
                      </small>
                      {row.recurrence_weekday !== null && row.recurrence_weekday !== undefined && (
                        <small>
                          {language === "de" ? "Woechentlich" : "Weekly"}:{" "}
                          {schoolWeekdayLabel(row.recurrence_weekday, language)}
                          {row.recurrence_until ? ` | ${language === "de" ? "bis" : "until"} ${row.recurrence_until}` : ""}
                        </small>
                      )}
                    </div>
                    {canManageSchoolAbsences && (
                      <div className="row wrap task-actions">
                        <button type="button" className="danger-btn" onClick={() => void removeSchoolAbsence(row.id)}>
                          {language === "de" ? "Löschen" : "Delete"}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
                {schoolAbsences.length === 0 && (
                  <li className="muted">{language === "de" ? "Keine Schulzeiten vorhanden." : "No school dates found."}</li>
                )}
              </ul>
            </div>
          </section>
        )}

        {mainView === "profile" && (
          <section className="profile-layout">
            <div className="profile-left-stack">
              <div className="card profile-settings-card">
                <h3>{language === "de" ? "Profil & Einstellungen" : "Profile & settings"}</h3>
                <div className="row wrap profile-head-row">
                  <button
                    type="button"
                    className="profile-avatar-trigger"
                    onClick={openAvatarModal}
                    aria-label={language === "de" ? "Profilbild ändern" : "Change profile picture"}
                    title={language === "de" ? "Profilbild ändern" : "Change profile picture"}
                  >
                    <AvatarBadge
                      userId={user.id}
                      initials={userInitials}
                      hasAvatar={Boolean(user.avatar_updated_at)}
                      versionKey={avatarVersionKey}
                      className="profile-avatar"
                    />
                    <span className="profile-avatar-overlay">{language === "de" ? "Ändern" : "Change"}</span>
                  </button>
                  <div className="metric-stack">
                    <b>{user.full_name}</b>
                    <small>{user.email}</small>
                    <small>Role: {user.role}</small>
                  </div>
                </div>
                <form className="modal-form" onSubmit={saveProfileSettings}>
                  <label>
                    {language === "de" ? "Name" : "Name"}
                    <input
                      value={profileSettingsForm.full_name}
                      onChange={(event) =>
                        setProfileSettingsForm((current) => ({ ...current, full_name: event.target.value }))
                      }
                      required
                    />
                  </label>
                  <label>
                    {language === "de" ? "E-Mail" : "Email"}
                    <input
                      type="email"
                      value={profileSettingsForm.email}
                      onChange={(event) =>
                        setProfileSettingsForm((current) => ({ ...current, email: event.target.value }))
                      }
                      required
                    />
                  </label>
                  <label>
                    {language === "de" ? "Aktuelles Passwort" : "Current password"}
                    <input
                      type="password"
                      value={profileSettingsForm.current_password}
                      onChange={(event) =>
                        setProfileSettingsForm((current) => ({ ...current, current_password: event.target.value }))
                      }
                      placeholder={language === "de" ? "Nur für E-Mail/Passwort Änderung" : "Needed for email/password changes"}
                    />
                  </label>
                  <label>
                    {language === "de" ? "Neues Passwort" : "New password"}
                    <input
                      type="password"
                      minLength={8}
                      value={profileSettingsForm.new_password}
                      onChange={(event) =>
                        setProfileSettingsForm((current) => ({ ...current, new_password: event.target.value }))
                      }
                      placeholder={language === "de" ? "Leer lassen für keine Änderung" : "Leave empty to keep current"}
                    />
                  </label>
                  <div className="row wrap">
                    <button type="submit">{language === "de" ? "Profil speichern" : "Save profile"}</button>
                  </div>
                </form>
                <small className="muted">
                  {language === "de"
                    ? "Sprachwechsel und Abmelden sind unten in der Seitenleiste."
                    : "Language switch and sign-out are available in the sidebar footer."}
                </small>
              </div>

              {(canManageProjectImport || canManageSchoolAbsences || isAdmin) && (
                <div className="card">
                  <h3>{language === "de" ? "Admin Werkzeuge" : "Admin tools"}</h3>
                  {isAdmin && (
                    <div className="metric-stack">
                      <b>{language === "de" ? "Einladung senden" : "Send invite"}</b>
                      <form className="modal-form" onSubmit={submitCreateInvite}>
                        <label>
                          {language === "de" ? "Name" : "Name"}
                          <input
                            value={inviteCreateForm.full_name}
                            onChange={(event) =>
                              setInviteCreateForm((current) => ({ ...current, full_name: event.target.value }))
                            }
                            required
                          />
                        </label>
                        <label>
                          {language === "de" ? "E-Mail" : "Email"}
                          <input
                            type="email"
                            value={inviteCreateForm.email}
                            onChange={(event) =>
                              setInviteCreateForm((current) => ({ ...current, email: event.target.value }))
                            }
                            required
                          />
                        </label>
                        <label>
                          {language === "de" ? "Rolle" : "Role"}
                          <select
                            value={inviteCreateForm.role}
                            onChange={(event) =>
                              setInviteCreateForm((current) => ({
                                ...current,
                                role: event.target.value as User["role"],
                              }))
                            }
                          >
                            <option value="admin">admin</option>
                            <option value="ceo">ceo</option>
                            <option value="accountant">accountant</option>
                            <option value="planning">planning</option>
                            <option value="employee">employee</option>
                          </select>
                        </label>
                        <button type="submit">{language === "de" ? "Einladung senden" : "Send invite"}</button>
                      </form>
                    </div>
                  )}
                  {isAdmin && (
                    <div className="metric-stack">
                      <b>{language === "de" ? "Datenbank-Backup exportieren" : "Export database backup"}</b>
                      <small className="muted">
                        {language === "de"
                          ? "Die Sicherung ist verschlüsselt und kann nur mit derselben Schlüsseldatei entschlüsselt werden."
                          : "Backup is encrypted and can only be decrypted with the same key file."}
                      </small>
                      <form className="row wrap" onSubmit={exportEncryptedDatabaseBackup}>
                        <input type="file" name="key_file" required />
                        <button type="submit" disabled={backupExporting}>
                          {backupExporting
                            ? language === "de"
                              ? "Export läuft..."
                              : "Exporting..."
                            : language === "de"
                              ? "Backup herunterladen"
                              : "Download backup"}
                        </button>
                      </form>
                    </div>
                  )}
                  {canManageProjectImport && (
                    <div className="metric-stack">
                      <b>{language === "de" ? "Projekt-CSV Import" : "Project CSV import"}</b>
                      <div className="row wrap">
                        <button type="button" onClick={downloadProjectCsvTemplate}>
                          {language === "de" ? "CSV-Template herunterladen" : "Download CSV template"}
                        </button>
                      </div>
                      <form className="row wrap" onSubmit={importProjectsCsv}>
                        <input type="file" name="file" accept=".csv,text/csv" required />
                        <button type="submit">{language === "de" ? "CSV importieren" : "Import CSV"}</button>
                      </form>
                    </div>
                  )}
                  {canManageSchoolAbsences && (
                    <div className="metric-stack">
                      <b>{language === "de" ? "Berufsschule verwalten" : "Manage school dates"}</b>
                      <small className="muted">
                        {language === "de"
                          ? "Sie können Schulblöcke oder wiederkehrende Schultage hinzufügen."
                          : "You can add school blocks or recurring school days."}
                      </small>
                      <form className="modal-form" onSubmit={submitSchoolAbsence}>
                        <label>
                          {language === "de" ? "Mitarbeiter" : "Employee"}
                          <select
                            value={schoolAbsenceForm.user_id}
                            onChange={(event) =>
                              setSchoolAbsenceForm((current) => ({ ...current, user_id: event.target.value }))
                            }
                            required
                          >
                            <option value="">{language === "de" ? "Bitte auswählen" : "Please select"}</option>
                            {assignableUsers.map((entry) => (
                              <option key={`profile-school-user-${entry.id}`} value={String(entry.id)}>
                                {entry.full_name} (#{entry.id})
                              </option>
                            ))}
                          </select>
                        </label>
                        <div className="row wrap">
                          <label>
                            {language === "de" ? "Start" : "Start"}
                            <input
                              type="date"
                              value={schoolAbsenceForm.start_date}
                              onChange={(event) =>
                                setSchoolAbsenceForm((current) => ({ ...current, start_date: event.target.value }))
                              }
                              required
                            />
                          </label>
                          <label>
                            {language === "de" ? "Ende" : "End"}
                            <input
                              type="date"
                              value={schoolAbsenceForm.end_date}
                              onChange={(event) =>
                                setSchoolAbsenceForm((current) => ({ ...current, end_date: event.target.value }))
                              }
                              required
                            />
                          </label>
                        </div>
                        <div className="weekday-checkbox-group">
                          <small>{language === "de" ? "Wiederholung (Mo-Fr)" : "Recurring days (Mon-Fri)"}</small>
                          <div className="weekday-checkbox-row">
                            {[0, 1, 2, 3, 4].map((day) => (
                              <label key={`profile-school-day-${day}`} className="weekday-checkbox-item">
                                <input
                                  type="checkbox"
                                  checked={schoolAbsenceForm.recurrence_weekdays.includes(day)}
                                  onChange={(event) => toggleSchoolRecurrenceWeekday(day, event.target.checked)}
                                />
                                <span>{schoolWeekdayLabel(day, language)}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                        <label>
                          {language === "de" ? "Intervall bis (optional)" : "Recurring until (optional)"}
                          <input
                            type="date"
                            value={schoolAbsenceForm.recurrence_until}
                            onChange={(event) =>
                              setSchoolAbsenceForm((current) => ({ ...current, recurrence_until: event.target.value }))
                            }
                          />
                        </label>
                        <button type="submit">{language === "de" ? "Schulzeit speichern" : "Save school date"}</button>
                      </form>
                    </div>
                  )}
                </div>
              )}
            </div>
            {isAdmin && (
              <div className="card profile-admin-center-card">
                <h3>{language === "de" ? "Admin Center" : "Admin Center"}</h3>
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>{language === "de" ? "Name" : "Name"}</th>
                      <th>Email</th>
                      <th>{language === "de" ? "Rolle" : "Role"}</th>
                      <th>{language === "de" ? "Soll (h/Tag)" : "Required (h/day)"}</th>
                      <th>{language === "de" ? "Template" : "Template"}</th>
                      <th>{language === "de" ? "Einladung" : "Invite"}</th>
                      <th>{language === "de" ? "Aktionen" : "Actions"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className={!u.is_active ? "admin-user-inactive" : undefined}>
                        <td>{u.id}</td>
                        <td>
                          <div className="metric-stack">
                            <span>{u.full_name}</span>
                            {!u.is_active && (
                              <small className="muted">{language === "de" ? "deaktiviert" : "inactive"}</small>
                            )}
                          </div>
                        </td>
                        <td>{u.email}</td>
                        <td>
                          <select value={u.role} onChange={(e) => updateRole(u.id, e.target.value as User["role"])}>
                            <option value="admin">admin</option>
                            <option value="ceo">ceo</option>
                            <option value="accountant">accountant</option>
                            <option value="planning">planning</option>
                            <option value="employee">employee</option>
                          </select>
                        </td>
                        <td>
                          <div className="row wrap admin-required-hours-cell">
                            <input
                              type="number"
                              min={1}
                              max={24}
                              step={0.25}
                              value={requiredHoursDrafts[u.id] ?? String(u.required_daily_hours ?? 8)}
                              onChange={(event) =>
                                setRequiredHoursDrafts((current) => ({ ...current, [u.id]: event.target.value }))
                              }
                            />
                            <button type="button" onClick={() => void updateRequiredDailyHours(u.id)}>
                              {language === "de" ? "Speichern" : "Save"}
                            </button>
                          </div>
                        </td>
                        <td>
                          <button onClick={() => applyTemplate(u.id)}>
                            {language === "de" ? "Default anwenden" : "Apply default"}
                          </button>
                        </td>
                        <td>
                          <small>
                            {u.invite_sent_at
                              ? new Date(u.invite_sent_at).toLocaleString(language === "de" ? "de-DE" : "en-US")
                              : "-"}
                          </small>
                          <br />
                          <small className="muted">
                            {!u.is_active
                              ? language === "de"
                                ? "Gelöscht"
                                : "Deleted"
                              : u.invite_accepted_at
                                ? language === "de"
                                  ? "Angenommen"
                                  : "Accepted"
                                : language === "de"
                                  ? "Offen"
                                  : "Pending"}
                          </small>
                        </td>
                        <td>
                          <div className="admin-actions-menu-wrap">
                            <button
                              type="button"
                              className="admin-actions-trigger"
                              aria-haspopup="menu"
                              aria-expanded={adminUserMenuOpenId === u.id}
                              aria-label={language === "de" ? "Benutzeraktionen öffnen" : "Open user actions"}
                              onClick={() =>
                                setAdminUserMenuOpenId((current) => (current === u.id ? null : u.id))
                              }
                            >
                              &#8942;
                            </button>
                            {adminUserMenuOpenId === u.id && (
                              <div className="admin-actions-menu" role="menu">
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={!u.is_active}
                                  onClick={() => void sendInviteToUser(u.id)}
                                >
                                  {u.invite_sent_at
                                    ? language === "de"
                                      ? "Einladung erneut senden"
                                      : "Resend invite"
                                    : language === "de"
                                      ? "Einladung senden"
                                      : "Send invite"}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  disabled={!u.is_active}
                                  onClick={() => void sendPasswordResetToUser(u.id)}
                                >
                                  {language === "de" ? "Passwort-Reset senden" : "Send reset link"}
                                </button>
                                <button
                                  type="button"
                                  role="menuitem"
                                  className="danger"
                                  disabled={!u.is_active || u.id === user?.id}
                                  onClick={() => void softDeleteUser(u.id)}
                                >
                                  {language === "de" ? "Benutzer löschen" : "Delete user"}
                                </button>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {mainView === "admin" && isAdmin && (
          <section className="card">
            <h3>{language === "de" ? "Benutzerverwaltung" : "User administration"}</h3>
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>{language === "de" ? "Name" : "Name"}</th>
                  <th>Email</th>
                  <th>{language === "de" ? "Rolle" : "Role"}</th>
                  <th>{language === "de" ? "Soll (h/Tag)" : "Required (h/day)"}</th>
                  <th>{language === "de" ? "Template" : "Template"}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.id}</td>
                    <td>{u.full_name}</td>
                    <td>{u.email}</td>
                    <td>
                      <select value={u.role} onChange={(e) => updateRole(u.id, e.target.value as User["role"])}>
                        <option value="admin">admin</option>
                        <option value="ceo">ceo</option>
                        <option value="accountant">accountant</option>
                        <option value="planning">planning</option>
                        <option value="employee">employee</option>
                      </select>
                    </td>
                    <td>
                      <div className="row wrap admin-required-hours-cell">
                        <input
                          type="number"
                          min={1}
                          max={24}
                          step={0.25}
                          value={requiredHoursDrafts[u.id] ?? String(u.required_daily_hours ?? 8)}
                          onChange={(event) =>
                            setRequiredHoursDrafts((current) => ({ ...current, [u.id]: event.target.value }))
                          }
                        />
                        <button type="button" onClick={() => void updateRequiredDailyHours(u.id)}>
                          {language === "de" ? "Speichern" : "Save"}
                        </button>
                      </div>
                    </td>
                    <td>
                      <button onClick={() => applyTemplate(u.id)}>
                        {language === "de" ? "Default anwenden" : "Apply default"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </div>
  );
}
