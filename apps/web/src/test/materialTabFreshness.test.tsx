/**
 * The Verteilerplan page never shows the server's view of a board that is
 * older than what the fitter just typed.
 *
 * The Materialliste, the Klemmen PDF and every plan PDF are derived on the
 * server from the SAVED document. Autosave waits 900 ms after the last edit,
 * so without these guards a fitter who edits and then taps "Material" or
 * "Plan als PDF" reads the board as it was a second ago — the extra breaker
 * missing, and nothing on screen saying so. Pinned here end to end through
 * the page, because each guard is one line of wiring that a refactor drops
 * without any unit test noticing:
 *
 *  - switching to Material / Klemmen waits for the save ("Speichert…");
 *  - the Materialliste reloads when the plan's revision changes;
 *  - every plan PDF opens only after the save has landed;
 *  - a save the server refuses (4xx) says why, a dropped connection says
 *    "check the connection" — the two need different action from the fitter.
 *
 * All data is invented.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError } from "../api/client";
import { AppContext } from "../context/AppContext";
import { SchaltplanPage } from "../pages/SchaltplanPage";
import { makeDevice } from "../utils/schaltplanDevices";
import type { PanelDocument, PanelMaterial, PanelPlan, PanelPlanSummary } from "../types/schaltplan";
import { makeAppContextStub } from "./appContextStub";

vi.mock("../utils/schaltplanApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/schaltplanApi")>();
  return {
    ...actual,
    listPanels: vi.fn(),
    listRecentPanels: vi.fn(),
    getPanel: vi.fn(),
    updatePanel: vi.fn(),
    duplicatePanel: vi.fn(),
    getPanelMaterial: vi.fn(),
  };
});

import { getPanel, getPanelMaterial, listPanels, listRecentPanels, updatePanel } from "../utils/schaltplanApi";

const getPanelMock = vi.mocked(getPanel);
const updateMock = vi.mocked(updatePanel);
const materialMock = vi.mocked(getPanelMaterial);

const CONNECTION_HINT = "Änderungen konnten nicht gespeichert werden. Prüfe die Verbindung.";
const UNKNOWN_CODE = "Unbekannter Schrank- oder Modulcode: ZX99.";

const SUMMARY: PanelPlanSummary = {
  id: 7,
  panel_number: "VT-0007",
  customer_id: 3,
  customer_name: "Schulze",
  project_id: null,
  project_number: null,
  project_name: null,
  name: "Unterverteiler Keller",
  designation: "UV1",
  panel_type: "sub",
  location: null,
  fed_from_panel_id: null,
  fed_from_designation: null,
  status: "draft",
  revision: 3,
  device_count: 1,
  circuit_count: 1,
  rcd_count: 0,
  used_slots: 1,
  total_slots: 12,
  row_count: 1,
  updated_at: "2026-10-21T08:00:00",
  updated_by_name: "Test",
};

const DOCUMENT: PanelDocument = {
  version: 1,
  supply: { system: "TN-S", voltage: "400/230 V", incoming: "", fuse: "", meter_number: "", note: "" },
  rows: [
    {
      id: "r1",
      label: "Reihe 1",
      slots: 12,
      devices: [makeDevice("mcb", { id: "q1", designation: "F1", circuit: "1", label: "Licht Flur" })],
    },
  ],
};

function plan(overrides: Partial<PanelPlan> = {}): PanelPlan {
  return {
    ...SUMMARY,
    document: DOCUMENT,
    notes: null,
    legend: [],
    findings: [],
    terminal_bom: [],
    created_at: "2026-10-01T08:00:00",
    created_by_name: "Test",
    ...overrides,
  };
}

const MATERIAL: PanelMaterial = {
  panel: {
    id: 7,
    panel_number: "VT-0007",
    designation: "UV1",
    name: "Unterverteiler Keller",
    panel_type: "sub",
    status: "draft",
    customer_id: 3,
    customer_name: "Schulze",
    project_id: null,
    project_number: null,
    project_name: null,
    updated_at: "2026-10-21T08:00:00",
  },
  lines: [],
  planned_total: 0,
  scanned_total: 0,
  open_lines: 0,
  last_scanned_at: null,
};

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderPage(setError = vi.fn()) {
  render(
    <AppContext.Provider
      value={
        makeAppContextStub({
          overrides: {
            user: { id: 1, email: "test@example.com", role: "employee", effective_permissions: ["reports:create"] },
            setError,
          },
        }) as never
      }
    >
      <SchaltplanPage />
    </AppContext.Provider>,
  );
  return { setError };
}

/** Open the board through "Zuletzt bearbeitet", the way a fitter returns to it. */
async function openBoard(setError = vi.fn()) {
  renderPage(setError);
  fireEvent.focus(await screen.findByPlaceholderText("Kunde suchen…"));
  fireEvent.mouseDown(await screen.findByText("VT-0007 · UV1 Unterverteiler Keller"));
  await screen.findByRole("heading", { name: "Unterverteiler Keller" });
  return { setError };
}

/** One autosaved edit: the Spannung on the Daten tab. */
function editVoltage(value = "230 V") {
  fireEvent.click(screen.getByRole("tab", { name: "Daten" }));
  fireEvent.change(screen.getByLabelText("Spannung"), { target: { value } });
}

function hidePage() {
  Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => "hidden" });
  act(() => {
    window.document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  // Reset here, not after: the previous test's page flushes its autosave
  // when it unmounts, which lands after an afterEach reset and would be
  // counted against this test.
  updateMock.mockReset();
  materialMock.mockReset();
  getPanelMock.mockReset();
  vi.mocked(listPanels).mockResolvedValue([]);
  vi.mocked(listRecentPanels).mockResolvedValue([SUMMARY]);
  getPanelMock.mockResolvedValue(plan());
  materialMock.mockResolvedValue(MATERIAL);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Back to jsdom's own getter.
  delete (window.document as { visibilityState?: unknown }).visibilityState;
});

describe("SchaltplanPage — Material and Klemmen read the saved board", () => {
  it("saves the edit before the Materialliste is fetched", async () => {
    const save = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(save.promise);
    await openBoard();
    editVoltage();

    fireEvent.click(screen.getByRole("tab", { name: "Material" }));
    // Not fetched from a server that has not seen the edit yet.
    expect(materialMock).not.toHaveBeenCalled();
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0][2].document?.supply.voltage).toBe("230 V");
    expect(screen.getAllByText("Speichert…").length).toBeGreaterThan(0);
    expect(materialMock).not.toHaveBeenCalled();

    await act(async () => save.resolve(plan({ revision: 4 })));
    await waitFor(() => expect(materialMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.invocationCallOrder[0]).toBeLessThan(materialMock.mock.invocationCallOrder[0]);
    expect(screen.getByRole("tab", { name: "Material" })).toHaveAttribute("aria-selected", "true");
  });

  it("switches at once when nothing is waiting to be saved", async () => {
    await openBoard();
    fireEvent.click(screen.getByRole("tab", { name: "Material" }));
    expect(screen.getByRole("tab", { name: "Material" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(materialMock).toHaveBeenCalledTimes(1));
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("saves before the Klemmen tab opens too", async () => {
    const save = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(save.promise);
    await openBoard();
    editVoltage();

    fireEvent.click(screen.getByRole("tab", { name: "Klemmen" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("tab", { name: "Klemmen" })).toHaveAttribute("aria-selected", "false");

    await act(async () => save.resolve(plan({ revision: 4 })));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Klemmen" })).toHaveAttribute("aria-selected", "true"),
    );
  });

  it("lets a later tab tap win over a switch still waiting for the save", async () => {
    const save = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(save.promise);
    await openBoard();
    editVoltage();

    fireEvent.click(screen.getByRole("tab", { name: "Material" }));
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    await act(async () => save.resolve(plan({ revision: 4 })));

    expect(screen.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
    expect(materialMock).not.toHaveBeenCalled();
  });

  it("reloads the Materialliste when the plan's revision changes", async () => {
    await openBoard();
    fireEvent.click(screen.getByRole("tab", { name: "Material" }));
    await waitFor(() => expect(materialMock).toHaveBeenCalledTimes(1));

    updateMock.mockResolvedValueOnce(plan({ revision: 4, status: "final" }));
    fireEvent.click(screen.getByRole("button", { name: "Als Bestand markieren" }));

    await waitFor(() => expect(materialMock).toHaveBeenCalledTimes(2));
  });
});

describe("SchaltplanPage — plan PDFs open after the save", () => {
  function fakeWindow() {
    return { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
  }

  it("opens the window inside the tap and points it at the PDF once the edit is saved", async () => {
    const win = fakeWindow();
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    const save = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(save.promise);
    await openBoard();
    editVoltage();

    fireEvent.click(screen.getByRole("link", { name: "Plan als PDF" }));
    // Synchronously: iOS only lets a tap open a window, not a promise after it.
    expect(open).toHaveBeenCalledTimes(1);
    expect(win.opener).toBeNull();
    expect(win.location.href).toBe("");

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    await act(async () => save.resolve(plan({ revision: 4 })));
    await waitFor(() => expect(win.location.href).toBe("/api/schaltplan/panels/7/pdf"));
    expect(win.close).not.toHaveBeenCalled();
  });

  it("holds the Materialliste PDF until an edit made over the Material tab is saved", async () => {
    // The inspector stays open over every tab but Schrank, so a fitter can
    // still change a device while the Materialliste is on screen.
    const win = fakeWindow();
    const open = vi.fn(() => win);
    vi.stubGlobal("open", open);
    await openBoard();
    fireEvent.click(screen.getByRole("tab", { name: "Aufbau" }));
    fireEvent.click(screen.getByTitle("Leitungsschutzschalter — Licht Flur"));
    fireEvent.click(screen.getByRole("tab", { name: "Material" }));
    await waitFor(() => expect(materialMock).toHaveBeenCalledTimes(1));

    const save = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(save.promise);
    fireEvent.change(screen.getByLabelText("Verbraucher / Bezeichnung"), { target: { value: "Licht Keller" } });
    fireEvent.click(await screen.findByRole("link", { name: "Als PDF" }));
    expect(open).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
    expect(updateMock.mock.calls[0][2].document?.rows[0].devices[0].label).toBe("Licht Keller");
    // Not pointed at a PDF the server would still draw from the old board.
    expect(win.location.href).toBe("");

    await act(async () => save.resolve(plan({ revision: 4 })));
    await waitFor(() => expect(win.location.href).toBe("/api/schaltplan/panels/7/material/pdf"));
  });

  it("closes the window again and says why when the save fails", async () => {
    const win = fakeWindow();
    vi.stubGlobal("open", vi.fn(() => win));
    updateMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { setError } = await openBoard();
    editVoltage();

    fireEvent.click(screen.getByRole("link", { name: "Legende drucken" }));

    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(win.location.href).toBe("");
    expect(setError).toHaveBeenLastCalledWith(expect.stringMatching(/^PDF nicht geöffnet/));
  });
});

describe("SchaltplanPage — why a save failed", () => {
  it("shows the server's reason for a refused save", async () => {
    updateMock.mockRejectedValueOnce(new ApiError(UNKNOWN_CODE, 400, UNKNOWN_CODE));
    const { setError } = await openBoard();
    editVoltage();
    hidePage();

    await waitFor(() => expect(setError).toHaveBeenCalledWith(`Nicht gespeichert: ${UNKNOWN_CODE}`));
    expect(setError).not.toHaveBeenCalledWith(CONNECTION_HINT);
    // The chip in the header says it too, for whoever missed the banner.
    expect(screen.getByText("Nicht gespeichert")).toBeInTheDocument();
  });

  it("keeps the connection hint for a dropped connection", async () => {
    updateMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { setError } = await openBoard();
    editVoltage();
    hidePage();

    await waitFor(() => expect(setError).toHaveBeenCalledWith(CONNECTION_HINT));
  });

  it("keeps the connection hint for a server error", async () => {
    updateMock.mockRejectedValueOnce(new ApiError("Internal Server Error", 500, "Internal Server Error"));
    const { setError } = await openBoard();
    editVoltage();
    hidePage();

    await waitFor(() => expect(setError).toHaveBeenCalledWith(CONNECTION_HINT));
  });
});
