/**
 * How often each start-page resource refreshes while the page is visible.
 *
 * One table, so the request budget in docs/DASHBOARD.md §9.4 (about 7.5 polled
 * requests a minute with every widget placed, down from about 52) can be
 * checked in one place. The resource store polls a key at the smallest
 * interval among the widgets subscribed to it, and only while the tab is
 * visible. Context-fed widgets (tasks, projects, notifications, chats) do not
 * poll at all.
 */
export const DASHBOARD_POLL_MS = {
  /** `/time/current`: clock state and hours today, shared by „Mein Status“ and „Urlaub“. */
  timeCurrent: 30_000,
  /** `/time/clock-summary`: who is clocked in. */
  clockSummary: 60_000,
  /** `/construction-reports/recent`. */
  recentReports: 60_000,
  /** Every Werkstatt read: dashboard, boxes, checkouts, recent panels. */
  werkstatt: 120_000,
  /** Pending vacation requests waiting for approval. */
  vacationPending: 120_000,
  /** Absences, own vacation requests, due inspections: changes a few times a day. */
  slow: 600_000,
} as const;
