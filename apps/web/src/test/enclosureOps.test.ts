/**
 * Cabinet document ops (docs/PANEL_ENCLOSURE.md §10.2, §14 "enclosureOps").
 *
 * Every input is deep-frozen: an op that mutated the board it was given
 * would throw here instead of quietly corrupting the editor's undo-free
 * state. The catalogue is the small test one (`enclosureTestCatalog.ts`).
 */
import { describe, expect, it } from "vitest";

import { catalogIndex } from "../utils/enclosureCatalog";
import {
  addDeviceToRail,
  assignRowToRail,
  ensureRailRow,
  fillRailFromTemplate,
  moveDeviceToRail,
  moveModule,
  normalizeEnclosure,
  orderRowsPhysically,
  placeModule,
  previewClaims,
  railOfRow,
  refreshModuleSnapshot,
  removeEnclosure,
  removeModule,
  setEnclosure,
  setFittingRemoved,
  setMeter,
  setModuleLabel,
  swapModules,
  RAIL_NOT_EMPTY,
  SAME_SIZE_ONLY,
  TOO_MANY_RAILS,
  TOO_MANY_ROWS,
  type OpResult,
} from "../utils/enclosureOps";
import { linkedRows } from "../utils/enclosureLayout";
import type { PanelDocument } from "../types/schaltplan";
import { allDeviceIds, board, deepFreeze, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";

function ok(result: OpResult): Extract<OpResult, { ok: true }> {
  if (!result.ok) throw new Error(`op refused: ${result.error}`);
  return result;
}

function refused(result: OpResult): string {
  if (result.ok) throw new Error("op was expected to refuse");
  return result.error;
}

const cabinetBoard = (rows: PanelDocument["rows"] = [], code = "ZB33S", meterNumber = "") =>
  deepFreeze(board(rows, { code, modules: [] }, meterNumber));

function place(doc: PanelDocument, code: string, field: number, unit = 0, extra: { claim?: boolean; adoptRows?: boolean } = {}) {
  const result = ok(placeModule(deepFreeze(doc), INDEX, { code, field, unit, ...extra }));
  return { doc: deepFreeze(result.document), moduleId: result.moduleId!, result };
}

const devicesOfKind = (doc: PanelDocument, kind: string) => doc.rows.flatMap((r) => r.devices).filter((d) => d.kind === kind);
const rowOf = (doc: PanelDocument, deviceId: string) => doc.rows.find((r) => r.devices.some((d) => d.id === deviceId))!;

describe("placeModule", () => {
  it("creates rows lazily: only the rails that receive a fitting device", () => {
    const empty = place(cabinetBoard(), "ZU37KS", 1);
    expect(empty.doc.rows).toEqual([]);
    expect(empty.doc.enclosure!.modules[0].fittings!.map((f) => f.key)).toEqual(["pe_n"]);

    const meter = place(empty.doc, "ZH3EH16", 0);
    expect(meter.doc.rows.map((r) => [r.label, r.slots])).toEqual([
      ["F1 · AAR 1", 12],
      ["F1 · AAR 2", 12],
    ]);
    const [hs] = devicesOfKind(meter.doc, "hauptschalter");
    const [hlak] = devicesOfKind(meter.doc, "hlak");
    expect(hs.supplied_by).toEqual({ module: meter.moduleId, part: "hs" });
    expect(hlak).toMatchObject({ te: 4, poles: 3, supplied_by: { module: meter.moduleId, part: "hlak" } });
    expect(meter.result.regrouped).toEqual([]);
  });

  it("snapshots the non-retired fittings and gives every meter place an entry", () => {
    const { doc } = place(cabinetBoard(), "ZH3EL22", 0);
    const module = doc.enclosure!.modules[0];
    expect(module.fittings).toEqual([
      { key: "busbar", label: "Sammelschiene 5-polig 12×5 mm (NAR)", article_no: null, device_kind: null, removable: false },
      { key: "bke", label: "BKE-I Zählerplatz", article_no: null, device_kind: null, removable: false },
    ]);
    expect(module.meters).toEqual([
      { place: 0, number: "", label: "" },
      { place: 1, number: "", label: "" },
    ]);
  });

  it("refuses overlap, the last field and the wrong height with the §11 copy", () => {
    const { doc } = place(cabinetBoard(), "ZU37KS", 0);
    expect(refused(placeModule(doc, INDEX, { code: "ZU62A", field: 0, unit: 3 }))).toBe("Nicht genug Platz: 150 mm nötig, 0 mm frei.");
    expect(refused(placeModule(doc, INDEX, { code: "ZU37KS", field: 3, unit: 0 }))).toBe("Ragt über das letzte Feld hinaus.");
    expect(refused(placeModule(doc, INDEX, { code: "ZH5EL27", field: 1, unit: 0 }))).toBe("Für 1350 mm Felder — dieser Schrank hat 1050 mm.");
    expect(refused(placeModule(doc, INDEX, { code: "zz99", field: 1, unit: 0 }))).toBe("Unbekannter Schrank- oder Modulcode: ZZ99.");
    const partial = place(cabinetBoard(), "ZU62A", 1, 2).doc;
    expect(refused(placeModule(partial, INDEX, { code: "ZU37KS", field: 1, unit: 0 }))).toBe("Nicht genug Platz: 1050 mm nötig, 300 mm frei.");
  });

  it("refuses the 121st row and allows the 120th", () => {
    const filler = (count: number) => Array.from({ length: count }, (_, i) => row(`r${i}`, [dev("mcb")]));
    expect(refused(placeModule(cabinetBoard(filler(119)), INDEX, { code: "ZH3EH16", field: 0, unit: 0, claim: false }))).toBe(TOO_MANY_ROWS);
    expect(TOO_MANY_ROWS).toBe("Zu viele Reihen (max. 120) — erst leere Reihen entfernen.");
    expect(ok(placeModule(cabinetBoard(filler(118)), INDEX, { code: "ZH3EH16", field: 0, unit: 0, claim: false })).document.rows).toHaveLength(120);
  });

  it("orders rows physically with the rows outside the cabinet last", () => {
    const legacy = cabinetBoard([row("own", [dev("mcb")], "Reihe 1")]);
    const meter = place(legacy, "ZH3EH16", 1, 0, { claim: false });
    expect(meter.doc.rows.map((r) => r.label)).toEqual(["F2 · AAR 1", "F2 · AAR 2", "Reihe 1"]);
    const rfz = place(meter.doc, "ZY150RFZ", 0, 0);
    const withRfz = ok(addDeviceToRail(rfz.doc, INDEX, rfz.moduleId, "rfz", "terminal")).document;
    // RfZ rails belong to the supply group: before every other rail of the cabinet.
    expect(withRfz.rows.map((r) => r.label)).toEqual(["F1 · RfZ", "F2 · AAR 1", "F2 · AAR 2", "Reihe 1"]);
  });

  it("retrofits a legacy meter board: one HS (the old one, now supplied), the meter becomes a place", () => {
    const hs = dev("hauptschalter", { designation: "Q1", rating: "63 A" });
    const fi = dev("rcd", { designation: "F1" });
    const ls = dev("mcb", { designation: "F1.1", rating: "B16" });
    const meterDevice = dev("meter", { label: "Allgemein" });
    const legacy = cabinetBoard([row("reihe-1", [hs, fi, ls], "Reihe 1"), row("reihe-2", [meterDevice], "Reihe 2")], "ZB33S", "1EBZ0100000001");

    expect(previewClaims(legacy, INDEX, "ZH3EH16")).toEqual({ deviceIds: [hs.id], meterDeviceIds: [meterDevice.id] });
    const { doc, moduleId } = place(legacy, "ZH3EH16", 0);
    const switches = devicesOfKind(doc, "hauptschalter");
    expect(switches).toHaveLength(1);
    expect(switches[0]).toMatchObject({ id: hs.id, designation: "Q1", rating: "63 A", supplied_by: { module: moduleId, part: "hs" } });
    expect(rowOf(doc, hs.id).label).toBe("F1 · AAR 1");
    expect(devicesOfKind(doc, "meter")).toEqual([]);
    expect(doc.enclosure!.modules[0].meters).toEqual([{ place: 0, number: "1EBZ0100000001", label: "Allgemein" }]);
    // The FI and its LS stay where they were, outside the cabinet; the emptied meter row stays the fitter's.
    expect(rowOf(doc, ls.id).id).toBe("reihe-1");
  });

  it("stores the snapshot even when it is empty, so a catalogue fitting added later cannot reach the board", () => {
    const { doc } = place(cabinetBoard(), "ZU37RK", 0);
    expect(doc.enclosure!.modules[0].fittings).toEqual([]);
  });

  it("copies into a meter place only what the board can store", () => {
    // Legacy free text and a long device label: valid where they came from
    // (96 / 160 characters), too long for a meter place (40 / 64) — copied
    // whole, every later autosave would be refused.
    const number = "1 EBZ01 0000 0001 (Wandlermessung, alter Zählerplatz Keller)";
    const label = "Zwischenzähler Wärmepumpe Außeneinheit, Garage hinten links neben dem Tor";
    const legacy = cabinetBoard([row("reihe-1", [dev("meter", { label })], "Reihe 1")], "ZB33S", number);
    const { doc } = place(legacy, "ZH3EH16", 0);
    expect(doc.enclosure!.modules[0].meters).toEqual([{ place: 0, number: number.slice(0, 40), label: label.slice(0, 64) }]);
  });

  it("seeds the meter number only while no meter in the cabinet has one", () => {
    const first = place(cabinetBoard([], "ZB33S", "1EBZ0100000001"), "ZH3EH16", 0).doc;
    const second = place(first, "ZH3EL27", 1).doc;
    expect(second.enclosure!.modules[1].meters).toEqual([{ place: 0, number: "", label: "" }]);
  });

  it("adopts rows only into empty VT/VF rails, top to bottom, sized when they fit — never the terminal rails (R2 §3.6)", () => {
    const legacy = cabinetBoard([
      row("a", [dev("rcd"), dev("mcb")], "Reihe 1", 14),
      row("b", Array.from({ length: 14 }, () => dev("mcb")), "Reihe 2", 14),
    ]);
    const meter = place(legacy, "ZH3EH16", 0, 0, { claim: false, adoptRows: true });
    expect(Object.keys(meter.doc.enclosure!.modules[0].rails).sort()).toEqual(["aar1", "aar2"]);
    const dist = place(meter.doc, "ZU37KS", 1, 0, { adoptRows: true });
    // r1/r2 are the field's terminal rails (docs/PANEL_ENCLOSURE_R2.md R2).
    expect(dist.doc.enclosure!.modules[1].rails).toEqual({ r3: "a", r4: "b" });
    expect(dist.doc.rows.find((r) => r.id === "a")!.slots).toBe(12);
    // 14 TE do not fit on 12 PLE: kept, and the overflow finding says so.
    expect(dist.doc.rows.find((r) => r.id === "b")!.slots).toBe(14);
  });
});

describe("moveModule / swapModules", () => {
  it("moves a module and relabels only the generated row labels", () => {
    const placed = place(cabinetBoard(), "ZH3EH16", 0);
    const aar2 = placed.doc.rows[1].id;
    const named = deepFreeze({ ...placed.doc, rows: placed.doc.rows.map((r) => (r.id === aar2 ? { ...r, label: "Eigene" } : r)) });
    const moved = ok(moveModule(named, INDEX, placed.moduleId, { field: 2, unit: 0 })).document;
    expect(moved.enclosure!.modules[0]).toMatchObject({ field: 2, unit: 0 });
    expect(moved.rows.map((r) => r.label)).toEqual(["F3 · AAR 1", "Eigene"]);
    expect(refused(moveModule(named, INDEX, placed.moduleId, { field: 3, unit: 0 }))).toBe("Ragt über das letzte Feld hinaus.");
  });

  it("swaps modules of the same size only", () => {
    const a = place(cabinetBoard(), "ZU37KS", 0);
    const b = place(a.doc, "ZU37RK", 1);
    const c = place(b.doc, "ZU62A", 2);
    const swapped = ok(swapModules(c.doc, INDEX, a.moduleId, b.moduleId)).document;
    expect(swapped.enclosure!.modules.map((m) => [m.code, m.field])).toEqual([["ZU37KS", 1], ["ZU37RK", 0], ["ZU62A", 2]]);
    expect(refused(swapModules(c.doc, INDEX, a.moduleId, c.moduleId))).toBe(SAME_SIZE_ONLY);
  });
});

describe("removeModule", () => {
  it("deletes its pre-fitted devices, drops emptied rows and keeps the fitter's rows unlinked", () => {
    const placed = place(cabinetBoard(), "ZH3EH16", 0);
    const [hs] = devicesOfKind(placed.doc, "hauptschalter");
    const aar2 = rowOf(placed.doc, devicesOfKind(placed.doc, "hlak")[0].id).id;
    const own = dev("mcb", { parent_id: hs.id });
    const withOwn = deepFreeze({
      ...placed.doc,
      rows: placed.doc.rows.map((r) => (r.id === aar2 ? { ...r, devices: [...r.devices, own] } : r)),
      terminal_labels: { [`${hs.id}:feed`]: "X9", [`${own.id}:1`]: "1.1" },
    });
    const result = ok(removeModule(withOwn, INDEX, placed.moduleId));
    const doc = result.document;
    expect(doc.enclosure!.modules).toEqual([]);
    expect(allDeviceIds(doc)).toEqual([own.id]);
    expect(doc.rows.map((r) => r.id)).toEqual([aar2]);
    expect(linkedRows(doc, INDEX).size).toBe(0);
    expect(doc.rows[0].devices[0].parent_id).toBeNull();
    expect(doc.terminal_labels).toEqual({ [`${own.id}:1`]: "1.1" });
  });
});

describe("setFittingRemoved", () => {
  it("removes the HS by deleting its claimant and restores exactly one, twice or not", () => {
    const placed = place(cabinetBoard(), "ZH3EH16", 0);
    const removed = deepFreeze(ok(setFittingRemoved(placed.doc, INDEX, placed.moduleId, "hs", true)).document);
    expect(devicesOfKind(removed, "hauptschalter")).toEqual([]);
    const once = ok(setFittingRemoved(removed, INDEX, placed.moduleId, "hs", false));
    const twice = ok(setFittingRemoved(deepFreeze(once.document), INDEX, placed.moduleId, "hs", false));
    expect(twice.document).toBe(once.document);
    const switches = devicesOfKind(twice.document, "hauptschalter");
    expect(switches).toHaveLength(1);
    expect(switches[0].supplied_by).toEqual({ module: placed.moduleId, part: "hs" });
    expect(rowOf(twice.document, switches[0].id).devices[0].id).toBe(switches[0].id);
    expect(once.deviceId).toBe(switches[0].id);
  });

  it("lists removable parts without a device in removed_fittings and ignores fixed ones", () => {
    const placed = place(cabinetBoard(), "ZU37VT5APZ2", 2);
    const out = ok(setFittingRemoved(placed.doc, INDEX, placed.moduleId, "rj45", true)).document;
    expect(out.enclosure!.modules[0].removed_fittings).toEqual(["rj45"]);
    const back = ok(setFittingRemoved(deepFreeze(out), INDEX, placed.moduleId, "rj45", false)).document;
    expect(back.enclosure!.modules[0].removed_fittings).toEqual([]);

    const meter = place(cabinetBoard(), "ZH3EH16", 0);
    expect(ok(setFittingRemoved(meter.doc, INDEX, meter.moduleId, "busbar", true)).document).toBe(meter.doc);
    expect(refused(setFittingRemoved(meter.doc, INDEX, meter.moduleId, "nope", true))).toContain("„nope“");
  });
});

describe("rail ops", () => {
  it("moveDeviceToRail puts the legacy SLS into the NAR and keeps supplied_by on moves", () => {
    const sls = dev("sls", { designation: "Q0", rating: "E35" });
    const legacy = cabinetBoard([row("reihe-1", [sls, dev("rcd")], "Reihe 1")]);
    const placed = place(legacy, "ZH3EH16", 0);
    const moved = ok(moveDeviceToRail(placed.doc, INDEX, sls.id, placed.moduleId, "nar")).document;
    expect(rowOf(moved, sls.id).label).toBe("F1 · NAR");
    expect(railOfRow(moved, INDEX, rowOf(moved, sls.id).id)).toEqual({ moduleId: placed.moduleId, railKey: "nar" });

    const [hs] = devicesOfKind(placed.doc, "hauptschalter");
    const hsMoved = ok(moveDeviceToRail(placed.doc, INDEX, hs.id, placed.moduleId, "aar2")).document;
    expect(devicesOfKind(hsMoved, "hauptschalter")[0].supplied_by).toEqual({ module: placed.moduleId, part: "hs" });
    // aar1 emptied and still generated-labelled: pruned with its rail reference.
    expect(hsMoved.enclosure!.modules[0].rails.aar1).toBeUndefined();
  });

  it("an SLS on a meter module's NAR becomes the feed of its Hauptschalter", () => {
    const placed = place(cabinetBoard(), "ZH3EH16", 0);
    const result = ok(addDeviceToRail(placed.doc, INDEX, placed.moduleId, "nar", "sls"));
    const [hs] = devicesOfKind(result.document, "hauptschalter");
    expect(hs.parent_id).toBe(result.deviceId);
    expect(result.document.rows.map((r) => r.label)).toEqual(["F1 · NAR", "F1 · AAR 1", "F1 · AAR 2"]);
  });

  it("numbers breakers added to a rail", () => {
    const placed = place(cabinetBoard(), "ZU37KS", 0);
    const result = ok(addDeviceToRail(placed.doc, INDEX, placed.moduleId, "r1", "mcb"));
    expect(devicesOfKind(result.document, "mcb")[0].circuit).toBe("1");
  });

  it("rotates the phases of single-phase breakers added to a rail, as the row templates do", () => {
    // Review 2: every "+ Gerät" LS had phase "-", so the allpolig sheets drew no LS on its FI.
    const placed = place(cabinetBoard(), "ZU37KS", 0);
    let doc = ok(addDeviceToRail(placed.doc, INDEX, placed.moduleId, "r1", "rcd")).document;
    for (let i = 0; i < 4; i += 1) doc = ok(addDeviceToRail(deepFreeze(doc), INDEX, placed.moduleId, "r1", "mcb")).document;
    expect(devicesOfKind(doc, "mcb").map((d) => d.phase)).toEqual(["L1", "L2", "L3", "L1"]);
    expect(devicesOfKind(doc, "rcd")[0].phase).toBe("-");
  });

  it("fillRailFromTemplate numbers like hand-built rails and keeps the row id and label", () => {
    const placed = place(cabinetBoard(), "ZU37KS", 1);
    const ensured = ensureRailRow(placed.doc, INDEX, placed.moduleId, "r2");
    if ("error" in ensured) throw new Error(ensured.error);
    const named = deepFreeze({ ...ensured.document, rows: ensured.document.rows.map((r) => ({ ...r, label: "Küche" })) });
    const filled = ok(fillRailFromTemplate(named, INDEX, placed.moduleId, "r2", "rcd-8mcb")).document;
    expect(filled.rows).toHaveLength(1);
    expect(filled.rows[0]).toMatchObject({ id: ensured.rowId, label: "Küche", slots: 12 });
    expect(filled.rows[0].devices.map((d) => d.designation)).toEqual(["F1", "F1.1", "F1.2", "F1.3", "F1.4", "F1.5", "F1.6", "F1.7", "F1.8"]);
    expect(refused(fillRailFromTemplate(deepFreeze(filled), INDEX, placed.moduleId, "r2", "mcb-12"))).toBe(RAIL_NOT_EMPTY);
    // A rail without a row gets one.
    const fresh = ok(fillRailFromTemplate(placed.doc, INDEX, placed.moduleId, "r3", "rcd-6mcb")).document;
    expect(fresh.rows[0].label).toBe("F2 · Verteiler 3");
  });

  it("assignRowToRail hangs an outside row onto an empty rail and refuses a full one", () => {
    const legacy = cabinetBoard([row("own", [dev("rcd"), dev("mcb")], "Reihe 1")]);
    const placed = place(legacy, "ZU37KS", 0);
    const hung = ok(assignRowToRail(placed.doc, INDEX, placed.moduleId, "r3", "own")).document;
    expect(railOfRow(hung, INDEX, "own")).toEqual({ moduleId: placed.moduleId, railKey: "r3" });
    const full = ok(addDeviceToRail(deepFreeze(hung), INDEX, placed.moduleId, "r1", "mcb")).document;
    const second = cabinetBoard([...full.rows, row("other", [dev("mcb")], "Reihe 2")]);
    const target = deepFreeze({ ...second, enclosure: full.enclosure });
    expect(refused(assignRowToRail(target, INDEX, placed.moduleId, "r1", "other"))).toBe(RAIL_NOT_EMPTY);
  });

  it("ensureRailRow refuses at the row cap and for unknown rails", () => {
    const placed = place(cabinetBoard(Array.from({ length: 120 }, (_, i) => row(`r${i}`, []))), "ZU37KS", 0);
    expect(ensureRailRow(placed.doc, INDEX, placed.moduleId, "r1")).toEqual({ error: TOO_MANY_ROWS });
    expect(ensureRailRow(placed.doc, INDEX, placed.moduleId, "zz")).toEqual({ error: "Hutschiene „zz“ gibt es in ZU37KS nicht." });
  });

  it("ensureRailRow refuses a rail link past what one module can store", () => {
    // 16 links already (stale keys a hand edit left behind): a 17th would make
    // every save of the board fail, so the op says so instead.
    const stale = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`old${i}`, `gone${i}`]));
    const module = { id: "m", code: "ZU37KS", field: 0, unit: 0, label: "", rails: stale, fittings: [], removed_fittings: [], meters: [] };
    const doc = deepFreeze(board([], { code: "ZB33S", modules: [module] }));
    expect(ensureRailRow(doc, INDEX, "m", "r1")).toEqual({ error: TOO_MANY_RAILS });
    expect(TOO_MANY_RAILS).toBe("Zu viele Hutschienen in einem Modul (max. 16).");
  });
});

describe("cabinet-level ops", () => {
  it("setEnclosure sets, changes and refuses fewer fields or another height", () => {
    const fresh = ok(setEnclosure(deepFreeze(board([row("own", [])])), INDEX, "zb33s")).document;
    expect(fresh.enclosure).toEqual({ code: "ZB33S", modules: [] });
    const placed = place(fresh, "ZU37KS", 2);
    expect(refused(setEnclosure(placed.doc, INDEX, "ZB32S"))).toBe("Der neue Schrank hat nur 2 Felder — erst die Module aus Feld 3 entfernen.");
    expect(refused(setEnclosure(placed.doc, INDEX, "ZB52S"))).toBe("Höhe wechseln geht nur ohne Module — die Feldeinbausätze sind höhengebunden.");
    expect(ok(setEnclosure(placed.doc, INDEX, "ZB35S")).document.enclosure!.code).toBe("ZB35S");
    expect(refused(setEnclosure(placed.doc, INDEX, "ZB99S"))).toBe("Unbekannter Schrank- oder Modulcode: ZB99S.");
  });

  it("removeEnclosure keeps rows and devices and clears supplied_by", () => {
    const placed = place(cabinetBoard(), "ZH3EH16", 0);
    const plain = removeEnclosure(placed.doc);
    expect(plain.enclosure).toBeNull();
    expect(plain.rows.map((r) => r.id)).toEqual(placed.doc.rows.map((r) => r.id));
    expect(plain.rows.flatMap((r) => r.devices).every((d) => d.supplied_by === null)).toBe(true);
    const legacy = deepFreeze(board([]));
    expect(removeEnclosure(legacy)).toBe(legacy);
  });

  it("setMeter edits, frees and re-occupies a place; setModuleLabel renames", () => {
    const placed = place(cabinetBoard(), "ZH3EL22", 0);
    const numbered = deepFreeze(setMeter(placed.doc, placed.moduleId, 1, { number: "1EBZ0100000002", label: "WE 2" }));
    expect(numbered.enclosure!.modules[0].meters[1]).toEqual({ place: 1, number: "1EBZ0100000002", label: "WE 2" });
    const freed = deepFreeze(setMeter(numbered, placed.moduleId, 0, null));
    expect(freed.enclosure!.modules[0].meters.map((m) => m.place)).toEqual([1]);
    expect(setMeter(freed, placed.moduleId, 0, null)).toBe(freed);
    expect(setMeter(freed, placed.moduleId, 0, {}).enclosure!.modules[0].meters).toEqual([
      { place: 0, number: "", label: "" },
      { place: 1, number: "1EBZ0100000002", label: "WE 2" },
    ]);
    expect(setModuleLabel(freed, placed.moduleId, "Allgemein").enclosure!.modules[0].label).toBe("Allgemein");
    expect(setModuleLabel(freed, "missing", "x")).toBe(freed);
  });

  it("setMeter and setModuleLabel keep what they store within the board's limits", () => {
    const placed = place(cabinetBoard(), "ZH3EL22", 0);
    const long = deepFreeze(setMeter(placed.doc, placed.moduleId, 0, { number: "1".repeat(50), label: "W".repeat(80) }));
    expect(long.enclosure!.modules[0].meters[0]).toEqual({ place: 0, number: "1".repeat(40), label: "W".repeat(64) });
    expect(setModuleLabel(long, placed.moduleId, "F".repeat(70)).enclosure!.modules[0].label).toBe("F".repeat(64));
  });

  it("orderRowsPhysically pins circuits whose positional feed would change", () => {
    const fi1 = dev("rcd", { designation: "F1" });
    const fi2 = dev("rcd", { designation: "F2" });
    const loose = dev("mcb", { designation: "F1.9" });
    const doc = deepFreeze(
      board([row("f0", [fi1, dev("mcb")]), row("f2", [loose]), row("f1", [fi2, dev("mcb")])], {
        code: "ZB33S",
        modules: [
          { id: "m0", code: "ZU37KS", field: 0, unit: 0, label: "", rails: { r1: "f0" }, fittings: [], removed_fittings: [], meters: [] },
          { id: "m1", code: "ZU37KS", field: 1, unit: 0, label: "", rails: { r1: "f1" }, fittings: [], removed_fittings: [], meters: [] },
          { id: "m2", code: "ZU37KS", field: 2, unit: 0, label: "", rails: { r1: "f2" }, fittings: [], removed_fittings: [], meters: [] },
        ],
      }),
    );
    const result = ok(orderRowsPhysically(doc, INDEX));
    expect(result.document.rows.map((r) => r.id)).toEqual(["f0", "f1", "f2"]);
    expect(result.pinned).toEqual([loose.id]);
    expect(result.document.rows[2].devices[0].parent_id).toBe(fi1.id);
  });
});

describe("normalizeEnclosure / refreshModuleSnapshot", () => {
  it("gives duplicate module ids new ids and drops a second reference to one row", () => {
    const module = { id: "m", code: "ZU37KS", field: 0, unit: 0, label: "", rails: { r1: "x" }, fittings: [], removed_fittings: [], meters: [] };
    const doc = deepFreeze(board([row("x", [])], { code: "ZB33S", modules: [module, { ...module, field: 1, rails: { r1: "x", r2: "y" } }] }));
    const fixed = normalizeEnclosure(doc);
    const [first, second] = fixed.enclosure!.modules;
    expect(first).toBe(doc.enclosure!.modules[0]);
    expect(second.id).not.toBe("m");
    expect(second.rails).toEqual({ r2: "y" });
    const clean = deepFreeze(normalizeEnclosure(fixed));
    expect(normalizeEnclosure(clean)).toBe(clean);
  });

  it("takes the current catalogue and releases claimants of parts that are gone", () => {
    const placed = place(cabinetBoard(), "ZH3EH16", 0);
    const retired = { ...MODULES.ZH3EH16, fittings: MODULES.ZH3EH16.fittings.map((f) => (f.key === "hlak" ? { ...f, retired: true } : f)) };
    const index = catalogIndex(testCatalog({ modules: { ZH3EH16: retired } }));
    const refreshed = ok(refreshModuleSnapshot(placed.doc, index, placed.moduleId)).document;
    expect(refreshed.enclosure!.modules[0].fittings!.map((f) => f.key)).toEqual(["busbar", "bke", "hs"]);
    expect(devicesOfKind(refreshed, "hlak")[0].supplied_by).toBeNull();
    expect(devicesOfKind(refreshed, "hauptschalter")[0].supplied_by).toEqual({ module: placed.moduleId, part: "hs" });
  });
});
