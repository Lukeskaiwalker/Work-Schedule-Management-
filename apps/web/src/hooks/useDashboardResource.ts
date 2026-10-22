import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { useAppContext } from "../context/AppContext";
import {
  getDashboardResourceStore,
  type DashboardResourceLoader,
  type ResourceSnapshot,
} from "../utils/dashboardResourceStore";

/**
 * A start-page widget's data, from the per-user resource store (docs/
 * DASHBOARD.md §9.3; utils/dashboardResourceStore.ts).
 *
 * Pass a module-level `loader`: the first one registered for a key wins, and
 * two widgets sharing a key (`time:current`, `werkstatt:dashboard`) must
 * import the same one. `pollMs` comes from DASHBOARD_POLL_MS. `enabled: false`
 * subscribes to nothing and reads idle unless the key already holds data.
 */
export type DashboardResourceOptions = { pollMs: number | null; enabled?: boolean };
/** `reload` settles once the new answer is in the snapshot (see the store); it never rejects. */
export type DashboardResourceState<T> = ResourceSnapshot<T> & { reload: () => Promise<void> };

/** Read when nothing is being asked for: no user yet, or switched off. */
const IDLE: ResourceSnapshot<never> = Object.freeze({
  data: null,
  loading: false,
  error: null,
  stale: false,
  forbidden: false,
  loadedAt: null,
});

export function useDashboardResource<T>(
  key: string,
  loader: DashboardResourceLoader<T>,
  options: DashboardResourceOptions,
): DashboardResourceState<T> {
  const { token, user } = useAppContext();
  const userId = user?.id ?? null;
  const { pollMs } = options;
  const enabled = options.enabled ?? true;
  // No token, no store: the render that drops the token comes before the
  // session end clears the stores (hooks/useDashboardSessionEnd.ts), and
  // before the user is cleared; it must not create a fresh store and refill it.
  const store = userId === null || !token ? null : getDashboardResourceStore(userId);

  // Refs, not dependencies: a token refresh must not drop and re-create the
  // subscription (and with it the poller), and an inline loader would do so
  // on every render.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    store?.setToken(token);
  }, [store, token]);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!store || !enabled) return () => undefined;
      // Set before subscribing: subscribing may start the first request.
      store.setToken(tokenRef.current);
      return store.subscribe(key, loaderRef.current, pollMs, listener);
    },
    [store, key, pollMs, enabled],
  );

  const getSnapshot = useCallback((): ResourceSnapshot<T> => {
    if (!store) return IDLE;
    const snapshot = store.getSnapshot<T>(key);
    if (!enabled && snapshot.data === null && !snapshot.forbidden) return IDLE;
    return snapshot;
  }, [store, key, enabled]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  const reload = useCallback(() => (store ? store.reload(key) : Promise.resolve()), [store, key]);

  return useMemo(() => ({ ...snapshot, reload }), [snapshot, reload]);
}
