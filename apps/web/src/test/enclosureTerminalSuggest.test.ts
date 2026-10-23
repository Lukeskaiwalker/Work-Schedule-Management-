/**
 * The suggestions behind the terminal findings (docs/PANEL_ENCLOSURE_R2.md
 * §4.2) and the virtual document transforms they are checked with — the TS
 * twins of `apps/api/tests/test_panel_enclosure_terminal_suggest.py`.
 *
 * One sequential pass: vacate the reserved rails first, re-place the board
 * as if that were done, and only then — never while a vacate is pending —
 * offer to move a whole group (owner, 2026-10-22: an FI travels with its
 * circuits) into another field, accepted only when a virtual move really
 * places more. Python writes the result into `enclosureFixtures.json`
 * (`terminal_suggestions`); this twin must give the same.
 *
 * Not here: "the real ops give the virtual placement" needs
 * `enclosureOpsTerminals.ts` (slice W3) and is asserted there.
 */
import { describe, expect, it, vi } from "vitest";

import { linkedRows, physicalRowOrder } from "../utils/enclosureLayout";
import { boardTerminals, placeTerminals } from "../utils/enclosureTerminals";
import { joinAnd, suggestionPass, terminalSuggestions } from "../utils/enclosureTerminalSuggest";
import { fillRails, railRef, virtualMove, virtualRelink, vtRails } from "../utils/enclosureTerminalVirtual";
import type { RailTarget, TerminalSuggestion } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";
import { BOARD_NAMES, FIXTURE_BOARDS, FIXTURE_INDEX, boardDocument } from "./enclosureFixtureBoards";
import {
  elsewhereFirstZb53s,
  fullFieldZb32s,
  halfVacateZb32s,
  lostPlaceZb32s,
  range,
  runOverR2Zb32s,
  scatteredVacateZb33s,
  spillZb53s,
  stillShortZb32s,
  supplyOverflowZb32s,
  twoVacatesZb33s,
} from "./enclosureTerminalBoards";
import { deepFreeze } from "./enclosureTestCatalog";

const INDEX = FIXTURE_INDEX;

function suggest(document: PanelDocument): TerminalSuggestion[] {
  const terms = boardTerminals(document, INDEX);
  return terminalSuggestions(document, INDEX, terms, placeTerminals(document, INDEX, terms));
}

const target = (moduleId: string, railKey: string, title: string, field: number): RailTarget => ({ moduleId, railKey, title, field });
const unplaced = (document: PanelDocument): string[] =>
  placeTerminals(document, INDEX).fields.flatMap((field) => field.unplaced.map((strip) => strip.stripId));
const rowIds = (document: PanelDocument): string[] => document.rows.map((candidate) => candidate.id);
/** "moduleId:railKey" → row id, as `linkedRows` reads the board. */
function rowsByRail(document: PanelDocument): Map<string, string> {
  return new Map([...linkedRows(document, INDEX)].map(([rowId, link]) => [`${link.moduleId}:${link.railKey}`, rowId]));
}
const devicesOf = (document: PanelDocument, rowId: string): string[] =>
  document.rows.find((candidate) => candidate.id === rowId)!.devices.map((device) => device.id);
const withoutModule = (document: PanelDocument, moduleId: string): PanelDocument => ({
  ...document,
  enclosure: { ...document.enclosure!, modules: document.enclosure!.modules.filter((module) => module.id !== moduleId) },
});

describe("fixture parity", () => {
  it.each(BOARD_NAMES)("%s: the same suggestions as Python", (name) => {
    expect(suggest(boardDocument(name))).toEqual(FIXTURE_BOARDS[name].terminal_suggestions);
  });

  it("derives the terms and the placement itself when none are passed", () => {
    expect(terminalSuggestions(boardDocument("terminals_zb34s"), INDEX)).toEqual(FIXTURE_BOARDS.terminals_zb34s.terminal_suggestions);
  });
});

describe("the pass", () => {
  it("has nothing to suggest on the compliant board", () => {
    expect(suggest(boardDocument("meter_dist_zb33s"))).toEqual([]);
  });

  it("vacates both rows of the owner's board together and drops its placeholder", () => {
    expect(suggest(boardDocument("terminals_zb34s"))).toEqual([
      { rule: "encl.terminal_rail_devices", field: 1, kind: "relink_rows", scopes: ["row-old1", "row-old2"],
        moves: [{ rowId: "row-old1", target: target("mod-rk", "r3", "F3 · Verteiler 3", 2) },
                { rowId: "row-old2", target: target("mod-rk", "r4", "F3 · Verteiler 4", 2) }] },
      { rule: "encl.terminal_placeholders", field: 1, kind: "remove_placeholders", scopes: ["row-old2"], deviceIds: ["dev-pl1"] },
    ]);
  });

  it("really makes the owner's board fit by vacating", () => {
    const document = boardDocument("terminals_zb34s");
    const [vacate] = suggest(document);
    if (vacate.kind !== "relink_rows") throw new Error("expected the vacate first");
    const relinked = virtualRelink(document, INDEX, vacate.moves);
    expect(unplaced(relinked)).toEqual([]);
    expect(linkedRows(relinked, INDEX).get("row-old1")).toEqual({ moduleId: "mod-rk", railKey: "r3" });
    expect(linkedRows(relinked, INDEX).get("row-old2")).toEqual({ moduleId: "mod-rk", railKey: "r4" });
    // The rows now sit where the cabinet puts them, after field 1's.
    expect(rowIds(relinked)).toEqual(physicalRowOrder(relinked, INDEX));
    expect(rowIds(relinked).indexOf("row-old1")).toBeGreaterThan(rowIds(relinked).indexOf("row-k7"));
  });

  it("resets the RK board's ignored order", () => {
    expect(suggest(boardDocument("terminals_rk_zb53s"))).toEqual([
      { rule: "encl.terminal_order_ignored", field: 1, kind: "reset_order", scope: "mod-r" },
    ]);
  });

  it("moves a whole group into the next field, validated virtually", () => {
    const document = boardDocument("terminals_overflow_zb32s");
    const [move] = suggest(document);
    expect(move).toEqual({
      rule: "encl.terminals_overflow", field: 0, kind: "move_group", scope: "mod-o", headId: "dev-f5",
      deviceIds: ["dev-f5", ...range(1, 11).map((k) => `dev-f5-${k}`)],
      targets: [target("mod-e", "r3", "F2 · Verteiler 3", 1)],
    });
    if (move.kind !== "move_group") throw new Error("expected a move");
    expect(unplaced(virtualMove(document, INDEX, move.deviceIds, move.targets))).toEqual([]);
  });

  it("spans two empty rails and never moves the strip R6 brought in", () => {
    const document = elsewhereFirstZb53s();
    expect(unplaced(document)).toEqual(["dev-f1:leiste", "dev-f6:leiste"]);
    const [move] = suggest(document);
    if (move.kind !== "move_group") throw new Error("expected a move");
    expect([move.headId, move.scope, move.field]).toEqual(["dev-f6", "mod-d", 1]);
    expect(move.deviceIds).toEqual(["dev-f6", ...range(1, 12).map((k) => `dev-f6-${k}`)]);
    expect(move.targets).toEqual([target("mod-x", "r3", "F3 · Verteiler 3", 2), target("mod-x", "r4", "F3 · Verteiler 4", 2)]);
    const moved = virtualMove(document, INDEX, move.deviceIds, move.targets);
    expect(unplaced(moved)).toEqual(["dev-f1:leiste"]);
    const byRail = rowsByRail(moved);
    // Filled in order, never reordered: FI + 10 LS take 210 mm, the 11th LS goes on.
    expect(devicesOf(moved, byRail.get("mod-x:r3")!)).toEqual(move.deviceIds.slice(0, 11));
    expect(devicesOf(moved, byRail.get("mod-x:r4")!)).toEqual(move.deviceIds.slice(11));
  });

  it("moves a group whose run spills over the field line, checked on a board pinned like the real op's", () => {
    const document = deepFreeze(spillZb53s());
    expect(unplaced(document)).toEqual(["dev-f5:leiste"]);
    const [move] = suggest(document);
    expect(move).toEqual({
      rule: "encl.terminals_overflow", field: 0, kind: "move_group", scope: "mod-a", headId: "dev-f5",
      deviceIds: ["dev-f5", ...range(1, 11).map((k) => `dev-f5-${k}`)],
      targets: [target("mod-b", "r4", "F2 · Verteiler 4", 1)],
    });
    if (move.kind !== "move_group") throw new Error("expected a move");
    const moved = virtualMove(document, INDEX, move.deviceIds, move.targets);
    expect(unplaced(moved)).toEqual([]);
    const parents = new Map(moved.rows.flatMap((candidate) => candidate.devices).map((device) => [device.id, device.parent_id ?? null] as const));
    expect([11, 12].map((k) => parents.get(`dev-f5-${k}`))).toEqual(["dev-f5", "dev-f5"]);
    expect(range(1, 11).map((k) => parents.get(`dev-f5-${k}`))).toEqual(Array(10).fill(null));
  });

  it("refuses a move that places more overall but costs a placed strip its place", () => {
    const document = lostPlaceZb32s();
    expect(unplaced(document)).toEqual(["dev-g:leiste", "dev-b:leiste"]);
    // What the refused candidate would do: field 0 fits, field 1 loses a Block it did not have to hold before.
    const moved = virtualMove(document, INDEX, ["dev-g", "dev-g-b1", "dev-g-b2", ...range(1, 15).map((k) => `dev-g-${k}`)],
      [{ moduleId: "mod-m", railKey: "r6" }, { moduleId: "mod-m", railKey: "r7" }]);
    expect(unplaced(moved)).toEqual(["dev-g-b2:block"]);
    expect(suggest(document)).toEqual([]);
  });

  it("suggests no move while a vacate is pending", () => {
    expect(suggest(stillShortZb32s()).map((suggestion) => suggestion.kind)).toEqual(["relink_rows"]);
  });

  it("suggests nothing without a place or without a head", () => {
    expect(suggest(fullFieldZb32s())).toEqual([]);
    expect(suggest(supplyOverflowZb32s())).toEqual([]);
    expect(suggest(withoutModule(boardDocument("terminals_overflow_zb32s"), "mod-e"))).toEqual([]);
  });

  it("never names a vacate target twice", () => {
    expect(suggest(twoVacatesZb33s()).map((suggestion) => [suggestion.field, suggestion.kind === "relink_rows" ? suggestion.moves : null])).toEqual([
      [0, [{ rowId: "row-a1", target: target("mod-c", "r3", "F3 · Verteiler 3", 2) }]],
      [1, [{ rowId: "row-b1", target: target("mod-c", "r4", "F3 · Verteiler 4", 2) }]],
    ]);
  });

  it("gives each row the nearest free rail when no field takes them all", () => {
    expect(suggest(scatteredVacateZb33s())).toEqual([
      { rule: "encl.terminal_rail_devices", field: 0, kind: "relink_rows", scopes: ["row-a1", "row-a2"],
        moves: [{ rowId: "row-a1", target: target("mod-b", "r7", "F2 · Verteiler 7", 1) },
                { rowId: "row-a2", target: target("mod-c", "r7", "F3 · Verteiler 7", 2) }] },
    ]);
  });

  it("leaves a row without a free rail out of the vacate", () => {
    expect(suggest(halfVacateZb32s())).toEqual([
      { rule: "encl.terminal_rail_devices", field: 0, kind: "relink_rows", scopes: ["row-a1"],
        moves: [{ rowId: "row-a1", target: target("mod-b", "r7", "F2 · Verteiler 7", 1) }] },
    ]);
  });

  it("joins names the German way", () => {
    expect([joinAnd([]), joinAnd(["a"]), joinAnd(["a", "b"]), joinAnd(["a", "b", "c"])]).toEqual(["", "a", "a und b", "a, b und c"]);
  });

  it("has nothing to suggest without a cabinet, and reads garbage as Python does", () => {
    expect(terminalSuggestions({ ...boardDocument("terminals_zb34s"), enclosure: null }, INDEX)).toEqual([]);
    const garbage = { enclosure: { code: "ZB33S", modules: [null, { id: "m", code: "ZU37KS", rails: { r1: "r" } }] },
      rows: [null, { id: "r", devices: [null, { kind: "mcb", terminal_block: true, poles: "x" }] }] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Python's answer on the same document: the broken row and device are
    // read leniently, so the one breaker on r1 still gets its vacate.
    expect(terminalSuggestions(garbage as unknown as PanelDocument, INDEX)).toEqual([
      { rule: "encl.terminal_rail_devices", field: 0, kind: "relink_rows", scopes: ["r"],
        moves: [{ rowId: "r", target: target("m", "r3", "F1 · Verteiler 3", 0) }] },
    ]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the virtual transforms", () => {
  it("create the target row at its physical place and pin like the real op", () => {
    const document = boardDocument("terminals_overflow_zb32s");
    const ids = ["dev-f5", "dev-f5-1"];
    const moved = virtualMove(document, INDEX, ids, [{ moduleId: "mod-e", railKey: "r3" }]);
    const fresh = moved.rows.find((candidate) => rowsByRail(moved).get("mod-e:r3") === candidate.id)!;
    expect([fresh.id, fresh.label, fresh.slots]).toEqual(["virtual:mod-e:r3", "F2 · Verteiler 3", 12]);
    expect(fresh.devices.map((device) => device.id)).toEqual(ids);
    expect(fresh.devices.map((device) => device.parent_id)).toEqual([null, null]);
    expect(rowIds(moved)).toEqual(physicalRowOrder(moved, INDEX));
    expect(devicesOf(moved, "row-o7")).toEqual(range(2, 11).map((k) => `dev-f5-${k}`));
    // Left behind F4 by position, they keep F5 as the real op's finish does.
    const old = moved.rows.find((candidate) => candidate.id === "row-o7")!;
    expect(old.devices.map((device) => device.parent_id)).toEqual(Array(9).fill("dev-f5"));
  });

  it("relink pins a run that continued from the moved row", () => {
    const document = deepFreeze(runOverR2Zb32s());
    const [vacate] = suggest(document);
    if (vacate.kind !== "relink_rows") throw new Error("expected a vacate");
    expect(vacate.moves).toEqual([{ rowId: "row-a2", target: target("mod-a", "r4", "F1 · Verteiler 4", 0) }]);
    const relinked = virtualRelink(document, INDEX, vacate.moves);
    expect(rowIds(relinked)).toEqual(["row-a3", "row-a2"]);
    const parents = new Map(relinked.rows.flatMap((candidate) => candidate.devices).map((device) => [device.id, device.parent_id ?? null] as const));
    expect(range(1, 7).map((k) => parents.get(`dev-f1-${k}`))).toEqual([null, null, null, null, "dev-f1", "dev-f1"]);
    expect(range(1, 4).map((k) => parents.get(`dev-f2-${k}`))).toEqual([null, null, null]);
  });

  it("leave rail entries that are no text alone, as Python does", () => {
    for (const name of ["terminals_zb34s", "terminals_overflow_zb32s"] as const) {
      const clean = boardDocument(name);
      for (const junk of [{ a: 1 }, [null], ["row-x"]]) {
        const [first, ...rest] = clean.enclosure!.modules;
        const document = { ...clean, enclosure: { ...clean.enclosure!, modules: [{ ...first, rails: { ...first.rails, zz9: junk } }, ...rest] } };
        const answer = suggest(document as unknown as PanelDocument);
        expect(answer).toEqual(suggest(clean));
        expect(answer).not.toEqual([]);
      }
    }
  });

  it("never mutate and ignore what they cannot resolve", () => {
    const document = deepFreeze(boardDocument("terminals_zb34s"));
    const relinked = virtualRelink(document, INDEX, [
      { rowId: "row-old1", target: { moduleId: "mod-rk", railKey: "r3" } },
      { rowId: "nope", target: { moduleId: "mod-rk", railKey: "r4" } },
      { rowId: "row-old2", target: { moduleId: "gone", railKey: "r4" } },
    ]);
    expect(linkedRows(relinked, INDEX).get("row-old1")).toEqual({ moduleId: "mod-rk", railKey: "r3" });
    expect(linkedRows(relinked, INDEX).get("row-old2")).toEqual({ moduleId: "mod-k", railKey: "r2" });
    virtualMove(document, INDEX, ["dev-f2", "nope"], [{ moduleId: "mod-rk", railKey: "r5" }, { moduleId: "x", railKey: "y" }]);
    expect(virtualMove(document, INDEX, [], [{ moduleId: "mod-rk", railKey: "r5" }])).toBe(document);
    expect(virtualMove(document, INDEX, ["dev-f2"], [])).toBe(document);
    expect(virtualRelink(document, INDEX, [{ rowId: "nope", target: { moduleId: "mod-rk", railKey: "r4" } }])).toBe(document);
    expect(virtualRelink(document, INDEX, [null, { rowId: "row-old1" }] as never)).toBe(document);
  });

  it("move onto a rail with an empty row by filling that row", () => {
    const document = scatteredVacateZb33s();
    const moved = virtualMove(document, INDEX, ["dev-a1"], [{ moduleId: "mod-c", railKey: "r7" }]);
    expect(devicesOf(moved, "row-c7")).toEqual(["dev-a1"]);
    expect(devicesOf(moved, "row-a1")).toEqual([]);
    expect(moved.rows).toHaveLength(document.rows.length);
  });

  it("never reuse a row id and skip targets that are no rails", () => {
    const document = boardDocument("terminals_overflow_zb32s");
    const taken = { ...document, rows: [...document.rows, { id: "virtual:mod-e:r3", label: "alt", slots: 12, devices: [] }] };
    const moved = virtualMove(taken, INDEX, ["dev-f5"], [null, { moduleId: "mod-e", railKey: "r3" }] as never);
    const fresh = moved.rows.find((candidate) => rowsByRail(moved).get("mod-e:r3") === candidate.id)!;
    expect(fresh.id).toBe("virtual:mod-e:r3'");
    expect(fresh.devices.map((device) => device.id)).toEqual(["dev-f5"]);
  });

  it("fill rails in order, never reordered, and say when they are too short", () => {
    const document = boardDocument("terminals_overflow_zb32s");
    const r3 = vtRails(document, INDEX).get(1)!.find((ref) => ref.key === "r3")!;
    const group = document.rows.find((candidate) => candidate.id === "row-o7")!.devices;
    expect(fillRails(group, [r3])).toEqual([Array(11).fill(0), true]); // 2-TE FI + 10 LS = 210 mm
    const extra = [...group, { ...group[group.length - 1], id: "dev-x" }];
    expect(fillRails(extra, [r3])).toEqual([Array(12).fill(0), false]); // the 12th breaker overfills the last rail
    expect(fillRails([], [])).toEqual([[], true]);
    expect(fillRails(group, [])).toEqual([[], false]);
  });

  it("list every field's VT rails top → bottom, retired ones included, and resolve one by module and key", () => {
    const document = boardDocument("terminals_zb34s");
    const rails = vtRails(document, INDEX);
    expect([...rails.keys()]).toEqual([1, 2, 3]);
    expect(rails.get(1)!.map((ref) => ref.key)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    const ref = railRef(document, INDEX, "mod-rk", "r3")!;
    expect(ref.target()).toEqual(target("mod-rk", "r3", "F3 · Verteiler 3", 2));
    expect([ref.capacityMm, ref.row]).toEqual([210, null]);
    expect(railRef(document, INDEX, "mod-rk", "r99")).toBeNull();
    expect(railRef(document, INDEX, "mod-k", "r1")!.row!.id).toBe("row-old1");
  });
});

describe("suggestionPass — one pass per board (§6.7)", () => {
  it("is memoised by identity: the page's findings, the Schrank tab and the Aufbau tab share one pass", () => {
    const document = boardDocument("terminals_zb34s");
    const terms = boardTerminals(document, INDEX);
    const placement = placeTerminals(document, INDEX, terms);
    const pass = suggestionPass(document, INDEX, terms, placement);
    expect(pass.suggestions.length).toBeGreaterThan(0);
    expect(suggestionPass(document, INDEX, terms, placement)).toBe(pass);
    // Every caller gets its own array, so nobody can change the memoised one.
    const first = terminalSuggestions(document, INDEX, terms, placement);
    expect(first).toEqual(pass.suggestions);
    expect(first).not.toBe(pass.suggestions);
    // Another document is another pass, with the same answer for the same board.
    const copy = structuredClone(document);
    const copyTerms = boardTerminals(copy, INDEX);
    const again = suggestionPass(copy, INDEX, copyTerms, placeTerminals(copy, INDEX, copyTerms));
    expect(again).not.toBe(pass);
    expect(again.suggestions).toEqual(pass.suggestions);
  });
});
