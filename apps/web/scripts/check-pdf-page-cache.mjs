/**
 * Behaviour of the rendered-page cache behind the in-app PDF viewer.
 *
 *     npm run check --prefix apps/web
 *
 * Imports the real module (node strips the types), so these exercise shipping
 * code rather than a restatement of it. What is checked is what goes wrong
 * quietly: a page served from a cleared cache, a URL revoked while still on
 * screen, or an eviction that drops the page the reader is looking at.
 */
import { createPageCache } from "../src/utils/pdfPageCache.ts";

let fail = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

/** A cache whose fetches resolve when the test says so, so races are decidable. */
function harness({ maxEntries = 3 } = {}) {
  const fetched = [];
  const revoked = [];
  const gates = new Map();
  const cache = createPageCache({
    maxEntries,
    revoke: (url) => revoked.push(url),
    fetchPage: (page) => {
      fetched.push(page);
      return new Promise((resolve, reject) => gates.set(page, { resolve, reject }));
    },
  });
  return {
    cache, fetched, revoked,
    settle: (page) => { gates.get(page).resolve(`url:${page}`); return gates.get(page).promise; },
    reject: (page, err) => gates.get(page).reject(err ?? new Error("boom")),
    // Let queued microtasks (the .then chains inside the cache) run.
    tick: () => new Promise((r) => setTimeout(r, 0)),
  };
}

console.log("page cache:");

// 1. a resident page costs no request
{
  const h = harness();
  const p = h.cache.acquire(1); h.settle(1); await p; await h.tick();
  await h.cache.acquire(1);
  check("second read of a resident page issues no request", h.fetched, [1]);
}

// 2. a prefetch and a tap for the same page collapse into one request
{
  const h = harness();
  const a = h.cache.acquire(5), b = h.cache.acquire(5);
  h.settle(5);
  check("concurrent readers share one request", h.fetched, [5]);
  check("both readers get the same URL", [await a, await b], ["url:5", "url:5"]);
}

// 3. the least recently used page is the one evicted, and it is freed
{
  const h = harness({ maxEntries: 2 });
  for (const n of [1, 2]) { const p = h.cache.acquire(n); h.settle(n); await p; }
  await h.tick();
  const p3 = h.cache.acquire(3); h.settle(3); await p3; await h.tick();
  check("cache stays at its ceiling", h.cache.size(), 2);
  check("evicted the least recently used", h.cache.peek(1), undefined);
  check("freed exactly the evicted URL", h.revoked, ["url:1"]);
  check("kept the newer pages", [h.cache.peek(2), h.cache.peek(3)], ["url:2", "url:3"]);
}

// 4. reading a page makes it recent again — paging back must not cost a render
{
  const h = harness({ maxEntries: 2 });
  for (const n of [1, 2]) { const p = h.cache.acquire(n); h.settle(n); await p; }
  await h.tick();
  await h.cache.acquire(1);                       // page 1 read again -> newest
  const p3 = h.cache.acquire(3); h.settle(3); await p3; await h.tick();
  check("a re-read page survives the next eviction", h.cache.peek(1), "url:1");
  check("the untouched page is the one dropped", h.cache.peek(2), undefined);
}

// 5. clearing frees every resident page
{
  const h = harness();
  for (const n of [1, 2]) { const p = h.cache.acquire(n); h.settle(n); await p; }
  await h.tick();
  h.cache.clear();
  check("clear empties the cache", h.cache.size(), 0);
  check("clear frees both URLs", h.revoked.sort(), ["url:1", "url:2"]);
}

// 6. THE ONE THAT MATTERS: a request in flight when the viewer closes must not
//    land in the cache the next document reads from.
{
  const h = harness();
  const inflight = h.cache.acquire(3).catch(() => "rejected");
  h.cache.clear();                                 // viewer closed mid-load
  h.settle(3);                                     // the old request arrives late
  check("late arrival is rejected, not served", await inflight, "rejected");
  await h.tick();
  check("late arrival is not stored", h.cache.peek(3), undefined);
  check("late arrival is freed rather than leaked", h.revoked, ["url:3"]);
}

// 7. the page just stored is never the one evicted, even at a ceiling of 1
{
  const h = harness({ maxEntries: 1 });
  const p1 = h.cache.acquire(1); h.settle(1); await p1; await h.tick();
  const p2 = h.cache.acquire(2); h.settle(2);
  check("the page being displayed survives its own insertion", await p2, "url:2");
  await h.tick();
  check("and it is the one retained", h.cache.peek(2), "url:2");
}

// 8. a failed fetch leaves no ghost, so retrying actually retries
{
  const h = harness();
  const first = h.cache.acquire(9).catch(() => "failed");
  h.reject(9);
  check("failure surfaces to the caller", await first, "failed");
  await h.tick();
  h.cache.acquire(9);
  check("a retry issues a new request", h.fetched, [9, 9]);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
