/**
 * „Zuletzt bearbeitete Verteiler“ on the start page → that panel open in the
 * Schaltplan editor (docs/DASHBOARD.md §9.5).
 *
 * The start page and the editor share no state, so the panel waits in
 * utils/schaltplanHandoff.ts until the page mounts. Three ways that goes wrong
 * without anyone noticing: React.StrictMode (main.tsx) runs the mount effect
 * twice and a take-once read loses the panel to the discarded run; the request
 * is cleared before the panel actually opened, so a failed open cannot be
 * retried; or an old request nobody acted on pops a panel open on some later
 * visit. Built with createElement so the file keeps the contract's `.ts` name.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, createElement, type ReactNode } from "react";

import { AppContext } from "../context/AppContext";
import { usePendingPanelHandoff } from "../hooks/usePendingPanelHandoff";
import { SchaltplanPage } from "../pages/SchaltplanPage";
import type { PanelPlan, PanelPlanSummary } from "../types/schaltplan";
import { endDashboardSession } from "../utils/dashboardSession";
import { emptyDocument } from "../utils/schaltplanDevices";
import { clearPendingPanel, peekPendingPanel, requestOpenPanel } from "../utils/schaltplanHandoff";
import { makeAppContextStub } from "./appContextStub";

/** Invented board; the repo is public. */
const PANEL: PanelPlanSummary = {
  id: 42,
  panel_number: "VT-0042",
  customer_id: 3,
  customer_name: "Beispiel GmbH",
  project_id: 7,
  project_number: "P-0007",
  project_name: "Musterhaus",
  name: "Keller",
  designation: "UV1",
  panel_type: "sub",
  location: null,
  fed_from_panel_id: null,
  fed_from_designation: null,
  status: "draft",
  revision: 3,
  device_count: 0,
  circuit_count: 0,
  rcd_count: 0,
  used_slots: 0,
  total_slots: 12,
  row_count: 1,
  updated_at: "2026-10-21T08:00:00Z",
  updated_by_name: "Mara Beispiel",
};

const StrictWrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

afterEach(() => {
  clearPendingPanel();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the handoff store", () => {
  it("keeps the panel for 30 seconds and ignores a 31-second-old request", () => {
    const requestedAt = Date.parse("2026-10-22T09:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(requestedAt);

    requestOpenPanel(PANEL);

    expect(peekPendingPanel(requestedAt + 30_000)).toEqual(PANEL);
    expect(peekPendingPanel(requestedAt + 31_000)).toBeNull();
  });

  it("peeks without consuming, and clearPendingPanel empties it", () => {
    requestOpenPanel(PANEL);

    expect(peekPendingPanel()).toEqual(PANEL);
    expect(peekPendingPanel()).toEqual(PANEL);

    clearPendingPanel();

    expect(peekPendingPanel()).toBeNull();
  });

  it("is emptied when the session ends: the summary names a customer", () => {
    requestOpenPanel(PANEL);

    endDashboardSession();

    expect(peekPendingPanel()).toBeNull();
  });
});

describe("usePendingPanelHandoff", () => {
  it("survives a StrictMode double mount: picks the panel once and keeps it until it opened", () => {
    requestOpenPanel(PANEL);
    const pick = vi.fn();

    const { rerender } = renderHook(({ opened }) => usePendingPanelHandoff(pick, opened), {
      wrapper: StrictWrapper,
      initialProps: { opened: null as number | null },
    });

    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick).toHaveBeenCalledWith(PANEL);
    // Not consumed by the mount: the open is still on its way.
    expect(peekPendingPanel()).toEqual(PANEL);

    rerender({ opened: 9 });
    expect(peekPendingPanel()).toEqual(PANEL);

    rerender({ opened: PANEL.id });
    expect(peekPendingPanel()).toBeNull();
  });

  it("does nothing without a request", () => {
    const pick = vi.fn();

    renderHook(() => usePendingPanelHandoff(pick, null), { wrapper: StrictWrapper });

    expect(pick).not.toHaveBeenCalled();
  });

  it("ignores a request older than 30 seconds", () => {
    const requestedAt = Date.parse("2026-10-22T09:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(requestedAt);
    requestOpenPanel(PANEL);
    vi.setSystemTime(requestedAt + 31_000);
    const pick = vi.fn();

    renderHook(() => usePendingPanelHandoff(pick, null));

    expect(pick).not.toHaveBeenCalled();
  });
});

describe("SchaltplanPage", () => {
  function detail(): PanelPlan {
    return {
      ...PANEL,
      document: emptyDocument(),
      notes: null,
      legend: [],
      findings: [],
      terminal_bom: [],
      created_at: "2026-10-20T08:00:00Z",
      created_by_name: "Mara Beispiel",
    } as PanelPlan;
  }

  function serve() {
    const opened: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const path = url.split("?")[0];
        if (path === `/api/schaltplan/panels/${PANEL.id}`) {
          opened.push(path);
          await held;
          return new Response(JSON.stringify(detail()), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    return { opened, release };
  }

  it("opens the panel the start page asked for, once under StrictMode, and clears it only after it opened", async () => {
    requestOpenPanel(PANEL);
    const network = serve();
    const context = makeAppContextStub({
      overrides: {
        mainView: "schaltplan",
        language: "de",
        token: "test-token",
        user: { id: 1, email: "a@example.com", role: "employee", effective_permissions: ["reports:create"] },
      },
    });

    render(
      createElement(
        StrictMode,
        null,
        createElement(AppContext.Provider, { value: context as never }, createElement(SchaltplanPage)),
      ),
    );

    await waitFor(() => expect(network.opened).toHaveLength(1));
    expect(peekPendingPanel()).toEqual(PANEL);

    await act(async () => network.release());

    await waitFor(() => expect(peekPendingPanel()).toBeNull());
    expect(network.opened).toHaveLength(1);
  });
});
