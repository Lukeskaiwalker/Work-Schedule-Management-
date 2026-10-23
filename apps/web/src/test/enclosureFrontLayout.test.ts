/**
 * The pure half of the 2D cabinet drawing (docs/PANEL_ENCLOSURE.md §4, §11):
 * zoom steps and the initial fit, the label rule (horizontal → rotated 90°
 * → hidden below 9 CSS px), the free units a tap places a module at, and the
 * rail bands the one tap rule routes to RailSheet. The component test
 * (`enclosureFrontSvg.test.tsx`) proves the drawing uses them.
 */
import { describe, expect, it } from "vitest";

import {
  DRAWING_PAD_PX,
  ENCLOSURE_ZOOM_STEPS,
  FIELD_HEADER_PX,
  MIN_LABEL_BOX_PX,
  clampZoomStep,
  drawingSizePx,
  fieldIndexAt,
  fitBoxLabel,
  fitLineLabel,
  freeCells,
  gapRuns,
  initialZoomStep,
  railBands,
  scrollForZoom,
} from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { renderScene } from "./enclosureRenderBoard";
import { board, INDEX } from "./enclosureTestCatalog";
import { buildEnclosureScene } from "../utils/enclosureGeometry";

describe("zoom steps", () => {
  it("are the stepped px/mm of the contract, smallest first", () => {
    expect([...ENCLOSURE_ZOOM_STEPS]).toEqual([0.2, 0.3, 0.45, 0.65, 0.9, 1.3]);
  });

  it("start on the largest step whose drawing fits the available width", () => {
    // ZB33S, 800 mm: 0.9 → 728 px fits 1000 px, 1.3 → 1048 px does not.
    expect(initialZoomStep(800, 1000)).toBe(4);
    // ZB55S, 1300 mm: 0.65 → 853 px fits, 0.9 → 1178 px does not.
    expect(initialZoomStep(1300, 1000)).toBe(3);
    expect(initialZoomStep(800, 2000)).toBe(ENCLOSURE_ZOOM_STEPS.length - 1);
  });

  it("fall back to the smallest step when nothing fits or nothing was measured", () => {
    expect(initialZoomStep(1300, 100)).toBe(0);
    expect(initialZoomStep(1300, 0)).toBe(0);
    expect(initialZoomStep(Number.NaN, 900)).toBe(0);
  });

  it("clamp a step to the list", () => {
    expect(clampZoomStep(-3)).toBe(0);
    expect(clampZoomStep(99)).toBe(ENCLOSURE_ZOOM_STEPS.length - 1);
    expect(clampZoomStep(2.6)).toBe(2);
    expect(clampZoomStep(Number.NaN)).toBe(0);
  });

  it("size the drawing as cabinet × zoom plus the field header and the padding", () => {
    expect(drawingSizePx({ width: 800, height: 1100 }, 0.5)).toEqual({
      width: 400 + 2 * DRAWING_PAD_PX,
      height: 550 + FIELD_HEADER_PX + 2 * DRAWING_PAD_PX,
    });
  });

  it("keep the visible centre when the zoom changes", () => {
    expect(scrollForZoom(0.5, 2000, 600)).toBe(700);
    expect(scrollForZoom(0.1, 2000, 600)).toBe(0);
    expect(scrollForZoom(Number.NaN, 2000, 600)).toBe(0);
  });
});

describe("fitBoxLabel (devices and meters)", () => {
  it("hides the label of a box narrower than 9 CSS px", () => {
    expect(MIN_LABEL_BOX_PX).toBe(9);
    expect(fitBoxLabel("F1.1", 3.5, 18, 10).mode).toBe("hidden");
    expect(fitBoxLabel("F1.1", 8.9, 117, 10).mode).toBe("hidden");
  });

  it("writes it across when it fits", () => {
    expect(fitBoxLabel("F1", 31.5, 40.5, 10)).toEqual({ mode: "horizontal", text: "F1", fontPx: 10 });
  });

  it("rotates it 90° inside the box when it does not fit across", () => {
    expect(fitBoxLabel("F1.12", 22.75, 117, 10)).toEqual({ mode: "rotated", text: "F1.12", fontPx: 10 });
  });

  it("shrinks the rotated font to the box width, never below 7 px", () => {
    expect(fitBoxLabel("Q1", 9, 117, 10)).toEqual({ mode: "rotated", text: "Q1", fontPx: 7 });
  });

  it("cuts a long rotated label with an ellipsis, and hides it when two letters do not fit", () => {
    const cut = fitBoxLabel("Wallbox Garage", 20, 60, 10);
    expect(cut.mode).toBe("rotated");
    expect(cut.text.endsWith("…")).toBe(true);
    expect(Array.from(cut.text).length).toBeLessThanOrEqual(9);
    expect(fitBoxLabel("Wallbox Garage", 14, 18, 10).mode).toBe("hidden");
  });

  it("keeps a wide, low box horizontal and cuts it instead of rotating", () => {
    const label = fitBoxLabel("1EBZ0100000003", 40, 30, 10);
    expect(label.mode).toBe("horizontal");
    expect(label.text.endsWith("…")).toBe(true);
  });

  it("has nothing to draw for an empty label", () => {
    expect(fitBoxLabel("  ", 200, 200, 10).mode).toBe("hidden");
  });
});

describe("fitLineLabel (rails, zones, gaps)", () => {
  it("writes across, cut to the width, or hides when the line is too low", () => {
    expect(fitLineLabel("F2 · Verteiler 1", 200, 20, 10)).toEqual({ mode: "horizontal", text: "F2 · Verteiler 1", fontPx: 10 });
    expect(fitLineLabel("F2 · Verteiler 1", 40, 20, 10).text.endsWith("…")).toBe(true);
    expect(fitLineLabel("F2 · Verteiler 1", 200, 8, 10).mode).toBe("hidden");
    expect(fitLineLabel("F2 · Verteiler 1", 12, 20, 10).mode).toBe("hidden");
  });
});

describe("freeCells / gapRuns", () => {
  it("lists every 150 mm unit no module covers, per field", () => {
    const cells = freeCells(renderScene());
    expect(cells.filter((cell) => cell.field < 3)).toEqual([]);
    expect(cells.filter((cell) => cell.field === 3).map((cell) => cell.unit)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cells.filter((cell) => cell.field === 4).map((cell) => cell.unit)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const cell = cells.find((entry) => entry.field === 3 && entry.unit === 4)!;
    expect(cell).toMatchObject({ x: 25 + 3 * 250, y: 25 + 4 * 150, w: 250, h: 150 });
  });

  it("joins neighbouring free units into one gap per stretch", () => {
    expect(gapRuns(freeCells(renderScene()))).toEqual([
      { field: 3, unit: 1, units: 6, x: 775, y: 175, w: 250, h: 900 },
      { field: 4, unit: 0, units: 7, x: 1025, y: 25, w: 250, h: 1050 },
    ]);
  });

  it("reads the raster it is given", () => {
    const scene = buildEnclosureScene(board([], { code: "ZB32S", modules: [] }), INDEX, "open")!;
    expect(freeCells(scene, 350).filter((cell) => cell.field === 0)).toHaveLength(3);
  });
});

describe("railBands", () => {
  it("is the rail ± half a device height, across the rail and every device on it", () => {
    const bands = railBands(renderScene());
    const vt = bands.find((band) => band.moduleId === "m2" && band.railKey === "r1")!;
    expect(vt).toMatchObject({ rowId: "vt1", label: "F2 · Verteiler 1", deviceCount: 2, y: 55, h: 90 });
    expect(vt.x).toBeLessThan(275 + 20);
    expect(vt.x + vt.w).toBeGreaterThan(275 + 20 + 210);
  });

  it("covers busbars and empty rails without a row", () => {
    const bands = railBands(renderScene());
    expect(bands.find((band) => band.moduleId === "m1" && band.railKey === "nar")).toMatchObject({ label: "F1 · NAR", deviceCount: 1 });
    expect(bands.find((band) => band.moduleId === "m2" && band.railKey === "r2")).toMatchObject({ rowId: null, deviceCount: 0 });
  });

  it("knows its field, whether its rail is retired, and whether it is reserved for terminals (R2 §6.3)", () => {
    const bands = railBands(renderScene(), new Set(["m2:r2"]));
    expect(bands.find((band) => band.moduleId === "m1" && band.railKey === "nar")).toMatchObject({ field: 0, retired: false, reserved: false });
    expect(bands.find((band) => band.moduleId === "m2" && band.railKey === "r1")).toMatchObject({ field: 1, reserved: false });
    expect(bands.find((band) => band.moduleId === "m2" && band.railKey === "r2")).toMatchObject({ field: 1, reserved: true });
    expect(bands.find((band) => band.moduleId === "m3" && band.railKey === "aar1")).toMatchObject({ field: 2 });
    // Without a reserved set (until W3 passes the terminal rails), nothing is reserved.
    expect(railBands(renderScene()).every((band) => !band.reserved)).toBe(true);
  });

  it("exists in the closed view too, so the same tap does the same thing", () => {
    const closed = railBands(renderScene("closed"));
    expect(closed.find((band) => band.moduleId === "m2" && band.railKey === "r1")).toMatchObject({ deviceCount: 2, y: 55, h: 90 });
  });
});

describe("fieldIndexAt", () => {
  it("names the field a cabinet x lies in", () => {
    const scene = renderScene();
    expect(fieldIndexAt(scene, 25)).toBe(0);
    expect(fieldIndexAt(scene, 25 + 2 * 250 + 10)).toBe(2);
    expect(fieldIndexAt(scene, 5)).toBeNull();
  });
});
