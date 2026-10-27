/**
 * The cabinet as a list of boxes (docs/PANEL_ENCLOSURE.md §4) — the
 * TypeScript twin of `apps/api/app/services/panel_enclosure_geometry.py`.
 *
 * One pure function, twice: the SVG front view, the three.js view and the
 * reportlab Aufbau sheet all draw these boxes and compute no position of
 * their own, so the three pictures cannot disagree. A shared fixture written
 * by Python pins both twins to the same output, number for number — hence
 * `round1` (never `Math.round`, which rounds .5 differently from Python's
 * `round`) and a fully specified output order.
 *
 * Geometry reads the LIVE catalogue on purpose (§3.5): a corrected stack
 * reaches every drawing. Display-only sizes (device 90 × 70 mm, meters, a
 * terminal strip 96 × 42.3 mm — the 2003-7641 body —, every z) are drawing
 * approximations, not catalogue facts.
 *
 * WAGO terminals (docs/PANEL_ENCLOSURE_R2.md §8) come from the placement
 * (`placeTerminals`; pass it in when it is at hand): a terminal rail carries
 * the flag `terminals` in both views, and in the open view every placed strip
 * is one `terminal_strip` box on its rail. A hand-placed "Reihenklemme N/PE"
 * on a terminal rail is a placeholder the strips replace (R2 §3.6), so it is
 * not drawn there.
 *
 * The §14a block (docs/PANEL_ENCLOSURE_R4.md §5) is one `control_block` box
 * on its carrier's AAR rail, open view only, at the placement's (rounded)
 * `railX + offsetMm`; the runs of the cabinet preparation are no boxes.
 */

import { catalogEntry } from "./schaltplanDevices";
import { edgeTrimmed } from "./edgeTrim";
import { DERIVE, blockPlacement, controlBlockLayout, type BlockArg } from "./enclosureControlBlock";
import { enclosureModules, meterZones, type CatalogIndex } from "./enclosureCatalog";
import {
  enclosureDeviceWidthMm,
  generatedRowLabel,
  linkedRows,
  railLengthMm,
  railRowId,
  suppliedDevices,
  zoneLabel,
  type RailLink,
} from "./enclosureLayout";
import { PLACEHOLDER_KINDS, placeTerminals } from "./enclosureTerminals";
import type {
  DeviceSuppliedBy,
  EnclosureMeter,
  EnclosureModule,
  EnclosureScene,
  EnclosureSpec,
  ModuleSpec,
  PlacedTerminalRail,
  RailSpec,
  SceneBox,
  SceneBoxKind,
  SceneView,
  TerminalPlacement,
  ZoneSpec,
  ZoneType,
} from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

/** `floor(v·10 + 0.5) / 10` — the one rounding both twins use on every number. */
export function round1(value: number): number {
  return Math.floor(value * 10 + 0.5) / 10;
}

/**
 * "29,9" / "1050": a length as a finding's sentence shows it. Here, next to
 * `round1`, because the terminal findings need it and `enclosureRules`
 * imports them (Python moved `mm_text` into its geometry module alike).
 */
export function formatMmText(value: number): string {
  return String(round1(value)).replace(".", ",");
}

// Drawing approximations (mm), not catalogue facts.
const DEVICE_H = 90;
const RAIL_H = 35;
const BUSBAR_H = 60;
const SLOT_H = 46;
const FRONT_H = 45;
const COVER_INSET = 2;
const METER_BOX: Readonly<Record<"ehz" | "3punkt", { w: number; h: number }>> = {
  ehz: { w: 110, h: 210 },
  "3punkt": { w: 180, h: 330 },
};
const HANDLE = { w: 15, h: 120, d: 20 };
/** A placed WAGO strip: the 2003-7641 body's height (a drawing approximation). */
const STRIP_H = 96;
/** Right edge past the rail end by more than this = overflow (float noise allowance). */
const OVERFLOW_TOLERANCE_MM = 0.05;

// z / depth of each layer, back to front.
const Z = {
  field: [10, 2],
  module: [12, 3],
  zone: [15, 1],
  free: [15, 1],
  busbar: [30, 12],
  rail: [40, 7.5],
  meter: [40, 80],
  device: [47.5, 70],
  strip: [47.5, 42.3],
  cover: [120, 2],
  slot: [122, 0.5],
  window: [122, 0.5],
  front: [123, 0.5],
} as const;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BoxRefs {
  label?: string;
  moduleId?: string | null;
  railKey?: string | null;
  rowId?: string | null;
  deviceId?: string | null;
  zoneType?: ZoneType | null;
  flags?: string[];
}

function box(id: string, kind: SceneBoxKind, rect: Rect, [z, d]: readonly [number, number], refs: BoxRefs = {}): SceneBox {
  return {
    id,
    kind,
    x: round1(rect.x),
    y: round1(rect.y),
    z: round1(z),
    w: round1(rect.w),
    h: round1(rect.h),
    d: round1(d),
    label: refs.label ?? "",
    moduleId: refs.moduleId ?? null,
    railKey: refs.railKey ?? null,
    rowId: refs.rowId ?? null,
    deviceId: refs.deviceId ?? null,
    zoneType: refs.zoneType ?? null,
    flags: [...(refs.flags ?? [])].sort(),
  };
}

interface Context {
  cabinet: EnclosureSpec;
  index: CatalogIndex;
  view: SceneView;
  links: Map<string, RailLink>;
  rows: Map<string, PanelRow>;
  supplied: Map<string, DeviceSuppliedBy>;
  /** "moduleId\u0000railKey" → the placement's terminal rail. */
  terminals: Map<string, PlacedTerminalRail>;
}

const terminalKey = (moduleId: string, railKey: string): string => `${moduleId}\u0000${railKey}`;

// ── Cabinet ──────────────────────────────────────────────────────────────────

function cabinetBoxes(cabinet: EnclosureSpec): SceneBox[] {
  const { width_mm: W, height_mm: H, depth_mm: D, margin_mm: M, field_width_mm: FW, unit_mm: U } = cabinet;
  const boxes: SceneBox[] = [box("shell", "shell", { x: 0, y: 0, w: W, h: H }, [0, D])];
  for (let i = 0; i < cabinet.fields; i += 1) {
    const rect = { x: M + i * FW, y: M, w: FW, h: cabinet.units_per_field * U };
    boxes.push(box(`field:${i}`, "field", rect, Z.field, { label: `Feld ${i + 1}` }));
  }
  const leaves = cabinet.door_leaves;
  const leafW = W / leaves;
  for (let i = 0; i < leaves; i += 1) {
    boxes.push(box(`door:${i}`, "door", { x: i * leafW, y: 0, w: leafW, h: H }, [D, 2]));
    const handle = { x: handleX(i, leaves, leafW, W), y: H / 2 - HANDLE.h / 2, w: HANDLE.w, h: HANDLE.h };
    boxes.push(box(`handle:${i}`, "handle", handle, [D + 2, HANDLE.d]));
  }
  return boxes;
}

/** On the leaf's inner (closing) edge: one leaf hinges left; two meet in the middle. */
function handleX(i: number, leaves: number, leafW: number, width: number): number {
  if (leaves === 1) return width - 30;
  const left = i * leafW;
  // A leaf whose centre is the cabinet's centre (three leaves) counts as right of it.
  return left + leafW / 2 < width / 2 ? (i + 1) * leafW - 30 : left + 15;
}

// ── Modules ──────────────────────────────────────────────────────────────────

function moduleRect(module: EnclosureModule, spec: ModuleSpec | null, cabinet: EnclosureSpec): Rect {
  const { margin_mm: M, field_width_mm: FW, unit_mm: U } = cabinet;
  return {
    x: M + module.field * FW,
    y: M + module.unit * U,
    w: (spec ? spec.width_fields : 1) * FW,
    h: (spec ? spec.height_units : 1) * U,
  };
}

function moduleBoxes(ctx: Context, module: EnclosureModule): SceneBox[] {
  const spec = ctx.index.module(module.code);
  const rect = moduleRect(module, spec, ctx.cabinet);
  const flags = spec ? (spec.verified ? [] : ["unverified"]) : ["unknown_code"];
  const label = spec ? spec.article_no : edgeTrimmed(module.code);
  const boxes = [box(`module:${module.id}`, "module", rect, Z.module, { label, moduleId: module.id, flags })];
  if (!spec) return boxes;
  for (const zone of spec.zones) {
    const zoneRect = {
      x: rect.x + zone.field * ctx.cabinet.field_width_mm,
      y: rect.y + zone.unit * ctx.cabinet.unit_mm,
      w: ctx.cabinet.field_width_mm,
      h: zone.units * ctx.cabinet.unit_mm,
    };
    boxes.push(...zoneBoxes(ctx, module, zone, zoneRect));
  }
  boxes.push(...meterBoxes(ctx, module, spec, rect));
  return boxes;
}

function zoneBoxes(ctx: Context, module: EnclosureModule, zone: ZoneSpec, rect: Rect): SceneBox[] {
  const refs = { moduleId: module.id, zoneType: zone.type };
  const boxes = [box(`zone:${module.id}:${zone.key}`, "zone", rect, Z.zone, { ...refs, label: zoneLabel(zone) })];
  if (ctx.view === "closed") {
    const inset = { x: rect.x + COVER_INSET, y: rect.y + COVER_INSET, w: rect.w - 2 * COVER_INSET, h: rect.h - 2 * COVER_INSET };
    boxes.push(box(`cover:${module.id}:${zone.key}`, "cover", inset, Z.cover, { ...refs, flags: zone.sealable ? ["sealable"] : [] }));
  }
  for (const rail of zone.rails) boxes.push(...railBoxes(ctx, module, zone, rail, rect));
  return boxes;
}

function railBoxes(ctx: Context, module: EnclosureModule, zone: ZoneSpec, rail: RailSpec, zoneRect: Rect): SceneBox[] {
  const rowId = railRowId(ctx.links, module, rail.key);
  const row = rowId ? ctx.rows.get(rowId) : undefined;
  const terminalRail = ctx.terminals.get(terminalKey(module.id, rail.key));
  // The strips replace the hand-placed placeholders on a terminal rail (R2 §3.6).
  const devices = (row?.devices ?? []).filter((device) => !terminalRail || !PLACEHOLDER_KINDS.has(String(device.kind ?? "")));
  // A retired rail gets no new rows; it is drawn only while it still holds devices.
  if (rail.retired && devices.length === 0) return [];
  const U = ctx.cabinet.unit_mm;
  const cy = zoneRect.y + rail.unit * U + U / 2;
  const length = railLengthMm(rail);
  const x = zoneRect.x + (ctx.cabinet.field_width_mm - length) / 2;
  const busbar = rail.mount === "busbar";
  const height = busbar ? BUSBAR_H : RAIL_H;
  const refs = { moduleId: module.id, railKey: rail.key, rowId: rowId ?? null, zoneType: zone.type };
  const railRect = { x, y: cy - height / 2, w: length, h: height };
  const boxes = [
    box(`rail:${module.id}:${rail.key}`, busbar ? "busbar" : "rail", railRect, busbar ? Z.busbar : Z.rail, {
      ...refs,
      label: edgeTrimmed(row?.label) || generatedRowLabel(module, zone, rail),
      flags: [...(rail.retired ? ["retired"] : []), ...(terminalRail ? ["terminals"] : [])],
    }),
  ];
  if (ctx.view === "closed") {
    boxes.push(box(`slot:${module.id}:${rail.key}`, "cover_slot", { x, y: cy - SLOT_H / 2, w: length, h: SLOT_H }, Z.slot, refs));
  }
  // A running cursor, added to in the same order as the Python twin: float
  // sums are not associative, and the fixture compares to the last digit.
  let cursor = x;
  for (const device of devices) {
    const width = enclosureDeviceWidthMm(device, rail);
    const flags = deviceFlags(ctx, device, cursor + width > x + length + OVERFLOW_TOLERANCE_MM);
    const deviceRefs = { ...refs, deviceId: device.id, label: deviceLabelText(device), flags };
    boxes.push(
      ctx.view === "open"
        ? box(`device:${device.id}`, "device", { x: cursor, y: cy - DEVICE_H / 2, w: width, h: DEVICE_H }, Z.device, deviceRefs)
        : box(`front:${device.id}`, "device_front", { x: cursor, y: cy - FRONT_H / 2, w: width, h: FRONT_H }, Z.front, deviceRefs),
    );
    cursor += width;
  }
  if (terminalRail && ctx.view === "open") {
    // Behind the cover in the closed view.
    for (const strip of terminalRail.strips) {
      const rect = { x: x + strip.offsetMm, y: cy - STRIP_H / 2, w: strip.extentMm, h: STRIP_H };
      boxes.push(box(`terminal:${strip.stripId}`, "terminal_strip", rect, Z.strip, { ...refs, label: strip.xLabel }));
    }
  }
  return boxes;
}

function deviceFlags(ctx: Context, device: PanelDevice, overflow: boolean): string[] {
  const flags: string[] = [];
  if (overflow) flags.push("overflow");
  if (ctx.supplied.has(device.id)) flags.push("supplied");
  return flags;
}

/** BMK, else the catalogue's short name. */
export function deviceLabelText(device: Pick<PanelDevice, "designation" | "kind">): string {
  return edgeTrimmed(device.designation) || catalogEntry(device.kind).short;
}

// ── Meter places ─────────────────────────────────────────────────────────────

function meterBoxes(ctx: Context, module: EnclosureModule, spec: ModuleSpec, moduleBox: Rect): SceneBox[] {
  const occupied = new Map<number, EnclosureMeter>();
  // The first entry wins a repeated place.
  for (const meter of Array.isArray(module.meters) ? module.meters : []) if (!occupied.has(meter.place)) occupied.set(meter.place, meter);
  const { field_width_mm: FW, unit_mm: U } = ctx.cabinet;
  const boxes: SceneBox[] = [];
  let place = 0;
  for (const zone of meterZones(spec)) {
    const zone_ = { x: moduleBox.x + zone.field * FW, y: moduleBox.y + zone.unit * U, w: FW, h: zone.units * U };
    const type = zone.meter_type === "3punkt" ? "3punkt" : "ehz";
    const size = METER_BOX[type];
    for (let i = 0; i < zone.meter_places; i += 1, place += 1) {
      const entry = occupied.get(place);
      const rect = meterRect(zone_, zone.meter_places, i, size, type === "3punkt");
      boxes.push(...meterPlaceBoxes(ctx, module.id, place, rect, entry ? edgeTrimmed(entry.number) : null));
    }
  }
  return boxes;
}

/** eHZ side by side, 3-Punkt stacked (Doppelstock); the meter centred in its cell. */
function meterRect(zone: Rect, places: number, i: number, size: { w: number; h: number }, stacked: boolean): Rect {
  if (stacked) {
    const cell = zone.h / places;
    return { x: zone.x + (zone.w - size.w) / 2, y: zone.y + i * cell + (cell - size.h) / 2, w: size.w, h: size.h };
  }
  const cell = zone.w / places;
  return { x: zone.x + i * cell + (cell - size.w) / 2, y: zone.y + (zone.h - size.h) / 2, w: size.w, h: size.h };
}

/** `number` null = a free place (reserve); "" = occupied without a number yet. */
function meterPlaceBoxes(ctx: Context, moduleId: string, place: number, rect: Rect, number: string | null): SceneBox[] {
  const refs = { moduleId, zoneType: "ZF" as const };
  const free = number === null;
  if (ctx.view === "open") {
    return free
      ? [box(`meter:${moduleId}:${place}`, "meter_place", rect, Z.free, { ...refs, label: "frei", flags: ["free"] })]
      : [box(`meter:${moduleId}:${place}`, "meter", rect, Z.meter, { ...refs, label: number || "Zähler" })];
  }
  return [
    box(`window:${moduleId}:${place}`, "window", rect, Z.window, refs),
    free
      ? box(`blind:${moduleId}:${place}`, "blind_plate", rect, Z.front, { ...refs, label: "Blindabdeckung", flags: ["free"] })
      : box(`mfront:${moduleId}:${place}`, "meter_front", rect, Z.front, { ...refs, label: number }),
  ];
}

// ── The §14a block (R4 §5) ───────────────────────────────────────────────────

function controlBlockBoxes(document: PanelDocument, index: CatalogIndex, block: BlockArg): SceneBox[] {
  const layout = controlBlockLayout(document, index, block);
  if (!layout) return [];
  const placed = blockPlacement(layout);
  const rect = { x: placed.railX + placed.offsetMm, y: placed.railY - STRIP_H / 2, w: placed.widthMm, h: STRIP_H };
  return [box("control:block", "control_block", rect, Z.strip, {
    label: "§14a", moduleId: placed.moduleId, railKey: placed.railKey, rowId: layout.rail.rowId, zoneType: "AAR",
    flags: placed.overflow ? ["overflow"] : [],
  })];
}

// ── Scene ────────────────────────────────────────────────────────────────────

function compareBoxes(a: SceneBox, b: SceneBox): number {
  return a.z - b.z || a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Every box of the cabinet in one view, sorted by (z, y, x, id). Null when
 * the board has no cabinet or its cabinet code does not resolve. Devices of
 * rows not in the cabinet, and fittings without a device, produce no box.
 * `placement`: the board's `placeTerminals` result, when the caller already
 * has it; derived here otherwise (memoised by document identity). `block`:
 * the parsed §14a block (R4 §5; DERIVE reads it from the document, null: none).
 */
export function buildEnclosureScene(
  document: PanelDocument, index: CatalogIndex, view: SceneView, placement?: TerminalPlacement, block: BlockArg = DERIVE,
): EnclosureScene | null {
  const enclosure = document.enclosure;
  const cabinet = enclosure ? index.enclosure(enclosure.code) : null;
  if (!enclosure || !cabinet) return null;
  const ctx: Context = {
    cabinet,
    index,
    view,
    links: linkedRows(document, index),
    rows: new Map(document.rows.map((row) => [row.id, row] as const)),
    supplied: suppliedDevices(document, index),
    terminals: new Map(
      (placement ?? placeTerminals(document, index)).fields.flatMap((field) =>
        field.rails.map((rail) => [terminalKey(rail.moduleId, rail.railKey), rail] as const),
      ),
    ),
  };
  const boxes = [
    ...cabinetBoxes(cabinet),
    ...enclosureModules(document).flatMap((module) => moduleBoxes(ctx, module)),
    ...(view === "open" ? controlBlockBoxes(document, index, block) : []),
  ];
  return {
    width: round1(cabinet.width_mm),
    height: round1(cabinet.height_mm),
    depth: round1(cabinet.depth_mm),
    view,
    boxes: boxes.sort(compareBoxes),
  };
}
