/**
 * Forgetting the start page when the session ends.
 *
 * The start page keeps module-level caches so that coming back to „Start“
 * renders at once: widget data (dashboardResourceStore.ts), the last known
 * layouts and unsaved editor drafts. Module state outlives a sign-out, and
 * workshop tablets are shared — without this, the next person to sign in on
 * the same tablet could see the previous person's hours or absences for the
 * moment before the first request answers.
 *
 * Every such cache registers its clear here once (a Set, so registering the
 * same function again is harmless). App ends it through
 * `useDashboardSessionEnd(token)`, once the token is gone from the tree —
 * never right next to `setToken(null)` (the hook says why).
 */
const clears = new Set<() => void>();

export function onDashboardSessionEnd(clear: () => void): void {
  clears.add(clear);
}

export function endDashboardSession(): void {
  // One cache failing to clear must not keep the others alive: each is a
  // separate leak to the next person on the device.
  for (const clear of Array.from(clears)) {
    try {
      clear();
    } catch (error) {
      // The name only: a cache's error may carry what it held.
      console.warn("dashboard: a session-end cleanup failed", error instanceof Error ? error.name : typeof error);
    }
  }
}
