import { useEffect } from "react";

import { endDashboardSession } from "../utils/dashboardSession";

/**
 * Ends the start page's session (utils/dashboardSession.ts) once the app no
 * longer holds a token: in an effect, after the render that dropped it.
 *
 * Calling endDashboardSession() next to `setToken(null)` cleared the caches
 * while the tree still held the old token. The cleared caches tell their
 * subscribers at once, and on the 401 and expiry paths — no React event
 * around them, so `setToken(null)` waits at default priority — React
 * re-rendered those subscribers first, with the old token: a widget
 * re-created its user's store and asked the server again with the dead token,
 * and an open editor wrote its draft back into the emptied draft memory,
 * where the next sign-in on that tablet found it. Here the clear runs after
 * the commit in which every component already reads `token === null`, and
 * after the effects of the components below (children's effects run first),
 * so nothing that still knows the session can follow it.
 */
export function useDashboardSessionEnd(token: string | null): void {
  useEffect(() => {
    if (!token) endDashboardSession();
  }, [token]);
}
