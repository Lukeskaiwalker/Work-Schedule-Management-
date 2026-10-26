/**
 * The cabinet as boxes (docs/PANEL_ENCLOSURE.md §4, §14 "enclosureGeometry").
 * Direct cases on the test catalogue; the parity fixture pins every number
 * against the Python twin in `enclosureParity.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { buildEnclosureScene, round1 } from "../utils/enclosureGeometry";
import { DERIVE, defaultControlBlock, placeControlBlock } from "../utils/enclosureControlBlock";
import { placeTerminals } from "../utils/enclosureTerminals";
import type { EnclosureModule, SceneBox } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { BOARD_NAMES, FIXTURE_BOARDS, FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import { board, dev, INDEX, row } from "./enclosureTestCatalog";

// A hand-made module: no fitting snapshot, so the derivations read the catalogue.
const mod = (id: string, code: string, field: number, unit: number, rails: Record<string, string> = {}, extra: Partial<EnclosureModule> = {}): EnclosureModule => ({
  id, code, field, unit, label: "", rails, fittings: null, removed_fittings: [], meters: [], ...extra,
});

function sceneBoard() {
  const sls = dev("sls", { designation: "Q0" });
  const hs = dev("hauptschalter", { designation: "Q1", supplied_by: { module: "m", part: "hs" } });
  const lsRow = Array.from({ length: 13 }, (_, i) => dev("mcb", { designation: `F1.${i + 1}` }));
  const doc = board(
    [row("nar", [sls]), row("aar1", [hs], "  "), row("vt", lsRow, "Küche"), row("own", [dev("mcb")])],
    {
      code: "ZB33S",
      modules: [
        mod("m", "ZH3EH16", 0, 0, { nar: "nar", aar1: "aar1" }, { meters: [{ place: 0, number: "1EBZ0100000003", label: "" }] }),
        mod("d", "ZU37KS", 1, 0, { r1: "vt" }),
        mod("p", "ZH3EL22", 2, 0, {}, { meters: [{ place: 1, number: "", label: "" }] }),
        mod("x", "ZZ404", 2, 0),
      ],
    },
  );
  return { doc, sls, hs, lsRow };
}

const byId = (boxes: SceneBox[]) => new Map(boxes.map((box) => [box.id, box]));

describe("parity with the Python twin (enclosureFixtures.json)", () => {
  it.each(BOARD_NAMES)("%s: the open view, box for box", (name) => {
    const fixture = FIXTURE_BOARDS[name];
    expect(buildEnclosureScene(fixture.document, FIXTURE_INDEX, "open")).toEqual(fixture.scene_open);
  });

  it.each(BOARD_NAMES)("%s: the closed view, box for box", (name) => {
    const fixture = FIXTURE_BOARDS[name];
    expect(buildEnclosureScene(fixture.document, FIXTURE_INDEX, "closed")).toEqual(fixture.scene_closed);
  });
});

describe("round1", () => {
  it("rounds half up on the tenth, like the Python twin", () => {
    expect(round1(78.75)).toBe(78.8);
    expect(round1(0.05)).toBe(0.1);
    expect(round1(-0.05)).toBe(0);
    expect(round1(12.34)).toBe(12.3);
  });
});

describe("buildEnclosureScene", () => {
  it("is null without a cabinet or with an unknown cabinet code", () => {
    expect(buildEnclosureScene(board([]), INDEX, "open")).toBeNull();
    expect(buildEnclosureScene(board([], { code: "ZB99", modules: [] }), INDEX, "open")).toBeNull();
  });

  it("draws the shell, the fields and the modules at the 150 mm raster", () => {
    const scene = buildEnclosureScene(sceneBoard().doc, INDEX, "open")!;
    expect(scene).toMatchObject({ width: 800, height: 1100, depth: 205, view: "open" });
    const boxes = byId(scene.boxes);
    expect(boxes.get("shell")).toMatchObject({ x: 0, y: 0, z: 0, w: 800, h: 1100, d: 205 });
    expect(scene.boxes.filter((box) => box.kind === "field").map((box) => [box.x, box.label])).toEqual([
      [25, "Feld 1"],
      [275, "Feld 2"],
      [525, "Feld 3"],
    ]);
    expect(boxes.get("module:m")).toMatchObject({ x: 25, y: 25, w: 250, h: 1050, label: "ZH3EH16", flags: ["unverified"] });
    expect(boxes.get("module:x")).toMatchObject({ w: 250, h: 150, label: "ZZ404", flags: ["unknown_code"] });
    expect(boxes.get("zone:m:nar")).toMatchObject({ y: 25 + 5 * 150, h: 300, label: "NAR", zoneType: "NAR" });
  });

  it("puts rails at ple × 17.5 mm, devices contiguous, busbar SLS 78.75 mm, overflow flagged", () => {
    const { doc, sls, hs, lsRow } = sceneBoard();
    const boxes = byId(buildEnclosureScene(doc, INDEX, "open")!.boxes);
    const busbar = boxes.get("rail:m:nar")!;
    expect(busbar).toMatchObject({ kind: "busbar", x: 45, w: 210, h: 60, rowId: "nar", label: "nar" });
    expect(boxes.get(`device:${sls.id}`)).toMatchObject({ x: 45, w: 78.8, h: 90, label: "Q0", flags: [] });
    // A blank row label falls back to the generated one; the supplied HS is flagged.
    expect(boxes.get("rail:m:aar1")).toMatchObject({ label: "F1 · AAR 1", w: 210, h: 35 });
    expect(boxes.get(`device:${hs.id}`)!.flags).toEqual(["supplied"]);
    expect(boxes.get("rail:m:aar2")).toMatchObject({ rowId: null, label: "F1 · AAR 2" });
    const tiles = lsRow.map((device) => boxes.get(`device:${device.id}`)!);
    tiles.slice(1).forEach((tile, i) => expect(tile.x).toBe(round1(tiles[i].x + 17.5)));
    expect(tiles[11].flags).toEqual([]);
    expect(tiles[12].flags).toEqual(["overflow"]);
    // Rows outside the cabinet draw nothing.
    expect([...boxes.values()].filter((box) => box.kind === "device")).toHaveLength(15);
  });

  it("draws meter places: occupied with the number, free as 'frei'", () => {
    const boxes = byId(buildEnclosureScene(sceneBoard().doc, INDEX, "open")!.boxes);
    expect(boxes.get("meter:m:0")).toMatchObject({ kind: "meter", label: "1EBZ0100000003", w: 110, h: 210, x: 95, y: 25 + 450 + 45 });
    expect(boxes.get("meter:p:0")).toMatchObject({ kind: "meter_place", label: "frei", flags: ["free"] });
    expect(boxes.get("meter:p:1")).toMatchObject({ kind: "meter", label: "Zähler", x: 525 + 125 + 7.5 });
  });

  it("closes the cabinet: covers, slots, fronts, windows, blind plates, doors and handles", () => {
    const { doc, sls } = sceneBoard();
    const scene = buildEnclosureScene(doc, INDEX, "closed")!;
    const boxes = byId(scene.boxes);
    expect(scene.boxes.some((box) => box.kind === "device")).toBe(false);
    expect(boxes.get("cover:m:nar")).toMatchObject({ x: 27, y: 25 + 750 + 2, w: 246, h: 296, flags: ["sealable"] });
    expect(boxes.get("slot:m:nar")).toMatchObject({ x: 45, w: 210, h: 46 });
    expect(boxes.get(`front:${sls.id}`)).toMatchObject({ kind: "device_front", h: 45, label: "Q0" });
    expect(boxes.get("window:m:0")).toBeDefined();
    expect(boxes.get("mfront:m:0")).toMatchObject({ label: "1EBZ0100000003" });
    expect(boxes.get("blind:p:0")).toMatchObject({ label: "Blindabdeckung", flags: ["free"] });
    expect(scene.boxes.filter((box) => box.kind === "door").map((box) => [box.x, box.w, box.z])).toEqual([
      [0, 400, 205],
      [400, 400, 205],
    ]);
    expect(scene.boxes.filter((box) => box.kind === "handle").map((box) => box.x)).toEqual([370, 415]);
  });

  it("hangs a one-leaf door's handle on the right and sorts by (z, y, x, id)", () => {
    const scene = buildEnclosureScene(board([], { code: "ZB32S", modules: [] }), INDEX, "open")!;
    expect(scene.boxes.find((box) => box.kind === "handle")).toMatchObject({ x: 520, y: 490, w: 15, h: 120, z: 207 });
    const keys = scene.boxes.map((box) => [box.z, box.y, box.x, box.id] as const);
    const sorted = [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : 1));
    expect(keys).toEqual(sorted);
  });

  it("draws a retired rail only while its row still holds devices", () => {
    const base = board([row("r", [dev("mcb")])], { code: "ZB33S", modules: [mod("d", "ZU37KS", 0, 0, { r1: "r" })] });
    const retiredIndex = INDEX;
    const spec = retiredIndex.module("ZU37KS")!;
    const retiredCatalog = {
      enclosure: retiredIndex.enclosure,
      entry: retiredIndex.entry,
      module: (code: string) =>
        code === "ZU37KS" ? { ...spec, zones: [{ ...spec.zones[0], rails: spec.zones[0].rails.map((rail) => ({ ...rail, retired: true })) }] } : retiredIndex.module(code),
    };
    const boxes = buildEnclosureScene(base, retiredCatalog, "open")!.boxes.filter((box) => box.kind === "rail");
    expect(boxes.map((box) => [box.id, box.flags])).toEqual([["rail:d:r1", ["retired"]]]);
  });
});

// ── WAGO terminal strips (docs/PANEL_ENCLOSURE_R2.md §8) ─────────────────────

describe("terminal strips", () => {
  const boxesOf = (document: PanelDocument, view: "open" | "closed", kind?: SceneBox["kind"]) =>
    byId(buildEnclosureScene(document, FIXTURE_INDEX, view)!.boxes.filter((box) => !kind || box.kind === kind));

  it("draws each placed strip as one box on its terminal rail in the open view", () => {
    const boxes = boxesOf(boardDocument("meter_dist_zb33s"), "open");
    const rail = boxes.get("rail:mod-v:r1")!;
    const strip = boxes.get("terminal:dev-f1:leiste")!;
    // x from the rail's left end; 96 × 42.3 mm is the 2003-7641 body, a drawing approximation.
    expect(strip).toMatchObject({ kind: "terminal_strip", x: rail.x, y: round1(rail.y + 17.5 - 48), z: 47.5, w: 30.7, h: 96, d: 42.3, label: "X1" });
    expect([strip.moduleId, strip.railKey, strip.rowId, strip.deviceId, strip.zoneType, strip.flags]).toEqual(["mod-v", "r1", null, null, "VT", []]);
    expect([...boxes.values()].filter((box) => box.kind === "terminal_strip").map((box) => box.id).sort()).toEqual([
      "terminal:dev-f1:leiste", "terminal:dev-f3:leiste",
    ]);
  });

  it("marks the reserved rails in both views and draws no strip behind the cover", () => {
    const document = boardDocument("meter_dist_zb33s");
    for (const view of ["open", "closed"] as const) {
      const rails = boxesOf(document, view, "rail");
      expect(rails.get("rail:mod-v:r1")!.flags).toEqual(["terminals"]);
      expect(rails.get("rail:mod-v:r2")!.flags).toEqual(["terminals"]);
      expect(rails.get("rail:mod-v:r3")!.flags).toEqual([]);
      expect(rails.get("rail:mod-z:aar1")!.flags).toEqual([]);
    }
    expect(boxesOf(document, "closed", "terminal_strip").size).toBe(0);
  });

  it("puts strips after the devices left on a reserved rail and does not draw the placeholders", () => {
    const document = boardDocument("terminals_zb34s");
    for (const view of ["open", "closed"] as const) {
      const ids = boxesOf(document, view);
      expect(ids.has("device:dev-pl1") || ids.has("front:dev-pl1")).toBe(false);
    }
    const boxes = boxesOf(document, "open");
    const rail = boxes.get("rail:mod-k:r2")!;
    expect(boxes.get("device:dev-f1-7")!.x).toBe(round1(rail.x + 35));
    expect(boxes.get("terminal:dev-f2:leiste")!.x).toBe(round1(rail.x + 52.5));
    expect(boxes.get("terminal:dev-f3:leiste")!.w).toBe(61.9); // the end plate sits inside X3, before its 2009-305
    expect(boxes.has("terminal:dev-f4:leiste")).toBe(false); // unplaced strips get no box
  });

  it("draws a placeholder that is not on a terminal rail as before", () => {
    const document = boardDocument("terminals_zb34s");
    const k3 = document.rows.find((candidate) => candidate.id === "row-k3")!;
    k3.devices = [...k3.devices, { ...k3.devices[1], id: "dev-pl9", kind: "terminal" }];
    expect(boxesOf(document, "open").has("device:dev-pl9")).toBe(true);
  });

  it("gives the same scene with a precomputed placement", () => {
    const document = boardDocument("tall_zb54s");
    const placement = placeTerminals(document, FIXTURE_INDEX);
    for (const view of ["open", "closed"] as const) {
      expect(buildEnclosureScene(document, FIXTURE_INDEX, view, placement)).toEqual(buildEnclosureScene(document, FIXTURE_INDEX, view));
    }
  });

  it("draws what the passed placement says", () => {
    const document = boardDocument("meter_dist_zb33s");
    const placement = placeTerminals(document, FIXTURE_INDEX);
    const without = { ...placement, fields: [] };
    const boxes = byId(buildEnclosureScene(document, FIXTURE_INDEX, "open", without)!.boxes);
    expect([...boxes.values()].some((box) => box.kind === "terminal_strip")).toBe(false);
    expect(boxes.get("rail:mod-v:r1")!.flags).toEqual([]);
  });
});

// ── The §14a block (docs/PANEL_ENCLOSURE_R4.md §5) ───────────────────────────

describe("the §14a block box", () => {
  const blockBoxes = (document: PanelDocument, view: "open" | "closed", block: Parameters<typeof buildEnclosureScene>[4] = DERIVE) =>
    buildEnclosureScene(document, FIXTURE_INDEX, view, undefined, block)!.boxes.filter((box) => box.kind === "control_block");

  it("is one box on the carrier rail in the open view, none in the closed view", () => {
    const document = boardDocument("control_ehz_zb33s");
    const placed = placeControlBlock(document, FIXTURE_INDEX)!;
    expect(blockBoxes(document, "open")).toEqual([{
      id: "control:block", kind: "control_block",
      x: round1(placed.railX + placed.offsetMm), y: round1(placed.railY - 48), z: 47.5,
      w: placed.widthMm, h: 96, d: 42.3, label: "§14a",
      moduleId: "mod-a", railKey: "aar1", rowId: "row-a-aar1", deviceId: null, zoneType: "AAR", flags: [],
    }]);
    expect(blockBoxes(document, "closed")).toEqual([]);
  });

  it("follows a given block and none for null", () => {
    const document = boardDocument("meter_dist_zb33s");
    expect(blockBoxes(document, "open")).toEqual([]);
    expect(blockBoxes(document, "open", defaultControlBlock())).toHaveLength(1);
    expect(blockBoxes(boardDocument("control_ehz_zb33s"), "open", null)).toEqual([]);
  });

  it("is flagged when it overflows", () => {
    const document = boardDocument("control_ehz_zb33s");
    const aar1 = document.rows.find((candidate) => candidate.id === "row-a-aar1")!;
    aar1.devices = Array.from({ length: 12 }, (_, i) => ({ ...aar1.devices[0], id: `dev-full-${i}`, kind: "mcb", te: 1, width_mm: null }));
    const block = { ...defaultControlBlock(), rail: "aar1" };
    expect(blockBoxes(document, "open", block)[0]).toMatchObject({ x: 255, flags: ["overflow"] });
  });
});
