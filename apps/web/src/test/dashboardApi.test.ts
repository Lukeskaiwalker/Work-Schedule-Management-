/**
 * Every /api/dashboard* call the web makes, pinned to method, path and body.
 *
 * The server's routes are in apps/api/app/routers/dashboard.py (docs/
 * DASHBOARD.md §4). Two things here are easy to get quietly wrong: a role or
 * device spliced into a path unescaped, and a `settings: null` travelling
 * either way — the server stores none, and `sameLayout` must never see a
 * difference between "no settings" and null.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";
import {
  dashboardErrorDetail,
  fetchAbsentToday,
  fetchDashboard,
  fetchDashboardRoleDefaults,
  resetDashboardLayout,
  resetDashboardRoleDefault,
  saveDashboardLayout,
  saveDashboardRoleDefault,
} from "../utils/dashboardApi";

type Call = { url: string; method: string; body: unknown; auth: string | null };

function serve(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      auth: headers.Authorization ?? null,
    });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function layout(device: string, widgets: unknown[], extra: Record<string, unknown> = {}) {
  return { device, version: 1, source: "builtin", updated_at: null, role_changed: false, widgets, ...extra };
}

const SHORTCUTS_WITH_NULL = [
  { id: "shortcuts", size: "large", settings: { views: ["my_tasks", "planning"] } },
  { id: "my_status", size: "medium", settings: null },
];

afterEach(() => vi.unstubAllGlobals());

describe("the user's own layouts", () => {
  it("GET /api/dashboard, with the token, and drops null settings from every layout", async () => {
    const calls = serve({
      layouts: {
        mobile: layout("mobile", SHORTCUTS_WITH_NULL),
        tablet: layout("tablet", [], { source: "user", updated_at: "2026-10-21T18:40:12Z" }),
        desktop: layout("desktop", [{ id: "my_tasks", size: "large", settings: null }], { source: "role", role_changed: true }),
      },
      available_widgets: ["shortcuts", "my_status", "my_tasks"],
      default_sizes: { shortcuts: "large", my_status: "medium", my_tasks: "medium" },
    });

    const state = await fetchDashboard("token-1");

    expect(calls).toEqual([{ url: "/api/dashboard", method: "GET", body: null, auth: "Bearer token-1" }]);
    expect(state.layouts.mobile.widgets).toEqual([
      { id: "shortcuts", size: "large", settings: { views: ["my_tasks", "planning"] } },
      { id: "my_status", size: "medium" },
    ]);
    expect("settings" in state.layouts.mobile.widgets[1]).toBe(false);
    expect(state.layouts.desktop.widgets).toEqual([{ id: "my_tasks", size: "large" }]);
    expect(state.layouts.desktop.role_changed).toBe(true);
    expect(state.layouts.tablet).toMatchObject({ source: "user", updated_at: "2026-10-21T18:40:12Z", widgets: [] });
    expect(state.available_widgets).toEqual(["shortcuts", "my_status", "my_tasks"]);
    expect(state.default_sizes.my_status).toBe("medium");
  });

  it("rejects an answer that lacks a device's layout instead of inventing one", async () => {
    serve({ layouts: { mobile: layout("mobile", []) }, available_widgets: [], default_sizes: {} });

    await expect(fetchDashboard("t")).rejects.toThrow();
  });

  it("PUT /api/dashboard/layouts/{device} with the layout, and never sends settings: null", async () => {
    const calls = serve(layout("desktop", SHORTCUTS_WITH_NULL, { source: "user" }));

    const saved = await saveDashboardLayout("t", "desktop", {
      version: 1,
      widgets: SHORTCUTS_WITH_NULL as never,
    });

    expect(calls[0].url).toBe("/api/dashboard/layouts/desktop");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].body).toEqual({
      version: 1,
      widgets: [
        { id: "shortcuts", size: "large", settings: { views: ["my_tasks", "planning"] } },
        { id: "my_status", size: "medium" },
      ],
    });
    expect(saved.widgets[1]).toEqual({ id: "my_status", size: "medium" });
  });

  it("DELETE /api/dashboard/layouts/{device} and hands back the resolved layout", async () => {
    const calls = serve(layout("tablet", [{ id: "my_tasks", size: "medium" }], { source: "role" }));

    const resolved = await resetDashboardLayout("t", "tablet");

    expect(calls[0]).toMatchObject({ url: "/api/dashboard/layouts/tablet", method: "DELETE" });
    expect(resolved).toMatchObject({ device: "tablet", source: "role", widgets: [{ id: "my_tasks", size: "medium" }] });
  });

  it("escapes the device in the path", async () => {
    const calls = serve(layout("mobile", []));

    await saveDashboardLayout("t", "mo bile/x" as never, { version: 1, widgets: [] });
    await resetDashboardLayout("t", "mo bile/x" as never);

    expect(calls.map((call) => call.url)).toEqual([
      "/api/dashboard/layouts/mo%20bile%2Fx",
      "/api/dashboard/layouts/mo%20bile%2Fx",
    ]);
  });
});

describe("who is absent today", () => {
  it("GET /api/dashboard/absent-today", async () => {
    const body = {
      date: "2026-10-21",
      absences: [{ user_id: 7, user_name: "Mara Beispiel", type: "vacation", label: "Urlaub" }],
    };
    const calls = serve(body);

    const result = await fetchAbsentToday("t");

    expect(calls[0]).toMatchObject({ url: "/api/dashboard/absent-today", method: "GET" });
    expect(result).toEqual(body);
  });
});

describe("role defaults (admin)", () => {
  const roleDefault = (role: string, device: string, widgets: unknown[], extra: Record<string, unknown> = {}) => ({
    role,
    device,
    widgets,
    source: "builtin",
    hidden_for_role: [],
    updated_at: null,
    ...extra,
  });

  it("GET /api/dashboard/role-defaults and drops null settings in every default", async () => {
    const calls = serve({
      catalog: [{ id: "my_status", group: "personal", default_size: "medium", requires: [["time:clock"]] }],
      roles: ["admin", "employee"],
      defaults: [roleDefault("employee", "desktop", SHORTCUTS_WITH_NULL)],
    });

    const result = await fetchDashboardRoleDefaults("t");

    expect(calls[0]).toMatchObject({ url: "/api/dashboard/role-defaults", method: "GET" });
    expect(result.catalog[0].requires).toEqual([["time:clock"]]);
    expect(result.roles).toEqual(["admin", "employee"]);
    expect(result.defaults[0].widgets[1]).toEqual({ id: "my_status", size: "medium" });
  });

  it("PUT and DELETE /api/dashboard/role-defaults/{role}/{device}, escaping both", async () => {
    const calls = serve(roleDefault("planning", "desktop", [{ id: "clocked_in", size: "small" }], {
      source: "role",
      hidden_for_role: ["clocked_in"],
    }));

    const saved = await saveDashboardRoleDefault("t", "planning", "desktop", {
      version: 1,
      widgets: [{ id: "clocked_in", size: "small" }],
    });
    await resetDashboardRoleDefault("t", "plan ning/../admin", "desktop");

    expect(calls[0]).toEqual({
      url: "/api/dashboard/role-defaults/planning/desktop",
      method: "PUT",
      body: { version: 1, widgets: [{ id: "clocked_in", size: "small" }] },
      auth: "Bearer t",
    });
    expect(saved.hidden_for_role).toEqual(["clocked_in"]);
    expect(calls[1]).toMatchObject({
      url: "/api/dashboard/role-defaults/plan%20ning%2F..%2Fadmin/desktop",
      method: "DELETE",
    });
  });
});

describe("dashboardErrorDetail", () => {
  it("reads the server's object detail from a 422", async () => {
    serve({ detail: { code: "unknown_widget", message: "Widget „weather“ gibt es nicht.", ids: ["weather"] } }, 422);

    const failure = await saveDashboardLayout("t", "desktop", { version: 1, widgets: [] }).catch((error) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect(dashboardErrorDetail(failure)).toEqual({
      code: "unknown_widget",
      message: "Widget „weather“ gibt es nicht.",
      ids: ["weather"],
    });
  });

  it("returns null for FastAPI's list detail, other statuses and non-API errors", async () => {
    serve({ detail: [{ loc: ["path", "device"], msg: "Input should be 'mobile'", type: "literal_error" }] }, 422);
    const listFailure = await resetDashboardLayout("t", "watch" as never).catch((error) => error);

    expect(listFailure).toBeInstanceOf(ApiError);
    expect(dashboardErrorDetail(listFailure)).toBeNull();
    expect(dashboardErrorDetail(new ApiError("x", 500, { code: "unknown_widget", message: "m", ids: [] }))).toBeNull();
    expect(dashboardErrorDetail(new ApiError("x", 422, { code: "no_such_code", message: "m", ids: [] }))).toBeNull();
    expect(dashboardErrorDetail(new Error("network"))).toBeNull();
    expect(dashboardErrorDetail(null)).toBeNull();
  });

  it("keeps only string ids", () => {
    const detail = dashboardErrorDetail(
      new ApiError("x", 422, { code: "duplicate_view", message: "Kachel „wiki“ ist doppelt.", ids: ["wiki", 3, null] }),
    );

    expect(detail).toEqual({ code: "duplicate_view", message: "Kachel „wiki“ ist doppelt.", ids: ["wiki"] });
  });
});
