import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One loader, four states, shared by the Werkstatt dashboard and the "Auf
 * Baustelle" list.
 *
 * The state that matters is `error`. Both screens are read as fact by a
 * workshop — "wieviel liegt noch draußen" is the reason somebody opens them —
 * so a failed load must never leave a zero on screen. `data` therefore stays
 * `null` until a response actually lands, and the pages render the numbers as
 * "–" while it is null. Keeping the last good payload on a later failure would
 * be the same lie with a longer fuse.
 */
export interface WerkstattOverviewState<T> {
  data: T | null;
  loading: boolean;
  /** Message from the failed load; null while things are fine. */
  error: string | null;
  reload: () => void;
}

export function useWerkstattOverview<T>(
  active: boolean,
  token: string | null,
  load: (token: string | null, signal: AbortSignal) => Promise<T>,
  fallbackMessage: string,
): WerkstattOverviewState<T> {
  const [data, setData] = useState<T | null>(null);
  // Starts true when the screen is already showing: the effect below only
  // fires AFTER the first paint, so a `false` here would let the pages paint
  // one frame of "nothing to report" before anything had been asked of the
  // server. Callers still have to treat `data == null && error == null` as
  // loading, because a tab switched on later hits the same gap.
  const [loading, setLoading] = useState(active);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Held in a ref rather than read from the closure: the message is
  // language-dependent, and as an effect dependency it would re-issue the
  // whole request every time somebody flips DE/EN.
  const fallbackRef = useRef(fallbackMessage);
  fallbackRef.current = fallbackMessage;

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    // A retry clears the old failure right away. Leaving it up would keep the
    // red "could not be loaded" banner on screen for the whole request the
    // user just started, which reads as "the retry failed too" and gets
    // clicked again. `data` stays null until a response lands, so nothing
    // stale becomes visible.
    setError(null);
    void load(token, controller.signal)
      .then((payload) => {
        if (cancelled) return;
        setData(payload);
        setError(null);
      })
      .catch((cause: unknown) => {
        // An abort is this effect tearing itself down, not a failure to report.
        if (cancelled || controller.signal.aborted) return;
        setData(null);
        setError(cause instanceof Error && cause.message ? cause.message : fallbackRef.current);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `load` is deliberately absent from the deps. Both call sites pass a
    // module-level function, so it never changes; an inline lambda would change
    // identity every render and turn this into an endless refetch loop, which
    // is a bug to prevent rather than a dependency to track.
  }, [active, token, reloadTick]);

  return { data, loading, error, reload };
}
