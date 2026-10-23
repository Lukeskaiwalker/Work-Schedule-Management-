/**
 * "+ Gerät" on an empty cabinet rail of the Aufbau tab, the hook alone
 * (docs/PANEL_ENCLOSURE_R2.md §9, R14): the cabinet op `addDeviceToRail`
 * through the Schrank tab's runner. A refusal is said and changes nothing;
 * the page hears of the new device only once it is really on the board; a
 * circuit that would change its feed waits for RegroupConfirm. The page
 * tests (schaltplanEnclosurePage.test.tsx) drive the same paths through
 * the palette. Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";

import { useAufbauRailAdd, type AufbauRailTarget } from "../components/schaltplan/enclosure/useAufbauRailAdd";
import { MODULE_NOT_FOUND } from "../utils/enclosureOpsCore";
import type { PanelDocument } from "../types/schaltplan";
import { AUFBAU_INDEX, mod, ownerBoard } from "./enclosureAufbauBoards";
import { board, deepFreeze, dev, INDEX, row } from "./enclosureTestCatalog";

const VT_RAIL_1: AufbauRailTarget = { moduleId: "m-vt", railKey: "r1", label: "F3 · Verteiler 1" };

function setup(start: PanelDocument, options: { readOnly?: boolean; index?: typeof INDEX } = {}) {
  const state = { document: deepFreeze(start) };
  const mutate = vi.fn((recipe: (current: PanelDocument) => PanelDocument) => {
    if (options.readOnly) return;
    state.document = recipe(state.document);
  });
  const onError = vi.fn();
  const onNotice = vi.fn();
  const onAdded = vi.fn();
  const hook = renderHook(() =>
    useAufbauRailAdd({ document: state.document, index: options.index ?? AUFBAU_INDEX, mutate, onError, onNotice, onAdded }),
  );
  return { state, mutate, onError, onNotice, onAdded, hook };
}

const railRow = (document: PanelDocument, moduleId: string, railKey: string) => {
  const rowId = document.enclosure?.modules.find((module) => module.id === moduleId)?.rails[railKey];
  return document.rows.find((candidate) => candidate.id === rowId);
};

/** A ZB33S with only a ZU37KS in field 2, one LS on its second rail — straight off the Einspeisung. */
const fedByEinspeisung = (): PanelDocument =>
  board([row("v2", [dev("mcb", { id: "b1", designation: "F1.1", circuit: "1" })], "F2 · Verteiler 2")], {
    code: "ZB33S",
    modules: [mod("m2", "ZU37KS", 1, { r2: "v2" })],
  });

describe("useAufbauRailAdd", () => {
  it("creates and links the rail's row on the owner's empty ZU37VT5APZ2, then names the new device", () => {
    const { state, mutate, onError, onAdded, hook } = setup(ownerBoard());
    act(() => hook.result.current.add(VT_RAIL_1, "mcb"));

    expect(onError).not.toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledTimes(1);
    const added = railRow(state.document, "m-vt", "r1");
    expect(added).toEqual(expect.objectContaining({ label: "F3 · Verteiler 1", slots: 12 }));
    expect(added?.devices.map((device) => device.kind)).toEqual(["mcb"]);
    expect(onAdded).toHaveBeenCalledWith(added?.devices[0].id);
    expect(hook.result.current.confirm).toBeNull();
  });

  it("says a refusal and changes nothing — the module went away while the palette was open", () => {
    const { state, mutate, onError, onAdded, hook } = setup(ownerBoard());
    const before = state.document;
    act(() => hook.result.current.add({ ...VT_RAIL_1, moduleId: "m-gone" }, "mcb"));

    expect(onError).toHaveBeenCalledWith(MODULE_NOT_FOUND);
    expect(mutate).not.toHaveBeenCalled();
    expect(state.document).toBe(before);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("does not report a device that never landed (read-only board)", () => {
    const { state, onAdded, hook } = setup(ownerBoard(), { readOnly: true });
    const before = state.document;
    act(() => hook.result.current.add(VT_RAIL_1, "mcb"));

    expect(state.document).toBe(before);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("holds a feed change for RegroupConfirm and adds nothing on „Abbrechen“", () => {
    const { state, mutate, onAdded, hook } = setup(fedByEinspeisung(), { index: INDEX });
    act(() => hook.result.current.add({ moduleId: "m2", railKey: "r1", label: "F2 · Verteiler 1" }, "rcd"));

    expect(mutate).not.toHaveBeenCalled();
    const view = render(<>{hook.result.current.confirm}</>);
    const dialog = screen.getByRole("alertdialog", { name: "Stromkreise ändern ihre Einspeisung" });
    expect(within(dialog).getByText("F1.1: Einspeisung → FI")).toBeInTheDocument();
    act(() => fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" })));

    expect(hook.result.current.confirm).toBeNull();
    expect(mutate).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
    expect(railRow(state.document, "m2", "r1")).toBeUndefined();
    view.unmount();
  });

  it("adds the device on „Trotzdem ausführen“ and only then names it", () => {
    const { state, onAdded, hook } = setup(fedByEinspeisung(), { index: INDEX });
    act(() => hook.result.current.add({ moduleId: "m2", railKey: "r1", label: "F2 · Verteiler 1" }, "rcd"));
    expect(onAdded).not.toHaveBeenCalled();

    render(<>{hook.result.current.confirm}</>);
    act(() => fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Trotzdem ausführen" })));

    const added = railRow(state.document, "m2", "r1");
    expect(added?.devices.map((device) => device.kind)).toEqual(["rcd"]);
    expect(onAdded).toHaveBeenCalledWith(added?.devices[0].id);
    expect(hook.result.current.confirm).toBeNull();
  });
});
