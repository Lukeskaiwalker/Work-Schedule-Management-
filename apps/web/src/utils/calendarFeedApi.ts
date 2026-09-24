// API client for the per-user calendar subscription ("Kalender-Abo").
//
// One subscription link per user. The link carries a secret token
// (`smpl_cal_…`) and calendar apps fetch it without a login, so the app never
// sees the .ics itself — only the three calls that manage the link.
//
// ── Endpoint contract ────────────────────────────────────────────────────
// All paths are relative to `/api` (apiFetch prefixes it).
//
//   GET    /calendar/feed   → CalendarFeed, or HTTP 200 with body `null`
//                             when the user has no subscription
//   POST   /calendar/feed   → CalendarFeed — creates the subscription, or
//                             ROTATES it (new token; the old link stops working)
//   DELETE /calendar/feed   → 204 (idempotent)

import { apiFetch } from "../api/client";

const FEED_PATH = "/calendar/feed";

export type CalendarFeed = {
  /** The https link — what a calendar app is given "per URL". */
  url: string;
  /** The same link under the webcal scheme, which opens the calendar app directly. */
  webcal_url: string;
  created_at: string;
  /** When a calendar app last fetched the feed; null until the first fetch. */
  last_fetched_at: string | null;
  /** The User-Agent of that fetch, as sent — e.g. "iOS/26.0 (…) dataaccessd/1.0". */
  last_fetch_agent: string | null;
  fetch_count: number;
};

/**
 * "No subscription" arrives as a 200 whose body is the JSON literal `null`.
 * `apiFetch` parses that to `null` — but an empty body parses to `{}`, and a
 * test stub may answer `[]`. Anything that is not a feed is read as "none",
 * so the card never renders a link it does not have.
 */
function asFeed(value: unknown): CalendarFeed | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<CalendarFeed>;
  if (typeof candidate.url !== "string" || typeof candidate.webcal_url !== "string") return null;
  return {
    url: candidate.url,
    webcal_url: candidate.webcal_url,
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : "",
    last_fetched_at: typeof candidate.last_fetched_at === "string" ? candidate.last_fetched_at : null,
    last_fetch_agent: typeof candidate.last_fetch_agent === "string" ? candidate.last_fetch_agent : null,
    fetch_count: typeof candidate.fetch_count === "number" && Number.isFinite(candidate.fetch_count)
      ? candidate.fetch_count
      : 0,
  };
}

/** The user's subscription, or null when there is none. */
export async function getCalendarFeed(token: string | null): Promise<CalendarFeed | null> {
  const body = await apiFetch<unknown>(FEED_PATH, token);
  return asFeed(body);
}

/**
 * Creates the subscription — or rotates it when one exists. Either way the
 * answer is the link that is valid from now on.
 */
export async function createCalendarFeed(token: string | null): Promise<CalendarFeed> {
  const body = await apiFetch<unknown>(FEED_PATH, token, { method: "POST" });
  const feed = asFeed(body);
  if (!feed) {
    throw new Error("Der Server hat keinen Abo-Link zurückgegeben.");
  }
  return feed;
}

/** Removes the subscription. Idempotent on the server: a second call is still a 204. */
export async function deleteCalendarFeed(token: string | null): Promise<void> {
  await apiFetch<unknown>(FEED_PATH, token, { method: "DELETE" });
}
