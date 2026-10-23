/**
 * Where a dragged device would land (docs/PANEL_ENCLOSURE_R2.md §6.3): the
 * client → cabinet-mm conversion, the band under (or nearest to) the
 * finger — never one of another field —, the insertion index, the
 * refusals, and the rail-fit number the drop label shares with the
 * RailPicker so the two can never disagree.
 *
 * Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import {
  buildDropIndex,
  clientToSceneMm,
  deviceDragSource,
  deviceDropAt,
  deviceOverMm,
  dropLabelText,
  railOverMm,
  railUsedMm,
  stripDropAt,
  stripLabelText,
  type DeviceDrop,
} from "../components/schaltplan/enclosure/enclosureDropTargets";
import { DRAWING_PAD_PX, FIELD_HEADER_PX, railBands } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { catalogIndex } from "../utils/enclosureCatalog";
import { buildEnclosureScene } from "../utils/enclosureGeometry";
import { fillRailFromTemplate, placeModule } from "../utils/enclosureOps";
import { stripMoveOverMm } from "../utils/enclosureOpsTerminals";
import { placeTerminals, terminalRailKeys } from "../utils/enclosureTerminals";
import type { PanelDocument } from "../types/schaltplan";
import { renderBoard, renderScene } from "./enclosureRenderBoard";
import { board, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";
import { doc, fi, lsRun, mod, range, row as terminalRow } from "./enclosureTerminalBoards";

const NONE: ReadonlySet<string> = new Set();

function indexFor(scene = renderScene(), opts: Partial<Parameters<typeof buildDropIndex>[2]> = {}) {
  const bands = railBands(scene, opts.reserved ?? NONE);
  return buildDropIndex(scene, bands, { reserved: NONE, rowsInOrder: true, ...opts });
}

/** Feld 2 (ZU37KS "m2"), rail r1: x 295 … 505, centre y 100; FI F1 70 mm, LS F1.1 17,5 mm. */
const R1_Y = 100;
const R1_X = 295;

describe("clientToSceneMm", () => {
  it("undoes the drawing's padding, field header and zoom", () => {
    const rect = { left: 10, top: 20 } as DOMRect;
    const zoom = 0.5;
    const point = clientToSceneMm(rect, zoom, { x: 10 + DRAWING_PAD_PX + 50, y: 20 + FIELD_HEADER_PX + DRAWING_PAD_PX + 100 });
    expect(point).toEqual({ x: 100, y: 200 });
  });
});

describe("rail fit", () => {
  it("measures devices as the drawing does (an SLS on a busbar is 78,75 mm)", () => {
    expect(railUsedMm({ mount: "busbar" }, [dev("sls", { te: 3 }), dev("mcb")])).toBeCloseTo(96.25, 5);
    expect(railUsedMm({ mount: "rail" }, [dev("sls", { te: 3 }), dev("mcb")])).toBeCloseTo(70, 5);
  });

  it("is over only past a 0,05 mm tolerance, rounded to 0,1 mm", () => {
    expect(railOverMm(210, 210.05)).toBe(0);
    expect(railOverMm(210, 227.5)).toBe(17.5);
    expect(railOverMm(210, 210.26)).toBe(0.3);
  });
});

describe("deviceDropAt — the band", () => {
  it("picks the band under the point and counts the rail's other devices left of it", () => {
    const index = indexFor();
    const after = deviceDropAt(index, { x: R1_X + 80, y: R1_Y }, "sls1")!;
    expect(after).toMatchObject({ moduleId: "m2", railKey: "r1", rowId: "vt1", at: 2, afterLabel: "F1.1", title: "F2 · Verteiler 1", refused: null, overMm: 0 });
    expect(after.indicatorX).toBeCloseTo(R1_X + 87.5, 5);
    const start = deviceDropAt(index, { x: R1_X + 5, y: R1_Y }, "sls1")!;
    expect(start).toMatchObject({ at: 0, afterLabel: null, indicatorX: R1_X });
  });

  it("leaves the dragged devices out of the count (same rail)", () => {
    const index = indexFor();
    expect(deviceDropAt(index, { x: R1_X + 30, y: R1_Y }, "ls1")).toMatchObject({ at: 0 });
    expect(deviceDropAt(index, { x: R1_X + 200, y: R1_Y }, "ls1")).toMatchObject({ at: 1, afterLabel: "F1" });
    expect(deviceDropAt(index, { x: R1_X + 200, y: R1_Y }, ["fi1", "ls1"])).toMatchObject({ at: 0, afterLabel: null });
  });

  it("snaps to the nearest band of the field at the smallest zoom (a band is 18 px there)", () => {
    const scene = renderScene();
    const index = indexFor(scene);
    const rect = { left: 0, top: 0 } as DOMRect;
    // 6 px under r7's band at 0.2 px/mm: 30 mm below it, still inside the field.
    const r7Bottom = R1_Y + 6 * 150 + 45;
    const client = { x: DRAWING_PAD_PX + (R1_X + 100) * 0.2, y: FIELD_HEADER_PX + DRAWING_PAD_PX + (r7Bottom + 30) * 0.2 };
    expect(deviceDropAt(index, clientToSceneMm(rect, 0.2, client), "sls1")).toMatchObject({ moduleId: "m2", railKey: "r7" });
    // Outside the cabinet and far from every band: nothing.
    expect(deviceDropAt(index, { x: -400, y: -400 }, "sls1")).toBeNull();
  });

  it("never picks another field's band, even one that reaches over the field line", () => {
    const doc = renderBoard();
    const crowded: PanelDocument = {
      ...doc,
      rows: doc.rows.map((r) => (r.id === "vt1" ? { ...r, devices: [...r.devices, ...Array.from({ length: 14 }, (_, i) => dev("mcb", { id: `x${i}` }))] } : r)),
    };
    const scene = buildEnclosureScene(crowded, INDEX, "open")!;
    const index = indexFor(scene);
    // Field 3 begins at x = 525; r1's devices run on to ≈ 628 mm.
    const drop = deviceDropAt(index, { x: 527, y: R1_Y }, "sls1")!;
    expect(drop.moduleId).toBe("m3");
    expect(deviceDropAt(index, { x: 520, y: R1_Y }, "sls1")).toMatchObject({ moduleId: "m2", railKey: "r1" });
  });
});

describe("deviceDropAt — refusals and fit", () => {
  it("refuses a reserved rail, a retired one, and every rail of a board out of cabinet order", () => {
    const reserved = new Set(["m2:r2"]);
    expect(deviceDropAt(indexFor(renderScene(), { reserved }), { x: R1_X + 10, y: R1_Y + 150 }, "sls1")).toMatchObject({ railKey: "r2", refused: "terminal_rail" });
    expect(deviceDropAt(indexFor(renderScene(), { rowsInOrder: false }), { x: R1_X + 10, y: R1_Y }, "sls1")).toMatchObject({ refused: "row_order" });

    const retired = {
      ...MODULES.ZU37KS,
      zones: MODULES.ZU37KS.zones.map((zone) => ({ ...zone, rails: zone.rails.map((rail) => (rail.key === "r1" ? { ...rail, retired: true } : rail)) })),
    };
    const scene = buildEnclosureScene(renderBoard(), catalogIndex(testCatalog({ modules: { ZU37KS: retired } })), "open")!;
    expect(deviceDropAt(indexFor(scene), { x: R1_X + 10, y: R1_Y }, "sls1")).toMatchObject({ railKey: "r1", refused: "retired" });
  });

  it("reports how far a rail would run over (a warning, not a refusal)", () => {
    const index = indexFor(renderScene(), { overMmOn: (band) => (band.railKey === "r1" ? 17.5 : 0) });
    expect(deviceDropAt(index, { x: R1_X + 10, y: R1_Y }, "sls1")).toMatchObject({ overMm: 17.5, refused: null });
  });

  it("without a measure, adds the dragged devices' drawn widths to the rail's others", () => {
    const doc = renderBoard();
    const full: PanelDocument = { ...doc, rows: doc.rows.map((r) => (r.id === "vt1" ? { ...r, devices: [...r.devices, ...Array.from({ length: 6 }, (_, i) => dev("mcb", { id: `y${i}` }))] } : r)) };
    const index = indexFor(buildEnclosureScene(full, INDEX, "open")!);
    // 70 + 7 × 17,5 = 192,5 on r1; the 3-TE HS (52,5) makes 245 → 35 over.
    expect(deviceDropAt(index, { x: R1_X + 10, y: R1_Y }, "hs1")!.overMm).toBe(35);
  });
});

describe("the drag source and the RailPicker agree on fit", () => {
  function boardWithSls() {
    const outside = board([row("alt", [dev("sls", { id: "q0", designation: "Q0", rating: "E35" })], "Altbestand")], { code: "ZB33S", modules: [] });
    const meter = placeModule(outside, INDEX, { code: "ZH3EH16", field: 0, unit: 0, claim: false });
    if (!meter.ok) throw new Error(meter.error);
    const dist = placeModule(meter.document, INDEX, { code: "ZU37KS", field: 1, unit: 0, claim: false });
    if (!dist.ok) throw new Error(dist.error);
    const filled = fillRailFromTemplate(dist.document, INDEX, dist.moduleId!, "r1", "rcd-6mcb");
    if (!filled.ok) throw new Error(filled.error);
    return filled.document;
  }

  it("uses one number per rail for the drop label and the picker's 'Zu wenig Platz'", () => {
    const doc = boardWithSls();
    const source = deviceDragSource(doc, INDEX, "q0")!;
    const scene = buildEnclosureScene(doc, INDEX, "open")!;
    const bands = railBands(scene);
    const index = buildDropIndex(scene, bands, { reserved: NONE, rowsInOrder: source.rowsInOrder, overMmOn: (band) => source.overMmOn(band.moduleId, band.railKey) });
    for (const band of bands) {
      const drop = deviceDropAt(index, { x: band.x + band.w / 2, y: band.y + band.h / 2 }, source.deviceIds) as DeviceDrop;
      expect(drop.overMm, band.label).toBe(deviceOverMm(doc, INDEX, ["q0"], band.moduleId, band.railKey));
    }
    const nar = bands.find((band) => band.railKey === "nar")!;
    const v1 = bands.find((band) => band.railKey === "r1")!;
    expect(source.overMmOn(nar.moduleId, "nar")).toBe(0);
    // FI (4 TE) + 6 LS + the 3-TE SLS on a 12-PLE rail: 227,5 mm on 210.
    expect(source.overMmOn(v1.moduleId, "r1")).toBe(17.5);
  });
});

describe("deviceDragSource", () => {
  const doc = () => renderBoard();

  it("names a device by BMK, short and rating; a head with its circuits", () => {
    const withRatings: PanelDocument = {
      ...doc(),
      rows: doc().rows.map((r) => ({ ...r, devices: r.devices.map((d) => (d.id === "ls1" ? { ...d, rating: "B16" } : d.id === "fi1" ? { ...d, rating: "40 A" } : d)) })),
    };
    expect(deviceDragSource(withRatings, INDEX, "ls1")).toMatchObject({ deviceIds: ["ls1"], name: "F1.1 LS B16", ghost: "F1.1", rowsInOrder: true });
    expect(deviceDragSource(withRatings, INDEX, "fi1")).toMatchObject({ deviceIds: ["fi1", "ls1"], name: "F1 FI 40 A mit 1 Stromkreis", ghost: "F1" });
    expect(deviceDragSource(withRatings, INDEX, "nope")).toBeNull();
  });

  it("says when the rows are out of cabinet order", () => {
    const shuffled = { ...doc(), rows: [...doc().rows].reverse() };
    expect(deviceDragSource(shuffled, INDEX, "ls1")!.rowsInOrder).toBe(false);
  });
});

describe("dropLabelText (§6.6, §13)", () => {
  const drop = (patch: Partial<DeviceDrop>): DeviceDrop => ({
    moduleId: "m2", railKey: "r3", rowId: null, at: 3, indicatorX: 0, bandBoxId: "rail:m2:r3", title: "F2 · Verteiler 3", afterLabel: "F1.3", overMm: 0, refused: null, ...patch,
  });

  it("names source, target and place, and warns when the rail runs over", () => {
    expect(dropLabelText("F1.4 LS B16", drop({}))).toBe("F1.4 LS B16 → F2 · Verteiler 3 · nach F1.3");
    expect(dropLabelText("F1.4 LS B16", drop({ at: 0, afterLabel: null }))).toBe("F1.4 LS B16 → F2 · Verteiler 3 · am Anfang");
    expect(dropLabelText("F1.4 LS B16", drop({ overMm: 17.5 }))).toBe("F1.4 LS B16 → F2 · Verteiler 3 · nach F1.3 · zu voll: 17,5 mm über");
    expect(dropLabelText("F1.4 LS B16", null)).toBe("F1.4 LS B16");
  });

  it("says why a rail refuses", () => {
    expect(dropLabelText("F1.4 LS B16", drop({ refused: "terminal_rail" }))).toBe("F1.4 LS B16 → F2 · Verteiler 3 · Reihenklemmen-Schiene — hier keine Geräte");
    expect(dropLabelText("F1.4 LS B16", drop({ refused: "retired" }))).toBe("F1.4 LS B16 → F2 · Verteiler 3 · ausgemustert");
    expect(dropLabelText("F1.4 LS B16", drop({ refused: "row_order" }))).toBe("F1.4 LS B16 → F2 · Verteiler 3 · Reihen nicht in Schrankreihenfolge — erst „Reihen ordnen“");
  });
});

// ── Strips (§6.3: stripDropAt, R11) ──────────────────────────────────────────

describe("stripDropAt — whole strips on the field's two terminal rails", () => {
  /** Feld 1 (ZU37KS "mod-a"): four FI + 8 LS groups on r3–r6 → X1–X3 on r1 (184,1 mm), X4 on r2. Feld 2: F5 + 8 LS on r3. */
  function stripBoard(): PanelDocument {
    const group = (g: number) => [fi(`dev-f${g}`, `F${g}`), ...lsRun(`f${g}`, `F${g}`, range(1, 9), 1 + (g - 1) * 8)];
    return doc("ZB33S", [
      mod("mod-a", "ZU37KS", 0, { r3: "row-a3", r4: "row-a4", r5: "row-a5", r6: "row-a6" }),
      mod("mod-b", "ZU37KS", 1, { r3: "row-b3" }),
    ], [
      ...[1, 2, 3, 4].map((g) => terminalRow(`row-a${g + 2}`, `F1 · Verteiler ${g + 2}`, group(g))),
      terminalRow("row-b3", "F2 · Verteiler 3", group(5)),
    ]);
  }
  const stripDoc = stripBoard();
  const placement = placeTerminals(stripDoc, INDEX);
  const scene = buildEnclosureScene(stripDoc, INDEX, "open", placement)!;
  const reserved = terminalRailKeys(stripDoc, INDEX);
  const index = buildDropIndex(scene, railBands(scene, reserved), { reserved, rowsInOrder: true });
  const railBox = (moduleId: string, railKey: string) => scene.boxes.find((box) => box.id === `rail:${moduleId}:${railKey}`)!;
  const stripBox = (stripId: string) => scene.boxes.find((box) => box.id === `terminal:${stripId}`)!;
  const at = (moduleId: string, railKey: string, x: number) => ({ x: railBox(moduleId, railKey).x + x, y: railBox(moduleId, railKey).y + railBox(moduleId, railKey).h / 2 });
  const measure = (stripId: string) => (rail: 0 | 1, slot: number) => stripMoveOverMm(stripDoc, INDEX, stripId, { field: 0, rail, at: slot });

  it("counts the rail's other strips left of the finger and puts the bar after the one before", () => {
    const x2 = stripBox("dev-f2:leiste");
    const drop = stripDropAt(index, placement, { x: x2.x + x2.w * 0.75, y: x2.y + x2.h / 2 }, "dev-f4:leiste", measure("dev-f4:leiste"));
    expect(drop).toMatchObject({ field: 0, rail: 0, moduleId: "mod-a", railKey: "r1", at: 2, bandBoxId: "rail:mod-a:r1" });
    expect(drop!.indicatorX).toBeCloseTo(x2.x + x2.w, 6);
    // X1–X3 and X4 do not fit rail 1 together: refused with the op's own number.
    expect(drop!.overMm).toBe(35.2);
    expect(drop!.refused).toBe("too_full");
  });

  it("takes a strip onto the other terminal rail of its field when it fits", () => {
    const drop = stripDropAt(index, placement, at("mod-a", "r2", 1), "dev-f1:leiste", measure("dev-f1:leiste"));
    expect(drop).toMatchObject({ rail: 1, railKey: "r2", at: 0, overMm: 0, refused: null });
    expect(drop!.indicatorX).toBeCloseTo(railBox("mod-a", "r2").x, 6);
  });

  it("refuses a rail that is no terminal rail and another field's terminal rail", () => {
    expect(stripDropAt(index, placement, at("mod-a", "r4", 20), "dev-f1:leiste")!.refused).toBe("not_terminal_rail");
    expect(stripDropAt(index, placement, at("mod-b", "r1", 20), "dev-f1:leiste")).toMatchObject({ field: 1, refused: "other_field" });
  });

  it("without a measure, adds the strip to the rail's others as placed", () => {
    expect(stripDropAt(index, placement, at("mod-a", "r1", 190), "dev-f4:leiste")!.refused).toBe("too_full");
    expect(stripDropAt(index, placement, at("mod-a", "r2", 100), "dev-f3:leiste")!.refused).toBeNull();
  });

  it("labels the drop: rail and place, or why not (§13)", () => {
    const drop = stripDropAt(index, placement, at("mod-a", "r2", 1), "dev-f1:leiste", measure("dev-f1:leiste"));
    expect(stripLabelText("X1", 0, drop)).toBe("X1 → Hutschiene 2 · Platz 1");
    expect(stripLabelText("X1", 0, { ...drop!, refused: "other_field" })).toBe("X1 → F1 · Verteiler 2 · Klemmen gehören zu Feld 1");
    expect(stripLabelText("X1", 0, { ...drop!, refused: "not_terminal_rail" })).toBe("X1 → F1 · Verteiler 2 · keine Klemmen-Hutschiene");
    expect(stripLabelText("X1", 0, { ...drop!, refused: "too_full", overMm: 35.2 })).toBe("X1 → Hutschiene 2 · passt nicht: 35,2 mm zu viel");
    expect(stripLabelText("X1", 0, null)).toBe("X1");
  });
});
