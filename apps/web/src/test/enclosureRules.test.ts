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
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { BOARD_NAMES, FIXTURE_BOARDS, FIXTURE_INDEX } from "./enclosureFixtureBoards";
import { board, dev, INDEX, row } from "./enclosureTestCatalog";

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
    expect(RULE_ORDER).toHaveLength(25);
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
