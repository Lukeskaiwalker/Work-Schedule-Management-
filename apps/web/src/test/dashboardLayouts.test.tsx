/**
 * The layouts behind the start page (docs/DASHBOARD.md §9.1 step 2).
 *
 * One last-known value per user, kept between visits so „Start“ renders at
 * once, seeded on a cold start from localStorage and revalidated on every
 * mount. Three ways that could go wrong are pinned here: a slow GET landing
 * after a save and putting the old layout back, a shared device showing the
 * previous user's layout after sign-out, and a damaged stored copy taking the
 * page down.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useDashboardLayouts } from "../hooks/useDashboardLayouts";
import { endDashboardSession } from "../utils/dashboardSession";
import type { DashboardDevice, DashboardLayout, DashboardState, DashboardWidgetItem } from "../types/dashboard";
import { DASHBOARD_WIDGET_IDS } from "../types/dashboard";

function layoutOf(device: DashboardDevice, widgets: DashboardWidgetItem[], extra: Partial<DashboardLayout> = {}): DashboardLayout {
  return { device, version: 1, source: "builtin", updated_at: null, role_changed: false, widgets, ...extra };
}

function dashboard(desktop: DashboardWidgetItem[] = [{ id: "my_tasks", size: "large" }]): DashboardState {
  return {
    layouts: {
      mobile: layoutOf("mobile", [{ id: "my_status", size: "medium" }]),
      tablet: layoutOf("tablet", [{ id: "my_status", size: "medium" }]),
      desktop: layoutOf("desktop", desktop),
    },
    available_widgets: ["my_status", "my_tasks"],
    default_sizes: Object.fromEntries(DASHBOARD_WIDGET_IDS.map((id) => [id, "medium"])) as DashboardState["default_sizes"],
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Pending = { resolve: (response: Response) => void };

/** Every request waits until the test answers it. */
function holdRequests() {
  const pending: (Pending & { method: string; url: string; body: unknown })[] = [];
  const fetchMock = vi.fn(
    (url: string, init: RequestInit = {}) =>
      new Promise<Response>((resolve) => {
        pending.push({
          method: init.method ?? "GET",
          url,
          body: typeof init.body === "string" ? JSON.parse(init.body) : null,
          resolve,
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { pending, fetchMock };
}

afterEach(() => {
  endDashboardSession();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useDashboardLayouts", () => {
  it("asks for nothing without a token or a user", () => {
    const { fetchMock } = holdRequests();
    const noToken = renderHook(() => useDashboardLayouts(null, 1));
    const noUser = renderHook(() => useDashboardLayouts("token", null));
    for (const { result } of [noToken, noUser]) {
      expect(result.current.state).toBeNull();
      expect(result.current.loading).toBe(false);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads, then a save replaces only that device and is stored for the next cold start", async () => {
    const { pending } = holdRequests();
    const { result } = renderHook(() => useDashboardLayouts("token", 1));
    expect(result.current.loading).toBe(true);
    await act(async () => pending.shift()?.resolve(json(dashboard())));
    expect(result.current.loading).toBe(false);
    expect(result.current.state?.layouts.desktop.widgets).toEqual([{ id: "my_tasks", size: "large" }]);

    let saving: Promise<void> = Promise.resolve();
    act(() => {
      saving = result.current.save("desktop", [{ id: "my_status", size: "small" }]);
    });
    const put = pending.shift();
    expect(put).toMatchObject({ method: "PUT", url: "/api/dashboard/layouts/desktop" });
    await act(async () => {
      put?.resolve(json(layoutOf("desktop", [{ id: "my_status", size: "small" }], { source: "user" })));
      await saving;
    });

    expect(result.current.state?.layouts.desktop).toMatchObject({ source: "user", widgets: [{ id: "my_status", size: "small" }] });
    expect(result.current.state?.layouts.mobile.widgets).toEqual([{ id: "my_status", size: "medium" }]);
    const stored = JSON.parse(localStorage.getItem("smpl_dashboard_layouts:1") ?? "null");
    expect(stored.layouts.desktop).toEqual([{ id: "my_status", size: "small" }]);
  });

  it("a save that fails throws and leaves the state alone", async () => {
    const { pending } = holdRequests();
    const { result } = renderHook(() => useDashboardLayouts("token", 1));
    await act(async () => pending.shift()?.resolve(json(dashboard())));

    let failure: unknown = null;
    await act(async () => {
      const saving = result.current.save("desktop", []).catch((error: unknown) => {
        failure = error;
      });
      pending.shift()?.resolve(json({ detail: "boom" }, 500));
      await saving;
    });
    expect(failure).toBeInstanceOf(Error);
    expect(result.current.state?.layouts.desktop.widgets).toEqual([{ id: "my_tasks", size: "large" }]);
  });

  it("a GET still on its way when a save lands does not put the old layout back", async () => {
    const { pending } = holdRequests();
    const { result } = renderHook(() => useDashboardLayouts("token", 1));
    await act(async () => pending.shift()?.resolve(json(dashboard())));

    // A second visit revalidates in the background …
    const second = renderHook(() => useDashboardLayouts("token", 1));
    const staleGet = pending.shift();
    expect(staleGet?.method).toBe("GET");

    // … while the user saves.
    await act(async () => {
      const saving = result.current.save("desktop", [{ id: "my_status", size: "small" }]);
      pending.shift()?.resolve(json(layoutOf("desktop", [{ id: "my_status", size: "small" }], { source: "user" })));
      await saving;
    });
    await act(async () => staleGet?.resolve(json(dashboard())));

    expect(second.result.current.state?.layouts.desktop.widgets).toEqual([{ id: "my_status", size: "small" }]);
  });

  it("reset puts the resolved layout in place", async () => {
    const { pending } = holdRequests();
    const { result } = renderHook(() => useDashboardLayouts("token", 1));
    await act(async () => pending.shift()?.resolve(json(dashboard())));
    await act(async () => {
      const resetting = result.current.reset("desktop");
      const call = pending.shift();
      expect(call).toMatchObject({ method: "DELETE", url: "/api/dashboard/layouts/desktop" });
      call?.resolve(json(layoutOf("desktop", [{ id: "my_status", size: "large" }], { source: "role" })));
      await resetting;
    });
    expect(result.current.state?.layouts.desktop).toMatchObject({ source: "role", widgets: [{ id: "my_status", size: "large" }] });
  });

  it("forgets the in-memory layouts when the session ends", async () => {
    const { pending } = holdRequests();
    const first = renderHook(() => useDashboardLayouts("token", 1));
    await act(async () => pending.shift()?.resolve(json(dashboard())));
    first.unmount();
    endDashboardSession();
    // The stored copy (ids and sizes only) may stay; it is not what is tested here.
    localStorage.clear();

    const next = renderHook(() => useDashboardLayouts("token", 1));
    expect(next.result.current.state).toBeNull();
    expect(next.result.current.loading).toBe(true);
  });

  it("drops an answer that arrives after the session ended", async () => {
    const { pending } = holdRequests();
    const { result } = renderHook(() => useDashboardLayouts("token", 1));
    const late = pending.shift();
    act(() => endDashboardSession());
    await act(async () => late?.resolve(json(dashboard())));

    expect(result.current.state).toBeNull();
    expect(result.current.confirmed).toBe(false);
    expect(localStorage.getItem("smpl_dashboard_layouts:1")).toBeNull();
  });

  it("ignores a damaged stored copy and drops unknown or malformed items from a usable one", async () => {
    holdRequests();
    localStorage.setItem("smpl_dashboard_layouts:1", "{not json");
    const broken = renderHook(() => useDashboardLayouts("token", 1));
    expect(broken.result.current.state).toBeNull();
    broken.unmount();
    endDashboardSession();

    localStorage.setItem(
      "smpl_dashboard_layouts:2",
      JSON.stringify({
        version: 1,
        layouts: {
          mobile: [{ id: "weather", size: "small" }, { id: "my_status", size: "huge" }, { id: "my_tasks", size: "small" }],
          tablet: [],
          desktop: [
            { id: "shortcuts", size: "large", settings: { views: ["time", "materials", "wiki"] } },
            { id: "shortcuts", size: "small" },
          ],
        },
      }),
    );
    const seeded = renderHook(() => useDashboardLayouts("token", 2));
    const state = seeded.result.current.state;
    expect(state?.layouts.mobile.widgets).toEqual([{ id: "my_tasks", size: "small" }]);
    expect(state?.layouts.desktop.widgets).toEqual([{ id: "shortcuts", size: "large", settings: { views: ["time", "wiki"] } }]);
    // Shown, but not to be edited from: it knows no source and no permissions.
    expect(seeded.result.current.loading).toBe(true);
    expect(seeded.result.current.confirmed).toBe(false);
  });
});
