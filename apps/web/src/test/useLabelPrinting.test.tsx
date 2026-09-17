/**
 * The label sheet's state hook. SchaltplanPage memoises `openPanel` on the
 * hook's `reset` — the hook's return object is a fresh literal every render
 * and must never be a dependency itself — so `reset` and its siblings have
 * to keep their identity across renders and state changes. Without this
 * pin, a later `useEffect(..., [openPanel])` would refetch the panel on
 * every render and nobody would notice until the board flickered.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLabelPrinting } from "../components/schaltplan/useLabelPrinting";

function renderPrinting() {
  const deps = { panel: null, token: "t", setNotice: vi.fn(), setError: vi.fn() };
  return renderHook(() => useLabelPrinting(deps));
}

describe("useLabelPrinting", () => {
  it("keeps open, close and reset referentially stable across renders and state changes", () => {
    const { result, rerender } = renderPrinting();
    const first = result.current;
    rerender();
    // The object is new every render — which is exactly why a caller must
    // destructure the callbacks instead of depending on the object.
    expect(result.current).not.toBe(first);
    expect(result.current.reset).toBe(first.reset);
    expect(result.current.open).toBe(first.open);
    expect(result.current.close).toBe(first.close);

    act(() => first.open(["r1"], "reihenklemmen"));
    expect(result.current.dialog).toEqual({ open: true, ids: ["r1"], mode: "reihenklemmen" });
    expect(result.current.reset).toBe(first.reset);
    expect(result.current.open).toBe(first.open);
    expect(result.current.close).toBe(first.close);
  });

  it("close only hides the sheet; reset forgets the selection and the mode", () => {
    const { result } = renderPrinting();
    act(() => result.current.open(["f1"], "reihenklemmen"));
    act(() => result.current.close());
    expect(result.current.dialog).toEqual({ open: false, ids: ["f1"], mode: "reihenklemmen" });
    act(() => result.current.reset());
    expect(result.current.dialog).toEqual({ open: false, ids: [], mode: "bmk" });
  });
});
