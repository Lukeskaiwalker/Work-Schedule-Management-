/**
 * The Protokoll's filters as the query GET /admin/audit-logs understands.
 *
 * One place turns a period into bounds, for the list and the CSV export
 * alike. Before 2026-10-20 the list filtered the newest 300 rows in the
 * browser and the export computed its own bounds; now both send the same
 * range and the server filters the whole table.
 *
 * Bounds are local days ("Heute" is today's local midnight to its last
 * millisecond) sent as UTC ISO strings, because `created_at` is stored in
 * naive UTC: a German midnight is 22:00 or 23:00 UTC the evening before.
 */

export type AuditPeriodFilter = "all" | "today" | "7d" | "30d" | "90d" | "custom";

/** Rows the tab shows per page. It asks for one more to learn whether older rows exist. */
export const AUDIT_PAGE_SIZE = 300;

export type AuditLogFilters = {
  period: AuditPeriodFilter;
  /** yyyy-mm-dd from the date picker; read only for "custom". */
  dateFrom: string;
  dateTo: string;
  categories: readonly string[];
  search: string;
};

export type AuditBounds = { fromIso: string | null; toIso: string | null };

/** Days before today that each rolling period reaches back. */
const PERIOD_DAYS_BACK: Partial<Record<AuditPeriodFilter, number>> = {
  today: 0,
  "7d": 6,
  "30d": 29,
  "90d": 89,
};

function localDayIso(day: string, endOfDay: boolean): string | null {
  if (!day) return null;
  const parsed = new Date(endOfDay ? `${day}T23:59:59.999` : `${day}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** The period as inclusive UTC bounds; null where it is open. */
export function auditPeriodBounds(
  period: AuditPeriodFilter,
  dateFrom: string,
  dateTo: string,
  now: Date = new Date(),
): AuditBounds {
  if (period === "custom") {
    return { fromIso: localDayIso(dateFrom, false), toIso: localDayIso(dateTo, true) };
  }
  const daysBack = PERIOD_DAYS_BACK[period];
  if (daysBack === undefined) return { fromIso: null, toIso: null };
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - daysBack);
  return { fromIso: start.toISOString(), toIso: end.toISOString() };
}

/**
 * The filter part of the list query, without page size or cursor.
 *
 * Its string form is stable for a whole local day (the rolling bounds only
 * move at midnight), so the feed can key its reload on it.
 */
export function auditLogFilterQuery(filters: AuditLogFilters, now: Date = new Date()): string {
  const params = new URLSearchParams();
  const { fromIso, toIso } = auditPeriodBounds(filters.period, filters.dateFrom, filters.dateTo, now);
  if (fromIso) params.set("from", fromIso);
  if (toIso) params.set("to", toIso);
  for (const category of filters.categories) params.append("category", category);
  const search = filters.search.trim();
  if (search) params.set("q", search);
  return params.toString();
}

/** One page request: the filters, one row more than a page, and the cursor. */
export function auditLogPagePath(filterQuery: string, beforeId: number | null): string {
  const params = new URLSearchParams(filterQuery);
  params.set("limit", String(AUDIT_PAGE_SIZE + 1));
  if (beforeId !== null) params.set("before_id", String(beforeId));
  return `/admin/audit-logs?${params.toString()}`;
}
