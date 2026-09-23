/**
 * Reihenklemmen — derive the WAGO terminal strips of every FI group, with
 * their X numbers.
 *
 * Twin of `apps/api/app/services/schaltplan_terminals.py`. The editor
 * derives the strips locally for the "Klemmen" tab, the Stückliste, the
 * legend and the print preview; the server derives them again for the
 * print job and the PDF. Both sides are pinned on the same fixtures
 * (`test/fixtures/terminalFixtures.json`, walked by
 * `test/schaltplanTerminalFixtures.test.ts`), which is what keeps a preview
 * from promising a strip the printer will not produce.
 *
 * The rule (owner's numbering, 2026-09-23), per protection group G from
 * `buildTopology` in group order, children in physical order, with E = the
 * children that are eligible and flagged `terminal_block`:
 *
 *   1. E empty → G emits nothing.
 *   2. Every strip on the board gets the next X number, in board order. A
 *      group emits its **Leiste** first (when it has small outgoings), then
 *      one **Block** per big outgoing.
 *   3. The Leiste of an FI group: [2016-7714, marker "X<n>"] + per small
 *      outgoing its Etagenklemmen (2003-7641 for one phase; 2003-7641 +
 *      2003-7642 for three), each marker "<n>.<k>" with k counting through
 *      the whole Leiste + [2009-305, no marker]. Under a group without an FI
 *      (`no_rcd`) the Leiste has no feed terminal — there is no FI whose N
 *      bus it could open — and `validateDocument` says so.
 *   4. A big outgoing (three phases above 16 A, `isBlockDevice`) gets the
 *      16 mm² Block: [2016-7604 "N", 2016-7601 × 3 "L1" "L2" "L3", 2016-7607
 *      "PE"]. Its label is the owner's PV-block blueprint: the name (the
 *      device's description unless overridden), "X<n>", one cell per terminal.
 *
 * Decisions, spelled out because the owner's words allowed two readings:
 *   (a) "at the end of the row" means per protection group, not per
 *       physical rail — every FI owns its own N bus, so its end clamp closes
 *       *that* group even when its breakers continue on the next rail and
 *       even when two FIs share a rail;
 *   (b) a 2-pole breaker is treated as 1-pole, a 4-pole small outgoing as
 *       3-pole (the Etagenklemmen come in exactly those two shapes) —
 *       reported as an info finding; a 4-pole Block puts its N on the feed
 *       terminal;
 *   (c) an RCBO never opens a terminal group and never gets one;
 *   (d) every marker text can be overridden in `document.terminal_labels`
 *       (key → text, see `overrideKey`); a blank override prints nothing for
 *       that terminal, like an unnamed device on the BMK strip.
 */
import { catalogEntry } from "./schaltplanDevices";
import {
  DOTS_PER_MM,
  fontSizeForSegments,
  textWidthEm,
  trimMarkerText,
  type BoardFontSize,
  type FitSegment,
} from "./schaltplanStrip";
import {
  OUTGOING_PART_IDS,
  TERMINAL_PARTS,
  TERMINAL_PART_ORDER,
  devicePoles,
  isBlockDevice,
  outgoingPartsForPoles,
  terminalChildren,
  terminalVariant,
  type TerminalPart,
  type TerminalPartId,
  type TerminalVariant,
} from "./schaltplanTerminalRules";
import { buildTopology, findRowOf } from "./schaltplanTopologyCore";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

export type TerminalPole = "L1" | "L2" | "L3" | "N" | "PE";

/** Which editable text a terminal carries — the second half of its override key. */
export type TerminalSlot = "feed" | "1" | "2" | TerminalPole;

export const STRIP_KIND_LEISTE = "leiste";
export const STRIP_KIND_BLOCK = "block";
export type StripKind = typeof STRIP_KIND_LEISTE | typeof STRIP_KIND_BLOCK;

/** Group id of the circuits placed before any head — the supply group. */
export const SUPPLY_GROUP_ID = "supply";

/** The document key the marker overrides live under. */
export const OVERRIDES_KEY = "terminal_labels";

export interface TerminalEntry {
  /** 1-based position within its strip, feed terminal first. */
  position: number;
  partId: TerminalPartId;
  partNo: string;
  /** The FI for a feed terminal, the outgoing for its terminals, null for the end clamp. */
  deviceId: string | null;
  pole: TerminalPole | null;
  /** Which override slot this marker reads; null for a marker-less part. */
  slot: TerminalSlot | null;
  /** `"<device id>:<slot>"` — the key in `document.terminal_labels`; "" for a marker-less part. */
  key: string;
  /** What the marker says without an override ("X1", "1.3", "PE"); "" for the end clamp. */
  defaultLabel: string;
  /** What the marker says after overrides — "" prints nothing. */
  label: string;
  /** Strip segment (and rail footprint) in mm, from the part table. */
  widthMm: number;
  /** Carries a marker: gets a strip segment when its text is not empty. */
  marker: boolean;
}

export interface TerminalStrip {
  /** `"<head id or 'supply'>:leiste"` or `"<device id>:block"`. */
  stripId: string;
  /** The X number, counted over the whole board. */
  stripNo: number;
  kind: StripKind;
  /** "X1 · FI F1 · Reihe 1" for a Leiste, "X2 · Block F1.4 Wallbox Garage" for a Block. */
  title: string;
  /** The big outgoing a Block belongs to; null for a Leiste. */
  deviceId: string | null;
  /** The Block's name row after overrides; "" for a Leiste. */
  name: string;
  /** "X<n>" — the Block's X row after overrides; the plain X number for a Leiste. */
  xLabel: string;
  /** Override keys of the Block's two text rows; "" for a Leiste. */
  nameKey: string;
  xKey: string;
  terminals: TerminalEntry[];
}

export interface TerminalGroup {
  /** The head device's id, or "supply" for circuits placed before any head. */
  groupId: string;
  headDevice: PanelDevice | null;
  /** Label of the rail the head sits on; "—" for the supply group. */
  railLabel: string;
  variant: TerminalVariant;
  /** The group's Leiste (when it has small outgoings) then one Block per big outgoing, in board order. */
  strips: TerminalStrip[];
  /** Every terminal of every strip, flat, in order. */
  terminals: TerminalEntry[];
}

/**
 * Pad between a terminal's cut mark and its text, in dots (0.5 mm). The BMK
 * strip keeps 1 mm on either side, but a 5.2 mm segment minus 2 mm of pad
 * holds nothing: 5.2 × 12 − 12 = 50 dots leave "1.1" at 36 dots — the three
 * characters the owner says are all a 5.2 mm marker can carry.
 */
export const TERMINAL_SEG_PAD_DOTS = 6;

/**
 * The Block label sizes its own rows (`werkstatt_labels._render_block_label`):
 * every text is fitted between these two sizes, in dots, on its own row or
 * cell — the two text rows across the whole block, a cell on its 12 mm —
 * keeping `BLOCK_PAD_DOTS` free on either side and never starting closer
 * than `BLOCK_TEXT_GUARD_DOTS` to a cut line.
 */
export const BLOCK_ROW_SIZE_MAX_DOTS = 34;
export const BLOCK_ROW_SIZE_MIN_DOTS = 18;
export const BLOCK_PAD_DOTS = 6;
export const BLOCK_TEXT_GUARD_DOTS = 2;

/** Twin of `_fit_strip_text`: the size at which `text` fills `budgetDots`, clamped to the block's two sizes. */
function fitBlockText(text: string, budgetDots: number): number {
  const em = textWidthEm(text) || 0.6;
  return Math.max(BLOCK_ROW_SIZE_MIN_DOTS, Math.min(BLOCK_ROW_SIZE_MAX_DOTS, Math.trunc(budgetDots / em)));
}

/** Font size (dots) of a Block's name or X row across a block `lengthMm` wide. */
export function blockRowSizeDots(text: string, lengthMm: number): number {
  const bodyDots = Math.round(lengthMm * DOTS_PER_MM);
  return fitBlockText(text, bodyDots - 2 * BLOCK_TEXT_GUARD_DOTS - 2 * BLOCK_PAD_DOTS);
}

/** Font size (dots) of one cell text on a terminal `widthMm` wide. */
export function blockCellSizeDots(text: string, widthMm: number): number {
  return fitBlockText(text, widthMm * DOTS_PER_MM - 2 * BLOCK_PAD_DOTS);
}

const BLOCK_POLES: readonly TerminalPole[] = ["L1", "L2", "L3"];

type Overrides = Readonly<Record<string, string>>;

/**
 * The key of one editable text in `document.terminal_labels`:
 * `"<device id>:<slot>"` — slot `feed` for the FI's feed terminal, `1`/`2`
 * for an outgoing's Etagenklemmen, `N`/`L1`…/`PE` for a Block's cells,
 * `name` and `x` for the Block's two text rows.
 */
export function overrideKey(deviceId: string | null, slot: TerminalSlot | "name" | "x"): string {
  return `${deviceId ?? ""}:${slot}`;
}

/** The document's overrides as a clean string map — anything that is not an object, or a null value, is ignored. */
export function labelOverrides(document: Pick<PanelDocument, "terminal_labels">): Record<string, string> {
  const raw: unknown = document.terminal_labels;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

function entry(
  position: number,
  partId: TerminalPartId,
  deviceId: string | null,
  pole: TerminalPole | null,
  slot: TerminalSlot | null,
  defaultLabel: string,
  overrides: Overrides,
): TerminalEntry {
  const part = TERMINAL_PARTS[partId];
  const key = part.marker && slot !== null ? overrideKey(deviceId, slot) : "";
  const fallback = part.marker ? trimMarkerText(defaultLabel) : "";
  const label = key !== "" && key in overrides ? trimMarkerText(overrides[key]) : fallback;
  return {
    position,
    partId,
    partNo: part.partNo,
    deviceId,
    pole,
    slot: part.marker ? slot : null,
    key,
    defaultLabel: fallback,
    label,
    widthMm: part.widthMm,
    marker: part.marker,
  };
}

function leisteTerminals(
  stripNo: number,
  variant: TerminalVariant,
  head: PanelDevice | null,
  children: readonly PanelDevice[],
  overrides: Overrides,
): TerminalEntry[] {
  const withFeed = variant !== "no_rcd" && head !== null;
  const feed = withFeed ? [entry(1, "2016-7714", head.id || null, null, "feed", `X${stripNo}`, overrides)] : [];
  let position = feed.length;
  let k = 0;
  const outgoings = children.flatMap((device) =>
    outgoingPartsForPoles(devicePoles(device)).map((partId, index) => {
      position += 1;
      k += 1;
      const slot: TerminalSlot = index === 0 ? "1" : "2";
      return entry(position, partId, device.id || null, null, slot, `${stripNo}.${k}`, overrides);
    }),
  );
  const end = withFeed ? [entry(position + 1, "2009-305", null, null, null, "", overrides)] : [];
  return [...feed, ...outgoings, ...end];
}

function blockTerminals(device: PanelDevice, overrides: Overrides): TerminalEntry[] {
  const deviceId = device.id || null;
  return [
    entry(1, "2016-7604", deviceId, "N", "N", "N", overrides),
    ...BLOCK_POLES.map((pole, index) => entry(index + 2, "2016-7601", deviceId, pole, pole, pole, overrides)),
    entry(BLOCK_POLES.length + 2, "2016-7607", deviceId, "PE", "PE", "PE", overrides),
  ];
}

/** "F1.4 Wallbox Garage" — designation (or the catalogue short) and description. */
function deviceTitle(device: PanelDevice): string {
  const designation = device.designation.trim() || catalogEntry(device.kind).short;
  return `${designation} ${device.label.trim()}`.trim();
}

/** "FI F1 · Reihe 1" — the group as the strip list and the PDF name it. */
function groupName(head: PanelDevice | null, railLabel: string): string {
  if (!head) return "Einspeisung";
  const name = `${catalogEntry(head.kind).short} ${head.designation.trim() || "?"}`;
  return railLabel ? `${name} · ${railLabel}` : name;
}

function blockName(device: PanelDevice, overrides: Overrides): string {
  const key = overrideKey(device.id || null, "name");
  if (key in overrides) return trimMarkerText(overrides[key]);
  return trimMarkerText(device.label) || trimMarkerText(device.designation);
}

function blockX(stripNo: number, device: PanelDevice, overrides: Overrides): string {
  const key = overrideKey(device.id || null, "x");
  return key in overrides ? trimMarkerText(overrides[key]) : `X${stripNo}`;
}

function railLabelOf(document: PanelDocument, head: PanelDevice | null): string {
  if (!head) return "—";
  const rowId = findRowOf(document, head.id);
  return document.rows.find((row) => row.id === rowId)?.label ?? "";
}

/**
 * One entry per group that has at least one terminal, in group order; the
 * X numbers count through every strip of the board.
 */
export function deriveTerminals(document: PanelDocument): TerminalGroup[] {
  const overrides = labelOverrides(document);
  let stripNo = 0;
  return buildTopology(document).flatMap((group): TerminalGroup[] => {
    const children = terminalChildren(group);
    const variant = terminalVariant(group, children);
    if (!variant) return [];
    const head = group.device;
    const headId = head ? head.id : SUPPLY_GROUP_ID;
    const railLabel = railLabelOf(document, head);
    const title = groupName(head, railLabel);
    const small = children.filter((device) => !isBlockDevice(device));
    const big = children.filter((device) => isBlockDevice(device));
    const strips: TerminalStrip[] = [];
    if (small.length > 0) {
      stripNo += 1;
      strips.push({
        stripId: `${headId}:leiste`,
        stripNo,
        kind: STRIP_KIND_LEISTE,
        title: `X${stripNo} · ${title}`,
        deviceId: null,
        name: "",
        xLabel: `X${stripNo}`,
        nameKey: "",
        xKey: "",
        terminals: leisteTerminals(stripNo, variant, head, small, overrides),
      });
    }
    for (const device of big) {
      stripNo += 1;
      const deviceId = device.id || null;
      strips.push({
        stripId: `${deviceId}:block`,
        stripNo,
        kind: STRIP_KIND_BLOCK,
        title: `X${stripNo} · Block ${deviceTitle(device)}`,
        deviceId,
        name: blockName(device, overrides),
        xLabel: blockX(stripNo, device, overrides),
        nameKey: overrideKey(deviceId, "name"),
        xKey: overrideKey(deviceId, "x"),
        terminals: blockTerminals(device, overrides),
      });
    }
    return [
      {
        groupId: headId,
        headDevice: head,
        railLabel,
        variant,
        strips,
        terminals: strips.flatMap((strip) => strip.terminals),
      },
    ];
  });
}

/** "FI F1 · Reihe 1" — how a group is named on the tab, in the dialog and on the printed strip list. */
export function terminalGroupTitle(group: TerminalGroup): string {
  return groupName(group.headDevice, group.railLabel);
}

/**
 * device id → the X labels of its terminals, for the legend: an outgoing on
 * the Leiste lists "X1.1", "X1.2"; a Block lists its "X2" once.
 */
export function deviceTerminalLabels(groups: readonly TerminalGroup[]): Record<string, string[]> {
  const labels: Record<string, string[]> = {};
  const add = (deviceId: string, label: string) => {
    labels[deviceId] = [...(labels[deviceId] ?? []), label];
  };
  for (const group of groups) {
    for (const strip of group.strips) {
      if (strip.kind === STRIP_KIND_BLOCK) {
        if (strip.deviceId) add(strip.deviceId, strip.xLabel);
        continue;
      }
      for (const terminal of strip.terminals) {
        if (terminal.deviceId && OUTGOING_PART_IDS.has(terminal.partId) && terminal.label) {
          add(terminal.deviceId, `X${terminal.label}`);
        }
      }
    }
  }
  return labels;
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
  /** Leisten and Blöcke together — the X numbers on the board. */
  strips: number;
  groups: number;
  /** Outgoing devices that end on a terminal — the number the tab badge and the bulk toggle talk about. */
  devices: number;
}

export function terminalCounts(groups: readonly TerminalGroup[]): TerminalCounts {
  const devices = new Set<string>();
  let terminals = 0;
  let strips = 0;
  for (const group of groups) {
    terminals += group.terminals.length;
    strips += group.strips.length;
    for (const terminal of group.terminals) {
      if (terminal.deviceId && OUTGOING_PART_IDS.has(terminal.partId)) devices.add(terminal.deviceId);
    }
  }
  return { terminals, strips, groups: groups.length, devices: devices.size };
}

/** Parts in use on this board whose width is not confirmed — the print dialog warns about them. */
export function unverifiedTerminalParts(groups: readonly TerminalGroup[]): TerminalPart[] {
  const inUse = new Set(groups.flatMap((group) => group.terminals.map((terminal) => terminal.partId)));
  return TERMINAL_PART_ORDER.filter((partId) => inUse.has(partId))
    .map((partId) => TERMINAL_PARTS[partId])
    .filter((part) => !part.verified);
}

export interface TerminalStripItem {
  kind: StripKind;
  stripId: string;
  /** The strip's title — what the strip list and the print notice call it. */
  label: string;
  /** Block only: the name row; "" for a Leiste. */
  name: string;
  xLabel: string;
  /** Block only: one cell per terminal, blank or not — the label is one piece the width of the block. */
  cells: FitSegment[];
  /** Leiste only: one segment per marker-carrying terminal with a text, at the part's width. */
  segments: FitSegment[];
  /** Leiste only: marker-carrying terminals whose text is blank — nothing printed, but worth saying. */
  skipped: number;
  /** Every part of the strip, end clamp included. */
  partCount: number;
  /** Printed length between the start and end lines, in mm. */
  lengthMm: number;
}

export interface TerminalStripSet {
  /** One item per wanted strip that has something to print, in board order. */
  strips: TerminalStripItem[];
  /**
   * Marker-carrying Leiste terminals of the wanted strips that got no
   * segment — the ones of a Leiste dropped for having none included. The
   * dialog summary and the print notice report this number; a dropped
   * strip must not shrink it.
   */
  skipped: number;
}

/**
 * The printed length of a strip. Rounded to 0.01 mm: the widths are tenths
 * of a millimetre, and the twin sums them with Python's compensated `sum`,
 * so 12 + 5.2 + 5.2 + 5.2 must come out as 27.6 on both sides.
 */
function lengthOf(segments: readonly FitSegment[]): number {
  return Math.round(segments.reduce((total, segment) => total + segment.widthMm, 0) * 100) / 100;
}

function blockItem(strip: TerminalStrip): TerminalStripItem {
  const cells = strip.terminals.map((terminal) => ({ text: terminal.label, widthMm: terminal.widthMm }));
  return {
    kind: STRIP_KIND_BLOCK,
    stripId: strip.stripId,
    label: strip.title,
    name: strip.name,
    xLabel: strip.xLabel,
    cells,
    segments: [],
    skipped: 0,
    partCount: strip.terminals.length,
    lengthMm: lengthOf(cells),
  };
}

function leisteItem(strip: TerminalStrip): { item: TerminalStripItem | null; skipped: number } {
  const markers = strip.terminals.filter((terminal) => terminal.marker);
  const segments = markers
    .map((terminal) => ({ text: terminal.label, widthMm: terminal.widthMm }))
    .filter((segment) => segment.text !== "");
  const skipped = markers.length - segments.length;
  if (segments.length === 0) return { item: null, skipped };
  return {
    skipped,
    item: {
      kind: STRIP_KIND_LEISTE,
      stripId: strip.stripId,
      label: strip.title,
      name: "",
      xLabel: strip.xLabel,
      cells: [],
      segments,
      skipped,
      partCount: strip.terminals.length,
      lengthMm: lengthOf(segments),
    },
  };
}

/**
 * What goes to the printer for a selection. A Leiste terminal without a
 * text gets no segment and no width — the strip continues with the next
 * one, exactly like a blank cover on the BMK strip — and a Leiste left with
 * no segment at all is dropped from `strips` (its skipped terminals still
 * count). A Block is one piece the width of its five terminals, blank cells
 * included. `stripIds` absent = every strip; an explicit empty array = no
 * strip at all, because an unticked selection prints nothing, not the board.
 */
export function terminalStrips(groups: readonly TerminalGroup[], stripIds?: readonly string[]): TerminalStripSet {
  const wanted = stripIds === undefined ? null : new Set(stripIds);
  return groups
    .flatMap((group) => group.strips)
    .filter((strip) => wanted === null || wanted.has(strip.stripId))
    .reduce<TerminalStripSet>(
      (set, strip) => {
        if (strip.kind === STRIP_KIND_BLOCK) return { strips: [...set.strips, blockItem(strip)], skipped: set.skipped };
        const { item, skipped } = leisteItem(strip);
        return { strips: item ? [...set.strips, item] : set.strips, skipped: set.skipped + skipped };
      },
      { strips: [], skipped: 0 },
    );
}

/**
 * ONE font size for every Leiste marker of the board — over all strips, not
 * the ones being printed, so a strip reprinted later matches the rest. Block
 * labels size their own rows (`BlockSvg` ↔ werkstatt_labels). Not the BMK
 * board size: the pitch is different.
 */
export function terminalFontSize(groups: readonly TerminalGroup[], stripWidthMm: number): BoardFontSize {
  const segments = terminalStrips(groups)
    .strips.filter((strip) => strip.kind === STRIP_KIND_LEISTE)
    .flatMap((strip) => strip.segments);
  return fontSizeForSegments(segments, stripWidthMm, TERMINAL_SEG_PAD_DOTS);
}

/**
 * The document with one marker text overridden — `value` null removes the
 * override (the marker falls back to its default), "" keeps a blank one
 * (the marker prints nothing). A new object every time; the map is dropped
 * from the document once it is empty, so an untouched board round-trips
 * without the key.
 */
export function setTerminalLabel(document: PanelDocument, key: string, value: string | null): PanelDocument {
  const current = labelOverrides(document);
  const { [key]: _removed, ...rest } = current;
  const next = value === null ? rest : { ...rest, [key]: value };
  if (Object.keys(next).length === 0) {
    const { terminal_labels: _dropped, ...without } = document;
    return without;
  }
  return { ...document, terminal_labels: next };
}
