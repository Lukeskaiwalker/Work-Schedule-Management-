/**
 * Cabinet findings (docs/PANEL_ENCLOSURE.md §5, §14 "enclosureRules").
 *
 * Parity first: every fixture board must yield exactly the findings the
 * Python twin wrote, in the same order. Then direct cases on minimal boards
 * built on the test catalogue, one per rule that the fixture leaves quiet
 * or where the edge matters (SAS credit, per-place counts, PV/Wallbox in the
 * AAR, a ≤ 10 A tap on the NAR), and garbage that must never throw.
 */
import { describe, expect, it } from "vitest";

import { enclosureFindings, formatMmText, ratingValue, RULE_ORDER } from "../utils/enclosureRules";
import { PREP_RULE_ORDER } from "../utils/enclosurePrepRules";
import { TERMINAL_RULE_ORDER } from "../utils/enclosureTerminalRules";
import { defaultControlBlock } from "../utils/enclosureControlBlock";
import { catalogIndex } from "../utils/enclosureCatalog";
import type { ControlBlock, EnclosureModule, ModuleSpec, PrepOverrides } from "../types/panelEnclosure";
import type { PanelDocument, PanelSupply } from "../types/schaltplan";
import { BOARD_NAMES, FIXTURE_BOARDS, FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import { board, CABINETS, dev, INDEX, MODULES, R4_INDEX, row, testCatalog } from "./enclosureTestCatalog";

// A hand-made module: no fitting snapshot, so the derivations read the catalogue.
const mod = (id: string, code: string, field: number, unit: number, rails: Record<string, string> = {}, extra: Partial<EnclosureModule> = {}): EnclosureModule => ({
  id, code, field, unit, label: "", rails, fittings: null, removed_fittings: [], meters: [], ...extra,
});

const rulesOf = (doc: PanelDocument) => enclosureFindings(doc, INDEX).map((finding) => finding.rule);
const warnsOf = (doc: PanelDocument) => enclosureFindings(doc, INDEX).filter((finding) => finding.level === "warn");

describe("parity with the Python twin (enclosureFixtures.json)", () => {
  it.each(BOARD_NAMES)("%s: the same findings in the same order", (name) => {
    const fixture = FIXTURE_BOARDS[name];
    expect(enclosureFindings(fixture.document, FIXTURE_INDEX)).toEqual(fixture.findings);
  });

  it("the compliant reference board has no warning", () => {
    const fixture = FIXTURE_BOARDS.meter_dist_zb33s;
    expect(enclosureFindings(fixture.document, FIXTURE_INDEX).filter((finding) => finding.level === "warn")).toEqual([]);
  });
});

describe("helpers", () => {
  it("formats millimetres German style and reads the last number of a rating", () => {
    expect(formatMmText(29.94)).toBe("29,9");
    expect(formatMmText(1050)).toBe("1050");
    expect(ratingValue("B16")).toBe(16);
    expect(ratingValue("C 32A")).toBe(32);
    expect(ratingValue("0,5 A")).toBe(0.5);
    expect(ratingValue("")).toBeNull();
    // Round 2: ten terminal rules where "encl.terminals" was; round 4: seventeen prep rules before them
    // (the review added busbar_meters and infeed_small).
    expect(RULE_ORDER).toHaveLength(51);
  });
});

describe("direct cases", () => {
  it("is empty without a cabinet and reports an unknown cabinet code", () => {
    expect(enclosureFindings(board([row("a", [dev("mcb")])]), INDEX)).toEqual([]);
    const unknown = enclosureFindings(board([], { code: " zb99 ", modules: [] }), INDEX);
    expect(unknown).toEqual([
      { level: "warn", scope: "", rule: "encl.unknown_code", message: "Unbekannter oder fehlerhafter Katalogcode zb99 — nur als Platzhalter gezeigt." },
    ]);
  });

  it("reports bounds, overlap (on the later module), height and gaps", () => {
    const doc = board([], {
      code: "ZB32S",
      modules: [mod("a", "ZU37KS", 0, 0), mod("b", "ZU62A", 0, 6), mod("c", "ZU37KS", 1, 1), mod("d", "ZH5EL27", 2, 0)],
    });
    const findings = enclosureFindings(doc, INDEX);
    expect(findings.filter((f) => f.rule === "encl.overlap")).toEqual([
      { level: "warn", scope: "b", rule: "encl.overlap", message: "ZU37KS und ZU62A überlappen in Feld 1." },
    ]);
    expect(findings.filter((f) => f.rule === "encl.out_of_bounds").map((f) => f.scope)).toEqual(["c", "d"]);
    expect(findings.find((f) => f.rule === "encl.height_mismatch")?.message).toBe("ZH5EL27: für 1350 mm Felder — passt nicht in ZB32S.");
    expect(findings.find((f) => f.rule === "encl.field_gap")?.message).toBe("Feld 2: 150 mm ohne Modul — Abdeckung einplanen.");
  });

  it("names a row without a label by its id", () => {
    const doc = board([row("row-x", [], "  ")], { code: "ZB33S", modules: [] });
    expect(enclosureFindings(doc, INDEX).find((f) => f.rule === "encl.row_unlinked")?.message).toBe("row-x: keiner Hutschiene im Schrank zugeordnet.");
  });

  it("credits an SLS on a SAS to the meter field next to it, once", () => {
    const sas = (field: number) => mod("s", "ZH3ES5", field, 0, { sas: "sas" });
    const meter = mod("m", "ZH3EL27", 0, 0, {}, { meters: [{ place: 0, number: "", label: "" }] });
    const rows = [row("sas", [dev("sls", { rating: "E35" })])];
    expect(rulesOf(board(rows, { code: "ZB33S", modules: [meter, sas(1)] }))).not.toContain("vde.nar_sls");
    const far = enclosureFindings(board(rows, { code: "ZB33S", modules: [meter, sas(2)] }), INDEX).find((f) => f.rule === "vde.nar_sls");
    expect(far?.message).toBe("VDE-AR-N 4100: Feld 1 (ZH3EL27): 0 SLS-Schalter für 1 Zählerplatz/-plätze im NAR.");
    const second = mod("m2", "ZH3EL27", 2, 0, {}, { meters: [{ place: 0, number: "", label: "" }] });
    const shared = enclosureFindings(board(rows, { code: "ZB33S", modules: [meter, sas(1), second] }), INDEX).filter((f) => f.rule === "vde.nar_sls");
    expect(shared.map((f) => f.scope)).toEqual(["m2"]);
  });

  it("counts SLS per occupied meter place", () => {
    const meter = mod("m", "ZH3EL22", 0, 0, { nar: "nar" }, { meters: [{ place: 0, number: "", label: "" }, { place: 1, number: "", label: "" }] });
    const doc = board([row("nar", [dev("sls")])], { code: "ZB33S", modules: [meter] });
    expect(enclosureFindings(doc, INDEX).find((f) => f.rule === "vde.nar_sls")?.message).toBe(
      "VDE-AR-N 4100: Feld 1 (ZH3EL22): 1 SLS-Schalter für 2 Zählerplatz/-plätze im NAR.",
    );
  });

  it("allows a ≤ 10 A tap on the NAR, refuses fuses, FIs and bigger LS", () => {
    const tap = dev("mcb", { rating: "B10" });
    const big = dev("mcb", { rating: "B16" });
    const fuse = dev("fuse");
    const fi = dev("rcd");
    const meter = mod("m", "ZH3EL27", 0, 0, { nar: "nar" }, { meters: [{ place: 0, number: "", label: "" }] });
    const doc = board([row("nar", [dev("sls", { rating: "E35" }), tap, big, fuse, fi])], { code: "ZB33S", modules: [meter] });
    const nar = enclosureFindings(doc, INDEX).filter((f) => f.rule === "vde.nar_contents");
    expect(nar.map((f) => f.scope).sort()).toEqual([big.id, fuse.id, fi.id].sort());
    expect(nar.find((f) => f.scope === fuse.id)?.message).toBe("VDE-AR-N 4100: NAR ZH3EL27: NH/Neozed ist nicht als Trennvorrichtung zulässig — SLS verwenden.");
    expect(nar.find((f) => f.scope === big.id)?.message).toBe("VDE-AR-N 4100: NAR ZH3EL27: LS gehört nicht in den NAR.");
  });

  it("flags an SLS too big for the field wiring", () => {
    const meter = mod("m", "ZH3EL27", 0, 0, { nar: "nar" }, { meters: [{ place: 0, number: "", label: "" }] });
    const sls = dev("sls", { rating: "E50" });
    const doc = board([row("nar", [sls])], { code: "ZB33S", modules: [meter] });
    expect(enclosureFindings(doc, INDEX).find((f) => f.rule === "vde.sls_rating")).toEqual({
      level: "warn", scope: sls.id, rule: "vde.sls_rating",
      message: "VDE-AR-N 4100: Feld 1 (ZH3EL27): SLS E50 zu groß für 10 mm² Feldverdrahtung (max. E35).",
    });
  });

  it("allows PV and Wallbox in the AAR but counts them, at most 16 A each", () => {
    const meter = mod("m", "ZH3EL27", 0, 0, { nar: "nar", aar1: "aar" }, { meters: [{ place: 0, number: "", label: "" }] });
    const ok = board([row("nar", [dev("sls")]), row("aar", [dev("pv", { rating: "B16" }), dev("wallbox", { rating: "B16" }), dev("mcb", { rating: "B16" })])], { code: "ZB33S", modules: [meter] });
    expect(rulesOf(ok).filter((rule) => rule?.startsWith("vde.aar"))).toEqual([]);
    const tooMany = board([row("nar", [dev("sls")]), row("aar", [dev("pv", { rating: "B16" }), dev("wallbox", { rating: "B32" }), dev("contactor")])], { code: "ZB33S", modules: [meter] });
    expect(rulesOf(tooMany).filter((rule) => rule?.startsWith("vde.aar"))).toEqual(["vde.aar_contents", "vde.aar_circuits"]);
  });

  it("wants a Hauptschalter behind every 3-Punkt meter", () => {
    const meter = mod("m", "ZH33X7", 0, 0, { nar: "nar" }, { meters: [{ place: 0, number: "", label: "" }] });
    const doc = board([row("nar", [dev("sls")])], { code: "ZB33S", modules: [meter] });
    expect(warnsOf(doc).find((f) => f.rule === "vde.3p_main_switch")?.message).toBe(
      "VDE-AR-N 4100: Hinter jedem 3-Punkt-Zähler in Feld 1 gehört ein Hauptschalter in den AAR (0 von 1).",
    );
  });

  it("keeps the RfZ for the grid operator, wants an APZ at an edge and next to the meter field", () => {
    const meter = mod("m", "ZH3EL27", 0, 0, { rfz: "rfz", nar: "nar" }, { meters: [{ place: 0, number: "", label: "" }] });
    const unrated = dev("mcb");
    const doc = board([row("rfz", [dev("mcb", { rating: "B6" }), unrated]), row("nar", [dev("sls")])], { code: "ZB33S", modules: [meter] });
    const findings = enclosureFindings(doc, INDEX);
    expect(findings.filter((f) => f.rule === "vde.rfz_devices").map((f) => f.scope)).toEqual([unrated.id]);
    expect(findings.find((f) => f.rule === "vde.apz_missing")?.message).toBe("VDE-AR-N 4100: Kein APZ im Schrank (mind. 300 mm, plombierbar).");
    const withApz = board(doc.rows, { code: "ZB33S", modules: [meter, mod("a", "ZU37VT5APZ2", 1, 0)] });
    expect(rulesOf(withApz).filter((rule) => rule?.startsWith("vde.apz"))).toEqual([]);
    const middle = board(doc.rows, { code: "ZB33S", modules: [meter, mod("c", "ZY150RFZ", 1, 0), mod("a", "ZU37VT5APZ2", 2, 0)] });
    expect(rulesOf(middle).filter((rule) => rule?.startsWith("vde.apz"))).toEqual([]);
  });

  it("reports free and impossible meter places", () => {
    const meter = mod("m", "ZH3EL22", 0, 0, {}, { meters: [{ place: 1, number: "", label: "" }, { place: 5, number: "", label: "" }] });
    const findings = enclosureFindings(board([], { code: "ZB33S", modules: [meter] }), INDEX);
    expect(findings.find((f) => f.rule === "encl.meter_place_invalid")?.message).toBe("ZH3EL22: Zählerplatz 6 gibt es nicht — Eintrag wird ignoriert.");
    expect(findings.find((f) => f.rule === "vde.meter_place_empty")?.message).toBe(
      "VDE-AR-N 4100: Zählerplatz 1 in Feld 1 als Reserve geplant — Blindabdeckung steht auf der Materialliste.",
    );
  });

  it("never throws on garbage", () => {
    const garbage = [
      { version: 1, rows: [], enclosure: { code: 7, modules: "x" } },
      { version: 1, rows: [{ id: "r", label: null, slots: "a", devices: [] }], enclosure: { code: "ZB33S", modules: [{ id: "m", code: null, rails: null, meters: [{ place: "x" }] }] } },
      { version: 1, rows: [], enclosure: { code: "ZB33S", modules: [{ id: "m", code: "ZH3EL22", field: 0, unit: 0, rails: { nar: 5 }, meters: null, fittings: "no" }] } },
    ] as unknown as PanelDocument[];
    for (const doc of garbage) expect(() => enclosureFindings(doc, INDEX)).not.toThrow();
  });
});

// ── Round 4 (docs/PANEL_ENCLOSURE_R4.md §4) ──────────────────────────────────

type BoardParts = { block?: unknown; prep?: Partial<PrepOverrides>; supply?: Partial<PanelSupply> };

/** A ZB33S board; `block` and `prep` are stored as given (absent when omitted). */
function r4Board(modules: EnclosureModule[], rows = board([]).rows, parts: BoardParts = {}): PanelDocument {
  const doc = board(rows, { code: "ZB33S", modules });
  const enclosure = {
    ...doc.enclosure!,
    ...("block" in parts ? { control_block: parts.block as ControlBlock } : {}),
    ...(parts.prep ? { prep: parts.prep as PrepOverrides } : {}),
  };
  return { ...doc, supply: { ...doc.supply, ...parts.supply }, enclosure };
}

const messageOf = (doc: PanelDocument, rule: string, index = INDEX) =>
  enclosureFindings(doc, index).find((finding) => finding.rule === rule);
const block = (patch: Partial<ControlBlock> = {}): ControlBlock => ({ ...defaultControlBlock(), ...patch });
const fullRow = (id: string) => row(id, Array.from({ length: 12 }, () => dev("mcb")));
const indexWith = (modules: Record<string, ModuleSpec>) => catalogIndex(testCatalog({ modules }));

describe("round-4 rules", () => {
  it("sit between the meter places and the terminal rules", () => {
    const at = RULE_ORDER.indexOf("encl.control_block_missing");
    expect(RULE_ORDER[at - 1]).toBe("encl.meter_place_invalid");
    expect(RULE_ORDER.slice(at, at + PREP_RULE_ORDER.length)).toEqual([...PREP_RULE_ORDER]);
    expect(RULE_ORDER[at + PREP_RULE_ORDER.length]).toBe(TERMINAL_RULE_ORDER[0]);
  });

  it("ask for the block only with a carrier and nothing stored", () => {
    const meter = [mod("m", "ZH3EH16", 0, 0)];
    expect(messageOf(r4Board(meter), "encl.control_block_missing")).toEqual({
      level: "info", scope: "", rule: "encl.control_block_missing",
      message: "Zählerschrank ohne §14a-Steuersignal-Klemmleiste: im ersten Zählerfeld anlegen.",
    });
    const removed = r4Board(meter, undefined, { block: block({ off: true }) });
    expect(rulesOf(removed).filter((rule) => rule?.startsWith("encl.control"))).toEqual([]);
    expect(rulesOf(r4Board([mod("d", "ZU37KS", 0, 0)]))).not.toContain("encl.control_block_missing");
    expect(rulesOf(r4Board(meter, undefined, { block: block() }))).not.toContain("encl.control_block_missing");
  });

  it("take a given block instead of the stored one", () => {
    const doc = r4Board([mod("m", "ZH3EH16", 0, 0)], undefined, { block: block() });
    const rules = enclosureFindings(doc, INDEX, undefined, null).map((finding) => finding.rule);
    expect(rules).toContain("encl.control_block_missing");
  });

  it("name a reserve carrier and a 3-Punkt block without an APZ", () => {
    const doc = r4Board([mod("r", "ZH33XL", 0, 0)], undefined, { block: block() });
    expect(messageOf(doc, "encl.control_block_reserve", R4_INDEX)).toMatchObject({
      level: "info", scope: "r", message: "§14a-Klemmleiste sitzt auf einem Reserve-Zählerfeld (Feld 1).",
    });
    expect(messageOf(doc, "encl.control_block_target", R4_INDEX)).toMatchObject({
      level: "warn", scope: "r", message: "§14a-Steuerleitungen ohne Ziel: im Schrank fehlt ein APZ.",
    });
  });

  it("name an eHZ carrier without RfZ or without AAR rail", () => {
    const zones = MODULES.ZH3EH16.zones;
    const noRfz = indexWith({ ZH3EH16: { ...MODULES.ZH3EH16, zones: zones.filter((zone) => zone.type !== "RFZ") } });
    const doc = r4Board([mod("m", "ZH3EH16", 1, 0)], undefined, { block: block() });
    expect(messageOf(doc, "encl.control_block_target", noRfz)?.message).toBe("§14a-Steuerleitungen ohne Ziel: Feld 2 hat keinen RfZ.");
    const noAar = indexWith({ ZH3EH16: { ...MODULES.ZH3EH16, zones: zones.filter((zone) => zone.type !== "AAR") } });
    expect(messageOf(doc, "encl.control_block_rail", noAar)).toMatchObject({
      level: "warn", scope: "m", message: "§14a-Klemmleiste: Feld 2 hat keine AAR-Hutschiene.",
    });
  });

  it("name an overflowing block, a non-BDEW count and a tube too narrow for the wire", () => {
    const meter = [mod("m", "ZH3EH16", 0, 0, { aar1: "a1" })];
    const full = r4Board(meter, [fullRow("a1")], { block: block({ rail: "aar1" }) });
    expect(messageOf(full, "encl.control_block_overflow")?.message).toBe("§14a-Klemmleiste passt nicht auf F1 · AAR 1: 254,2 mm von 210 mm.");
    const five = r4Board(meter, undefined, { block: block({ terminals: defaultControlBlock().terminals.slice(0, 5) }) });
    expect(messageOf(five, "encl.control_block_bdew")?.message).toBe("§14a-Klemmleiste mit 5 statt 6 Klemmen — BDEW/VDE-AR-N 4100 sieht 6 vor.");
    const narrow = r4Board(meter, undefined, { block: block({ label_material: "wago-211-501", wire_mm2: 1.5 }) });
    expect(messageOf(narrow, "encl.control_tube")?.message).toBe("Schrumpfschlauch 211-501 passt nur auf 0,75–1 mm² — Leitung ist 1,5 mm².");
    expect(rulesOf(r4Board(meter, undefined, { block: block() }))).not.toContain("encl.control_tube");
  });

  it("name busbar gaps, busbars at different heights and a customer busbar beside a NAR", () => {
    const gap = r4Board([mod("a", "ZH3EL27", 0, 0), mod("d", "ZU37KS", 1, 0), mod("b", "ZH3EL27", 2, 0)]);
    expect(messageOf(gap, "encl.busbar_unjoined")).toMatchObject({
      level: "warn", scope: "",
      message: "Sammelschienen in Feld 1 und Feld 3 sind nicht verbunden: dazwischen liegt kein Feld mit Sammelschiene.",
    });
    const customer = r4Board([mod("m", "ZH3EL27", 0, 0), mod("s", "ZH3ES5", 1, 0)]);
    expect(messageOf(customer, "encl.busbar_role")).toMatchObject({
      level: "info", scope: "s",
      message: "Sammelschiene in Feld 2 ist Kundenverteilung (gezählt) und wird nicht mit dem NAR von Feld 1 verbunden.",
    });
    // The pre-R4-9 stack (SAS on top) holding an SLS: main, but not level with the NAR.
    const top = MODULES.ZH3ES5.zones.map((zone) => (zone.type === "SAS" ? { ...zone, unit: 0 } : { ...zone, unit: 2 }));
    const old = indexWith({ ZH3ES5: { ...MODULES.ZH3ES5, zones: top } });
    const high = r4Board([mod("m", "ZH3EL27", 0, 0), mod("s", "ZH3ES5", 1, 0, { sas: "sas" })], [row("sas", [dev("sls")])]);
    expect(messageOf(high, "encl.busbar_unjoined", old)?.message).toBe("Sammelschienen in Feld 1 und Feld 2 liegen nicht auf gleicher Höhe.");
  });

  it("name the role between a busbar gap and the customer busbars of two meters", () => {
    const between = r4Board([mod("a", "ZH3EL27", 0, 0), mod("s", "ZH3ES5", 1, 0), mod("b", "ZH3EL27", 2, 0)]);
    expect(messageOf(between, "encl.busbar_unjoined")?.message).toBe(
      "Sammelschienen in Feld 1 und Feld 3 sind nicht verbunden: dazwischen liegt Kundenverteilung (gezählt), keine Hauptleitung.",
    );
    const two = boardDocument("two_meters_busbar_zb34s");
    expect(messageOf(two, "encl.busbar_meters", FIXTURE_INDEX)).toMatchObject({
      level: "info", scope: "", message: "Sammelschienen in Feld 3 und Feld 4 gehören zu verschiedenen Zählern und werden nicht verbunden.",
    });
    expect(enclosureFindings(two, FIXTURE_INDEX).map((finding) => finding.rule)).not.toContain("encl.busbar_unjoined");
  });

  it("name a conductor too small for any clamp and trim a pasted fuse and BMK like the server", () => {
    const meter = [mod("m", "ZH3EH16", 0, 0, { nar: "n" })];
    const small = r4Board(meter, undefined, { supply: { incoming: "NYM-J 5x1,5" }, prep: { infeed: "clamps" } });
    expect(messageOf(small, "encl.infeed_small")?.message).toBe(
      "Zuleitung 1,5 mm²: keine Sammelschienenklemme für 12×5 mm in diesem Querschnitt — Einspeiseadapter K96ESA5 verwenden.",
    );
    const pasted = r4Board(meter, [row("n", [dev("sls"), dev("mcb", { rating: "B6", designation: "\ufeff" })])],
      { supply: { incoming: "", fuse: "\ufeffNH00 160 A\u001c" } });
    expect(messageOf(pasted, "encl.infeed_fuse")?.message).toBe(
      "Einspeiseadapter K96ESA5 nur hinter höchstens NH00 gG 100 A: Vorsicherung „NH00 160 A“ prüfen.",
    );
    expect(messageOf(pasted, "encl.supply_existing")?.message).toMatch(/^Spannungsabgriff bereits geplant \(LS, F1 · NAR\)/);
  });

  it("name an existing tap, an assumed infeed, its fuse, an oversized infeed and the PEN split", () => {
    const meter = [mod("m", "ZH3EH16", 0, 0, { nar: "n" })];
    const tap = r4Board(meter, [row("n", [dev("sls"), dev("mcb", { rating: "B6", designation: "F9" })])]);
    expect(messageOf(tap, "encl.supply_existing")?.message).toBe(
      "Spannungsabgriff bereits geplant (F9, F1 · NAR) — Bestückungspaket nicht ergänzt; Leitungen zu RfZ/APZ prüfen.",
    );
    const hot = r4Board(meter, undefined, { supply: { incoming: "", fuse: " NH 125 A " } });
    expect(messageOf(hot, "encl.infeed_assumed")?.message).toBe(
      "Querschnitt der Zuleitung unbekannt: Einspeiseadapter K96ESA5 (bis 25 mm²) angenommen. Im Tab Daten bei „Zuleitung“ eintragen.",
    );
    expect(messageOf(hot, "encl.infeed_fuse")).toMatchObject({
      level: "warn", message: "Einspeiseadapter K96ESA5 nur hinter höchstens NH00 gG 100 A: Vorsicherung „NH 125 A“ prüfen.",
    });
    expect(rulesOf(r4Board(meter, undefined, { supply: { fuse: "NH 125 A" }, prep: { infeed: "off" } }))).not.toContain("encl.infeed_fuse");
    expect(rulesOf(r4Board(meter, undefined, { supply: { incoming: "NYY-J 5x50", fuse: "NH 125 A" } }))).not.toContain("encl.infeed_fuse");
    const big = r4Board(meter, undefined, { supply: { incoming: "NYY-J 5x240" } });
    expect(messageOf(big, "encl.infeed_size")?.message).toBe(
      "Zuleitung 240 mm²: keine Sammelschienenklemme für 12×5 mm bis 185 mm² — Einspeisung gesondert planen.",
    );
    const pen = r4Board(meter, undefined, { supply: { system: "TN-C-S", incoming: "NYY-J 4x35" } });
    expect(messageOf(pen, "encl.pen_split")?.message).toBe("Zuleitung 4-adrig im TN-C-S-System: PEN im NAR von Feld 1 in PE und N aufteilen.");
  });

  it("name a cabinet height without a Hager supply kit", () => {
    const catalog = testCatalog();
    const odd = { ...CABINETS.ZB33S, code: "ZB3XS", article_no: "ZB3XS", height_mm: 950 };
    const index = catalogIndex({ ...catalog, enclosures: [...catalog.enclosures, { ...catalog.enclosures[0], code: "ZB3XS", spec: odd }] });
    const doc = { ...r4Board([mod("m", "ZH3EH16", 0, 0)]), enclosure: { code: "ZB3XS", modules: [mod("m", "ZH3EH16", 0, 0)] } };
    expect(messageOf(doc, "encl.supply_height", index)).toMatchObject({
      level: "warn", scope: "",
      message: "Spannungsversorgung RfZ/APZ: Schrankhöhe 950 mm nicht im Hager-Programm — Bestückungspaket selbst wählen.",
    });
  });

  it("never throw on a garbage block, prep or supply", () => {
    const meter = [mod("m", "ZH3EH16", 0, 0)];
    for (const parts of [{ block: "x" }, { block: { terminals: [null, 5] } }, { prep: { supply: 7 } as never }]) {
      expect(() => enclosureFindings(r4Board(meter, undefined, parts), INDEX)).not.toThrow();
    }
    const noSupply = { ...r4Board(meter), supply: undefined } as unknown as PanelDocument;
    expect(() => enclosureFindings(noSupply, INDEX)).not.toThrow();
  });
});
