/**
 * The start page's data cache: one store per signed-in user, one request and
 * one poller per key (docs/DASHBOARD.md D14, §9.3).
 *
 * „Start“ is the most used tab. If every widget fetched for itself on mount,
 * coming back to it would fire ten requests behind ten skeletons, and two
 * widgets showing the same Werkstatt figures would ask for them twice. Here:
 *
 * - A key (`werkstatt:dashboard`, `time:current`, …) has one in-flight request
 *   and one poller, polling at the smallest `pollMs` among its subscribers,
 *   and only while the document is visible and somebody is subscribed.
 * - Stale-while-revalidate: a new subscriber gets the cached data at once and
 *   causes a request only when that data is older than its own `pollMs`. The
 *   last unsubscribe stops the poller and keeps the data for the next visit.
 * - A first failure leaves `data` null with `error` set; a later one keeps the
 *   data and marks it `stale`. A 403 makes the key `forbidden` — no data, no
 *   more requests — until the session ends, because asking again cannot help.
 * - Module-level, so it outlives the page; `endDashboardSession()` drops every
 *   store, aborts what is in flight and discards answers still on their way.
 */
import { ApiError } from "../api/client";
import { onDashboardSessionEnd } from "./dashboardSession";
import { createSingleFlight, type SingleFlight } from "./singleFlight";
import { startVisiblePolling } from "./visiblePolling";

/**
 * What a widget renders from. `loading` means "nothing to show yet": true
 * until the first answer (and again while a retry after a first failure
 * runs), never during a background refresh of data already on screen — so a
 * frame shows skeletons, not a „0“, and polling re-renders nobody until its
 * answer lands. `error` is set only while there is no data; with data on
 * screen a failed refresh sets `stale` instead.
 */
export type ResourceSnapshot<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  forbidden: boolean;
  /** `Date.now()` of the last successful answer; null before the first. */
  loadedAt: number | null;
};

export type DashboardResourceLoader<T> = (token: string | null, signal: AbortSignal) => Promise<T>;

export type DashboardResourceStore = {
  setToken(token: string | null): void;
  /** `pollMs: null` loads once and never polls. The first loader registered for a key wins. */
  subscribe<T>(key: string, loader: DashboardResourceLoader<T>, pollMs: number | null, listener: () => void): () => void;
  getSnapshot<T>(key: string): ResourceSnapshot<T>;
  /**
   * Asks the server again — after the request in flight, if there is one, so
   * the answer is newer than the call. Settles once that answer (or its
   * failure) is in the snapshot; never rejects. A widget that just changed
   * something waits for it before it offers the next action.
   */
  reload(key: string): Promise<void>;
};

type Snapshot = ResourceSnapshot<unknown>;
type Subscriber = { pollMs: number | null; listener: () => void };

type Entry = {
  key: string;
  loader: DashboardResourceLoader<unknown>;
  snapshot: Snapshot;
  subscribers: Set<Subscriber>;
  flight: SingleFlight;
  intervalMs: number | null;
  stopPolling: (() => void) | null;
};

type InternalStore = DashboardResourceStore & {
  dispose(): void;
  /** `reload` for every cached key that matches, subscribed or not. */
  reloadMatching(matches: (key: string) => boolean): void;
};

/** The snapshot of a key nobody has asked for yet. Shared, so its identity is stable. */
const INITIAL_SNAPSHOT: Snapshot = Object.freeze({
  data: null,
  loading: true,
  error: null,
  stale: false,
  forbidden: false,
  loadedAt: null,
});

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Request failed";
}

function isForbidden(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 403;
}

function smallestInterval(subscribers: Iterable<Subscriber>): number | null {
  let smallest: number | null = null;
  for (const { pollMs } of subscribers) {
    if (pollMs !== null && (smallest === null || pollMs < smallest)) smallest = pollMs;
  }
  return smallest;
}

function isFresh(entry: Entry, maxAgeMs: number | null): boolean {
  const { loadedAt } = entry.snapshot;
  if (loadedAt === null) return false;
  return maxAgeMs === null || Date.now() - loadedAt < maxAgeMs;
}

function createStore(onForbidden: (key: string) => void): InternalStore {
  const entries = new Map<string, Entry>();
  const inFlight = new Set<AbortController>();
  let token: string | null = null;
  let disposed = false;

  function publish(entry: Entry, patch: Partial<Snapshot>): void {
    const current = entry.snapshot;
    const fields = Object.keys(patch) as Array<keyof Snapshot>;
    if (fields.every((field) => Object.is(current[field], patch[field]))) return;
    entry.snapshot = { ...current, ...patch };
    // A copy: a listener may unsubscribe while being told.
    for (const subscriber of Array.from(entry.subscribers)) subscriber.listener();
  }

  function stopPolling(entry: Entry): void {
    entry.stopPolling?.();
    entry.stopPolling = null;
    entry.intervalMs = null;
  }

  async function load(entry: Entry): Promise<void> {
    if (disposed || entry.snapshot.forbidden) return;
    const controller = new AbortController();
    inFlight.add(controller);
    // A retry after a failed first load clears the error at once; leaving it
    // up for the whole request reads as "the retry failed too".
    if (entry.snapshot.data === null) publish(entry, { loading: true, error: null });
    try {
      const data = await entry.loader(token, controller.signal);
      // A loader may ignore its signal; an answer for an ended session is dropped.
      if (disposed) return;
      publish(entry, { data, loading: false, error: null, stale: false, loadedAt: Date.now() });
    } catch (cause) {
      if (disposed || controller.signal.aborted) return;
      if (isForbidden(cause)) {
        // The data goes too: access was withdrawn, so what we hold is no
        // longer this user's to see.
        publish(entry, { data: null, loading: false, error: null, stale: false, forbidden: true, loadedAt: null });
        stopPolling(entry);
        onForbidden(entry.key);
        return;
      }
      if (entry.snapshot.data !== null) publish(entry, { loading: false, stale: true });
      else publish(entry, { loading: false, error: messageOf(cause) });
    } finally {
      inFlight.delete(controller);
    }
  }

  /**
   * Starts, re-paces or stops the key's poller to match its subscribers.
   * True when a poller was (re)started: starting asks the server itself when
   * the cache is older than the new interval, so the caller must not.
   */
  function schedule(entry: Entry): boolean {
    const interval = entry.snapshot.forbidden ? null : smallestInterval(entry.subscribers);
    if (interval === entry.intervalMs) return false;
    stopPolling(entry);
    if (interval === null) return false;
    entry.intervalMs = interval;
    entry.stopPolling = startVisiblePolling({
      intervalMs: interval,
      refreshNow: () => (isFresh(entry, interval) ? undefined : entry.flight.runIfIdle()),
      refreshIfIdle: () => entry.flight.runIfIdle(),
    });
    return true;
  }

  function reload(key: string): Promise<void> {
    const entry = entries.get(key);
    if (disposed || !entry || entry.snapshot.forbidden) return Promise.resolve();
    // `load` publishes its own failures; nothing is left to reject with.
    return entry.flight.run().catch(() => undefined);
  }

  function refreshIfStale(entry: Entry, maxAgeMs: number | null): void {
    if (entry.snapshot.forbidden || isFresh(entry, maxAgeMs)) return;
    // A polled key waits for the page to show, as its poller does; it fetches
    // the moment it does.
    if (maxAgeMs !== null && document.visibilityState === "hidden") return;
    void entry.flight.runIfIdle();
  }

  function entryFor(key: string, loader: DashboardResourceLoader<unknown>): Entry {
    const existing = entries.get(key);
    if (existing) return existing;
    const created: Entry = {
      key,
      loader,
      snapshot: INITIAL_SNAPSHOT,
      subscribers: new Set<Subscriber>(),
      // `load` runs on a microtask after `created` is assigned (createSingleFlight).
      flight: createSingleFlight(() => load(created)),
      intervalMs: null,
      stopPolling: null,
    };
    entries.set(key, created);
    return created;
  }

  return {
    setToken(next) {
      token = next;
    },

    subscribe<T>(key: string, loader: DashboardResourceLoader<T>, pollMs: number | null, listener: () => void) {
      // A component can still hold the store of an ended session for one
      // render; it must not start polling on it again.
      if (disposed) return () => undefined;
      const entry = entryFor(key, loader as DashboardResourceLoader<unknown>);
      const subscriber: Subscriber = { pollMs, listener };
      entry.subscribers.add(subscriber);
      if (!schedule(entry)) refreshIfStale(entry, pollMs);
      return () => {
        if (disposed || !entry.subscribers.delete(subscriber)) return;
        schedule(entry);
      };
    },

    getSnapshot<T>(key: string) {
      return (entries.get(key)?.snapshot ?? INITIAL_SNAPSHOT) as ResourceSnapshot<T>;
    },

    reload,

    reloadMatching(matches) {
      for (const key of Array.from(entries.keys())) {
        if (matches(key)) void reload(key);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      token = null;
      const listeners: Array<() => void> = [];
      for (const entry of entries.values()) {
        stopPolling(entry);
        entry.subscribers.forEach((subscriber) => listeners.push(subscriber.listener));
        entry.subscribers.clear();
      }
      entries.clear();
      inFlight.forEach((controller) => controller.abort());
      inFlight.clear();
      // Told last, so whatever they read back is already empty.
      listeners.forEach((listener) => listener());
    },
  };
}

const stores = new Map<number, InternalStore>();
const forbiddenListeners = new Map<number, Set<(key: string) => void>>();

function notifyForbidden(userId: number, key: string): void {
  for (const listener of Array.from(forbiddenListeners.get(userId) ?? [])) {
    try {
      listener(key);
    } catch (error) {
      // One listener failing must not stop the others; the name only (LOG_HYGIENE).
      console.warn("dashboard: a forbidden listener failed", error instanceof Error ? error.name : typeof error);
    }
  }
}

/** The store of one signed-in user. Two users on one device never share one. */
export function getDashboardResourceStore(userId: number): DashboardResourceStore {
  const existing = stores.get(userId);
  if (existing) return existing;
  const created = createStore((key) => notifyForbidden(userId, key));
  stores.set(userId, created);
  return created;
}

/**
 * Asks again for the matching keys this user's store already holds, whether
 * or not a widget shows them right now — for a change made elsewhere in the
 * app. „Start“ serves a re-visit from the cache while the data is younger
 * than its poll interval, so without this a clock-in on the Zeit page would
 * leave „Mein Status“ offering „Einstempeln“ for up to 30 s after coming
 * back, and a vacation request filed there would be missing from „Urlaub“
 * for up to 10 min. Creates no store and no key: what was never shown is
 * loaded fresh when it is.
 */
export function reloadDashboardResources(userId: number, matches: (key: string) => boolean): void {
  stores.get(userId)?.reloadMatching(matches);
}

/**
 * Told when one of this user's widget resources answers 403
 * (docs/DASHBOARD.md §8.1). The start page then refetches its layouts, which
 * normally removes the widget whose permission was withdrawn — the store
 * itself only stops asking. Kept apart from the store's own type so the
 * stores stay plain data caches; unaffected by the session end, since a
 * listener holds nothing of the user's.
 */
export function onDashboardResourceForbidden(userId: number, listener: (key: string) => void): () => void {
  const set = forbiddenListeners.get(userId) ?? new Set<(key: string) => void>();
  set.add(listener);
  forbiddenListeners.set(userId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && forbiddenListeners.get(userId) === set) forbiddenListeners.delete(userId);
  };
}

function clearAllDashboardResourceStores(): void {
  const all = Array.from(stores.values());
  stores.clear();
  all.forEach((store) => store.dispose());
}

onDashboardSessionEnd(clearAllDashboardResourceStores);
