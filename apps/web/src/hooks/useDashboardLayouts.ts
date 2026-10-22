import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  DASHBOARD_DEVICES,
  DASHBOARD_SHORTCUT_VIEWS,
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_WIDGET_SIZES,
  type DashboardDevice,
  type DashboardLayout,
  type DashboardShortcutView,
  type DashboardState,
  type DashboardWidgetId,
  type DashboardWidgetItem,
  type DashboardWidgetSize,
} from "../types/dashboard";
import { fetchDashboard, resetDashboardLayout, saveDashboardLayout } from "../utils/dashboardApi";
import { onDashboardSessionEnd } from "../utils/dashboardSession";

/**
 * The user's three start-page layouts (docs/DASHBOARD.md §9.1 step 2).
 *
 * One module-level last-known value per user, so coming back to „Start“
 * renders at once and revalidates behind it (`GET /api/dashboard` on every
 * mount). On a cold start — first visit since the app loaded — the value is
 * seeded from localStorage, which holds the widget ids, sizes and tile choices
 * only; it is shown at once but marked unconfirmed, because it knows neither
 * where a layout came from nor what the user may add, so editing waits for the
 * server.
 *
 * Writes go through `save` and `reset`, which patch one device from the
 * server's answer. A GET that was already on its way when a write landed is
 * older than that write and is dropped, or a slow revalidation could put the
 * old layout back on screen right after „Fertig“.
 *
 * Everything in memory is dropped when the session ends (shared workshop
 * tablets); an answer for an ended session is discarded on arrival.
 */
export type DashboardLayoutsState = {
  state: DashboardState | null;
  /** True while there is no server answer yet and one is on its way. */
  loading: boolean;
  /** Set while there is no server answer to show; a failed background refresh keeps the data and sets nothing. */
  error: string | null;
  /** The state came from the server in this session (not only from the stored copy). */
  confirmed: boolean;
  /** Fetches again; resolves to the state after the answer (null when there is none). Never throws. */
  reload: () => Promise<DashboardState | null>;
  /** Throws ApiError; on success the device's layout is the server's answer. */
  save: (device: DashboardDevice, widgets: DashboardWidgetItem[]) => Promise<void>;
  /** Throws; on success the device shows the layout that applies now (role or built-in). */
  reset: (device: DashboardDevice) => Promise<void>;
};

type Snapshot = Pick<DashboardLayoutsState, "state" | "loading" | "error" | "confirmed">;

type Entry = {
  snapshot: Snapshot;
  request: Promise<DashboardState | null> | null;
  /** Bumped by every successful save or reset; a GET started before the last one is stale. */
  writes: number;
};

const STORAGE_PREFIX = "smpl_dashboard_layouts:";
const STORAGE_VERSION = 1;

const IDLE: Snapshot = Object.freeze({ state: null, loading: false, error: null, confirmed: false });

const KNOWN_IDS: ReadonlySet<string> = new Set(DASHBOARD_WIDGET_IDS);
const KNOWN_SIZES: ReadonlySet<string> = new Set(DASHBOARD_WIDGET_SIZES);
const KNOWN_VIEWS: ReadonlySet<string> = new Set(DASHBOARD_SHORTCUT_VIEWS);

/** Never read: the seeded state cannot be edited before the server confirms it. */
const SEED_DEFAULT_SIZES = Object.freeze(
  Object.fromEntries(DASHBOARD_WIDGET_IDS.map((id) => [id, "medium"])),
) as Record<DashboardWidgetId, DashboardWidgetSize>;

const entries = new Map<number, Entry>();
// Apart from the entries, so a component subscribed before the session ended
// still hears about the fresh entry created after it.
const listeners = new Map<number, Set<() => void>>();

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : "Request failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ── The stored copy ────────────────────────────────────────────────────────

/** Item by item: what this build does not know is dropped, never guessed. */
function cleanStoredItems(raw: readonly unknown[]): DashboardWidgetItem[] {
  const seen = new Set<string>();
  const items: DashboardWidgetItem[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const { id, size, settings } = candidate;
    if (typeof id !== "string" || !KNOWN_IDS.has(id) || seen.has(id)) continue;
    if (typeof size !== "string" || !KNOWN_SIZES.has(size)) continue;
    seen.add(id);
    const rawViews = id === "shortcuts" && isRecord(settings) && Array.isArray(settings.views) ? settings.views : [];
    const views = Array.from(
      new Set(rawViews.filter((view): view is DashboardShortcutView => typeof view === "string" && KNOWN_VIEWS.has(view))),
    );
    const item = { id: id as DashboardWidgetId, size: size as DashboardWidgetSize };
    items.push(views.length > 0 ? { ...item, settings: { views } } : item);
  }
  return items;
}

function seededLayout(device: DashboardDevice, widgets: DashboardWidgetItem[]): DashboardLayout {
  return { device, version: 1, widgets, source: "builtin", updated_at: null, role_changed: false };
}

function readStored(userId: number): DashboardState | null {
  // Every access guarded: private windows, blocked site data and quota all
  // throw, and the stored copy is only ever a convenience.
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== STORAGE_VERSION || !isRecord(parsed.layouts)) return null;
    const stored = parsed.layouts;
    if (DASHBOARD_DEVICES.some((device) => !Array.isArray(stored[device]))) return null;
    const layout = (device: DashboardDevice) => seededLayout(device, cleanStoredItems(stored[device] as unknown[]));
    return {
      layouts: { mobile: layout("mobile"), tablet: layout("tablet"), desktop: layout("desktop") },
      available_widgets: [],
      default_sizes: SEED_DEFAULT_SIZES,
    };
  } catch {
    return null;
  }
}

function writeStored(userId: number, state: DashboardState): void {
  const strip = (item: DashboardWidgetItem): DashboardWidgetItem =>
    item.settings ? { id: item.id, size: item.size, settings: { views: [...item.settings.views] } } : { id: item.id, size: item.size };
  const layouts = Object.fromEntries(DASHBOARD_DEVICES.map((device) => [device, state.layouts[device].widgets.map(strip)]));
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify({ version: STORAGE_VERSION, layouts }));
  } catch {
    // Quota or blocked storage: the next cold start simply waits for the server.
  }
}

// ── The module-level cache ─────────────────────────────────────────────────

function entryFor(userId: number): Entry {
  const existing = entries.get(userId);
  if (existing) return existing;
  // `loading` from the start: the mounting hook asks the server right away.
  const created: Entry = {
    snapshot: { state: readStored(userId), loading: true, error: null, confirmed: false },
    request: null,
    writes: 0,
  };
  entries.set(userId, created);
  return created;
}

function publish(userId: number, entry: Entry, patch: Partial<Snapshot>): void {
  entry.snapshot = { ...entry.snapshot, ...patch };
  listeners.get(userId)?.forEach((listener) => listener());
}

function subscribeLayouts(userId: number, listener: () => void): () => void {
  const set = listeners.get(userId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(userId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(userId) === set) listeners.delete(userId);
  };
}

function fetchLayouts(userId: number, token: string | null): Promise<DashboardState | null> {
  const entry = entryFor(userId);
  if (entry.request) return entry.request;
  const writesAtStart = entry.writes;
  // A retry after a failed first load clears the error at once.
  if (!entry.snapshot.confirmed) publish(userId, entry, { loading: true, error: null });

  const request = (async (): Promise<DashboardState | null> => {
    try {
      const fresh = await fetchDashboard(token);
      if (entries.get(userId) !== entry) return null;
      if (entry.writes !== writesAtStart) {
        publish(userId, entry, { loading: false });
        return entry.snapshot.state;
      }
      publish(userId, entry, { state: fresh, loading: false, error: null, confirmed: true });
      writeStored(userId, fresh);
      return fresh;
    } catch (cause) {
      if (entries.get(userId) !== entry) return null;
      // With confirmed data on screen a failed refresh changes nothing visible.
      publish(userId, entry, { loading: false, error: entry.snapshot.confirmed ? null : messageOf(cause) });
      return entry.snapshot.state;
    } finally {
      // Nothing else can have started on this entry while this one was in flight.
      entry.request = null;
    }
  })();
  entry.request = request;
  return request;
}

/** Puts the server's answer for one device in place; ignored once the session has ended. */
function applyLayout(userId: number, entry: Entry, device: DashboardDevice, layout: DashboardLayout): void {
  if (entries.get(userId) !== entry) return;
  entry.writes += 1;
  const current = entry.snapshot.state;
  if (!current) return;
  const next: DashboardState = { ...current, layouts: { ...current.layouts, [device]: { ...layout, device } } };
  publish(userId, entry, { state: next });
  writeStored(userId, next);
}

function clearAllLayouts(): void {
  entries.clear();
  // Told after the clear, so whatever they read back is already empty.
  Array.from(listeners.values()).forEach((set) => Array.from(set).forEach((listener) => listener()));
}

onDashboardSessionEnd(clearAllLayouts);

// ── The hook ───────────────────────────────────────────────────────────────

export function useDashboardLayouts(token: string | null, userId: number | null): DashboardLayoutsState {
  const active = userId !== null && Boolean(token);
  // A ref, not a dependency: a new token must not refetch or re-create the callbacks.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const subscribe = useCallback(
    (listener: () => void) => (userId === null ? () => undefined : subscribeLayouts(userId, listener)),
    [userId],
  );
  const getSnapshot = useCallback(
    (): Snapshot => (active && userId !== null ? entryFor(userId).snapshot : IDLE),
    [active, userId],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!active || userId === null) return;
    void fetchLayouts(userId, tokenRef.current);
  }, [active, userId]);

  const reload = useCallback(
    () => (userId === null || !tokenRef.current ? Promise.resolve(null) : fetchLayouts(userId, tokenRef.current)),
    [userId],
  );

  const save = useCallback(
    async (device: DashboardDevice, widgets: DashboardWidgetItem[]) => {
      if (userId === null) throw new Error("Not signed in");
      const entry = entryFor(userId);
      const saved = await saveDashboardLayout(tokenRef.current, device, { version: 1, widgets });
      applyLayout(userId, entry, device, saved);
    },
    [userId],
  );

  const reset = useCallback(
    async (device: DashboardDevice) => {
      if (userId === null) throw new Error("Not signed in");
      const entry = entryFor(userId);
      const resolved = await resetDashboardLayout(tokenRef.current, device);
      applyLayout(userId, entry, device, resolved);
    },
    [userId],
  );

  return useMemo(() => ({ ...snapshot, reload, save, reset }), [snapshot, reload, save, reset]);
}
