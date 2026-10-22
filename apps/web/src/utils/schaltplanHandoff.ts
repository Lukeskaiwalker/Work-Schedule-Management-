/**
 * „Zuletzt bearbeitete Verteiler“ → the Schaltplan editor, with that panel open.
 *
 * The start page and SchaltplanPage share no state: the page keeps its
 * selection to itself, and a navigation is only `setMainView("schaltplan")`.
 * So the start page leaves the panel here and the page picks it up in a mount
 * effect (docs/DASHBOARD.md §9.5).
 *
 * Peek and clear are separate on purpose. React.StrictMode (main.tsx) runs a
 * mount effect twice; a take-once read would hand the panel to the first run,
 * which StrictMode throws away, and the real mount would open nothing. The
 * page clears only after the panel actually opened.
 *
 * A request expires after 30 s, so a panel asked for and never opened (the
 * tab was left at once) does not pop up on some later visit.
 */
import type { PanelPlanSummary } from "../types/schaltplan";
import { onDashboardSessionEnd } from "./dashboardSession";

const MAX_AGE_MS = 30_000;

let pending: { summary: PanelPlanSummary; requestedAt: number } | null = null;

export function requestOpenPanel(summary: PanelPlanSummary): void {
  pending = { summary, requestedAt: Date.now() };
}

/** The panel asked for, or null once it is older than 30 s. Does not consume it. */
export function peekPendingPanel(now: number = Date.now()): PanelPlanSummary | null {
  if (!pending || now - pending.requestedAt > MAX_AGE_MS) return null;
  return pending.summary;
}

export function clearPendingPanel(): void {
  pending = null;
}

// The summary names a customer; it must not survive into the next session on
// a shared tablet.
onDashboardSessionEnd(clearPendingPanel);
