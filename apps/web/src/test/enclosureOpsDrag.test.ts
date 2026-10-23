/**
 * Device drops in the cabinet (docs/PANEL_ENCLOSURE_R2.md §6.4, R10, R19;
 * owner answer 2026-10-22: a group head drags WITH its circuits).
 *
 * `dropDevice` is positional: the device lands at an index of the target
 * rail, nothing is re-sorted and nothing is pinned. `followPosition` is the
 * one regroup rule shared by the drag, the RailPicker and the inspector
 * arrows: a nudge inside a run keeps a deliberate cross-feed, crossing into
 * another head's run clears it, a head keeps its feeder link.
 *
 * Every input is deep-frozen. Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import { moveDeviceIn } from "../hooks/usePanelDocumentEditor";
import { catalogIndex } from "../utils/enclosureCatalog";
import { feedMap } from "../utils/enclosureFeeds";
import { linkedRows } from "../utils/enclosureLayout";
import { TOO_MANY_ROWS } from "../utils/enclosureOps";
import {
  dragGroup,
  dropDevice,
  followPosition,
  positionalHead,
  ROWS_OUT_OF_ORDER,
  TERMINAL_RAIL_RESERVED,
  type DropResult,
} from "../utils/enclosureOpsDrag";
import { MAX_ROWS } from "../utils/schaltplanDevices";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";
import { board, deepFreeze, dev, INDEX, MODULES, row, testCatalog } from "./enclosureTestCatalog";

const mod = (id: string, code: string, field: number, rails: Record<string, string>): EnclosureModule => ({
  id, code, field, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: [],
});

const ls = (id: string, designation: string, extra: Partial<PanelDevice> = {}) => dev("mcb", { id, designation, ...extra });
const fi = (id: string, designation: string, extra: Partial<PanelDevice> = {}) => dev("rcd", { id, designation, parent_id: "hs1", ...extra });

/**
 * ZB33S. Feld 1 (ZU37KS "mv"): r1 = HS Q1, FI F1 + F1.1–F1.3; r2 = FI F2 + F2.1, F2.2.
 * Feld 2 (ZU37KS "mw"): r1 = FI F3 + F3.1. Every row carries its generated label.
 */
function base(patch: (rows: PanelRow[]) => PanelRow[] = (rows) => rows): PanelDocument {
  const rows = [
    row("v1", [dev("hauptschalter", { id: "hs1", designation: "Q1" }), fi("fi1", "F1"), ls("a1", "F1.1"), ls("a2", "F1.2"), ls("a3", "F1.3")], "F1 · Verteiler 1"),
    row("v2", [fi("fi2", "F2"), ls("b1", "F2.1"), ls("b2", "F2.2")], "F1 · Verteiler 2"),
    row("w1", [fi("fi3", "F3"), ls("c1", "F3.1")], "F2 · Verteiler 1"),
  ];
  return deepFreeze(board(patch(rows), { code: "ZB33S", modules: [mod("mv", "ZU37KS", 0, { r1: "v1", r2: "v2" }), mod("mw", "ZU37KS", 1, { r1: "w1" })] }));
}

/** A device patched in place of the test board (rows rebuilt, never edited). */
function withDevice(id: string, patch: Partial<PanelDevice>) {
  return (rows: PanelRow[]) => rows.map((r) => ({ ...r, devices: r.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
}

function ok(result: DropResult): Extract<DropResult, { ok: true }> {
  if (!result.ok) throw new Error(`drop refused: ${result.error}`);
  return result;
}

function refused(result: DropResult): string {
  if (result.ok) throw new Error("drop was expected to refuse");
  return result.error;
}

const ids = (doc: PanelDocument, rowId: string) => doc.rows.find((r) => r.id === rowId)!.devices.map((d) => d.id);
const device = (doc: PanelDocument, id: string) => doc.rows.flatMap((r) => r.devices).find((d) => d.id === id)!;
const feedOf = (doc: PanelDocument, id: string) => feedMap(doc).get(id);
const rowOfDevice = (doc: PanelDocument, id: string) => doc.rows.find((r) => r.devices.some((d) => d.id === id))!;
const target = (moduleId: string, railKey: string, at: number) => ({ moduleId, railKey, at });

describe("dropDevice — index semantics", () => {
  it("moves right and left on the same rail; `at` counts the rail's other devices", () => {
    const right = ok(dropDevice(base(), INDEX, "a1", target("mv", "r1", 4)));
    expect(ids(right.document, "v1")).toEqual(["hs1", "fi1", "a2", "a3", "a1"]);
    expect(right.unchanged).toBe(false);
    expect(right.deviceId).toBe("a1");

    const left = ok(dropDevice(base(), INDEX, "a3", target("mv", "r1", 2)));
    expect(ids(left.document, "v1")).toEqual(["hs1", "fi1", "a3", "a1", "a2"]);
    expect(left.changes).toEqual([]);
  });

  it("clamps an index past the end", () => {
    const moved = ok(dropDevice(base(), INDEX, "a1", target("mv", "r2", 99)));
    expect(ids(moved.document, "v2")).toEqual(["fi2", "b1", "b2", "a1"]);
  });

  it("onto another rail: the LS hangs off the head of its new run, and the change is listed", () => {
    const moved = ok(dropDevice(base(), INDEX, "a1", target("mv", "r2", 1)));
    expect(ids(moved.document, "v1")).toEqual(["hs1", "fi1", "a2", "a3"]);
    expect(ids(moved.document, "v2")).toEqual(["fi2", "a1", "b1", "b2"]);
    expect(feedOf(moved.document, "a1")).toBe("fi2");
    expect(moved.changes).toEqual([{ deviceId: "a1", from: "fi1", to: "fi2" }]);
  });

  it("onto an empty rail: the rail's row is created at its physical place", () => {
    const moved = ok(dropDevice(base(), INDEX, "a1", target("mv", "r3", 0)));
    const created = rowOfDevice(moved.document, "a1");
    expect(created).toMatchObject({ label: "F1 · Verteiler 3", slots: 12 });
    expect(moved.document.rows.map((r) => r.id)).toEqual(["v1", "v2", created.id, "w1"]);
    expect(linkedRows(moved.document, INDEX).get(created.id)).toEqual({ moduleId: "mv", railKey: "r3" });
    expect(feedOf(moved.document, "a1")).toBe("fi2");
  });

  it("prunes the generated row it emptied, with its rail link", () => {
    const start = base((rows) => [...rows.slice(0, 2), row("w1", [ls("c9", "F9.1")], "F2 · Verteiler 1")]);
    const moved = ok(dropDevice(start, INDEX, "c9", target("mv", "r2", 3)));
    expect(moved.document.rows.map((r) => r.id)).toEqual(["v1", "v2"]);
    expect(moved.document.enclosure!.modules.find((m) => m.id === "mw")!.rails).toEqual({});
  });

  it("same rail, same place: unchanged, and the very same document (nothing to save)", () => {
    const start = base();
    const same = ok(dropDevice(start, INDEX, "a2", target("mv", "r1", 3)));
    expect(same.unchanged).toBe(true);
    expect(same.document).toBe(start);
    expect(same.changes).toEqual([]);
  });

  it("keeps a pre-fitted part pre-fitted", () => {
    const start = base(withDevice("hs1", { supplied_by: { module: "mv", part: "hs" } }));
    const moved = ok(dropDevice(start, INDEX, "a1", target("mw", "r1", 2)));
    expect(device(moved.document, "hs1").supplied_by).toEqual({ module: "mv", part: "hs" });
    expect(ids(moved.document, "w1")).toEqual(["fi3", "c1", "a1"]);
  });
});

describe("followPosition (R10) — the one regroup rule", () => {
  const crossFed = () => base(withDevice("a2", { parent_id: "fi3" }));

  it("a nudge within a run keeps a deliberate cross-feed", () => {
    const moved = ok(dropDevice(crossFed(), INDEX, "a2", target("mv", "r1", 4)));
    expect(ids(moved.document, "v1")).toEqual(["hs1", "fi1", "a1", "a3", "a2"]);
    expect(device(moved.document, "a2").parent_id).toBe("fi3");
    expect(moved.changes).toEqual([]);
  });

  it("crossing into another head's run clears it: the LS follows its new position", () => {
    const moved = ok(dropDevice(crossFed(), INDEX, "a2", target("mv", "r2", 1)));
    expect(device(moved.document, "a2").parent_id).toBeNull();
    expect(feedOf(moved.document, "a2")).toBe("fi2");
    expect(moved.changes).toEqual([{ deviceId: "a2", from: "fi3", to: "fi2" }]);
  });

  it("a head keeps its feeder link wherever it goes", () => {
    const moved = ok(dropDevice(base(), INDEX, "fi2", target("mw", "r1", 2)));
    expect(device(moved.document, "fi2").parent_id).toBe("hs1");
  });

  it("returns `after` itself when nothing needs clearing", () => {
    const before = crossFed();
    const after = deepFreeze({ ...before, rows: before.rows.map((r) => ({ ...r })) });
    expect(followPosition(before, after, "a2")).toBe(after);
    expect(followPosition(before, after, "a1")).toBe(after);
    expect(followPosition(before, after, "gone")).toBe(after);
  });

  it("positionalHead ignores the device's own parent_id; '' before the first head", () => {
    const doc = crossFed();
    expect(positionalHead(doc, "a2")).toBe("fi1");
    expect(positionalHead(doc, "b1")).toBe("fi2");
    expect(positionalHead(doc, "hs1")).toBe("");
    expect(positionalHead(doc, "nope")).toBeNull();
  });
});

describe("the inspector arrows follow position too (moveDeviceIn)", () => {
  it("a nudge within a run keeps a deliberate cross-feed", () => {
    const moved = moveDeviceIn(base(withDevice("a2", { parent_id: "fi3" })), "a2", 1);
    expect(ids(moved, "v1")).toEqual(["hs1", "fi1", "a1", "a3", "a2"]);
    expect(device(moved, "a2").parent_id).toBe("fi3");
  });

  it("hopping in front of the next head keeps it; stepping past that head clears it", () => {
    const start = base((rows) => [
      { ...rows[0], devices: rows[0].devices.filter((d) => d.id !== "a3").map((d) => (d.id === "a2" ? { ...d, parent_id: "fi3" } : d)) },
      ...rows.slice(1),
    ]);
    const hop = moveDeviceIn(start, "a2", 1);
    expect(ids(hop, "v2")).toEqual(["a2", "fi2", "b1", "b2"]);
    expect(device(hop, "a2").parent_id).toBe("fi3");
    const past = moveDeviceIn(deepFreeze(hop), "a2", 1);
    expect(ids(past, "v2")).toEqual(["fi2", "a2", "b1", "b2"]);
    expect(device(past, "a2").parent_id).toBeNull();
    expect(feedOf(past, "a2")).toBe("fi2");
  });

  it("a head keeps its feeder link", () => {
    const moved = moveDeviceIn(base(), "fi2", -1);
    expect(ids(moved, "v1")).toEqual(["hs1", "fi1", "a1", "a2", "a3", "fi2"]);
    expect(device(moved, "fi2").parent_id).toBe("hs1");
  });

  it("returns the input itself at the board's edge", () => {
    const start = base();
    expect(moveDeviceIn(start, "hs1", -1)).toBe(start);
  });
});

describe("a group head drags with its circuits (owner, 2026-10-22)", () => {
  it("the FI travels with the circuits it feeds, in order", () => {
    expect(dragGroup(base(), INDEX, "fi2")).toEqual(["fi2", "b1", "b2"]);
    const moved = ok(dropDevice(base(), INDEX, "fi2", target("mw", "r1", 2)));
    expect(ids(moved.document, "w1")).toEqual(["fi3", "c1", "fi2", "b1", "b2"]);
    // The emptied generated row goes.
    expect(moved.document.rows.map((r) => r.id)).toEqual(["v1", "w1"]);
    expect(feedOf(moved.document, "b1")).toBe("fi2");
    expect(moved.changes).toEqual([]);
  });

  it("dropped into another run, the circuits after it re-hang by position and are listed", () => {
    const moved = ok(dropDevice(base(), INDEX, "fi2", target("mw", "r1", 1)));
    expect(ids(moved.document, "w1")).toEqual(["fi3", "fi2", "b1", "b2", "c1"]);
    expect(moved.changes).toEqual([{ deviceId: "c1", from: "fi3", to: "fi2" }]);
  });

  it("a circuit of its field pinned to it from another run travels too, right behind it", () => {
    const start = base(withDevice("a3", { parent_id: "fi2" }));
    expect(feedOf(start, "a3")).toBe("fi2");
    expect(dragGroup(start, INDEX, "fi2")).toEqual(["fi2", "a3", "b1", "b2"]);
    const moved = ok(dropDevice(start, INDEX, "fi2", target("mw", "r1", 2)));
    expect(ids(moved.document, "v1")).toEqual(["hs1", "fi1", "a1", "a2"]);
    expect(ids(moved.document, "w1")).toEqual(["fi3", "c1", "fi2", "a3", "b1", "b2"]);
    // It hangs off its FI by position now: same feed, the pin is no longer needed.
    expect(feedOf(moved.document, "a3")).toBe("fi2");
    expect(device(moved.document, "a3").parent_id).toBeNull();
    expect(moved.changes).toEqual([]);
  });

  it("a circuit pinned in from another field stays where it is, and keeps its feed", () => {
    const start = base(withDevice("c1", { parent_id: "fi2" }));
    expect(dragGroup(start, INDEX, "fi2")).toEqual(["fi2", "b1", "b2"]);
    const moved = ok(dropDevice(start, INDEX, "fi2", target("mv", "r1", 5)));
    expect(ids(moved.document, "w1")).toEqual(["fi3", "c1"]);
    expect(feedOf(moved.document, "c1")).toBe("fi2");
  });

  it("circuits of its run in another field stay in that field", () => {
    const start = base((rows) => [...rows.slice(0, 2), row("w1", [ls("c1", "F3.1")], "F2 · Verteiler 1")]);
    expect(feedOf(start, "c1")).toBe("fi2");
    expect(dragGroup(start, INDEX, "fi2")).toEqual(["fi2", "b1", "b2"]);
  });

  it("a circuit drags alone; an unknown device has no group", () => {
    expect(dragGroup(base(), INDEX, "a1")).toEqual(["a1"]);
    expect(dragGroup(base(), INDEX, "nope")).toEqual([]);
  });

  it("dropping a group where it already is changes nothing", () => {
    const start = base();
    const same = ok(dropDevice(start, INDEX, "fi2", target("mv", "r2", 0)));
    expect(same.unchanged).toBe(true);
    expect(same.document).toBe(start);
  });
});

describe("dropDevice — refusals", () => {
  it("refuses a rail reserved for terminals", () => {
    const reserved = new Set(["mv:r3"]);
    expect(refused(dropDevice(base(), INDEX, "a1", target("mv", "r3", 0), { reserved }))).toBe(TERMINAL_RAIL_RESERVED);
    expect(TERMINAL_RAIL_RESERVED).toBe("Diese Hutschiene ist für Reihenklemmen reserviert.");
  });

  it("refuses a retired rail", () => {
    const retired = {
      ...MODULES.ZU37KS,
      zones: MODULES.ZU37KS.zones.map((zone) => ({ ...zone, rails: zone.rails.map((rail) => (rail.key === "r7" ? { ...rail, retired: true } : rail)) })),
    };
    const index = catalogIndex(testCatalog({ modules: { ZU37KS: retired } }));
    expect(refused(dropDevice(base(), index, "a1", target("mv", "r7", 0)))).toMatch(/ausgemustert/);
  });

  it("refuses on a board whose rows are not in cabinet order (R19)", () => {
    const shuffled = base((rows) => [rows[2], rows[0], rows[1]]);
    expect(refused(dropDevice(shuffled, INDEX, "a1", target("mv", "r2", 0)))).toBe(ROWS_OUT_OF_ORDER);
    expect(ROWS_OUT_OF_ORDER).toBe("Reihen sind nicht in Schrankreihenfolge — erst „Reihen ordnen“.");
  });

  it("refuses the 121st row", () => {
    const full = base((rows) => [...rows, ...Array.from({ length: MAX_ROWS - rows.length }, (_, i) => row(`x${i}`, [], `Reihe ${i}`))]);
    expect(full.rows).toHaveLength(MAX_ROWS);
    expect(refused(dropDevice(full, INDEX, "a1", target("mv", "r3", 0)))).toBe(TOO_MANY_ROWS);
    // An existing rail row needs no new row.
    expect(ok(dropDevice(full, INDEX, "a1", target("mv", "r2", 0))).document.rows).toHaveLength(MAX_ROWS);
  });

  it("refuses an unknown device and an unknown rail", () => {
    expect(refused(dropDevice(base(), INDEX, "nope", target("mv", "r1", 0)))).toBe("Gerät nicht gefunden.");
    expect(refused(dropDevice(base(), INDEX, "a1", target("mv", "zz", 0)))).toMatch(/zz/);
    expect(refused(dropDevice(base(), INDEX, "a1", target("gone", "r1", 0)))).toBe("Modul nicht gefunden.");
  });
});
