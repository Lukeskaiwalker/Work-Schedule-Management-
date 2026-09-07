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
