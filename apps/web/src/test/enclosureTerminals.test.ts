/**
 * WAGO terminals on the cabinet's rails (docs/PANEL_ENCLOSURE_R2.md §2.1,
 * §3) — the TS twin of `apps/api/tests/test_panel_enclosure_terminals.py`.
 *
 * The placement is derived, never stored: which circuits get terminals at
 * all (the skip set, R3), which rails carry them (the top two VT rails of a
 * field, R2), which field a strip belongs to (R4, R6), and how a field's
 * strips pack onto its two rails (R5) with one end plate per rail (R7). The
 * only stored input is `module.terminal_order` (§2.1), read leniently.
 *
 * Owner answers of 2026-10-22 that change the addendum: no WAGO 249-116 end
 * stops anywhere, and the Werkstatt facts stay as assumed (210 mm usable,
 * unverified; RK fields need no U84T).
 *
 * Python computes; `enclosureFixtures.json` records `terminal_skip` and
 * `terminal_placement` per board, and this twin must give the same, number
 * for number. Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import { catalogIndex, type CatalogIndex } from "../utils/enclosureCatalog";
import {
  INSULATED_RAILS_FITTING,
  TERMINAL_RAIL_USABLE_MM,
  TERMINAL_RAIL_USABLE_VERIFIED,
  WAGO_ZONE_TYPES,
  boardTerminals,
  effectiveSequence,
  emptyPlacement,
  fieldOrder,
  insulationSets,
  parseTerminalOrder,
  placeTerminals,
  stripHomeField,
  terminalRailKeys,
  terminalRailParts,
  terminalRails,
  terminalSkip,
  type BoardTerminals,
} from "../utils/enclosureTerminals";
import { makeDevice } from "../utils/schaltplanDevices";
import { END_PLATE_PART_IDS, RAIL_PART_IDS, type TerminalPartId } from "../utils/schaltplanTerminalRules";
import { deriveTerminals } from "../utils/schaltplanTerminals";
import type {
  CatalogEntry,
  EnclosureModule,
  ModuleSpec,
  PlacedTerminalRail,
  TerminalFieldPlacement,
  TerminalPlacement,
} from "../types/panelEnclosure";
import type { DeviceKind, PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";
import {
  BOARD_NAMES,
  FIXTURE_BOARDS,
  FIXTURE_CATALOG,
  FIXTURE_CONSTANTS,
  FIXTURE_INDEX,
  boardDocument,
} from "./enclosureFixtureBoards";
import { board, deepFreeze } from "./enclosureTestCatalog";

// ── builders (the Python writer's, in TS) ────────────────────────────────────

const dev = (id: string, kind: DeviceKind, overrides: Partial<PanelDevice> = {}): PanelDevice =>
  makeDevice(kind, { id, ...overrides });
const fi = (id: string, bmk: string, overrides: Partial<PanelDevice> = {}): PanelDevice =>
  dev(id, "rcd", { designation: bmk, rating: "40 A", residual_current: "30 mA", rcd_type: "A", ...overrides });
const ls = (id: string, bmk: string, circuit: string, label: string, overrides: Partial<PanelDevice> = {}): PanelDevice =>
  dev(id, "mcb", { designation: bmk, circuit, label, rating: "B16", cable: "NYM-J 3x2,5 mm²", ...overrides });

/** LS `{bmk}.k` for k = from … from + count − 1, each on a Reihenklemme (Python `ls_run`). */
function lsRun(group: string, bmk: string, count: number, firstCircuit: number, from = 1): PanelDevice[] {
  return Array.from({ length: count }, (_, i) =>
    ls(`dev-${group}-${from + i}`, `${bmk}.${from + i}`, String(firstCircuit + i), `Stromkreis ${firstCircuit + i}`, {
      terminal_block: true,
    }),
  );
}

const row = (id: string, label: string, devices: PanelDevice[]): PanelRow => ({ id, label, slots: 12, devices });

function mod(id: string, code: string, field: number, rails: Record<string, string>, extra: Partial<EnclosureModule> = {}): EnclosureModule {
  return { id, code, field, unit: 0, label: "", rails, fittings: [], removed_fittings: [], meters: [], ...extra };
}

const doc = (cabinet: string, modules: EnclosureModule[], rows: PanelRow[]): PanelDocument =>
  board(rows, { code: cabinet, modules });

function customEntry(spec: Partial<ModuleSpec> & { code: string }): CatalogEntry {
  return {
    code: spec.code, entry_type: "module", source: "custom", archived: false, invalid: false,
    spec: { article_no: spec.code, name: `Testfeld ${spec.code}`, family: "distribution", field_height_mm: 1050,
      width_fields: 1, fittings: [], accessories: [], verified: true, ...spec } as ModuleSpec,
    article: null, article_source: null, stock_available: 0, recent_count: 0, last_used_at: null, used_by_plans: 0,
  };
}

function withCustom(...specs: (Partial<ModuleSpec> & { code: string })[]): CatalogIndex {
  return catalogIndex({ ...FIXTURE_CATALOG, modules: [...FIXTURE_CATALOG.modules, ...(specs.map(customEntry) as CatalogEntry<ModuleSpec>[])] });
}

const railSpec = (key: string, unit: number, extra: Record<string, unknown> = {}) => ({ key, unit, ple: 12, mount: "rail", retired: false, ...extra });

/** An admin's own field: two plain DIN rails (Python `custom_module_spec`). */
const TWO_RAIL_FIELD = {
  code: "ZX37TEST",
  height_units: 2,
  zones: [{ key: "vt", type: "VT", unit: 0, units: 2, rails: [railSpec("r1", 0), railSpec("r2", 1)] }],
} as unknown as Partial<ModuleSpec> & { code: string };

const fieldOf = (placement: TerminalPlacement, number: number): TerminalFieldPlacement =>
  placement.fields.find((field) => field.field === number)!;
const xs = (rail: PlacedTerminalRail) => rail.strips.map((strip) => strip.xLabel);

function strip(
  stripId: string, stripNo: number, xLabel: string, groupId: string, homeField: number | null, headField: number | null,
  offsetMm: number, widthMm: number, extentMm: number, kind: "leiste" | "block" = "leiste",
) {
  return { stripId, stripNo, kind, xLabel, groupId, homeField, headField, offsetMm, widthMm, extentMm };
}

const plate = (partId: string, offsetMm: number) =>
  ({ partId, role: "end_plate", offsetMm, widthMm: partId === "2003-7692" ? 0.8 : 1.0 });

// ── the shared fixture ───────────────────────────────────────────────────────

describe("fixture parity", () => {
  it("echoes the same assumed capacity Python placed with", () => {
    expect(FIXTURE_CONSTANTS).toEqual({
      TERMINAL_RAIL_USABLE_MM: TERMINAL_RAIL_USABLE_MM,
      TERMINAL_RAIL_USABLE_VERIFIED: TERMINAL_RAIL_USABLE_VERIFIED,
    });
    expect([TERMINAL_RAIL_USABLE_MM, TERMINAL_RAIL_USABLE_VERIFIED]).toEqual([210, false]);
  });

  it.each(BOARD_NAMES)("%s: the skip set and the placement equal Python's", (name) => {
    const document = boardDocument(name);
    const terms = boardTerminals(document, FIXTURE_INDEX);
    expect([...terms.skip].sort()).toEqual(FIXTURE_BOARDS[name].terminal_skip);
    expect(placeTerminals(document, FIXTURE_INDEX, terms)).toEqual(FIXTURE_BOARDS[name].terminal_placement);
    expect(placeTerminals(document, FIXTURE_INDEX)).toEqual(FIXTURE_BOARDS[name].terminal_placement);
  });

  it("closes each rail with one end plate and no end stop (owner, 2026-10-22)", () => {
    expect([...RAIL_PART_IDS].sort()).toEqual([...END_PLATE_PART_IDS].sort());
    for (const name of BOARD_NAMES) {
      const placement = placeTerminals(boardDocument(name), FIXTURE_INDEX);
      for (const partId of Object.keys(placement.railParts)) expect(END_PLATE_PART_IDS.has(partId)).toBe(true);
      for (const field of placement.fields) {
        for (const rail of field.rails) {
          expect(rail.parts).toHaveLength(rail.strips.length > 0 ? 1 : 0);
          expect(rail.parts.every((part) => part.role === "end_plate")).toBe(true);
        }
      }
    }
  });
});

// ── which circuits get terminals (R3) ────────────────────────────────────────

const MM_FIELD = {
  code: "ZX37MM",
  family: "multimedia",
  field_height_mm: null,
  height_units: 2,
  zones: [{ key: "mm", type: "MM", unit: 0, units: 2, rails: [railSpec("mm1", 0)] }],
} as unknown as Partial<ModuleSpec> & { code: string };

describe("the skip set (R3)", () => {
  it("is every device on a rail of the grid operator or the AAR; VT, VF, MM and SAS keep theirs", () => {
    const index = withCustom(MM_FIELD);
    const tb = { terminal_block: true };
    const document = doc(
      "ZB55S",
      [
        mod("m1", "ZH5EL27", 0, { vf1: "row-vf", aar1: "row-aar", rfz: "row-rfz", nar: "row-nar" }),
        mod("m2", "ZU37VT5APZ2", 1, { r3: "row-vt", apz: "row-apz" }),
        mod("m3", "ZH53XS", 2, { sas: "row-sas" }),
        mod("m4", "ZX37MM", 3, { mm1: "row-mm" }),
        mod("m5", "ZX99NOPE", 4, { r1: "row-unknown" }),
      ],
      [
        row("row-nar", "F1 · NAR", [dev("d-sls", "sls", { designation: "Q0" }), ls("d-nar", "F0", "1", "x", tb)]),
        row("row-rfz", "F1 · RfZ", [ls("d-rfz", "F1", "2", "x", tb)]),
        row("row-aar", "F1 · AAR 1", [ls("d-aar", "F2", "3", "x")]),
        row("row-vf", "F1 · Verteilerfeld 1", [ls("d-vf", "F3", "4", "x", tb)]),
        row("row-vt", "F2 · Verteiler 3", [ls("d-vt", "F4", "5", "x", tb)]),
        row("row-apz", "F2 · APZ", [ls("d-apz", "F6", "7", "x", tb)]),
        row("row-sas", "F3 · Sammelschienen", [ls("d-sas", "F7", "8", "x", tb)]),
        row("row-mm", "F4 · Multimedia", [ls("d-mm", "F8", "9", "x", tb)]),
        row("row-unknown", "F5 · Verteiler 1", [ls("d-unknown", "F9", "10", "x", tb)]),
        row("row-loose", "Reihe 1", [ls("d-loose", "F10", "11", "x", tb)]),
      ],
    );
    expect([...WAGO_ZONE_TYPES].sort()).toEqual(["MM", "SAS", "VF", "VT"]);
    expect([...terminalSkip(document, index)].sort()).toEqual(["d-aar", "d-apz", "d-nar", "d-rfz", "d-sls"]);
    const terms = boardTerminals(document, index);
    const flagged = new Set(terms.groups.flatMap((group) => group.terminals.map((t) => t.deviceId).filter(Boolean)));
    for (const id of ["d-vf", "d-vt", "d-sas", "d-mm", "d-unknown", "d-loose"]) expect(flagged.has(id)).toBe(true);
    for (const id of terms.skip) expect(flagged.has(id)).toBe(false);
    expect(terms.groups).toEqual(deriveTerminals(document, terms.skip));
  });

  it("a board without a cabinet skips nothing and places nothing", () => {
    const document = { ...boardDocument("meter_dist_zb33s"), enclosure: null };
    const terms = boardTerminals(document, FIXTURE_INDEX);
    expect(terms.skip.size).toBe(0);
    expect(terms.groups).toEqual(deriveTerminals(document));
    expect(placeTerminals(document, FIXTURE_INDEX)).toEqual(emptyPlacement());
    expect(emptyPlacement()).toEqual({
      skip: [], usableMm: 210, fields: [], elsewhere: [], outside: [], noRails: [], railParts: {}, insulationSets: 0,
    });
  });

  it("skipped AAR circuits renumber the board", () => {
    const document = boardDocument("terminals_zb34s");
    expect(deriveTerminals(document)[0].strips[0].stripId).toBe("dev-q1:leiste");
    const terms = boardTerminals(document, FIXTURE_INDEX);
    expect(terms.groups[0].strips[0].stripId).toBe("dev-f1:leiste");
    expect([...terms.skip].sort()).toEqual(["dev-aar-ls1", "dev-q0", "dev-q1", "dev-x0"]);
  });

  it("placeTerminals refuses groups derived without the skip set", () => {
    const document = boardDocument("terminals_zb34s");
    const raw = { skip: new Set<string>(), groups: deriveTerminals(document) };
    // @ts-expect-error — only boardTerminals() makes a BoardTerminals
    expect(() => placeTerminals(document, FIXTURE_INDEX, raw)).toThrow(TypeError);
    const forged = { ...raw, __brand: "BoardTerminals" } as BoardTerminals;
    expect(() => placeTerminals(document, FIXTURE_INDEX, forged)).toThrow(TypeError);
    expect(() => placeTerminals(document, FIXTURE_INDEX, deriveTerminals(document) as unknown as BoardTerminals)).toThrow(TypeError);
  });
});

// ── terminal rails (R2) ──────────────────────────────────────────────────────

describe("terminal rails (R2)", () => {
  it("are the top two VT rails of each field; the served spec decides the insulation", () => {
    const document = doc(
      "ZB55S",
      [
        mod("m0", "ZU37KS", 0, { r2: "row-a" }),
        mod("m1", "ZU37RK", 1, {}), // a snapshot without u84t: the served spec decides
        mod("m2", "ZH53XS", 2, {}),
        mod("m3", "ZH3EH16", 3, {}),
        mod("m4", "ZX99NOPE", 4, {}),
      ],
      [row("row-a", "F1 · Verteiler 2", [ls("d1", "F1", "1", "Licht"), dev("ph", "terminal")])],
    );
    const rails = terminalRails(document, FIXTURE_INDEX);
    expect([...rails.keys()]).toEqual([0, 1, 2]);
    const tuples = [...rails.values()].flat().map((r) =>
      [r.field, r.position, r.moduleId, r.railKey, r.rowId, r.title, r.capacityMm, r.devicesMm, r.insulated]);
    expect(tuples).toEqual([
      [0, 0, "m0", "r1", null, "F1 · Verteiler 1", 210, 0, false],
      // the hand-placed "Reihenklemme N/PE" is a placeholder: not counted
      [0, 1, "m0", "r2", "row-a", "F1 · Verteiler 2", 210, 17.5, false],
      [1, 0, "m1", "r1", null, "F2 · Verteiler 1", 210, 0, true],
      [1, 1, "m1", "r2", null, "F2 · Verteiler 2", 210, 0, true],
      // SAS on top: the terminal rails are the first two VT rails below it
      [2, 0, "m2", "r1", null, "F3 · Verteiler 1", 210, 0, false],
      [2, 1, "m2", "r2", null, "F3 · Verteiler 2", 210, 0, false],
    ]);
    expect([...terminalRailKeys(document, FIXTURE_INDEX)].sort()).toEqual(
      ["m0:r1", "m0:r2", "m1:r1", "m1:r2", "m2:r1", "m2:r2"]);
    expect(INSULATED_RAILS_FITTING).toBe("u84t");
  });

  it("a retired top rail hands over to the next, and custom rails use their PLE", () => {
    const index = withCustom({
      code: "ZX37RET",
      height_units: 4,
      zones: [{ key: "vt", type: "VT", unit: 0, units: 4, rails: [
        railSpec("r1", 0, { retired: true }), railSpec("r2", 1), railSpec("r3", 2, { ple: 8 }), railSpec("r4", 3)] }],
    } as unknown as Partial<ModuleSpec> & { code: string });
    const document = doc("ZB32S", [mod("m", "ZX37RET", 0, {})], []);
    expect(terminalRails(document, index).get(0)!.map((r) => [r.railKey, r.capacityMm])).toEqual([["r2", 210], ["r3", 140]]);
  });

  it("two modules in one field rank their rails by height, then module id", () => {
    const document = doc("ZB32S", [mod("mb", "ZX37TEST", 0, {}, { unit: 0 }), mod("ma", "ZX37TEST", 0, {}, { unit: 1 })], []);
    expect(terminalRails(document, withCustom(TWO_RAIL_FIELD)).get(0)!.map((r) => [r.moduleId, r.railKey])).toEqual([
      ["mb", "r1"], ["ma", "r1"]]);
    // Level with each other, the module id decides, then the rail key.
    const level = doc("ZB32S", [mod("mb", "ZX37TEST", 0, {}), mod("ma", "ZX37TEST", 0, {})], []);
    expect(terminalRails(level, withCustom(TWO_RAIL_FIELD)).get(0)!.map((r) => [r.moduleId, r.railKey])).toEqual([
      ["ma", "r1"], ["mb", "r1"]]);
  });

  it("a row named twice counts once, on its first rail", () => {
    const document = doc("ZB32S", [mod("m", "ZU37KS", 0, { r1: "row-a", r2: "row-a" })], [
      row("row-a", "F1 · Verteiler 1", [ls("d1", "F1", "1", "Licht")]),
      row("row-a", "Doppelt", [ls("d2", "F2", "2", "Licht"), ls("d3", "F3", "3", "Licht")]),
    ]);
    expect(terminalRails(document, FIXTURE_INDEX).get(0)!.map((r) => [r.railKey, r.rowId, r.devicesMm])).toEqual([
      ["r1", "row-a", 17.5], ["r2", null, 0]]);
  });
});

// ── home fields (R4, R6) ─────────────────────────────────────────────────────

const t = (partId: TerminalPartId, deviceId: string | null) => ({ partId, deviceId });

describe("home fields (R4, R6)", () => {
  it("a Leiste homes where most of its circuits are; ties go to the first circuit's field", () => {
    const leiste = {
      kind: "leiste" as const,
      deviceId: null,
      terminals: [t("2016-7714", "f1"), t("2003-7641", "a"), t("2003-7641", "b"), t("2003-7642", "b"), t("2003-7641", "c"), t("2009-305", null)],
    };
    const fields = (entries: Record<string, number>) => new Map(Object.entries(entries));
    expect(stripHomeField(leiste, fields({ f1: 2, a: 2, b: 1, c: 1 }))).toBe(1); // b counts once, the FI not at all
    expect(stripHomeField(leiste, fields({ f1: 1, a: 2, b: 1 }))).toBe(2); // a tie: the first circuit's field
    expect(stripHomeField(leiste, fields({ b: 3 }))).toBe(3); // circuits outside the cabinet do not count
    expect(stripHomeField(leiste, fields({ f1: 0 }))).toBeNull();
    expect(stripHomeField({ kind: "block", deviceId: "w", terminals: [] }, fields({ w: 4 }))).toBe(4);
  });

  it("a strip without terminal rails in its field goes to the nearest one, left on a tie", () => {
    const document = doc(
      "ZB53S",
      [mod("ma", "ZU59RK", 0, {}), mod("mm", "ZH5EL27", 1, { vf1: "row-vf" }), mod("mb", "ZU59RK", 2, {})],
      [row("row-vf", "F2 · Verteilerfeld 1", [fi("f1", "F1"), ...lsRun("f1", "F1", 2, 1)])],
    );
    const placement = placeTerminals(document, FIXTURE_INDEX);
    expect(placement.elsewhere).toEqual([{ stripId: "f1:leiste", homeField: 1, field: 0 }]);
    expect(fieldOf(placement, 0).rails[0].strips).toEqual([strip("f1:leiste", 1, "X1", "f1", 1, 1, 0, 29.9, 30.7)]);
    expect(fieldOf(placement, 2).rails[0].strips).toEqual([]);
  });

  it("strips with no field at all are listed, never placed", () => {
    const vf = [row("row-vf", "F2 · Verteilerfeld 1", [fi("f1", "F1"), ...lsRun("f1", "F1", 2, 1)])];
    const onlyMeter = placeTerminals(doc("ZB53S", [mod("mm", "ZH5EL27", 1, { vf1: "row-vf" })], vf), FIXTURE_INDEX);
    expect([onlyMeter.fields, onlyMeter.noRails, onlyMeter.outside]).toEqual([[], ["f1:leiste"], []]);
    const loose = placeTerminals(
      doc("ZB32S", [mod("m", "ZU37KS", 0, {})], [row("row-loose", "Reihe 1", [fi("f1", "F1"), ...lsRun("f1", "F1", 2, 1)])]),
      FIXTURE_INDEX,
    );
    expect([loose.outside, loose.noRails]).toEqual([["f1:leiste"], []]);
    expect(fieldOf(loose, 0).rails.map(xs)).toEqual([[], []]);
  });

  it("a Block homes with its device and the supply strip has no head", () => {
    const document = doc(
      "ZB32S",
      [mod("m0", "ZU37KS", 0, { r3: "row-a" }), mod("m1", "ZU37KS", 1, { r3: "row-b" })],
      [
        row("row-a", "F1 · Verteiler 3", [ls("s1", "F0.1", "1", "x", { terminal_block: true }), fi("f1", "F1"), ...lsRun("f1", "F1", 2, 2)]),
        row("row-b", "F2 · Verteiler 3", [
          ls("w1", "F1.3", "4", "Wallbox", { rating: "C32", poles: 3, te: 3, terminal_block: true, parent_id: "f1" })]),
      ],
    );
    const placement = placeTerminals(document, FIXTURE_INDEX);
    expect(fieldOf(placement, 0).rails[0].strips).toEqual([
      strip("supply:leiste", 1, "X1", "supply", 0, null, 0, 5.2, 5.2),
      strip("f1:leiste", 2, "X2", "f1", 0, 0, 5.2, 29.9, 30.7),
    ]);
    expect(fieldOf(placement, 1).rails[0].strips).toEqual([strip("w1:block", 3, "X3", "f1", 1, 0, 0, 60, 60, "block")]);
  });
});

// ── packing (R5, R7) ─────────────────────────────────────────────────────────

describe("packing (R5, R7)", () => {
  it("the compliant reference places its strips on r1", () => {
    const placement = placeTerminals(boardDocument("meter_dist_zb33s"), FIXTURE_INDEX);
    expect(placement.skip).toEqual(["dev-q0", "dev-q1", "dev-x0"]);
    expect(placement.fields.map((f) => [f.field, f.rails.map((r) => [r.railKey, xs(r)])])).toEqual([
      [1, [["r1", ["X1"]], ["r2", []]]], [2, [["r1", ["X2"]], ["r2", []]]]]);
    expect([placement.railParts, placement.insulationSets]).toEqual([{ "2003-7692": 2 }, 2]);
  });

  it("the owner's board keeps its old rows and packs around them", () => {
    const field = fieldOf(placeTerminals(boardDocument("terminals_zb34s"), FIXTURE_INDEX), 1);
    const [rail1, rail2] = field.rails;
    expect([rail1.rowId, rail1.devicesMm, rail1.usedMm, rail1.capacityMm]).toEqual(["row-old1", 140, 196.7, 210]);
    expect(rail1.strips).toEqual([strip("dev-f1:leiste", 1, "X1", "dev-f1", 1, 1, 140, 55.9, 56.7)]);
    // The plate sits after the last terminal block, before the 2009-305.
    expect(rail1.parts).toEqual([plate("2003-7692", 188.4)]);
    // 3 LS = 52.5 mm; the hand-placed "Reihenklemme N/PE" is a placeholder.
    expect([rail2.rowId, rail2.devicesMm, xs(rail2), rail2.usedMm]).toEqual(["row-old2", 52.5, ["X2", "X3"], 175.5]);
    expect(rail2.strips.map((s) => s.offsetMm)).toEqual([52.5, 113.6]);
    expect(rail2.parts).toEqual([plate("2003-7692", 167.2)]);
    expect(field.unplaced.map((s) => [s.stripId, s.xLabel, s.widthMm])).toEqual([
      ["dev-f4:leiste", "X4", 61.1], ["dev-f5:leiste", "X5", 61.1], ["dev-f6:leiste", "X6", 61.1]]);
    expect([field.missingMm, field.order, field.orderModuleId]).toEqual([183.3, "default", null]);
  });

  it("first-fit puts a Block back onto rail 1 that next-fit left over", () => {
    const placement = placeTerminals(boardDocument("terminals_zb34s"), FIXTURE_INDEX);
    const [rail1, rail2] = fieldOf(placement, 3).rails;
    expect([xs(rail1), rail1.usedMm, xs(rail2), rail2.usedMm]).toEqual([["X7", "X8", "X10"], 204, ["X9", "X11", "X12"], 173.7]);
    expect(rail1.strips[2]).toEqual(strip("dev-f9-11:block", 10, "X10", "dev-f9", 3, 3, 143, 60, 60, "block"));
    expect(rail1.parts).toEqual([plate("2016-7691", 203)]);
    expect(rail2.parts).toEqual([plate("2003-7692", 165.4)]);
    expect(fieldOf(placement, 3).unplaced).toEqual([]);
    expect(fieldOf(placement, 2).rails.map((r) => [r.title, r.insulated, r.strips, r.parts, r.usedMm])).toEqual([
      ["F3 · Verteiler 1", true, [], [], 0], ["F3 · Verteiler 2", true, [], [], 0]]);
    expect(terminalRailParts(placement)).toEqual({ "2003-7692": 3, "2016-7691": 1 });
    expect(insulationSets(placement)).toBe(4);
  });

  it("a strip is unplaced only when it fits neither rail", () => {
    const placement = placeTerminals(boardDocument("terminals_overflow_zb32s"), FIXTURE_INDEX);
    const field = fieldOf(placement, 0);
    expect(field.rails.map((r) => [xs(r), r.usedMm])).toEqual([[["X1", "X2"], 143.8], [["X3", "X4"], 143.8]]);
    expect(field.unplaced).toEqual([{ stripId: "dev-f5:leiste", xLabel: "X5", widthMm: 71.5 }]);
    expect(field.missingMm).toBe(71.5);
    expect([placement.railParts, placement.insulationSets]).toEqual([{ "2003-7692": 2 }, 2]);
  });

  it.each([[148.1, 0], [148.9, 1]])("the end plate counts against the rail (%s mm of devices → rail %s)", (devicesMm, rail) => {
    const document = doc("ZB32S", [mod("m", "ZU37KS", 0, { r1: "row-1", r3: "row-3" })], [
      row("row-1", "F1 · Verteiler 1", [dev("big", "blank", { width_mm: devicesMm })]),
      row("row-3", "F1 · Verteiler 3", [fi("f1", "F1"), ...lsRun("f1", "F1", 8, 1)]),
    ]);
    // 148.1 + 61.1 + 0.8 = 210.0 fits; 148.9 + 61.1 + 0.8 = 210.8 does not.
    expect(fieldOf(placeTerminals(document, FIXTURE_INDEX), 0).rails.map(xs)).toEqual([0, 1].map((i) => (i === rail ? ["X1"] : [])));
  });

  it("the RK board places elsewhere, ignores a grown split and keeps the SAS Block", () => {
    const placement = placeTerminals(boardDocument("terminals_rk_zb53s"), FIXTURE_INDEX);
    expect(placement.skip).toEqual(["dev-q0"]);
    const field1 = fieldOf(placement, 1);
    expect([field1.order, field1.orderModuleId]).toEqual(["ignored", "mod-r"]);
    // A Leiste without an FI ends in an Etagenklemme: the plate follows it.
    expect(field1.rails[1].strips[1]).toEqual(strip("dev-q2:leiste", 2, "X2", "dev-q2", 1, 1, 61.1, 15.6, 15.6));
    expect(field1.rails[1].parts).toEqual([plate("2003-7692", 76.7)]);
    expect(fieldOf(placement, 2).rails[0].strips.map((s) => [s.xLabel, s.homeField, s.headField])).toEqual([
      ["X5", 2, 1], ["X7", 2, 2], ["X6", 2, 2]]);
    expect([placement.railParts, placement.insulationSets]).toEqual([{ "2003-7692": 2, "2016-7691": 1 }, 0]);
  });
});

// ── the stored order (§2.1) ──────────────────────────────────────────────────

describe("the stored order (§2.1)", () => {
  const ids = (seq: { id: string }[]) => seq.map((s) => s.id);
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => ({ id }));

  it("the effective sequence keeps the stored order and merges the rest at their default neighbour", () => {
    expect(ids(effectiveSequence([a, b, c], ["c", "gone", "a", "b"]))).toEqual(["c", "a", "b"]);
    expect(ids(effectiveSequence([a, b, c, d], ["c", "a"]))).toEqual(["c", "d", "a", "b"]);
    expect(ids(effectiveSequence([a, b], ["b"]))).toEqual(["a", "b"]);
    expect(ids(effectiveSequence([a, b], ["b", "b", "a"]))).toEqual(["b", "a"]);
    expect(ids(effectiveSequence([a, b], []))).toEqual(["a", "b"]);
  });

  /** F1, F2, F3 with 8 LS each (61.1 mm Leisten) on r3–r5; `f1Size` grows F1. */
  function threeGroups(order?: EnclosureModule["terminal_order"], f1Size = 8): PanelDocument {
    const rows = ([[1, 3], [2, 4], [3, 5]] as const).map(([group, rail]) =>
      row(`row-${rail}`, `F1 · Verteiler ${rail}`, [
        fi(`f${group}`, `F${group}`), ...lsRun(`f${group}`, `F${group}`, group === 1 ? f1Size : 8, group * 100)]));
    const extra = order === undefined ? {} : { terminal_order: order };
    return doc("ZB32S", [mod("m", "ZU37KS", 0, { r3: "row-3", r4: "row-4", r5: "row-5" }, extra)], rows);
  }
  const packed = (document: PanelDocument) => fieldOf(placeTerminals(document, FIXTURE_INDEX), 0);

  it("a stored split is honoured when both rails fit", () => {
    const fallback = packed(threeGroups());
    expect([fallback.rails.map(xs), fallback.order]).toEqual([[["X1", "X2", "X3"], []], "default"]);
    const manual = packed(threeGroups({ "0": { strips: ["f3:leiste", "f1:leiste", "f2:leiste"], rail2_from: "f2:leiste" } }));
    expect([manual.rails.map(xs), manual.order, manual.orderModuleId]).toEqual([[["X3", "X1"], ["X2"]], "manual", "m"]);
    const unsplit = packed(threeGroups({ "0": { strips: ["f3:leiste", "f1:leiste"] } } as unknown as EnclosureModule["terminal_order"]));
    expect([unsplit.rails.map(xs), unsplit.order]).toEqual([[["X3", "X1", "X2"], []], "manual"]);
  });

  it("a stored split is ignored once a group grew: auto layout, nothing kept that does not fit", () => {
    const order = { "0": { strips: ["f1:leiste", "f2:leiste", "f3:leiste"], rail2_from: "f3:leiste" } };
    const before = packed(threeGroups(order));
    expect([before.rails.map(xs), before.order]).toEqual([[["X1", "X2"], ["X3"]], "manual"]);
    // F1 with 25 LS is 149.5 mm: X1 + X2 + plate = 211.4 mm no longer fits rail 1.
    const grown = packed(threeGroups(order, 25));
    expect([grown.rails.map(xs), grown.rails.map((r) => r.usedMm), grown.order, grown.orderModuleId, grown.unplaced])
      .toEqual([[["X1"], ["X2", "X3"]], [150.3, 123], "ignored", "m", []]);
  });

  it("a split on a strip that is gone packs the stored sequence automatically", () => {
    const field = packed(threeGroups({ "0": { strips: ["f2:leiste", "gone:leiste"], rail2_from: "gone:leiste" } }));
    expect([field.rails.map(xs), field.order]).toEqual([[["X1", "X2", "X3"], []], "manual"]);
  });

  it("a field with one terminal rail keeps the stored sequence and has no split to honour", () => {
    const index = withCustom({
      code: "ZX37ONE",
      height_units: 2,
      zones: [
        { key: "vt", type: "VT", unit: 0, units: 1, rails: [railSpec("r1", 0)] },
        { key: "vf", type: "VF", unit: 1, units: 1, rails: [railSpec("v1", 1)] },
      ],
    } as unknown as Partial<ModuleSpec> & { code: string });
    const order = { "0": { strips: ["f2:leiste", "f1:leiste"], rail2_from: "f1:leiste" } };
    const document = doc("ZB32S", [mod("m", "ZX37ONE", 0, { v1: "row-v" }, { terminal_order: order })], [
      row("row-v", "F1 · Verteilerfeld", [fi("f1", "F1"), ...lsRun("f1", "F1", 2, 1), fi("f2", "F2"), ...lsRun("f2", "F2", 2, 3)]),
    ]);
    const field = fieldOf(placeTerminals(document, index), 0);
    expect([field.rails.map(xs), field.order, field.orderModuleId]).toEqual([[["X2", "X1"]], "manual", "m"]);
  });

  it("fieldOrder reads the first terminal-rail holder with an entry", () => {
    const index = withCustom(TWO_RAIL_FIELD);
    const entryA = { "0": { strips: ["x:leiste"], rail2_from: null } };
    const entryB = { "0": { strips: ["y:leiste"], rail2_from: null } };
    const both = doc("ZB32S", [
      mod("mb", "ZX37TEST", 0, {}, { unit: 0, terminal_order: entryB }),
      mod("ma", "ZX37TEST", 0, {}, { unit: 1, terminal_order: entryA }),
    ], []);
    expect(fieldOrder(both, index, 0)).toEqual({ moduleId: "mb", strips: ["y:leiste"], rail2_from: null });
    const [first, second] = both.enclosure!.modules;
    const { terminal_order: _dropped, ...withoutOrder } = first;
    const onlySecond = { ...both, enclosure: { ...both.enclosure!, modules: [withoutOrder, second] } };
    expect(fieldOrder(onlySecond, index, 0)).toEqual({ moduleId: "ma", strips: ["x:leiste"], rail2_from: null });
    expect(fieldOrder(onlySecond, index, 1)).toBeNull();
  });
});

// ── tolerance ────────────────────────────────────────────────────────────────

describe("parseTerminalOrder", () => {
  const strips = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
  it.each<[unknown, unknown]>([
    [null, null], ["0", null], [[], null], [42, null], [undefined, null],
    [{ "3": { strips: ["a"] }, x: { strips: ["a"] } }, null],
    [{ "0": { strips: "a" } }, null],
    [{ "0": "x", "1": null, "2": { strips: [] } }, null],
    [{ "0": [{ strips: ["a"] }] }, null],
    [{ "0": { strips: [1, null, "", "a", "a", "x".repeat(81), "y".repeat(80)] } }, { "0": { strips: ["a", "y".repeat(80)], rail2_from: null } }],
    // Code points, as Python counts them: 80 emoji are 160 UTF-16 units and still fit.
    [{ "0": { strips: ["🔌".repeat(80)] } }, { "0": { strips: ["🔌".repeat(80)], rail2_from: null } }],
    [{ "0": { strips: ["a"], rail2_from: "b" } }, { "0": { strips: ["a"], rail2_from: null } }],
    [{ "0": { strips: ["a"], rail2_from: 5, extra: 1 } }, { "0": { strips: ["a"], rail2_from: null } }],
    [{ "2": { strips: ["a", "b"], rail2_from: "b" } }, { "2": { strips: ["a", "b"], rail2_from: "b" } }],
    [{ "1": { strips: strips(1000) } }, { "1": { strips: strips(40), rail2_from: null } }],
  ])("%j → %j, never throws", (value, expected) => {
    expect(parseTerminalOrder(value)).toEqual(expected);
  });
});

describe("garbage never throws", () => {
  const rows = [row("row", "F1 · Verteiler 1", [ls("d", "F1", "1", "x", { terminal_block: true })])];
  const garbage: unknown[] = [
    { ...board(rows), enclosure: "x" },
    { ...board(rows), enclosure: { code: "ZB33S", modules: "x" } },
    { ...board(rows), enclosure: { code: "ZB33S" } },
    { ...board(rows), rows: 5, enclosure: { code: "ZB33S", modules: [{ id: "m", code: "ZU37KS", field: 0, rails: { r1: "row" } }] } },
    {
      ...board(rows),
      enclosure: {
        code: "ZB33S",
        modules: [
          null, 5, { id: 5 }, { id: "m", code: 7 },
          { id: "m2", code: "ZU37KS", field: "x", unit: null, rails: { r1: 5, r2: "row" }, terminal_order: { "0": "x" } },
          { id: "m3", code: "ZU37RK", field: 1, unit: 0, rails: "x", terminal_order: [1] },
          { id: "m4", code: "ZU37KS", field: 2.5, unit: true, rails: { r3: "row" }, terminal_order: { "0": { strips: ["d:leiste"], rail2_from: "d:leiste" } } },
        ],
      },
    },
    // The Python twin's row-level garbage: rows that are no rows, devices that are no devices.
    {
      ...board([]),
      enclosure: { code: "ZB33S", modules: [{ id: "m", code: "ZU37KS", field: 0, rails: { r1: "row" } }] },
      rows: [null, { id: "row", devices: "x" }, { id: "row", devices: [null, { id: null, width_mm: "x" }] }],
    },
    {
      ...board([]),
      enclosure: { code: "ZB33S", modules: [{ id: "m", code: "ZU37KS", field: 0, rails: { r1: "row" } }] },
      rows: [{ id: "row", devices: [{ id: "d", kind: "mcb", terminal_block: true, te: "x" }] }],
      terminal_labels: "x",
    },
  ];
  it.each(garbage.map((value, i) => [i, value] as const))("document %i", (_i, value) => {
    const document = value as PanelDocument;
    const placement = placeTerminals(document, FIXTURE_INDEX);
    expect(Object.keys(placement).sort()).toEqual(Object.keys(emptyPlacement()).sort());
    expect(terminalSkip(document, FIXTURE_INDEX)).toBeInstanceOf(Set);
    expect(terminalRails(document, FIXTURE_INDEX)).toBeInstanceOf(Map);
  });

  it("never mutates its inputs", () => {
    const document = deepFreeze(boardDocument("terminals_rk_zb53s"));
    const before = JSON.stringify(document);
    expect(placeTerminals(document, FIXTURE_INDEX)).toEqual(FIXTURE_BOARDS.terminals_rk_zb53s.terminal_placement);
    expect(JSON.stringify(document)).toBe(before);
  });
});

// ── memoisation (§6.7) ───────────────────────────────────────────────────────

describe("memoisation by document identity, per catalogue index", () => {
  it("boardTerminals and placeTerminals answer the same object for the same document", () => {
    const document = boardDocument("terminals_zb34s");
    const terms = boardTerminals(document, FIXTURE_INDEX);
    expect(boardTerminals(document, FIXTURE_INDEX)).toBe(terms);
    const placement = placeTerminals(document, FIXTURE_INDEX);
    expect(placeTerminals(document, FIXTURE_INDEX)).toBe(placement);
    expect(placeTerminals(document, FIXTURE_INDEX, terms)).toBe(placement);
  });

  it("a new document, another index or other terms compute afresh", () => {
    const document = boardDocument("terminals_zb34s");
    const terms = boardTerminals(document, FIXTURE_INDEX);
    const placement = placeTerminals(document, FIXTURE_INDEX, terms);
    const copy = { ...document };
    expect(boardTerminals(copy, FIXTURE_INDEX)).not.toBe(terms);
    expect(boardTerminals(copy, FIXTURE_INDEX)).toEqual(terms);
    const otherIndex = catalogIndex(FIXTURE_CATALOG);
    expect(boardTerminals(document, otherIndex)).not.toBe(terms);
    const otherTerms = boardTerminals(copy, FIXTURE_INDEX);
    const again = placeTerminals(document, FIXTURE_INDEX, otherTerms);
    expect(again).not.toBe(placement);
    expect(again).toEqual(placement);
  });
});
