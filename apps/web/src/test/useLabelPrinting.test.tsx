/**
 * The label sheet's state hook. SchaltplanPage memoises `openPanel` on the
 * hook's `reset` — the hook's return object is a fresh literal every render
 * and must never be a dependency itself — so `reset` and its siblings have
 * to keep their identity across renders and state changes. Without this
 * pin, a later `useEffect(..., [openPanel])` would refetch the panel on
 * every render and nobody would notice until the board flickered.
 *
 * The print call itself is pinned too: the Reihenklemmen request carries
 * strip ids and no text mode (the marker texts live in the saved document),
 * and the page's autosave is settled first — a failed save aborts the print
 * instead of feeding markers the server has not seen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLabelPrinting } from "../components/schaltplan/useLabelPrinting";
import { printPanelLabels } from "../utils/schaltplanApi";
import type { PanelPlan } from "../types/schaltplan";

vi.mock("../utils/schaltplanApi", () => ({ printPanelLabels: vi.fn() }));

const printMock = vi.mocked(printPanelLabels);

function renderPrinting(overrides: Partial<Parameters<typeof useLabelPrinting>[0]> = {}) {
  const deps = { panel: null, token: "t", setNotice: vi.fn(), setError: vi.fn(), ...overrides };
  return { deps, ...renderHook(() => useLabelPrinting(deps)) };
}

const PANEL = { id: 7 } as PanelPlan;

const RESULT = {
  printed: 4,
  skipped_without_bmk: 0,
  printer: "192.168.2.158:9100",
  material: "WAGO 2009-110",
  strips: [
    { row_id: "f1:leiste", row_label: "X1 · FI F1 · Reihe 1", length_mm: 17.2, part_count: 3 },
    { row_id: "w:block", row_label: "X2 · Block F1.2 Wallbox", length_mm: 60, part_count: 5 },
  ],
  font_size_dots: 35, // what the API answers for "1.1" on 5,2 mm at 300 dpi
  overflowing: [],
};

describe("useLabelPrinting", () => {
  beforeEach(() => {
    printMock.mockReset();
  });

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

    act(() => first.open(["f1:leiste"], "reihenklemmen"));
    expect(result.current.dialog).toEqual({ open: true, ids: ["f1:leiste"], mode: "reihenklemmen" });
    expect(result.current.reset).toBe(first.reset);
    expect(result.current.open).toBe(first.open);
    expect(result.current.close).toBe(first.close);
  });

  it("close only hides the sheet; reset forgets the selection and the mode", () => {
    const { result } = renderPrinting();
    act(() => result.current.open(["f1:leiste"], "reihenklemmen"));
    act(() => result.current.close());
    expect(result.current.dialog).toEqual({ open: false, ids: ["f1:leiste"], mode: "reihenklemmen" });
    act(() => result.current.reset());
    expect(result.current.dialog).toEqual({ open: false, ids: [], mode: "bmk" });
  });

  it("prints the Reihenklemmen selection by strip id, without a text mode, and reports the pieces", async () => {
    printMock.mockResolvedValue(RESULT);
    const beforePrint = vi.fn().mockResolvedValue(true);
    const { result, deps } = renderPrinting({ panel: PANEL, beforePrint });
    act(() => result.current.open(["f1:leiste", "w:block"], "reihenklemmen"));
    await act(() => result.current.print(["f1:leiste", "w:block"], "wago-2009-110", { target: "reihenklemmen" }));
    expect(beforePrint).toHaveBeenCalledTimes(1);
    expect(printMock).toHaveBeenCalledWith("t", 7, {
      stripIds: ["f1:leiste", "w:block"],
      materialId: "wago-2009-110",
      target: "reihenklemmen",
    });
    expect(deps.setNotice).toHaveBeenCalledWith("2 Klemmen-Etiketten gedruckt (4 Klemmen) — Schrift 3,0 mm");
    expect(result.current.dialog.open).toBe(false);
    expect(result.current.printing).toBe(false);
  });

  it("prints the BMK selection by rail id", async () => {
    printMock.mockResolvedValue({ ...RESULT, printed: 3, strips: [RESULT.strips[0]], font_size_dots: 91 }); // F1.1 on 17,5 mm at 300 dpi
    const { result, deps } = renderPrinting({ panel: PANEL });
    await act(() => result.current.print(["r1"], "wago-2009-110", { target: "bmk" }));
    expect(printMock).toHaveBeenCalledWith("t", 7, { rowIds: ["r1"], materialId: "wago-2009-110", target: "bmk" });
    expect(deps.setNotice).toHaveBeenCalledWith("1 Streifen gedruckt (3 BMK) — Schrift 7,7 mm");
  });

  it("settles the autosave first and does not print when the save failed", async () => {
    const beforePrint = vi.fn().mockResolvedValue(false);
    const { result, deps } = renderPrinting({ panel: PANEL, beforePrint });
    act(() => result.current.open(["f1:leiste"], "reihenklemmen"));
    await act(() => result.current.print(["f1:leiste"], "wago-2009-110", { target: "reihenklemmen" }));
    expect(printMock).not.toHaveBeenCalled();
    expect(deps.setError).toHaveBeenCalledWith(expect.stringMatching(/^Nicht gedruckt/));
    expect(deps.setNotice).not.toHaveBeenCalled();
    // The sheet stays open: the electrician sees the save chip and tries again.
    expect(result.current.dialog.open).toBe(true);
    expect(result.current.printing).toBe(false);
  });

  it("reports the skipped markers of a Reihenklemmen print", async () => {
    printMock.mockResolvedValue({ ...RESULT, skipped_without_bmk: 1 });
    const { result, deps } = renderPrinting({ panel: PANEL });
    await act(() => result.current.print(["f1:leiste"], "wago-2009-110", { target: "reihenklemmen" }));
    expect(deps.setNotice).toHaveBeenCalledWith(
      "2 Klemmen-Etiketten gedruckt (4 Klemmen) — Schrift 3,0 mm — 1 Klemme(n) ohne Beschriftung übersprungen",
    );
  });

  it("prints the Aderbeschriftung by its one id on the board's tube and counts the sleeves", async () => {
    printMock.mockResolvedValue({
      ...RESULT,
      printed: 12,
      material: "wago-211-502",
      strips: [{ row_id: "control:wires", row_label: "Aderbeschriftung", length_mm: 180, part_count: 12 }],
      font_size_dots: 48,
    });
    const { result, deps } = renderPrinting({ panel: PANEL });
    act(() => result.current.open(["control:wires"], "adern"));
    expect(result.current.dialog).toEqual({ open: true, ids: ["control:wires"], mode: "adern" });
    await act(() => result.current.print(["control:wires"], "wago-211-502", { target: "adern" }));
    expect(printMock).toHaveBeenCalledWith("t", 7, {
      stripIds: ["control:wires"],
      materialId: "wago-211-502",
      target: "adern",
    });
    expect(deps.setNotice).toHaveBeenCalledWith("12 Aderetiketten gedruckt");
    expect(result.current.dialog.open).toBe(false);
  });

  it("has its own fallback when the Aderbeschriftung fails without a message", async () => {
    printMock.mockRejectedValue(new Error(""));
    const { result, deps } = renderPrinting({ panel: PANEL });
    await act(() => result.current.print(["control:wires"], "wago-211-502", { target: "adern" }));
    expect(deps.setError).toHaveBeenCalledWith("Aderbeschriftung konnte nicht gedruckt werden");
  });

  // The §14a strip sizes itself; the size the server reports is the Leisten's.
  it("leaves the Leiste size out of a print that was only the §14a strip", async () => {
    printMock.mockResolvedValue({
      ...RESULT,
      printed: 6,
      strips: [{ row_id: "control:block", row_label: "§14a-Klemmleiste", length_mm: 31.2, part_count: 6 }],
      font_size_dots: 93,
    });
    const { result, deps } = renderPrinting({ panel: PANEL });
    await act(() => result.current.print(["control:block"], "wago-2009-110", { target: "reihenklemmen" }));
    expect(deps.setNotice).toHaveBeenCalledWith("1 Klemmen-Etikett gedruckt (6 Klemmen)");
  });

  it("surfaces the server's message when the print fails", async () => {
    printMock.mockRejectedValue(new Error("Keine Klemmenleiste ausgewählt — mindestens eine wählen."));
    const { result, deps } = renderPrinting({ panel: PANEL });
    await act(() => result.current.print(["f1:leiste"], "wago-2009-110", { target: "reihenklemmen" }));
    expect(deps.setError).toHaveBeenCalledWith("Keine Klemmenleiste ausgewählt — mindestens eine wählen.");
    expect(result.current.printing).toBe(false);
  });
});
