/**
 * The time-tracking data behind the Zeiterfassung page and the overview's
 * clock card: which requests one refresh makes, and the answers in their
 * places. App.tsx owns the state and the polling; this owns the requests, so
 * that how many a refresh costs is written down in one spot and tested
 * (src/test/timeDataPolling.test.ts).
 */
import type { SchoolAbsence, TimeCurrent, TimeEntry, TimesheetSummary, VacationRequest } from "../types";

/**
 * How often a visible tab refreshes it. One refresh on the Zeiterfassung is
 * 9–11 requests (one timesheet per calendar week of the month), so this is
 * roughly 110–130 requests a minute per visible tab; hidden tabs ask nothing
 * (see startVisiblePolling).
 */
export const TIME_DATA_POLL_INTERVAL_MS = 5000;

export type TimeDataQuery = {
  /** The month table: a timesheet per week plus the strict month total.
   * Only the Zeiterfassung shows it; the overview needs the four lists. */
  includeMonthTable: boolean;
  /** Whose data; null asks for the signed-in user's own. */
  userId: number | null;
  entriesStartDate: string;
  entriesEndDate: string;
  /** "YYYY-MM" of the month on screen. */
  monthISO: string;
  /** Monday of every calendar week that touches the month. */
  weekStarts: string[];
};

export type TimeDataSnapshot = {
  current: TimeCurrent;
  entries: TimeEntry[];
  vacationRequests: VacationRequest[];
  schoolAbsences: SchoolAbsence[];
  monthlySheet: TimesheetSummary | null;
  weeklySheets: TimesheetSummary[];
};

type FetchJson = <T>(path: string) => Promise<T>;

function paths(query: TimeDataQuery) {
  const userParam = query.userId != null ? `user_id=${query.userId}` : "";
  const andUser = userParam ? `&${userParam}` : "";
  const onlyUser = userParam ? `?${userParam}` : "";
  const entriesRange =
    query.entriesStartDate && query.entriesEndDate
      ? `&start_date=${query.entriesStartDate}&end_date=${query.entriesEndDate}`
      : "";
  return {
    weekly: query.includeMonthTable
      ? query.weekStarts.map((weekStart) => `/time/timesheet?period=weekly&day=${weekStart}${andUser}`)
      : [],
    // The strict calendar-month total, separate from the weeks: summing the
    // weeks would double-count the days of neighbouring months that fall
    // into the first and last week.
    monthly: query.includeMonthTable ? `/time/timesheet?period=monthly&day=${query.monthISO}-01${andUser}` : null,
    current: `/time/current${onlyUser}`,
    entries: `/time/entries?period=weekly${entriesRange}${andUser}`,
    vacationRequests: `/time/vacation-requests${onlyUser}`,
    schoolAbsences: `/time/school-absences${onlyUser}`,
  };
}

/** Every request one refresh makes, in the order it makes them. */
export function timeDataPaths(query: TimeDataQuery): string[] {
  const plan = paths(query);
  return [
    ...plan.weekly,
    ...(plan.monthly ? [plan.monthly] : []),
    plan.current,
    plan.entries,
    plan.vacationRequests,
    plan.schoolAbsences,
  ];
}

/** One refresh: every request at once, each answer in its place. */
export async function fetchTimeData(fetchJson: FetchJson, query: TimeDataQuery): Promise<TimeDataSnapshot> {
  const plan = paths(query);
  const weekly = plan.weekly.map((path) => fetchJson<TimesheetSummary>(path));
  const monthly = plan.monthly ? fetchJson<TimesheetSummary>(plan.monthly) : Promise.resolve(null);
  const [current, entries, vacationRequests, schoolAbsences, monthlySheet, ...weeklySheets] = await Promise.all([
    fetchJson<TimeCurrent>(plan.current),
    fetchJson<TimeEntry[]>(plan.entries),
    fetchJson<VacationRequest[]>(plan.vacationRequests),
    fetchJson<SchoolAbsence[]>(plan.schoolAbsences),
    monthly,
    ...weekly,
  ]);
  return {
    current: current as TimeCurrent,
    entries: entries as TimeEntry[],
    vacationRequests: vacationRequests as VacationRequest[],
    schoolAbsences: schoolAbsences as SchoolAbsence[],
    monthlySheet: monthlySheet as TimesheetSummary | null,
    weeklySheets: weeklySheets as TimesheetSummary[],
  };
}
