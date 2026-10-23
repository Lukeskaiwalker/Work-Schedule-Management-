/**
 * Boards for the Aufbau tab fix (docs/PANEL_ENCLOSURE_R2.md §9, O6), shared
 * by the model, RailEditor and page tests.
 *
 * `ownerBoard()` has the shape of the board that hid a whole Verteilerfeld:
 * a ZB34S with ZH3EL16 / ZH3EH16 / a ZU37VT5APZ2 without any row (its RJ45
 * fitting makes none) / a ZU37KS. Codes and layout are the owner's, every
 * name and designation is invented — the repo is public.
 */
import { catalogIndex, type CatalogIndex } from "../utils/enclosureCatalog";
import type { EnclosureCatalog, EnclosureModule, ModuleSpec } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { board, dev, MODULES, row, testCatalog } from "./enclosureTestCatalog";

export const mod = (
  id: string,
  code: string,
  field: number,
  rails: Record<string, string> = {},
  extra: Partial<EnclosureModule> = {},
): EnclosureModule => ({ id, code, field, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [], ...extra });

/** Same zone stack as the ZH3EL27 of the test catalogue, 16 mm² wiring. */
const ZH3EL16: ModuleSpec = { ...MODULES.ZH3EL27, code: "ZH3EL16", article_no: "ZH3EL16", name: "Modul ZH3EL16", wiring_mm2: 16 };

/** The ZU37KS with its bottom rail (r7) retired, as an admin edit can leave it. */
export function withRetiredBottomRail(spec: ModuleSpec): ModuleSpec {
  return {
    ...spec,
    zones: spec.zones.map((zone) => ({ ...zone, rails: zone.rails.map((rail) => (rail.key === "r7" ? { ...rail, retired: true } : rail)) })),
  };
}

/** The small test catalogue plus the ZB34S cabinet and the ZH3EL16 meter field. */
export function aufbauCatalog(modules: Record<string, ModuleSpec> = {}): EnclosureCatalog {
  const base = testCatalog({ modules: { ZH3EL16, ...modules } });
  const zb33s = base.enclosures.find((entry) => entry.code === "ZB33S")!;
  const zb34s = {
    ...zb33s,
    code: "ZB34S",
    spec: { ...zb33s.spec!, code: "ZB34S", article_no: "ZB34S", name: "Zählerschrank ZB34S", fields: 4, width_mm: 1050 },
  };
  return { ...base, enclosures: [...base.enclosures, zb34s] };
}

export const AUFBAU_INDEX: CatalogIndex = catalogIndex(aufbauCatalog());

/**
 * ZB34S: field 1 ZH3EL16 (SLS on the NAR, HLAK on AAR 2), field 2 ZH3EH16
 * (pre-fitted HS on AAR 1, SLS on the NAR), field 3 ZU37VT5APZ2 with no
 * row at all, field 4 ZU37KS with one FI group on r1–r2. Rows in the
 * cabinet's reading order (§2.3).
 */
export function ownerBoard(): PanelDocument {
  return board(
    [
      row("el-nar", [dev("sls", { id: "q1", designation: "Q1" })], "F1 · NAR"),
      row("el-aar2", [dev("hlak", { id: "x1", designation: "X1" })], "F1 · AAR 2"),
      row("eh-nar", [dev("sls", { id: "q2", designation: "Q2" })], "F2 · NAR"),
      row("eh-aar1", [dev("hauptschalter", { id: "q3", designation: "Q3", supplied_by: { module: "m-eh", part: "hs" } })], "F2 · AAR 1"),
      row(
        "ks-r1",
        [dev("rcd", { id: "f1", designation: "F1" }), dev("mcb", { id: "f11", designation: "F1.1", circuit: "1", label: "Licht Flur" })],
        "F4 · Verteiler 1",
      ),
      row("ks-r2", [dev("mcb", { id: "f12", designation: "F1.2", circuit: "2", label: "Steckdosen Büro" })], "F4 · Verteiler 2"),
    ],
    {
      code: "ZB34S",
      modules: [
        mod("m-el", "ZH3EL16", 0, { nar: "el-nar", aar2: "el-aar2" }),
        mod("m-eh", "ZH3EH16", 1, { nar: "eh-nar", aar1: "eh-aar1" }),
        mod("m-vt", "ZU37VT5APZ2", 2),
        mod("m-ks", "ZU37KS", 3, { r1: "ks-r1", r2: "ks-r2" }),
      ],
    },
  );
}

export const OWNER_GROUP_TITLES = [
  "Feld 1 · ZH3EL16 Modul ZH3EL16",
  "Feld 2 · ZH3EH16 Modul ZH3EH16",
  "Feld 3 · ZU37VT5APZ2 Modul ZU37VT5APZ2",
  "Feld 4 · ZU37KS Modul ZU37KS",
];
