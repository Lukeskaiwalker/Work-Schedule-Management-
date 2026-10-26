/**
 * The pure half of the §14a sheet (docs/PANEL_ENCLOSURE_R4.md §8.2): the
 * drawing at 5 px/mm with the marker text at the print size, the sheet's four
 * states, the field bar's line, and the length text a fitter types ("4,5").
 * Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import {
  CONTROL_DRAWING_PAD_PX,
  controlBarEntry,
  controlBlockDrawing,
  controlSheetState,
  parseLengthText,
} from "../components/schaltplan/enclosure/controlBlockLayout";
import { VERTICAL_PX_PER_MM, previewFontPx } from "../components/schaltplan/StripSvg";
import { defaultControlBlock } from "../utils/enclosureControlBlock";
import { cabinetPrep, wireDm } from "../utils/enclosurePrep";
import { controlStripSize } from "../utils/schaltplanStrip";
import type { ControlBlock, EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument, PanelRow } from "../types/schaltplan";
import { board, deepFreeze, dev, INDEX, R4_INDEX, row } from "./enclosureTestCatalog";

const mod = (id: string, code: string, field: number, rails: Record<string, string> = {}): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [],
});

const ABSENT = Symbol("absent");

function ehzBoard(block: unknown = defaultControlBlock(), rows: PanelRow[] = [], rails: Record<string, string> = {}): PanelDocument {
  const doc = board(rows, { code: "ZB33S", modules: [mod("m1", "ZH3EH16", 0, rails), mod("m2", "ZU37VT5APZ2", 1)] });
  const enclosure = block === ABSENT ? doc.enclosure! : { ...doc.enclosure!, control_block: block as ControlBlock };
  return deepFreeze({ ...doc, enclosure });
}

const fullRow = (id: string) => row(id, Array.from({ length: 12 }, () => dev("mcb")));

describe("controlBlockDrawing", () => {
  it("lays end stop | terminals | end plate | end stop at 5 px/mm", () => {
    const drawing = controlBlockDrawing(defaultControlBlock().terminals);
    expect(drawing.parts.map((part) => part.partId)).toEqual(["249-116", ...Array(6).fill("2002-1671"), "2002-1692", "249-116"]);
    const first = drawing.parts[1];
    expect(first).toMatchObject({ label: "UNSM", color: "braun", position: 1, x: CONTROL_DRAWING_PAD_PX + 6 * VERTICAL_PX_PER_MM, w: 26 });
    expect(drawing.parts[8].x + drawing.parts[8].w).toBeCloseTo(CONTROL_DRAWING_PAD_PX + 44.2 * VERTICAL_PX_PER_MM, 6);
    expect(drawing.width).toBeCloseTo(44.2 * VERTICAL_PX_PER_MM + 2 * CONTROL_DRAWING_PAD_PX, 6);
    expect(drawing.stub.h).toBe(6 * VERTICAL_PX_PER_MM);
    expect(drawing.stub.y).toBeGreaterThanOrEqual(drawing.parts[1].y + drawing.parts[1].h);
    expect(drawing.height).toBeGreaterThanOrEqual(drawing.stub.y + drawing.stub.h);
  });

  it("writes the marker at the size it prints at, and names every label", () => {
    const terminals = defaultControlBlock().terminals;
    const drawing = controlBlockDrawing(terminals);
    expect(drawing.fontPx).toBe(previewFontPx(controlStripSize(terminals.map((t) => t.label)), VERTICAL_PX_PER_MM));
    expect(drawing.ariaLabel).toBe("§14a-Klemmleiste: UNSM, 60%, 30%, 0%, UStve, Stve");
    const blank = controlBlockDrawing([{ id: "t1", label: "", color: "rot" }, { id: "t2", label: "A", color: "rosa" }]);
    expect(blank.ariaLabel).toBe("§14a-Klemmleiste: leer, A");
  });
});

describe("controlSheetState", () => {
  it("has no carrier without a meter field", () => {
    const doc = deepFreeze(board([], { code: "ZB33S", modules: [mod("m2", "ZU37VT5APZ2", 1)] }));
    expect(controlSheetState(doc, INDEX)).toEqual({ kind: "no-carrier" });
    expect(controlBarEntry(controlSheetState(doc, INDEX))).toBeNull();
  });

  it("knows an absent and a removed block, on the carrier's field", () => {
    const absent = controlSheetState(ehzBoard(ABSENT), INDEX);
    expect(absent.kind).toBe("absent");
    expect(controlBarEntry(absent)).toEqual({ field: 0, sub: "fehlt" });
    const off = controlSheetState(ehzBoard({ ...defaultControlBlock(), off: true }), INDEX);
    expect(off.kind).toBe("off");
    expect(controlBarEntry(off)).toEqual({ field: 0, sub: "entfernt" });
  });

  it("describes a placed block: field, target, rails and the measured wire", () => {
    const doc = ehzBoard();
    const state = controlSheetState(doc, INDEX);
    if (state.kind !== "present") throw new Error(state.kind);
    expect(state.field).toBe(0);
    expect(state.target).toMatchObject({ name: "RfZ", field: 0 });
    expect(state.rails).toEqual([{ key: "aar1", title: "F1 · AAR 1" }, { key: "aar2", title: "F1 · AAR 2" }]);
    const run = cabinetPrep(doc, INDEX)!.runs.find((entry) => entry.kind === "control")!;
    expect(state.measuredM).toBe(wireDm(null, run.lengthMm) / 10);
    expect(controlBarEntry(state)).toEqual({ field: 0, sub: "6 Klemmen" });
  });

  it("says when the block does not fit, and for one terminal in the singular", () => {
    const full = ehzBoard(defaultControlBlock(), [fullRow("r1"), fullRow("r2")], { aar1: "r1", aar2: "r2" });
    expect(controlBarEntry(controlSheetState(full, INDEX))).toEqual({ field: 0, sub: "passt nicht" });
    const one = ehzBoard({ ...defaultControlBlock(), terminals: [{ id: "t1", label: "A", color: "braun" }] });
    expect(controlBarEntry(controlSheetState(one, INDEX))?.sub).toBe("1 Klemme");
  });

  it("has no target on a 3-Punkt carrier without an APZ, and skips a reserve field", () => {
    const doc = board([], { code: "ZB33S", modules: [mod("r", "ZH33XL", 0), mod("m", "ZH33X7", 1)] });
    const state = controlSheetState(deepFreeze({ ...doc, enclosure: { ...doc.enclosure!, control_block: defaultControlBlock() } }), R4_INDEX);
    if (state.kind !== "present") throw new Error(state.kind);
    expect(state.carrier.id).toBe("m");
    expect(state.target).toBeNull();
    expect(state.measuredM).toBeNull();
  });
});

describe("parseLengthText", () => {
  it.each([
    ["", { kind: "empty" }],
    ["   ", { kind: "empty" }],
    ["4,5", { kind: "value", metres: 4.5 }],
    ["4.5", { kind: "value", metres: 4.5 }],
    ["3,25 m", { kind: "value", metres: 3.3 }],
    ["20", { kind: "value", metres: 20 }],
    ["0,4", { kind: "invalid" }],
    ["21", { kind: "invalid" }],
    ["vier", { kind: "invalid" }],
    ["1,2,3", { kind: "invalid" }],
  ])("%j", (text, expected) => {
    expect(parseLengthText(text)).toEqual(expected);
  });
});
