/**
 * The Schrank-Etikett sheet's state hook. Like `useLabelPrinting`, its
 * callbacks must keep their identity across renders, and what it tells the
 * electrician after a print — or a failed one — is the only feedback the
 * printer gives from across the workshop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useTypeLabelPrinting } from "../components/schaltplan/useTypeLabelPrinting";
import type { PanelPlan } from "../types/schaltplan";

vi.mock("../utils/schaltplanApi", () => ({ printPanelTypeLabel: vi.fn() }));

import { printPanelTypeLabel } from "../utils/schaltplanApi";

const printMock = vi.mocked(printPanelTypeLabel);

const PANEL = { id: 7 } as unknown as PanelPlan;

const RESULT = {
  printer: "WAGO Smart Printer",
  material: "Typenschilder 99 × 44 (silber)",
  sheets: 2,
  customer: "Familie Schulze",
  project_number: "381",
  build_month: "09.2026",
};

function renderPrinting(panel: PanelPlan | null = PANEL) {
  const deps = { panel, token: "t", setNotice: vi.fn(), setError: vi.fn() };
  return { deps, ...renderHook(() => useTypeLabelPrinting(deps)) };
}

describe("useTypeLabelPrinting", () => {
  beforeEach(() => {
    printMock.mockReset();
  });

  it("opens and closes the sheet with callbacks that keep their identity", () => {
    const { result, rerender } = renderPrinting();
    const first = result.current;
    expect(first.dialogOpen).toBe(false);

    rerender();
    expect(result.current.open).toBe(first.open);
    expect(result.current.close).toBe(first.close);

    act(() => first.open());
    expect(result.current.dialogOpen).toBe(true);
    act(() => first.close());
    expect(result.current.dialogOpen).toBe(false);
  });

  it("reports the sheets and the material after a print, and closes the sheet", async () => {
    printMock.mockResolvedValueOnce(RESULT);
    const { result, deps } = renderPrinting();
    act(() => result.current.open());

    await act(() => result.current.print({ build_month: "09.2026", copies: 2 }));

    expect(printMock).toHaveBeenCalledWith("t", 7, { build_month: "09.2026", copies: 2 });
    expect(deps.setNotice).toHaveBeenCalledWith("Schrank-Etikett gedruckt (2×, Typenschilder 99 × 44 (silber))");
    expect(deps.setError).not.toHaveBeenCalled();
    expect(result.current.dialogOpen).toBe(false);
    expect(result.current.printing).toBe(false);
  });

  it("shows the server's sentence when the print fails, and keeps the sheet open", async () => {
    printMock.mockRejectedValueOnce(new Error("Im Drucker ist kein 99 × 44 Etikett eingelegt."));
    const { result, deps } = renderPrinting();
    act(() => result.current.open());

    await act(() => result.current.print({ build_month: "09.2026", copies: 1 }));

    expect(deps.setError).toHaveBeenCalledWith("Im Drucker ist kein 99 × 44 Etikett eingelegt.");
    expect(deps.setNotice).not.toHaveBeenCalled();
    expect(result.current.dialogOpen).toBe(true);
    expect(result.current.printing).toBe(false);
  });

  it("falls back to a generic message when the failure carries none", async () => {
    printMock.mockRejectedValueOnce(new Error(""));
    const { result, deps } = renderPrinting();

    await act(() => result.current.print({ build_month: "09.2026", copies: 1 }));

    expect(deps.setError).toHaveBeenCalledWith("Schrank-Etikett konnte nicht gedruckt werden");
  });

  it("prints nothing without a panel", async () => {
    const { result, deps } = renderPrinting(null);

    await act(() => result.current.print({ build_month: "09.2026", copies: 1 }));

    expect(printMock).not.toHaveBeenCalled();
    expect(deps.setNotice).not.toHaveBeenCalled();
    expect(deps.setError).not.toHaveBeenCalled();
  });
});
