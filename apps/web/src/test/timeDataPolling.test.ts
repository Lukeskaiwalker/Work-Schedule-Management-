/**
 * The Zeiterfassung refresh: what one tick asks the server, and when it asks.
 *
 * A visible Zeiterfassung tab refreshes every 5 s, and a refresh is one
 * request each to /time/current, /time/entries, /time/vacation-requests and
 * /time/school-absences plus a /time/timesheet per calendar week of the month
 * and one for the month itself — 10 in a five-week month, about 120 a minute.
 * Measured 2026-10-11 on a production build (vite preview against a local
 * api): 140 /api/time/* requests in 68 s, ten per tick. The api counted that
 * against the office's one NAT address, together with everybody else's tabs,
 * hidden ones included. These tests pin the polling that keeps it bounded:
 * a hidden tab asks nothing, a tick never stacks on a refresh still in
 * flight, and one tick is exactly one request per endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "../utils/singleFlight";
import { TIME_DATA_POLL_INTERVAL_MS, fetchTimeData, timeDataPaths, type TimeDataQuery } from "../utils/timeData";
import { startVisiblePolling } from "../utils/visiblePolling";
import { monthWeekRanges } from "../utils/dates";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const october2026 = monthWeekRanges(new Date(2026, 9, 1)).map((row) => row.weekStart);

const timePageQuery: TimeDataQuery = {
  includeMonthTable: true,
  userId: null,
  entriesStartDate: "2026-10-01",
  entriesEndDate: "2026-10-31",
  monthISO: "2026-10",
  weekStarts: october2026,
};

/** A fake api: records every path, answers with an empty-but-valid body. */
function recordingFetcher(options: { hang?: boolean } = {}) {
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  const fetchJson = <T,>(path: string): Promise<T> => {
    calls.push(path);
    const body = (path.startsWith("/time/current")
      ? { required_daily_hours: 8 }
      : path.startsWith("/time/timesheet")
        ? { total_hours: 0 }
        : []) as T;
    if (!options.hang) return Promise.resolve(body);
    return new Promise<T>((resolve) => pending.push(() => resolve(body)));
  };
  const perEndpoint = () => {
    const counts = new Map<string, number>();
    for (const path of calls) counts.set(path, (counts.get(path) ?? 0) + 1);
    return counts;
  };
  const releaseAll = () => pending.splice(0).forEach((release) => release());
  return { calls, fetchJson, perEndpoint, releaseAll };
}

function startTimePagePolling(fetcher: ReturnType<typeof recordingFetcher>, query = timePageQuery) {
  const flight = createSingleFlight(async () => {
    await fetchTimeData(fetcher.fetchJson, query);
  });
  const stop = startVisiblePolling({
    intervalMs: TIME_DATA_POLL_INTERVAL_MS,
    refreshNow: () => flight.run(),
    refreshIfIdle: () => flight.runIfIdle(),
  });
  return { flight, stop };
}

async function settle() {
  // Let every resolved fetch and the single-flight bookkeeping run.
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("what one refresh asks for", () => {
  it("is one request per endpoint: four lists, each week of the month, and the month", () => {
    const paths = timeDataPaths(timePageQuery);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual([
      "/time/timesheet?period=weekly&day=2026-09-28",
      "/time/timesheet?period=weekly&day=2026-10-05",
      "/time/timesheet?period=weekly&day=2026-10-12",
      "/time/timesheet?period=weekly&day=2026-10-19",
      "/time/timesheet?period=weekly&day=2026-10-26",
      "/time/timesheet?period=monthly&day=2026-10-01",
      "/time/current",
      "/time/entries?period=weekly&start_date=2026-10-01&end_date=2026-10-31",
      "/time/vacation-requests",
      "/time/school-absences",
    ]);
  });

  it("asks for the chosen employee when a manager picked one", () => {
    const paths = timeDataPaths({ ...timePageQuery, userId: 7 });
    expect(paths).toContain("/time/current?user_id=7");
    expect(paths).toContain("/time/entries?period=weekly&start_date=2026-10-01&end_date=2026-10-31&user_id=7");
    expect(paths).toContain("/time/vacation-requests?user_id=7");
    expect(paths).toContain("/time/school-absences?user_id=7");
    expect(paths).toContain("/time/timesheet?period=monthly&day=2026-10-01&user_id=7");
    expect(paths.filter((path) => path.endsWith("&user_id=7") || path.endsWith("?user_id=7"))).toHaveLength(10);
  });

  it("on the overview skips the month table and asks for the four lists only", () => {
    expect(timeDataPaths({ ...timePageQuery, includeMonthTable: false })).toEqual([
      "/time/current",
      "/time/entries?period=weekly&start_date=2026-10-01&end_date=2026-10-31",
      "/time/vacation-requests",
      "/time/school-absences",
    ]);
  });

  it("hands each answer back in its place", async () => {
    vi.useRealTimers();
    const snapshot = await fetchTimeData(
      <T,>(path: string) =>
        Promise.resolve((path.startsWith("/time/timesheet") ? { total_hours: path.length } : { path }) as T),
      timePageQuery,
    );
    expect(snapshot.current).toEqual({ path: "/time/current" });
    expect(snapshot.schoolAbsences).toEqual({ path: "/time/school-absences" });
    expect(snapshot.monthlySheet).toEqual({ total_hours: "/time/timesheet?period=monthly&day=2026-10-01".length });
    expect(snapshot.weeklySheets).toHaveLength(5);
    expect(snapshot.weeklySheets[0]).toEqual({ total_hours: "/time/timesheet?period=weekly&day=2026-09-28".length });
  });
});

describe("polling the Zeiterfassung", () => {
  it("refreshes on start, then one request per endpoint per tick", async () => {
    const fetcher = recordingFetcher();
    const { stop } = startTimePagePolling(fetcher);
    await settle();
    expect(fetcher.calls).toHaveLength(10);

    await vi.advanceTimersByTimeAsync(TIME_DATA_POLL_INTERVAL_MS);
    expect(fetcher.calls).toHaveLength(20);
    for (const [path, count] of fetcher.perEndpoint()) expect(count, path).toBe(2);

    // A minute of a visible tab: the start plus twelve ticks.
    await vi.advanceTimersByTimeAsync(60_000 - TIME_DATA_POLL_INTERVAL_MS);
    expect(fetcher.calls).toHaveLength(130);
    stop();
  });

  it("asks nothing while the tab is hidden, and catches up once when it is shown", async () => {
    const fetcher = recordingFetcher();
    const { stop } = startTimePagePolling(fetcher);
    await settle();
    expect(fetcher.calls).toHaveLength(10);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetcher.calls).toHaveLength(10);

    setVisibility("visible");
    await settle();
    expect(fetcher.calls).toHaveLength(20);
    for (const [path, count] of fetcher.perEndpoint()) expect(count, path).toBe(2);
    stop();
  });

  it("does not refetch when the tab comes back before the data is due", async () => {
    const fetcher = recordingFetcher();
    const { stop } = startTimePagePolling(fetcher);
    await settle();
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(1_000);
    setVisibility("visible");
    await settle();
    expect(fetcher.calls).toHaveLength(10);
    stop();
  });

  it("does not start a tab that opens hidden until it is shown", async () => {
    visibility = "hidden";
    const fetcher = recordingFetcher();
    const { stop } = startTimePagePolling(fetcher);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher.calls).toHaveLength(0);
    setVisibility("visible");
    await settle();
    expect(fetcher.calls).toHaveLength(10);
    stop();
  });

  it("never stacks a tick on a refresh that has not answered yet", async () => {
    const fetcher = recordingFetcher({ hang: true });
    const { stop } = startTimePagePolling(fetcher);
    await vi.advanceTimersByTimeAsync(6 * TIME_DATA_POLL_INTERVAL_MS);
    expect(fetcher.calls).toHaveLength(10);

    fetcher.releaseAll();
    await settle();
    await vi.advanceTimersByTimeAsync(TIME_DATA_POLL_INTERVAL_MS);
    expect(fetcher.calls).toHaveLength(20);
    stop();
  });

  it("stops completely when stopped", async () => {
    const fetcher = recordingFetcher();
    const { stop } = startTimePagePolling(fetcher);
    await settle();
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(fetcher.calls).toHaveLength(10);
  });
});

describe("createSingleFlight", () => {
  it("folds every request made during a refresh into one more refresh after it", async () => {
    const releases: Array<() => void> = [];
    const task = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const flight = createSingleFlight(task);

    const first = flight.run();
    await settle();
    // A save, an SSE event and a re-render all ask while the first is in flight.
    const second = flight.run();
    const third = flight.run();
    const fourth = flight.run();
    expect(second).toBe(third);
    expect(third).toBe(fourth);
    expect(task).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await first;
    await settle();
    // Exactly one follow-up, started after the first answered, so a caller
    // that saved something sees data fetched after its save.
    expect(task).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await second;
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("lets a poll ride along with a refresh in flight instead of queueing one", async () => {
    const releases: Array<() => void> = [];
    const task = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const flight = createSingleFlight(task);

    const first = flight.run();
    await settle();
    expect(flight.runIfIdle()).toBe(first);
    releases.shift()?.();
    await first;
    await settle();
    expect(task).toHaveBeenCalledTimes(1);

    const next = flight.runIfIdle();
    await settle();
    expect(task).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await next;
  });

  it("recovers after a failed refresh", async () => {
    vi.useRealTimers();
    let fail = true;
    const task = vi.fn(async () => {
      if (fail) throw new Error("network");
    });
    const flight = createSingleFlight(task);
    await expect(flight.run()).rejects.toThrow("network");
    fail = false;
    await expect(flight.run()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });
});
