/**
 * What a server event makes a tab fetch, and when it fetches it.
 *
 * Every SSE event used to make every open tab refetch at once: the project
 * lists for task and project events, the thread list for chat events, and the
 * open view for almost everything — on the Zeiterfassung a full time refresh of
 * 9–11 requests, though no event carries time data. An admin receives every
 * event in the company, and the api counts all of one person's requests
 * against one allowance (apps/api/app/main.py, _rate_limit_key), so that cost
 * grew with the company's activity times the tabs the person had open, hidden
 * ones included, until the allowance ran out (2026-10-11 review).
 *
 * `realtimeRefreshesFor` says what an event asks for; `createRealtimeRefresher`
 * decides when it is fetched. Tested in src/test/realtimeRefresh.test.ts.
 */
import { createSingleFlight, type SingleFlight } from "./singleFlight";

export type RealtimeRefresh = "notifications" | "projectLists" | "threads" | "activeView" | "taskRevision";

/** Everything but the notifications goes through the refresher. Those stay
 * immediate in every tab, hidden included: they are personal (one recipient
 * per event) and loading them is what raises the browser notification. */
export type PacedRealtimeRefresh = Exclude<RealtimeRefresh, "notifications">;

/**
 * The shortest gap between two event-driven refreshes of the same kind in a
 * visible tab. The first event is answered at once; a burst behind it costs
 * one more refresh at the end of the window, so a visible tab refetches each
 * kind at most 12 times a minute however busy the office is. The same 5 s as
 * the Zeiterfassung poll (TIME_DATA_POLL_INTERVAL_MS).
 */
export const REALTIME_REFRESH_MIN_INTERVAL_MS = 5000;

/** Views that refresh on task changes only, so a chat message or a project
 * edit does not flash their loading state. The overview's open view is the
 * user's own tasks; its start-page widgets read the thread and project lists
 * (refreshed by their own kinds) or poll for themselves. Before, every event
 * an admin received, chat included, reloaded the overview's tasks and
 * reports. */
const TASK_EVENTS_ONLY_VIEWS = new Set(["planning", "calendar", "overview"]);

/** Views that no event feeds. The Zeiterfassung shows clock state, entries,
 * timesheets, vacation and school absences; no event carries any of that, and
 * its own 5 s poll keeps it current. Refreshing it per event was 9–11 requests
 * for nothing. */
const NO_EVENT_VIEWS = new Set(["time"]);

const TASK_CHANGES = new Set(["task.created", "task.updated", "task.deleted"]);

/** What one server event asks a tab to refresh, given the view on screen. */
export function realtimeRefreshesFor(rawEventType: string, mainView: string): RealtimeRefresh[] {
  const eventType = String(rawEventType || "").trim().toLowerCase();
  if (!eventType) return [];
  // Personal, and fully answered by reloading them. `notification.resolved`
  // fires when a task is completed or deleted and its notifications are
  // retired server-side; without it here a panel that is already open would
  // keep an entry for a task somebody else just finished — the "task is done
  // but the notification is still there" report.
  if (eventType === "notification.created" || eventType === "notification.resolved") return ["notifications"];

  const refreshes: RealtimeRefresh[] = [];
  // Project headers and sidebars show task and project state.
  if (eventType.startsWith("task.") || eventType.startsWith("project.")) refreshes.push("projectLists");
  // Read by the customer page's task card, wherever a task changed.
  if (TASK_CHANGES.has(eventType)) refreshes.push("taskRevision");
  // The thread list stays fresh outside the messages view too.
  if (eventType.startsWith("message.") || eventType.startsWith("thread.")) refreshes.push("threads");

  if (NO_EVENT_VIEWS.has(mainView)) return refreshes;
  if (TASK_EVENTS_ONLY_VIEWS.has(mainView) && !TASK_CHANGES.has(eventType)) return refreshes;
  refreshes.push("activeView");
  return refreshes;
}

export type RealtimeRefresher<K extends string> = {
  /** Ask for a refresh of `key`, as an event did. */
  request: (key: K) => void;
  /** Cancel what is booked and stop listening; later requests do nothing. */
  stop: () => void;
};

export type RealtimeRefresherOptions<K extends string> = {
  refresh: (key: K) => Promise<unknown> | unknown;
  minIntervalMs: number;
  doc?: Document;
};

/**
 * Event-driven refreshes, paced and paused with the page.
 *
 * - Visible: the first request for a kind runs at once. Requests inside the
 *   following `minIntervalMs` book one more run at the end of that window, so
 *   the last event of a burst is always answered and a burst costs one run.
 * - Hidden: nothing runs. What was asked for is remembered and run once, per
 *   kind, when the page is shown again — through the same pacing.
 * - A kind never runs twice at once: a run that falls due while the previous
 *   one is still open waits for it (createSingleFlight's run).
 */
export function createRealtimeRefresher<K extends string>({
  refresh,
  minIntervalMs,
  doc = document,
}: RealtimeRefresherOptions<K>): RealtimeRefresher<K> {
  type KindState = { lastRunAt: number; timer: number | null; flight: SingleFlight };
  const kinds = new Map<K, KindState>();
  const askedWhileHidden = new Set<K>();
  let stopped = false;
  const isHidden = () => doc.visibilityState === "hidden";

  function stateOf(key: K): KindState {
    let state = kinds.get(key);
    if (!state) {
      // -Infinity: never run, so the first request runs at once.
      state = { lastRunAt: Number.NEGATIVE_INFINITY, timer: null, flight: createSingleFlight(() => Promise.resolve(refresh(key))) };
      kinds.set(key, state);
    }
    return state;
  }

  function run(key: K, state: KindState) {
    state.lastRunAt = Date.now();
    // Background sync: a failed refresh is retried by the next event or poll.
    void state.flight.run().catch(() => undefined);
  }

  function request(key: K) {
    if (stopped) return;
    if (isHidden()) {
      askedWhileHidden.add(key);
      return;
    }
    const state = stateOf(key);
    if (state.timer !== null) return;
    const wait = state.lastRunAt + minIntervalMs - Date.now();
    if (wait <= 0) {
      run(key, state);
      return;
    }
    state.timer = window.setTimeout(() => {
      state.timer = null;
      if (isHidden()) {
        askedWhileHidden.add(key);
        return;
      }
      run(key, state);
    }, wait);
  }

  function onVisibilityChange() {
    if (isHidden()) return;
    const keys = [...askedWhileHidden];
    askedWhileHidden.clear();
    keys.forEach(request);
  }
  doc.addEventListener("visibilitychange", onVisibilityChange);

  function stop() {
    stopped = true;
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    for (const state of kinds.values()) {
      if (state.timer !== null) window.clearTimeout(state.timer);
      state.timer = null;
    }
    askedWhileHidden.clear();
  }

  return { request, stop };
}
