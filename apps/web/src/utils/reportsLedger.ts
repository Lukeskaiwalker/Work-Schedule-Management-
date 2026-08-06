/**
 * Domain helpers for the "Berichte" filing ledger (`pages/ReportsPage.tsx`).
 *
 * The page groups reports by **day**, on one of two axes:
 *   - `"filed"`   — the day the report entered the system (`created_at`)
 *   - `"site"`    — the day the work happened (`report_date`)
 *
 * The backend window admits a row when *either* date qualifies
 * (`workflow_reports.py:186`), so on either axis some rows fall outside the
 * window. Those get explicit overflow groups rather than being dropped or
 * silently folded into a day they do not belong to.
 */

import { addDaysISO, formatDateISOLocal, parseServerDateTime } from "./dates";
import type { Language, RecentConstructionReport } from "../types";

/** Mirrors the `days` default of `loadReportsWindow` in App.tsx. */
export const REPORTS_WINDOW_DAYS = 28;
/** Rows rendered before the card foot appears. */
export const REPORTS_INITIAL_ROW_CAP = 150;
/** How many more rows the card-foot button reveals per press. */
export const REPORTS_ROW_CAP_STEP = 150;
/** `limit=500` is what App.tsx requests and what the backend clamps to. */
export const REPORTS_API_ROW_LIMIT = 500;
export const REPORTS_POLL_INTERVAL_MS = 20_000;
/** 15 × 20s = 5 minutes, after which the toolbar offers a manual refresh. */
export const REPORTS_MAX_POLLS = 15;
/** A PDF older than this and still pending is called out as delayed. */
export const REPORTS_PENDING_DELAY_MINUTES = 10;

export type ReportAxis = "filed" | "site";

/**
 * The five-branch document status truth table, evaluated in order. Keyed on
 * `attachment_id` for the openable branch because that is the field which
 * decides whether the link actually works.
 */
export type ReportDocumentBranch = "failed" | "open" | "pending" | "missing";

export type ReportGroupKind = "day" | "future" | "past";

export type ReportGroup = {
  /** Stable React key. */
  readonly key: string;
  readonly kind: ReportGroupKind;
  /** `YYYY-MM-DD` for `kind === "day"`, empty for overflow groups. */
  readonly dayKey: string;
  readonly reports: readonly RecentConstructionReport[];
};

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function localeOf(language: Language): string {
  return language === "de" ? "de-DE" : "en-US";
}

/** `YYYY-MM-DD` for the local day, or null when the value is unusable. */
function siteKeyOf(report: RecentConstructionReport): string | null {
  const raw = String(report.report_date ?? "").slice(0, 10);
  return DAY_KEY_RE.test(raw) ? raw : null;
}

function filedKeyOf(report: RecentConstructionReport): string | null {
  const parsed = parseServerDateTime(report.created_at);
  return parsed ? formatDateISOLocal(parsed) : null;
}

/** The site-visit day. Falls back to the filing day on unparseable input. */
export function siteDayKey(report: RecentConstructionReport): string {
  return siteKeyOf(report) ?? filedKeyOf(report) ?? "";
}

/** The filing day. Falls back to the site-visit day on unparseable input. */
export function filedDayKey(report: RecentConstructionReport): string {
  return filedKeyOf(report) ?? siteKeyOf(report) ?? "";
}

/** The day this report is grouped under, for the active axis. */
export function axisDayKey(report: RecentConstructionReport, axis: ReportAxis): string {
  return axis === "filed" ? filedDayKey(report) : siteDayKey(report);
}

/** The date lane 1 carries — always the one the grouping is *not* using. */
export function counterpartDayKey(report: RecentConstructionReport, axis: ReportAxis): string {
  return axis === "filed" ? siteDayKey(report) : filedDayKey(report);
}

/** A report filed on a day other than the one it documents ("Nachtrag"). */
export function isLateFiling(report: RecentConstructionReport): boolean {
  return siteDayKey(report) !== filedDayKey(report);
}

export function todayDayKey(reference: Date = new Date()): string {
  return formatDateISOLocal(reference);
}

export function yesterdayDayKey(reference: Date = new Date()): string {
  return addDaysISO(formatDateISOLocal(reference), -1);
}

/** First day of the loaded window — the same arithmetic `loadReportsWindow` uses. */
export function reportsWindowStartKey(reference: Date = new Date()): string {
  return addDaysISO(formatDateISOLocal(reference), -REPORTS_WINDOW_DAYS);
}

function dayKeyToDate(dayKey: string): Date | null {
  if (!DAY_KEY_RE.test(dayKey)) return null;
  // Local noon: immune to DST shifts and to the UTC-midnight off-by-one.
  const date = new Date(`${dayKey}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `Mi` / `Wed` — Intl adds a trailing period in German, which we drop. */
function weekdayShort(date: Date, language: Language): string {
  return date
    .toLocaleDateString(localeOf(language), { weekday: "short" })
    .replace(/\.$/, "");
}

/** `Heute` / `Gestern` / `Mi, 8. August 2026`. The year is always printed. */
export function formatDayHeading(
  dayKey: string,
  language: Language,
  today: string,
  yesterday: string,
): string {
  const de = language === "de";
  if (dayKey === today) return de ? "Heute" : "Today";
  if (dayKey === yesterday) return de ? "Gestern" : "Yesterday";
  const date = dayKeyToDate(dayKey);
  if (!date) return dayKey;
  const weekday = weekdayShort(date, language);
  const month = date.toLocaleDateString(localeOf(language), { month: "long" });
  return de
    ? `${weekday}, ${date.getDate()}. ${month} ${date.getFullYear()}`
    : `${weekday}, ${date.getDate()} ${month} ${date.getFullYear()}`;
}

/** `Fr, 10.08.2026` — the echo beside a relative day label. */
export function formatDayEcho(dayKey: string, language: Language): string {
  const date = dayKeyToDate(dayKey);
  if (!date) return dayKey;
  return `${weekdayShort(date, language)}, ${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** `Mi 08.08.` — lane 1's counterpart date. */
export function formatLaneDay(dayKey: string, language: Language): string {
  const date = dayKeyToDate(dayKey);
  if (!date) return dayKey;
  return `${weekdayShort(date, language)} ${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.`;
}

/** `10.08.2026` — used in the overflow-group echo. */
export function formatDayNumeric(dayKey: string): string {
  const date = dayKeyToDate(dayKey);
  if (!date) return dayKey;
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/** `16:42`, 24h, from a server timestamp. Empty when unparseable. */
export function formatClockTime(value: string | null | undefined): string {
  const parsed = parseServerDateTime(value);
  if (!parsed) return "";
  return `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`;
}

/**
 * `14.07.–10.08.2026`. The start year is printed only when it differs from the
 * end year, so a window spanning New Year can never read as one year.
 */
export function formatWindowRange(startKey: string, endKey: string): string {
  const start = dayKeyToDate(startKey);
  const end = dayKeyToDate(endKey);
  if (!start || !end) return `${startKey}–${endKey}`;
  const startText =
    start.getFullYear() === end.getFullYear()
      ? `${pad2(start.getDate())}.${pad2(start.getMonth() + 1)}.`
      : formatDayNumeric(startKey);
  return `${startText}–${formatDayNumeric(endKey)}`;
}

/** §5.1 truth table. Every branch is total; there is no fall-through. */
export function reportDocumentBranch(report: RecentConstructionReport): ReportDocumentBranch {
  if (report.processing_status === "failed") return "failed";
  if (report.attachment_id != null) return "open";
  if (report.processing_status === "queued" || report.processing_status === "processing") {
    return "pending";
  }
  return "missing";
}

/** Whole minutes since filing, floored at 0 (clock skew must not read negative). */
export function pendingAgeMinutes(report: RecentConstructionReport, nowMs: number): number {
  const parsed = parseServerDateTime(report.created_at);
  if (!parsed) return 0;
  return Math.max(0, Math.floor((nowMs - parsed.getTime()) / 60_000));
}

/**
 * Newest first by the grouping axis, then by the counterpart date, then by id.
 * Sorting on the axis first is what makes the overflow groups contiguous:
 * future rows land at the head, pre-window rows at the tail.
 */
export function sortReportsForAxis(
  reports: readonly RecentConstructionReport[],
  axis: ReportAxis,
): RecentConstructionReport[] {
  return [...reports].sort((left, right) => {
    const axisOrder = axisDayKey(right, axis).localeCompare(axisDayKey(left, axis));
    if (axisOrder !== 0) return axisOrder;
    const counterpartOrder = counterpartDayKey(right, axis).localeCompare(
      counterpartDayKey(left, axis),
    );
    if (counterpartOrder !== 0) return counterpartOrder;
    return right.id - left.id;
  });
}

/**
 * Bucket pre-sorted reports into day groups plus at most two overflow groups.
 * Every row lands in exactly one group, on both axes.
 */
export function groupReportsByAxis(
  reports: readonly RecentConstructionReport[],
  axis: ReportAxis,
  windowStartKey: string,
  today: string,
): ReportGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, RecentConstructionReport[]>();
  const kinds = new Map<string, ReportGroupKind>();
  const dayKeys = new Map<string, string>();

  for (const report of reports) {
    const dayKey = axisDayKey(report, axis);
    const kind: ReportGroupKind =
      axis === "site" && dayKey > today
        ? "future"
        : dayKey && dayKey < windowStartKey
          ? "past"
          : "day";
    const key = kind === "day" ? `day:${dayKey}` : kind;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(report);
      continue;
    }
    order.push(key);
    buckets.set(key, [report]);
    kinds.set(key, kind);
    dayKeys.set(key, kind === "day" ? dayKey : "");
  }

  return order.map((key) => ({
    key,
    kind: kinds.get(key) ?? "day",
    dayKey: dayKeys.get(key) ?? "",
    reports: buckets.get(key) ?? [],
  }));
}

/**
 * Guarantee a "Heute" band exists so the page's single accent mark always has a
 * home, inserted in the correct descending position.
 */
export function ensureTodayGroup(groups: readonly ReportGroup[], today: string): ReportGroup[] {
  if (groups.some((group) => group.kind === "day" && group.dayKey === today)) {
    return [...groups];
  }
  const placeholder: ReportGroup = {
    key: `day:${today}`,
    kind: "day",
    dayKey: today,
    reports: [],
  };
  const olderIndex = groups.findIndex((group) => group.kind === "day" && group.dayKey < today);
  const insertAt =
    olderIndex >= 0
      ? olderIndex
      : (() => {
          const pastIndex = groups.findIndex((group) => group.kind === "past");
          return pastIndex >= 0 ? pastIndex : groups.length;
        })();
  return [...groups.slice(0, insertAt), placeholder, ...groups.slice(insertAt)];
}
