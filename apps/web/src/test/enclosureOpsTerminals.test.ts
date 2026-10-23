/**
 * The terminal ops (docs/PANEL_ENCLOSURE_R2.md §2.1, §4.2, §6.4, R5, R11,
 * R12): a manual strip move stores one sequence per field (only current
 * strip ids, on the holder of the field's first terminal rail, deleted when
 * it equals the default; no split while strips are without place, when the
 * field then packs as asked); the vacate re-links whole rows; "move
 * circuits" fills target rails in order; placeholders go through
 * `removeDevices`. The real ops on the suggestions give the placement and
 * the pins the virtual transforms promised — also where a group's run
 * crosses a row or a field line.
 *
 * Every input is deep-frozen. Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import { feedMap } from "../utils/enclosureFeeds";
import { linkedRows } from "../utils/enclosureLayout";
import { placeModule, RAIL_NOT_EMPTY } from "../utils/enclosureOps";
import {
  moveGroupToRails,
  moveTerminalStrip,
  relinkRows,
  removeTerminalPlaceholders,
  resetTerminalOrder,
  stripMoveOverMm,
} from "../utils/enclosureOpsTerminals";
import { parseTerminalOrder, placeTerminals } from "../utils/enclosureTerminals";
import { terminalSuggestions } from "../utils/enclosureTerminalSuggest";
import { virtualMove, virtualRelink } from "../utils/enclosureTerminalVirtual";
import { removeDevices } from "../utils/schaltplanDocumentOps";
import type { CatalogIndex } from "../utils/enclosureCatalog";
import type { OpResult } from "../utils/enclosureOps";
import type { EnclosureModule, TerminalPlacement, TerminalSuggestion } from "../types/panelEnclosure";
import type { PanelDocument, PanelRow } from "../types/schaltplan";
import { FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import { dev, doc, elsewhereFirstZb53s, fi, ls, lsRun, mod, range, row, runOverR2Zb32s, spillZb53s } from "./enclosureTerminalBoards";
import { deepFreeze, INDEX } from "./enclosureTestCatalog";

// ── Boards ───────────────────────────────────────────────────────────────────

/** FI F{g} + `count` LS with terminals, one group per rail from r3 down, per field's ZU37KS; groups count across the board. */
function vtBoard(cabinet: string, fields: number[][], extra: (modules: EnclosureModule[]) => EnclosureModule[] = (m) => m): PanelDocument {
  const modules: EnclosureModule[] = [];
  const rows: PanelRow[] = [];
  let group = 0;
  let circuit = 1;
  fields.forEach((counts, field) => {
    const name = "abcde"[field];
    const rails: Record<string, string> = {};
    counts.forEach((count, i) => {
      group += 1;
      const rail = 3 + i;
      rails[`r${rail}`] = `row-${name}${rail}`;
      rows.push(row(`row-${name}${rail}`, `F${field + 1} · Verteiler ${rail}`, [fi(`dev-f${group}`, `F${group}`), ...lsRun(`f${group}`, `F${group}`, range(1, count + 1), circuit)]));
      circuit += count;
    });
    modules.push(mod(`mod-${name}`, "ZU37KS", field, rails));
  });
  return deepFreeze(doc(cabinet, extra(modules), rows));
}

const X = (group: number) => `dev-f${group}:leiste`;

/** strip ids per terminal rail of `field`, then its unplaced ones. */
function layoutOf(document: PanelDocument, field: number, index: CatalogIndex = INDEX): { rails: string[][]; unplaced: string[]; order: string } {
  const placed = placeTerminals(document, index).fields.find((candidate) => candidate.field === field)!;
  return {
    rails: placed.rails.map((rail) => rail.strips.map((strip) => strip.stripId)),
    unplaced: placed.unplaced.map((strip) => strip.stripId),
    order: placed.order,
  };
}

function ok(result: OpResult): PanelDocument {
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return deepFreeze(result.document);
}
const refusal = (result: OpResult): string => (result.ok ? "(applied)" : result.error);
const moduleOf = (document: PanelDocument, id: string) => document.enclosure!.modules.find((candidate) => candidate.id === id)!;

/** The placement without row ids (the real ops make new rows, the virtual ones `virtual:` rows). */
function shape(placement: TerminalPlacement) {
  return placement.fields.map((field) => ({
    ...field,
    rails: field.rails.map(({ rowId: _rowId, ...rail }) => rail),
  }));
}

/** device id → parent_id, over the whole board. */
const parentsOf = (document: PanelDocument) =>
  new Map(document.rows.flatMap((candidate) => candidate.devices).map((device) => [device.id, device.parent_id ?? null] as const));

// ── moveTerminalStrip ────────────────────────────────────────────────────────

describe("moveTerminalStrip — what it stores", () => {
  it("writes the field's sequence and rail2_from to the holder of its first terminal rail", () => {
    const before = vtBoard("ZB33S", [[8, 8, 8]]);
    expect(layoutOf(before, 0).rails).toEqual([[X(1), X(2), X(3)], []]);
    const after = ok(moveTerminalStrip(before, INDEX, X(1), { field: 0, rail: 1, at: 0 }));
    expect(moduleOf(after, "mod-a").terminal_order).toEqual({ "0": { strips: [X(2), X(3), X(1)], rail2_from: X(1) } });
    expect(layoutOf(after, 0)).toEqual({ rails: [[X(2), X(3)], [X(1)]], unplaced: [], order: "manual" });
  });

  it("reorders within a rail (no rail-2 split stored)", () => {
    const before = vtBoard("ZB33S", [[8, 8, 8]]);
    const after = ok(moveTerminalStrip(before, INDEX, X(3), { field: 0, rail: 0, at: 0 }));
    expect(moduleOf(after, "mod-a").terminal_order).toEqual({ "0": { strips: [X(3), X(1), X(2)], rail2_from: null } });
    expect(layoutOf(after, 0).rails).toEqual([[X(3), X(1), X(2)], []]);
  });

  it("deletes the entry when the result is the default placement again", () => {
    const moved = ok(moveTerminalStrip(vtBoard("ZB33S", [[8, 8, 8]]), INDEX, X(1), { field: 0, rail: 1, at: 0 }));
    const back = ok(moveTerminalStrip(moved, INDEX, X(1), { field: 0, rail: 0, at: 0 }));
    expect("terminal_order" in moduleOf(back, "mod-a")).toBe(false);
    expect(layoutOf(back, 0)).toEqual({ rails: [[X(1), X(2), X(3)], []], unplaced: [], order: "default" });
  });

  it("writes only current strip ids, and takes the field's entry off its other modules", () => {
    const stale = { strips: ["gone:leiste", X(3), X(2), X(1)], rail2_from: null };
    // ZB52S: a cover module shares field 0 with the ZU37KS and carries an entry for it.
    const before = vtBoard("ZB52S", [[8, 8, 8]], (modules) => [
      { ...modules[0], terminal_order: { "0": stale, "1": { strips: ["other:leiste"], rail2_from: null } } },
      { ...mod("mod-cover", "ZU62A", 0, {}, { "0": { strips: [X(2)], rail2_from: null } }), unit: 7 },
    ]);
    expect(layoutOf(before, 0).rails[0]).toEqual([X(3), X(2), X(1)]);
    const after = ok(moveTerminalStrip(before, INDEX, X(1), { field: 0, rail: 0, at: 0 }));
    expect(moduleOf(after, "mod-a").terminal_order).toEqual({
      "0": { strips: [X(1), X(3), X(2)], rail2_from: null },
      "1": { strips: ["other:leiste"], rail2_from: null },
    });
    expect("terminal_order" in moduleOf(after, "mod-cover")).toBe(false);
  });

  it("is the very same document when the strip stays where it is", () => {
    const before = vtBoard("ZB33S", [[8, 8, 8]]);
    const result = moveTerminalStrip(before, INDEX, X(2), { field: 0, rail: 0, at: 1 });
    expect(result.ok && result.document).toBe(before);
  });

  it("refuses another field, a split that does not fit and an unknown strip", () => {
    const two = vtBoard("ZB33S", [[8], [8]]);
    expect(refusal(moveTerminalStrip(two, INDEX, X(1), { field: 1, rail: 0, at: 0 }))).toBe(
      "Klemmen gehören zu Feld 1 — die Stromkreise verschieben, nicht die Klemmen.",
    );
    // X1–X3 fill rail 1 (184,1 mm), X4 sits on rail 2: a fourth 61,1 mm Leiste on rail 1 is 35,2 mm too much.
    const four = vtBoard("ZB33S", [[8, 8, 8, 8]]);
    expect(layoutOf(four, 0).rails).toEqual([[X(1), X(2), X(3)], [X(4)]]);
    expect(refusal(moveTerminalStrip(four, INDEX, X(4), { field: 0, rail: 0, at: 3 }))).toBe("Passt nicht: 35,2 mm zu viel auf Hutschiene 1.");
    expect(stripMoveOverMm(four, INDEX, X(4), { field: 0, rail: 0, at: 3 })).toBe(35.2);
    expect(stripMoveOverMm(four, INDEX, X(4), { field: 0, rail: 0, at: 0 })).toBe(35.2);
    expect(stripMoveOverMm(four, INDEX, X(1), { field: 0, rail: 1, at: 1 })).toBe(0);
    expect(refusal(moveTerminalStrip(four, INDEX, "nope:leiste", { field: 0, rail: 0, at: 0 }))).toBe("Klemmleiste nicht gefunden.");
  });

  it("reorders while strips are without place: no split stored, packed exactly as asked (R5)", () => {
    // Five 71,5 mm Leisten (2-TE FIs + 10 LS): X1–X2 on rail 1, X3–X4 on rail 2, X5 without place.
    // A split would have to take X5 onto rail 2 as well; null ("split automatically") gives the same rails.
    const full = deepFreeze(boardDocument("terminals_overflow_zb32s"));
    const before = layoutOf(full, 0, FIXTURE_INDEX);
    expect(before).toEqual({ rails: [[X(1), X(2)], [X(3), X(4)]], unplaced: [X(5)], order: "default" });

    const target = { field: 0, rail: 0, at: 1 } as const;
    expect(stripMoveOverMm(full, FIXTURE_INDEX, X(1), target)).toBe(0);
    const rail1 = ok(moveTerminalStrip(full, FIXTURE_INDEX, X(1), target));
    expect(moduleOf(rail1, "mod-o").terminal_order).toEqual({ "0": { strips: [X(2), X(1), X(3), X(4), X(5)], rail2_from: null } });
    expect(layoutOf(rail1, 0, FIXTURE_INDEX)).toEqual({ rails: [[X(2), X(1)], [X(3), X(4)]], unplaced: [X(5)], order: "manual" });

    const rail2 = ok(moveTerminalStrip(full, FIXTURE_INDEX, X(3), { field: 0, rail: 1, at: 1 }));
    expect(layoutOf(rail2, 0, FIXTURE_INDEX)).toEqual({ rails: [[X(1), X(2)], [X(4), X(3)]], unplaced: [X(5)], order: "manual" });
  });

  it("refuses a place no packing gives while strips are without place, naming the rail that runs over", () => {
    const full = deepFreeze(boardDocument("terminals_overflow_zb32s"));
    // X5 in front of X3: rail 2 would hold three 71,5 mm Leisten.
    expect(refusal(moveTerminalStrip(full, FIXTURE_INDEX, X(5), { field: 0, rail: 1, at: 0 }))).toMatch(/^Passt nicht: .* mm zu viel auf Hutschiene 2\.$/);
    expect(stripMoveOverMm(full, FIXTURE_INDEX, X(5), { field: 0, rail: 1, at: 0 })).toBeGreaterThan(0);
    // … and in front of X1: rail 1 would.
    expect(refusal(moveTerminalStrip(full, FIXTURE_INDEX, X(5), { field: 0, rail: 0, at: 0 }))).toMatch(/^Passt nicht: .* mm zu viel auf Hutschiene 1\.$/);
  });

  it("reorders the owner's board while it still waits for the vacate", () => {
    const owner = deepFreeze(boardDocument("terminals_zb34s"));
    const before = layoutOf(owner, 1, FIXTURE_INDEX);
    expect(before.rails[1]).toHaveLength(2);
    expect(before.unplaced.length).toBeGreaterThan(0);
    const [left, right] = before.rails[1];
    const after = ok(moveTerminalStrip(owner, FIXTURE_INDEX, left, { field: 1, rail: 1, at: 1 }));
    expect(layoutOf(after, 1, FIXTURE_INDEX)).toEqual({ ...before, rails: [before.rails[0], [right, left]], order: "manual" });
  });
});

describe("moveTerminalStrip — the stored order over time", () => {
  it("a group that grows past the stored split: ignored, packed automatically", () => {
    const moved = ok(moveTerminalStrip(vtBoard("ZB33S", [[8, 8, 8]]), INDEX, X(1), { field: 0, rail: 1, at: 0 }));
    // F3 grows to 25 LS: X2 + X3 no longer fit rail 1.
    const grown = deepFreeze({
      ...moved,
      rows: moved.rows.map((candidate) =>
        candidate.id === "row-a5" ? { ...candidate, devices: [fi("dev-f3", "F3"), ...lsRun("f3", "F3", range(1, 26), 17)] } : candidate,
      ),
    });
    const layout = layoutOf(grown, 0);
    expect(layout.order).toBe("ignored");
    // Next-fit over X2, X3, X1: X3 opens rail 2, X1 fits neither cursor rail and goes back onto rail 1 (first-fit).
    expect(layout.rails).toEqual([[X(2), X(1)], [X(3)]]);
  });

  it("a new strip merges in after its default neighbour", () => {
    const moved = ok(moveTerminalStrip(vtBoard("ZB33S", [[8, 8, 8]]), INDEX, X(3), { field: 0, rail: 0, at: 0 }));
    // A fourth group after F3: its default predecessor is X3, so it lands right after it.
    const added = deepFreeze({
      ...moved,
      rows: [...moved.rows, row("row-a6", "F1 · Verteiler 6", [fi("dev-f4", "F4"), ...lsRun("f4", "F4", range(1, 3), 40)])],
      enclosure: {
        ...moved.enclosure!,
        modules: moved.enclosure!.modules.map((module) => ({ ...module, rails: { ...module.rails, r6: "row-a6" } })),
      },
    });
    expect(layoutOf(added, 0).rails).toEqual([[X(3), X(4), X(1)], [X(2)]]);
  });

  it("a strip that leaves the field and comes back takes its stored slot again", () => {
    const board = vtBoard("ZB33S", [[8, 8, 8], []]);
    const moved = ok(moveTerminalStrip(board, INDEX, X(1), { field: 0, rail: 0, at: 2 }));
    expect(layoutOf(moved, 0).rails[0]).toEqual([X(2), X(3), X(1)]);
    const away = ok(moveGroupToRails(moved, INDEX, ["dev-f1", ...range(1, 9).map((k) => `dev-f1-${k}`)], [{ moduleId: "mod-b", railKey: "r3" }]));
    expect(layoutOf(away, 0).rails[0]).toEqual([X(2), X(3)]);
    expect(layoutOf(away, 1).rails[0]).toEqual([X(1)]);
    // Back on r3, before F2 and F3: by default X1 would lead again; the stored slot wins.
    const home = ok(moveGroupToRails(away, INDEX, ["dev-f1", ...range(1, 9).map((k) => `dev-f1-${k}`)], [{ moduleId: "mod-a", railKey: "r3" }]));
    expect(home.rows[0].devices[0].id).toBe("dev-f1");
    expect(layoutOf(home, 0).rails[0]).toEqual([X(2), X(3), X(1)]);
  });
});

describe("resetTerminalOrder", () => {
  it("deletes the field's entry everywhere; the board without one comes back as it is", () => {
    const moved = ok(moveTerminalStrip(vtBoard("ZB33S", [[8, 8, 8]]), INDEX, X(1), { field: 0, rail: 1, at: 0 }));
    const reset = deepFreeze(resetTerminalOrder(moved, INDEX, 0));
    expect("terminal_order" in moduleOf(reset, "mod-a")).toBe(false);
    expect(layoutOf(reset, 0).order).toBe("default");
    expect(resetTerminalOrder(reset, INDEX, 0)).toBe(reset);
  });

  it("resets the fixture's ignored order", () => {
    const document = deepFreeze(boardDocument("terminals_rk_zb53s"));
    const reset = resetTerminalOrder(document, FIXTURE_INDEX, 1);
    expect(parseTerminalOrder(moduleOf(reset, "mod-r").terminal_order)?.["0"]).toBeUndefined();
    expect(placeTerminals(reset, FIXTURE_INDEX).fields.find((field) => field.field === 1)!.order).toBe("default");
  });
});

// ── relinkRows (the vacate) ──────────────────────────────────────────────────

const suggestionOf = <K extends TerminalSuggestion["kind"]>(document: PanelDocument, kind: K, index: CatalogIndex = FIXTURE_INDEX) =>
  terminalSuggestions(document, index).find((candidate) => candidate.kind === kind) as Extract<TerminalSuggestion, { kind: K }>;

describe("relinkRows", () => {
  it("moves the fixture's reserved rows in one op and places exactly as the virtual relink", () => {
    const document = deepFreeze(boardDocument("terminals_zb34s"));
    const vacate = suggestionOf(document, "relink_rows");
    const result = relinkRows(document, FIXTURE_INDEX, vacate.moves);
    const after = ok(result);
    const links = linkedRows(after, FIXTURE_INDEX);
    expect(links.get("row-old1")).toEqual({ moduleId: "mod-rk", railKey: "r3" });
    expect(links.get("row-old2")).toEqual({ moduleId: "mod-rk", railKey: "r4" });
    expect(shape(placeTerminals(after, FIXTURE_INDEX))).toEqual(shape(placeTerminals(virtualRelink(document, FIXTURE_INDEX, vacate.moves), FIXTURE_INDEX)));
    // Rows and devices are untouched; a generated label follows its rail.
    expect(after.rows.find((candidate) => candidate.id === "row-old1")!.devices).toBe(document.rows.find((candidate) => candidate.id === "row-old1")!.devices);
    expect(after.rows.find((candidate) => candidate.id === "row-old1")!.label).toBe("F3 · Verteiler 3");
  });

  it("keeps a hand-named row's label and pins a circuit whose feed would change (one finish, D4)", () => {
    // Feld 1: r1 = FI F1 + a1, r2 = a2 (under F1), r3 = FI F2 + b1. Feld 2 empty.
    const before = deepFreeze(doc("ZB32S", [mod("mod-a", "ZU37KS", 0, { r1: "row-1", r2: "row-2", r3: "row-3" }), mod("mod-b", "ZU37KS", 1, {})], [
      row("row-1", "Küche", [fi("fi1", "F1"), ls("a1", "F1.1", "1", "Licht")]),
      row("row-2", "F1 · Verteiler 2", [ls("a2", "F1.2", "2", "Steckdosen")]),
      row("row-3", "F1 · Verteiler 3", [fi("fi2", "F2"), ls("b1", "F2.1", "3", "Herd")]),
    ]));
    const result = relinkRows(before, INDEX, [
      { rowId: "row-1", target: { moduleId: "mod-b", railKey: "r3" } },
      { rowId: "row-2", target: { moduleId: "mod-b", railKey: "r4" } },
    ]);
    const after = ok(result);
    expect(after.rows.map((candidate) => [candidate.id, candidate.label])).toEqual([
      ["row-3", "F1 · Verteiler 3"],
      ["row-1", "Küche"],
      ["row-2", "F2 · Verteiler 4"],
    ]);
    expect(result.ok && result.pinned).toEqual([]);
    expect(feedMap(after).get("a2")).toBe("fi1");

    const one = relinkRows(before, INDEX, [{ rowId: "row-2", target: { moduleId: "mod-b", railKey: "r3" } }]);
    expect(one.ok && one.pinned).toEqual(["a2"]);
    expect(feedMap(ok(one)).get("a2")).toBe("fi1");
  });

  it("pins a run that continued from the moved row exactly as the virtual relink does", () => {
    const document = deepFreeze(runOverR2Zb32s());
    const vacate = suggestionOf(document, "relink_rows");
    const result = relinkRows(document, FIXTURE_INDEX, vacate.moves);
    const virtual = virtualRelink(document, FIXTURE_INDEX, vacate.moves);
    expect(result.ok && result.pinned).toEqual(["dev-f1-5", "dev-f1-6"]);
    expect(parentsOf(ok(result))).toEqual(parentsOf(virtual));
    expect(shape(placeTerminals(ok(result), FIXTURE_INDEX))).toEqual(shape(placeTerminals(virtual, FIXTURE_INDEX)));
  });

  it("makes room on a target with an empty row, refuses one with devices and a missing row", () => {
    const before = deepFreeze(doc("ZB32S", [mod("mod-a", "ZU37KS", 0, { r1: "row-1" }), mod("mod-b", "ZU37KS", 1, { r3: "row-e", r4: "row-f" })], [
      row("row-1", "F1 · Verteiler 1", [ls("a1", "F1.1", "1", "Licht")]),
      row("row-e", "F2 · Verteiler 3", []),
      row("row-f", "F2 · Verteiler 4", [ls("c1", "F2.1", "2", "Bad")]),
    ]));
    const after = ok(relinkRows(before, INDEX, [{ rowId: "row-1", target: { moduleId: "mod-b", railKey: "r3" } }]));
    expect(after.rows.map((candidate) => candidate.id)).toEqual(["row-1", "row-f"]);
    expect(moduleOf(after, "mod-b").rails).toEqual({ r3: "row-1", r4: "row-f" });
    expect(refusal(relinkRows(before, INDEX, [{ rowId: "row-1", target: { moduleId: "mod-b", railKey: "r4" } }]))).toBe(RAIL_NOT_EMPTY);
    expect(refusal(relinkRows(before, INDEX, [{ rowId: "nope", target: { moduleId: "mod-b", railKey: "r5" } }]))).toBe("Reihe nicht gefunden.");
  });
});

// ── moveGroupToRails ─────────────────────────────────────────────────────────

describe("moveGroupToRails", () => {
  it("moves the fixture's group into the next field and places exactly as the virtual move", () => {
    const document = deepFreeze(boardDocument("terminals_overflow_zb32s"));
    const move = suggestionOf(document, "move_group");
    const after = ok(moveGroupToRails(document, FIXTURE_INDEX, move.deviceIds, move.targets));
    expect(placeTerminals(after, FIXTURE_INDEX).fields.flatMap((field) => field.unplaced)).toEqual([]);
    expect(shape(placeTerminals(after, FIXTURE_INDEX))).toEqual(shape(placeTerminals(virtualMove(document, FIXTURE_INDEX, move.deviceIds, move.targets), FIXTURE_INDEX)));
  });

  it("moves a group whose run spills over the field line, pinned and placed exactly as the virtual move", () => {
    const document = deepFreeze(spillZb53s());
    const move = suggestionOf(document, "move_group");
    const result = moveGroupToRails(document, FIXTURE_INDEX, move.deviceIds, move.targets);
    const virtual = virtualMove(document, FIXTURE_INDEX, move.deviceIds, move.targets);
    expect(result.ok && result.pinned).toEqual(["dev-f5-11", "dev-f5-12"]);
    expect(parentsOf(ok(result))).toEqual(parentsOf(virtual));
    expect(placeTerminals(ok(result), FIXTURE_INDEX).fields.flatMap((field) => field.unplaced)).toEqual([]);
    expect(shape(placeTerminals(ok(result), FIXTURE_INDEX))).toEqual(shape(placeTerminals(virtual, FIXTURE_INDEX)));
  });

  it("fills two rails in order, never reordered", () => {
    const document = deepFreeze(elsewhereFirstZb53s());
    const move = suggestionOf(document, "move_group");
    expect(move.targets).toHaveLength(2);
    const after = ok(moveGroupToRails(document, FIXTURE_INDEX, move.deviceIds, move.targets));
    const links = [...linkedRows(after, FIXTURE_INDEX)];
    const devicesOn = (railKey: string) => {
      const [rowId] = links.find(([, link]) => link.moduleId === "mod-x" && link.railKey === railKey)!;
      return after.rows.find((candidate) => candidate.id === rowId)!.devices.map((device) => device.id);
    };
    expect(devicesOn("r3")).toEqual(move.deviceIds.slice(0, 11));
    expect(devicesOn("r4")).toEqual(move.deviceIds.slice(11));
    expect(shape(placeTerminals(after, FIXTURE_INDEX))).toEqual(shape(placeTerminals(virtualMove(document, FIXTURE_INDEX, move.deviceIds, move.targets), FIXTURE_INDEX)));
  });

  it("refuses without a target rail or a device", () => {
    const document = vtBoard("ZB33S", [[2], []]);
    expect(refusal(moveGroupToRails(document, INDEX, ["dev-f1"], [{ moduleId: "nope", railKey: "r3" }]))).toBe("Hutschiene nicht gefunden.");
    expect(refusal(moveGroupToRails(document, INDEX, ["nope"], [{ moduleId: "mod-b", railKey: "r3" }]))).toBe("Gerät nicht gefunden.");
  });
});

// ── Placeholders ─────────────────────────────────────────────────────────────

describe("removeTerminalPlaceholders", () => {
  it("removes the hand-placed Reihenklemmen N/PE and nothing else", () => {
    const before = deepFreeze(doc("ZB32S", [mod("mod-a", "ZU37KS", 0, { r2: "row-2" })], [
      row("row-2", "F1 · Verteiler 2", [ls("a1", "F1.1", "1", "Licht"), dev("ph1", "terminal"), dev("ph2", "terminal")]),
    ]));
    const after = removeTerminalPlaceholders(before, INDEX, ["ph1", "ph2", "a1"]);
    expect(after.rows[0].devices.map((device) => device.id)).toEqual(["a1"]);
    expect(removeTerminalPlaceholders(before, INDEX, ["a1", "nope"])).toBe(before);
  });
});

describe("removeDevices prunes the stored order", () => {
  it("drops a deleted head's strip id and the rail2_from it named", () => {
    const moved = ok(moveTerminalStrip(vtBoard("ZB33S", [[8, 8, 8]]), INDEX, X(1), { field: 0, rail: 1, at: 0 }));
    const removed = removeDevices(moved, ["dev-f1"]);
    expect(moduleOf(removed, "mod-a").terminal_order).toEqual({ "0": { strips: [X(2), X(3)], rail2_from: null } });
  });
});

// ── placeModule({adoptRows}) ─────────────────────────────────────────────────

describe("placeModule with adoptRows", () => {
  it("skips the field's terminal rails (R12, §3.6)", () => {
    const legacy = deepFreeze(doc("ZB32S", [], [row("a", "Reihe 1", [ls("a1", "F1.1", "1", "Licht")]), row("b", "Reihe 2", [ls("b1", "F1.2", "2", "Bad")])]));
    const placed = placeModule(legacy, INDEX, { code: "ZU37KS", field: 0, unit: 0, adoptRows: true });
    const after = ok(placed);
    expect(after.enclosure!.modules[0].rails).toEqual({ r3: "a", r4: "b" });
  });
});
