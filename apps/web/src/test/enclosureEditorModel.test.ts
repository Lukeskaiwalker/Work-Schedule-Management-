/**
 * The Aufbau tab's groups (docs/PANEL_ENCLOSURE_R2.md §9, O6): every module
 * of the cabinet gets a group and every rail an entry — a row, or an empty
 * rail to put the first device on. Before the fix a module without a linked
 * row was skipped, which hid an empty ZU37VT5APZ2, every cover, every
 * unknown code and an empty custom-labelled row on a retired rail.
 * Invented boards only — the repo is public.
 */
import { describe, expect, it } from "vitest";

import {
  OUTSIDE_TITLE,
  railEditorGroups,
  reservedRailLine,
  rowHoldsDevices,
  setAllTerminalsOnBoard,
  terminalBlockedZone,
  type RailEditorEntry,
  type RailEditorGroup,
} from "../components/schaltplan/enclosure/enclosureEditorModel";
import { catalogIndex } from "../utils/enclosureCatalog";
import { boardTerminals } from "../utils/enclosureTerminals";
import { NO_SKIP } from "../utils/schaltplanTerminalRules";
import type { PanelDocument } from "../types/schaltplan";
import { AUFBAU_INDEX, aufbauCatalog, mod, OWNER_GROUP_TITLES, ownerBoard, withRetiredBottomRail } from "./enclosureAufbauBoards";
import { boardDocument, FIXTURE_INDEX } from "./enclosureFixtureBoards";
import { board, deepFreeze, dev, INDEX, MODULES, row } from "./enclosureTestCatalog";

/** "row:{id}" or "empty:{railKey}:{title}:{ple}" — one string per entry, so a whole group compares at once. */
const describeEntry = (entry: RailEditorEntry) =>
  entry.kind === "row" ? `row:${entry.row.id}` : `empty:${entry.railKey}:${entry.title}:${entry.ple}`;
const entriesOf = (group: RailEditorGroup | undefined) => (group?.entries ?? []).map(describeEntry);
const groupOf = (groups: RailEditorGroup[] | null, key: string) => groups?.find((group) => group.key === key);

describe("railEditorGroups — the owner's ZB34S (ZH3EL16 / ZH3EH16 / empty ZU37VT5APZ2 / ZU37KS)", () => {
  const groups = railEditorGroups(deepFreeze(ownerBoard()), AUFBAU_INDEX);

  it("lists all four modules, the Verteilerfeld without any row included", () => {
    expect(groups?.map((group) => group.title)).toEqual(OWNER_GROUP_TITLES);
    expect(groups?.every((group) => group.linked && group.note === null)).toBe(true);
  });

  it("gives the empty ZU37VT5APZ2 one empty entry per rail: five Verteiler rails and the APZ", () => {
    expect(entriesOf(groupOf(groups, "m-vt"))).toEqual([
      "empty:r1:F3 · Verteiler 1:12",
      "empty:r2:F3 · Verteiler 2:12",
      "empty:r3:F3 · Verteiler 3:12",
      "empty:r4:F3 · Verteiler 4:12",
      "empty:r5:F3 · Verteiler 5:12",
      "empty:apz:F3 · APZ:6",
    ]);
    const first = groupOf(groups, "m-vt")!.entries[0];
    expect(first).toEqual({ kind: "empty", moduleId: "m-vt", railKey: "r1", title: "F3 · Verteiler 1", ple: 12, reserved: true, xLabels: [] });
  });

  it("mixes rows and empty rails top to bottom in the meter fields and the ZU37KS", () => {
    expect(entriesOf(groupOf(groups, "m-el"))).toEqual(["empty:aar1:F1 · AAR 1:12", "row:el-aar2", "empty:rfz:F1 · RfZ:12", "row:el-nar"]);
    expect(entriesOf(groupOf(groups, "m-eh"))).toEqual(["row:eh-aar1", "empty:aar2:F2 · AAR 2:12", "empty:rfz:F2 · RfZ:12", "row:eh-nar"]);
    expect(entriesOf(groupOf(groups, "m-ks"))).toEqual([
      "row:ks-r1",
      "row:ks-r2",
      "empty:r3:F4 · Verteiler 3:12",
      "empty:r4:F4 · Verteiler 4:12",
      "empty:r5:F4 · Verteiler 5:12",
      "empty:r6:F4 · Verteiler 6:12",
      "empty:r7:F4 · Verteiler 7:12",
    ]);
  });

  it("reserves the two top Verteiler rails of each Verteilerfeld — rows and empty rails alike (R2, §3.2)", () => {
    const reserved = groups?.flatMap((group) => group.entries.filter((entry) => entry.reserved).map(describeEntry));
    expect(reserved).toEqual(["empty:r1:F3 · Verteiler 1:12", "empty:r2:F3 · Verteiler 2:12", "row:ks-r1", "row:ks-r2"]);
  });

  it("has no Nicht-im-Schrank group when every row hangs on a rail", () => {
    expect(groups?.some((group) => group.title === OUTSIDE_TITLE)).toBe(false);
  });
});

describe("railEditorGroups — modules without rails", () => {
  it("keeps a cover with the note „Keine Hutschiene“", () => {
    const doc = board([], { code: "ZB33S", modules: [mod("m-cover", "ZU62A", 0), mod("m-ks", "ZU37KS", 1)] });
    const groups = railEditorGroups(doc, INDEX);
    expect(groups?.map((group) => group.key)).toEqual(["m-cover", "m-ks"]);
    expect(groupOf(groups, "m-cover")).toEqual({
      key: "m-cover",
      title: "Feld 1 · ZU62A Modul ZU62A",
      linked: true,
      entries: [],
      note: "Keine Hutschiene",
    });
  });

  it("keeps an unknown code with its note; its rows go under „Nicht im Schrank“", () => {
    const doc = board([row("lost", [dev("mcb", { id: "b1" })], "Reihe Altbestand")], {
      code: "ZB33S",
      modules: [mod("m-x", "ZX99Q", 0, { r1: "lost" }, { label: "Altfeld" })],
    });
    const groups = railEditorGroups(doc, INDEX);
    expect(groups?.map((group) => [group.title, group.note])).toEqual([
      ["Feld 1 · ZX99Q Altfeld", "Modulcode unbekannt — Reihen unter „Nicht im Schrank“"],
      [OUTSIDE_TITLE, null],
    ]);
    expect(entriesOf(groupOf(groups, "m-x"))).toEqual([]);
    expect(groupOf(groups, "outside")).toEqual({
      key: "outside",
      title: OUTSIDE_TITLE,
      linked: false,
      entries: [{ kind: "row", row: doc.rows[0], reserved: false, xLabels: [] }],
      note: null,
    });
  });
});

describe("railEditorGroups — the retired-rail blind spot", () => {
  const index = catalogIndex(aufbauCatalog({ ZU37KS: withRetiredBottomRail(MODULES.ZU37KS) }));

  it("lists an empty, custom-labelled row on a retired rail after the module's rails", () => {
    const doc = board([row("res", [], "Reserve Wallbox")], { code: "ZB32S", modules: [mod("m-ks", "ZU37KS", 0, { r7: "res" })] });
    const groups = railEditorGroups(doc, index);
    expect(entriesOf(groupOf(groups, "m-ks"))).toEqual([
      "empty:r1:F1 · Verteiler 1:12",
      "empty:r2:F1 · Verteiler 2:12",
      "empty:r3:F1 · Verteiler 3:12",
      "empty:r4:F1 · Verteiler 4:12",
      "empty:r5:F1 · Verteiler 5:12",
      "empty:r6:F1 · Verteiler 6:12",
      "row:res",
    ]);
    expect(groups?.some((group) => group.title === OUTSIDE_TITLE)).toBe(false);
  });

  it("offers no empty entry for a retired rail without a row: nothing new goes onto it", () => {
    const doc = board([], { code: "ZB32S", modules: [mod("m-ks", "ZU37KS", 0)] });
    expect(entriesOf(groupOf(railEditorGroups(doc, index), "m-ks"))).not.toContain("empty:r7:F1 · Verteiler 7:12");
    expect(groupOf(railEditorGroups(doc, index), "m-ks")?.entries).toHaveLength(6);
  });

  it("keeps a retired rail that still holds devices in its place", () => {
    const doc = board([row("full", [dev("mcb", { id: "b7" })], "F1 · Verteiler 7")], {
      code: "ZB32S",
      modules: [mod("m-ks", "ZU37KS", 0, { r7: "full" })],
    });
    const entries = entriesOf(groupOf(railEditorGroups(doc, index), "m-ks"));
    expect(entries[entries.length - 1]).toBe("row:full");
  });
});

describe("railEditorGroups — unchanged parts", () => {
  it("still returns null without a cabinet", () => {
    expect(railEditorGroups(board([row("r1", [])]), INDEX)).toBeNull();
  });

  it("keeps „Nicht im Schrank“ last, rows in document order", () => {
    const doc: PanelDocument = board(
      [row("b", [], "Reihe B"), row("v1", [dev("rcd", { id: "f1" })], "F1 · Verteiler 1"), row("a", [], "Reihe A")],
      { code: "ZB33S", modules: [mod("m-ks", "ZU37KS", 0, { r1: "v1" })] },
    );
    const groups = railEditorGroups(doc, INDEX)!;
    const last = groups[groups.length - 1];
    expect(last.title).toBe(OUTSIDE_TITLE);
    expect(entriesOf(last)).toEqual(["row:b", "row:a"]);
  });

  it("orders the groups as the cabinet reads, field by field", () => {
    const doc = board([], { code: "ZB33S", modules: [mod("m3", "ZU37KS", 2), mod("m1", "ZU62A", 0), mod("m2", "ZU37VT5APZ2", 1)] });
    expect(railEditorGroups(doc, INDEX)?.map((group) => group.key)).toEqual(["m1", "m2", "m3"]);
  });
});

// ── Round 2, W4b: the WAGO terminal rails on the Aufbau tab (§3.1, §3.2, §9) ──

/** The fixture's owner board (§14.1 `terminals_zb34s`): rows on F2's r1/r2, an empty RK field, a full field 4. */
const terminalsBoard = () => deepFreeze(boardDocument("terminals_zb34s"));
const deviceOf = (doc: PanelDocument, id: string) => doc.rows.flatMap((candidate) => candidate.devices).find((device) => device.id === id);

describe("railEditorGroups — reserved terminal rails with their strips", () => {
  const groups = railEditorGroups(terminalsBoard(), FIXTURE_INDEX);
  const reservedOf = (key: string) =>
    (groupOf(groups, key)?.entries ?? []).filter((entry) => entry.reserved).map((entry) =>
      entry.kind === "row" ? `row:${entry.row.id}` : `empty:${entry.railKey}:${entry.xLabels.join(",")}`,
    );

  it("marks the back-compat rows on F2's top rails reserved, and nothing in the meter field", () => {
    expect(reservedOf("mod-z")).toEqual([]);
    expect(reservedOf("mod-k")).toEqual(["row:row-old1", "row:row-old2"]);
  });

  it("gives an empty reserved rail the X labels placed on it, in rail order — none yet on the empty RK field", () => {
    expect(reservedOf("mod-rk")).toEqual(["empty:r1:", "empty:r2:"]);
    expect(reservedOf("mod-w")).toEqual(["empty:r1:X7,X8,X10", "empty:r2:X9,X11,X12"]);
  });

  it("gives a reserved row the X labels placed after its devices", () => {
    const rows = groupOf(groups, "mod-k")!.entries.filter((entry) => entry.kind === "row" && entry.reserved);
    expect(rows.map((entry) => entry.xLabels)).toEqual([["X1"], ["X2", "X3"]]);
  });

  it("keeps every rail below the terminal rails open, with no X labels", () => {
    const open = groupOf(groups, "mod-rk")!.entries.filter((entry) => !entry.reserved);
    expect(open.map(describeEntry)).toEqual([3, 4, 5, 6, 7].map((n) => `empty:r${n}:F3 · Verteiler ${n}:12`));
    expect(open.every((entry) => entry.kind === "empty" && entry.xLabels.length === 0)).toBe(true);
  });

  it("reserves nothing under „Nicht im Schrank“", () => {
    const doc = board([row("loose", [dev("mcb", { id: "b1", terminal_block: true })], "Reihe lose")], {
      code: "ZB32S",
      modules: [mod("m-ks", "ZU37KS", 0)],
    });
    const outside = groupOf(railEditorGroups(doc, INDEX), "outside");
    expect(outside?.entries.map((entry) => entry.reserved)).toEqual([false]);
  });
});

describe("rowHoldsDevices — whether a reserved row's devices must move down (R12)", () => {
  it("counts devices, but not the hand-placed „Reihenklemme N/PE“ placeholders", () => {
    expect(rowHoldsDevices(row("a", [dev("mcb", { id: "b1" })]))).toBe(true);
    expect(rowHoldsDevices(row("b", [dev("terminal", { id: "p1" })]))).toBe(false);
    expect(rowHoldsDevices(row("c", []))).toBe(false);
  });
});

describe("reservedRailLine — what an empty reserved rail says (§9)", () => {
  it("says „noch keine“ while no strip sits on the rail", () => {
    expect(reservedRailLine([])).toBe("für Reihenklemmen reserviert · noch keine");
  });

  it("lists the strips on it, at most four, then how many more", () => {
    expect(reservedRailLine(["X7", "X8", "X10"])).toBe("für Reihenklemmen reserviert · X7, X8, X10");
    expect(reservedRailLine(["X1", "X2", "X3", "X4", "X5", "X6"])).toBe("für Reihenklemmen reserviert · X1, X2, X3, X4 und 2 weitere");
  });
});

describe("terminalBlockedZone — the inspector's note instead of the checkbox (§3.1)", () => {
  const doc = terminalsBoard();
  const { skip } = boardTerminals(doc, FIXTURE_INDEX);

  it("names the zone of a circuit on a no-WAGO rail", () => {
    expect(terminalBlockedZone(doc, FIXTURE_INDEX, skip, "dev-aar-ls1")).toBe("AAR");
  });

  it("is null for a circuit in a Verteilerfeld, an unknown device and no selection", () => {
    expect(terminalBlockedZone(doc, FIXTURE_INDEX, skip, "dev-f1-1")).toBeNull();
    expect(terminalBlockedZone(doc, FIXTURE_INDEX, skip, "dev-nope")).toBeNull();
    expect(terminalBlockedZone(doc, FIXTURE_INDEX, skip, null)).toBeNull();
  });

  it("is null before the catalogue is there and on a board without a cabinet", () => {
    expect(terminalBlockedZone(doc, null, skip, "dev-aar-ls1")).toBeNull();
    const plain = board([row("r1", [dev("mcb", { id: "b1", terminal_block: true })])]);
    expect(terminalBlockedZone(plain, INDEX, NO_SKIP, "b1")).toBeNull();
  });
});

describe("setAllTerminalsOnBoard — the Klemmen tab's bulk switch with the skip set (§3.1)", () => {
  it("leaves the AAR circuit's flag alone, both ways, and clears the Verteilerfeld's", () => {
    const doc = terminalsBoard();
    const off = setAllTerminalsOnBoard(doc, FIXTURE_INDEX, false);
    expect(deviceOf(off, "dev-aar-ls1")?.terminal_block).toBe(true);
    expect(deviceOf(off, "dev-f1-1")?.terminal_block).toBe(false);

    const aarOff: PanelDocument = {
      ...doc,
      rows: doc.rows.map((candidate) => ({
        ...candidate,
        devices: candidate.devices.map((device) => (device.id === "dev-aar-ls1" ? { ...device, terminal_block: false } : device)),
      })),
    };
    expect(deviceOf(setAllTerminalsOnBoard(aarOff, FIXTURE_INDEX, true), "dev-aar-ls1")?.terminal_block).toBe(false);
  });

  it("changes nothing on a cabinet board while the catalogue is not there", () => {
    const doc = terminalsBoard();
    expect(setAllTerminalsOnBoard(doc, null, false)).toBe(doc);
  });

  it("flags every outgoing of a board without a cabinet, as before", () => {
    const plain = board([row("r1", [dev("rcd", { id: "f1" }), dev("mcb", { id: "b1" })])]);
    expect(deviceOf(setAllTerminalsOnBoard(plain, null, true), "b1")?.terminal_block).toBe(true);
  });
});
