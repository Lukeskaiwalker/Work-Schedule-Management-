/**
 * The admin's live preview (docs/PANEL_ENCLOSURE.md §9 Slice F, §4): the
 * entry being typed is drawn by the same geometry every board uses, in a
 * dummy cabinet just big enough for it — so a stack that does not add up,
 * a rail outside its zone or a pre-fitted part on the wrong rail is visible
 * before anything is saved. A module gets a one-field cabinet (as many
 * fields as it is wide); a cabinet is drawn empty.
 */
import { describe, expect, it } from "vitest";

import { PREVIEW_MODULE_ID, previewScene, previewZoomStep } from "../components/schaltplan/enclosure/catalogEntryPreview";
import { ENCLOSURE_ZOOM_STEPS } from "../components/schaltplan/enclosure/enclosureFrontLayout";
import { CABINETS, MODULES } from "./enclosureTestCatalog";
import type { SceneBox } from "../types/panelEnclosure";

function scene(entryType: "enclosure" | "module", spec: object) {
  const result = previewScene(entryType, spec as Record<string, unknown>);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

const kinds = (boxes: SceneBox[], kind: string) => boxes.filter((box) => box.kind === kind);

describe("previewScene", () => {
  it("draws a meter module in a one-field cabinet of its height, with its pre-fitted devices and meter place", () => {
    const { scene: drawn, unitMm } = scene("module", MODULES.ZH3EH16);
    expect(unitMm).toBe(150);
    expect(drawn.view).toBe("open");
    expect(drawn.width).toBe(300); // 2 × 25 margin + 1 × 250
    expect(drawn.height).toBe(1100); // 2 × 25 + 7 × 150
    expect(kinds(drawn.boxes, "field")).toHaveLength(1);
    const module = kinds(drawn.boxes, "module");
    expect(module).toHaveLength(1);
    expect(module[0].moduleId).toBe(PREVIEW_MODULE_ID);
    expect(module[0].flags).toContain("unverified");
    // Busbar NAR, aar1, aar2, rfz: every rail drawn.
    expect(kinds(drawn.boxes, "rail").length + kinds(drawn.boxes, "busbar").length).toBe(4);
    // hs and hlak are device fittings: drawn on their rails as supplied.
    const devices = kinds(drawn.boxes, "device");
    expect(devices).toHaveLength(2);
    expect(devices.every((box) => box.flags.includes("supplied"))).toBe(true);
    expect(devices.map((box) => box.railKey).sort()).toEqual(["aar1", "aar2"]);
    expect(kinds(drawn.boxes, "meter")).toHaveLength(1);
  });

  it("a module three fields wide gets three fields", () => {
    const wide = { ...MODULES.ZU37KS, width_fields: 3 };
    const drawn = scene("module", wide).scene;
    expect(drawn.width).toBe(800);
    expect(kinds(drawn.boxes, "field")).toHaveLength(3);
  });

  it("a one-unit module gets a one-unit cabinet", () => {
    const drawn = scene("module", MODULES.ZU62A).scene;
    expect(drawn.height).toBe(200);
  });

  it("draws a cabinet empty, with its fields", () => {
    const drawn = scene("enclosure", CABINETS.ZB33S).scene;
    expect(drawn.width).toBe(CABINETS.ZB33S.width_mm);
    expect(drawn.height).toBe(CABINETS.ZB33S.height_mm);
    expect(kinds(drawn.boxes, "field")).toHaveLength(3);
    expect(kinds(drawn.boxes, "module")).toHaveLength(0);
  });

  it("a device fitting naming a rail the module lacks draws nothing for it and does not throw", () => {
    const broken = {
      ...MODULES.ZH3EH16,
      fittings: MODULES.ZH3EH16.fittings.map((fitting) => (fitting.device ? { ...fitting, device: { ...fitting.device, rail: "gibtsnicht" } } : fitting)),
    };
    expect(kinds(scene("module", broken).scene.boxes, "device")).toHaveLength(0);
  });

  it("says why it cannot draw sizes outside the catalogue's range", () => {
    expect(previewScene("module", { ...MODULES.ZU37KS, width_fields: 12 })).toEqual({ ok: false, reason: expect.stringContaining("Breite") });
    expect(previewScene("module", { ...MODULES.ZU37KS, height_units: 0 })).toEqual({ ok: false, reason: expect.stringContaining("Höhe") });
    expect(previewScene("enclosure", { ...CABINETS.ZB33S, fields: 40 })).toEqual({ ok: false, reason: expect.stringContaining("Felder") });
    expect(previewScene("enclosure", { ...CABINETS.ZB33S, units_per_field: 500 })).toEqual({ ok: false, reason: expect.stringContaining("Raster") });
  });

  it("the preview zoom fits width AND height, so a tall module shows whole", () => {
    const tall = scene("module", MODULES.ZH3EH16).scene; // 300 × 1100 mm
    // Width alone would allow 1.3 px/mm (394 px); 1100 mm must fit into 520 px: 0.45 (≈ 527 px with header) is too tall, 0.3 fits.
    expect(ENCLOSURE_ZOOM_STEPS[previewZoomStep(tall, 600, 520)]).toBe(0.3);
    expect(ENCLOSURE_ZOOM_STEPS[previewZoomStep(tall, 600, 2000)]).toBe(1.3);
    // Nothing fits: the smallest step, never an error.
    expect(previewZoomStep(tall, 10, 10)).toBe(0);
    expect(previewZoomStep(tall, 0, 0)).toBe(0);
  });

  it("garbage in the Aufbau never throws", () => {
    for (const spec of [{}, { zones: "x" }, { zones: [null, 3, { rails: "y" }] }, { fittings: [{ device: { kind: "nope", rail: 5 } }] }]) {
      expect(() => previewScene("module", spec as Record<string, unknown>)).not.toThrow();
    }
    expect(() => previewScene("enclosure", { fields: "drei" })).not.toThrow();
  });
});
