/**
 * The start page's data cache: one request per key, however many widgets ask.
 *
 * „Start“ is the most used tab. Before this store, every card on it fetched
 * for itself on mount and polled on its own timer, so coming back to the page
 * fired a burst of requests behind skeletons and two cards showing the same
 * Werkstatt figures asked for them twice. What has to hold (docs/DASHBOARD.md
 * §9.3): one request and one poller per key at the smallest interval asked
 * for, nothing while the tab is hidden, cached data shown at once on return,
 * a 403 that stops asking, and nothing left behind when the session ends —
 * workshop tablets are shared.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";
import {
  getDashboardResourceStore,
  onDashboardResourceForbidden,
  reloadDashboardResources,
  type DashboardResourceLoader,
} from "../utils/dashboardResourceStore";
import { endDashboardSession, onDashboardSessionEnd } from "../utils/dashboardSession";

type Payload = { n: number };

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Answers { n } with n = how many times it has been called. */
function countingLoader() {
  const loader = vi.fn<DashboardResourceLoader<Payload>>();
  loader.mockImplementation(async () => ({ n: loader.mock.calls.length }));
  return loader;
}

/** A loader whose next answer the test releases by hand. */
function deferredLoader() {
  const releases: Array<{ resolve: (value: Payload) => void; reject: (error: unknown) => void }> = [];
  const loader = vi.fn<DashboardResourceLoader<Payload>>(
    () => new Promise<Payload>((resolve, reject) => releases.push({ resolve, reject })),
  );
  return { loader, releases };
}

async function settle() {
  // Lets resolved loaders and the single-flight bookkeeping run.
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  endDashboardSession();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("one request and one poller per key", () => {
  it("two subscribers on one key cause one fetch, and both hear the answer", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();
    const first = vi.fn();
    const second = vi.fn();

    store.subscribe("werkstatt:dashboard", loader, 120_000, first);
    store.subscribe("werkstatt:dashboard", loader, 120_000, second);
    await settle();

    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot<Payload>("werkstatt:dashboard").data).toEqual({ n: 1 });
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it("keeps the loader of the first registration", async () => {
    const store = getDashboardResourceStore(1);
    const firstLoader = countingLoader();
    const secondLoader = countingLoader();

    store.subscribe("time:current", firstLoader, 30_000, vi.fn());
    store.subscribe("time:current", secondLoader, 30_000, vi.fn());
    await settle();
    store.reload("time:current");
    await settle();

    expect(firstLoader).toHaveBeenCalledTimes(2);
    expect(secondLoader).not.toHaveBeenCalled();
  });

  it("polls at the smallest interval among the current subscribers", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    store.subscribe("time:current", loader, 60_000, vi.fn());
    const unsubscribeFast = store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(loader).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loader).toHaveBeenCalledTimes(3);

    // The fast subscriber leaves: back to one request a minute, and the data
    // just fetched is fresh enough that the switch itself asks nothing.
    unsubscribeFast();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loader).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(loader).toHaveBeenCalledTimes(4);
  });

  it("asks nothing while the document is hidden, and fetches at once when it shows", async () => {
    visibility = "hidden";
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    store.subscribe("werkstatt:dashboard", loader, 120_000, vi.fn());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(loader).not.toHaveBeenCalled();

    setVisibility("visible");
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("requests with the latest token set", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    store.setToken("first-token");
    store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();
    store.setToken("second-token");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(loader.mock.calls.map(([token]) => token)).toEqual(["first-token", "second-token"]);
    expect(loader.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });

  it("fetches a key without a poll interval once, and never again on its own", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    store.subscribe("reports:recent", loader, null, vi.fn());
    await settle();
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("what a widget sees before and after a failure", () => {
  it("reads as loading, never as data, until the first answer arrives", async () => {
    const store = getDashboardResourceStore(1);
    const { loader, releases } = deferredLoader();

    store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();
    expect(store.getSnapshot("time:current")).toMatchObject({ data: null, loading: true, error: null, stale: false });

    releases[0].resolve({ n: 7 });
    await settle();
    expect(store.getSnapshot("time:current")).toMatchObject({ data: { n: 7 }, loading: false, error: null });
    expect(store.getSnapshot("time:current").loadedAt).toBe(Date.now());
  });

  it("leaves data null and sets the error when the first load fails", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();
    loader.mockRejectedValueOnce(new ApiError("Internal Server Error", 500));

    store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();

    const snapshot = store.getSnapshot("time:current");
    expect(snapshot.data).toBeNull();
    expect(snapshot.error).toBeTruthy();
    expect(snapshot).toMatchObject({ loading: false, stale: false, forbidden: false, loadedAt: null });
  });

  it("keeps the data and marks it stale when a later refresh fails, until one succeeds", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();
    loader.mockRejectedValueOnce(new ApiError("Bad Gateway", 502));
    await vi.advanceTimersByTimeAsync(30_000);

    expect(store.getSnapshot("time:current")).toMatchObject({ data: { n: 1 }, stale: true, error: null, loading: false });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getSnapshot("time:current")).toMatchObject({ data: { n: 3 }, stale: false, error: null });
  });

  it("shows loading again, without the old error, while a retry runs", async () => {
    const store = getDashboardResourceStore(1);
    const { loader, releases } = deferredLoader();

    store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();
    releases[0].reject(new ApiError("Bad Gateway", 502));
    await settle();
    expect(store.getSnapshot("time:current").error).toBeTruthy();

    store.reload("time:current");
    await settle();
    expect(store.getSnapshot("time:current")).toMatchObject({ loading: true, error: null, data: null });
  });

  it("marks a 403 forbidden, drops the data and stops asking for that key", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    store.subscribe("time:clock-summary", loader, 60_000, vi.fn());
    await settle();
    loader.mockRejectedValueOnce(new ApiError("Forbidden", 403));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loader).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot("time:clock-summary")).toMatchObject({ forbidden: true, data: null, loading: false });

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    store.reload("time:clock-summary");
    store.subscribe("time:clock-summary", loader, 60_000, vi.fn());
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("tells that user's forbidden listeners which key answered 403, and nobody else's", async () => {
    // The start page refetches its layouts on this (§8.1), which normally
    // removes the widget whose permission was withdrawn.
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();
    loader.mockRejectedValueOnce(new ApiError("Forbidden", 403));
    const mine = vi.fn();
    const otherUsers = vi.fn();
    const stopMine = onDashboardResourceForbidden(1, mine);
    onDashboardResourceForbidden(2, otherUsers);

    store.subscribe("dashboard:absent-today", loader, 600_000, vi.fn());
    await settle();
    expect(mine).toHaveBeenCalledTimes(1);
    expect(mine).toHaveBeenCalledWith("dashboard:absent-today");
    expect(otherUsers).not.toHaveBeenCalled();

    stopMine();
    const later = countingLoader();
    later.mockRejectedValueOnce(new ApiError("Forbidden", 403));
    store.subscribe("time:clock-summary", later, 60_000, vi.fn());
    await settle();
    expect(mine).toHaveBeenCalledTimes(1);
  });

  it("does not poll other keys any less after one key was forbidden", async () => {
    const store = getDashboardResourceStore(1);
    const forbidden = countingLoader();
    forbidden.mockRejectedValue(new ApiError("Forbidden", 403));
    const allowed = countingLoader();

    store.subscribe("time:clock-summary", forbidden, 60_000, vi.fn());
    store.subscribe("reports:recent", allowed, 60_000, vi.fn());
    await vi.advanceTimersByTimeAsync(120_000);

    expect(forbidden).toHaveBeenCalledTimes(1);
    expect(allowed).toHaveBeenCalledTimes(3);
  });
});

describe("stale-while-revalidate between visits", () => {
  it("stops the poller on the last unsubscribe and keeps the data", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    const unsubscribe = store.subscribe("werkstatt:dashboard", loader, 120_000, vi.fn());
    await settle();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot("werkstatt:dashboard").data).toEqual({ n: 1 });
  });

  it("serves a re-subscribe within pollMs from the cache without a request", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    const unsubscribe = store.subscribe("werkstatt:dashboard", loader, 120_000, vi.fn());
    await settle();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(60_000);

    store.subscribe("werkstatt:dashboard", loader, 120_000, vi.fn());
    expect(store.getSnapshot("werkstatt:dashboard").data).toEqual({ n: 1 });
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("revalidates a re-subscribe once the data is older than its pollMs", async () => {
    const store = getDashboardResourceStore(1);
    const loader = countingLoader();

    const unsubscribe = store.subscribe("werkstatt:dashboard", loader, 120_000, vi.fn());
    await settle();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(121_000);

    store.subscribe("werkstatt:dashboard", loader, 120_000, vi.fn());
    expect(store.getSnapshot("werkstatt:dashboard").data).toEqual({ n: 1 });
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot("werkstatt:dashboard").data).toEqual({ n: 2 });
  });

  it("still fills the cache with an answer that lands after the last unsubscribe", async () => {
    const store = getDashboardResourceStore(1);
    const { loader, releases } = deferredLoader();

    const unsubscribe = store.subscribe("werkstatt:dashboard", loader, 120_000, vi.fn());
    await settle();
    unsubscribe();
    releases[0].resolve({ n: 4 });
    await settle();

    expect(store.getSnapshot("werkstatt:dashboard").data).toEqual({ n: 4 });
  });

  it("does not notify a listener that has unsubscribed", async () => {
    const store = getDashboardResourceStore(1);
    const { loader, releases } = deferredLoader();
    const listener = vi.fn();

    const unsubscribe = store.subscribe("werkstatt:dashboard", loader, 120_000, listener);
    await settle();
    listener.mockClear();
    unsubscribe();
    releases[0].resolve({ n: 1 });
    await settle();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("asking again", () => {
  it("reload settles once the newer answer is in the snapshot", async () => {
    const store = getDashboardResourceStore(1);
    const { loader, releases } = deferredLoader();
    store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();
    releases[0].resolve({ n: 1 });
    await settle();

    let settled = false;
    void store.reload("time:current").then(() => {
      settled = true;
    });
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);

    releases[1].resolve({ n: 2 });
    await settle();
    expect(settled).toBe(true);
    expect(store.getSnapshot("time:current").data).toEqual({ n: 2 });
  });

  it("reload settles without rejecting when the answer fails", async () => {
    const store = getDashboardResourceStore(1);
    const { loader, releases } = deferredLoader();
    store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();
    releases[0].resolve({ n: 1 });
    await settle();

    const reloaded = store.reload("time:current");
    await settle();
    releases[1].reject(new Error("offline"));
    await expect(reloaded).resolves.toBeUndefined();
    expect(store.getSnapshot("time:current").stale).toBe(true);
  });

  it("reloadDashboardResources refetches the matching cached keys, with nobody subscribed", async () => {
    const store = getDashboardResourceStore(1);
    const time = countingLoader();
    const werkstatt = countingLoader();
    store.subscribe("time:current", time, 30_000, vi.fn())();
    store.subscribe("werkstatt:dashboard", werkstatt, 120_000, vi.fn())();
    await settle();

    // A clock-in on the Zeit page, while „Start“ is not on screen.
    reloadDashboardResources(1, (key) => key.startsWith("time:"));
    await settle();

    expect(time).toHaveBeenCalledTimes(2);
    expect(werkstatt).toHaveBeenCalledTimes(1);
    // Back on „Start“ within the poll interval: the newer answer, no request.
    store.subscribe("time:current", time, 30_000, vi.fn());
    expect(store.getSnapshot("time:current").data).toEqual({ n: 2 });
    await settle();
    expect(time).toHaveBeenCalledTimes(2);
  });

  it("reloadDashboardResources leaves other users and forbidden keys alone", async () => {
    const mine = getDashboardResourceStore(1);
    const theirs = getDashboardResourceStore(2);
    const loader = countingLoader();
    const forbidden = vi.fn<DashboardResourceLoader<Payload>>(async () => {
      throw new ApiError("Forbidden", 403, "Forbidden");
    });
    mine.subscribe("time:current", loader, 30_000, vi.fn());
    theirs.subscribe("time:current", loader, 30_000, vi.fn());
    mine.subscribe("time:clock-summary", forbidden, 60_000, vi.fn());
    await settle();

    reloadDashboardResources(1, (key) => key.startsWith("time:"));
    reloadDashboardResources(3, () => true);
    await settle();

    expect(loader).toHaveBeenCalledTimes(3);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });
});

describe("session end and users", () => {
  it("keeps one user's data away from another's", async () => {
    const mine = getDashboardResourceStore(1);
    const theirs = getDashboardResourceStore(2);
    const loader = countingLoader();

    mine.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();

    expect(getDashboardResourceStore(1)).toBe(mine);
    expect(mine.getSnapshot("time:current").data).toEqual({ n: 1 });
    expect(theirs.getSnapshot("time:current").data).toBeNull();
  });

  it("endDashboardSession() empties every store, stops every poller and tells the subscribers", async () => {
    const first = getDashboardResourceStore(1);
    const second = getDashboardResourceStore(2);
    const loader = countingLoader();
    const listener = vi.fn();

    first.subscribe("time:current", loader, 30_000, listener);
    second.subscribe("werkstatt:dashboard", loader, 120_000, vi.fn());
    await settle();
    expect(loader).toHaveBeenCalledTimes(2);
    listener.mockClear();

    endDashboardSession();

    expect(listener).toHaveBeenCalled();
    expect(getDashboardResourceStore(1).getSnapshot("time:current").data).toBeNull();
    expect(getDashboardResourceStore(2).getSnapshot("werkstatt:dashboard").data).toBeNull();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("aborts a request in flight and drops its answer when the session ends", async () => {
    const store = getDashboardResourceStore(1);
    const { loader, releases } = deferredLoader();

    store.subscribe("time:current", loader, 30_000, vi.fn());
    await settle();
    const signal = loader.mock.calls[0][1];

    endDashboardSession();
    releases[0].resolve({ n: 9 });
    await settle();

    expect(signal.aborted).toBe(true);
    expect(getDashboardResourceStore(1).getSnapshot("time:current").data).toBeNull();
  });

  it("ignores a subscribe on a store from before the session ended", async () => {
    const stale = getDashboardResourceStore(1);
    endDashboardSession();
    const loader = countingLoader();

    const unsubscribe = stale.subscribe("time:current", loader, 30_000, vi.fn());
    await vi.advanceTimersByTimeAsync(60_000);
    unsubscribe();

    expect(loader).not.toHaveBeenCalled();
  });

  it("runs every other cleanup when one of them throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let thrown = false;
    const later = vi.fn();
    onDashboardSessionEnd(() => {
      if (thrown) return;
      thrown = true;
      throw new Error("cleanup failed");
    });
    onDashboardSessionEnd(later);

    endDashboardSession();

    expect(later).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});
