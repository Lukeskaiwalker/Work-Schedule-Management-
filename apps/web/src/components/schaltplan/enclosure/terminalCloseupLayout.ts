/**
 * Where the close-up draws what (docs/PANEL_ENCLOSURE_R2.md §7.2) — pure:
 * the px layout of a field's two terminal rails, every text already fitted
 * by the shared rule (`fitLabel`, the PDF's own, with the app's 1.1 margin).
 *
 * Across, the rails are to scale: 5 px per mm, so a 210 mm rail is 1050 px
 * and a 5.2 mm terminal 26 px. Up and down, the zones are fixed, not to
 * scale. Per rail, top → bottom:
 *
 *   heading   "Hutschiene {r} · {title} · {used} von {cap} mm" and the U84T chip
 *   markers   40 px: the marker ABOVE its terminal (a drawing convention —
 *             WAGO marks the middle/side; the legend says so), rotated in the
 *             zone when wider than the terminal, else cut with "…", ≥ 11 px
 *   body      160 px: part number, the conductors as stacked tags, WAGO colour
 *   texts     the "für" text and the cable, rotated, two lines ≥ 11 px; the
 *             column is as tall as the longest fitted text needs, ≤ 220 px
 *
 * The close-up places nothing itself: offsets come from `terminalCloseup`,
 * which reads the one placement.
 */
import { formatMmText } from "../../../utils/enclosureGeometry";
import { fitLabel, textWidth, type LabelFit } from "../../../utils/labelFit";
import type { CloseupItem, CloseupRail, TerminalCloseup } from "../../../types/panelEnclosure";

export const PX_PER_MM = 5;
export const PAD_PX = 16;
export const HEAD_PX = 34;
export const MARKER_ZONE_PX = 40;
export const BODY_PX = 160;
export const TEXT_MIN_PX = 40;
export const TEXT_MAX_PX = 220;
export const RAIL_GAP_PX = 28;
/** The fit rule's sizes in px; `scale` keeps the margin the UI font needs over Helvetica. */
export const CLOSEUP_FIT = Object.freeze({
  marker: { max: 13, min: 11 },
  text: { max: 12, min: 11 },
  part: { max: 10, min: 8 },
  heading: 13,
  scale: 1.1,
});
const CELL_PAD_PX = 2;
const MARKER_PAD_PX = 6;
const TEXT_PAD_PX = 8;
const PART_CELL_PX = 52;
const CHIP_PAD_PX = 10;

export const U84T_FACTORY = "U84T ab Werk";
export const U84T_LISTED = "U84T: 1 Satz auf der Materialliste";

/** WAGO housing colours (§7.2): grey 2003/2016-7601 and the 2016-7691, blue N and the end clamp, green-yellow PE, orange 2003 plate. */
export type PartTone = "grey" | "blue" | "pe" | "orange";
const TONES: Readonly<Record<string, PartTone>> = {
  "2016-7714": "blue",
  "2016-7604": "blue",
  "2009-305": "blue",
  "2016-7607": "pe",
  "2003-7692": "orange",
};
export const partTone = (partId: string): PartTone => TONES[partId] ?? "grey";

export interface ItemLayout {
  /** `{stripId}#{offsetMm}` (`plate#…` for an end plate): unique on a rail. */
  key: string;
  item: CloseupItem;
  /** 1-based place of the terminal in its strip (the Klemmen tab's "Pos."); 0 for a plate. */
  position: number;
  x: number;
  w: number;
  marker: LabelFit;
  part: LabelFit;
  forText: LabelFit;
  cable: LabelFit;
  tone: PartTone;
}

export interface StripExtent {
  stripId: string;
  xLabel: string;
  /** On the rail, mm from its left end (as the placement measures). */
  offsetMm: number;
  extentMm: number;
}

export interface RailLayout {
  rail: CloseupRail;
  position: 0 | 1;
  top: number;
  markerY: number;
  bodyY: number;
  textY: number;
  textH: number;
  bottom: number;
  heading: string;
  chip: string | null;
  /** Where the heading's chip starts, px. */
  chipX: number;
  chipW: number;
  /** Where the back-compat devices end and the strips may start, mm. */
  devicesEndMm: number;
  items: ItemLayout[];
  strips: StripExtent[];
  devices: { deviceId: string; label: LabelFit; x: number; w: number }[];
}

export interface CloseupLayout {
  width: number;
  height: number;
  rails: RailLayout[];
}

/** px of a rail position in mm. */
export const xOf = (mm: number): number => PAD_PX + mm * PX_PER_MM;

export function railHeading(rail: CloseupRail): string {
  return `Hutschiene ${rail.position + 1} · ${rail.title} · ${formatMmText(rail.usedMm)} von ${formatMmText(rail.capacityMm)} mm`;
}

/** "U84T ab Werk" on an insulated rail; the set the Materialliste adds for a rail that holds strips; nothing else. */
export function u84tChip(rail: CloseupRail): string | null {
  if (rail.insulated) return U84T_FACTORY;
  return rail.items.some((item) => item.stripId !== null) ? U84T_LISTED : null;
}

/** The strips on the rail, left → right: from the first to the last of each strip's items. */
function stripExtents(items: readonly CloseupItem[]): StripExtent[] {
  return items.reduce<StripExtent[]>((out, item) => {
    if (item.stripId === null) return out;
    const last = out[out.length - 1];
    if (last && last.stripId === item.stripId) {
      return [...out.slice(0, -1), { ...last, extentMm: item.offsetMm + item.widthMm - last.offsetMm }];
    }
    return [...out, { stripId: item.stripId, xLabel: item.xLabel, offsetMm: item.offsetMm, extentMm: item.widthMm }];
  }, []);
}

function textColumnPx(items: readonly CloseupItem[]): number {
  let longest = 0;
  for (const item of items) {
    for (const text of [item.forText, item.cable]) longest = Math.max(longest, textWidth(text, CLOSEUP_FIT.text.max, CLOSEUP_FIT.scale));
  }
  return Math.min(TEXT_MAX_PX, Math.max(TEXT_MIN_PX, Math.ceil(longest + 2 * TEXT_PAD_PX)));
}

function itemLayout(item: CloseupItem, position: number, textH: number): ItemLayout {
  const w = item.widthMm * PX_PER_MM;
  const inner = Math.max(0, w - CELL_PAD_PX);
  const line = { w: Math.max(0, textH - 2 * TEXT_PAD_PX), h: Math.max(0, (w - 2 * CELL_PAD_PX) / 2) };
  return {
    key: `${item.stripId ?? "plate"}#${item.offsetMm}`,
    item,
    position,
    x: xOf(item.offsetMm),
    w,
    marker: fitLabel(item.marker, { w: inner, h: MARKER_ZONE_PX - MARKER_PAD_PX }, CLOSEUP_FIT.marker, CLOSEUP_FIT.scale),
    part: fitLabel(item.partId, { w: inner, h: PART_CELL_PX }, CLOSEUP_FIT.part, CLOSEUP_FIT.scale),
    forText: fitLabel(item.forText, line, CLOSEUP_FIT.text, CLOSEUP_FIT.scale),
    cable: fitLabel(item.cable, line, CLOSEUP_FIT.text, CLOSEUP_FIT.scale),
    tone: partTone(item.partId),
  };
}

function railLayout(rail: CloseupRail, top: number): RailLayout {
  const textH = textColumnPx(rail.items);
  const markerY = top + HEAD_PX;
  const bodyY = markerY + MARKER_ZONE_PX;
  const textY = bodyY + BODY_PX;
  const counters = new Map<string, number>();
  const items = rail.items.map((item) => {
    const position = item.stripId === null ? 0 : (counters.get(item.stripId) ?? 0) + 1;
    if (item.stripId !== null) counters.set(item.stripId, position);
    return itemLayout(item, position, textH);
  });
  const heading = railHeading(rail);
  const chip = u84tChip(rail);
  const lastDevice = rail.devices[rail.devices.length - 1];
  return {
    rail,
    position: rail.position,
    top,
    markerY,
    bodyY,
    textY,
    textH,
    bottom: textY + textH,
    heading,
    chip,
    chipX: PAD_PX + textWidth(heading, CLOSEUP_FIT.heading, CLOSEUP_FIT.scale) + CHIP_PAD_PX,
    chipW: chip ? textWidth(chip, CLOSEUP_FIT.text.max, CLOSEUP_FIT.scale) + 2 * CHIP_PAD_PX : 0,
    devicesEndMm: lastDevice ? lastDevice.offsetMm + lastDevice.widthMm : 0,
    items,
    strips: stripExtents(rail.items),
    devices: rail.devices.map((device) => ({
      deviceId: device.deviceId,
      label: fitLabel(device.label, { w: Math.max(0, device.widthMm * PX_PER_MM - CELL_PAD_PX), h: BODY_PX / 2 }, CLOSEUP_FIT.marker, CLOSEUP_FIT.scale),
      x: xOf(device.offsetMm),
      w: device.widthMm * PX_PER_MM,
    })),
  };
}

/** The close-up's px layout: both rails stacked in one drawing. */
export function closeupLayout(closeup: TerminalCloseup): CloseupLayout {
  const rails: RailLayout[] = [];
  let top = 0;
  for (const rail of closeup.rails) {
    const laid = railLayout(rail, top);
    rails.push(laid);
    top = laid.bottom + RAIL_GAP_PX;
  }
  const right = Math.max(
    0,
    ...rails.map((rail) => Math.max(xOf(rail.rail.capacityMm), rail.chipX + rail.chipW, ...rail.items.map((item) => item.x + item.w), ...rail.devices.map((device) => device.x + device.w))),
  );
  return { width: Math.ceil(right + PAD_PX), height: Math.max(0, top - RAIL_GAP_PX), rails };
}
