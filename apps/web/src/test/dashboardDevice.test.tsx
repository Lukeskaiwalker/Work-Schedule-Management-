/**
 * Which layout a width gets (docs/DASHBOARD.md D9, §9.2).
 *
 * Two queries only — `(min-width: 1280px)` and `(min-width: 768px)` — so no
 * fractional width falls between breakpoints. The first value is synchronous
 * (the first paint already shows the right layout), and later changes wait
 * 200 ms, so a window dragged across 1280 px does not swap layouts every frame.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useDashboardDevice } from "../hooks/useDashboardDevice";
import { stubWidth } from "./matchMediaStub";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useDashboardDevice", () => {
  it("is mobile under the global jsdom stub, where every query is false", () => {
    const { result } = renderHook(() => useDashboardDevice());
    expect(result.current).toBe("mobile");
  });

  it.each([
    [390, "mobile"],
    [767, "mobile"],
    [768, "tablet"],
    [1024, "tablet"],
    [1279, "tablet"],
    [1280, "desktop"],
    [1920, "desktop"],
  ])("reads %i px as %s on the first render", (width, device) => {
    stubWidth(width);
    const { result } = renderHook(() => useDashboardDevice());
    expect(result.current).toBe(device);
  });

  it("follows a change only after 200 ms, and coalesces a drag across the breakpoint", () => {
    vi.useFakeTimers();
    const screen = stubWidth(1024);
    const { result } = renderHook(() => useDashboardDevice());
    expect(result.current).toBe("tablet");

    act(() => screen.resize(1366));
    act(() => vi.advanceTimersByTime(150));
    expect(result.current).toBe("tablet");
    act(() => screen.resize(1200));
    act(() => screen.resize(1400));
    act(() => vi.advanceTimersByTime(199));
    expect(result.current).toBe("tablet");
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe("desktop");
  });

  it("stops listening on unmount", () => {
    const screen = stubWidth(1024);
    const { unmount } = renderHook(() => useDashboardDevice());
    expect(screen.listenerCount()).toBeGreaterThan(0);
    unmount();
    expect(screen.listenerCount()).toBe(0);
  });
});
