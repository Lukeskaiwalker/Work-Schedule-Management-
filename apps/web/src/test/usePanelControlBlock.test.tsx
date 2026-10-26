/**
 * The page's §14a wiring (docs/PANEL_ENCLOSURE_R4.md §8.5, §9.1, §9.2): the
 * Klemmen print opens with every strip and the §14a strip last, the wire
 * labels open the dialog in mode `adern` only while a block exists and is
 * not removed, and the Daten hint is derived only while it is wanted.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import { usePanelControlBlock } from "../components/schaltplan/usePanelControlBlock";
import { defaultControlBlock } from "../utils/enclosureControlBlock";
import { CONTROL_STRIP_ID, WIRE_STRIP_ID } from "../utils/schaltplanControlStrip";
import type { ControlBlock, EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { board, INDEX } from "./enclosureTestCatalog";

const mod = (id: string, code: string, field: number): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails: {}, fittings: null, removed_fittings: [], meters: [],
});

const ABSENT = Symbol("absent");

function meterBoard(block: unknown = defaultControlBlock(), incoming = "NYY-J 5x16 mm²"): PanelDocument {
  const doc = board([], { code: "ZB33S", modules: [mod("m1", "ZH3EH16", 0)] });
  const withSupply = { ...doc, supply: { ...doc.supply, incoming } };
  return block === ABSENT ? withSupply : { ...withSupply, enclosure: { ...doc.enclosure!, control_block: block as ControlBlock } };
}

const GROUPS = [{ strips: [{ stripId: "rcd:f1:0" }, { stripId: "rcd:f2:0" }] }];

function setup(document: PanelDocument | null, wantHint = false) {
  const openLabels = vi.fn();
  const { result } = renderHook(() => usePanelControlBlock({ document, index: INDEX, groups: GROUPS, wantHint, openLabels }));
  return { result, openLabels };
}

describe("usePanelControlBlock", () => {
  it("opens the Klemmen print with the §14a strip last", () => {
    const { result, openLabels } = setup(meterBoard());
    expect(result.current.hasControlStrip).toBe(true);
    result.current.printKlemmen();
    expect(openLabels).toHaveBeenCalledWith(["rcd:f1:0", "rcd:f2:0", CONTROL_STRIP_ID], "reihenklemmen");
  });

  it("opens the wire labels in mode adern while a block exists", () => {
    const { result, openLabels } = setup(meterBoard());
    result.current.printWires!();
    expect(openLabels).toHaveBeenCalledWith([WIRE_STRIP_ID], "adern");
  });

  it("has no wire print and no §14a strip without a block or with a removed one", () => {
    for (const document of [meterBoard(ABSENT), meterBoard({ ...defaultControlBlock(), off: true })]) {
      const { result, openLabels } = setup(document);
      expect(result.current.printWires).toBeUndefined();
      expect(result.current.hasControlStrip).toBe(false);
      result.current.printKlemmen();
      expect(openLabels).toHaveBeenCalledWith(["rcd:f1:0", "rcd:f2:0"], "reihenklemmen");
    }
  });

  it("derives the Daten hint only while it is wanted", () => {
    expect(setup(meterBoard(), false).result.current.infeedHint).toBeNull();
    expect(setup(meterBoard(), true).result.current.infeedHint).toBe("Querschnitt erkannt: 16 mm² → Einspeiseadapter K96ESA5");
    expect(setup(null, true).result.current.infeedHint).toBeNull();
  });
});
