/**
 * Reihenklemmen — derive the WAGO terminal sequence of every FI group.
 *
 * Twin of `apps/api/app/services/schaltplan_terminals.py`. The editor
 * derives the sequence locally for the "Klemmen" tab, the Stückliste and
 * the print preview; the server derives it again for the print job and
 * the PDF. Both sides are pinned on the same fixtures
 * (`test/schaltplanTerminals.test.ts` ↔ `tests/test_schaltplan_terminals.py`),
 * which is what keeps a preview from promising a strip the printer will
 * not produce.
 *
 * The rule, per protection group G (from `buildTopology`, in group order,
 * children in physical order), with E = the children that are eligible
 * and flagged `terminal_block`:
 *
 *   1. E empty → G emits nothing.
 *   2. Head is an FI and E is one device with ≥ 3 poles → "single3p":
 *      [2016-7604 (FI's BMK)] + [2016-7601 × poles (L1, L2, L3, N)] + [2016-7607 (PE)].
 *   3. Head is an FI otherwise → "standard":
 *      [2016-7714 (FI's BMK)] + per device (2003-7641 for ≤ 2 poles,
 *      2003-7642 for ≥ 3) + [2009-305].
 *   4. Head is not an FI → "no_rcd": the per-device terminals only, and
 *      `validateDocument` says why there is no feed terminal.
 *
 * Decisions, spelled out because the owner's words allowed two readings:
 *   (a) "at the end of the row" means per protection group, not per
 *       physical rail — every FI owns its own N bus, so its end element
 *       closes *that* group even when its breakers continue on the next
 *       rail (the mcb-12 template) and even when two FIs share a rail;
 *   (b) a 2-pole breaker is treated as 1-pole, a 4-pole outgoing as 3-pole
 *       (the Etagenklemmen come in exactly those two shapes) — reported as
 *       an info finding;
 *   (c) an RCBO never opens a terminal group and never gets one.
 */
import { catalogEntry } from "./schaltplanDevices";
import { fontSizeForSegments, trimMarkerText, type BoardFontSize, type FitSegment } from "./schaltplanStrip";
import {
  OUTGOING_PART_IDS,
  TERMINAL_PARTS,
  TERMINAL_PART_ORDER,
  devicePoles,
  outgoingPartForPoles,
  terminalChildren,
  terminalVariant,
  type TerminalPart,
  type TerminalPartId,
  type TerminalVariant,
} from "./schaltplanTerminalRules";
import { buildTopology, findRowOf } from "./schaltplanTopology";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

export type TerminalPole = "L1" | "L2" | "L3" | "N" | "PE";

export interface TerminalEntry {
  /** 1-based position along the group, feed terminal first. */
  position: number;
  partId: TerminalPartId;
  partNo: string;
  /** The FI for a feed terminal, the outgoing for its terminal(s), null for an end element. */
  deviceId: string | null;
  pole: TerminalPole | null;
  /** What the marker says in BMK mode ("F1.3"); empty for an end element. */
  labelBmk: string;
  /** What the marker says in Stromkreis-Nr. mode ("7"); the FI's BMK on a feed terminal. */
  labelCircuit: string;
  /** Strip segment (and rail footprint) in mm, from the part table. */
  widthMm: number;
  /** Carries a marker: gets a strip segment when its text is not empty. */
  marker: boolean;
}

export interface TerminalGroup {
  /** The head device's id, or "supply" for circuits placed before any head. */
  groupId: string;
  headDevice: PanelDevice | null;
  /** Label of the rail the head sits on; "—" for the supply group. */
  railLabel: string;
  variant: TerminalVariant;
  terminals: TerminalEntry[];
}

/**
 * Pad between a terminal's cut mark and its text, in dots (0.5 mm). The BMK
 * strip keeps 1 mm on either side, but a 5.2 mm segment minus 2 mm of pad
 * holds nothing: 5.2 × 12 − 12 = 50 dots leave "7" at 90 dots and "F1.3"
 * at 25 — just above the 24-dot readability floor. "F1.12" still overflows
 * and is reported like any other overflow.
 */
export const TERMINAL_SEG_PAD_DOTS = 6;

export type TerminalTextMode = "bmk" | "circuit";

const POLE_NAMES: readonly TerminalPole[] = ["L1", "L2", "L3", "N"];

function entry(
  position: number,
  partId: TerminalPartId,
  deviceId: string | null,
  pole: TerminalPole | null,
  labelBmk: string,
  labelCircuit: string,
): TerminalEntry {
  const part = TERMINAL_PARTS[partId];
  return {
    position,
    partId,
    partNo: part.partNo,
    deviceId,
    pole,
    labelBmk: part.marker ? labelBmk : "",
    labelCircuit: part.marker ? labelCircuit : "",
    widthMm: part.widthMm,
    marker: part.marker,
  };
}

function feedEntry(position: number, partId: TerminalPartId, head: PanelDevice): TerminalEntry {
  const bmk = trimMarkerText(head.designation);
  return entry(position, partId, head.id, null, bmk, bmk);
}

function outgoingEntry(position: number, device: PanelDevice): TerminalEntry {
  return entry(
    position,
    outgoingPartForPoles(devicePoles(device)),
    device.id,
    null,
    trimMarkerText(device.designation),
    trimMarkerText(device.circuit),
  );
}

function sequence(variant: TerminalVariant, head: PanelDevice | null, children: PanelDevice[]): TerminalEntry[] {
  if (variant === "no_rcd" || head === null) {
    return children.map((device, index) => outgoingEntry(index + 1, device));
  }
  if (variant === "single3p") {
    const device = children[0];
    const poles = POLE_NAMES.slice(0, devicePoles(device));
    return [
      feedEntry(1, "2016-7604", head),
      ...poles.map((pole, index) => entry(index + 2, "2016-7601", device.id, pole, pole, pole)),
      entry(poles.length + 2, "2016-7607", device.id, "PE", "PE", "PE"),
    ];
  }
  return [
    feedEntry(1, "2016-7714", head),
    ...children.map((device, index) => outgoingEntry(index + 2, device)),
    entry(children.length + 2, "2009-305", null, null, "", ""),
  ];
}

function railLabelOf(document: PanelDocument, head: PanelDevice | null): string {
  if (!head) return "—";
  const rowId = findRowOf(document, head.id);
  return document.rows.find((row) => row.id === rowId)?.label ?? "";
}

export function deriveTerminals(document: PanelDocument): TerminalGroup[] {
  return buildTopology(document).flatMap((group): TerminalGroup[] => {
    const children = terminalChildren(group);
    const variant = terminalVariant(group, children);
    if (!variant) return [];
    const head = group.device;
    return [
      {
        groupId: head?.id ?? "supply",
        headDevice: head,
        railLabel: railLabelOf(document, head),
        variant,
        terminals: sequence(variant, head, children),
      },
    ];
  });
}

/** "FI F1 · Reihe 1" — how a group is named on the tab, in the dialog and on the printed strip list. */
export function terminalGroupTitle(group: TerminalGroup): string {
  const head = group.headDevice;
  if (!head) return "Einspeisung";
  const name = `${catalogEntry(head.kind).short} ${head.designation.trim() || "?"}`;
  return group.railLabel ? `${name} · ${group.railLabel}` : name;
}

export interface TerminalBomRow {
  partId: TerminalPartId;
  partNo: string;
  name: string;
  count: number;
  widthMm: number;
  verified: boolean;
}

/** Parts summed over the board, sorted by part number. */
export function terminalBom(groups: readonly TerminalGroup[]): TerminalBomRow[] {
  const counts = new Map<TerminalPartId, number>();
  for (const group of groups) {
    for (const terminal of group.terminals) {
      counts.set(terminal.partId, (counts.get(terminal.partId) ?? 0) + 1);
    }
  }
  return TERMINAL_PART_ORDER.filter((partId) => counts.has(partId)).map((partId) => {
    const part = TERMINAL_PARTS[partId];
    return {
      partId,
      partNo: part.partNo,
      name: part.name,
      count: counts.get(partId) ?? 0,
      widthMm: part.widthMm,
      verified: part.verified,
    };
  });
}

export interface TerminalCounts {
  terminals: number;
  groups: number;
  /** Outgoing devices that end on a terminal — the number the tab badge and the bulk toggle talk about. */
  devices: number;
}

export function terminalCounts(groups: readonly TerminalGroup[]): TerminalCounts {
  const devices = new Set<string>();
  let terminals = 0;
  for (const group of groups) {
    terminals += group.terminals.length;
    for (const terminal of group.terminals) {
      if (terminal.deviceId && OUTGOING_PART_IDS.has(terminal.partId)) devices.add(terminal.deviceId);
    }
  }
  return { terminals, groups: groups.length, devices: devices.size };
}

/** Parts in use on this board whose width is not confirmed — the print dialog warns about them. */
export function unverifiedTerminalParts(groups: readonly TerminalGroup[]): TerminalPart[] {
  const inUse = new Set(groups.flatMap((group) => group.terminals.map((terminal) => terminal.partId)));
  return TERMINAL_PART_ORDER.filter((partId) => inUse.has(partId))
    .map((partId) => TERMINAL_PARTS[partId])
    .filter((part) => !part.verified);
}

/** What a terminal's marker says in the chosen mode; "" for an end element or a missing text. */
export function terminalText(terminal: TerminalEntry, mode: TerminalTextMode): string {
  if (!terminal.marker) return "";
  return mode === "bmk" ? terminal.labelBmk : terminal.labelCircuit;
}

export interface TerminalStrip {
  groupId: string;
  label: string;
  /** One segment per marker-carrying terminal with a text, at the part's width. */
  segments: FitSegment[];
  /** Marker-carrying terminals whose text is empty in this mode — nothing printed, but worth saying. */
  skipped: number;
  /** Every part of the group, end element included. */
  partCount: number;
  /** Printed length between the start and end lines, in mm. */
  lengthMm: number;
}

export interface TerminalStripSet {
  /** One strip per wanted group that has something to print, in group order. */
  strips: TerminalStrip[];
  /**
   * Marker-carrying terminals of the wanted groups that got no segment — the
   * ones of a group dropped for having none included. The dialog summary and
   * the print notice report this number; a dropped group must not shrink it.
   */
  skipped: number;
}

/**
 * The strips of a selection. A terminal without a text in the chosen mode
 * gets no segment and no width — the strip continues with the next one,
 * exactly like a blank cover on the BMK strip — and a group left with no
 * segment at all is dropped from `strips` (its skipped terminals still
 * count). `groupIds` absent = every group; an explicit empty array = no
 * group at all, because an unticked selection prints nothing, not the board.
 */
export function terminalStrips(
  groups: readonly TerminalGroup[],
  mode: TerminalTextMode,
  groupIds?: readonly string[],
): TerminalStripSet {
  const wanted = groupIds === undefined ? null : new Set(groupIds);
  return groups
    .filter((group) => wanted === null || wanted.has(group.groupId))
    .reduce<TerminalStripSet>(
      (set, group) => {
        const markers = group.terminals.filter((terminal) => terminal.marker);
        const segments = markers
          .map((terminal) => ({ text: terminalText(terminal, mode), widthMm: terminal.widthMm }))
          .filter((segment) => segment.text !== "");
        const skipped = set.skipped + markers.length - segments.length;
        if (segments.length === 0) return { strips: set.strips, skipped };
        const strip: TerminalStrip = {
          groupId: group.groupId,
          label: terminalGroupTitle(group),
          segments,
          skipped: markers.length - segments.length,
          partCount: group.terminals.length,
          lengthMm: segments.reduce((total, segment) => total + segment.widthMm, 0),
        };
        return { strips: [...set.strips, strip], skipped };
      },
      { strips: [], skipped: 0 },
    );
}

/**
 * ONE font size for every terminal strip of the board, in the chosen mode —
 * over all groups, not the ones being printed, so a group reprinted later
 * matches the rest. Not the BMK board size: the pitch is different.
 */
export function terminalFontSize(
  groups: readonly TerminalGroup[],
  mode: TerminalTextMode,
  stripWidthMm: number,
): BoardFontSize {
  const segments = terminalStrips(groups, mode).strips.flatMap((strip) => strip.segments);
  return fontSizeForSegments(segments, stripWidthMm, TERMINAL_SEG_PAD_DOTS);
}
