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
import { buildLegend, buildTopology, validateDocument } from "../utils/schaltplanTopology";
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
