/**
 * The editor's topology twin must survive a parent placed after its child.
 *
 * Field crash: an RCBO was pointed at a single-pole Hauptschalter one slot to
 * its right. `buildTopology` indexed a group only on reaching it, then did
 * `groups[indexByGroupId.get(explicit)!]` — the `!` turned a missing index
 * into `undefined.children` and a TypeError inside render. The error boundary
 * took the whole page down, and the same document 500'd on the server.
 *
 * Placement order is physical; `parent_id` is electrical. They may disagree.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import {
  buildLegend,
  buildTopology,
  documentStats,
  feederFuseIds,
  neighbourDeviceId,
  opensGroup,
  validateDocument,
} from "../utils/schaltplanTopology";
import type { PanelDocument } from "../types/schaltplan";

function documentWithParentAfterChild(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [
          makeDevice("rcbo", { id: "c1", circuit: "1", label: "EMA", parent_id: "hs" }),
          makeDevice("hauptschalter", { id: "hs" }),
          makeDevice("mcb", { id: "c2", circuit: "2", label: "Licht" }),
        ],
      },
    ],
  };
}

describe("schaltplan topology — explicit parent placed after its child", () => {
  it("resolves the parent instead of throwing", () => {
    const groups = buildTopology(documentWithParentAfterChild());
    const hs = groups.find((g) => g.device?.id === "hs");
    expect(hs).toBeDefined();
    expect(hs!.children.map((d) => d.id)).toEqual(["c1", "c2"]);
    // Nothing fell back to "direkt von der Einspeisung".
    expect(groups.some((g) => g.device === null)).toBe(false);
  });

  it("builds the legend and validation the page renders from", () => {
    const document = documentWithParentAfterChild();
    expect(() => buildLegend(document)).not.toThrow();
    expect(buildLegend(document).map((r) => r.circuit)).toEqual(["1", "2"]);
    expect(() => validateDocument(document)).not.toThrow();
  });

  it("the legend names the Reihenklemmen a circuit ends on, and nothing without one", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("rcd", { id: "f1", designation: "F1" }),
            makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1", rating: "B16", terminal_block: true }),
            makeDevice("mcb", { id: "c2", designation: "F1.2", circuit: "2", rating: "B16", poles: 3, terminal_block: true }),
            makeDevice("wallbox", { id: "w", designation: "F1.3", circuit: "3", rating: "B32", terminal_block: true }),
            makeDevice("mcb", { id: "c4", designation: "F1.4", circuit: "4" }),
          ],
        },
      ],
      terminal_labels: { "c1:1": "7" },
    };
    const rows = buildLegend(document);
    // An override is printed as typed, so the legend says "X7", not "X1.7".
    expect(rows.map((row) => [row.circuit, row.terminals])).toEqual([
      ["1", "X7"],
      ["2", "X1.2, X1.3"],
      ["3", "X2"],
      ["4", ""],
    ]);
  });

  it("still degrades a genuinely missing parent to the supply group", () => {
    const document = documentWithParentAfterChild();
    document.rows[0].devices[0] = makeDevice("rcbo", { id: "c1", circuit: "1", parent_id: "ghost" });
    const groups = buildTopology(document);
    const supply = groups.find((g) => g.device === null);
    expect(supply?.children.map((d) => d.id)).toEqual(["c1"]);
  });
});

// ── Vorsicherung: a fuse feeding an FI ───────────────────────────────────────

function documentWithPreFuse(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [
          makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A" }),
          makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "f0" }),
          makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1" }),
          makeDevice("mcb", { id: "c2", designation: "F1.2", circuit: "2" }),
        ],
      },
    ],
  };
}

describe("schaltplan topology — Vorsicherung", () => {
  it("a group device may name a fuse; the fuse feeds it and stops being a circuit", () => {
    const groups = buildTopology(documentWithPreFuse());
    const fi = groups.find((g) => g.device?.id === "f1");
    expect(fi?.preFuse?.id).toBe("f0");
    expect(fi?.children.map((d) => d.id)).toEqual(["c1", "c2"]);
    expect(groups.flatMap((g) => g.children).some((d) => d.id === "f0")).toBe(false);
  });

  it("the legend shows the Vorsicherung on every circuit under that FI", () => {
    const rows = buildLegend(documentWithPreFuse());
    expect(rows.map((r) => r.circuit)).toEqual(["1", "2"]);
    expect(new Set(rows.map((r) => r.pre_fuse))).toEqual(new Set(["F0 35 A"]));
  });

  it("a fuse nobody points at stays a circuit", () => {
    // Placed AFTER the FI on the rail, so physical-order parenting puts it
    // under that FI; a fuse before any FI would sit on the supply group,
    // which is also correct and is not what this test is about.
    const document = documentWithPreFuse();
    document.rows[0].devices = [
      makeDevice("rcd", { id: "f1", designation: "F1" }),
      makeDevice("fuse", { id: "f0", designation: "F0", circuit: "9", rating: "16 A" }),
      makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1" }),
    ];
    const fi = buildTopology(document).find((g) => g.device?.id === "f1");
    expect(fi?.preFuse).toBeNull();
    expect(fi?.children.map((d) => d.id)).toEqual(["f0", "c1"]);
    expect(buildLegend(document)[0].pre_fuse).toBe("—");
  });

  it("a missing Vorsicherung degrades and is reported", () => {
    const document = documentWithPreFuse();
    document.rows[0].devices[1] = makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "ghost" });
    const fi = buildTopology(document).find((g) => g.device?.id === "f1");
    expect(fi?.preFuse).toBeNull();
    const messages = validateDocument(document).map((f) => f.message);
    expect(messages.some((m) => m.includes("Vorsicherung") && m.includes("F1"))).toBe(true);
  });
});

// ── Sicherung speist Abgänge: Neozed → RCBO / LS ohne FI ─────────────────────
//
// A Neozed block may feed an RCBO (which brings its own residual-current
// protection) or a row of MCBs that need no FI at all. Two ways to say so:
// point the circuit at the fuse (`parent_id`), or flag the fuse itself
// (`feeds_following`) so it captures the rail after it like an FI would.

function boardWithFuseFeedingRcbo(): PanelDocument {
  return {
    ...emptyDocument(),
    rows: [
      {
        id: "r1",
        label: "Reihe 1",
        slots: 12,
        devices: [
          makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A" }),
          makeDevice("rcbo", {
            id: "c1",
            designation: "F0.1",
            circuit: "1",
            parent_id: "f0",
            residual_current: "30 mA",
            rcd_type: "A",
          }),
          makeDevice("rcd", { id: "f1", designation: "F1" }),
          makeDevice("mcb", { id: "c2", designation: "F1.1", circuit: "2" }),
        ],
      },
    ],
  };
}

describe("schaltplan topology — Sicherung speist Abgänge", () => {
  it("an RCBO may name a Neozed; the fuse then heads its own group", () => {
    const document = boardWithFuseFeedingRcbo();
    expect(feederFuseIds(document)).toEqual(new Set(["f0"]));
    expect(opensGroup(document.rows[0].devices[0], document)).toBe(true);

    const groups = buildTopology(document);
    const fuseGroup = groups.find((g) => g.device?.id === "f0");
    expect(fuseGroup).toBeDefined();
    expect(fuseGroup!.preFuse).toBeNull();
    expect(fuseGroup!.children.map((d) => d.id)).toEqual(["c1"]);
    // A group head, not a circuit column anywhere.
    expect(groups.flatMap((g) => g.children).some((d) => d.id === "f0")).toBe(false);
    // The FI after it is untouched.
    expect(groups.find((g) => g.device?.id === "f1")?.children.map((d) => d.id)).toEqual(["c2"]);
    expect(groups.some((g) => g.device === null)).toBe(false);
  });

  it("the legend lists the fuse as Vorsicherung and only the RCBO's own RCD", () => {
    const rows = buildLegend(boardWithFuseFeedingRcbo());
    const rcbo = rows.find((r) => r.circuit === "1");
    expect(rcbo?.pre_fuse).toBe("F0 35 A");
    expect(rcbo?.rcd).toBe("30 mA / Typ A");
    expect(rcbo?.group).toBe("F0 Si");
    const underFi = rows.find((r) => r.circuit === "2");
    expect(underFi?.pre_fuse).toBe("—");
  });

  it("a flagged fuse captures everything after it until the next FI", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A", feeds_following: true }),
            makeDevice("mcb", { id: "c1", designation: "F0.1", circuit: "1" }),
            makeDevice("mcb", { id: "c2", designation: "F0.2", circuit: "2" }),
            makeDevice("rcd", { id: "f1", designation: "F1" }),
            makeDevice("mcb", { id: "c3", designation: "F1.1", circuit: "3" }),
          ],
        },
      ],
    };
    expect(opensGroup(document.rows[0].devices[0], document)).toBe(true);
    const groups = buildTopology(document);
    expect(groups.find((g) => g.device?.id === "f0")?.children.map((d) => d.id)).toEqual(["c1", "c2"]);
    expect(groups.find((g) => g.device?.id === "f1")?.children.map((d) => d.id)).toEqual(["c3"]);
    expect(groups.some((g) => g.device === null)).toBe(false);

    const rows = buildLegend(document);
    expect(rows.find((r) => r.circuit === "1")?.rcd).toBe("—");
    expect(rows.find((r) => r.circuit === "1")?.pre_fuse).toBe("F0 35 A");
    expect(rows.find((r) => r.circuit === "3")?.pre_fuse).toBe("—");
    expect(rows.find((r) => r.circuit === "3")?.rcd).toBe("30 mA / Typ A");
  });

  it("an unflagged fuse nobody names captures nothing", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A", circuit: "9" }),
            makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1" }),
          ],
        },
      ],
    };
    expect(feederFuseIds(document).size).toBe(0);
    expect(opensGroup(document.rows[0].devices[0], document)).toBe(false);
    const groups = buildTopology(document);
    expect(groups.some((g) => g.device?.id === "f0")).toBe(false);
    expect(groups.find((g) => g.device === null)?.children.map((d) => d.id)).toEqual(["f0", "c1"]);
  });

  it("a fuse that is Vorsicherung of an FI and feeds an RCBO renders both ways", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A" }),
            makeDevice("rcbo", { id: "c1", designation: "F0.1", circuit: "1", parent_id: "f0" }),
            makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "f0" }),
            makeDevice("mcb", { id: "c2", designation: "F1.1", circuit: "2" }),
          ],
        },
      ],
    };
    const groups = buildTopology(document);
    const fuseGroup = groups.find((g) => g.device?.id === "f0");
    expect(fuseGroup?.children.map((d) => d.id)).toEqual(["c1"]);
    const fi = groups.find((g) => g.device?.id === "f1");
    expect(fi?.preFuse?.id).toBe("f0");
    expect(fi?.children.map((d) => d.id)).toEqual(["c2"]);
    expect(groups.flatMap((g) => g.children).some((d) => d.id === "f0")).toBe(false);

    const rows = buildLegend(document);
    expect(rows.map((r) => r.pre_fuse)).toEqual(["F0 35 A", "F0 35 A"]);
  });

  it("reports a flagged fuse that feeds nothing, and only that one", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A", feeds_following: true }),
            makeDevice("rcd", { id: "f1", designation: "F1" }),
            makeDevice("fuse", { id: "f2", designation: "F2", rating: "20 A", feeds_following: true }),
            makeDevice("mcb", { id: "c1", designation: "F2.1", circuit: "1", cable: "NYM-J 3x1,5 mm²" }),
          ],
        },
      ],
    };
    const findings = validateDocument(document);
    const idle = findings.filter((f) => f.message.includes("speist keine Abgänge"));
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({ level: "info", scope: "f0", message: "F0: Vorsicherung speist keine Abgänge" });
  });
});

describe("schaltplan topology — a fuse-headed group has no plate", () => {
  it("ignores a feeder fuse's own parent_id and reports nothing about it", () => {
    // Backend rule, mirrored: only a catalogue group reads parent_id as a
    // Vorsicherung. A flagged fuse that still names the FI it used to hang
    // off is neither that FI's child nor a group with a plate.
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("rcd", { id: "f1", designation: "F1" }),
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A", feeds_following: true, parent_id: "f1" }),
            makeDevice("mcb", { id: "c1", designation: "F0.1", circuit: "1", cable: "NYM-J 3x1,5 mm²" }),
          ],
        },
      ],
    };
    const groups = buildTopology(document);
    const fuseGroup = groups.find((g) => g.device?.id === "f0");
    expect(fuseGroup?.preFuse).toBeNull();
    expect(fuseGroup?.children.map((d) => d.id)).toEqual(["c1"]);
    expect(groups.find((g) => g.device?.id === "f1")?.children).toEqual([]);
    const messages = validateDocument(document).map((f) => f.message);
    expect(messages.some((m) => m.includes("Vorsicherung nicht gefunden"))).toBe(false);
    expect(messages.some((m) => m.includes("speist keine Abgänge"))).toBe(false);
  });
});

describe("feeder fuses — review follow-ups", () => {
  function nhNeozedFi(): PanelDocument {
    return {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("fuse", { id: "f00", designation: "F00", rating: "63 A", circuit: "9", label: "NH-Abgang" }),
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A", parent_id: "f00" }),
            makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "f0" }),
            makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1", label: "Licht" }),
          ],
        },
      ],
    };
  }

  it("a fuse naming a fuse does not conjure an empty group (NH → Neozed → FI)", () => {
    const document = nhNeozedFi();
    expect([...feederFuseIds(document)]).toEqual([]);
    const heads = buildTopology(document).map((group) => group.device?.id ?? null);
    expect(heads).not.toContain("f00");
    const fi = buildTopology(document).find((group) => group.device?.id === "f1");
    expect(fi?.preFuse?.id).toBe("f0");
    expect(buildLegend(document).map((row) => row.circuit)).toContain("9");
  });

  it("a fuse heading a group is not nagged like a load and is not a circuit", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A", feeds_following: true }),
            makeDevice("mcb", { id: "c1", designation: "F0.1", circuit: "1", cable: "NYM-J 3x1,5 mm²", label: "Heizung" }),
          ],
        },
      ],
    };
    expect(validateDocument(document).filter((finding) => finding.scope === "f0")).toEqual([]);
    expect(documentStats(document).circuitCount).toBe(1);
  });

  it("a flagged fuse fed only by remote references still gets the hint", () => {
    const document: PanelDocument = {
      ...emptyDocument(),
      rows: [
        {
          id: "r1",
          label: "Reihe 1",
          slots: 12,
          devices: [
            makeDevice("fuse", { id: "f0", designation: "F0", rating: "35 A", feeds_following: true }),
            makeDevice("rcd", { id: "f1", designation: "F1" }),
            makeDevice("mcb", { id: "c1", designation: "F1.1", circuit: "1" }),
            makeDevice("rcbo", { id: "k1", designation: "F0.1", circuit: "2", parent_id: "f0" }),
          ],
        },
      ],
    };
    expect(validateDocument(document)).toContainEqual({
      level: "info",
      scope: "f0",
      message: "F0: Vorsicherung speist keine Abgänge",
    });
  });
});

describe("neighbourDeviceId — the arrows in the device sheet", () => {
  const twoRows: PanelDocument = {
    ...emptyDocument(),
    rows: [
      { id: "r1", label: "Reihe 1", slots: 12, devices: [makeDevice("rcd", { id: "a" }), makeDevice("mcb", { id: "b" })] },
      { id: "r2", label: "Reihe 2", slots: 12, devices: [makeDevice("mcb", { id: "c" })] },
    ],
  };

  it("walks left to right and crosses the row boundary", () => {
    expect(neighbourDeviceId(twoRows, "a", 1)).toBe("b");
    expect(neighbourDeviceId(twoRows, "b", 1)).toBe("c");
    expect(neighbourDeviceId(twoRows, "c", -1)).toBe("b");
  });

  it("is null at both ends and for an unknown or missing id", () => {
    expect(neighbourDeviceId(twoRows, "a", -1)).toBeNull();
    expect(neighbourDeviceId(twoRows, "c", 1)).toBeNull();
    expect(neighbourDeviceId(twoRows, "zzz", 1)).toBeNull();
    expect(neighbourDeviceId(twoRows, null, 1)).toBeNull();
  });
});
