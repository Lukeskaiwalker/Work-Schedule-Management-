/**
 * The terminal lines of the drop note (docs/PANEL_ENCLOSURE_R2.md §6.5 item
 * 3 and 4, §13): what a drop did to the WAGO terminals — renumbered strips
 * ("Beschriftung neu drucken"), a strip now in another field, a strip that
 * lost or found its place — and a terminal circuit dropped where no WAGO
 * goes. Strip moves and the findings' actions get their own first line.
 *
 * Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import { describeAction, describeDrop, describeStripMove } from "../components/schaltplan/enclosure/dropNoteText";
import { dropDevice } from "../utils/enclosureOpsDrag";
import { moveTerminalStrip, relinkRows } from "../utils/enclosureOpsTerminals";
import { terminalSuggestions } from "../utils/enclosureTerminalSuggest";
import type { CatalogIndex } from "../utils/enclosureCatalog";
import type { TerminalSuggestion } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import { doc, fi, lsRun, mod, range, row } from "./enclosureTerminalBoards";
import { deepFreeze, INDEX } from "./enclosureTestCatalog";

function dropped(document: PanelDocument, deviceId: string, moduleId: string, railKey: string, at: number, index: CatalogIndex = INDEX) {
  const result = dropDevice(document, index, deviceId, { moduleId, railKey, at });
  if (!result.ok) throw new Error(result.error);
  return deepFreeze(result.document);
}

const group = (g: number, count: number, first: number) => [fi(`dev-f${g}`, `F${g}`), ...lsRun(`f${g}`, `F${g}`, range(1, count + 1), first)];

/** Feld 1: F1 + 2 LS on r3, F2 + 2 LS on r4. Feld 2: F3 + 2 LS on r3. X1–X3 in that order. */
function threeGroups(): PanelDocument {
  return deepFreeze(
    doc("ZB33S", [mod("mod-a", "ZU37KS", 0, { r3: "row-a3", r4: "row-a4" }), mod("mod-b", "ZU37KS", 1, { r3: "row-b3" })], [
      row("row-a3", "F1 · Verteiler 3", group(1, 2, 1)),
      row("row-a4", "F1 · Verteiler 4", group(2, 2, 3)),
      row("row-b3", "F2 · Verteiler 3", group(3, 2, 5)),
    ]),
  );
}

/** Feld 1: four 102,7 mm Leisten (FI + 16 LS) two per rail. Feld 2: F5 + 1 LS. */
function tightField(): PanelDocument {
  const rails = { r3: "row-a3", r4: "row-a4", r5: "row-a5", r6: "row-a6" };
  return deepFreeze(
    doc("ZB33S", [mod("mod-a", "ZU37KS", 0, rails), mod("mod-b", "ZU37KS", 1, { r3: "row-b3" })], [
      ...range(1, 5).map((g) => row(`row-a${g + 2}`, `F1 · Verteiler ${g + 2}`, group(g, 16, 1 + (g - 1) * 16))),
      row("row-b3", "F2 · Verteiler 3", group(5, 1, 80)),
    ]),
  );
}

describe("describeDrop — terminal lines", () => {
  it("lists renumbered strips and a strip now in another field", () => {
    const before = threeGroups();
    const after = dropped(before, "dev-f3", "mod-a", "r3", 0);
    expect(describeDrop(before, after, INDEX, "dev-f3")).toEqual([
      "F3 mit 2 Stromkreisen verschoben: F1 · Verteiler 3, Platz 1.",
      "Klemmen neu nummeriert: X1 → X2, X2 → X3, X3 → X1 — Beschriftung neu drucken.",
      "X1 jetzt in Feld 1.",
    ]);
  });

  it("says which strip lost its place, and which found one again", () => {
    const before = tightField();
    // F5.1 behind F1's 16 circuits: X1 grows to 107,9 mm, rail 1 cannot take X1 and X2 any more.
    const after = dropped(before, "dev-f5-1", "mod-a", "r3", 17);
    expect(describeDrop(before, after, INDEX, "dev-f5-1")).toEqual([
      "F5.1 verschoben: F1 · Verteiler 3, Platz 18.",
      "F5.1 hängt jetzt an F1 (vorher F5).",
      "X4 hat keinen Platz mehr in Feld 1.",
    ]);
    const back = dropped(after, "dev-f5-1", "mod-b", "r3", 1);
    expect(describeDrop(after, back, INDEX, "dev-f5-1")).toContain("X4 hat jetzt Platz in Feld 1.");
  });

  it("says when a circuit with Reihenklemme lands where no WAGO goes", () => {
    const before = deepFreeze(
      doc("ZB33S", [mod("mod-z", "ZH3EH16", 0, {}), mod("mod-a", "ZU37KS", 1, { r3: "row-a3" })], [row("row-a3", "F2 · Verteiler 3", group(1, 2, 1))]),
    );
    const after = dropped(before, "dev-f1-2", "mod-z", "aar2", 0);
    expect(describeDrop(before, after, INDEX, "dev-f1-2")).toContain("Im AAR keine Reihenklemme für F1.2.");
  });

  it("adds nothing on a board without a cabinet change to the terminals", () => {
    const before = threeGroups();
    const after = dropped(before, "dev-f1-2", "mod-a", "r3", 1);
    expect(describeDrop(before, after, INDEX, "dev-f1-2")).toEqual(["F1.2 verschoben: F1 · Verteiler 3, Platz 2."]);
  });
});

describe("describeStripMove", () => {
  it("names the strip, its field and its rail", () => {
    const before = threeGroups();
    const result = moveTerminalStrip(before, INDEX, "dev-f1:leiste", { field: 0, rail: 1, at: 0 });
    if (!result.ok) throw new Error(result.error);
    expect(describeStripMove(before, result.document, INDEX, "dev-f1:leiste")).toEqual(["X1 verschoben: Feld 1 · Hutschiene 2."]);
  });
});

describe("describeAction", () => {
  it("says what a finding's suggestion did, then what it did to the terminals", () => {
    const before = deepFreeze(boardDocument("terminals_zb34s"));
    const vacate = terminalSuggestions(before, FIXTURE_INDEX).find((candidate) => candidate.kind === "relink_rows") as Extract<TerminalSuggestion, { kind: "relink_rows" }>;
    const result = relinkRows(before, FIXTURE_INDEX, vacate.moves);
    if (!result.ok) throw new Error(result.error);
    const lines = describeAction(before, result.document, FIXTURE_INDEX, vacate);
    expect(lines[0]).toBe("Vorschlag ausgeführt: Reihen auf F3 · Verteiler 3 und F3 · Verteiler 4 umgehängt.");
    expect(lines.some((line) => line.startsWith("Klemmen neu nummeriert: ") && line.endsWith(" — Beschriftung neu drucken."))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it("words the other three actions", () => {
    const before = threeGroups();
    const field = (suggestion: Partial<TerminalSuggestion>) => ({ field: 0, ...suggestion }) as TerminalSuggestion;
    expect(describeAction(before, before, INDEX, field({ kind: "reset_order", rule: "encl.terminal_order_ignored", scope: "mod-a" }))[0]).toBe(
      "Reihenfolge der Klemmleisten in Feld 1 zurückgesetzt.",
    );
    expect(describeAction(before, before, INDEX, field({ kind: "remove_placeholders", rule: "encl.terminal_placeholders", scopes: ["r"], deviceIds: ["a", "b"] }))[0]).toBe(
      "2 Platzhalter-Reihenklemmen entfernt.",
    );
    const move = field({
      kind: "move_group", rule: "encl.terminals_overflow", scope: "mod-a", headId: "dev-f1", deviceIds: ["dev-f1", "dev-f1-1", "dev-f1-2"],
      targets: [{ moduleId: "mod-b", railKey: "r4", title: "F2 · Verteiler 4", field: 1 }],
    });
    expect(describeAction(before, before, INDEX, move)[0]).toBe("Vorschlag ausgeführt: F1 mit 2 Stromkreisen nach F2 · Verteiler 4 verschoben.");
  });
});
