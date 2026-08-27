/**
 * A bounded, deduplicating cache of rendered PDF pages.
 *
 * Pulled out of the file viewer because the interesting behaviour here is not
 * React's: eviction order, collapsing a prefetch and a tap into one request,
 * and refusing to store a result that arrived after the cache was dropped.
 * Those are pure and worth testing on their own — inside a component they were
 * reachable only by rendering one.
 *
 * Entries are object URLs. The cache owns them: it revokes on eviction and on
 * clear, and callers must treat a returned URL as borrowed, never revoking it
 * themselves — a displayed page is usually also a cached one.
 */

export type PageFetcher = (page: number) => Promise<string>;

export interface PageCacheOptions {
  /** Hard ceiling on retained pages. The least recently used goes first. */
  maxEntries: number;
  fetchPage: PageFetcher;
  /** Injectable so tests can observe frees without a DOM. */
  revoke?: (url: string) => void;
}

export interface PageCache {
  /** The page, from cache if present, else fetched once however many ask. */
  acquire: (page: number) => Promise<string>;
  /** The page if it is already resident — never starts a request. */
  peek: (page: number) => string | undefined;
  /** Drop and revoke everything; in-flight results are discarded on arrival. */
  clear: () => void;
  size: () => number;
}

export function createPageCache(options: PageCacheOptions): PageCache {
  const { maxEntries, fetchPage } = options;
  const revoke = options.revoke ?? ((url: string) => URL.revokeObjectURL(url));

  /** Insertion order is recency order: re-inserting on hit is what makes it LRU. */
  const entries = new Map<number, string>();
  const inFlight = new Map<number, Promise<string>>();
  /**
   * Bumped by clear(). A request that started before the bump must not write
   * into the cache it returns to — by then it can belong to a different
   * document, and page 3 of the last PDF would be served as page 3 of this one.
   */
  let epoch = 0;

  function evictWhileOver(protect: number): void {
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      // Never evict the page just stored, even if the cap is 1 — the caller is
      // about to display it, and handing back a revoked URL shows a broken page.
      if (oldest.done || oldest.value === protect) return;
      const url = entries.get(oldest.value);
      entries.delete(oldest.value);
      if (url) revoke(url);
    }
  }

  return {
    peek: (page) => entries.get(page),

    size: () => entries.size,

    acquire(page) {
      const hit = entries.get(page);
      if (hit !== undefined) {
        entries.delete(page);
        entries.set(page, hit);
        return Promise.resolve(hit);
      }

      const pending = inFlight.get(page);
      if (pending) return pending;

      const startedAt = epoch;
      const request = fetchPage(page)
        .then((url) => {
          inFlight.delete(page);
          if (startedAt !== epoch) {
            // Stale. Own the URL exactly long enough to free it.
            revoke(url);
            throw new Error("page cache cleared while loading");
          }
          entries.set(page, url);
          evictWhileOver(page);
          return url;
        })
        .catch((err) => {
          inFlight.delete(page);
          throw err;
        });

      inFlight.set(page, request);
      return request;
    },

    clear() {
      for (const url of entries.values()) revoke(url);
      entries.clear();
      inFlight.clear();
      epoch += 1;
    },
  };
}
