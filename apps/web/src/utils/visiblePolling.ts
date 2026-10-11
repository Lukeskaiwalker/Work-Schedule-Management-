/**
 * Poll while the page is being looked at, and only then.
 *
 * A tab left open in the background used to keep polling at full rate for as
 * long as it stayed open, and the api counts those requests the same as a
 * person's clicks. Here a tick that finds the page hidden asks nothing, and
 * showing the page again refreshes at once when the data is older than one
 * interval — so a tab brought back after lunch is current immediately, while
 * flicking between tabs costs nothing.
 *
 * `refreshNow` answers the start (a new filter, user or month must be fetched,
 * even over a refresh already in flight); `refreshIfIdle` answers ticks and
 * coming back into view, where data being fetched right now is good enough.
 * Pair them with createSingleFlight's run / runIfIdle.
 *
 * Returns the stop function, for a useEffect cleanup.
 */
export type VisiblePollingOptions = {
  intervalMs: number;
  refreshNow: () => Promise<unknown> | void;
  refreshIfIdle: () => Promise<unknown> | void;
  doc?: Document;
};

export function startVisiblePolling({
  intervalMs,
  refreshNow,
  refreshIfIdle,
  doc = document,
}: VisiblePollingOptions): () => void {
  // -Infinity: nothing fetched yet, so becoming visible always fetches.
  let lastRefreshAt = Number.NEGATIVE_INFINITY;
  const isHidden = () => doc.visibilityState === "hidden";

  function refresh(refreshFn: () => Promise<unknown> | void) {
    lastRefreshAt = Date.now();
    void refreshFn();
  }

  if (!isHidden()) refresh(refreshNow);

  const timer = window.setInterval(() => {
    if (isHidden()) return;
    refresh(refreshIfIdle);
  }, intervalMs);

  function onVisibilityChange() {
    if (isHidden()) return;
    if (Date.now() - lastRefreshAt < intervalMs) return;
    refresh(refreshIfIdle);
  }
  doc.addEventListener("visibilitychange", onVisibilityChange);

  return () => {
    window.clearInterval(timer);
    doc.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
