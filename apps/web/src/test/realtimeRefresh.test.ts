/**
 * What a server event makes a tab fetch, and when.
 *
 * Every SSE event made every open tab refetch: the project lists for task and
 * project events, the thread list for chat events, and the open view for
 * almost everything — on the Zeiterfassung a full time refresh, 9–11 requests,
 * though no event carries time data. An admin receives every event in the
 * company, and since 2026-10-11 all of one person's requests share one
 * allowance, so the cost grew with the company's activity times the number of
 * tabs open, hidden ones included. These tests pin what replaced that:
 *
 *  - the Zeiterfassung is not refreshed by events at all (its 5 s poll is);
 *  - a hidden tab fetches nothing and catches up once per kind when shown;
 *  - a visible tab answers the first event at once and a burst behind it with
 *    one more refresh at most every REALTIME_REFRESH_MIN_INTERVAL_MS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REALTIME_REFRESH_MIN_INTERVAL_MS,
  createRealtimeRefresher,
  realtimeRefreshesFor,
  type PacedRealtimeRefresh,
} from "../utils/realtimeRefresh";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

const WINDOW = REALTIME_REFRESH_MIN_INTERVAL_MS;

/** A refresher whose refreshes are recorded, and optionally held open. */
function recordingRefresher(options: { hang?: boolean } = {}) {
  const runs: PacedRealtimeRefresh[] = [];
  const pending: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const refresher = createRealtimeRefresher<PacedRealtimeRefresh>({
    minIntervalMs: WINDOW,
    refresh: (key) => {
      runs.push(key);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const done = () => {
        inFlight -= 1;
      };
      if (!options.hang) {
        done();
        return Promise.resolve();
      }
      return new Promise<void>((resolve) =>
        pending.push(() => {
          done();
          resolve();
        }),
      );
    },
  });
  const count = (key: PacedRealtimeRefresh) => runs.filter((run) => run === key).length;
  const releaseAll = () => pending.splice(0).forEach((release) => release());
  return { refresher, runs, count, releaseAll, maxInFlight: () => maxInFlight };
}

async function settle() {
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

describe("which refreshes an event asks for", () => {
  const timeViewEvents = [
    "task.created",
    "task.updated",
    "task.deleted",
    "task.assigned",
    "project.updated",
    "message.created",
    "thread.created",
    "thread.updated",
    "connected-but-unknown.kind",
  ];

  it("on the Zeiterfassung, no event refetches the open view: nothing on it comes by event", () => {
    for (const eventType of timeViewEvents) {
      expect(realtimeRefreshesFor(eventType, "time"), eventType).not.toContain("activeView");
    }
    expect(realtimeRefreshesFor("task.updated", "time")).toEqual(["projectLists", "taskRevision"]);
    expect(realtimeRefreshesFor("message.created", "time")).toEqual(["threads"]);
    expect(realtimeRefreshesFor("project.updated", "time")).toEqual(["projectLists"]);
  });

  it("everywhere else asks for what it asked for before", () => {
    expect(realtimeRefreshesFor("task.updated", "project")).toEqual(["projectLists", "taskRevision", "activeView"]);
    expect(realtimeRefreshesFor("task.assigned", "project")).toEqual(["projectLists", "activeView"]);
    expect(realtimeRefreshesFor("project.updated", "overview")).toEqual(["projectLists", "activeView"]);
    expect(realtimeRefreshesFor("message.created", "messages")).toEqual(["threads", "activeView"]);
    expect(realtimeRefreshesFor("thread.updated", "my_tasks")).toEqual(["threads", "activeView"]);
    // Planning and calendar answer task changes only, so a chat message does
    // not flash their loading state.
    for (const view of ["planning", "calendar"]) {
      expect(realtimeRefreshesFor("task.deleted", view)).toEqual(["projectLists", "taskRevision", "activeView"]);
      expect(realtimeRefreshesFor("message.created", view)).toEqual(["threads"]);
      expect(realtimeRefreshesFor("project.updated", view)).toEqual(["projectLists"]);
    }
  });

  it("answers a personal notification with the notifications and nothing else", () => {
    for (const view of ["time", "project", "planning", "messages"]) {
      expect(realtimeRefreshesFor("notification.created", view)).toEqual(["notifications"]);
      expect(realtimeRefreshesFor("notification.resolved", view)).toEqual(["notifications"]);
    }
  });

  it("ignores an event without a type", () => {
    expect(realtimeRefreshesFor("", "project")).toEqual([]);
    expect(realtimeRefreshesFor("   ", "project")).toEqual([]);
  });

  it("reads the type the way the server spells it, whatever the case", () => {
    expect(realtimeRefreshesFor(" Task.Updated ", "project")).toEqual(["projectLists", "taskRevision", "activeView"]);
  });
});

describe("pacing and pausing", () => {
  it("answers the first event at once and a burst behind it once, at the end of the window", async () => {
    const { refresher, count } = recordingRefresher();
    refresher.request("projectLists");
    await settle();
    expect(count("projectLists")).toBe(1);

    for (let index = 0; index < 10; index += 1) {
      await vi.advanceTimersByTimeAsync(WINDOW / 20);
      refresher.request("projectLists");
    }
    expect(count("projectLists")).toBe(1);
    await vi.advanceTimersByTimeAsync(WINDOW);
    // The last event of the burst is always answered...
    expect(count("projectLists")).toBe(2);
    // ...and nothing runs that no event asked for.
    await vi.advanceTimersByTimeAsync(WINDOW * 10);
    expect(count("projectLists")).toBe(2);
    refresher.stop();
  });

  it("answers an event at once again when the last refresh is older than the window", async () => {
    const { refresher, count } = recordingRefresher();
    refresher.request("threads");
    await vi.advanceTimersByTimeAsync(WINDOW + 1);
    refresher.request("threads");
    await settle();
    expect(count("threads")).toBe(2);
    refresher.stop();
  });

  it("paces each kind on its own", async () => {
    const { refresher, runs } = recordingRefresher();
    refresher.request("projectLists");
    refresher.request("threads");
    refresher.request("activeView");
    refresher.request("taskRevision");
    await settle();
    expect(runs).toEqual(["projectLists", "threads", "activeView", "taskRevision"]);
    refresher.stop();
  });

  it("fetches nothing in a hidden tab and catches up once per kind when shown", async () => {
    const { refresher, runs, count } = recordingRefresher();
    setVisibility("hidden");
    for (let minute = 0; minute < 30; minute += 1) {
      refresher.request("projectLists");
      refresher.request("activeView");
      refresher.request("projectLists");
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(runs).toEqual([]);

    setVisibility("visible");
    await settle();
    expect(count("projectLists")).toBe(1);
    expect(count("activeView")).toBe(1);
    expect(count("threads")).toBe(0);
    await vi.advanceTimersByTimeAsync(WINDOW * 10);
    expect(runs).toHaveLength(2);

    // Flicking away and back with nothing asked for in between costs nothing.
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(WINDOW * 2);
    expect(runs).toHaveLength(2);
    refresher.stop();
  });

  it("holds a refresh that falls due while the tab is hidden until it is shown", async () => {
    const { refresher, count } = recordingRefresher();
    refresher.request("activeView");
    refresher.request("activeView");
    await settle();
    expect(count("activeView")).toBe(1);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(WINDOW * 3);
    expect(count("activeView")).toBe(1);
    setVisibility("visible");
    await settle();
    expect(count("activeView")).toBe(2);
    refresher.stop();
  });

  it("never runs one kind twice at the same time", async () => {
    const recorder = recordingRefresher({ hang: true });
    const { refresher, count } = recorder;
    refresher.request("activeView");
    await settle();
    for (let index = 0; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(WINDOW);
      refresher.request("activeView");
    }
    await vi.advanceTimersByTimeAsync(WINDOW);
    // The server is slow: the first refresh is still open, so the next waits
    // for it instead of joining it on the wire.
    expect(count("activeView")).toBe(1);
    expect(recorder.maxInFlight()).toBe(1);
    recorder.releaseAll();
    await settle();
    expect(count("activeView")).toBe(2);
    recorder.releaseAll();
    await vi.advanceTimersByTimeAsync(WINDOW * 3);
    expect(recorder.maxInFlight()).toBe(1);
    refresher.stop();
  });

  it("leaves nothing behind when stopped", async () => {
    const { refresher, runs } = recordingRefresher();
    refresher.request("threads");
    refresher.request("threads");
    setVisibility("hidden");
    refresher.request("projectLists");
    refresher.stop();
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(WINDOW * 3);
    refresher.request("activeView");
    await settle();
    expect(runs).toEqual(["threads"]);
  });
});

describe("what an admin's tab costs while the office is busy", () => {
  /** Requests each refresh makes on the project task view. The task revision
   * costs nothing there: only the customer page's task card reads it. */
  const REQUESTS: Record<string, number> = { projectLists: 2, threads: 1, activeView: 1, taskRevision: 0 };

  /** Ten minutes of one event every two seconds — task and chat events
   * alternating, 30 a minute — as an admin, who receives all of them. */
  async function busyOffice(view: string, recorder: ReturnType<typeof recordingRefresher>) {
    const sent = { requests: 0 };
    for (let second = 0; second < 600; second += 2) {
      const eventType = (second / 2) % 2 === 0 ? "task.updated" : "message.created";
      for (const refresh of realtimeRefreshesFor(eventType, view)) {
        if (refresh !== "notifications") recorder.refresher.request(refresh);
      }
      await vi.advanceTimersByTimeAsync(2000);
    }
    for (const run of recorder.runs) sent.requests += REQUESTS[run];
    return sent.requests / 10;
  }

  it("a visible tab: at most one refresh per kind per window, however many events", async () => {
    const recorder = recordingRefresher();
    const perMinute = await busyOffice("project", recorder);
    const perKindPerMinute = 60_000 / WINDOW;
    for (const kind of ["projectLists", "threads", "activeView", "taskRevision"] as const) {
      // One per window over the ten minutes, plus the one that opened them.
      expect(recorder.count(kind), kind).toBeLessThanOrEqual(10 * perKindPerMinute + 1);
    }
    // Answering every event used to be 15 × (2 + 1) + 15 × (1 + 1) = 75
    // requests a minute here; paced, the ceiling no longer moves with the
    // event rate: 12 × (2 + 1 + 1) = 48 at most, whatever the office does.
    expect(perMinute).toBeLessThanOrEqual(perKindPerMinute * (2 + 1 + 1) + 1);
    recorder.refresher.stop();
  });

  it("a visible Zeiterfassung: events cost no /time request at all", async () => {
    const recorder = recordingRefresher();
    await busyOffice("time", recorder);
    expect(recorder.count("activeView")).toBe(0);
    recorder.refresher.stop();
  });

  it("a hidden tab: nothing until it is shown, then one refresh per kind", async () => {
    const recorder = recordingRefresher();
    setVisibility("hidden");
    const perMinute = await busyOffice("project", recorder);
    expect(perMinute).toBe(0);
    setVisibility("visible");
    await settle();
    expect([...recorder.runs].sort()).toEqual(["activeView", "projectLists", "taskRevision", "threads"]);
    recorder.refresher.stop();
  });
});
