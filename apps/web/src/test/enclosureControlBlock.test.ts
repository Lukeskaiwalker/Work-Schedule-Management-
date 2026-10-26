/**
 * The §14a Steuersignal-Klemmleiste (docs/PANEL_ENCLOSURE_R4.md §2.1, §3.1,
 * §3.2) — the TypeScript twin of `panel_enclosure_control_block.py`.
 *
 * Parity first: the parser table and every fixture board's placement must be
 * what Python answered. Then direct cases on the test catalogue: the carrier
 * (first meter field from the left, never a reserve field while one is in
 * use), the rail (stored, first with room, first), the right-aligned offset
 * that never covers the devices, and the occupancy the rail sheets add.
 */
import { describe, expect, it } from "vitest";

import {
  CONTROL_LABEL_MAX,
  CONTROL_PARTS,
  DEFAULT_CONTROL_LABELS,
  DERIVE,
  MAX_CONTROL_TERMINALS,
  WIRE_COLOURS,
  WIRE_COLOUR_STYLE,
  blockParts,
  candidateRails,
  controlBlockLayout,
  controlBlockMmOn,
  controlCarrier,
  defaultControlBlock,
  normaliseControlLabel,
  parseControlBlock,
  parseLengthM,
  placeControlBlock,
} from "../utils/enclosureControlBlock";
import { TERMINAL_PARTS } from "../utils/schaltplanTerminalRules";
import type { ControlBlock, EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelRow } from "../types/schaltplan";
import { BOARD_NAMES, FIXTURE_BOARDS, FIXTURE_INDEX, FIXTURE_TABLES } from "./enclosureFixtureBoards";
import { board, deepFreeze, dev, INDEX, MODULES, R4_INDEX, row, testCatalog } from "./enclosureTestCatalog";
import { catalogIndex } from "../utils/enclosureCatalog";

const mod = (id: string, code: string, field: number, unit: number, rails: Record<string, string> = {}, extra: Partial<EnclosureModule> = {}): EnclosureModule => ({
  id, code, field, unit, label: "", rails, fittings: null, removed_fittings: [], meters: [], ...extra,
});

const ABSENT = Symbol("absent");

/** A ZB33S with the given modules, rows and stored block (the default block unless given; ABSENT = no key). */
function cabinetBoard(modules: EnclosureModule[], rows: PanelRow[] = [], block: unknown = defaultControlBlock()): PanelDocument {
  const doc = board(rows, { code: "ZB33S", modules });
  if (block === ABSENT) return doc;
  return { ...doc, enclosure: { ...doc.enclosure!, control_block: block as ControlBlock } };
}

const fullRow = (id: string, count = 12) => row(id, Array.from({ length: count }, () => dev("mcb")));

describe("parity with the Python twin (enclosureFixtures.json)", () => {
  it.each(FIXTURE_TABLES.control_block_parse.map((entry, i) => [i, entry] as const))("control_block_parse #%i", (_i, entry) => {
    expect(parseControlBlock(entry.input)).toEqual(entry.output);
  });

  it.each(BOARD_NAMES)("%s: the placement", (name) => {
    const fixture = FIXTURE_BOARDS[name];
    expect(placeControlBlock(fixture.document, FIXTURE_INDEX)).toEqual(fixture.control_block);
  });
});

describe("constants and the parser", () => {
  it("keeps the block's parts apart from the circuit terminals' parts (R4-3)", () => {
    const shared = Object.keys(CONTROL_PARTS).filter((id) => id in TERMINAL_PARTS);
    expect(shared).toEqual([]);
    expect(Object.values(CONTROL_PARTS).map((part) => part.width_mm)).toEqual([6, 5.2, 1]);
  });

  it("never names PE or N colours and styles every colour", () => {
    for (const colour of WIRE_COLOURS) expect(colour).not.toMatch(/grün|gelb|blau/);
    expect(Object.keys(WIRE_COLOUR_STYLE)).toEqual([...WIRE_COLOURS]);
  });

  it("seeds six BDEW terminals that parse to themselves", () => {
    const block = defaultControlBlock();
    expect(block.terminals.map((t) => [t.id, t.label, t.color])).toEqual(
      DEFAULT_CONTROL_LABELS.map((label, i) => [`t${i + 1}`, label, WIRE_COLOURS[i]]),
    );
    expect(block).toMatchObject({ rail: null, wire_mm2: 2.5, wire_length_m: null, label_material: "wago-211-502", off: false });
    expect(parseControlBlock(block)).toEqual(block);
    expect(defaultControlBlock()).not.toBe(block); // a fresh copy every time
  });

  it("normalises a label: control characters out, outer U+0020 off, 12 code points", () => {
    expect(normaliseControlLabel("  60 %  ")).toBe("60 %");
    expect(normaliseControlLabel("a\u0000b\u009fc")).toBe("abc");
    expect(normaliseControlLabel(" UNSM ")).toBe(" UNSM ");
    expect(Array.from(normaliseControlLabel("🔌".repeat(13)))).toHaveLength(CONTROL_LABEL_MAX);
    expect(normaliseControlLabel(7)).toBe("");
  });

  it("reads a length half up and keeps it between 0,5 and 20 m", () => {
    expect(parseLengthM(0.45)).toBe(0.5);
    expect(parseLengthM(0.44)).toBeNull();
    expect(parseLengthM(20.05)).toBeNull();
    expect(parseLengthM(2.25)).toBe(2.3);
    expect(parseLengthM(true)).toBeNull();
    expect(parseLengthM(Number.NaN)).toBeNull();
    expect(parseLengthM(1e12)).toBeNull();
  });

  it("keeps at most twelve terminals", () => {
    const many = { terminals: Array.from({ length: 20 }, () => ({})) };
    expect(parseControlBlock(many)!.terminals).toHaveLength(MAX_CONTROL_TERMINALS);
  });
});

describe("the carrier (§3.1)", () => {
  it("is the first meter module from the left, by field, unit, then list order", () => {
    const doc = cabinetBoard([mod("d", "ZU37KS", 0, 0), mod("b", "ZH3EL27", 2, 0), mod("a", "ZH3EH16", 1, 0)]);
    expect(controlCarrier(doc, INDEX)?.id).toBe("a");
    const moved = cabinetBoard([mod("d", "ZU37KS", 1, 0), mod("b", "ZH3EL27", 0, 0), mod("a", "ZH3EH16", 2, 0)]);
    expect(controlCarrier(moved, INDEX)?.id).toBe("b");
  });

  it("skips a reserve field while a meter field in use exists, else takes it", () => {
    const doc = cabinetBoard([mod("r", "ZH33XL", 0, 0), mod("m", "ZH33X7", 1, 0)]);
    expect(controlCarrier(doc, R4_INDEX)).toMatchObject({ id: "m", reserve: false, family: "meter_3p", field: 1 });
    const reserveOnly = cabinetBoard([mod("r", "ZH33XL", 0, 0)]);
    expect(controlCarrier(reserveOnly, R4_INDEX)).toMatchObject({ id: "r", reserve: true });
  });

  it("is null without a meter module", () => {
    expect(controlCarrier(cabinetBoard([mod("d", "ZU37KS", 0, 0)]), INDEX)).toBeNull();
    expect(controlCarrier(board([]), INDEX)).toBeNull();
  });
});

describe("the placement (§3.2)", () => {
  it("sits right-aligned on the first AAR rail with room", () => {
    const placed = placeControlBlock(cabinetBoard([mod("m", "ZH3EH16", 0, 0)]), INDEX)!;
    expect(placed).toMatchObject({
      moduleId: "m", railKey: "aar1", field: 0, railTitle: "F1 · AAR 1", railX: 45, railY: 100,
      offsetMm: 165.8, widthMm: 44.2, devicesMm: 0, capacityMm: 210, overflow: false,
    });
    expect(placed.parts.map((part) => [part.partId, part.position, part.offsetMm])).toEqual([
      ["249-116", null, 0], ["2002-1671", 1, 6], ["2002-1671", 2, 11.2], ["2002-1671", 3, 16.4],
      ["2002-1671", 4, 21.6], ["2002-1671", 5, 26.8], ["2002-1671", 6, 32], ["2002-1692", null, 37.2], ["249-116", null, 38.2],
    ]);
    expect(placed.parts[1]).toMatchObject({ terminalId: "t1", label: "UNSM", color: "braun", widthMm: 5.2 });
    expect(placed.parts[0]).toMatchObject({ terminalId: null, label: null, color: null });
  });

  it("takes the next rail when the first is full and honours a stored rail even when full", () => {
    const modules = [mod("m", "ZH3EH16", 0, 0, { aar1: "a1" })];
    const auto = placeControlBlock(cabinetBoard(modules, [fullRow("a1")]), INDEX)!;
    expect(auto).toMatchObject({ railKey: "aar2", railTitle: "F1 · AAR 2", railY: 250, overflow: false });
    const stored = placeControlBlock(cabinetBoard(modules, [fullRow("a1")], { ...defaultControlBlock(), rail: "aar1" }), INDEX)!;
    expect(stored).toMatchObject({ railKey: "aar1", devicesMm: 210, offsetMm: 210, overflow: true });
    const unknown = placeControlBlock(cabinetBoard(modules, [fullRow("a1")], { ...defaultControlBlock(), rail: "rfz" }), INDEX)!;
    expect(unknown.railKey).toBe("aar2");
  });

  it("with every rail full takes the first and never draws over the devices", () => {
    const modules = [mod("m", "ZH3EH16", 0, 0, { aar1: "a1", aar2: "a2" })];
    const placed = placeControlBlock(cabinetBoard(modules, [fullRow("a1", 11), fullRow("a2")]), INDEX)!;
    expect(placed).toMatchObject({ railKey: "aar1", devicesMm: 192.5, offsetMm: 192.5, overflow: true });
  });

  it("counts hand-placed placeholders on an AAR rail (it is never a terminal rail)", () => {
    const modules = [mod("m", "ZH3EH16", 0, 0, { aar1: "a1" })];
    const placed = placeControlBlock(cabinetBoard(modules, [row("a1", [dev("terminal"), dev("terminal")])]), INDEX)!;
    expect(placed).toMatchObject({ railKey: "aar1", devicesMm: 35, offsetMm: 165.8 });
  });

  it("sizes twelve terminals and one terminal", () => {
    expect(blockParts(defaultControlBlock().terminals.slice(0, 1)).widthMm).toBeCloseTo(18.2, 9);
    const twelve = parseControlBlock({ terminals: Array.from({ length: 12 }, () => ({})) })!;
    const placed = placeControlBlock(cabinetBoard([mod("m", "ZH3EH16", 0, 0)], [], twelve), INDEX)!;
    expect(placed).toMatchObject({ widthMm: 75.4, offsetMm: 134.6 });
    expect(placed.parts).toHaveLength(15);
  });

  it("places nothing without a block, terminals, a carrier or an AAR rail", () => {
    const meter = [mod("m", "ZH3EH16", 0, 0)];
    expect(placeControlBlock(cabinetBoard(meter, [], ABSENT), INDEX)).toBeNull();
    expect(placeControlBlock(cabinetBoard(meter, [], null), INDEX)).toBeNull();
    expect(placeControlBlock(cabinetBoard(meter, [], "garbage"), INDEX)).toBeNull();
    expect(placeControlBlock(cabinetBoard(meter, [], { ...defaultControlBlock(), off: true }), INDEX)).toBeNull();
    expect(placeControlBlock(cabinetBoard(meter, [], { ...defaultControlBlock(), terminals: [] }), INDEX)).toBeNull();
    expect(placeControlBlock(cabinetBoard([mod("d", "ZU37KS", 0, 0)]), INDEX)).toBeNull();
    const noAar = catalogIndex(testCatalog({ modules: { ZH3EH16: { ...MODULES.ZH3EH16, zones: MODULES.ZH3EH16.zones.filter((z) => z.type !== "AAR") } } }));
    const doc = cabinetBoard(meter);
    expect(controlCarrier(doc, noAar)?.id).toBe("m");
    expect(candidateRails(doc, noAar, controlCarrier(doc, noAar)!)).toEqual([]);
    expect(placeControlBlock(doc, noAar)).toBeNull();
  });

  it("reads the stored block for DERIVE and takes a given one (or none) as is", () => {
    const doc = cabinetBoard([mod("m", "ZH3EH16", 0, 0)]);
    expect(placeControlBlock(doc, INDEX, DERIVE)).toEqual(placeControlBlock(doc, INDEX));
    expect(placeControlBlock(doc, INDEX, null)).toBeNull();
    const one = parseControlBlock({ terminals: [{ label: "X" }] })!;
    expect(placeControlBlock(doc, INDEX, one)!.widthMm).toBe(18.2);
  });

  it("counts a row named twice for its first name only", () => {
    // n names the row first (list order), so it is not on the carrier's aar1.
    const modules = [mod("n", "ZH3EL27", 1, 0, { aar1: "a1" }), mod("m", "ZH3EH16", 0, 0, { aar1: "a1" })];
    expect(placeControlBlock(cabinetBoard(modules, [fullRow("a1")]), INDEX)).toMatchObject({ moduleId: "m", railKey: "aar1", devicesMm: 0 });
  });

  it("never mutates the document", () => {
    const doc = deepFreeze(cabinetBoard([mod("m", "ZH3EH16", 0, 0, { aar1: "a1" })], [fullRow("a1", 3)]));
    expect(() => placeControlBlock(doc, INDEX)).not.toThrow();
    expect(() => controlBlockLayout(doc, INDEX)).not.toThrow();
  });
});

describe("occupancy (controlBlockMmOn)", () => {
  it("is the unrounded block width on the block's rail and 0 elsewhere", () => {
    const doc = cabinetBoard([mod("m", "ZH3EH16", 0, 0)]);
    const width = blockParts(defaultControlBlock().terminals).widthMm;
    expect(controlBlockMmOn(doc, INDEX, "m", "aar1")).toBe(width);
    expect(controlBlockMmOn(doc, INDEX, "m", "aar2")).toBe(0);
    expect(controlBlockMmOn(doc, INDEX, "x", "aar1")).toBe(0);
    expect(controlBlockMmOn(cabinetBoard([mod("m", "ZH3EH16", 0, 0)], [], ABSENT), INDEX, "m", "aar1")).toBe(0);
  });
});
