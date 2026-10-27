/**
 * Cabinet preparation (docs/PANEL_ENCLOSURE_R4.md §2.2, §3.3–§3.5) — the
 * TypeScript twin of `panel_enclosure_prep.py` and `cable_section_parse.py`.
 *
 * Parity first: the parser tables and every fixture board's `cabinet_prep`.
 * Then the overrides, the infeed matrix, the roles and joints, the runs and
 * the wire metres on fixture boards edited per case (deep copies).
 */
import { describe, expect, it } from "vitest";

import { parseCableSection } from "../utils/cableSectionParse";
import { defaultControlBlock } from "../utils/enclosureControlBlock";
import {
  HAGER_NETWORK_TABLE,
  busbarZones,
  cabinetPrep,
  jointPairs,
  makeRun,
  parseFuseAmps,
  parseInfeed,
  parsePrep,
  ratingValue,
  wireDm,
} from "../utils/enclosurePrep";
import { edgeTrimmed } from "../utils/edgeTrim";
import type { CabinetPrep, EnclosureModule, PrepItem } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { BOARD_NAMES, FIXTURE_BOARDS, FIXTURE_INDEX, FIXTURE_TABLES, boardDocument } from "./enclosureFixtureBoards";
import { board, deepFreeze, dev, INDEX, row } from "./enclosureTestCatalog";

const mod = (id: string, code: string, field: number, unit: number, rails: Record<string, string> = {}): EnclosureModule => ({
  id, code, field, unit, label: "", rails, fittings: null, removed_fittings: [], meters: [],
});

/** The eHZ fixture board with `prep`, `incoming` or the block changed. */
function ehz(change: { prep?: unknown; incoming?: string; block?: unknown } = {}): PanelDocument {
  const doc = boardDocument("control_ehz_zb33s");
  const enclosure = { ...doc.enclosure!, ...(change.prep !== undefined ? { prep: change.prep as never } : {}) };
  if (change.block !== undefined) enclosure.control_block = change.block as never;
  const supply = change.incoming !== undefined ? { ...doc.supply, incoming: change.incoming } : doc.supply;
  return { ...doc, supply, enclosure };
}

const prepOf = (doc: PanelDocument, index = FIXTURE_INDEX): CabinetPrep => cabinetPrep(doc, index)!;
const itemOf = (prep: CabinetPrep, prefix: string): PrepItem | undefined => prep.items.find((item) => item.key.startsWith(prefix));

describe("parity with the Python twin (enclosureFixtures.json)", () => {
  it.each(FIXTURE_TABLES.prep_parse.map((entry, i) => [i, entry] as const))("prep_parse #%i", (_i, entry) => {
    expect(parsePrep(entry.input)).toEqual(entry.output);
  });

  it.each(FIXTURE_TABLES.infeed_parse.map((entry) => [entry.input, entry] as const))("infeed_parse %j", (_input, entry) => {
    expect(parseInfeed(entry.input)).toEqual(entry.output);
    expect(parseCableSection(entry.input)).toEqual(entry.output);
  });

  it.each(FIXTURE_TABLES.fuse_parse.map((entry) => [entry.input, entry] as const))("fuse_parse %j", (_input, entry) => {
    expect(parseFuseAmps(entry.input)).toEqual(entry.output);
  });

  // ASCII digits only on both sides: "B１０" is no 10 A tap in either twin.
  it.each(FIXTURE_TABLES.rating_parse.map((entry, i) => [i, entry] as const))("rating_parse #%i", (_i, entry) => {
    expect(ratingValue(entry.input)).toEqual(entry.output);
  });

  // One explicit edge set: Python strip() and JS trim() disagree on U+FEFF, U+001C–U+001F, U+0085.
  it.each(FIXTURE_TABLES.edge_trim.map((entry, i) => [i, entry] as const))("edge_trim #%i", (_i, entry) => {
    expect(edgeTrimmed(entry.input)).toEqual(entry.output);
  });

  it.each(BOARD_NAMES)("%s: the cabinet preparation", (name) => {
    const fixture = FIXTURE_BOARDS[name];
    expect(cabinetPrep(fixture.document, FIXTURE_INDEX)).toEqual(fixture.prep);
  });
});

describe("the parsers", () => {
  it("never throw on anything", () => {
    for (const value of [null, undefined, 5, {}, [], "x"]) {
      expect(parseInfeed(value)).toEqual({ mm2: null, cores: null, aluminium: false });
      expect(parseFuseAmps(value)).toBeNull();
    }
  });

  it("read odd spaces as spaces", () => {
    expect(parseInfeed("NYY-J 5×25 mm²")).toEqual({ mm2: 25, cores: 5, aluminium: false });
    expect(parseFuseAmps("NH00 100 A")).toBe(100);
  });
});

describe("cabinetPrep", () => {
  it("is null for an unknown cabinet and empty without meter or busbar fields", () => {
    expect(cabinetPrep(board([]), INDEX)).toBeNull();
    expect(cabinetPrep(board([], { code: "ZB99", modules: [] }), INDEX)).toBeNull();
    expect(cabinetPrep(board([], { code: "ZB33S", modules: [mod("d", "ZU37KS", 0, 0)] }), INDEX)).toEqual({
      items: [], runs: [], infeed: null,
      overrides: { supply: "auto", infeed: "auto", joints: "auto", network: "auto", network_m: null },
    });
  });

  it("never mutates the document", () => {
    for (const name of BOARD_NAMES) {
      const doc = deepFreeze(boardDocument(name));
      expect(() => cabinetPrep(doc, FIXTURE_INDEX)).not.toThrow();
    }
  });

  it("gives every item the same keys", () => {
    const keys = ["articleNo", "group", "key", "label", "override", "qty", "reason", "suppressed", "unit", "verified"];
    for (const name of BOARD_NAMES) {
      for (const item of cabinetPrep(FIXTURE_BOARDS[name].document, FIXTURE_INDEX)?.items ?? []) expect(Object.keys(item).sort()).toEqual(keys);
    }
  });
});

describe("(a) Spannungsversorgung", () => {
  it("offers SABO, LS and Sicherungsbox kits", () => {
    const ls = itemOf(prepOf(ehz({ prep: { supply: "LS" } })), "accessory:ZY")!;
    expect(ls).toMatchObject({
      key: "accessory:ZY3N2LS", articleNo: "ZY3N2LS", override: "LS", suppressed: false, qty: 1,
      label: "Bestückungspaket Spannungsversorgung APZ/RfZ, Sammelschienen-LS 6 A, Bauhöhe 1100 mm",
      reason: "Spannungsversorgung SMGW/Steuerbox: LS 6 A im NAR von Feld 1, Leitungen zum RfZ Feld 1 und APZ Feld 3",
    });
    const si = prepOf(ehz({ prep: { supply: "SI" } }));
    expect(itemOf(si, "accessory:ZY")).toMatchObject({
      key: "accessory:ZY3R2SI",
      label: "Bestückungspaket Spannungsversorgung APZ/RfZ, Sicherungsbox 1 A im RfZ, Bauhöhe 1100 mm",
      reason: "Spannungsversorgung SMGW/Steuerbox: Sicherungsbox 1 A im RfZ, Abgriff im NAR von Feld 1, Leitungen zum RfZ Feld 1 und APZ Feld 3",
    });
    expect(si.runs.filter((run) => run.kind === "supply").map((run) => run.label)).toEqual([
      "ZY3R2SI · Sicherungsbox 1 A → RfZ", "ZY3R2SI · Sicherungsbox 1 A → APZ",
    ]);
  });

  it("strikes a kit switched off and draws no supply runs", () => {
    const prep = prepOf(ehz({ prep: { supply: "off" } }));
    expect(itemOf(prep, "accessory:ZY")).toMatchObject({ key: "accessory:ZY3N2SA", qty: 0, suppressed: true, override: "off" });
    expect(prep.runs.some((run) => run.kind === "supply")).toBe(false);
  });

  it("adds no kit where a small LS already taps the NAR, in auto only", () => {
    const doc = ehz();
    const tapped = {
      ...doc,
      rows: doc.rows.map((r) => (r.id === "row-a-nar" ? { ...r, devices: [...r.devices, dev("mcb", { rating: "B6", designation: "F9" })] } : r)),
    };
    expect(itemOf(prepOf(tapped), "accessory:ZY")).toMatchObject({
      qty: 0, suppressed: true, override: "auto", reason: "Spannungsabgriff bereits geplant (F9, F1 · NAR)",
    });
    const forced = { ...tapped, enclosure: { ...tapped.enclosure!, prep: parsePrep({ supply: "SA" }) } };
    expect(itemOf(prepOf(forced), "accessory:ZY")).toMatchObject({ qty: 1, suppressed: false, override: "SA" });
  });
});

describe("(b) Einspeisung", () => {
  it.each([
    ["NYY-J 5x95", null, "K96H", 5, "Zuleitung 95 mm² > 25 mm²: eine Klemme je Leiter"],
    ["NAYY-J 4x50", null, "K96N", 4, "Zuleitung 50 mm² Al > 25 mm²: eine Klemme je Leiter"],
    ["", null, "K96ESA5", 1, "Querschnitt unbekannt — angenommen"],
    ["NYY-J 5x50 mm²", "K96ESA5", "K96ESA5", 1, "Einspeiseadapter manuell gewählt · Zuleitung 50 mm²"],
    ["", "clamps", "K96F", 5, "Querschnitt unbekannt: eine Klemme je Leiter"],
    // Forced clamps on a small Cu infeed: K96C (2,5–35 mm²), never K96F (from 25 mm²).
    ["NYY-J 5x16", "clamps", "K96C", 5, "Zuleitung 16 mm²: eine Klemme je Leiter"],
    ["NYY-J 5x10", "clamps", "K96C", 5, "Zuleitung 10 mm²: eine Klemme je Leiter"],
    ["NYY-J 5x25", "clamps", "K96F", 5, "Zuleitung 25 mm²: eine Klemme je Leiter"],
  ])("%j with %s → %s × %i", (incoming, choice, article, qty, reason) => {
    const prep = prepOf(ehz({ incoming, prep: choice ? { infeed: choice } : undefined }));
    expect(itemOf(prep, `accessory:${article}`)).toMatchObject({ articleNo: article, qty, reason, group: "busbar" });
    expect(prep.infeed?.article).toBe(article);
  });

  it.each([false, true])("chooses only clamps whose range holds the conductor (aluminium %s)", (aluminium) => {
    for (const mm2 of [1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185]) {
      const incoming = `${aluminium ? "NAYY-J" : "NYY-J"} 5x${String(mm2).replace(".", ",")}`;
      const prep = prepOf(ehz({ incoming, prep: { infeed: "clamps" } }));
      const clamp = prep.items.find((item) => item.group === "busbar" && item.key !== "accessory:ZZ55SAVE" && item.key !== "prep:pen_split");
      if (!clamp) {
        expect(mm2).toBeLessThan(aluminium ? 10 : 2.5);
        continue;
      }
      const [, low, high] = /Sammelschienenklemme ([0-9,]+)–([0-9,]+) mm²/.exec(clamp.label)!.map((v) => Number(v.replace(",", ".")));
      expect(low <= mm2 && mm2 <= high, `${incoming} → ${clamp.articleNo}`).toBe(true);
    }
  });

  it("finds no clamp above 185 mm² and keeps the automatic article when switched off", () => {
    const big = prepOf(ehz({ incoming: "NYY-J 5x240" }));
    expect(big.items.some((item) => item.group === "busbar" && item.key !== "accessory:ZZ55SAVE")).toBe(false);
    expect(big.infeed).toEqual({ mm2: 240, cores: 5, aluminium: false, article: null, assumed: false });
    const off = prepOf(ehz({ prep: { infeed: "off" } }));
    expect(itemOf(off, "accessory:K96ESA5")).toMatchObject({ qty: 0, suppressed: true, override: "off" });
  });

  it("assumes the adapter only as the automatic guess", () => {
    expect(prepOf(ehz({ incoming: "" })).infeed?.assumed).toBe(true);
    expect(prepOf(ehz({ incoming: "", prep: { infeed: "K96ESA5" } })).infeed?.assumed).toBe(false);
  });
});

describe("(c) Sammelschienenverbinder, roles and runs", () => {
  it("joins same-role neighbours at the same height only", () => {
    const cabinet = (modules: EnclosureModule[], rows = board([]).rows) => board(rows, { code: "ZB33S", modules });
    const meterAndSas = [mod("m", "ZH3EL27", 0, 0), mod("s", "ZH3ES5", 1, 0, { sas: "sas" })];
    const customer = cabinet(meterAndSas);
    expect(busbarZones(customer, INDEX).map((zone) => [zone.moduleId, zone.role])).toEqual([["m", "main"], ["s", "customer"]]);
    expect(jointPairs(busbarZones(customer, INDEX))).toEqual([]);
    const withSls = cabinet(meterAndSas, [row("sas", [dev("sls")])]);
    expect(jointPairs(busbarZones(withSls, INDEX))).toEqual([{ role: "main", left: 0, right: 1 }]);
    const twoMeters = cabinet([mod("a", "ZH3EL27", 0, 0), mod("b", "ZH3EL22", 1, 0), mod("c", "ZH3EH16", 2, 0)]);
    expect(itemOf(prepOf(twoMeters, INDEX), "accessory:ZZ55SAVE")).toMatchObject({ qty: 2, reason: "2 Feldübergänge: Feld 1–2, Feld 2–3" });
  });

  it("never joins the customer busbars of two meters and checks a joint whose meter is unknown", () => {
    const zones = busbarZones(boardDocument("two_meters_busbar_zb34s"), FIXTURE_INDEX);
    expect(zones.map((zone) => [zone.field, zone.role, zone.meters])).toEqual([
      [0, "main", []], [1, "main", []], [2, "customer", ["mod-m1"]], [3, "customer", ["mod-m2"]],
    ]);
    expect(jointPairs(zones)).toEqual([{ role: "main", left: 0, right: 1 }]);
    const sameMeter = boardDocument("two_meters_busbar_zb34s");
    const fi = sameMeter.rows.find((r) => r.id === "row-s2")!.devices.find((d) => d.id === "dev-s2-f2")!;
    fi.parent_id = "dev-m1-q1";
    expect(itemOf(prepOf(sameMeter), "accessory:ZZ55SAVE")).toMatchObject({ qty: 2, verified: true, reason: "2 Feldübergänge: Feld 1–2, Feld 3–4" });
    const empty = boardDocument("two_meters_busbar_zb34s");
    empty.rows = empty.rows.map((r) => (r.id === "row-s2" ? { ...r, devices: [] } : r));
    expect(itemOf(prepOf(empty), "accessory:ZZ55SAVE")).toMatchObject({
      qty: 2, verified: false, reason: "2 Feldübergänge: Feld 1–2, Feld 3–4 · Feld 3–4: Zähler prüfen",
    });
  });

  it("strikes the joints when switched off", () => {
    expect(itemOf(prepOf(ehz({ prep: { joints: "off" } })), "accessory:ZZ55SAVE")).toMatchObject({ qty: 0, suppressed: true, override: "off" });
  });

  it("runs go vertical first, drop repeated points and measure the unrounded ends", () => {
    expect(makeRun("control", [1.04, 2], [3, 4.06], "x")).toEqual({
      kind: "control", from: [1, 2], to: [3, 4.1], points: [[1, 2], [1, 4.1], [3, 4.1]], label: "x", lengthMm: 4,
    });
    expect(makeRun("supply", [0.04, 0], [0.04, 10.06], "")).toMatchObject({ points: [[0, 0], [0, 10.1]], lengthMm: 10.1 });
  });
});

describe("(d) Netzwerkleitung", () => {
  it("takes a stored length, else Hager's table", () => {
    expect(itemOf(prepOf(ehz()), "accessory:ZZ45WAN")).toMatchObject({ articleNo: "ZZ45WAN100", verified: true });
    const stored = itemOf(prepOf(ehz({ prep: { network_m: 1.5 } })), "accessory:ZZ45WAN")!;
    expect(stored).toMatchObject({
      articleNo: "ZZ45WAN150", verified: true, label: "Patch-Leitung RJ45 Cat 5e, spannungsfest, 1,5 m",
      reason: "APZ (Feld 3) → RfZ über dem Zähler (Feld 1) · Länge 1,5 m vorgegeben",
    });
    expect(itemOf(prepOf(ehz({ prep: { network_m: 0.5 } })), "accessory:ZZ45WAN")).toMatchObject({
      articleNo: "ZZ45WAN100", reason: "APZ (Feld 3) → RfZ über dem Zähler (Feld 1) · Länge 0,5 m vorgegeben",
    });
    expect(itemOf(prepOf(ehz({ prep: { network_m: 6 } })), "accessory:ZZ45WAN")).toMatchObject({
      articleNo: "ZZ45WAN500", label: "Patch-Leitung RJ45 Cat 5e, spannungsfest, 5 m",
      reason: "APZ (Feld 3) → RfZ über dem Zähler (Feld 1) · Länge 6 m vorgegeben · länger als 5 m",
    });
  });

  it("strikes the lead and drops its run when switched off", () => {
    const prep = prepOf(ehz({ prep: { network: "off" } }));
    expect(itemOf(prep, "accessory:ZZ45WAN")).toMatchObject({ qty: 0, suppressed: true });
    expect(prep.runs.some((run) => run.kind === "network")).toBe(false);
  });

  it("keeps Hager's Bestelltabelle", () => {
    expect(HAGER_NETWORK_TABLE).toEqual({
      "meter_ehz|1100|bottom": ["ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200"],
      "meter_ehz|1100|top": ["ZZ45WAN040", "ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150"],
      "meter_3p|1100|bottom": ["ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200"],
      "meter_3p|1100|top": ["ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN150", "ZZ45WAN200"],
      "meter_3p|1400|bottom": ["ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200", "ZZ45WAN200"],
      "meter_3p|1400|top": ["ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN150", "ZZ45WAN200"],
    });
  });
});

describe("(e) §14a block, wires and Lüsterklemme", () => {
  it("measures wire decimetres in 0,5 m steps, or takes the stored length", () => {
    expect(wireDm(null, 382.9)).toBe(10);
    expect(wireDm(null, 1164.5)).toBe(15);
    expect(wireDm(null, 0)).toBe(5);
    expect(wireDm(1.2, 9999)).toBe(12);
    expect(wireDm(2.25, 0)).toBe(23);
  });

  it("lists nothing of the block when it is removed or absent", () => {
    for (const block of [{ ...defaultControlBlock(), off: true }, null]) {
      const prep = prepOf(ehz({ block }));
      expect(prep.items.some((item) => item.group === "control")).toBe(false);
      expect(prep.runs.some((run) => run.kind === "control")).toBe(false);
    }
  });

  it("plans whole metres per colour", () => {
    const block = { ...defaultControlBlock(), wire_length_m: 1.2, terminals: defaultControlBlock().terminals.map((t) => ({ ...t, color: "rot" })) };
    const wires = prepOf(ehz({ block })).items.filter((item) => item.key.startsWith("wire:"));
    expect(wires).toHaveLength(1);
    expect(wires[0]).toMatchObject({
      key: "wire:h07vk:2.5:rot", qty: 8, unit: "m", articleNo: null,
      reason: "UNSM, 60%, 30%, 0%, UStve, Stve · Klemmleiste → RfZ · ≈ 1,2 m je Ader",
    });
  });
});
