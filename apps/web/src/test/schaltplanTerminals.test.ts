/**
 * Reihenklemmen — the WAGO terminal sequence derived per FI group.
 *
 * The rule table lives twice: here (live tab and print preview) and in
 * `apps/api/app/services/schaltplan_terminals.py` (print job and PDF).
 * Every fixture below is pinned identically in
 * `apps/api/tests/test_schaltplan_terminals.py`; when one side changes a
 * rule the other test breaks, which is the whole point of the pairing —
 * a preview that shows six terminals and a strip that prints five is a
 * board built wrong.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import { fontSizeForSegments } from "../utils/schaltplanStrip";
import {
  TERMINAL_PARTS,
  isTerminalEligible,
  outgoingPartForPoles,
  terminalFindings,
} from "../utils/schaltplanTerminalRules";
import {
  TERMINAL_SEG_PAD_DOTS,
  deriveTerminals,
  terminalBom,
  terminalCounts,
  terminalFontSize,
  terminalGroupTitle,
  terminalStrips,
  unverifiedTerminalParts,
  type TerminalStripSet,
} from "../utils/schaltplanTerminals";
import { buildTopology, validateDocument } from "../utils/schaltplanTopology";
import type { DeviceKind, PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

type RowSpec = { id: string; label: string; devices: PanelDevice[] };

function board(rows: RowSpec[]): PanelDocument {
  return {
    ...emptyDocument(),
    rows: rows.map((row): PanelRow => ({ ...row, slots: 12 })),
  };
}

/** A device that ends on a Reihenklemme. */
function tb(kind: DeviceKind, overrides: Partial<PanelDevice> = {}): PanelDevice {
  return makeDevice(kind, { terminal_block: true, ...overrides });
}

function standardBoard(): PanelDocument {
  return board([
    {
      id: "r1",
      label: "Reihe 1",
      devices: [
        makeDevice("rcd", { id: "f1", designation: "F1" }),
        tb("mcb", { id: "f11", designation: "F1.1", circuit: "1" }),
        tb("mcb", { id: "f12", designation: "F1.2", circuit: "2" }),
        tb("mcb", { id: "f13", designation: "F1.3", circuit: "3" }),
        // A wallbox is 3-pole by catalogue.
        tb("wallbox", { id: "w1", designation: "F1.4", circuit: "4" }),
        // No terminal on this one: it gets nothing.
        makeDevice("mcb", { id: "f15", designation: "F1.5", circuit: "5" }),
      ],
    },
  ]);
}

function single3pBoard(): PanelDocument {
  return board([
    {
      id: "r1",
      label: "Reihe 1",
      devices: [
        makeDevice("rcd", { id: "f2", designation: "F2" }),
        tb("wallbox", { id: "w2", designation: "F2.1", circuit: "9" }),
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
        tb("mcb", { id: "a", designation: "F1.1", circuit: "1" }),
        makeDevice("rcd", { id: "f2", designation: "F2" }),
        tb("mcb", { id: "b", designation: "F2.1", circuit: "2" }),
      ],
    },
  ]);
}

/** FI F1 with numbered outgoings, then a Hauptschalter group whose outgoings have no Stromkreis-Nr. yet. */
function noRcdWithoutNumbersBoard(): PanelDocument {
  return board([
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
      devices: [
        makeDevice("hauptschalter", { id: "q1", designation: "Q1" }),
        tb("mcb", { id: "c", designation: "F0.1", circuit: "" }),
        tb("mcb", { id: "d", designation: "F0.2", circuit: "" }),
      ],
    },
  ]);
}

const partIds = (groups: ReturnType<typeof deriveTerminals>, index = 0) =>
  groups[index].terminals.map((entry) => entry.partId);

const stripIds = (set: TerminalStripSet) => set.strips.map((strip) => strip.groupId);

describe("terminal_block on the device", () => {
  it("defaults to off — opt-in per device", () => {
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

  it("maps 1 and 2 poles to the 1-pole Etagenklemme, 3 and 4 to the L/L one", () => {
    expect(outgoingPartForPoles(1)).toBe("2003-7641");
    expect(outgoingPartForPoles(2)).toBe("2003-7641");
    expect(outgoingPartForPoles(3)).toBe("2003-7642");
    expect(outgoingPartForPoles(4)).toBe("2003-7642");
  });
});

describe("the part table", () => {
  it("carries the looked-up widths: 5.2 mm Etagenklemmen, 12 mm feed terminals, 7.5 mm end clamp", () => {
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

describe("deriveTerminals — standard FI group", () => {
  it("feed terminal, one Etagenklemme per outgoing by poles, end clamp", () => {
    const groups = deriveTerminals(standardBoard());
    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group.groupId).toBe("f1");
    expect(group.variant).toBe("standard");
    expect(group.railLabel).toBe("Reihe 1");
    expect(group.headDevice?.designation).toBe("F1");
    expect(partIds(groups)).toEqual([
      "2016-7714",
      "2003-7641",
      "2003-7641",
      "2003-7641",
      "2003-7642",
      "2009-305",
    ]);
    expect(group.terminals.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("labels the feed with the FI's BMK and the outgoings with BMK and Stromkreis-Nr.", () => {
    const [group] = deriveTerminals(standardBoard());
    const [feed, first, , , wallbox, end] = group.terminals;
    expect(feed).toMatchObject({ deviceId: "f1", labelBmk: "F1", labelCircuit: "F1", pole: null, widthMm: 12 });
    expect(first).toMatchObject({ deviceId: "f11", labelBmk: "F1.1", labelCircuit: "1", widthMm: 5.2 });
    expect(wallbox).toMatchObject({ deviceId: "w1", partId: "2003-7642", labelBmk: "F1.4", labelCircuit: "4" });
    expect(end).toMatchObject({ deviceId: null, labelBmk: "", labelCircuit: "", marker: false });
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
});

describe("deriveTerminals — single 3-pole outgoing under an FI", () => {
  it("uses the 16 mm² feed, one terminal per pole and the 2016 end element", () => {
    const groups = deriveTerminals(single3pBoard());
    expect(groups).toHaveLength(1);
    expect(groups[0].variant).toBe("single3p");
    expect(partIds(groups)).toEqual(["2016-7604", "2016-7601", "2016-7601", "2016-7601", "2016-7607"]);
    expect(groups[0].terminals.map((entry) => entry.pole)).toEqual([null, "L1", "L2", "L3", "PE"]);
    expect(groups[0].terminals[1]).toMatchObject({ deviceId: "w2", labelBmk: "L1", labelCircuit: "L1", widthMm: 12 });
  });

  it("gives a 4-pole single outgoing four pole terminals, the fourth being N", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f3", designation: "F3" }),
          tb("sub_feed", { id: "u1", designation: "F3.1", circuit: "12", poles: 4 }),
        ],
      },
    ]);
    const groups = deriveTerminals(document);
    expect(partIds(groups)).toEqual(["2016-7604", "2016-7601", "2016-7601", "2016-7601", "2016-7601", "2016-7607"]);
    expect(groups[0].terminals.map((entry) => entry.pole)).toEqual([null, "L1", "L2", "L3", "N", "PE"]);
    // The per-pole variant honours the poles, so there is nothing to report.
    expect(terminalFindings(buildTopology(document))).toEqual([]);
  });

  it("falls back to the standard variant when the single outgoing is 1-pole", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [makeDevice("rcd", { id: "f1", designation: "F1" }), tb("mcb", { id: "a", designation: "F1.1", circuit: "1" })],
      },
    ]);
    const groups = deriveTerminals(document);
    expect(groups[0].variant).toBe("standard");
    expect(partIds(groups)).toEqual(["2016-7714", "2003-7641", "2009-305"]);
  });
});

describe("deriveTerminals — group boundaries", () => {
  it("follows the FI's group across rails: one end element, in physical order", () => {
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
    expect(partIds(groups).filter((id) => id === "2009-305")).toHaveLength(1);
  });

  it("closes every FI group on its own, even two FIs on one rail", () => {
    const groups = deriveTerminals(twoRcdBoard());
    expect(groups.map((group) => group.groupId)).toEqual(["f1", "f2"]);
    expect(partIds(groups, 0)).toEqual(["2016-7714", "2003-7641", "2009-305"]);
    expect(partIds(groups, 1)).toEqual(["2016-7714", "2003-7641", "2009-305"]);
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
    expect(partIds(groups)).toEqual(["2003-7641", "2003-7641"]);
    const findings = validateDocument(document);
    expect(findings).toContainEqual({
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

  it("treats a 4-pole outgoing in a standard group as 3-pole and says so", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("mcb", { id: "a", designation: "F1.1", circuit: "1" }),
          tb("sub_feed", { id: "u", designation: "F1.2", circuit: "2", poles: 4 }),
        ],
      },
    ]);
    expect(partIds(deriveTerminals(document))).toEqual(["2016-7714", "2003-7641", "2003-7642", "2009-305"]);
    expect(validateDocument(document)).toContainEqual({
      level: "info",
      scope: "u",
      message: "F1.2: 4-polig — Klemme wie 3-polig abgeleitet",
    });
  });
});

describe("terminalBom / terminalCounts", () => {
  it("sums parts over the board, sorted by part number", () => {
    const bom = terminalBom(deriveTerminals(standardBoard()));
    expect(bom.map((row) => [row.partId, row.count])).toEqual([
      ["2003-7641", 3],
      ["2003-7642", 1],
      ["2009-305", 1],
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

  it("counts terminals, groups and devices for the tab badge", () => {
    expect(terminalCounts(deriveTerminals(standardBoard()))).toEqual({ terminals: 6, groups: 1, devices: 4 });
    expect(terminalCounts(deriveTerminals(twoRcdBoard()))).toEqual({ terminals: 6, groups: 2, devices: 2 });
    expect(terminalCounts([])).toEqual({ terminals: 0, groups: 0, devices: 0 });
  });

  it("lists the parts in use whose width could not be verified", () => {
    expect(unverifiedTerminalParts(deriveTerminals(standardBoard()))).toEqual([]);
    // Every part in the table is verified since the PE terminal was confirmed
    // as 2016-7607; the function stays for the next part that is not.
    expect(unverifiedTerminalParts(deriveTerminals(single3pBoard()))).toEqual([]);
  });
});

describe("terminalStrips", () => {
  it("one strip per group: Stromkreis-Nr. by default, at the parts' widths, no end element", () => {
    const selection = terminalStrips(deriveTerminals(standardBoard()), "circuit");
    expect(selection.skipped).toBe(0);
    const strips = selection.strips;
    expect(strips).toHaveLength(1);
    const [strip] = strips;
    expect(strip.groupId).toBe("f1");
    expect(strip.label).toBe("FI F1 · Reihe 1");
    expect(strip.segments.map((segment) => segment.text)).toEqual(["F1", "1", "2", "3", "4"]);
    expect(strip.segments.map((segment) => segment.widthMm)).toEqual([12, 5.2, 5.2, 5.2, 5.2]);
    expect(strip.lengthMm).toBeCloseTo(32.8, 6);
    expect(strip.partCount).toBe(6);
    expect(strip.skipped).toBe(0);
  });

  it("switches the outgoings to their BMK; the feed keeps the FI's BMK", () => {
    const [strip] = terminalStrips(deriveTerminals(standardBoard()), "bmk").strips;
    expect(strip.segments.map((segment) => segment.text)).toEqual(["F1", "F1.1", "F1.2", "F1.3", "F1.4"]);
  });

  it("prints pole names for the single-3-pole variant in either mode", () => {
    for (const mode of ["circuit", "bmk"] as const) {
      const [strip] = terminalStrips(deriveTerminals(single3pBoard()), mode).strips;
      // Feed + three poles + the PE terminal, 12 mm each.
      expect(strip.segments.map((segment) => segment.text)).toEqual(["F2", "L1", "L2", "L3", "PE"]);
      expect(strip.lengthMm).toBe(60);
    }
  });

  it("skips a terminal whose text is empty in the chosen mode and counts it", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("mcb", { id: "a", designation: "F1.1", circuit: "" }),
          tb("mcb", { id: "b", designation: "F1.2", circuit: "2" }),
        ],
      },
    ]);
    const circuit = terminalStrips(deriveTerminals(document), "circuit");
    expect(circuit.strips[0].segments.map((segment) => segment.text)).toEqual(["F1", "2"]);
    expect(circuit.strips[0].skipped).toBe(1);
    expect(circuit.skipped).toBe(1);
    const bmk = terminalStrips(deriveTerminals(document), "bmk");
    expect(bmk.strips[0].segments.map((segment) => segment.text)).toEqual(["F1", "F1.1", "F1.2"]);
    expect(bmk.skipped).toBe(0);
  });

  it("limits to the requested groups: absent = every group, an empty array = none", () => {
    const groups = deriveTerminals(twoRcdBoard());
    expect(stripIds(terminalStrips(groups, "circuit", ["f2"]))).toEqual(["f2"]);
    expect(stripIds(terminalStrips(groups, "circuit"))).toEqual(["f1", "f2"]);
    expect(stripIds(terminalStrips(groups, "circuit", undefined))).toEqual(["f1", "f2"]);
    // An explicit empty selection is nothing, not everything: unticking every
    // group in the sheet must not print the board.
    expect(terminalStrips(groups, "circuit", [])).toEqual({ strips: [], skipped: 0 });
  });

  it("drops a group with no text but keeps counting its terminals", () => {
    const unnamed = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [makeDevice("rcd", { id: "f1", designation: "" }), tb("mcb", { id: "a", designation: "", circuit: "" })],
      },
    ]);
    // Feed terminal and Etagenklemme both carry a marker; neither has a text.
    expect(terminalStrips(deriveTerminals(unnamed), "circuit")).toEqual({ strips: [], skipped: 2 });
  });

  it("counts the terminals of a whole group dropped for having no text", () => {
    const groups = deriveTerminals(noRcdWithoutNumbersBoard());
    expect(groups.map((group) => group.groupId)).toEqual(["f1", "q1"]);
    const circuit = terminalStrips(groups, "circuit");
    expect(stripIds(circuit)).toEqual(["f1"]);
    // Q1's two Etagenklemmen print nothing in circuit mode — skipped, not forgotten.
    expect(circuit.skipped).toBe(2);
    expect(circuit.strips[0].skipped).toBe(0);
    expect(terminalStrips(groups, "circuit", ["q1"])).toEqual({ strips: [], skipped: 2 });
    const bmk = terminalStrips(groups, "bmk");
    expect(stripIds(bmk)).toEqual(["f1", "q1"]);
    expect(bmk.skipped).toBe(0);
  });
});

describe("terminalFontSize", () => {
  it("uses the 0.5 mm terminal pad: a Stromkreis-Nr. on 5.2 mm fits at 90 dots", () => {
    expect(TERMINAL_SEG_PAD_DOTS).toBe(6);
    expect(fontSizeForSegments([{ text: "7", widthMm: 5.2 }], 11, TERMINAL_SEG_PAD_DOTS)).toEqual({
      sizeDots: 90,
      overflowing: [],
    });
    // The BMK pad would leave the same digit 69 dots — the two are not interchangeable.
    expect(fontSizeForSegments([{ text: "7", widthMm: 5.2 }], 11, 12).sizeDots).toBe(69);
    expect(terminalFontSize(deriveTerminals(standardBoard()), "circuit", 11)).toEqual({ sizeDots: 90, overflowing: [] });
  });

  it("is one size over all groups of the board, in the chosen mode", () => {
    expect(terminalFontSize(deriveTerminals(standardBoard()), "bmk", 11)).toEqual({ sizeDots: 25, overflowing: [] });
    // The 12 mm feed terminals alone would allow the strip's maximum.
    expect(terminalFontSize(deriveTerminals(single3pBoard()), "bmk", 11)).toEqual({ sizeDots: 95, overflowing: [] });
  });

  it("reports a BMK that cannot fit 5.2 mm even at the 2 mm floor", () => {
    const document = board([
      {
        id: "r1",
        label: "Reihe 1",
        devices: [
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          tb("mcb", { id: "a", designation: "F1.12", circuit: "12" }),
          tb("mcb", { id: "b", designation: "F1.3", circuit: "3" }),
        ],
      },
    ]);
    expect(terminalFontSize(deriveTerminals(document), "bmk", 11)).toEqual({ sizeDots: 24, overflowing: ["F1.12"] });
    // Two digits still fit 5.2 mm at 45 dots (3.75 mm) — the default mode is the way out.
    expect(terminalFontSize(deriveTerminals(document), "circuit", 11)).toEqual({ sizeDots: 45, overflowing: [] });
  });

  it("gives the maximum when nothing carries a text", () => {
    expect(terminalFontSize([], "circuit", 11)).toEqual({ sizeDots: 95, overflowing: [] });
  });
});
