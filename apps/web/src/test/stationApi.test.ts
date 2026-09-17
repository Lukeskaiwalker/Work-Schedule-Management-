/**
 * The station client's judgement calls, pinned.
 *
 * Three of them matter to a person at the page: the freshness thresholds
 * (they must match the API's, or the pill and the server disagree about
 * "online"), the error sentences (a 409 "no address yet" from the API must
 * reach the page verbatim, not be flattened into "request failed"), and the
 * list readers (a bare list and an enveloped one both render).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";
import {
  ONLINE_WITHIN_MS,
  STALE_WITHIN_MS,
  describeStationError,
  fallbackSetupScript,
  firstSelectableStation,
  isStationApiMissing,
  isStationRetired,
  isStationUnreachable,
  listOpenInventorySessions,
  listStationSessions,
  listStations,
  stationAddress,
  stationStatus,
  type Station,
} from "../utils/stationApi";

const NOW = Date.parse("2026-09-17T12:00:00Z");

function station(overrides: Partial<Station> = {}): Station {
  return {
    id: 1,
    name: "Werkstatt Pi",
    location: null,
    status: "unknown",
    agent_version: "1.1.0",
    uptime_seconds: 60,
    host: "192.168.2.235",
    port: 8765,
    agent_url_override: null,
    last_seen_at: null,
    paired_at: null,
    paired_by_name: null,
    hardware: null,
    session_count: 0,
    pending_count: 0,
    agent_error: null,
    ...overrides,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stationStatus", () => {
  it("prefers the server's verdict over its own arithmetic", () => {
    const stale = station({ status: "stale", last_seen_at: "2026-09-17T11:59:59" });
    expect(stationStatus(stale, NOW)).toBe("stale");
  });

  it("derives online / stale / offline with the 3-minute and 15-minute thresholds", () => {
    expect(ONLINE_WITHIN_MS).toBe(3 * 60_000);
    expect(STALE_WITHIN_MS).toBe(15 * 60_000);
    const seenAgo = (ms: number) => new Date(NOW - ms).toISOString();
    expect(stationStatus(station({ last_seen_at: seenAgo(2 * 60_000) }), NOW)).toBe("online");
    expect(stationStatus(station({ last_seen_at: seenAgo(3 * 60_000) }), NOW)).toBe("online");
    expect(stationStatus(station({ last_seen_at: seenAgo(10 * 60_000) }), NOW)).toBe("stale");
    expect(stationStatus(station({ last_seen_at: seenAgo(20 * 60_000) }), NOW)).toBe("offline");
  });

  it("treats the API's naive timestamps as UTC and a missing one as unknown", () => {
    // 2 minutes before NOW, written the way the API writes it (no zone).
    expect(stationStatus(station({ last_seen_at: "2026-09-17T11:58:00" }), NOW)).toBe("online");
    expect(stationStatus(station({ last_seen_at: null }), NOW)).toBe("unknown");
    expect(stationStatus(station({ last_seen_at: "garbage" }), NOW)).toBe("unknown");
  });
});

describe("stationAddress", () => {
  it("shows host:port, lets the admin override win, and admits to having none", () => {
    expect(stationAddress(station())).toBe("192.168.2.235:8765");
    expect(stationAddress(station({ agent_url_override: "http://10.0.0.5:9000" }))).toBe("http://10.0.0.5:9000");
    expect(stationAddress(station({ host: null, port: null }))).toBeNull();
    expect(stationAddress(station({ port: null }))).toBe("192.168.2.235");
  });
});

describe("describeStationError", () => {
  it("passes the API's German sentence through for a 409 and a 502", () => {
    const noAddress = new ApiError("Conflict", 409, "Die Station hat noch keine Adresse gemeldet.");
    expect(describeStationError(noAddress, true)).toBe("Die Station hat noch keine Adresse gemeldet.");
    const agentSaid = new ApiError("Bad Gateway", 502, "printer not found on USB");
    expect(describeStationError(agentSaid, true)).toBe("printer not found on USB");
  });

  it("has a sentence for a 502 without detail, a timeout and a missing API", () => {
    expect(describeStationError(new ApiError("Bad Gateway", 502), true)).toMatch(/Läuft der Agent/);
    const timeout = new ApiError("timeout", 0);
    expect(isStationUnreachable(timeout)).toBe(true);
    expect(describeStationError(timeout, true)).toMatch(/Keine Antwort vom Server/);
    const missing = new ApiError("Not Found", 404);
    expect(isStationApiMissing(missing)).toBe(true);
    expect(describeStationError(missing, false)).toMatch(/not available/);
    expect(describeStationError(new ApiError("Forbidden", 403), true)).toMatch(/Berechtigung/);
  });

  it("shows a 404 that carries the API's own sentence instead of calling the API missing", () => {
    // The Pi's state dir was reset while the page still listed the old
    // session: the api answers a deliberate 404 in German.
    const gone = new ApiError("Not Found", 404, "Sitzung „regal“ wurde auf der Station nicht gefunden.");
    expect(isStationApiMissing(gone)).toBe(false);
    expect(describeStationError(gone, true)).toBe("Sitzung „regal“ wurde auf der Station nicht gefunden.");
    expect(describeStationError(gone, false)).toBe("Sitzung „regal“ wurde auf der Station nicht gefunden.");
    expect(describeStationError(new ApiError("Not Found", 404, "Inventur nicht gefunden"), true)).toBe(
      "Inventur nicht gefunden",
    );
    // Only FastAPI's bare default — an unrouted path — still means "no API".
    expect(isStationApiMissing(new ApiError("Not Found", 404, "Not Found"))).toBe(true);
    expect(isStationApiMissing(new ApiError("Not Found", 404, "   "))).toBe(true);
    expect(isStationApiMissing(new ApiError("Method Not Allowed", 405, "Method Not Allowed"))).toBe(true);
    expect(describeStationError(new ApiError("Not Found", 404, "Not Found"), true)).toMatch(
      /noch nicht verfügbar/,
    );
  });
});

describe("retired stations", () => {
  it("counts revoked and expired rows as retired, an uncollected token as not", () => {
    expect(isStationRetired(station(), NOW)).toBe(false);
    expect(isStationRetired(station({ revoked_at: "2026-09-10T08:00:00" }), NOW)).toBe(true);
    expect(isStationRetired(station({ expires_at: "2026-09-17T11:00:00" }), NOW)).toBe(true);
    expect(isStationRetired(station({ expires_at: "2027-09-17T11:00:00Z" }), NOW)).toBe(false);
    // Approved, token not collected yet: active=false but not retired.
    expect(isStationRetired(station({ active: false, expires_at: null, revoked_at: null }), NOW)).toBe(false);
  });

  it("never auto-selects a retired row", () => {
    const expired = station({ id: 1, expires_at: "2026-09-01T00:00:00" });
    const revoked = station({ id: 2, revoked_at: "2026-09-10T08:00:00" });
    const live = station({ id: 3 });
    expect(firstSelectableStation([expired, revoked, live], NOW)?.id).toBe(3);
    expect(firstSelectableStation([expired, revoked], NOW)).toBeNull();
    expect(firstSelectableStation([], NOW)).toBeNull();
  });
});

describe("list readers", () => {
  it("reads the bare station list the API answers with", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([station({ id: 7 })])));
    const result = await listStations("tok");
    expect(result.stations.map((s) => s.id)).toEqual([7]);
    expect(result.server_time).toBeNull();
  });

  it("asks for the retired rows only when told to", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    await listStations("tok");
    await listStations("tok", { includeInactive: true });
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls[0]).toMatch(/\/station\/stations$/);
    expect(urls[1]).toMatch(/\/station\/stations\?include_inactive=1$/);
  });

  it("keeps ok=false and the error sentence from the sessions endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ sessions: [], ok: false, error: "Die Station antwortet nicht." })),
    );
    const result = await listStationSessions("tok", 7);
    expect(result).toEqual({ sessions: [], ok: false, error: "Die Station antwortet nicht." });
  });

  it("offers only OPEN inventories as import targets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          { id: 1, name: "Inventur Q3", status: "finalized", counted_articles: 12 },
          { id: 2, name: "Nachzählung", status: "open", counted_articles: 3 },
        ]),
      ),
    );
    const rows = await listOpenInventorySessions("tok");
    expect(rows.map((r) => r.id)).toEqual([2]);
  });
});

describe("fallbackSetupScript", () => {
  it("is the documented install-pi.sh path, not the retired run.sh one", () => {
    const script = fallbackSetupScript("https://smpl.example.de/");
    expect(script).toContain("install-pi.sh --smpl-url https://smpl.example.de");
    expect(script).toContain("server.py --pair");
    expect(script).not.toContain("run.sh");
    expect(script).not.toContain("SMPL_PAIRING_CODE");
  });
});
