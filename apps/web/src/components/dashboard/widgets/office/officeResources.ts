/**
 * The requests behind the „Büro“ widgets, as module-level loaders for the
 * start page's resource store (docs/DASHBOARD.md §1, §9.3).
 *
 * Module-level on purpose: the store keeps the first loader registered for a
 * key, so a key and its loader must be one pair for the whole app. Each
 * answer is checked for its shape here, at the boundary — a list that is not
 * a list becomes the widget's error state, not a crash inside a render.
 */
import { apiFetch } from "../../../../api/client";
import type { RecentConstructionReport, VacationRequest } from "../../../../types";

/** The newest reports; the server caps the list at `limit`. */
export const RECENT_REPORTS_KEY = "reports:recent";
/** Requests waiting for approval, everyone's for a time manager. */
export const PENDING_VACATION_KEY = "time:vacation-requests:pending";
/** Who is clocked in right now (`/time/clock-summary`, time managers only). */
export const CLOCK_SUMMARY_KEY = "time:clock-summary";

/**
 * Ten for every size: one cached answer serves Klein, Mittel and Groß, and
 * Groß shows ten rows (§1.1).
 */
const RECENT_REPORTS_LIMIT = 10;

/** One row of `GET /time/clock-summary` (apps/api/app/routers/time_tracking.py). */
export type ClockedInPerson = {
  user_id: number;
  name: string;
  /** Local time of the open shift's start, already "HH:MM". */
  clocked_in_since: string;
  hours_today: number;
};

export type ClockSummary = {
  target_local_date: string;
  clocked_in: ClockedInPerson[];
  total_users_with_entries: number;
  total_hours_today: number;
};

function expectList<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Unexpected response for ${what}`);
  return value as T[];
}

export async function loadRecentReports(token: string | null, signal: AbortSignal): Promise<RecentConstructionReport[]> {
  const rows = await apiFetch<unknown>(`/construction-reports/recent?limit=${RECENT_REPORTS_LIMIT}`, token, { signal });
  return expectList<RecentConstructionReport>(rows, "recent reports");
}

export async function loadPendingVacationRequests(token: string | null, signal: AbortSignal): Promise<VacationRequest[]> {
  const rows = await apiFetch<unknown>("/time/vacation-requests?status=pending", token, { signal });
  return expectList<VacationRequest>(rows, "pending vacation requests");
}

export async function loadClockSummary(token: string | null, signal: AbortSignal): Promise<ClockSummary> {
  const summary = await apiFetch<Partial<ClockSummary> | null>("/time/clock-summary", token, { signal });
  if (!summary || typeof summary !== "object") throw new Error("Unexpected response for the clock summary");
  return { ...summary, clocked_in: expectList<ClockedInPerson>(summary.clocked_in, "the clock summary") } as ClockSummary;
}
