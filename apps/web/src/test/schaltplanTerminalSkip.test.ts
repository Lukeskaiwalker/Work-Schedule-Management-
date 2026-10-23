/**
 * Round 2 of the Reihenklemmen rules (docs/PANEL_ENCLOSURE_R2.md §3.1, §5.3):
 * the skip set every caller on a cabinet board passes, and the end plates
 * that close a terminal rail.
 *
 * A skipped device (a circuit on an AAR, NAR, RfZ or APZ rail) gets no
 * terminal whatever its flag says, and the X numbers run over what is left —
 * so the derivation, the legend and the strip-name check must all take the
 * same set, or the Klemmen tab, the legend and the print would disagree.
 * Twin of the skip and part-table cases in
 * `apps/api/tests/test_schaltplan_terminals.py`. (A file of its own: the
 * rule-by-rule `schaltplanTerminals.test.ts` is close to the size cap.)
 */
import { describe, expect, it } from "vitest";

import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import {
  END_PLATE_PART_IDS,
  RAIL_PART_IDS,
  TERMINAL_PARTS,
  TERMINAL_PART_ORDER,
  terminalChildren,
  terminalFindings,
} from "../utils/schaltplanTerminalRules";
import { deriveTerminals, terminalBom } from "../utils/schaltplanTerminals";
import { buildLegend, buildTopology, validateDocument } from "../utils/schaltplanTopology";
import type { PanelDocument } from "../types/schaltplan";

/** Numbered and cabled, so the only finding scoped to a breaker is the terminal rule's. */
const tb = { terminal_block: true, rating: "B16", cable: "NYM-J 3x2,5 mm²" };

/** F1 with three LS and a 2-pole LS, F2 with one LS, and a surge arrester whose BMK is "X2". */
function twoGroups(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 24,
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          makeDevice("mcb", { id: "a", circuit: "1", designation: "F1.1", ...tb }),
          makeDevice("mcb", { id: "b", circuit: "2", designation: "F1.2", ...tb }),
          makeDevice("mcb", { id: "e", circuit: "3", designation: "F1.3", poles: 2, ...tb }),
          makeDevice("rcd", { id: "f2", designation: "F2" }),
          makeDevice("mcb", { id: "d", circuit: "4", designation: "F2.1", ...tb }),
          makeDevice("spd", { id: "s", designation: "X2" }),
        ],
      },
    ],
  };
}

const ALL_OF_F1 = new Set(["a", "b", "e"]);

describe("the part table: end plates (§5.3)", () => {
  it("adds the two end plates as rail parts, verified, without a marker", () => {
    expect(TERMINAL_PARTS["2003-7692"]).toMatchObject({
      partNo: "WAGO 2003-7692", name: "Abschluss- und Zwischenplatte, 0,8 mm, orange", role: "rail_part",
      widthMm: 0.8, marker: false, verified: true, endPlate: null,
    });
    expect(TERMINAL_PARTS["2016-7691"]).toMatchObject({
      partNo: "WAGO 2016-7691", name: "Abschlussplatte, 1 mm, grau", role: "rail_part",
      widthMm: 1.0, marker: false, verified: true, endPlate: null,
    });
    expect([...END_PLATE_PART_IDS].sort()).toEqual(["2003-7692", "2016-7691"]);
    // Only the end plates close a rail: no WAGO 249-116 end stops (owner, 2026-10-22).
    expect([...RAIL_PART_IDS].sort()).toEqual(["2003-7692", "2016-7691"]);
  });

  it("maps every terminal block to the plate of its series; feed, end clamp and plates take none", () => {
    const plates = Object.fromEntries(TERMINAL_PART_ORDER.map((id) => [id, TERMINAL_PARTS[id].endPlate]));
    expect(plates).toEqual({
      "2003-7641": "2003-7692",
      "2003-7642": "2003-7692",
      "2003-7692": null,
      "2009-305": null,
      "2016-7601": "2016-7691",
      "2016-7604": "2016-7691",
      "2016-7607": "2016-7691",
      "2016-7691": null,
      "2016-7714": null,
    });
  });

  it("sorts the plates into the part order next to their series", () => {
    expect(TERMINAL_PART_ORDER).toEqual([
      "2003-7641", "2003-7642", "2003-7692", "2009-305", "2016-7601", "2016-7604", "2016-7607", "2016-7691", "2016-7714",
    ]);
  });
});

describe("the skip set (§3.1)", () => {
  it("removes skipped children and renumbers the X labels after them", () => {
    const document = twoGroups();
    const plain = deriveTerminals(document);
    expect(plain.flatMap((group) => group.strips.map((strip) => [strip.stripId, strip.xLabel]))).toEqual([
      ["f1:leiste", "X1"], ["f2:leiste", "X2"]]);
    const partial = deriveTerminals(document, new Set(["b"]));
    expect(partial[0].terminals.map((terminal) => terminal.deviceId)).toEqual(["f1", "a", "e", null]);
    const skipped = deriveTerminals(document, ALL_OF_F1);
    expect(skipped.flatMap((group) => group.strips.map((strip) => [strip.stripId, strip.xLabel]))).toEqual([["f2:leiste", "X1"]]);
    const [f1] = buildTopology(document);
    expect(terminalChildren(f1, new Set(["a"])).map((device) => device.id)).toEqual(["b", "e"]);
    expect(terminalChildren(f1).map((device) => device.id)).toEqual(["a", "b", "e"]);
  });

  it("drops a skipped device's pole finding", () => {
    const groups = buildTopology(twoGroups());
    expect(terminalFindings(groups).map((finding) => finding.scope)).toEqual(["e"]);
    expect(terminalFindings(groups, new Set(["e"]))).toEqual([]);
  });

  it("the legend and the strip-name check number the way the derivation does", () => {
    const document = twoGroups();
    const terminals = (skip?: ReadonlySet<string>) =>
      Object.fromEntries(buildLegend(document, skip).map((entry) => [entry.designation, entry.terminals]));
    expect(terminals()).toMatchObject({ "F1.1": "X1.1", "F2.1": "X2.1" });
    expect(terminals(ALL_OF_F1)).toMatchObject({ "F1.1": "", "F1.2": "", "F2.1": "X1.1" });
    const clash = (skip?: ReadonlySet<string>) =>
      validateDocument(document, skip).filter((finding) => finding.message.includes("so heißt auch eine Klemmleiste"));
    expect(clash().map((finding) => finding.scope)).toEqual(["s"]);
    expect(clash(ALL_OF_F1)).toEqual([]);
    // The skipped 2-pole breaker no longer reports how its terminal was derived.
    expect(validateDocument(document, ALL_OF_F1).some((finding) => finding.scope === "e")).toBe(false);
  });
});

describe("terminalBom(groups, extra)", () => {
  it("adds the rail parts on top and sorts them into the part order; a zero count gets no row", () => {
    const groups = deriveTerminals(twoGroups());
    const plain = terminalBom(groups);
    expect(plain.map((row) => row.partId)).toEqual(["2003-7641", "2009-305", "2016-7714"]);
    const withPlates = terminalBom(groups, { "2003-7692": 2, "2016-7691": 0 });
    expect(withPlates.map((row) => [row.partId, row.count])).toEqual([
      ["2003-7641", 4], ["2003-7692", 2], ["2009-305", 2], ["2016-7714", 2]]);
    expect(withPlates[1]).toMatchObject({ partNo: "WAGO 2003-7692", widthMm: 0.8, verified: true });
    expect(terminalBom(groups, {})).toEqual(plain);
    expect(terminalBom([], { "2016-7691": 1 }).map((row) => [row.partId, row.count])).toEqual([["2016-7691", 1]]);
  });
});
