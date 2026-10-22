/**
 * Catalogue index, fit helpers and the electrical reading order
 * (docs/PANEL_ENCLOSURE.md §2.3, §3, §10.2). Direct cases on the test
 * catalogue; `enclosureParity.test.ts` pins the same functions on the
 * Python-written fixture.
 */
import { describe, expect, it } from "vitest";

import { catalogIndex, fitsAt, freeRuns, moduleArticle, normalizeCode } from "../utils/enclosureCatalog";
import {
  enclosureDeviceWidthMm,
  fittingRemoved,
  generatedRowLabel,
  linkedRows,
  moduleFittings,
  physicalRowOrder,
  resolvableRails,
  suppliedDevices,
} from "../utils/enclosureLayout";
import type { EnclosureCatalog, EnclosureModule, FittingSpec } from "../types/panelEnclosure";
import { BOARD_NAMES, FIXTURE_BOARDS, FIXTURE_INDEX } from "./enclosureFixtureBoards";
import { board, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";

// A hand-made module: no fitting snapshot, so the derivations read the catalogue.
const mod = (id: string, code: string, field: number, unit: number, rails: Record<string, string> = {}, extra: Partial<EnclosureModule> = {}): EnclosureModule => ({
  id, code, field, unit, label: "", rails, fittings: null, removed_fittings: [], meters: [], ...extra,
});

describe("parity with the Python twin (enclosureFixtures.json)", () => {
  it.each(BOARD_NAMES)("%s: the electrical reading order", (name) => {
    const board = FIXTURE_BOARDS[name];
    expect(physicalRowOrder(board.document, FIXTURE_INDEX)).toEqual(board.order);
  });
});

describe("catalogIndex", () => {
  it("resolves by normalised code, keeps archived entries and hides invalid ones", () => {
    const base = testCatalog();
    const catalog: EnclosureCatalog = {
      ...base,
      modules: [
        ...base.modules.map((entry) => (entry.code === "ZU62A" ? { ...entry, archived: true } : entry)),
        { ...base.modules[0], code: "BROKEN1", spec: null, invalid: true },
      ],
    };
    const index = catalogIndex(catalog);
    expect(normalizeCode(" zu37ks ")).toBe("ZU37KS");
    expect(index.module(" zu37ks ")?.code).toBe("ZU37KS");
    expect(index.module("ZU62A")?.code).toBe("ZU62A");
    expect(index.module("BROKEN1")).toBeNull();
    expect(index.entry("BROKEN1")?.invalid).toBe(true);
    expect(index.enclosure("ZU37KS")).toBeNull();
    expect(index.module("ZB33S")).toBeNull();
    expect(index.enclosure("ZB33S")?.units_per_field).toBe(7);
  });

  it("fills the defaults a sparse spec leaves out", () => {
    const sparse = {
      enclosures: [],
      modules: [{ code: "x1", entry_type: "module", spec: { code: "X1", zones: [{ key: "vt", type: "VT", unit: 0, units: 1, rails: [{ key: "r1", unit: 0 }] }] } }],
    } as unknown as EnclosureCatalog;
    const spec = catalogIndex(sparse).module("X1")!;
    expect(spec).toMatchObject({ article_no: "X1", width_fields: 1, height_units: 1, field_height_mm: null, fittings: [] });
    expect(spec.zones[0].rails[0]).toEqual({ key: "r1", unit: 0, ple: 12, mount: "rail", retired: false });
    expect(moduleArticle({ code: "X1" }, catalogIndex(sparse))).toBe("X1");
    expect(moduleArticle({ code: "nope" }, catalogIndex(sparse))).toBe("NOPE");
  });
});

describe("freeRuns / fitsAt", () => {
  const doc = board([], { code: "ZB33S", modules: [mod("a", "ZU62A", 0, 2), mod("b", "ZH3EH16", 1, 0), mod("ghost", "ZZ1", 2, 6)] });

  it("lists the free stretches of a field, unknown modules as one unit", () => {
    expect(freeRuns(doc, INDEX, 0)).toEqual([{ unit: 0, units: 2 }, { unit: 3, units: 4 }]);
    expect(freeRuns(doc, INDEX, 1)).toEqual([]);
    expect(freeRuns(doc, INDEX, 2)).toEqual([{ unit: 0, units: 6 }]);
    expect(freeRuns(doc, INDEX, 3)).toEqual([]);
    expect(freeRuns(doc, INDEX, 0, "a")).toEqual([{ unit: 0, units: 7 }]);
    expect(freeRuns(board([]), INDEX, 0)).toEqual([]);
  });

  it("says why a module does not fit", () => {
    expect(fitsAt(doc, INDEX, "ZU62A", 0, 0)).toBeNull();
    expect(fitsAt(doc, INDEX, "ZU79A", 0, 1)).toBe("Unbekannter Schrank- oder Modulcode: ZU79A.");
    expect(fitsAt(doc, INDEX, "ZY150RFZ", 0, 2)).toBe("Nicht genug Platz: 150 mm nötig, 0 mm frei.");
    expect(fitsAt(doc, INDEX, "ZU37KS", 0, 0)).toBe("Nicht genug Platz: 1050 mm nötig, 300 mm frei.");
    expect(fitsAt(doc, INDEX, "ZU37KS", 1, 0, "b")).toBeNull();
    expect(fitsAt(doc, INDEX, "ZU37KS", 3, 0)).toBe("Ragt über das letzte Feld hinaus.");
    // The left edge has its own sentence: "the last field" would point the fitter the wrong way.
    expect(fitsAt(doc, INDEX, "ZU37KS", -1, 0)).toBe("Ragt über das erste Feld hinaus.");
    expect(fitsAt(doc, INDEX, "ZH5EL27", 0, 0)).toBe("Für 1350 mm Felder — dieser Schrank hat 1050 mm.");
    expect(fitsAt(board([]), INDEX, "ZU37KS", 0, 0)).toBe("Noch kein Schrank geplant.");
    expect(fitsAt(board([], { code: "zb99", modules: [] }), INDEX, "ZU37KS", 0, 0)).toBe("Unbekannter Schrank- oder Modulcode: ZB99.");
  });
});

describe("rails, rows and the reading order", () => {
  it("links only existing rows under resolvable rails, the first claim wins", () => {
    const doc = board([row("n", []), row("v", []), row("x", []), row("u", [])], {
      code: "ZB33S",
      modules: [mod("m", "ZH3EH16", 0, 0, { nar: "n", gone: "x", aar1: "missing" }), mod("d", "ZU37KS", 1, 0, { r1: "v", r2: "n" }), mod("q", "ZZ9", 2, 0, { r1: "u" })],
    });
    expect([...linkedRows(doc, INDEX)]).toEqual([
      ["n", { moduleId: "m", railKey: "nar" }],
      ["v", { moduleId: "d", railKey: "r1" }],
    ]);
    expect([...resolvableRails(doc.enclosure!.modules[0], INDEX).keys()]).toEqual(["aar1", "aar2", "rfz", "nar"]);
    expect(linkedRows(board([row("n", [])]), INDEX).size).toBe(0);
  });

  it("puts RfZ/APZ rails first, then NAR → SAS → AAR → VF → VT per module, outside rows last", () => {
    const rows = ["own1", "vt2", "aar1", "apz", "nar", "sas", "rfz", "vt1", "own2", "aar2"].map((id) => row(id, [dev("mcb")]));
    const doc = board(rows, {
      code: "ZB33S",
      modules: [
        mod("z-dist", "ZU37VT5APZ2", 2, 0, { r2: "vt2", r1: "vt1", apz: "apz" }),
        mod("m-meter", "ZH3EH16", 0, 0, { aar2: "aar2", nar: "nar", aar1: "aar1", rfz: "rfz" }),
        mod("sas", "ZH3ES5", 1, 0, { sas: "sas" }),
      ],
    });
    expect(physicalRowOrder(doc, INDEX)).toEqual(["rfz", "apz", "nar", "aar1", "aar2", "sas", "vt1", "vt2", "own1", "own2"]);
    // Idempotent: ordering an ordered board changes nothing.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = { ...doc, rows: physicalRowOrder(doc, INDEX).map((id) => byId.get(id)!) };
    expect(physicalRowOrder(ordered, INDEX)).toEqual(ordered.rows.map((r) => r.id));
  });

  it("names rails like the rows they get", () => {
    const meter = MODULES.ZH3EH16;
    expect(generatedRowLabel({ field: 0 }, meter.zones[0], meter.zones[0].rails[1])).toBe("F1 · AAR 2");
    expect(generatedRowLabel({ field: 2 }, meter.zones[3], meter.zones[3].rails[0])).toBe("F3 · NAR");
  });

  it("measures devices on a rail: own width, busbar SLS, else TE", () => {
    const busbar = { mount: "busbar" as const };
    expect(enclosureDeviceWidthMm(dev("sls"), busbar)).toBe(78.75);
    expect(enclosureDeviceWidthMm(dev("sls"), { mount: "rail" })).toBe(52.5);
    expect(enclosureDeviceWidthMm(dev("rcd", { width_mm: 70 }), busbar)).toBe(70);
    expect(enclosureDeviceWidthMm(dev("mcb", { te: 0 }), { mount: "rail" })).toBe(17.5);
  });
});

describe("fittings and supplied devices", () => {
  it("counts only the first claimant of a live device fitting", () => {
    const first = dev("hauptschalter", { supplied_by: { module: "m", part: "hs" } });
    const second = dev("hauptschalter", { supplied_by: { module: "m", part: "hs" } });
    const dangling = dev("hlak", { supplied_by: { module: "gone", part: "hlak" } });
    const nonDevice = dev("terminal", { supplied_by: { module: "m", part: "busbar" } });
    const doc = board([row("a", [first, second, dangling, nonDevice])], { code: "ZB33S", modules: [mod("m", "ZH3EH16", 0, 0)] });
    expect([...suppliedDevices(doc, INDEX)]).toEqual([[first.id, { module: "m", part: "hs" }]]);
  });

  it("reads the snapshot, else the catalogue, and decides what is removed", () => {
    const snapshot = [{ key: "hs", label: "HS", article_no: null, device_kind: "hauptschalter" as const, removable: true }];
    const withSnapshot = mod("m", "ZZ-UNKNOWN", 0, 0, { aar1: "a" }, { fittings: snapshot, removed_fittings: ["busbar"] });
    expect(moduleFittings(withSnapshot, INDEX)).toBe(snapshot);
    const handMade = mod("h", "ZU37VT5APZ2", 0, 0, {}, { removed_fittings: ["rj45"] });
    expect(moduleFittings(handMade, INDEX).map((f) => f.key)).toEqual(["rj45"]);
    const doc = board([row("a", [])], { code: "ZB33S", modules: [withSnapshot, handMade] });
    expect(fittingRemoved(doc, withSnapshot, snapshot[0])).toBe(true);
    expect(fittingRemoved(doc, handMade, moduleFittings(handMade, INDEX)[0])).toBe(true);
    const fixed = { key: "busbar", label: "Schiene", article_no: null, device_kind: null, removable: false };
    expect(fittingRemoved(doc, withSnapshot, fixed)).toBe(false);
  });

  it("keeps an empty snapshot empty when the catalogue gains a fitting later", () => {
    // ZU37RK ships without fittings, so its placement stored []: "nothing
    // came pre-fitted", not "no snapshot". A device fitting an admin adds
    // afterwards must not reach that board (it would read as taken out).
    const hs: FittingSpec = {
      key: "hs", label: "Hauptschalter", article_no: null, removable: true, verified: false, note: "", retired: false,
      device: { kind: "hauptschalter", rail: "r1", te: 3, poles: 3, rating: "", width_mm: null },
    };
    const grown = catalogIndex(testCatalog({ modules: { ZU37RK: { ...MODULES.ZU37RK, fittings: [hs] } } }));
    const placed = mod("m", "ZU37RK", 0, 0, { r1: "v1" }, { fittings: [] });
    const claimant = dev("hauptschalter", { supplied_by: { module: "m", part: "hs" } });
    const doc = board([row("v1", [claimant])], { code: "ZB33S", modules: [placed] });
    expect(moduleFittings(placed, grown)).toEqual([]);
    expect(suppliedDevices(doc, grown).size).toBe(0);

    // A hand-made module — no key, or null — has no snapshot and reads the catalogue.
    const handMade = mod("h", "ZU37RK", 0, 0, {}, { fittings: null });
    expect(moduleFittings(handMade, grown).map((fitting) => fitting.key)).toEqual(["hs"]);
    const { fittings: _absent, ...withoutKey } = handMade;
    expect(moduleFittings(withoutKey, grown).map((fitting) => fitting.key)).toEqual(["hs"]);
  });
});

describe("generatedRowLabel", () => {
  it("cuts the label to what a row label may hold, by code point like the Python twin", () => {
    const zone = { ...MODULES.ZU37KS.zones[0], label: `${"x".repeat(58)}🔌🔌` };
    const label = generatedRowLabel({ field: 0 }, zone, zone.rails[1]);
    expect(Array.from(label)).toHaveLength(64);
    // Never half a surrogate pair: the server would refuse the string.
    expect(label.endsWith("🔌")).toBe(true);
    const plain = generatedRowLabel({ field: 1 }, MODULES.ZU37KS.zones[0], MODULES.ZU37KS.zones[0].rails[0]);
    expect(plain).toBe("F2 · Verteiler 1");
  });
});
