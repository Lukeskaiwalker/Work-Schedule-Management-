/**
 * The Verteilerplan editor's document state and autosave, out of the page.
 *
 * What this pins is what a fitter would lose without noticing: an edit sent
 * twice (StrictMode double-invokes), an edit never sent (tablet locked, page
 * left), keystrokes eaten by a save answer that overwrote the document, a
 * PDF or printer reading the board before the last edit landed, a refused
 * save reported as a network problem, and a key this client does not know
 * yet (the enclosure block, `supplied_by`) silently dropped on the next save.
 *
 * All data is invented.
 */
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { ApiError } from "../api/client";
import { AUTOSAVE_DELAY_MS, usePanelDocumentEditor } from "../hooks/usePanelDocumentEditor";
import { makeDevice } from "../utils/schaltplanDevices";
import type { PanelDocument, PanelPlan } from "../types/schaltplan";

vi.mock("../utils/schaltplanApi", () => ({ updatePanel: vi.fn() }));

import { updatePanel } from "../utils/schaltplanApi";

const updateMock = vi.mocked(updatePanel);

const CONNECTION_HINT = "Änderungen konnten nicht gespeichert werden. Prüfe die Verbindung.";

const RCD = makeDevice("rcd", { id: "f1", designation: "F1" });
const MCB = makeDevice("mcb", { id: "q1", designation: "F1.1", circuit: "1", label: "Licht Flur" });
const FED = makeDevice("mcb", { id: "q2", designation: "F2.1", circuit: "2", parent_id: "f1" });

const DOCUMENT: PanelDocument = {
  version: 1,
  supply: { system: "TN-S", voltage: "400/230 V", incoming: "", fuse: "", meter_number: "", note: "" },
  rows: [
    { id: "r1", label: "Reihe 1", slots: 12, devices: [RCD, MCB] },
    { id: "r2", label: "Reihe 2", slots: 12, devices: [FED] },
  ],
};

/** A document from a newer client: keys this one has no type for yet. */
const FUTURE_DOCUMENT = {
  ...DOCUMENT,
  enclosure: { code: "ZB33S", modules: [{ id: "mod-a", code: "ZH3EH16", field: 0, unit: 0 }] },
  rows: [
    {
      ...DOCUMENT.rows[0],
      devices: [RCD, { ...MCB, supplied_by: { module: "mod-a", part: "hs" } }],
    },
    DOCUMENT.rows[1],
  ],
} as unknown as PanelDocument;

function saved(revision: number, document: PanelDocument = DOCUMENT): PanelPlan {
  return { id: 7, revision, document } as PanelPlan;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function strict({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}

function renderEditor(options: { readOnly?: boolean; document?: PanelDocument } = {}) {
  const onSaved = vi.fn();
  const setError = vi.fn();
  const hook = renderHook(
    () => usePanelDocumentEditor({ token: "t", readOnly: options.readOnly ?? false, onSaved, setError }),
    { wrapper: strict },
  );
  act(() => hook.result.current.load({ panelId: 7, document: options.document ?? DOCUMENT }));
  return { ...hook, onSaved, setError };
}

/** Let the chained save promises run; fake timers do not touch microtasks. */
async function drain() {
  await act(async () => {
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
  });
}

function sentDocument(call: number): PanelDocument {
  const body = updateMock.mock.calls[call][2];
  if (!body.document) throw new Error(`PATCH ${call} carried no document`);
  return body.document;
}

function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(window.document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    window.document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  updateMock.mockReset();
  updateMock.mockImplementation(async (_token, _id, body) => saved(4, body.document));
});

afterEach(() => {
  vi.useRealTimers();
  delete (window.document as { visibilityState?: unknown }).visibilityState;
});

describe("usePanelDocumentEditor — autosave", () => {
  it("sends one PATCH per debounced edit under StrictMode, carrying the latest document", async () => {
    const { result } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => result.current.patchSupply({ fuse: "NH 63 A" }));
    expect(result.current.saveState).toBe("pending");
    expect(updateMock).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    await drain();

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(sentDocument(0).supply).toMatchObject({ voltage: "230 V", fuse: "NH 63 A" });
    expect(result.current.saveState).toBe("clean");
  });

  it("flushes at once when the page is hidden", async () => {
    const { result } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    setVisibility("visible");
    expect(updateMock).not.toHaveBeenCalled();

    setVisibility("hidden");
    await drain();
    expect(updateMock).toHaveBeenCalledTimes(1);
    // The debounce was cancelled, not left to send it a second time.
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2));
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("flushes when the editor unmounts", () => {
    const { result, unmount } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    unmount();
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(sentDocument(0).supply.voltage).toBe("230 V");
  });

  it("never lets the server's answer overwrite the document being edited", async () => {
    const answer = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(answer.promise);
    const { result, onSaved } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(result.current.saveState).toBe("saving");

    // Typed on while the request was in flight.
    act(() => result.current.patchSupply({ fuse: "NH 63 A" }));
    const reply = saved(4, { ...DOCUMENT, rows: [] });
    await act(async () => answer.resolve(reply));
    await drain();

    expect(onSaved).toHaveBeenCalledWith(reply);
    expect(result.current.document?.rows).toHaveLength(2);
    expect(result.current.document?.supply).toMatchObject({ voltage: "230 V", fuse: "NH 63 A" });
    expect(result.current.saveState).toBe("pending");
  });

  it("settleSaves waits for the request in flight, then flushes the rest in edit order", async () => {
    const first = deferred<PanelPlan>();
    const second = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    act(() => result.current.patchSupply({ voltage: "400 V" }));

    let settled: boolean | undefined;
    act(() => {
      void result.current.settleSaves().then((value) => {
        settled = value;
      });
    });
    await drain();
    // One PATCH at a time: the second waits for the first's answer.
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(settled).toBeUndefined();

    await act(async () => first.resolve(saved(4)));
    await drain();
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(sentDocument(1).supply.voltage).toBe("400 V");
    expect(settled).toBeUndefined();

    await act(async () => second.resolve(saved(5)));
    await drain();
    expect(settled).toBe(true);
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2));
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it("settleSaves is true straight away when nothing waits", async () => {
    const { result } = renderEditor();
    await expect(result.current.settleSaves()).resolves.toBe(true);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("keeps a failed save and sends it again when something needs the server current", async () => {
    updateMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { result } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    await drain();
    expect(result.current.saveState).toBe("error");

    let settled: boolean | undefined;
    await act(async () => {
      settled = await result.current.settleSaves();
    });
    expect(settled).toBe(true);
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(sentDocument(1).supply.voltage).toBe("230 V");
    expect(result.current.saveState).toBe("clean");
  });

  it("settleSaves keeps waiting for an edit that left the queue while it waited", async () => {
    // The PDF tab coming to the front hides the editor page, and that flushes
    // the waiting edit behind the save in flight — while settleSaves waits.
    const first = deferred<PanelPlan>();
    const second = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    act(() => result.current.patchSupply({ voltage: "400 V" }));

    let settled: boolean | undefined;
    act(() => {
      void result.current.settleSaves().then((value) => {
        settled = value;
      });
    });
    setVisibility("hidden");
    await act(async () => first.resolve(saved(4)));
    await drain();
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(settled).toBeUndefined();

    await act(async () => second.resolve(saved(5)));
    await drain();
    expect(settled).toBe(true);
  });

  it("judges settleSaves and the chip by the open panel, not by the one just left", async () => {
    const left = deferred<PanelPlan>();
    updateMock.mockReturnValueOnce(left.promise);
    const { result, setError } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => result.current.load({ panelId: 9, document: { ...DOCUMENT, rows: [] } }));

    let settled: boolean | undefined;
    act(() => {
      void result.current.settleSaves().then((value) => {
        settled = value;
      });
    });
    await act(async () => left.reject(new ApiError("Verteiler gesperrt", 409, "Verteiler gesperrt")));
    await drain();
    // Panel 9 has nothing waiting: its PDF, copy or labels may go ahead.
    expect(settled).toBe(true);
    expect(result.current.saveState).toBe("clean");
    // The edit to panel 7 is lost, so it is still said — as panel 7's.
    expect(setError).toHaveBeenCalledWith("Vorher geöffneter Verteiler nicht gespeichert: Verteiler gesperrt");
  });

  it("saves a pending edit to the panel it was made on when another panel is loaded", async () => {
    const { result } = renderEditor();
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => result.current.load({ panelId: 9, document: { ...DOCUMENT, rows: [] } }));
    await drain();

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][1]).toBe(7);
    expect(result.current.document?.rows).toEqual([]);
  });
});

describe("usePanelDocumentEditor — why a save failed", () => {
  async function failWith(error: unknown) {
    updateMock.mockRejectedValueOnce(error);
    const editor = renderEditor();
    act(() => editor.result.current.patchSupply({ voltage: "230 V" }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    await drain();
    return editor;
  }

  it("names the server's reason for a refused save (4xx)", async () => {
    const detail = "Unbekannter Schrank- oder Modulcode: ZX99.";
    const { result, setError } = await failWith(new ApiError(detail, 400, detail));
    expect(setError).toHaveBeenCalledWith(`Nicht gespeichert: ${detail}`);
    expect(result.current.saveState).toBe("error");
  });

  it("reads a validation error's first message (422)", async () => {
    const detail = [{ loc: ["body", "document", "rows"], msg: "Zu viele Reihen", type: "too_long" }];
    const { setError } = await failWith(new ApiError("Unprocessable Entity", 422, detail));
    expect(setError).toHaveBeenCalledWith("Nicht gespeichert: Zu viele Reihen");
  });

  it("keeps the connection hint for a dropped connection", async () => {
    const { setError } = await failWith(new TypeError("Failed to fetch"));
    expect(setError).toHaveBeenCalledWith(CONNECTION_HINT);
  });

  it("keeps the connection hint for a server error (5xx)", async () => {
    const { setError } = await failWith(new ApiError("Bad Gateway", 502, "Bad Gateway"));
    expect(setError).toHaveBeenCalledWith(CONNECTION_HINT);
  });
});

describe("usePanelDocumentEditor — document operations", () => {
  it("keeps keys it has no type for through every edit", () => {
    const { result } = renderEditor({ document: FUTURE_DOCUMENT });
    act(() => result.current.patchDevice("q1", { label: "Licht Keller" }));
    act(() => result.current.moveDevice("q1", -1));
    act(() => result.current.addDevice("r2", "mcb"));
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));

    const sent = sentDocument(0) as unknown as typeof FUTURE_DOCUMENT & Record<string, unknown>;
    expect(sent.enclosure).toEqual((FUTURE_DOCUMENT as unknown as Record<string, unknown>).enclosure);
    const moved = sent.rows[0].devices[0] as unknown as Record<string, unknown>;
    expect(moved).toMatchObject({ id: "q1", label: "Licht Keller", supplied_by: { module: "mod-a", part: "hs" } });
  });

  it("applies two edits from one handler on top of each other", () => {
    const { result } = renderEditor();
    act(() => {
      result.current.patchSupply({ voltage: "230 V" });
      result.current.patchSupply({ fuse: "NH 63 A" });
    });
    expect(result.current.document?.supply).toMatchObject({ voltage: "230 V", fuse: "NH 63 A" });
  });

  it("does nothing read-only", () => {
    const { result } = renderEditor({ readOnly: true });
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    expect(result.current.addDevice("r1", "mcb")).toBeNull();
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(result.current.document).toBe(DOCUMENT);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("does not save an edit that changed nothing", () => {
    const { result } = renderEditor();
    // f1 is first on the first rail: "nach links" has nowhere to go, and a
    // PATCH for it would still bump the printed revision.
    act(() => result.current.moveDevice("f1", -1));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));
    expect(updateMock).not.toHaveBeenCalled();
    expect(result.current.saveState).toBe("clean");
  });

  it("numbers a new breaker and hands back its id", () => {
    const { result } = renderEditor();
    let id: string | null = null;
    act(() => {
      id = result.current.addDevice("r2", "mcb");
    });
    const devices = result.current.document?.rows[1].devices ?? [];
    const added = devices[devices.length - 1];
    expect(added?.id).toBe(id);
    expect(added?.circuit).toBe("3");
  });

  it("duplicates into the next slot and hands back the copy's id", () => {
    const { result } = renderEditor();
    let id: string | null = null;
    act(() => {
      id = result.current.duplicateDevice("q1");
    });
    expect(id).not.toBeNull();
    expect(result.current.document?.rows[0].devices.map((device) => device.id)).toEqual(["f1", "q1", id]);
  });

  it("removes a device and frees whatever named it as its feed", () => {
    const { result } = renderEditor();
    act(() => result.current.removeDevice("f1"));
    const rows = result.current.document?.rows ?? [];
    expect(rows[0].devices.map((device) => device.id)).toEqual(["q1"]);
    expect(rows[1].devices[0].parent_id).toBeNull();
  });

  it("removes a device's Reihenklemmen overrides with it", () => {
    const { result } = renderEditor({ document: { ...DOCUMENT, terminal_labels: { "q1:0": "1.1", "q2:0": "2.1" } } });
    act(() => result.current.removeDevice("q1"));
    expect(result.current.document?.terminal_labels).toEqual({ "q2:0": "2.1" });
  });

  it("saves a cabinet board normalised, so a stale duplicate cannot fail every save", () => {
    const module = { id: "mod-a", code: "ZU37KS", field: 0, unit: 0, label: "", rails: { r1: "r1" }, fittings: [], removed_fittings: [], meters: [] };
    const twin = { ...module, field: 1, rails: { r1: "r1", r2: "r2" } };
    const { result } = renderEditor({ document: { ...DOCUMENT, enclosure: { code: "ZB33S", modules: [module, twin] } } });
    act(() => result.current.patchSupply({ voltage: "230 V" }));
    act(() => vi.advanceTimersByTime(AUTOSAVE_DELAY_MS));

    const modules = sentDocument(0).enclosure!.modules;
    expect(new Set(modules.map((entry) => entry.id)).size).toBe(2);
    expect(modules[1].rails).toEqual({ r2: "r2" });
    expect(result.current.document?.enclosure?.modules.map((entry) => entry.id)).toEqual(modules.map((entry) => entry.id));
  });

  it("hops to the neighbouring rail at a rail's edge", () => {
    const { result } = renderEditor();
    act(() => result.current.moveDevice("q1", 1));
    const rows = result.current.document?.rows ?? [];
    expect(rows[0].devices.map((device) => device.id)).toEqual(["f1"]);
    expect(rows[1].devices.map((device) => device.id)).toEqual(["q1", "q2"]);
  });

  it("adds, renames, resizes and removes rails", () => {
    const { result } = renderEditor();
    act(() => result.current.addRow());
    const added = result.current.document?.rows[2];
    expect(added).toMatchObject({ label: "Reihe 3", slots: 12, devices: [] });
    act(() => result.current.renameRow(added?.id ?? "", "Reserve"));
    act(() => result.current.changeSlots(added?.id ?? "", 400));
    expect(result.current.document?.rows[2]).toMatchObject({ label: "Reserve", slots: 96 });
    act(() => result.current.changeSlots(added?.id ?? "", 0));
    expect(result.current.document?.rows[2].slots).toBe(1);
    act(() => result.current.removeRow(added?.id ?? ""));
    expect(result.current.document?.rows).toHaveLength(2);
  });

  it("appends a rail from a template", () => {
    const { result } = renderEditor();
    act(() => result.current.addRowFromTemplate("rcd-6mcb"));
    expect(result.current.document?.rows).toHaveLength(3);
    expect(result.current.document?.rows[2].devices).toHaveLength(7);
  });
});
