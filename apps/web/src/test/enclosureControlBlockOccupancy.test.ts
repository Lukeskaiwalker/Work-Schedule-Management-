/**
 * What the §14a block takes of its AAR rail in the editor (docs/PANEL_ENCLOSURE_R4.md
 * §3.2 "Occupancy"): the rail sheets' fullness (`sheetModel`) and the drop
 * measure (`enclosureDropTargets.deviceOverMm`) add `controlBlockMmOn`, the
 * latter on the document as it would be after the drop — the automatic rail
 * may move the block away. `encl.rail_overflow` keeps counting devices only.
 */
import { describe, expect, it } from "vitest";

import { deviceOverMm } from "../components/schaltplan/enclosure/enclosureDropTargets";
import { moduleRails, railInfo } from "../components/schaltplan/enclosure/sheetModel";
import { defaultControlBlock } from "../utils/enclosureControlBlock";
import { enclosureFindings } from "../utils/enclosureRules";
import type { ControlBlock, EnclosureModule } from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";
import { board, deepFreeze, dev, INDEX, row } from "./enclosureTestCatalog";

const meter = (rails: Record<string, string> = {}): EnclosureModule => ({
  id: "m", code: "ZH3EH16", field: 0, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [],
});

function withBlock(doc: PanelDocument, block: ControlBlock | null = defaultControlBlock()): PanelDocument {
  return { ...doc, enclosure: { ...doc.enclosure!, control_block: block } };
}

const mcbs = (count: number, prefix: string): PanelDevice[] => Array.from({ length: count }, (_, i) => dev("mcb", { id: `${prefix}${i}` }));

describe("sheetModel", () => {
  it("counts the block on its rail only", () => {
    const doc = withBlock(board([row("a1", mcbs(2, "x"))], { code: "ZB33S", modules: [meter({ aar1: "a1" })] }));
    expect(railInfo(doc, INDEX, "m", "aar1")).toMatchObject({ usedPle: 4.5, freePle: 7.5 }); // 35 + 44,2 mm
    expect(railInfo(doc, INDEX, "m", "aar2")).toMatchObject({ usedPle: 0, freePle: 12 });
    const rails = moduleRails(doc, INDEX, doc.enclosure!.modules[0]);
    expect(rails.find((rail) => rail.railKey === "aar1")?.usedPle).toBe(4.5);
  });

  it("counts nothing for a removed or absent block", () => {
    const plain = board([row("a1", mcbs(2, "x"))], { code: "ZB33S", modules: [meter({ aar1: "a1" })] });
    expect(railInfo(plain, INDEX, "m", "aar1")?.usedPle).toBe(2);
    expect(railInfo(withBlock(plain, { ...defaultControlBlock(), off: true }), INDEX, "m", "aar1")?.usedPle).toBe(2);
  });
});

describe("deviceOverMm", () => {
  it("adds the block where it sits after the drop", () => {
    // aar1 holds 8 LS (140 mm) + the block (44,2 mm); aar2 is full, so the block stays on aar1.
    const rows = [row("a1", mcbs(8, "a")), row("a2", mcbs(12, "b")), row("own", mcbs(2, "o"))];
    const doc = withBlock(board(rows, { code: "ZB33S", modules: [meter({ aar1: "a1", aar2: "a2" })] }));
    expect(deviceOverMm(doc, INDEX, ["o0"], "m", "aar1")).toBe(0); // 157,5 + 44,2 mm
    expect(deviceOverMm(doc, INDEX, ["o0", "o1"], "m", "aar1")).toBe(9.2); // 175 + 44,2 mm
  });

  it("drops the block from a rail it would leave", () => {
    // Ten more LS fill aar1: the automatic rail moves the block to aar2, so aar1 itself fits.
    const doc = withBlock(board([row("a1", mcbs(2, "a")), row("own", mcbs(10, "o"))], { code: "ZB33S", modules: [meter({ aar1: "a1" })] }));
    const ten = Array.from({ length: 10 }, (_, i) => `o${i}`);
    expect(deviceOverMm(doc, INDEX, ten, "m", "aar1")).toBe(0);
    // A stored rail keeps the block where it is.
    const pinned = withBlock(doc, { ...defaultControlBlock(), rail: "aar1" });
    expect(deviceOverMm(pinned, INDEX, ten, "m", "aar1")).toBe(44.2);
  });

  it("counts the block on an empty rail without a row yet", () => {
    const doc = withBlock(board([row("own", mcbs(10, "o"))], { code: "ZB33S", modules: [meter()] }));
    const ten = Array.from({ length: 10 }, (_, i) => `o${i}`);
    expect(deviceOverMm(doc, INDEX, ten, "m", "aar1")).toBe(0); // 175 + 44,2 > 210 → the block goes to aar2
    expect(deviceOverMm(withBlock(doc, { ...defaultControlBlock(), rail: "aar1" }), INDEX, ten, "m", "aar1")).toBe(9.2);
  });

  it("never mutates the document", () => {
    const doc = deepFreeze(withBlock(board([row("a1", mcbs(8, "a")), row("own", mcbs(2, "o"))], { code: "ZB33S", modules: [meter({ aar1: "a1" })] })));
    expect(() => deviceOverMm(doc, INDEX, ["o0", "o1"], "m", "aar1")).not.toThrow();
  });
});

describe("encl.rail_overflow", () => {
  it("still counts devices only", () => {
    const doc = withBlock(board([row("a1", mcbs(11, "a"))], { code: "ZB33S", modules: [meter({ aar1: "a1" })] }));
    expect(enclosureFindings(doc, INDEX).map((finding) => finding.rule)).not.toContain("encl.rail_overflow");
  });
});
