/**
 * Feeding chains — the TypeScript twin of `tests/test_schaltplan_feeders.py`.
 *
 * Owner, 2026-10-09: an SLS must be assignable to an FI, an SLS to a
 * Hauptschalter and that Hauptschalter to an FI "to complete the row", and a
 * Hensel KKL 54 after the Hauptschalter distributes to the next devices.
 * What must hold, as on the server: the link is recorded both ways (`fedBy`,
 * `feeds`) without moving any circuit; a fuse named by a group device stays
 * its Vorsicherung; a circle is ignored and reported; a link to something
 * that cannot feed is reported; the legend's Vorsicherung follows the chain
 * to the first fuse or SLS; the Verteilerblock opens a group of its own.
 */
import { describe, expect, it } from "vitest";
import { DEVICE_CATALOG, emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import { buildLegend, buildTopology, validateDocument } from "../utils/schaltplanTopology";
import type { PanelDevice, PanelDocument, PanelGroup } from "../types/schaltplan";

function board(devices: PanelDevice[]): PanelDocument {
  return { ...emptyDocument(), rows: [{ id: "r1", label: "Reihe 1", slots: 40, devices }] };
}

function groupsById(document: PanelDocument): Record<string, PanelGroup> {
  return Object.fromEntries(
    buildTopology(document)
      .filter((group) => group.device !== null)
      .map((group) => [group.device!.id, group]),
  );
}

const ids = (devices: PanelDevice[]) => devices.map((device) => device.id);

function chainBoard(): PanelDocument {
  return board([
    makeDevice("sls", { id: "q0", designation: "Q0", rating: "E35" }),
    makeDevice("hauptschalter", { id: "q1", designation: "Q1", rating: "63 A", parent_id: "q0" }),
    makeDevice("distribution_block", { id: "x1", designation: "X1", parent_id: "q1" }),
    makeDevice("rcd", { id: "f1", designation: "F1", rating: "40 A", rcd_type: "", parent_id: "x1" }),
    makeDevice("mcb", { id: "f1.1", designation: "F1.1", circuit: "1", rating: "B16", label: "Küche", cable: "NYM-J 3x1,5 mm²" }),
    makeDevice("rcd", { id: "f2", designation: "F2", rating: "40 A", rcd_type: "", parent_id: "x1" }),
    makeDevice("mcb", { id: "f2.1", designation: "F2.1", circuit: "2", rating: "B16", label: "Bad", cable: "NYM-J 3x1,5 mm²" }),
  ]);
}

describe("feeding chains", () => {
  it("knows the Verteilerblock as a device that opens a group", () => {
    expect(DEVICE_CATALOG.distribution_block.label).toBe("Verteilerblock (Hensel KKL 54)");
    expect([DEVICE_CATALOG.distribution_block.group, DEVICE_CATALOG.distribution_block.circuit]).toEqual([true, false]);
    const groups = groupsById(board([makeDevice("distribution_block", { id: "x1" }), makeDevice("mcb", { id: "a", circuit: "1" })]));
    expect(ids(groups.x1.children)).toEqual(["a"]);
  });

  it("lets an SLS feed an FI directly, leaving the LS on the FI", () => {
    const document = board([
      makeDevice("sls", { id: "q0", designation: "Q0", rating: "E35" }),
      makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "q0" }),
      makeDevice("mcb", { id: "a", circuit: "1" }),
    ]);
    const groups = groupsById(document);
    expect(groups.f1.fedBy?.id).toBe("q0");
    expect(groups.f1.preFuse).toBeNull();
    expect(ids(groups.q0.feeds)).toEqual(["f1"]);
    expect(ids(groups.f1.children)).toEqual(["a"]);
    expect(validateDocument(document).filter((finding) => finding.scope === "f1")).toEqual([]);
  });

  it("links a whole chain SLS → Hauptschalter → Verteilerblock → two FIs", () => {
    const groups = groupsById(chainBoard());
    expect(groups.q1.fedBy?.id).toBe("q0");
    expect(groups.x1.fedBy?.id).toBe("q1");
    expect([groups.f1.fedBy?.id, groups.f2.fedBy?.id]).toEqual(["x1", "x1"]);
    expect([ids(groups.q0.feeds), ids(groups.q1.feeds), ids(groups.x1.feeds)]).toEqual([["q1"], ["x1"], ["f1", "f2"]]);
  });

  it("follows the chain to the first fuse or SLS in the legend", () => {
    const rows = Object.fromEntries(buildLegend(chainBoard()).map((row) => [row.circuit, row]));
    expect(rows["1"].pre_fuse).toBe("Q0 SLS E35");
    const behindFuse = board([
      makeDevice("fuse", { id: "n0", designation: "F0", rating: "35 A" }),
      makeDevice("hauptschalter", { id: "q1", designation: "Q1", parent_id: "n0" }),
      makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "q1" }),
      makeDevice("mcb", { id: "a", circuit: "7" }),
    ]);
    expect(buildLegend(behindFuse)[0].pre_fuse).toBe("F0 35 A");
  });

  it("keeps a fuse named by an FI as its Vorsicherung", () => {
    const groups = groupsById(
      board([
        makeDevice("fuse", { id: "n0", designation: "F0", rating: "35 A" }),
        makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "n0" }),
        makeDevice("mcb", { id: "a", circuit: "1" }),
      ]),
    );
    expect(groups.f1.preFuse?.id).toBe("n0");
    expect(groups.f1.fedBy).toBeNull();
  });

  it("ignores and reports a circle", () => {
    const document = board([
      makeDevice("sls", { id: "q0", designation: "Q0", parent_id: "q1" }),
      makeDevice("hauptschalter", { id: "q1", designation: "Q1", parent_id: "q0" }),
      makeDevice("mcb", { id: "a", circuit: "1" }),
    ]);
    const groups = groupsById(document);
    expect([groups.q0.fedBy, groups.q1.fedBy]).toEqual([null, null]);
    expect([groups.q0.feeds, groups.q1.feeds]).toEqual([[], []]);
    const messages = Object.fromEntries(validateDocument(document).map((finding) => [finding.scope, finding.message]));
    expect(messages.q0).toContain("Kreis");
    expect(messages.q1).toContain("Kreis");
  });

  it("reports a link to something that cannot feed", () => {
    const document = board([
      makeDevice("mcb", { id: "a", circuit: "1" }),
      makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "a" }),
      makeDevice("rcd", { id: "f2", designation: "F2", parent_id: "ghost" }),
    ]);
    const groups = groupsById(document);
    expect([groups.f1.fedBy, groups.f2.fedBy]).toEqual([null, null]);
    const findings = validateDocument(document);
    expect(findings.some((f) => f.scope === "f1" && f.message.includes("Einspeisung nicht gefunden"))).toBe(true);
    expect(findings.some((f) => f.scope === "f2" && f.message.includes("Einspeisung nicht gefunden"))).toBe(true);
  });
  it("reports a device named like a terminal strip, but not a rail terminal carrying its own strip's name", () => {
    const named = (blockName: string, railTerminal?: string) =>
      board([
        makeDevice("hauptschalter", { id: "q1", designation: "Q1" }),
        makeDevice("distribution_block", { id: "x1", designation: blockName, parent_id: "q1" }),
        makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "x1" }),
        makeDevice("mcb", { id: "a", designation: "F1.1", circuit: "1", rating: "B16", terminal_block: true }),
        ...(railTerminal ? [makeDevice("terminal", { id: "t1", designation: railTerminal })] : []),
      ]);
    const clash = validateDocument(named("X1")).filter((finding) => finding.scope === "x1");
    expect(clash.map((finding) => finding.level)).toEqual(["warn"]);
    expect(clash[0].message.startsWith("X1: so heißt auch eine Klemmleiste")).toBe(true);
    expect(validateDocument(named("x1")).some((finding) => finding.scope === "x1")).toBe(true);
    expect(validateDocument(named("X0")).some((finding) => finding.scope === "x1")).toBe(false);
    expect(validateDocument(named("X0", "X1")).some((finding) => finding.scope === "t1")).toBe(false);
  });
});
