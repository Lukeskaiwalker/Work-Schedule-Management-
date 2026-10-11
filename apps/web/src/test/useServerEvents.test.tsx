/**
 * The live-update stream must never put the session token in its URL.
 *
 * It used to open `/api/events?token=<JWT>`, and the proxy's access log kept
 * every one of those URLs — an eight-hour session for anyone who read a log
 * dump. Now a browser opens the bare path and authenticates with its session
 * cookie, and the native shell (whose cookie never travels cross-origin)
 * opens it with a single-use ticket fetched just before. What is pinned here:
 * the URLs themselves, the fallback from cookie to ticket, and that a spent
 * ticket is never what a reconnect sends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { ApiError, apiFetch } from "../api/client";
import { eventStreamUrl, useServerEvents } from "../hooks/useServerEvents";

const surface = vi.hoisted(() => ({ native: false }));
vi.mock("../native/shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../native/shell")>();
  return {
    ...actual,
    get IS_NATIVE_SHELL() {
      return surface.native;
    },
  };
});

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const fetchMock = vi.mocked(apiFetch);

const SESSION_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = FakeEventSource.CLOSED;
  });

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event("open"));
  }

  /** CONNECTING = the browser is retrying by itself; CLOSED = it gave up (an HTTP error). */
  fail(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

function latest(): FakeEventSource {
  const source = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  if (!source) throw new Error("no EventSource was opened");
  return source;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderStream(onReconnect = vi.fn()) {
  const onEvent = vi.fn();
  const view = renderHook(() => useServerEvents(SESSION_TOKEN, { onEvent, onReconnect }));
  return { ...view, onEvent, onReconnect };
}

beforeEach(() => {
  vi.useFakeTimers();
  surface.native = false;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  fetchMock.mockReset();
  let issued = 0;
  fetchMock.mockImplementation(async () => {
    issued += 1;
    return { ticket: `ticket-${issued}`, expires_in: 60 } as never;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("eventStreamUrl", () => {
  it("is the bare path without a ticket and carries only the ticket with one", () => {
    expect(eventStreamUrl(null)).toBe("/api/events");
    expect(eventStreamUrl("a+b/c")).toBe("/api/events?ticket=a%2Bb%2Fc");
  });
});

describe("useServerEvents in a browser", () => {
  it("opens the stream with no credential in the URL, on the session cookie", async () => {
    const { result } = renderStream();
    await flush();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe("/api/events");
    expect(latest().url).not.toContain(SESSION_TOKEN);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => latest().open());
    expect(result.current.status).toBe("connected");
  });

  it("leaves a dropped cookie stream to the browser's own reconnect", async () => {
    const { onReconnect } = renderStream();
    await flush();
    const source = latest();
    act(() => source.open());
    act(() => source.fail(FakeEventSource.CONNECTING));
    await flush(60_000);
    expect(source.close).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    act(() => source.open());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("falls back to a ticket when the cookie cannot open the stream", async () => {
    renderStream();
    await flush();
    act(() => latest().fail(FakeEventSource.CLOSED));
    await flush(1_000);
    expect(fetchMock).toHaveBeenCalledWith("/events/ticket", SESSION_TOKEN, { method: "POST" });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url).toBe("/api/events?ticket=ticket-1");
    expect(latest().url).not.toContain(SESSION_TOKEN);
  });

  it("reopens a stream the server closed after it had been open, on the cookie again", async () => {
    // A deploy: the API restarts and the maintenance page answers in between,
    // which an EventSource treats as fatal and never retries by itself.
    const { onReconnect } = renderStream();
    await flush();
    act(() => latest().open());
    act(() => latest().fail(FakeEventSource.CLOSED));
    await flush(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url).toBe("/api/events");
    act(() => latest().open());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});

describe("useServerEvents in the native shell", () => {
  beforeEach(() => {
    surface.native = true;
  });

  it("opens the stream with a single-use ticket, never the session token", async () => {
    renderStream();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/events/ticket", SESSION_TOKEN, { method: "POST" });
    expect(latest().url).toBe("/api/events?ticket=ticket-1");
    expect(latest().url).not.toContain(SESSION_TOKEN);
  });

  it("reconnects with a fresh ticket instead of letting the browser resend the spent one", async () => {
    const { onReconnect } = renderStream();
    await flush();
    const first = latest();
    act(() => first.open());
    act(() => first.fail(FakeEventSource.CONNECTING));
    expect(first.close).toHaveBeenCalled();
    await flush(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest()).not.toBe(first);
    expect(latest().url).toBe("/api/events?ticket=ticket-2");
    act(() => latest().open());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("backs off a stream that keeps dying right after it opens, and forgives a healthy one", async () => {
    // A stream that opens and drops at once (the API cannot reach Postgres)
    // must not turn into one ticket per second per phone.
    renderStream();
    await flush();
    act(() => latest().open());
    act(() => latest().fail(FakeEventSource.CONNECTING));
    await flush(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => latest().open());
    act(() => latest().fail(FakeEventSource.CONNECTING));
    await flush(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    await flush(1_000);
    expect(FakeEventSource.instances).toHaveLength(3);

    // Open long enough to count as healthy: the next drop starts over at 1 s.
    act(() => latest().open());
    await flush(30_000);
    act(() => latest().fail(FakeEventSource.CONNECTING));
    await flush(1_000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("stops when the ticket request says the session is over", async () => {
    // apiFetch has already reported the 401 to App, which signs out.
    fetchMock.mockRejectedValue(new ApiError("Invalid token", 401));
    renderStream();
    await flush(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("retries the ticket request when the server is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new ApiError("Network request failed", 0, null, null, "network"));
    renderStream();
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);
    await flush(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest().url).toBe("/api/events?ticket=ticket-1");
  });
});

describe("useServerEvents teardown", () => {
  it("closes the stream and cancels a pending reconnect on unmount", async () => {
    const { unmount } = renderStream();
    await flush();
    const source = latest();
    act(() => source.fail(FakeEventSource.CLOSED));
    unmount();
    await flush(60_000);
    expect(source.close).toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
