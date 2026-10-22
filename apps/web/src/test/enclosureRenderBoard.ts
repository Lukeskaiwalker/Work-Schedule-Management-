/**
 * One invented cabinet board for the 2D renderer tests (EnclosureFrontSvg,
 * its layout helpers, the field bar). ZB35S, five fields:
 *
 *   Feld 1  ZH3EH16  — SLS on the NAR, the pre-fitted HS on AAR 1, meter 0 numbered
 *   Feld 2  ZU37KS   — rail r1: FI F1 (4 TE) + LS F1.1 (1 TE); r2 … r7 empty, no rows
 *   Feld 3  ZH3EL22  — place 0 numbered, place 1 frei (blind plate)
 *   Feld 4  ZU62A    — one cover unit at the top, units 1 … 6 free
 *   Feld 5  empty
 *
 * The repo is public: every number and name here is made up.
 */
import { buildEnclosureScene } from "../utils/enclosureGeometry";
import type { EnclosureModule, EnclosureScene, SceneView } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { board, dev, INDEX, row } from "./enclosureTestCatalog";

export const METER_A = "1EBZ0100000003";
export const METER_B = "1EBZ0100000004";

const mod = (id: string, code: string, field: number, unit: number, rails: Record<string, string> = {}, extra: Partial<EnclosureModule> = {}): EnclosureModule => ({
  id, code, field, unit, label: "", rails, fittings: null, removed_fittings: [], meters: [], ...extra,
});

export function renderBoard(): PanelDocument {
  return board(
    [
      row("nar", [dev("sls", { id: "sls1", designation: "Q0" })], "F1 · NAR"),
      row("aar1", [dev("hauptschalter", { id: "hs1", designation: "Q1", supplied_by: { module: "m1", part: "hs" } })], "F1 · AAR 1"),
      row("vt1", [dev("rcd", { id: "fi1", designation: "F1" }), dev("mcb", { id: "ls1", designation: "F1.1" })], "F2 · Verteiler 1"),
    ],
    {
      code: "ZB35S",
      modules: [
        mod("m1", "ZH3EH16", 0, 0, { nar: "nar", aar1: "aar1" }, { label: "Allgemein", meters: [{ place: 0, number: METER_A, label: "" }] }),
        mod("m2", "ZU37KS", 1, 0, { r1: "vt1" }),
        mod("m3", "ZH3EL22", 2, 0, {}, { meters: [{ place: 0, number: METER_B, label: "WE 1" }] }),
        mod("m4", "ZU62A", 3, 0),
      ],
    },
  );
}

export function renderScene(view: SceneView = "open", document: PanelDocument = renderBoard()): EnclosureScene {
  const scene = buildEnclosureScene(document, INDEX, view);
  if (!scene) throw new Error("test board has no resolvable cabinet");
  return scene;
}
