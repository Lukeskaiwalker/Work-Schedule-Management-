/**
 * "Reihenklemme am Abgang" — who may carry the flag. The inspector's checkbox
 * and the Klemmen tab's bulk switch ask one question (`terminalOffered`). A
 * Neozed qualifies only as an outgoing of its own: as the Vorsicherung of an
 * FI, or heading circuits, it feeds others, and a hidden flag there would turn
 * into a 2016 block the day the fuse became an outgoing (review, 2026-10-09).
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, makeDevice } from "../utils/schaltplanDevices";
import { setTerminalsEverywhere } from "../utils/schaltplanDocumentOps";
import { terminalOffered } from "../utils/schaltplanTopology";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

function board(devices: PanelDevice[]): PanelDocument {
  return { ...emptyDocument(), rows: [{ id: "r1", label: "Reihe 1", slots: 40, devices }] };
}

const flags = (document: PanelDocument) =>
  Object.fromEntries(document.rows[0].devices.map((device) => [device.id, device.terminal_block === true]));

describe("terminalOffered", () => {
  const document = board([
    makeDevice("fuse", { id: "pre", designation: "F0", rating: "35 A" }),
    makeDevice("rcd", { id: "f1", designation: "F1", parent_id: "pre" }),
    makeDevice("mcb", { id: "a", designation: "F1.1", rating: "B16" }),
    makeDevice("fuse", { id: "head", designation: "F2", rating: "35 A", feeds_following: true }),
    makeDevice("mcb", { id: "b", designation: "F2.1", rating: "B16" }),
    makeDevice("fuse", { id: "pv", designation: "F3", rating: "35 A", parent_id: "f1" }),
    makeDevice("spd", { id: "spd", designation: "F4" }),
  ]);
  const byId = Object.fromEntries(document.rows[0].devices.map((device) => [device.id, device]));

  it("offers the flag to outgoings — an LS, and a Neozed that is an outgoing of its own", () => {
    expect(terminalOffered(byId.a, document)).toBe(true);
    expect(terminalOffered(byId.pv, document)).toBe(true);
  });

  it("never to a fuse that feeds others, nor to a device that is no outgoing", () => {
    expect(terminalOffered(byId.pre, document)).toBe(false);
    expect(terminalOffered(byId.head, document)).toBe(false);
    expect(terminalOffered(byId.f1, document)).toBe(false);
    expect(terminalOffered(byId.spd, document)).toBe(false);
  });

  it("the bulk switch flags exactly those, and clearing also clears a stale hidden flag", () => {
    const flagged = setTerminalsEverywhere(document, true);
    expect(flags(flagged)).toEqual({ pre: false, f1: false, a: true, head: false, b: true, pv: true, spd: false });
    // An old flag on a fuse that has since become a Vorsicherung goes on "off".
    const stale = board(document.rows[0].devices.map((device) => (device.id === "pre" ? { ...device, terminal_block: true } : device)));
    expect(flags(setTerminalsEverywhere(stale, false)).pre).toBe(false);
    // Untouched devices keep their identity, so React re-renders only what changed.
    expect(flagged.rows[0].devices[0]).toBe(document.rows[0].devices[0]);
  });
});
