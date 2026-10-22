/**
 * The time calls behind „Mein Status“ and „Urlaub“.
 *
 * The one that matters most is the vacation list: for a `time:view_all` user
 * the bare `/time/vacation-requests` returns everybody's requests, so the
 * widget must name its own user (docs/DASHBOARD.md §1 notes). The clock calls
 * hit the same routes the Zeit page does.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";
import {
  clockIn,
  clockOut,
  endBreak,
  loadOwnVacationRequests,
  loadTimeCurrent,
  startBreak,
} from "../utils/dashboardTimeApi";

type Call = { url: string; method: string; auth: string | null };

let calls: Call[] = [];
let answer: () => Response = () => json({});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  answer = () => json({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), method: init?.method ?? "GET", auth: headers.get("Authorization") });
      return answer();
    }),
  );
});

describe("dashboardTimeApi", () => {
  it("reads the caller's own clock state with the token and passes the abort signal on", async () => {
    answer = () => json({ server_time: "2026-10-21T08:00:00", break_open: false, daily_net_hours: 1.5 });
    const controller = new AbortController();
    const fetchSpy = vi.mocked(fetch);

    const current = await loadTimeCurrent("token-a", controller.signal);

    expect(current.daily_net_hours).toBe(1.5);
    expect(calls).toEqual([{ url: "/api/time/current", method: "GET", auth: "Bearer token-a" }]);
    expect(fetchSpy.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it.each([
    ["clockIn", clockIn, "/api/time/clock-in"],
    ["clockOut", clockOut, "/api/time/clock-out"],
    ["startBreak", startBreak, "/api/time/break-start"],
    ["endBreak", endBreak, "/api/time/break-end"],
  ] as const)("%s posts to %s", async (_name, call, url) => {
    await call("token-a");
    expect(calls).toEqual([{ url, method: "POST", auth: "Bearer token-a" }]);
  });

  it("throws the server's refusal instead of reporting success", async () => {
    answer = () => json({ detail: "Already clocked in" }, 400);
    await expect(clockIn("token-a")).rejects.toBeInstanceOf(ApiError);
  });

  it("asks for the user's own vacation requests by id", async () => {
    answer = () => json([{ id: 1, user_id: 7, start_date: "2026-11-02", end_date: "2026-11-06", status: "approved" }]);

    const rows = await loadOwnVacationRequests("token-a", 7, new AbortController().signal);

    expect(rows).toHaveLength(1);
    expect(calls).toEqual([{ url: "/api/time/vacation-requests?user_id=7", method: "GET", auth: "Bearer token-a" }]);
  });

  it("reads anything but a list as no requests rather than crashing the widget", async () => {
    answer = () => json({ unexpected: true });
    expect(await loadOwnVacationRequests("token-a", 7, new AbortController().signal)).toEqual([]);
  });
});
