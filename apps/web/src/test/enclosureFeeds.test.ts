/**
 * No silent re-feeding (docs/PANEL_ENCLOSURE.md D4, §2.4, §14 "enclosureFeeds").
 *
 * The property under test: after any cabinet op, every circuit that the op
 * did not report in `regrouped` hangs off exactly the head it hung off
 * before — pinned circuits included. The direct boards here are built on
 * the test catalogue; the parity fixture's `cross_feed_zb33s` and
 * `meter_dist_zb33s` run the same property in `enclosureParity.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { feedMap, preserveFeeds } from "../utils/enclosureFeeds";
import {
  addDeviceToRail,
  assignRowToRail,
  fillRailFromTemplate,
  moveDeviceToRail,
  moveModule,
  orderRowsPhysically,
  placeModule,
  removeModule,
  setFittingRemoved,
  swapModules,
  type OpResult,
} from "../utils/enclosureOps";
import type { EnclosureModule } from "../types/panelEnclosure";
import { boardDocument, FIXTURE_INDEX } from "./enclosureFixtureBoards";
import { board, deepFreeze, dev, expectFeedsKept, INDEX, row } from "./enclosureTestCatalog";

function ok(result: OpResult): Extract<OpResult, { ok: true }> {
  if (!result.ok) throw new Error(`op refused: ${result.error}`);
  return result;
}

// A hand-made module: no fitting snapshot, so the derivations read the catalogue.
const mod = (id: string, code: string, field: number, rails: Record<string, string> = {}, unit = 0): EnclosureModule => ({
  id, code, field, unit, label: "", rails, fittings: null, removed_fittings: [], meters: [],
});

/**
 * Field 0 holds FI F1 with a breaker; field 2's first rail starts with two
 * breakers that hang off F1 only because their row is stored right after
 * it; field 1 holds FI F2. The rows are stored out of physical order.
 */
function crossFeed() {
  const fi1 = dev("rcd", { designation: "F1" });
  const fi2 = dev("rcd", { designation: "F2" });
  const loose = [dev("mcb", { designation: "F1.8" }), dev("mcb", { designation: "F1.9" })];
  const doc = deepFreeze(
    board([row("v0", [fi1, dev("mcb", { designation: "F1.1" })]), row("v2", loose), row("v1", [fi2, dev("mcb")])], {
      code: "ZB33S",
      modules: [mod("m0", "ZU37KS", 0, { r1: "v0" }), mod("m1", "ZU37KS", 1, { r1: "v1" }), mod("m2", "ZU37KS", 2, { r1: "v2" })],
    }),
  );
  return { doc, fi1, fi2, loose };
}

describe("feedMap", () => {
  it("maps each circuit to its head and the Einspeisung to ''", () => {
    const sls = dev("sls");
    const early = dev("mcb");
    const fi = dev("rcd");
    const late = dev("mcb");
    const map = feedMap(board([row("a", [early, sls, fi, late])]));
    expect(map.get(early.id)).toBe("");
    expect(map.get(late.id)).toBe(fi.id);
    expect(map.has(fi.id)).toBe(false);
  });
});

describe("preserveFeeds", () => {
  it("pins to an old head that still exists and reports the rest", () => {
    const fi = dev("rcd");
    const a = dev("mcb");
    const b = dev("mcb");
    const before = deepFreeze(board([row("x", [fi, a]), row("y", [b])]));
    const after = deepFreeze(board([row("y", [b]), row("x", [fi, a])]));
    const out = preserveFeeds(before, after, new Set());
    expect(out.pinned).toEqual([b.id]);
    expect(out.regrouped).toEqual([]);
    expect(feedMap(out.document)).toEqual(feedMap(before));

    const gone = deepFreeze(board([row("y", [b]), row("x", [a])]));
    // In the order of the document after the op.
    expect(preserveFeeds(before, gone, new Set()).regrouped).toEqual([
      { deviceId: b.id, from: fi.id, to: "" },
      { deviceId: a.id, from: fi.id, to: "" },
    ]);
    expect(preserveFeeds(before, after, new Set([b.id])).pinned).toEqual([]);
    expect(preserveFeeds(before, before, new Set()).document).toBe(before);
  });

  it("an old feed straight from the Einspeisung cannot be pinned", () => {
    const loose = dev("mcb");
    const fi = dev("rcd");
    const before = deepFreeze(board([row("x", [loose]), row("y", [fi])]));
    const after = deepFreeze(board([row("y", [fi]), row("x", [loose])]));
    expect(preserveFeeds(before, after, new Set()).regrouped).toEqual([{ deviceId: loose.id, from: "", to: fi.id }]);
  });
});

describe("every cabinet op keeps feeds", () => {
  it("orderRowsPhysically on the cross-feed board pins the loose breakers to F1", () => {
    const { doc, fi1, loose } = crossFeed();
    const result = ok(orderRowsPhysically(doc, INDEX));
    expect(result.document.rows.map((r) => r.id)).toEqual(["v0", "v1", "v2"]);
    expect(result.pinned.sort()).toEqual(loose.map((d) => d.id).sort());
    expect(loose.every((d) => feedMap(result.document).get(d.id) === fi1.id)).toBe(true);
    expectFeedsKept(doc, result);
  });

  it("place (with a supplied HS between fields), move, swap and remove", () => {
    const { doc } = crossFeed();
    const ordered = deepFreeze(ok(orderRowsPhysically(doc, INDEX)).document);
    const moved = ok(moveModule(ordered, INDEX, "m2", { field: 2, unit: 0 }));
    expectFeedsKept(ordered, moved);
    const swapped = ok(swapModules(ordered, INDEX, "m0", "m2"));
    expectFeedsKept(ordered, swapped);
    const removed = ok(removeModule(ordered, INDEX, "m1"));
    expectFeedsKept(ordered, removed);
  });

  it("claiming an HS into a meter field keeps the FI's breakers and reports what it cannot pin", () => {
    const early = dev("mcb", { designation: "F0.1" });
    const hs = dev("hauptschalter", { designation: "Q1" });
    const fi = dev("rcd", { designation: "F1" });
    const before = deepFreeze(board([row("legacy", [early, hs, fi, dev("mcb"), dev("mcb")], "Reihe 1")], { code: "ZB33S", modules: [] }));
    const placed = ok(placeModule(before, INDEX, { code: "ZH3EH16", field: 0, unit: 0 }));
    expectFeedsKept(before, placed);
    // The breaker left of the HS was fed straight from the Einspeisung; with the
    // HS now on the AAR ahead of it, it would hang off the HS — the UI must ask.
    expect(placed.regrouped).toEqual([{ deviceId: early.id, from: "", to: hs.id }]);
  });

  it("adopt, claim, move to rail and template fill keep every feed", () => {
    const fi = dev("rcd", { designation: "F1" });
    const before = deepFreeze(
      board([row("a", [fi, dev("mcb")], "Reihe 1"), row("b", [dev("mcb"), dev("mcb")], "Reihe 2")], { code: "ZB33S", modules: [] }),
    );
    const adopted = ok(placeModule(before, INDEX, { code: "ZU37KS", field: 1, unit: 0, adoptRows: true }));
    expectFeedsKept(before, adopted);
    const doc = deepFreeze(adopted.document);
    const moduleId = adopted.moduleId!;
    const target = doc.rows.find((r) => r.id === "b")!.devices[0].id;
    expectFeedsKept(doc, ok(moveDeviceToRail(doc, INDEX, target, moduleId, "r5")));
    expectFeedsKept(doc, ok(fillRailFromTemplate(doc, INDEX, moduleId, "r4", "mcb-12")));
    expectFeedsKept(doc, ok(addDeviceToRail(doc, INDEX, moduleId, "r6", "rcd")));
    const extra = deepFreeze({ ...doc, rows: [...doc.rows, row("c", [dev("mcb")], "Reihe 3")] });
    expectFeedsKept(extra, ok(assignRowToRail(extra, INDEX, moduleId, "r3", "c")));
  });

  it("removing the HS fitting reports its circuits as regrouped", () => {
    const empty = deepFreeze(board([], { code: "ZB33S", modules: [] }));
    const placed = ok(placeModule(empty, INDEX, { code: "ZH3EH16", field: 0, unit: 0 }));
    const withCircuit = deepFreeze(ok(addDeviceToRail(placed.document, INDEX, placed.moduleId!, "aar1", "mcb")).document);
    const hs = withCircuit.rows[0].devices[0];
    const circuit = withCircuit.rows[0].devices[1];
    expect(feedMap(withCircuit).get(circuit.id)).toBe(hs.id);
    const removed = ok(setFittingRemoved(withCircuit, INDEX, placed.moduleId!, "hs", true));
    expect(removed.regrouped).toEqual([{ deviceId: circuit.id, from: hs.id, to: "" }]);
  });
});

describe("feed preservation on the parity fixture boards", () => {
  const fx = FIXTURE_INDEX;
  const crossFeedBoard = () => deepFreeze(boardDocument("cross_feed_zb33s"));
  const meterBoard = () => deepFreeze(boardDocument("meter_dist_zb33s"));

  it("cross_feed_zb33s: Reihen ordnen, move, swap and remove keep every feed", () => {
    const doc = crossFeedBoard();
    const ordered = ok(orderRowsPhysically(doc, fx));
    expect(ordered.document.rows.map((r) => r.id)).toEqual(["row-l1", "row-l2", "row-r1", "row-r2"]);
    expectFeedsKept(doc, ordered);
    expectFeedsKept(doc, ok(moveModule(doc, fx, "mod-r", { field: 1, unit: 0 })));
    const swapped = ok(swapModules(doc, fx, "mod-l", "mod-r"));
    expectFeedsKept(doc, swapped);
    // The LS of field 3's first rail now come before FI F1 and are pinned to it.
    expect(swapped.pinned.sort()).toEqual(["dev-r1", "dev-r2"]);
    const removed = ok(removeModule(doc, fx, "mod-l"));
    expectFeedsKept(doc, removed);
    expect(removed.regrouped).toEqual([]);
  });

  it("cross_feed_zb33s: a supplied HS placed between the fields does not take field 3's LS", () => {
    const doc = crossFeedBoard();
    const placed = ok(placeModule(doc, fx, { code: "ZH3EH16", field: 1, unit: 0 }));
    expectFeedsKept(doc, placed);
    expect(placed.regrouped).toEqual([]);
    expect(placed.pinned.sort()).toEqual(["dev-r1", "dev-r2"]);
    expect(feedMap(placed.document).get("dev-r1")).toBe("dev-f1");
  });

  it("cross_feed_zb33s: adopt, claim, move to rail and template fill keep every feed", () => {
    const base = boardDocument("cross_feed_zb33s");
    const hs = dev("hauptschalter", { designation: "Q1" });
    const legacy = deepFreeze({ ...base, rows: [...base.rows, row("row-old", [dev("rcd", { designation: "F9" }), dev("mcb")], "Reihe 1"), row("row-hs", [hs], "Reihe 2")] });
    const adopted = ok(placeModule(legacy, fx, { code: "ZU37KS", field: 1, unit: 0, adoptRows: true, claim: false }));
    expectFeedsKept(legacy, adopted);
    const claimed = ok(placeModule(legacy, fx, { code: "ZH3EH16", field: 1, unit: 0 }));
    expectFeedsKept(legacy, claimed);
    expect(claimed.document.rows.flatMap((r) => r.devices).filter((d) => d.kind === "hauptschalter").map((d) => d.id)).toEqual([hs.id]);

    const doc = crossFeedBoard();
    const moved = ok(moveDeviceToRail(doc, fx, "dev-l1", "mod-r", "r3"));
    expectFeedsKept(doc, moved);
    expect(moved.pinned).toContain("dev-l1");
    expectFeedsKept(doc, ok(fillRailFromTemplate(doc, fx, "mod-l", "r3", "mcb-12")));
  });

  it("meter_dist_zb33s: swap and Reihen ordnen keep every feed", () => {
    const doc = meterBoard();
    expectFeedsKept(doc, ok(swapModules(doc, fx, "mod-v", "mod-a")));
    const ordered = ok(orderRowsPhysically(doc, fx));
    expect(ordered.document).toBe(doc);
  });

  it("meter_dist_zb33s: removing the HS fitting reports the circuits it fed", () => {
    const withCircuit = deepFreeze(ok(addDeviceToRail(meterBoard(), fx, "mod-z", "aar2", "mcb")).document);
    const circuit = withCircuit.rows.find((r) => r.id === "row-aar2")!.devices[1];
    expect(feedMap(withCircuit).get(circuit.id)).toBe("dev-q1");
    const removed = ok(setFittingRemoved(withCircuit, fx, "mod-z", "hs", true));
    expect(removed.regrouped).toEqual([{ deviceId: circuit.id, from: "dev-q1", to: "dev-q0" }]);
    expectFeedsKept(withCircuit, removed);
  });
});
