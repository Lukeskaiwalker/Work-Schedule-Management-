import type { Language, MonthWeekRange } from "../types";

export function parseServerDateTime(value?: string | null) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const hasTimePart = raw.includes("T");
  const hasTimezone = /(?:[zZ]|[+\-]\d{2}:\d{2})$/.test(raw);
  const normalized = hasTimePart && !hasTimezone ? `${raw}Z` : raw;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function formatServerDateTime(value: string | null | undefined, language: Language) {
  const parsed = parseServerDateTime(value);
  if (!parsed) return value ? String(value) : "";
  return parsed.toLocaleString(language === "de" ? "de-DE" : "en-US");
}

export function chatDayKey(value: string, index: number) {
  const date = parseServerDateTime(value);
  if (!date) return `unknown-${index}`;
  return date.toISOString().slice(0, 10);
}

export function formatChatDayLabel(value: string, language: Language) {
  const date = parseServerDateTime(value);
  if (!date) return value;
  return date.toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatChatTimeLabel(value: string) {
  const date = parseServerDateTime(value);
  if (!date) return "--:--";
  return date.toLocaleTimeString("de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function isoToLocalDateTimeInput(value?: string | null) {
  const d = parseServerDateTime(value);
  if (!d) return "";
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60_000);
  return local.toISOString().slice(0, 16);
}

export function localDateTimeInputToIso(value: string) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatDateISOLocal(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function startOfWeekISO(source: Date) {
  const monday = new Date(source);
  monday.setHours(12, 0, 0, 0);
  const diff = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - diff);
  return formatDateISOLocal(monday);
}

export function addDaysISO(isoDate: string, days: number) {
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  d.setDate(d.getDate() + days);
  return formatDateISOLocal(d);
}

export function normalizeWeekStartISO(isoDate: string) {
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return startOfWeekISO(d);
}

export function isoWeekInfo(isoDate: string) {
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

export function formatDayLabel(dateIso: string, language: Language) {
  const d = new Date(`${dateIso}T00:00:00`);
  return d.toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

export function formatDayMonth(isoDate: string) {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.`;
}

export function daysInMonth(year: number, monthIndex: number) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function weekdaysBetweenIso(startIso: string, endIso: string) {
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

export function isIsoDateWithinRange(targetIso: string, startIso: string, endIso: string) {
  const target = targetIso.trim();
  const start = startIso.trim();
  const end = endIso.trim() || start;
  if (!target || !start || !end) return false;
  const from = start <= end ? start : end;
  const until = start <= end ? end : start;
  return target >= from && target <= until;
}

export function isoWeekdayMondayFirst(isoDate: string) {
  const date = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return -1;
  return (date.getDay() + 6) % 7;
}

export function formatShortIsoDate(isoDate: string, language: Language) {
  const date = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toLocaleDateString(language === "de" ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "2-digit",
  });
}

export function monthWeekRanges(reference: Date): MonthWeekRange[] {
  const year = reference.getFullYear();
  const monthIndex = reference.getMonth();
  const monthStart = new Date(year, monthIndex, 1, 12, 0, 0, 0);
  const monthEnd = new Date(year, monthIndex, daysInMonth(year, monthIndex), 12, 0, 0, 0);

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

export function shiftMonthStart(source: Date, delta: number) {
  return new Date(source.getFullYear(), source.getMonth() + delta, 1);
}

export function schoolWeekdayLabel(dayIndex: number, language: Language) {
  const en = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const de = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag"];
  if (dayIndex < 0 || dayIndex > 4) return String(dayIndex);
  return language === "de" ? de[dayIndex] : en[dayIndex];
}

export function parseTimestampValue(value: unknown) {
  if (typeof value !== "string") return 0;
  const parsed = parseServerDateTime(value)?.getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
