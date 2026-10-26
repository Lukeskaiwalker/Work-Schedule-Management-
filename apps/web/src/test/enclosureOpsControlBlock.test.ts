/**
 * The §14a block's ops and the prep overrides (docs/PANEL_ENCLOSURE_R4.md
 * §8.3, §2.1, §2.2): pure, tested on deep-frozen boards — an op that touches
 * its input throws in strict mode. Refusals carry the exported copy; an op
 * that changes nothing hands the input back, so `mutate` saves nothing.
 * `placeModule` seeds the default block for a meter field, never over one
 * that exists or was removed.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import {
  CONTROL_BLOCK_ABSENT,
  CONTROL_COLOUR_INVALID,
  CONTROL_LENGTH_INVALID,
  CONTROL_NO_CABINET,
  CONTROL_RAIL_INVALID,
  CONTROL_TERMINALS_FULL,
  CONTROL_TERMINAL_GONE,
  CONTROL_TERMINAL_LAST,
  CONTROL_TUBE_INVALID,
  CONTROL_WIRE_INVALID,
  PREP_CHOICE_INVALID,
  addControlBlock,
  addControlTerminal,
  removeControlBlock,
  removeControlTerminal,
  renameControlTerminal,
  resetControlBlock,
  restoreControlBlock,
  seedControlBlock,
  setControlBlockRail,
  setControlLabelMaterial,
  setControlTerminalColour,
  setControlWire,
  setControlWireLength,
  setPrepOverride,
} from "../utils/enclosureOpsControlBlock";
import { defaultControlBlock, storedBlock, WIRE_COLOURS } from "../utils/enclosureControlBlock";
import { placeModule, type OpResult } from "../utils/enclosureOps";
import type { ControlBlock, PrepOverrides } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { board, deepFreeze, INDEX } from "./enclosureTestCatalog";

const ABSENT = Symbol("absent");

function cabinet(block: unknown = defaultControlBlock(), prep?: unknown): PanelDocument {
  const doc = board([], { code: "ZB33S", modules: [] });
  const enclosure = { ...doc.enclosure!, ...(block === ABSENT ? {} : { control_block: block as ControlBlock }) };
  return deepFreeze({ ...doc, enclosure: prep === undefined ? enclosure : { ...enclosure, prep: prep as PrepOverrides } });
}

function applied(result: OpResult): PanelDocument {
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.document;
}

const block = (doc: PanelDocument) => doc.enclosure?.control_block as ControlBlock;
const labels = (doc: PanelDocument) => block(doc).terminals.map((terminal) => terminal.label);

describe("add, remove, restore, reset", () => {
  it("adds the default block to a cabinet without one, and refuses without a cabinet", () => {
    expect(block(applied(addControlBlock(cabinet(ABSENT))))).toEqual(defaultControlBlock());
    expect(addControlBlock(deepFreeze(board([])))).toEqual({ ok: false, error: CONTROL_NO_CABINET });
  });

  it("leaves a present block alone and brings a removed one back with its labels", () => {
    const present = cabinet();
    const kept = addControlBlock(present);
    expect(kept.ok && kept.document).toBe(present);
    const renamed = applied(renameControlTerminal(present, "t1", "Freigabe"));
    const off = applied(removeControlBlock(deepFreeze(renamed)));
    expect(block(off).off).toBe(true);
    expect(labels(off)[0]).toBe("Freigabe");
    const back = applied(restoreControlBlock(deepFreeze(off)));
    expect(block(back).off).toBe(false);
    expect(labels(back)[0]).toBe("Freigabe");
  });

  it("restore seeds the default when there is no block, remove leaves an absent block absent", () => {
    expect(block(applied(restoreControlBlock(cabinet(ABSENT))))).toEqual(defaultControlBlock());
    const doc = cabinet(ABSENT);
    const removed = removeControlBlock(doc);
    expect(removed.ok && removed.document).toBe(doc);
  });

  it("resets labels and colours to the six defaults, keeping wire, tube, length and rail", () => {
    const start = cabinet({
      ...defaultControlBlock(),
      terminals: [{ id: "t4", label: "X", color: "rosa" }],
      rail: "aar2",
      wire_mm2: 1.5,
      wire_length_m: 3.5,
      label_material: "wago-211-501",
    });
    const reset = block(applied(resetControlBlock(start)));
    expect(reset.terminals).toEqual(defaultControlBlock().terminals);
    expect(reset).toMatchObject({ rail: "aar2", wire_mm2: 1.5, wire_length_m: 3.5, label_material: "wago-211-501", off: false });
  });

  it("reads a hand-edited block through the parser before changing it", () => {
    const messy = cabinet({ terminals: [{ id: "t1", label: "  A\u0007  ", color: "grün" }, "junk"], off: "yes", extra: 1 });
    const next = block(applied(setControlWire(messy, 1.5)));
    expect(next).toEqual({
      terminals: [{ id: "t1", label: "A", color: "braun" }],
      rail: null, wire_mm2: 1.5, wire_length_m: null, label_material: "wago-211-502", off: false,
    });
  });
});

describe("terminals", () => {
  it("adds a terminal with the smallest free id and the colour of its position", () => {
    const start = cabinet({ ...defaultControlBlock(), terminals: [{ id: "t2", label: "A", color: "rot" }, { id: "t3", label: "B", color: "rot" }] });
    const next = block(applied(addControlTerminal(start)));
    expect(next.terminals[2]).toEqual({ id: "t1", label: "", color: WIRE_COLOURS[2] });
  });

  it("refuses a 13th terminal", () => {
    const twelve = cabinet({ ...defaultControlBlock(), terminals: Array.from({ length: 12 }, (_, i) => ({ id: `t${i + 1}`, label: "", color: "grau" })) });
    expect(addControlTerminal(twelve)).toEqual({ ok: false, error: CONTROL_TERMINALS_FULL });
  });

  it("removes a terminal by id but never the last one", () => {
    const next = applied(removeControlTerminal(cabinet(), "t2"));
    expect(labels(next)).toEqual(["UNSM", "30%", "0%", "UStve", "Stve"]);
    const single = cabinet({ ...defaultControlBlock(), terminals: [{ id: "t1", label: "A", color: "braun" }] });
    expect(removeControlTerminal(single, "t1")).toEqual({ ok: false, error: CONTROL_TERMINAL_LAST });
    expect(removeControlTerminal(cabinet(), "t9")).toEqual({ ok: false, error: CONTROL_TERMINAL_GONE });
  });

  it("renames to at most 12 code points without control characters, and says when nothing changed", () => {
    const next = applied(renameControlTerminal(cabinet(), "t1", " Wärmepumpe12345\u0000 "));
    expect(labels(next)[0]).toBe("Wärmepumpe12");
    expect(Array.from(labels(applied(renameControlTerminal(cabinet(), "t1", "🔌".repeat(14))))[0])).toHaveLength(12);
    const doc = cabinet();
    const same = renameControlTerminal(doc, "t1", "UNSM");
    expect(same.ok && same.document).toBe(doc);
    expect(renameControlTerminal(cabinet(), "t7", "A")).toEqual({ ok: false, error: CONTROL_TERMINAL_GONE });
    expect(renameControlTerminal(cabinet(ABSENT), "t1", "A")).toEqual({ ok: false, error: CONTROL_BLOCK_ABSENT });
  });

  it("sets a colour from the list only", () => {
    expect(block(applied(setControlTerminalColour(cabinet(), "t3", "orange"))).terminals[2].color).toBe("orange");
    expect(setControlTerminalColour(cabinet(), "t3", "grün-gelb" as never)).toEqual({ ok: false, error: CONTROL_COLOUR_INVALID });
  });
});

describe("rail, wire, length, tube", () => {
  it("pins a rail by key or goes back to automatic", () => {
    const pinned = applied(setControlBlockRail(cabinet(), "aar2"));
    expect(block(pinned).rail).toBe("aar2");
    expect(block(applied(setControlBlockRail(deepFreeze(pinned), null))).rail).toBeNull();
    expect(setControlBlockRail(cabinet(), "AAR 2")).toEqual({ ok: false, error: CONTROL_RAIL_INVALID });
  });

  it("takes 1,5 or 2,5 mm² only", () => {
    expect(block(applied(setControlWire(cabinet(), 1.5))).wire_mm2).toBe(1.5);
    expect(setControlWire(cabinet(), 4 as never)).toEqual({ ok: false, error: CONTROL_WIRE_INVALID });
  });

  it("stores a length in 0,5 … 20 m rounded half up to one decimal, null for the drawing", () => {
    expect(block(applied(setControlWireLength(cabinet(), 3.25))).wire_length_m).toBe(3.3);
    expect(block(applied(setControlWireLength(cabinet(), 0.45))).wire_length_m).toBe(0.5);
    const set = applied(setControlWireLength(cabinet(), 4));
    expect(block(applied(setControlWireLength(deepFreeze(set), null))).wire_length_m).toBeNull();
    for (const bad of [0.4, 20.1, Number.NaN, Infinity]) {
      expect(setControlWireLength(cabinet(), bad)).toEqual({ ok: false, error: CONTROL_LENGTH_INVALID });
    }
  });

  it("takes the two WAGO tubes only", () => {
    expect(block(applied(setControlLabelMaterial(cabinet(), "wago-211-501"))).label_material).toBe("wago-211-501");
    expect(setControlLabelMaterial(cabinet(), "wago-2009-110" as never)).toEqual({ ok: false, error: CONTROL_TUBE_INVALID });
  });
});

describe("setPrepOverride (§2.2)", () => {
  const prepOf = (doc: PanelDocument) => doc.enclosure?.prep;

  it("stores the whole parsed object, in key order", () => {
    const next = applied(setPrepOverride(cabinet(ABSENT), "supply", "LS"));
    expect(prepOf(next)).toEqual({ supply: "LS", infeed: "auto", joints: "auto", network: "auto", network_m: null });
    expect(Object.keys(prepOf(next)!)).toEqual(["supply", "infeed", "joints", "network", "network_m"]);
  });

  it("removes the key once every group is automatic again", () => {
    const start = cabinet(ABSENT, { supply: "LS", infeed: "auto", joints: "auto", network: "auto", network_m: null });
    const next = applied(setPrepOverride(start, "supply", "auto"));
    expect(next.enclosure).not.toHaveProperty("prep");
    const lengthOnly = cabinet(ABSENT, { supply: "auto", infeed: "auto", joints: "auto", network: "auto", network_m: 2.5 });
    expect(applied(setPrepOverride(lengthOnly, "network_m", null)).enclosure).not.toHaveProperty("prep");
  });

  it("takes a network length by rule 8, and refuses values outside the choices", () => {
    expect(prepOf(applied(setPrepOverride(cabinet(ABSENT), "network_m", 1.24)))?.network_m).toBe(1.2);
    expect(setPrepOverride(cabinet(ABSENT), "network_m", 25)).toEqual({ ok: false, error: CONTROL_LENGTH_INVALID });
    expect(setPrepOverride(cabinet(ABSENT), "infeed", "LS")).toEqual({ ok: false, error: PREP_CHOICE_INVALID });
    expect(setPrepOverride(cabinet(ABSENT), "colour" as never, "auto")).toEqual({ ok: false, error: PREP_CHOICE_INVALID });
    expect(setPrepOverride(deepFreeze(board([])), "joints", "off")).toEqual({ ok: false, error: CONTROL_NO_CABINET });
  });

  it("changes nothing when the value is already stored, or all automatic without a key", () => {
    const doc = cabinet(ABSENT);
    const same = setPrepOverride(doc, "network", "auto");
    expect(same.ok && same.document).toBe(doc);
    const off = cabinet(ABSENT, { supply: "auto", infeed: "auto", joints: "off", network: "auto", network_m: null });
    const again = setPrepOverride(off, "joints", "off");
    expect(again.ok && again.document).toBe(off);
  });
});

describe("seeding (R4-2)", () => {
  const empty = () => deepFreeze(board([], { code: "ZB33S", modules: [] }));

  it("placeModule seeds the default block with the first meter field", () => {
    const placed = applied(placeModule(empty(), INDEX, { code: "ZH3EH16", field: 0, unit: 0, claim: false }));
    expect(storedBlock(placed)).toEqual(defaultControlBlock());
  });

  it("does not seed for other families, nor over a present or removed block", () => {
    const distribution = applied(placeModule(empty(), INDEX, { code: "ZU37KS", field: 0, unit: 0 }));
    expect(distribution.enclosure).not.toHaveProperty("control_block");
    const renamed = { ...defaultControlBlock(), terminals: [{ id: "t1", label: "Eigen", color: "rot" as const }] };
    const present = deepFreeze({ ...empty(), enclosure: { ...empty().enclosure!, control_block: renamed } });
    expect(block(applied(placeModule(present, INDEX, { code: "ZH33X7", field: 1, unit: 0 })))).toEqual(renamed);
    const off = deepFreeze({ ...empty(), enclosure: { ...empty().enclosure!, control_block: { ...defaultControlBlock(), off: true } } });
    expect(block(applied(placeModule(off, INDEX, { code: "ZH33X7", field: 1, unit: 0 }))).off).toBe(true);
  });

  it("seedControlBlock is a no-op without a cabinet or for a non-meter family", () => {
    const plain = deepFreeze(board([]));
    expect(seedControlBlock(plain, "meter_ehz")).toBe(plain);
    const doc = empty();
    expect(seedControlBlock(doc, "distribution")).toBe(doc);
    expect(seedControlBlock(doc, "meter_3p").enclosure?.control_block).toEqual(defaultControlBlock());
  });
});
