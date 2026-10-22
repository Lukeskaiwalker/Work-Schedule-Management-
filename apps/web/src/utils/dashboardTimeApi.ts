// The time calls of the start page's „Mein Status“ and „Urlaub“ widgets.
//
// Backend: apps/api/app/routers/time_tracking.py, the routes the Zeit page
// uses. Every function throws ApiError on a non-2xx answer.
//
// The loaders here are module-level on purpose: the resource store keeps the
// first loader registered for a key, and both widgets read `time:current`
// (docs/DASHBOARD.md §9.3) — so with both on the page there is one request
// and one poller, at the shorter interval.

import { apiFetch } from "../api/client";
import type { TimeCurrent, VacationRequest } from "../types";
import { reloadDashboardResources } from "./dashboardResourceStore";

/** Clock state, hours today and the vacation balance, fresh from the server. */
export const TIME_CURRENT_KEY = "time:current";
/** The signed-in user's own vacation requests (the store is per user). */
export const OWN_VACATION_REQUESTS_KEY = "time:vacation-requests:own";

/** Every start-page key read from the time routes starts so (also the office widgets' pending requests and clock summary). */
const TIME_KEY_PREFIX = "time:";

/**
 * For App after the Zeit page changed the time state (a clock action, an
 * entry, a vacation request or review): the start page asks again for its
 * cached time keys, so „Mein Status“, „Urlaub“ and the office time widgets
 * show the change when the user comes back to „Start“, instead of the copy
 * from before it (dashboardResourceStore.ts, reloadDashboardResources).
 */
export function refreshDashboardTimeResources(userId: number): void {
  reloadDashboardResources(userId, (key) => key.startsWith(TIME_KEY_PREFIX));
}

export function loadTimeCurrent(token: string | null, signal?: AbortSignal): Promise<TimeCurrent> {
  return apiFetch<TimeCurrent>("/time/current", token, { signal });
}

async function post(path: string, token: string | null): Promise<void> {
  // The answer is an entry the widget does not show: it reloads
  // `time:current`, which is what every other surface reads.
  await apiFetch<unknown>(path, token, { method: "POST" });
}

export function clockIn(token: string | null): Promise<void> {
  return post("/time/clock-in", token);
}

export function clockOut(token: string | null): Promise<void> {
  return post("/time/clock-out", token);
}

export function startBreak(token: string | null): Promise<void> {
  return post("/time/break-start", token);
}

export function endBreak(token: string | null): Promise<void> {
  return post("/time/break-end", token);
}

/**
 * The user's own requests, newest first. `user_id` is not optional here: for
 * a `time:view_all` user the bare list is everybody's requests.
 */
export async function loadOwnVacationRequests(
  token: string | null,
  userId: number,
  signal?: AbortSignal,
): Promise<VacationRequest[]> {
  const rows = await apiFetch<unknown>(
    `/time/vacation-requests?user_id=${encodeURIComponent(String(userId))}`,
    token,
    { signal },
  );
  return Array.isArray(rows) ? (rows as VacationRequest[]) : [];
}
