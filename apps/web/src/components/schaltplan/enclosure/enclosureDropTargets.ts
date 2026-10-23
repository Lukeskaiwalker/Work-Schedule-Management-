/**
 * Where a dragged device would land (docs/PANEL_ENCLOSURE_R2.md §6.3) —
 * pure, so the hit test is a unit test and not a guess about layout.
 *
 * The drop targets are scene geometry in cabinet mm (rail bands, device
 * centres), not DOM rectangles: the finger's client point is converted once
 * (`clientToSceneMm`), and the band is chosen inside the field under the
 * finger — never a band of another field, even one whose overflowing
 * devices reach over the field line. `at` is the number of the rail's OTHER
 * devices left of the finger, the index `dropDevice` inserts at.
 *
 * `buildDropIndex` runs once per drag start; a hit test is then O(bands +
 * devices on one rail). The rail-fit number lives here too and is shared
 * with the RailPicker's "Zu wenig Platz" (`deviceOverMm`), so the drop
 * label and the picker can never disagree about a full rail.
 *
 * Strips (R11, owner 2026-10-22: whole strips) drop only onto the two
 * terminal rails of their own field; `stripDropAt` reads the same bands and
 * the placement, and takes the op's own fit number (`stripMoveOverMm`) as
 * its measure, so the label says exactly what `moveTerminalStrip` would.
 */
import { DRAWING_PAD_PX, FIELD_HEADER_PX, fieldIndexAt, type RailBand } from "./enclosureFrontLayout";
import { enclosureModules, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { round1 } from "../../../utils/enclosureGeometry";
import { enclosureDeviceWidthMm, linkedRows, railLengthMm, railRowId, resolvableRails } from "../../../utils/enclosureLayout";
import { dragGroup, reservedRailKey, rowsInCabinetOrder } from "../../../utils/enclosureOpsDrag";
import { fieldOfStrip, stripMoveOverMm } from "../../../utils/enclosureOpsTerminals";
import { TOLERANCE_MM } from "../../../utils/enclosureTerminals";
import { formatMmText } from "../../../utils/enclosureRules";
import { catalogEntry } from "../../../utils/schaltplanDevices";
import { findDevice } from "../../../utils/schaltplanTopologyCore";
import type { EnclosureScene, RailSpec, SceneBox, TerminalPlacement } from "../../../types/panelEnclosure";
import type { PanelDevice, PanelDocument } from "../../../types/schaltplan";

// ── Rail fit (shared with RailPickerSheet and sheetModel) ────────────────────

/** Geometry's overflow tolerance (§4): a rail is over only past this. */
export const RAIL_FIT_TOLERANCE_MM = 0.05;

/** What devices take on a rail, measured as the drawing measures them (an SLS on a busbar is 78,75 mm). */
export function railUsedMm(rail: Pick<RailSpec, "mount">, devices: readonly PanelDevice[]): number {
  return devices.reduce((total, device) => total + enclosureDeviceWidthMm(device, rail), 0);
}

/** How far `usedMm` runs over a rail of `capacityMm`, to 0,1 mm; 0 when it fits. */
export function railOverMm(capacityMm: number, usedMm: number): number {
  // Compared as geometry compares a device's right edge with the rail end.
  return usedMm > capacityMm + RAIL_FIT_TOLERANCE_MM ? round1(usedMm - capacityMm) : 0;
}

/**
 * How far a rail would run over with `deviceIds` moved onto it (they leave
 * wherever they are, this rail included). 0 when they fit, and for a rail
 * the board cannot resolve.
 */
export function deviceOverMm(doc: PanelDocument, index: CatalogIndex, deviceIds: readonly string[], moduleId: string, railKey: string): number {
  const module = enclosureModules(doc).find((candidate) => candidate.id === moduleId);
  const ref = module ? resolvableRails(module, index).get(railKey) : undefined;
  if (!module || !ref) return 0;
  const moving = new Set(deviceIds);
  const rowId = railRowId(linkedRows(doc, index), module, railKey);
  const staying = (doc.rows.find((row) => row.id === rowId)?.devices ?? []).filter((device) => !moving.has(device.id));
  const moved = deviceIds.map((id) => findDevice(doc, id)).filter((device): device is PanelDevice => device !== null);
  return railOverMm(railLengthMm(ref.rail), railUsedMm(ref.rail, staying) + railUsedMm(ref.rail, moved));
}

// ── What is being dragged ────────────────────────────────────────────────────

/** What a device drag needs from the board, asked once when the drag starts. */
export interface DeviceDragSource {
  /** The devices that travel, in reading order: the device alone, or a group head with its circuits. */
  deviceIds: string[];
  /** "F1.4 LS B16" · "F2 FI 40 A mit 8 Stromkreisen" — the label's source half. */
  name: string;
  /** The BMK on the ghost under the finger. */
  ghost: string;
  /** R19: on a board out of cabinet order every rail refuses. */
  rowsInOrder: boolean;
  /** `deviceOverMm` of the travelling devices on a rail. */
  overMmOn(moduleId: string, railKey: string): number;
}

function circuitsText(count: number): string {
  return count === 1 ? "1 Stromkreis" : `${count} Stromkreisen`;
}

export function deviceDragSource(doc: PanelDocument, index: CatalogIndex, deviceId: string): DeviceDragSource | null {
  const device = findDevice(doc, deviceId);
  if (!device) return null;
  const deviceIds = dragGroup(doc, index, deviceId);
  const short = catalogEntry(device.kind).short;
  const base = [device.designation.trim(), short, (device.rating ?? "").trim()].filter(Boolean).join(" ");
  return {
    deviceIds,
    name: deviceIds.length > 1 ? `${base} mit ${circuitsText(deviceIds.length - 1)}` : base,
    ghost: device.designation.trim() || short,
    rowsInOrder: rowsInCabinetOrder(doc, index),
    overMmOn: (moduleId, railKey) => deviceOverMm(doc, index, deviceIds, moduleId, railKey),
  };
}

// ── The hit test ─────────────────────────────────────────────────────────────

export type DropRefusal = "terminal_rail" | "retired" | "row_order" | "other_field" | "not_terminal_rail" | "too_full";

export interface DeviceDrop {
  moduleId: string;
  railKey: string;
  rowId: string | null;
  /** Index among the rail's other devices — what `dropDevice` inserts at. */
  at: number;
  /** Cabinet mm x of the insertion bar. */
  indicatorX: number;
  bandBoxId: string;
  title: string;
  /** The device the drop goes after; null = "am Anfang". */
  afterLabel: string | null;
  /** > 0: the rail runs over by this much — a warning only (D10). */
  overMm: number;
  refused: DropRefusal | null;
}

/** Client px → cabinet mm of a drawing whose svg sits at `svgRect` (EnclosureFrontSvg's padding and field header). */
export function clientToSceneMm(svgRect: Pick<DOMRect, "left" | "top">, zoom: number, client: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (client.x - svgRect.left - DRAWING_PAD_PX) / zoom,
    y: (client.y - svgRect.top - FIELD_HEADER_PX - DRAWING_PAD_PX) / zoom,
  };
}

interface IndexedDevice {
  id: string;
  label: string;
  x: number;
  w: number;
  cx: number;
}

interface IndexedBand {
  band: RailBand;
  railX: number;
  capacityMm: number;
  /** The rail's devices, left → right. */
  devices: IndexedDevice[];
  refused: DropRefusal | null;
}

export interface DropIndex {
  scene: EnclosureScene;
  bands: IndexedBand[];
  /** Drawn width of every device box, for the measure without a board. */
  widths: ReadonlyMap<string, number>;
  overMmOn: ((band: RailBand) => number) | null;
  /** `overMmOn` per band, filled as bands are hit. */
  overCache: Map<string, number>;
}

export interface DropIndexOptions {
  /** Terminal rails as `reservedRailKey` — empty until W3 passes `terminalRailKeys`. */
  reserved: ReadonlySet<string>;
  /** R19: false refuses every rail. */
  rowsInOrder: boolean;
  /** The rail-fit measure (`DeviceDragSource.overMmOn`); without it the drawn widths are summed. */
  overMmOn?: (band: RailBand) => number;
}

function staticRefusal(band: RailBand, opts: DropIndexOptions): DropRefusal | null {
  if (band.reserved || opts.reserved.has(reservedRailKey(band.moduleId, band.railKey))) return "terminal_rail";
  if (band.retired) return "retired";
  if (!opts.rowsInOrder) return "row_order";
  return null;
}

/** Once per drag start: per band its rail, its devices' centres and its standing refusal. */
export function buildDropIndex(scene: EnclosureScene, bands: readonly RailBand[], opts: DropIndexOptions): DropIndex {
  const rails = new Map(scene.boxes.filter((box) => box.kind === "rail" || box.kind === "busbar").map((box) => [box.id, box] as const));
  const devices = scene.boxes.filter((box): box is SceneBox & { deviceId: string } => box.kind === "device" && box.deviceId !== null);
  const indexed = bands.flatMap((band) => {
    const rail = rails.get(band.boxId);
    if (!rail) return [];
    const own = devices
      .filter((box) => box.moduleId === band.moduleId && box.railKey === band.railKey)
      .map((box) => ({ id: box.deviceId, label: box.label, x: box.x, w: box.w, cx: box.x + box.w / 2 }))
      .sort((a, b) => a.x - b.x);
    return [{ band, railX: rail.x, capacityMm: rail.w, devices: own, refused: staticRefusal(band, opts) }];
  });
  return { scene, bands: indexed, widths: new Map(devices.map((box) => [box.deviceId, box.w] as const)), overMmOn: opts.overMmOn ?? null, overCache: new Map() };
}

function contains(band: RailBand, point: { x: number; y: number }): boolean {
  return point.x >= band.x && point.x <= band.x + band.w && point.y >= band.y && point.y <= band.y + band.h;
}

function rectDistance(band: RailBand, point: { x: number; y: number }): number {
  const dx = Math.max(band.x - point.x, 0, point.x - (band.x + band.w));
  const dy = Math.max(band.y - point.y, 0, point.y - (band.y + band.h));
  return Math.hypot(dx, dy);
}

/** The band under the point, else the nearest within 1,5 band heights — inside the field under the point. */
function bandAt(index: DropIndex, point: { x: number; y: number }): IndexedBand | null {
  const field = fieldIndexAt(index.scene, point.x);
  const candidates = field === null ? index.bands : index.bands.filter((entry) => entry.band.field === field);
  const inside = candidates.find((entry) => contains(entry.band, point));
  if (inside) return inside;
  let best: IndexedBand | null = null;
  let bestDistance = Infinity;
  for (const entry of candidates) {
    const distance = rectDistance(entry.band, point);
    if (distance <= 1.5 * entry.band.h && distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  return best;
}

function overMmFor(index: DropIndex, entry: IndexedBand, others: readonly IndexedDevice[], dragged: ReadonlySet<string>): number {
  const measure = index.overMmOn;
  if (measure) {
    const cached = index.overCache.get(entry.band.boxId);
    if (cached !== undefined) return cached;
    const value = measure(entry.band);
    index.overCache.set(entry.band.boxId, value);
    return value;
  }
  const draggedMm = [...dragged].reduce((total, id) => total + (index.widths.get(id) ?? 0), 0);
  return railOverMm(entry.capacityMm, others.reduce((total, device) => total + device.w, 0) + draggedMm);
}

/** The drop under `point` (cabinet mm) for the dragged device(s), or null when no rail is near. */
export function deviceDropAt(index: DropIndex, point: { x: number; y: number }, dragged: string | readonly string[]): DeviceDrop | null {
  const entry = bandAt(index, point);
  if (!entry) return null;
  const moving = new Set(typeof dragged === "string" ? [dragged] : dragged);
  const others = entry.devices.filter((device) => !moving.has(device.id));
  const at = others.filter((device) => device.cx < point.x).length;
  const before = at > 0 ? others[at - 1] : null;
  return {
    moduleId: entry.band.moduleId,
    railKey: entry.band.railKey,
    rowId: entry.band.rowId,
    at,
    indicatorX: before ? before.x + before.w : entry.railX,
    bandBoxId: entry.band.boxId,
    title: entry.band.label,
    afterLabel: before ? before.label : null,
    overMm: overMmFor(index, entry, others, moving),
    refused: entry.refused,
  };
}

// ── The label (§6.6, §13) ────────────────────────────────────────────────────

const DEVICE_REFUSALS: Partial<Record<DropRefusal, string>> = {
  terminal_rail: "Reihenklemmen-Schiene — hier keine Geräte",
  retired: "ausgemustert",
  row_order: "Reihen nicht in Schrankreihenfolge — erst „Reihen ordnen“",
};

/** `{bmk} {short} → {title} · nach {bmk}` (· zu voll: {mm} mm über), or the refusal; the source alone over no rail. */
export function dropLabelText(name: string, drop: DeviceDrop | null): string {
  if (!drop) return name;
  if (drop.refused) return `${name} → ${drop.title} · ${DEVICE_REFUSALS[drop.refused] ?? "hier nicht"}`;
  const where = drop.afterLabel ? `nach ${drop.afterLabel}` : "am Anfang";
  const over = drop.overMm > 0 ? ` · zu voll: ${formatMmText(drop.overMm)} mm über` : "";
  return `${name} → ${drop.title} · ${where}${over}`;
}

// ── Strips (§6.3, R11) ───────────────────────────────────────────────────────

/** What a strip drag needs from the board, asked once when the drag starts. */
export interface StripDragSource {
  stripId: string;
  /** "X3": the ghost and the label. */
  xLabel: string;
  /** The field its circuits are in (0-based): the only field it may go to. */
  field: number;
  /** `stripMoveOverMm` of the strip at (`rail`, `at`): 0 when it fits. */
  overMmOn(rail: 0 | 1, at: number): number;
}

/**
 * The strip's drag source: its X label, its field, and the op's fit number
 * for every place — asked every frame, so each (rail, place) is measured
 * once per drag. Null for a strip the placement does not hold.
 */
export function stripDragSource(doc: PanelDocument, index: CatalogIndex, placement: TerminalPlacement, stripId: string): StripDragSource | null {
  const field = fieldOfStrip(placement, stripId);
  if (!field) return null;
  const strip = [...field.rails.flatMap((rail) => rail.strips), ...field.unplaced].find((candidate) => candidate.stripId === stripId);
  if (!strip) return null;
  const measured = new Map<string, number>();
  return {
    stripId,
    xLabel: strip.xLabel,
    field: field.field,
    overMmOn: (rail, at) => {
      const key = `${rail}:${at}`;
      const known = measured.get(key);
      if (known !== undefined) return known;
      const mm = stripMoveOverMm(doc, index, stripId, { field: field.field, rail, at });
      measured.set(key, mm);
      return mm;
    },
  };
}

export interface StripDrop {
  /** The field of the rail under the finger (0-based; -1 outside every field). */
  field: number;
  /** 0 = the field's top terminal rail, 1 = the second (0 on a rail that is none). */
  rail: 0 | 1;
  moduleId: string;
  railKey: string;
  /** Index among the rail's OTHER strips — what `moveTerminalStrip` inserts at. */
  at: number;
  /** Cabinet mm x of the insertion bar. */
  indicatorX: number;
  /** > 0: the move would not fit (refused, `too_full`). */
  overMm: number;
  refused: DropRefusal | null;
  bandBoxId: string;
  title: string;
}

/** The slot among `strips` (cabinet mm, any order) for a finger at `x`, the dragged one left out; the bar after the one before, else at `startX`. */
export function stripSlot(strips: readonly { id: string; x: number; w: number }[], stripId: string, x: number, startX: number): { at: number; indicatorX: number } {
  const others = strips.filter((strip) => strip.id !== stripId).sort((a, b) => a.x - b.x);
  const at = others.filter((strip) => strip.x + strip.w / 2 < x).length;
  const before = at > 0 ? others[at - 1] : null;
  return { at, indicatorX: before ? before.x + before.w : startX };
}

/** Without the op's measure: the strip added to the rail's others as placed (the target rail only). */
function placedOverMm(placement: TerminalPlacement, field: number, rail: number, stripId: string): number {
  const placed = placement.fields.find((candidate) => candidate.field === field);
  const target = placed?.rails[rail];
  if (!placed || !target) return 0;
  const all = [...placed.rails.flatMap((candidate) => candidate.strips), ...placed.unplaced];
  const dragged = all.find((strip) => strip.stripId === stripId)?.widthMm ?? 0;
  const others = target.strips.filter((strip) => strip.stripId !== stripId).reduce((total, strip) => total + strip.extentMm, 0);
  const plate = target.parts[0]?.widthMm ?? 0;
  const used = target.devicesMm + others + dragged + plate;
  return used > target.capacityMm + TOLERANCE_MM ? round1(used - target.capacityMm) : 0;
}

/**
 * The drop under `point` (cabinet mm) for a dragged strip, or null when no
 * rail is near. Refused: a rail that is no terminal rail, a terminal rail of
 * another field, and a move that does not fit (`measure`, the op's number).
 */
export function stripDropAt(
  index: DropIndex,
  placement: TerminalPlacement,
  point: { x: number; y: number },
  stripId: string,
  measure?: (rail: 0 | 1, at: number) => number,
): StripDrop | null {
  const entry = bandAt(index, point);
  if (!entry) return null;
  const band = entry.band;
  const base = { moduleId: band.moduleId, railKey: band.railKey, bandBoxId: band.boxId, title: band.label, field: band.field ?? -1 };
  const field = placement.fields.find((candidate) => candidate.field === band.field);
  const position = field ? field.rails.findIndex((rail) => rail.moduleId === band.moduleId && rail.railKey === band.railKey) : -1;
  if (!field || position < 0) return { ...base, rail: 0, at: 0, indicatorX: entry.railX, overMm: 0, refused: "not_terminal_rail" };
  const rail = position === 0 ? 0 : 1;
  const placed = field.rails[position];
  const strips = placed.strips.map((strip) => ({ id: strip.stripId, x: entry.railX + strip.offsetMm, w: strip.extentMm }));
  const slot = stripSlot(strips, stripId, point.x, entry.railX + placed.devicesMm);
  if (fieldOfStrip(placement, stripId)?.field !== field.field) return { ...base, rail, ...slot, overMm: 0, refused: "other_field" };
  const overMm = measure ? measure(rail, slot.at) : placedOverMm(placement, field.field, position, stripId);
  return { ...base, rail, ...slot, overMm, refused: overMm > 0 ? "too_full" : null };
}

/** `{X} → Hutschiene {r} · Platz {i}`, or why not (§13); the strip alone over no rail. `field`: the strip's own (0-based). */
export function stripLabelText(xLabel: string, field: number, drop: StripDrop | null): string {
  if (!drop) return xLabel;
  const rail = `Hutschiene ${drop.rail + 1}`;
  switch (drop.refused) {
    case "other_field":
      return `${xLabel} → ${drop.title} · Klemmen gehören zu Feld ${field + 1}`;
    case "not_terminal_rail":
      return `${xLabel} → ${drop.title} · keine Klemmen-Hutschiene`;
    case "too_full":
      return `${xLabel} → ${rail} · passt nicht: ${formatMmText(drop.overMm)} mm zu viel`;
    default:
      return `${xLabel} → ${rail} · Platz ${drop.at + 1}`;
  }
}
