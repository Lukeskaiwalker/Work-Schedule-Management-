/**
 * Fetch every page of an offset-paged list endpoint, or fail.
 *
 * Written for GET /customers, whose 200-row default silently hid the
 * alphabetically last customers from every picker once there were more than
 * 200 of them. The rules that make a "complete" list trustworthy live here:
 *
 *   - **Complete or nothing.** A failing page rejects the whole call. A list
 *     that stops early looks exactly like a list that is complete, so a caller
 *     is never handed one.
 *   - **A ceiling throws.** `maxPages` stops a runaway loop, and reaching it is
 *     an error, not a truncation.
 *   - **Each row once.** Offset paging over a list that changes between two
 *     requests can hand the same row back on two pages (a row inserted before
 *     it pushes it across the boundary); the first copy is kept.
 *   - **A full page with nothing new means the server is not paging** (e.g. it
 *     ignores `offset`). Asking again would only repeat it, so it throws.
 *
 * The loop ends at the first page shorter than `pageSize`.
 */
export interface FetchAllPagesOptions {
  /** Rows asked for per request — the endpoint's maximum, so the usual list is one request. */
  pageSize: number;
  /** Requests allowed before giving up with an error. */
  maxPages: number;
}

export async function fetchAllPages<T extends { id: number }>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  { pageSize, maxPages }: FetchAllPagesOptions,
): Promise<T[]> {
  let collected: T[] = [];
  const seen = new Set<number>();
  for (let page = 0; page < maxPages; page += 1) {
    const rows = await fetchPage(page * pageSize, pageSize);
    const fresh = rows.filter((row) => !seen.has(row.id));
    fresh.forEach((row) => seen.add(row.id));
    collected = [...collected, ...fresh];
    if (rows.length < pageSize) return collected;
    if (fresh.length === 0) {
      throw new Error("Die Liste wurde nicht vollständig geladen: der Server liefert dieselbe Seite erneut.");
    }
  }
  throw new Error(
    `Die Liste wurde nicht vollständig geladen: mehr als ${maxPages * pageSize} Einträge.`,
  );
}
