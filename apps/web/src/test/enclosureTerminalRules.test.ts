/**
 * The ten WAGO terminal findings of a cabinet board
 * (docs/PANEL_ENCLOSURE_R2.md §4.1) and the sentences the suggestion pass
 * (§4.2) appends to them — the TS twin of
 * `apps/api/tests/test_panel_enclosure_terminal_rules.py`.
 *
 * Each rule is shown firing with its exact German text and staying silent
 * on the compliant reference board; the fixture pins the rest through
 * `findings`. Owner answers of 2026-10-22: no end stops; the 210 mm usable
 * length stays an unverified assumption, so "passt nicht" is info until the
 * flag is flipped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { enclosureFindings, RULE_ORDER } from "../utils/enclosureRules";
import { boardTerminals, placeTerminals } from "../utils/enclosureTerminals";
import { TERMINAL_RULE_ORDER, terminalFindings } from "../utils/enclosureTerminalRules";
import type { PanelDocument } from "../types/schaltplan";
import { FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import {
  doc,
  elsewhereFirstZb53s,
  fi,
  fullFieldZb32s,
  halfVacateZb32s,
  lostPlaceZb32s,
  ls,
  mod,
  row,
  scatteredVacateZb33s,
  spillZb53s,
  stillShortZb32s,
  supplyOverflowZb32s,
} from "./enclosureTerminalBoards";
import { deepFreeze } from "./enclosureTestCatalog";

const INDEX = FIXTURE_INDEX;
const ASSUMED = ", Nutzlänge 210 mm je Hutschiene angenommen";
const NO_THIRD = " — eine dritte Hutschiene wird nicht belegt.";
const RESERVED = "Hutschiene ist für Reihenklemmen reserviert — 1 Gerät(e) tiefer setzen.";

type Entry = [level: string, scope: string, message: string];
const byText = (a: Entry, b: Entry): number => (a.join("\u0000") < b.join("\u0000") ? -1 : a.join("\u0000") > b.join("\u0000") ? 1 : 0);
const rule = (document: PanelDocument, name: string): Entry[] =>
  terminalFindings(document, INDEX)
    .filter((finding) => finding.rule === name)
    .map((finding): Entry => [finding.level, finding.scope, finding.message])
    .sort(byText);
const messages = (document: PanelDocument, name: string): string[] => rule(document, name).map(([, , message]) => message);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the rule order", () => {
  it("puts the ten rules where the old one was", () => {
    expect(TERMINAL_RULE_ORDER).toEqual([
      "encl.terminals", "encl.terminals_overflow", "encl.terminal_order_ignored", "encl.terminal_rail_devices",
      "encl.terminal_placeholders", "encl.terminals_elsewhere", "encl.terminals_no_field", "encl.terminals_split",
      "encl.terminals_head_field", "encl.terminals_zone",
    ]);
    const start = RULE_ORDER.indexOf("encl.terminals");
    expect(RULE_ORDER.slice(start, start + 10)).toEqual(TERMINAL_RULE_ORDER);
    // Round 4 (R4 §4) put the fifteen prep rules between the meter places and these.
    expect([RULE_ORDER[start - 1], RULE_ORDER[start + 10]]).toEqual(["encl.pen_split", "vde.nar_sls"]);
  });
});

describe("each rule", () => {
  it("only states the terminals of the compliant board", () => {
    const findings = terminalFindings(boardDocument("meter_dist_zb33s"), INDEX);
    expect(findings).toEqual([
      { level: "info", scope: "", rule: "encl.terminals", message: "Feld 2: 4 Reihenklemmen auf den oberen Hutschienen, 30,7 von 420 mm belegt." },
      { level: "info", scope: "", rule: "encl.terminals", message: "Feld 3: 3 Reihenklemmen auf den oberen Hutschienen, 25,5 von 420 mm belegt." },
    ]);
  });

  it("no longer says the terminals are not drawn", () => {
    for (const name of ["meter_dist_zb33s", "terminals_zb34s", "terminals_rk_zb53s", "terminals_overflow_zb32s"]) {
      expect(enclosureFindings(boardDocument(name), INDEX).some((finding) => finding.message.includes("nicht gezeichnet"))).toBe(false);
    }
  });

  it("states the owner board's fields and waits for the vacate before suggesting a move", () => {
    const document = boardDocument("terminals_zb34s");
    expect(messages(document, "encl.terminals")).toEqual([
      "Feld 2: 29 Reihenklemmen auf den oberen Hutschienen, 372,2 von 420 mm belegt.",
      "Feld 4: 57 Reihenklemmen auf den oberen Hutschienen, 377,7 von 420 mm belegt.",
    ]);
    expect(rule(document, "encl.terminals_overflow")).toEqual([[
      "info", "mod-k",
      `Feld 2: 3 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (183,3 mm ohne Platz${ASSUMED})${NO_THIRD}` +
        " Zuerst die reservierten Hutschienen räumen (Vorschlag „umhängen“) — danach passen alle Klemmleisten.",
    ]]);
    const vacate = " Vorschlag: Reihen auf F3 · Verteiler 3 und F3 · Verteiler 4 umhängen.";
    expect(rule(document, "encl.terminal_rail_devices")).toEqual([
      ["warn", "row-old1", `F2 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert — 5 Gerät(e) tiefer setzen.${vacate}`],
      ["warn", "row-old2", `F2 · Verteiler 2: Hutschiene ist für Reihenklemmen reserviert — 3 Gerät(e) tiefer setzen.${vacate}`],
    ]);
    expect(rule(document, "encl.terminal_placeholders")).toEqual([[
      "info", "row-old2",
      "F2 · Verteiler 2: 1 Platzhalter-Reihenklemme(n) — Reihenklemmen werden jetzt aus den Stromkreisen abgeleitet.",
    ]]);
    expect(rule(document, "encl.terminals_zone")).toEqual([
      ["info", "dev-aar-ls1", "F0.1: im AAR — keine Reihenklemme (nur in Verteilerfeldern)."],
    ]);
    for (const name of ["encl.terminal_order_ignored", "encl.terminals_elsewhere", "encl.terminals_no_field",
      "encl.terminals_split", "encl.terminals_head_field"]) {
      expect(rule(document, name), name).toEqual([]);
    }
  });

  it("names the RK board's ignored order, the strip sent elsewhere, the split and the head fields", () => {
    const document = boardDocument("terminals_rk_zb53s");
    expect(rule(document, "encl.terminal_order_ignored")).toEqual([
      ["info", "mod-r", "Feld 2: Die manuelle Aufteilung der Klemmleisten passt nicht mehr — automatisch verteilt."],
    ]);
    expect(rule(document, "encl.terminals_elsewhere")).toEqual([
      ["info", "", "Feld 1 hat keine Hutschienen für Reihenklemmen — X1 in Feld 2."],
    ]);
    expect(rule(document, "encl.terminals_split")).toEqual([
      ["info", "", "X7 (F5): Stromkreise in Feld 2 und 3 — Reihenklemmen in Feld 3."],
    ]);
    // The N feed crosses a field boundary wherever the terminals sit: F6's
    // pinned circuits, and F1's strip that R6 sent to the next field.
    expect(rule(document, "encl.terminals_head_field")).toEqual([
      ["info", "", "X1 (F1): Schutzgerät in Feld 1, Klemmen in Feld 2 — N-Zuleitung über die Feldgrenze."],
      ["info", "", "X5 (F6): Schutzgerät in Feld 2, Klemmen in Feld 3 — N-Zuleitung über die Feldgrenze."],
    ]);
    expect(messages(document, "encl.terminals")).toEqual([
      "Feld 2: 39 Reihenklemmen auf den oberen Hutschienen, 231,7 von 420 mm belegt.",
      "Feld 3: 14 Reihenklemmen auf den oberen Hutschienen, 126 von 420 mm belegt.",
    ]);
    expect(rule(document, "encl.terminals_zone")).toEqual([]);
    expect(rule(document, "encl.terminals_overflow")).toEqual([]);
  });

  it("lists three split fields with a comma and „und“", () => {
    const document = boardDocument("terminals_rk_zb53s");
    const add = (rowId: string, device: ReturnType<typeof ls>) => {
      const target = document.rows.find((candidate) => candidate.id === rowId)!;
      target.devices = [...target.devices, device];
    };
    add("row-x-sas", ls("dev-f5-9", "F5.9", "99", "Carport", { terminal_block: true, parent_id: "dev-f5" }));
    add("row-m-vf1", ls("dev-f5-8", "F5.8", "98", "Keller", { terminal_block: true, parent_id: "dev-f5" }));
    // Feld 1 counts, though it has no terminal rails: one of F5's circuits lies there.
    expect(messages(document, "encl.terminals_split")).toEqual(["X7 (F5): Stromkreise in Feld 1, 2 und 3 — Reihenklemmen in Feld 3."]);
  });

  it("lists strips without any field, at most four, then counts the rest", () => {
    const devices = [1, 2, 3, 4, 5, 6].flatMap((n) => [
      fi(`dev-g${n}`, `F${n}`), ls(`dev-g${n}-1`, `F${n}.1`, "", "x", { terminal_block: true }),
    ]);
    const outside = doc("ZB32S", [mod("mod-a", "ZU37KS", 0, {})], [row("row-x", "Reihe 9", devices)]);
    expect(rule(outside, "encl.terminals_no_field")).toEqual([
      ["info", "", "X1, X2, X3, X4 und 2 weitere: kein Platz für Reihenklemmen — Stromkreise nicht in einem Verteilerfeld."],
    ]);
    // A cabinet without any Verteilerfeld: a circuit in the AAR gets no terminal at all.
    const meterOnly = doc("ZB32S", [mod("mod-m", "ZH3EL27", 0, { aar1: "row-a" })], [
      row("row-a", "F1 · AAR 1", [fi("dev-f1", "F1"), ls("dev-l1", "F1.1", "1", "x", { terminal_block: true })]),
    ]);
    expect(rule(meterOnly, "encl.terminals_no_field")).toEqual([]);
    expect(rule(meterOnly, "encl.terminals_zone")).toEqual([["info", "dev-l1", "F1.1: im AAR — keine Reihenklemme (nur in Verteilerfeldern)."]]);
  });

  it("names a home field on a board with no terminal rails at all like no field", () => {
    const document = doc("ZB54S", [mod("mod-m", "ZH5EL27", 0, { vf1: "row-v" })], [
      row("row-v", "F1 · Verteilerfeld 1", [fi("dev-f1", "F1"), ls("dev-l1", "F1.1", "1", "x", { terminal_block: true })]),
    ]);
    expect(messages(document, "encl.terminals_no_field")).toEqual(["X1: kein Platz für Reihenklemmen — Stromkreise nicht in einem Verteilerfeld."]);
    expect(rule(document, "encl.terminals_elsewhere")).toEqual([]);
  });

  it("sends the tall board's VF strip over and flags its old row", () => {
    const document = boardDocument("tall_zb54s");
    expect(messages(document, "encl.terminals_elsewhere")).toEqual(["Feld 1 hat keine Hutschienen für Reihenklemmen — X1 in Feld 3."]);
    expect(rule(document, "encl.terminal_rail_devices")).toEqual([[
      "warn", "row-s-r1",
      "F3 · Verteiler 1: Hutschiene ist für Reihenklemmen reserviert — 3 Gerät(e) tiefer setzen. Vorschlag: Reihe auf F3 · Verteiler 3 umhängen.",
    ]]);
  });
});

describe("the overflow level", () => {
  afterEach(() => {
    vi.doUnmock("../utils/enclosureTerminals");
    vi.resetModules();
  });

  it("turns into a warning once the usable length is measured", async () => {
    vi.resetModules();
    vi.doMock("../utils/enclosureTerminals", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../utils/enclosureTerminals")>()),
      TERMINAL_RAIL_USABLE_VERIFIED: true,
    }));
    const fresh = await import("../utils/enclosureTerminalRules");
    const overflow = fresh.terminalFindings(boardDocument("terminals_overflow_zb32s"), INDEX).filter((f) => f.rule === "encl.terminals_overflow");
    expect(overflow).toHaveLength(1);
    expect(overflow[0].level).toBe("warn");
    expect(overflow[0].message).not.toContain("Nutzlänge");
    expect(overflow[0].message.startsWith("Feld 1: 1 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (71,5 mm ohne Platz)")).toBe(true);
  });
});

describe("the sentences of the suggestion pass", () => {
  it("says when a reserved row has nowhere to go", () => {
    const nowhere = " Keine leere Hutschiene frei — Geräte einzeln wegziehen (gedrückt halten).";
    expect(messages(fullFieldZb32s(), "encl.terminal_rail_devices")).toEqual([
      `F1 · Verteiler 1: ${RESERVED}${nowhere}`,
      `F1 · Verteiler 2: ${RESERVED}${nowhere}`,
    ]);
  });

  it("spreads a vacate over two fields, and leaves one row without a rail", () => {
    const both = " Vorschlag: Reihen auf F2 · Verteiler 7 und F3 · Verteiler 7 umhängen.";
    expect(messages(scatteredVacateZb33s(), "encl.terminal_rail_devices")).toEqual([
      `F1 · Verteiler 1: ${RESERVED}${both}`, `F1 · Verteiler 2: ${RESERVED}${both}`,
    ]);
    expect(messages(halfVacateZb32s(), "encl.terminal_rail_devices")).toEqual([
      `F1 · Verteiler 1: ${RESERVED} Vorschlag: Reihe auf F2 · Verteiler 7 umhängen.`,
      `F1 · Verteiler 2: ${RESERVED} Keine leere Hutschiene frei — Geräte einzeln wegziehen (gedrückt halten).`,
    ]);
  });

  it("says what is still missing after vacating first", () => {
    expect(messages(stillShortZb32s(), "encl.terminals_overflow")).toEqual([
      `Feld 1: 1 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (71,5 mm ohne Platz${ASSUMED})${NO_THIRD}` +
        " Zuerst die reservierten Hutschienen räumen — danach fehlen noch 71,5 mm.",
    ]);
  });

  it("proposes moving the circuits", () => {
    expect(rule(boardDocument("terminals_overflow_zb32s"), "encl.terminals_overflow")).toEqual([[
      "info", "mod-o",
      `Feld 1: 1 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (71,5 mm ohne Platz${ASSUMED})${NO_THIRD}` +
        " Vorschlag: F5 mit 10 Stromkreis(en) nach F2 · Verteiler 3 verschieben.",
    ]]);
  });

  it("proposes two rails and skips the strip R6 brought in", () => {
    expect(messages(elsewhereFirstZb53s(), "encl.terminals_overflow")).toEqual([
      `Feld 2: 2 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (210,6 mm ohne Platz${ASSUMED})${NO_THIRD}` +
        " Vorschlag: F6 mit 11 Stromkreis(en) nach F3 · Verteiler 3 und F3 · Verteiler 4 verschieben.",
    ]);
  });

  it("proposes moving a group whose run spills over the field line (checked pinned, like the real op)", () => {
    const [message] = messages(spillZb53s(), "encl.terminals_overflow");
    expect(message.endsWith(" Vorschlag: F5 mit 10 Stromkreis(en) nach F2 · Verteiler 4 verschieben.")).toBe(true);
  });

  it("says when no other field has room", () => {
    const document = boardDocument("terminals_overflow_zb32s");
    const alone = { ...document, enclosure: { ...document.enclosure!, modules: document.enclosure!.modules.filter((m) => m.id !== "mod-e") } };
    const [message] = messages(alone, "encl.terminals_overflow");
    expect(message.endsWith(
      " Kein anderes Feld hat genug Platz — Verteilerfeld ergänzen oder bei einzelnen Stromkreisen „Reihenklemme“ abwählen.",
    )).toBe(true);
    // Also when the only other field would take the group but drop a strip it placed before.
    expect(messages(lostPlaceZb32s(), "encl.terminals_overflow")).toEqual([
      `Feld 1: 2 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (163,8 mm ohne Platz${ASSUMED})${NO_THIRD}` +
        " Kein anderes Feld hat genug Platz — Verteilerfeld ergänzen oder bei einzelnen Stromkreisen „Reihenklemme“ abwählen.",
    ]);
  });

  it("says when the strip is the supply group's", () => {
    expect(messages(supplyOverflowZb32s(), "encl.terminals_overflow")).toEqual([
      `Feld 1: 1 Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen (213,2 mm ohne Platz${ASSUMED})${NO_THIRD}` +
        " Stromkreise vor dem ersten Schutzgerät — einzeln in ein anderes Feld ziehen.",
    ]);
  });
});

describe("the entry point", () => {
  it("gives the same findings with the precomputed terms and placement", () => {
    const document = boardDocument("terminals_rk_zb53s");
    const terms = boardTerminals(document, INDEX);
    const placement = placeTerminals(document, INDEX, terms);
    expect(terminalFindings(document, INDEX, { terms, placement })).toEqual(terminalFindings(document, INDEX));
    expect(enclosureFindings(document, INDEX, { terms, placement })).toEqual(enclosureFindings(document, INDEX));
  });

  it("has no terminal findings without a cabinet", () => {
    expect(terminalFindings({ ...boardDocument("terminals_zb34s"), enclosure: null }, INDEX)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["an empty object", {}],
    ["modules and rows of the wrong type", { enclosure: { code: "ZB33S", modules: "x" }, rows: "y" }],
    ["a broken enclosure block around a reserved row", {
      ...doc("ZB33S", [], [row("r", "", [ls("d1", "F1", "1", "x")])]),
      enclosure: {
        code: "ZB33S",
        modules: [null, 5, { id: "m", code: "ZU37KS", field: "x", rails: { r1: "r", r2: 7 }, terminal_order: { 0: { strips: [1, null] } } }],
      },
    }],
  ])("never throws, and never has to give up, on %s", (_, garbage) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(Array.isArray(terminalFindings(garbage as PanelDocument, INDEX))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads broken rows as Python does (the server never stores such rows)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const garbage = {
      enclosure: { code: "ZB33S", modules: [{ id: "m", code: "ZU37KS", rails: { r1: "r" } }] },
      rows: [null, { id: "r", devices: [null, { kind: "mcb", terminal_block: true, poles: "x" }] }],
    };
    // Python's answer: the id-less breaker blocks the reserved rail, and its
    // terminal belongs to no field (a circuit without an id has no rail).
    expect(terminalFindings(garbage as unknown as PanelDocument, INDEX)).toEqual([
      { level: "warn", scope: "r", rule: "encl.terminal_rail_devices",
        message: `r: ${RESERVED} Vorschlag: Reihe auf F1 · Verteiler 3 umhängen.` },
      { level: "info", scope: "", rule: "encl.terminals_no_field",
        message: "X1: kein Platz für Reihenklemmen — Stromkreise nicht in einem Verteilerfeld." },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(Array.isArray(enclosureFindings(garbage as unknown as PanelDocument, INDEX))).toBe(true);
  });

  it.each<[string, unknown]>([["dict", { a: 1 }], ["list", [null]], ["list of text", ["row-x"]]])(
    "reads a rail entry that is no text (%s) past, as Python does: the same findings as without it",
    (_, junk) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      for (const name of ["terminals_zb34s", "terminals_overflow_zb32s"]) {
        const clean = boardDocument(name);
        const [first, ...rest] = clean.enclosure!.modules;
        const document = { ...clean, enclosure: { ...clean.enclosure!, modules: [{ ...first, rails: { ...first.rails, zz9: junk } }, ...rest] } };
        const findings = terminalFindings(document as unknown as PanelDocument, INDEX);
        expect(findings).toEqual(terminalFindings(clean, INDEX));
        expect(findings).not.toEqual([]);
      }
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("never mutates its inputs", () => {
    for (const name of ["terminals_zb34s", "terminals_rk_zb53s", "terminals_overflow_zb32s"]) {
      const document = deepFreeze(boardDocument(name));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect(terminalFindings(document, INDEX).length).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
