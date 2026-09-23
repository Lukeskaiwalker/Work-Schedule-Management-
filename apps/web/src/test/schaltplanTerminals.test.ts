/**
 * Reihenklemmen — the WAGO terminal strips derived per FI group, with X
 * numbers.
 *
 * The rule table lives twice: here (live tab and print preview) and in
 * `apps/api/app/services/schaltplan_terminals.py` (print job and PDF).
 * `schaltplanTerminalFixtures.test.ts` walks the backend's own output; this
 * file pins the rules one at a time, so a red test says which rule moved —
 * two Etagenklemmen for three phases, the Block by rating, X numbering
 * across groups, overrides, the strips a selection prints, the board font
 * size, the legend labels.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import { fontSizeForSegments } from "../utils/schaltplanStrip";
import {
  BLOCK_MIN_AMPS_EXCLUSIVE,
  TERMINAL_PARTS,
  isBlockDevice,
  isTerminalEligible,
  outgoingPartsForPoles,
  ratingAmps,
  terminalFindings,
  terminalVariant,
} from "../utils/schaltplanTerminalRules";
import {
  TERMINAL_SEG_PAD_DOTS,
  deriveTerminals,
  deviceTerminalLabels,
  labelOverrides,
  overrideKey,
  setTerminalLabel,
  terminalBom,
  terminalCounts,
  terminalFontSize,
  terminalGroupTitle,
  terminalStrips,
  unverifiedTerminalParts,
  type TerminalGroup,
  type TerminalStripSet,
} from "../utils/schaltplanTerminals";
import { buildTopology, validateDocument } from "../utils/schaltplanTopology";
import type { DeviceKind, PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

type RowSpec = { id: string; label: string; devices: PanelDevice[] };

function board(rows: RowSpec[], labels?: Record<string, string>): PanelDocument {
  return {
    ...emptyDocument(),
    rows: rows.map((row): PanelRow => ({ ...row, slots: 12 })),
    ...(labels ? { terminal_labels: labels } : {}),
  };
}

/** A device that ends on a Reihenklemme. */
function tb(kind: DeviceKind, overrides: Partial<PanelDevice> = {}): PanelDevice {
  return makeDevice(kind, { terminal_block: true, ...overrides });
}

/** FI F1: three small outgoings (one of them three-phase), one Wallbox above 16 A, one breaker without a terminal. */
function standardBoard(labels?: Record<string, string>): PanelDocument {
  return board(
    [
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("mcb", { id: "f11", designation: "F1.1", circuit: "1", rating: "B16" }),
          tb("mcb", { id: "f12", designation: "F1.2", circuit: "2", rating: "B16" }),
          tb("mcb", { id: "f13", designation: "F1.3", circuit: "3", rating: "B16", poles: 3 }),
          tb("wallbox", { id: "w1", designation: "F1.4", circuit: "4", label: "Wallbox Garage", rating: "B32" }),
          makeDevice("mcb", { id: "f15", designation: "F1.5", circuit: "5" }),
        ],
      },
    ],
    labels,
  );
}

function blockOnlyBoard(): PanelDocument {
  return board([
    {
      id: "r1",
      label: "Reihe 1",
      devices: [
        makeDevice("rcd", { id: "f2", designation: "F2" }),
        tb("wallbox", { id: "w2", designation: "F2.1", circuit: "9", label: "Wechselrichter PV", rating: "C32" }),
      ],
    },
  ]);
}

function twoRcdBoard(): PanelDocument {
  return board([
    {
      id: "r1",
      label: "Reihe 1",
      devices: [
        makeDevice("rcd", { id: "f1", designation: "F1" }),
        tb("mcb", { id: "a", designation: "F1.1", circuit: "1", rating: "B16" }),
        makeDevice("rcd", { id: "f2", designation: "F2" }),
        tb("mcb", { id: "b", designation: "F2.1", circuit: "2", rating: "B16" }),
      ],
    },
  ]);
}

const partIds = (groups: readonly TerminalGroup[], index = 0) => groups[index].terminals.map((entry) => entry.partId);
const labelsOf = (groups: readonly TerminalGroup[], index = 0) => groups[index].terminals.map((entry) => entry.label);
const stripIds = (set: TerminalStripSet) => set.strips.map((strip) => strip.stripId);

describe("the rules", () => {
  it("terminal_block defaults to off — opt-in per device", () => {
    expect(makeDevice("mcb").terminal_block).toBe(false);
  });

  it("only MCB-protected outgoing kinds are eligible; an RCBO keeps its own N", () => {
    for (const kind of ["mcb", "wallbox", "sub_feed", "pv"] as DeviceKind[]) {
      expect(isTerminalEligible(makeDevice(kind))).toBe(true);
    }
    for (const kind of ["rcbo", "fuse", "contactor", "rcd", "spd", "blank", "terminal"] as DeviceKind[]) {
      expect(isTerminalEligible(makeDevice(kind))).toBe(false);
    }
  });

  it("gives one phase one Etagenklemme and three phases two — N/L/PE then L/L", () => {
    expect(outgoingPartsForPoles(1)).toEqual(["2003-7641"]);
    expect(outgoingPartsForPoles(2)).toEqual(["2003-7641"]);
    expect(outgoingPartsForPoles(3)).toEqual(["2003-7641", "2003-7642"]);
    expect(outgoingPartsForPoles(4)).toEqual(["2003-7641", "2003-7642"]);
  });

  it("reads the amps out of a rating as the office writes it", () => {
    expect(ratingAmps("B16")).toBe(16);
    expect(ratingAmps("C 32A")).toBe(32);
    expect(ratingAmps("16 A")).toBe(16);
    expect(ratingAmps("63")).toBe(63);
    expect(ratingAmps("0,5 A")).toBe(0.5);
    expect(ratingAmps("")).toBeNull();
    expect(ratingAmps("gG")).toBeNull();
    expect(ratingAmps(undefined)).toBeNull();
  });

  it("makes a Block of three phases above 16 A, and of nothing else", () => {
    expect(BLOCK_MIN_AMPS_EXCLUSIVE).toBe(16);
    expect(isBlockDevice({ poles: 3, rating: "B32" })).toBe(true);
    expect(isBlockDevice({ poles: 4, rating: "C 20 A" })).toBe(true);
    // Exactly 16 A stays on the Etagenklemmen: the rule is "more than".
    expect(isBlockDevice({ poles: 3, rating: "B16" })).toBe(false);
    expect(isBlockDevice({ poles: 1, rating: "B32" })).toBe(false);
    expect(isBlockDevice({ poles: 2, rating: "B32" })).toBe(false);
    // No number in the rating = not big, whatever the poles.
    expect(isBlockDevice({ poles: 3, rating: "" })).toBe(false);
  });

  it("knows only two variants now: an FI, or no FI", () => {
    const [group] = buildTopology(blockOnlyBoard());
    expect(terminalVariant(group, group.children)).toBe("standard");
    expect(terminalVariant(group, [])).toBeNull();
  });

  it("builds an override key from device id and slot", () => {
    expect(overrideKey("f1", "feed")).toBe("f1:feed");
    expect(overrideKey("w1", "L2")).toBe("w1:L2");
    expect(overrideKey("w1", "name")).toBe("w1:name");
    expect(overrideKey(null, "x")).toBe(":x");
  });
});

describe("the part table", () => {
  it("carries the looked-up widths: 5.2 mm Etagenklemmen, 12 mm 16 mm² terminals, 7.5 mm end clamp", () => {
    expect(TERMINAL_PARTS["2003-7641"].widthMm).toBe(5.2);
    expect(TERMINAL_PARTS["2003-7642"].widthMm).toBe(5.2);
    expect(TERMINAL_PARTS["2016-7714"].widthMm).toBe(12);
    expect(TERMINAL_PARTS["2016-7604"].widthMm).toBe(12);
    expect(TERMINAL_PARTS["2016-7601"].widthMm).toBe(12);
    expect(TERMINAL_PARTS["2016-7607"].widthMm).toBe(12);
    expect(TERMINAL_PARTS["2009-305"].widthMm).toBe(7.5);
  });

  it("marks the end clamp as marker-less, the PE terminal as marked, and every part as verified", () => {
    expect(TERMINAL_PARTS["2009-305"].marker).toBe(false);
    expect(TERMINAL_PARTS["2016-7607"].marker).toBe(true);
    const verified = Object.values(TERMINAL_PARTS).filter((part) => part.verified).map((part) => part.id);
    expect(verified.sort()).toEqual(
      ["2003-7641", "2003-7642", "2009-305", "2016-7601", "2016-7604", "2016-7607", "2016-7714"].sort(),
    );
    for (const part of Object.values(TERMINAL_PARTS)) {
      expect(part.source).toMatch(/^https:\/\//);
    }
  });
});

describe("deriveTerminals — the Leiste of an FI group", () => {
  it("feed terminal, the Etagenklemmen of the small outgoings, end clamp — then a Block per big outgoing", () => {
    const groups = deriveTerminals(standardBoard());
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group).toMatchObject({ groupId: "f1", variant: "standard", railLabel: "Reihe 1" });
    expect(group.headDevice?.designation).toBe("F1");
    expect(group.strips.map((strip) => [strip.stripId, strip.kind, strip.stripNo])).toEqual([
      ["f1:leiste", "leiste", 1],
      ["w1:block", "block", 2],
    ]);
    expect(group.strips[0].terminals.map((entry) => entry.partId)).toEqual([
      "2016-7714",
      "2003-7641",
      "2003-7641",
      "2003-7641",
      "2003-7642",
      "2009-305",
    ]);
    expect(group.strips[0].terminals.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5, 6]);
    // The group's flat list is every strip's terminals in order.
    expect(partIds(groups)).toEqual([...group.strips[0].terminals, ...group.strips[1].terminals].map((t) => t.partId));
  });

  it("marks the feed X1 and counts the Etagenklemmen 1.1, 1.2 … through the whole Leiste", () => {
    const [group] = deriveTerminals(standardBoard());
    const leiste = group.strips[0];
    expect(leiste.title).toBe("X1 · FI F1 · Reihe 1");
    expect(leiste.xLabel).toBe("X1");
    expect(leiste.terminals.map((entry) => entry.label)).toEqual(["X1", "1.1", "1.2", "1.3", "1.4", ""]);
    const [feed, first, , third, fourth, end] = leiste.terminals;
    expect(feed).toMatchObject({ deviceId: "f1", slot: "feed", key: "f1:feed", defaultLabel: "X1", widthMm: 12 });
    expect(first).toMatchObject({ deviceId: "f11", slot: "1", key: "f11:1", defaultLabel: "1.1", widthMm: 5.2 });
    // The three-phase breaker owns two consecutive markers.
    expect(third).toMatchObject({ deviceId: "f13", partId: "2003-7641", slot: "1", key: "f13:1", label: "1.3" });
    expect(fourth).toMatchObject({ deviceId: "f13", partId: "2003-7642", slot: "2", key: "f13:2", label: "1.4" });
    expect(end).toMatchObject({ deviceId: null, slot: null, key: "", defaultLabel: "", label: "", marker: false });
  });

  it("emits nothing for a group without terminal_block devices", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [makeDevice("rcd", { id: "f1", designation: "F1" }), makeDevice("mcb", { id: "a", designation: "F1.1" })],
      },
    ]);
    expect(deriveTerminals(document)).toEqual([]);
  });

  it("numbers the X across groups: the second FI's Leiste is X2 with markers 2.1 …", () => {
    const groups = deriveTerminals(twoRcdBoard());
    expect(groups.map((group) => group.groupId)).toEqual(["f1", "f2"]);
    expect(groups.map((group) => group.strips[0].title)).toEqual(["X1 · FI F1 · Reihe 1", "X2 · FI F2 · Reihe 1"]);
    expect(labelsOf(groups, 0)).toEqual(["X1", "1.1", ""]);
    expect(labelsOf(groups, 1)).toEqual(["X2", "2.1", ""]);
    expect(partIds(groups, 0)).toEqual(["2016-7714", "2003-7641", "2009-305"]);
    expect(partIds(groups, 1)).toEqual(["2016-7714", "2003-7641", "2009-305"]);
  });
});

describe("deriveTerminals — the 16 mm² Block", () => {
  it("gives a three-phase outgoing above 16 A its own Block: N, L1, L2, L3, PE at 12 mm each", () => {
    const groups = deriveTerminals(blockOnlyBoard());
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.variant).toBe("standard");
    // No small outgoing: no Leiste, the Block is X1.
    expect(group.strips).toHaveLength(1);
    const [block] = group.strips;
    expect(block).toMatchObject({
      stripId: "w2:block",
      stripNo: 1,
      kind: "block",
      title: "X1 · Block F2.1 Wechselrichter PV",
      deviceId: "w2",
      name: "Wechselrichter PV",
      xLabel: "X1",
      nameKey: "w2:name",
      xKey: "w2:x",
    });
    expect(block.terminals.map((entry) => entry.partId)).toEqual([
      "2016-7604",
      "2016-7601",
      "2016-7601",
      "2016-7601",
      "2016-7607",
    ]);
    expect(block.terminals.map((entry) => entry.pole)).toEqual(["N", "L1", "L2", "L3", "PE"]);
    expect(block.terminals.map((entry) => entry.label)).toEqual(["N", "L1", "L2", "L3", "PE"]);
    expect(block.terminals.map((entry) => entry.key)).toEqual(["w2:N", "w2:L1", "w2:L2", "w2:L3", "w2:PE"]);
    expect(block.terminals.every((entry) => entry.deviceId === "w2" && entry.widthMm === 12)).toBe(true);
  });

  it("names the Block after the device's description, else its designation", () => {
    const named = deriveTerminals(blockOnlyBoard())[0].strips[0];
    expect(named.name).toBe("Wechselrichter PV");
    const unnamed = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [makeDevice("rcd", { id: "f2", designation: "F2" }), tb("wallbox", { id: "w2", designation: "F2.1", rating: "C32" })],
      },
    ]);
    expect(deriveTerminals(unnamed)[0].strips[0]).toMatchObject({ name: "F2.1", title: "X1 · Block F2.1" });
  });

  it("is decided per device by rating, not by the FI having one outgoing", () => {
    // One three-phase outgoing at 16 A used to be the old "single3p" case;
    // now it stays on the Etagenklemmen like any other small outgoing.
    const sixteen = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [makeDevice("rcd", { id: "f1", designation: "F1" }), tb("wallbox", { id: "w", designation: "F1.1", rating: "B16" })],
      },
    ]);
    const [group] = deriveTerminals(sixteen);
    expect(group.strips.map((strip) => strip.kind)).toEqual(["leiste"]);
    expect(partIds([group])).toEqual(["2016-7714", "2003-7641", "2003-7642", "2009-305"]);
    expect(labelsOf([group])).toEqual(["X1", "1.1", "1.2", ""]);
  });

  it("puts a 4-pole Block's N on the feed terminal and reports nothing", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f3", designation: "F3" }),
          tb("sub_feed", { id: "u1", designation: "F3.1", circuit: "12", poles: 4, rating: "B40" }),
        ],
      },
    ]);
    const groups = deriveTerminals(document);
    expect(partIds(groups)).toEqual(["2016-7604", "2016-7601", "2016-7601", "2016-7601", "2016-7607"]);
    expect(terminalFindings(buildTopology(document))).toEqual([]);
  });

  it("emits the Leiste first, then the Blocks, even when the big outgoing sits first on the rail", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("wallbox", { id: "w", designation: "F1.1", circuit: "1", rating: "B32" }),
          tb("mcb", { id: "a", designation: "F1.2", circuit: "2", rating: "B16" }),
        ],
      },
    ]);
    const [group] = deriveTerminals(document);
    expect(group.strips.map((strip) => [strip.stripId, strip.xLabel])).toEqual([
      ["f1:leiste", "X1"],
      ["w:block", "X2"],
    ]);
  });

  it("goes under a group without an FI too — no feed terminal on the Leiste, the Block unchanged", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("hauptschalter", { id: "q1", designation: "Q1" }),
          tb("mcb", { id: "a", designation: "F0.1", circuit: "1", rating: "B16" }),
          tb("wallbox", { id: "w", designation: "F0.2", circuit: "2", rating: "B32" }),
        ],
      },
    ]);
    const [group] = deriveTerminals(document);
    expect(group.variant).toBe("no_rcd");
    expect(group.strips[0].terminals.map((entry) => [entry.partId, entry.label])).toEqual([["2003-7641", "1.1"]]);
    expect(group.strips[1].terminals.map((entry) => entry.label)).toEqual(["N", "L1", "L2", "L3", "PE"]);
  });
});

describe("deriveTerminals — group boundaries", () => {
  it("follows the FI's group across rails: one end clamp, in physical order", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("mcb", { id: "a", designation: "F1.1", circuit: "1" }),
          tb("mcb", { id: "b", designation: "F1.2", circuit: "2" }),
        ],
      },
      {
        id: "r2",
        label: "Reihe 2",
        devices: [tb("mcb", { id: "c", designation: "F1.3", circuit: "3" }), tb("mcb", { id: "d", designation: "F1.4", circuit: "4" })],
      },
    ]);
    const groups = deriveTerminals(document);
    expect(groups).toHaveLength(1);
    expect(groups[0].railLabel).toBe("Reihe 1");
    expect(groups[0].terminals.map((entry) => entry.deviceId)).toEqual(["f1", "a", "b", "c", "d", null]);
    expect(labelsOf(groups)).toEqual(["X1", "1.1", "1.2", "1.3", "1.4", ""]);
    expect(partIds(groups).filter((id) => id === "2009-305")).toHaveLength(1);
  });

  it("prints only the per-MCB terminals under a Hauptschalter and reports the missing FI", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("hauptschalter", { id: "q1", designation: "Q1" }),
          tb("mcb", { id: "a", designation: "F0.1", circuit: "1" }),
          tb("mcb", { id: "b", designation: "F0.2", circuit: "2" }),
        ],
      },
    ]);
    const groups = deriveTerminals(document);
    expect(groups[0].variant).toBe("no_rcd");
    expect(groups[0].strips[0].title).toBe("X1 · HS Q1 · Reihe 1");
    expect(partIds(groups)).toEqual(["2003-7641", "2003-7641"]);
    expect(labelsOf(groups)).toEqual(["1.1", "1.2"]);
    expect(validateDocument(document)).toContainEqual({
      level: "info",
      scope: "q1",
      message: "Gruppe Q1: Abgänge mit Reihenklemme ohne FI — Einspeiseklemme nicht abgeleitet",
    });
  });

  it("puts a terminal placed before any head into the supply group", () => {
    const document = board([
      { id: "r1", label: "Reihe 1", devices: [tb("mcb", { id: "a", designation: "F0.1", circuit: "1" })] },
    ]);
    const groups = deriveTerminals(document);
    expect(groups[0]).toMatchObject({ groupId: "supply", headDevice: null, railLabel: "—", variant: "no_rcd" });
    expect(groups[0].strips[0]).toMatchObject({ stripId: "supply:leiste", title: "X1 · Einspeisung" });
    expect(terminalGroupTitle(groups[0])).toBe("Einspeisung");
    expect(validateDocument(document)).toContainEqual({
      level: "info",
      scope: "",
      message: "Gruppe Einspeisung: Abgänge mit Reihenklemme ohne FI — Einspeiseklemme nicht abgeleitet",
    });
  });

  it("ignores an RCBO and a fuse even when they carry the flag", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("rcbo", { id: "x", designation: "F1.1", circuit: "1" }),
          tb("fuse", { id: "s", designation: "F9" }),
        ],
      },
    ]);
    expect(deriveTerminals(document)).toEqual([]);
    expect(terminalFindings(buildTopology(document))).toEqual([]);
  });
});

describe("deriveTerminals — pole rounding", () => {
  it("treats a 2-pole breaker as 1-pole and says so", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("mcb", { id: "a", designation: "F1.1", circuit: "1", poles: 2 }),
          tb("mcb", { id: "b", designation: "F1.2", circuit: "2" }),
        ],
      },
    ]);
    expect(partIds(deriveTerminals(document))).toEqual(["2016-7714", "2003-7641", "2003-7641", "2009-305"]);
    expect(validateDocument(document)).toContainEqual({
      level: "info",
      scope: "a",
      message: "F1.1: 2-polig — Klemme wie 1-polig abgeleitet",
    });
  });

  it("treats a small 4-pole outgoing as 3-pole — two Etagenklemmen — and says so", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("mcb", { id: "a", designation: "F1.1", circuit: "1" }),
          tb("sub_feed", { id: "u", designation: "F1.2", circuit: "2", poles: 4, rating: "B16" }),
        ],
      },
    ]);
    expect(partIds(deriveTerminals(document))).toEqual(["2016-7714", "2003-7641", "2003-7641", "2003-7642", "2009-305"]);
    expect(validateDocument(document)).toContainEqual({
      level: "info",
      scope: "u",
      message: "F1.2: 4-polig — Klemme wie 3-polig abgeleitet",
    });
  });
});

describe("overrides from document.terminal_labels", () => {
  const labels = { "f11:1": "1.9", "f1:feed": "XA", "w1:name": "Wallbox", "w1:x": "X9", "f12:1": "" };

  it("replaces the marker text, keeps the default, and prints nothing for a blank one", () => {
    const [group] = deriveTerminals(standardBoard(labels));
    const leiste = group.strips[0];
    expect(leiste.terminals.map((entry) => [entry.defaultLabel, entry.label])).toEqual([
      ["X1", "XA"],
      ["1.1", "1.9"],
      ["1.2", ""],
      ["1.3", "1.3"],
      ["1.4", "1.4"],
      ["", ""],
    ]);
    // The strip's own X number and title never follow an override — the
    // feed marker did, the board order did not.
    expect(leiste.xLabel).toBe("X1");
    expect(leiste.title).toBe("X1 · FI F1 · Reihe 1");
    const block = group.strips[1];
    expect(block).toMatchObject({ name: "Wallbox", xLabel: "X9", title: "X2 · Block F1.4 Wallbox Garage" });
  });

  it("trims an override the way the printer trims a BMK", () => {
    const [group] = deriveTerminals(standardBoard({ "f11:1": "  7 \u0000", "w1:N": "﻿N1\t" }));
    expect(group.strips[0].terminals[1].label).toBe("7");
    expect(group.strips[1].terminals[0].label).toBe("N1");
  });

  it("reads only a string map; a null value and a non-object are ignored", () => {
    expect(labelOverrides({ terminal_labels: undefined })).toEqual({});
    expect(labelOverrides({ terminal_labels: ["x"] as unknown as Record<string, string> })).toEqual({});
    expect(labelOverrides({ terminal_labels: { a: "1", b: null } as unknown as Record<string, string> })).toEqual({
      a: "1",
    });
  });

  it("setTerminalLabel writes, blanks and removes one key without touching the input", () => {
    const original = standardBoard();
    const written = setTerminalLabel(original, "f11:1", "1.9");
    expect(written.terminal_labels).toEqual({ "f11:1": "1.9" });
    expect(original.terminal_labels).toBeUndefined();
    expect(written.rows).toBe(original.rows);
    const blanked = setTerminalLabel(written, "f12:1", "");
    expect(blanked.terminal_labels).toEqual({ "f11:1": "1.9", "f12:1": "" });
    expect(written.terminal_labels).toEqual({ "f11:1": "1.9" });
    const removed = setTerminalLabel(blanked, "f11:1", null);
    expect(removed.terminal_labels).toEqual({ "f12:1": "" });
    // The last override gone, the key leaves the document too.
    expect(setTerminalLabel(removed, "f12:1", null)).not.toHaveProperty("terminal_labels");
  });
});

describe("terminalBom / terminalCounts", () => {
  it("sums parts over the board, sorted by part number", () => {
    const bom = terminalBom(deriveTerminals(standardBoard()));
    expect(bom.map((row) => [row.partId, row.count])).toEqual([
      ["2003-7641", 3],
      ["2003-7642", 1],
      ["2009-305", 1],
      ["2016-7601", 3],
      ["2016-7604", 1],
      ["2016-7607", 1],
      ["2016-7714", 1],
    ]);
    expect(bom[0]).toMatchObject({ partNo: "WAGO 2003-7641", widthMm: 5.2, verified: true });
    expect(bom.every((row) => row.name.length > 0)).toBe(true);
  });

  it("sums across groups", () => {
    const bom = terminalBom(deriveTerminals(twoRcdBoard()));
    expect(bom.map((row) => [row.partId, row.count])).toEqual([
      ["2003-7641", 2],
      ["2009-305", 2],
      ["2016-7714", 2],
    ]);
  });

  it("counts terminals, strips, groups and devices for the tab badge", () => {
    expect(terminalCounts(deriveTerminals(standardBoard()))).toEqual({ terminals: 11, strips: 2, groups: 1, devices: 4 });
    expect(terminalCounts(deriveTerminals(twoRcdBoard()))).toEqual({ terminals: 6, strips: 2, groups: 2, devices: 2 });
    expect(terminalCounts(deriveTerminals(blockOnlyBoard()))).toEqual({ terminals: 5, strips: 1, groups: 1, devices: 1 });
    expect(terminalCounts([])).toEqual({ terminals: 0, strips: 0, groups: 0, devices: 0 });
  });

  it("lists the parts in use whose width could not be verified", () => {
    expect(unverifiedTerminalParts(deriveTerminals(standardBoard()))).toEqual([]);
    // Every part in the table is verified since the PE terminal was confirmed
    // as 2016-7607; the function stays for the next part that is not.
    expect(unverifiedTerminalParts(deriveTerminals(blockOnlyBoard()))).toEqual([]);
  });
});

describe("deviceTerminalLabels — the legend's Klemmen column", () => {
  it("lists X<n>.<k> per Etagenklemme and the Block's X once", () => {
    expect(deviceTerminalLabels(deriveTerminals(standardBoard()))).toEqual({
      f11: ["X1.1"],
      f12: ["X1.2"],
      f13: ["X1.3", "X1.4"],
      w1: ["X2"],
    });
  });

  it("follows the overrides and drops a blanked marker", () => {
    const labels = { "f11:1": "1.9", "w1:x": "X9", "f12:1": "" };
    expect(deviceTerminalLabels(deriveTerminals(standardBoard(labels)))).toEqual({
      f11: ["X1.9"],
      f13: ["X1.3", "X1.4"],
      w1: ["X9"],
    });
  });
});

describe("terminalStrips", () => {
  it("one item per strip: the Leiste's marked segments at the parts' widths, the Block's five cells", () => {
    const selection = terminalStrips(deriveTerminals(standardBoard()));
    expect(selection.skipped).toBe(0);
    expect(selection.strips).toHaveLength(2);
    const [leiste, block] = selection.strips;
    expect(leiste).toMatchObject({ kind: "leiste", stripId: "f1:leiste", label: "X1 · FI F1 · Reihe 1", xLabel: "X1" });
    expect(leiste.segments.map((segment) => segment.text)).toEqual(["X1", "1.1", "1.2", "1.3", "1.4"]);
    expect(leiste.segments.map((segment) => segment.widthMm)).toEqual([12, 5.2, 5.2, 5.2, 5.2]);
    expect(leiste).toMatchObject({ cells: [], lengthMm: 32.8, partCount: 6, skipped: 0 });
    expect(block).toMatchObject({
      kind: "block",
      stripId: "w1:block",
      label: "X2 · Block F1.4 Wallbox Garage",
      name: "Wallbox Garage",
      xLabel: "X2",
      segments: [],
      skipped: 0,
      partCount: 5,
      lengthMm: 60,
    });
    expect(block.cells).toEqual([
      { text: "N", widthMm: 12 },
      { text: "L1", widthMm: 12 },
      { text: "L2", widthMm: 12 },
      { text: "L3", widthMm: 12 },
      { text: "PE", widthMm: 12 },
    ]);
  });

  it("skips a blanked marker on the Leiste and counts it; a blanked Block cell stays a cell", () => {
    const groups = deriveTerminals(standardBoard({ "f12:1": "", "w1:L2": "" }));
    const selection = terminalStrips(groups);
    expect(selection.strips[0].segments.map((segment) => segment.text)).toEqual(["X1", "1.1", "1.3", "1.4"]);
    expect(selection.strips[0]).toMatchObject({ skipped: 1, lengthMm: 27.6 });
    expect(selection.strips[1].cells.map((cell) => cell.text)).toEqual(["N", "L1", "", "L3", "PE"]);
    expect(selection.strips[1]).toMatchObject({ skipped: 0, lengthMm: 60 });
    expect(selection.skipped).toBe(1);
  });

  it("limits to the requested strips: absent = every strip, an empty array = none", () => {
    const groups = deriveTerminals(standardBoard());
    expect(stripIds(terminalStrips(groups, ["w1:block"]))).toEqual(["w1:block"]);
    expect(stripIds(terminalStrips(groups))).toEqual(["f1:leiste", "w1:block"]);
    expect(stripIds(terminalStrips(groups, undefined))).toEqual(["f1:leiste", "w1:block"]);
    // An explicit empty selection is nothing, not everything: unticking every
    // strip in the sheet must not print the board.
    expect(terminalStrips(groups, [])).toEqual({ strips: [], skipped: 0 });
  });

  it("drops a Leiste with no text but keeps counting its terminals", () => {
    const groups = deriveTerminals(twoRcdBoard());
    const blanked = deriveTerminals({
      ...twoRcdBoard(),
      terminal_labels: { "f2:feed": "", "b:1": "" },
    });
    expect(stripIds(terminalStrips(groups))).toEqual(["f1:leiste", "f2:leiste"]);
    const selection = terminalStrips(blanked);
    expect(stripIds(selection)).toEqual(["f1:leiste"]);
    // F2's feed and Etagenklemme print nothing — skipped, not forgotten.
    expect(selection.skipped).toBe(2);
    expect(selection.strips[0].skipped).toBe(0);
    expect(terminalStrips(blanked, ["f2:leiste"])).toEqual({ strips: [], skipped: 2 });
  });
});

describe("terminalFontSize", () => {
  it("uses the 0.5 mm terminal pad: '1.1' on 5.2 mm fits at 36 dots", () => {
    expect(TERMINAL_SEG_PAD_DOTS).toBe(6);
    expect(fontSizeForSegments([{ text: "1.1", widthMm: 5.2 }], 11, TERMINAL_SEG_PAD_DOTS)).toEqual({
      sizeDots: 36,
      overflowing: [],
    });
    // The BMK pad would leave the same text 27 dots — the two are not interchangeable.
    expect(fontSizeForSegments([{ text: "1.1", widthMm: 5.2 }], 11, 12).sizeDots).toBe(27);
    expect(terminalFontSize(deriveTerminals(standardBoard()), 11)).toEqual({ sizeDots: 36, overflowing: [] });
  });

  it("is one size over every Leiste of the board; Blocks size themselves", () => {
    expect(terminalFontSize(deriveTerminals(twoRcdBoard()), 11)).toEqual({ sizeDots: 36, overflowing: [] });
    // A board of only a Block has no Leiste segment: the strip's maximum.
    expect(terminalFontSize(deriveTerminals(blockOnlyBoard()), 11)).toEqual({ sizeDots: 95, overflowing: [] });
  });

  it("reports an override that cannot fit 5.2 mm even at the 2 mm floor", () => {
    const groups = deriveTerminals(standardBoard({ "f11:1": "F1.12" }));
    expect(terminalFontSize(groups, 11)).toEqual({ sizeDots: 24, overflowing: ["F1.12"] });
  });

  it("gives the maximum when nothing carries a text", () => {
    expect(terminalFontSize([], 11)).toEqual({ sizeDots: 95, overflowing: [] });
  });
});
