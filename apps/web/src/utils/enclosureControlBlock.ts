/**
 * The §14a Steuersignal-Klemmleiste of a Zählerschrank
 * (docs/PANEL_ENCLOSURE_R4.md §2, §3.1, §3.2, §3.4) — the TypeScript twin of
 * `apps/api/app/services/panel_enclosure_control_block.py` (plus the
 * schema's `parse_control_block`), pinned on `enclosureFixtures.json` (key
 * `control_block` per board, table `control_block_parse`).
 *
 * The block is **stored** (`enclosure.control_block`: labels, colours, wire,
 * tube — user data only the editor seeds, R4-2) and read only through the
 * lenient `parseControlBlock`. Where it sits is **derived**:
 *
 * - the **carrier** is the first meter module from the left that is in use —
 *   a reserve field (R4-12) only when there is nothing else;
 * - the **rail** is an AAR rail of the carrier (BDEW Anwendungshilfe §3.5.2):
 *   the stored one when it is a candidate, else the first with room, else the
 *   first; the block is right-aligned and never drawn over the devices.
 *
 * The block has its own part table (`CONTROL_PARTS`, disjoint from the
 * circuit terminals' `TERMINAL_PARTS`) and never goes through
 * `placeTerminals` (R4-3). Also here: the scene points the cabinet
 * preparation measures runs between (§3.4). Never imports the geometry (the
 * geometry imports this for the `control_block` box). Millimetres are
 * computed unrounded, sums run left → right in plain loops, `round1` on the
 * way out — as the Python twin does, so both agree to the bit.
 */

import { meterZones, type CatalogIndex } from "./enclosureCatalog";
import { enclosureDeviceWidthMm } from "./enclosureLayout";
import {
  TOLERANCE_MM,
  asInt,
  enclosureOf,
  ident,
  isRecord,
  linkedRails,
  moduleRails,
  moduleSpec,
  modulesOf,
  railTitle,
  round1,
  rowDevices,
  rowsOf,
  zoneField,
} from "./enclosureTerminals";
import { MODULE_WIDTH_MM } from "./schaltplanStrip";
import type {
  ControlBlock,
  ControlBlockPart,
  ControlBlockPlacement,
  ControlPartId,
  ControlTerminal,
  EnclosureModule,
  ModuleFamily,
  ModuleSpec,
  RailSpec,
  TubeMaterialId,
  WireColour,
  WireMm2,
  ZoneSpec,
} from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";

// ── Constants (§2.3, both twins exact) ───────────────────────────────────────

/** `fn(..., block = DERIVE)` reads the stored block; `null` means "there is no block". */
export const DERIVE: unique symbol = Symbol("DERIVE");
export type BlockArg = ControlBlock | null | typeof DERIVE;

export const PART_END_STOP = "249-116";
export const PART_TERMINAL = "2002-1671";
export const PART_PLATE = "2002-1692";

export interface ControlPart {
  label: string;
  width_mm: number;
  marker: boolean;
}

export const CONTROL_PARTS: Readonly<Record<ControlPartId, ControlPart>> = {
  [PART_END_STOP]: { label: "WAGO 249-116 Endklammer", width_mm: 6.0, marker: false },
  [PART_TERMINAL]: { label: "WAGO 2002-1671 2-Leiter-Trenn- und Messklemme", width_mm: 5.2, marker: true },
  [PART_PLATE]: { label: "WAGO 2002-1692 Abschluss- und Zwischenplatte", width_mm: 1.0, marker: false },
};
export const DEFAULT_CONTROL_LABELS: readonly string[] = ["UNSM", "60%", "30%", "0%", "UStve", "Stve"];
/** Never grün-gelb (PE), hellblau/blau (N), single grün/gelb. */
export const WIRE_COLOURS: readonly WireColour[] = ["braun", "schwarz", "grau", "rot", "violett", "weiß", "orange", "rosa"];
export const WIRE_COLOUR_STYLE: Readonly<Record<WireColour, string>> = {
  braun: "#8a5527", schwarz: "#1c2024", grau: "#8b929b", rot: "#d0312d",
  violett: "#7547c9", weiß: "#ffffff", orange: "#f08a24", rosa: "#f2a7c3",
};
/** weiß and rosa are drawn with a 1 px outline in this colour. */
export const WIRE_OUTLINE_COLOUR = "#6b7a8c";
export const OUTLINED_WIRE_COLOURS: ReadonlySet<WireColour> = new Set<WireColour>(["weiß", "rosa"]);
export const DEFAULT_WIRE_MM2: WireMm2 = 2.5;
export const WIRE_MM2_CHOICES: readonly WireMm2[] = [1.5, 2.5];
export const DEFAULT_LABEL_MATERIAL: TubeMaterialId = "wago-211-502";
export const TUBE_MATERIAL_IDS: ReadonlySet<TubeMaterialId> = new Set<TubeMaterialId>(["wago-211-501", "wago-211-502"]);
export const MAX_CONTROL_TERMINALS = 12;
/** Code points. */
export const CONTROL_LABEL_MAX = 12;
export const LENGTH_MIN_M = 0.5;
export const LENGTH_MAX_M = 20;
/** 300 mm per wire (150 per end). */
export const WIRE_RESERVE_DM = 3;
/** Only for meter_3p (Hager: ≥ 30 cm free cable). */
export const NETWORK_RESERVE_MM = 300;
export const NETWORK_LEADS: readonly (readonly [number, string])[] = [
  [400, "ZZ45WAN040"], [1000, "ZZ45WAN100"], [1500, "ZZ45WAN150"], [2000, "ZZ45WAN200"], [5000, "ZZ45WAN500"],
];
/** One sleeve; ungeprüft. */
export const WIRE_LABEL_PIECE_MM = 15.0;
export const WIRE_LABEL_MAX_DOTS = 48;

const METER_FAMILIES: ReadonlySet<string> = new Set(["meter_ehz", "meter_3p"]);
const KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;
const TERMINAL_ID = /^t[0-9]{1,3}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** "Braun": a colour as the UI's options show it. */
export function wireColourLabel(colour: WireColour): string {
  return colour.charAt(0).toUpperCase() + colour.slice(1);
}

// ── Parser (§2.1) ────────────────────────────────────────────────────────────

const isNumber = (value: unknown): value is number => typeof value === "number";
const isWireColour = (value: unknown): value is WireColour => typeof value === "string" && (WIRE_COLOURS as readonly string[]).includes(value);
const isTube = (value: unknown): value is TubeMaterialId => typeof value === "string" && TUBE_MATERIAL_IDS.has(value as TubeMaterialId);

/** Rule 8 of §2.1: a finite number, `round1` half up, kept in [0,5; 20]; else null. */
export function parseLengthM(value: unknown): number | null {
  if (!isNumber(value) || !Number.isFinite(value) || Math.abs(value) > 1e9) return null;
  const rounded = Math.floor(value * 10 + 0.5) / 10;
  return rounded >= LENGTH_MIN_M && rounded <= LENGTH_MAX_M ? rounded : null;
}

/** Step 4 of §2.1: control characters out, outer U+0020 off, cut to 12 code points; not a string → "". */
export function normaliseControlLabel(value: unknown): string {
  const text = typeof value === "string" ? value.replace(CONTROL_CHARS, "") : "";
  return Array.from(text.replace(/^ +| +$/g, "")).slice(0, CONTROL_LABEL_MAX).join("");
}

/** Step 3: valid unique ids kept, the rest get the smallest free `t<n>` in list order. */
function terminalIds(entries: readonly Record<string, unknown>[]): string[] {
  const kept: (string | null)[] = [];
  for (const entry of entries) {
    const value = entry.id;
    const ok = typeof value === "string" && TERMINAL_ID.test(value) && !kept.includes(value);
    kept.push(ok ? (value as string) : null);
  }
  const taken = new Set(kept.filter((value): value is string => value !== null));
  return kept.map((value) => {
    if (value !== null) return value;
    let n = 1;
    while (taken.has(`t${n}`)) n += 1;
    taken.add(`t${n}`);
    return `t${n}`;
  });
}

/**
 * `enclosure.control_block` as far as it makes sense; never throws (§2.1).
 * Every derivation reads the block through this, never the raw value.
 */
export function parseControlBlock(value: unknown): ControlBlock | null {
  if (!isRecord(value)) return null;
  const raw = value.terminals;
  const entries = (Array.isArray(raw) ? raw : []).filter(isRecord).slice(0, MAX_CONTROL_TERMINALS);
  const ids = terminalIds(entries);
  const terminals: ControlTerminal[] = entries.map((entry, i) => ({
    id: ids[i],
    label: normaliseControlLabel(entry.label),
    color: isWireColour(entry.color) ? entry.color : WIRE_COLOURS[i % 8],
  }));
  const { rail, wire_mm2: mm2 } = value;
  return {
    terminals,
    rail: typeof rail === "string" && KEY_PATTERN.test(rail) ? rail : null,
    wire_mm2: mm2 === 1.5 || mm2 === 2.5 ? mm2 : DEFAULT_WIRE_MM2,
    wire_length_m: parseLengthM(value.wire_length_m),
    label_material: isTube(value.label_material) ? value.label_material : DEFAULT_LABEL_MATERIAL,
    off: value.off === true,
  };
}

/** What `placeModule` seeds: t1…t6, the BDEW labels, the first six colours. */
export function defaultControlBlock(): ControlBlock {
  return {
    terminals: DEFAULT_CONTROL_LABELS.map((label, i) => ({ id: `t${i + 1}`, label, color: WIRE_COLOURS[i] })),
    rail: null,
    wire_mm2: DEFAULT_WIRE_MM2,
    wire_length_m: null,
    label_material: DEFAULT_LABEL_MATERIAL,
    off: false,
  };
}

export function storedBlock(doc: unknown): ControlBlock | null {
  const enclosure = enclosureOf(doc);
  return enclosure ? parseControlBlock(enclosure.control_block) : null;
}

/** The parsed block: read from the document for DERIVE, else as given. */
export function resolveBlock(doc: unknown, block: BlockArg): ControlBlock | null {
  return block === DERIVE ? storedBlock(doc) : block;
}

// ── Carrier (§3.1) ───────────────────────────────────────────────────────────

export interface Carrier {
  module: EnclosureModule;
  spec: ModuleSpec;
  /** Position among the board's readable modules (the tie-break). */
  index: number;
  id: string;
  /** 0-based cabinet field of the module. */
  field: number;
  family: ModuleFamily;
  reserve: boolean;
}

/** Meter-family modules in (field, unit, list index) order — never `modulesInOrder`, which breaks ties by id. */
export function meterCandidates(doc: unknown, index: CatalogIndex): Carrier[] {
  const found: Carrier[] = [];
  modulesOf(doc).forEach((module, position) => {
    const spec = moduleSpec(module, index);
    if (!spec || !METER_FAMILIES.has(spec.family)) return;
    found.push({
      module, spec, index: position, id: ident(module.id), field: asInt(module.field),
      family: spec.family, reserve: spec.reserve_field === true,
    });
  });
  const unit = (carrier: Carrier) => asInt(carrier.module.unit);
  return found.sort((a, b) => a.field - b.field || unit(a) - unit(b) || a.index - b.index);
}

/** The first candidate that is no reserve field, else the first; null without one. */
export function controlCarrier(doc: unknown, index: CatalogIndex): Carrier | null {
  const candidates = meterCandidates(doc, index);
  return candidates.find((candidate) => !candidate.reserve) ?? candidates[0] ?? null;
}

// ── Scene points (§3.4) ──────────────────────────────────────────────────────

export type Point = readonly [number, number];

/** The cabinet raster, with the spec model's defaults for an unknown code. */
export interface Grid {
  margin: number;
  fieldWidth: number;
  unit: number;
  unitsPerField: number;
  heightMm: number;
}

export function gridOf(doc: unknown, index: CatalogIndex): Grid {
  const code = enclosureOf(doc)?.code;
  const spec = typeof code === "string" ? index.enclosure(code) : null;
  return {
    margin: asInt(spec?.margin_mm, 25),
    fieldWidth: asInt(spec?.field_width_mm, 250),
    unit: asInt(spec?.unit_mm, 150),
    unitsPerField: asInt(spec?.units_per_field, 1),
    heightMm: asInt(spec?.height_mm),
  };
}

export function zoneOrigin(grid: Grid, module: EnclosureModule, zone: ZoneSpec): Point {
  return [grid.margin + zoneField(module, zone) * grid.fieldWidth, grid.margin + (asInt(module.unit) + asInt(zone.unit)) * grid.unit];
}

export function railLeft(grid: Grid, module: EnclosureModule, zone: ZoneSpec, rail: RailSpec): number {
  return zoneOrigin(grid, module, zone)[0] + (grid.fieldWidth - asInt(rail.ple, 1) * MODULE_WIDTH_MM) / 2;
}

export function railCentreY(grid: Grid, module: EnclosureModule, zone: ZoneSpec, rail: RailSpec): number {
  return zoneOrigin(grid, module, zone)[1] + asInt(rail.unit) * grid.unit + grid.unit / 2;
}

export function railCentre(grid: Grid, module: EnclosureModule, zone: ZoneSpec, rail: RailSpec): Point {
  return [railLeft(grid, module, zone, rail) + (asInt(rail.ple, 1) * MODULE_WIDTH_MM) / 2, railCentreY(grid, module, zone, rail)];
}

/** Centre of place `k` of a ZF zone, in `_meter_boxes`' expression order. */
export function meterPlace(grid: Grid, module: EnclosureModule, zone: ZoneSpec, k: number): Point {
  const [zoneX, zoneY] = zoneOrigin(grid, module, zone);
  const places = Math.max(1, asInt(zone.meter_places, 1));
  const zoneH = asInt(zone.units, 1) * grid.unit;
  if (zone.meter_type === "3punkt") {
    const cell = zoneH / places;
    return [zoneX + grid.fieldWidth / 2, zoneY + k * cell + cell / 2];
  }
  const cell = grid.fieldWidth / places;
  return [zoneX + k * cell + cell / 2, zoneY + zoneH / 2];
}

/** The zone's first non-retired rail in spec order. */
export function firstRail(zone: ZoneSpec): RailSpec | null {
  return zone.rails.find((rail) => !rail.retired) ?? null;
}

export function firstMeterZone(spec: ModuleSpec): ZoneSpec | null {
  return meterZones(spec)[0] ?? null;
}

// ── Placement (§3.2) ─────────────────────────────────────────────────────────

export interface ControlRailCandidate {
  zone: ZoneSpec;
  rail: RailSpec;
  /** 1-based place of the rail in its zone (`default_rail_label`). */
  position: number;
  rowId: string | null;
  devicesMm: number;
  capacityMm: number;
}

/** The placement with unrounded numbers; `placeControlBlock` is its twinned output. */
export interface BlockLayout {
  carrier: Carrier;
  rail: ControlRailCandidate;
  railX: number;
  railY: number;
  offsetMm: number;
  widthMm: number;
  overflow: boolean;
  parts: ControlBlockPart[];
  terminals: ControlTerminal[];
  /** 0-based field of the AAR zone. */
  field: number;
  /** "F1 · AAR 1". */
  railTitle: string;
}

/** The block's centre on its rail: where the control wires leave. */
export function blockPoint(layout: BlockLayout): Point {
  return [layout.railX + layout.offsetMm + layout.widthMm / 2, layout.railY];
}

/** The carrier's AAR DIN rails, top → bottom by (zone unit + rail unit), ties in spec order. */
export function candidateRails(doc: unknown, index: CatalogIndex, carrier: Carrier): ControlRailCandidate[] {
  const linked = linkedRails(doc, index);
  const rows = new Map(rowsOf(doc).map((row) => [row.id, row] as const));
  const names = moduleRails(carrier.module);
  const found: { top: number; order: number; candidate: ControlRailCandidate }[] = [];
  for (const zone of carrier.spec.zones) {
    zone.rails.forEach((rail, i) => {
      if (zone.type !== "AAR" || rail.retired || rail.mount !== "rail") return;
      const key = String(rail.key);
      const named = names.get(key) ?? null;
      const link = named !== null ? linked.get(named) : undefined;
      const rowId = link && ident(link.module.id) === carrier.id && String(link.rail.key) === key ? named : null;
      let devicesMm = 0;
      for (const device of rowDevices(rowId !== null ? rows.get(rowId) : undefined)) devicesMm += enclosureDeviceWidthMm(device, rail);
      const candidate = { zone, rail, position: i + 1, rowId, devicesMm, capacityMm: asInt(rail.ple, 1) * MODULE_WIDTH_MM };
      found.push({ top: asInt(zone.unit) + asInt(rail.unit), order: found.length, candidate });
    });
  }
  return found.sort((a, b) => a.top - b.top || a.order - b.order).map((entry) => entry.candidate);
}

/** 249-116 | n × 2002-1671 | 2002-1692 | 249-116, offsets relative to the block; and the total width. */
export function blockParts(terminals: readonly ControlTerminal[]): { parts: ControlBlockPart[]; widthMm: number } {
  const sequence: [ControlPartId, ControlTerminal | null, number | null][] = [
    [PART_END_STOP, null, null],
    ...terminals.map((terminal, i): [ControlPartId, ControlTerminal, number] => [PART_TERMINAL, terminal, i + 1]),
    [PART_PLATE, null, null],
    [PART_END_STOP, null, null],
  ];
  let cursor = 0;
  const parts: ControlBlockPart[] = [];
  for (const [partId, terminal, position] of sequence) {
    const width = CONTROL_PARTS[partId].width_mm;
    parts.push({
      partId, terminalId: terminal?.id ?? null, label: terminal?.label ?? null, color: terminal?.color ?? null,
      position, offsetMm: cursor, widthMm: width,
    });
    cursor += width;
  }
  return { parts, widthMm: cursor };
}

function chooseRail(candidates: ControlRailCandidate[], stored: string | null, blockMm: number): ControlRailCandidate {
  const pinned = stored !== null ? candidates.find((candidate) => String(candidate.rail.key) === stored) : undefined;
  if (pinned) return pinned;
  return candidates.find((c) => c.devicesMm + blockMm <= c.capacityMm + TOLERANCE_MM) ?? candidates[0];
}

/** The placement with unrounded numbers; null when there is nothing to place. */
export function controlBlockLayout(doc: unknown, index: CatalogIndex, block: BlockArg = DERIVE): BlockLayout | null {
  const parsed = resolveBlock(doc, block);
  if (!parsed || parsed.off || parsed.terminals.length === 0) return null;
  const carrier = controlCarrier(doc, index);
  if (!carrier) return null;
  const candidates = candidateRails(doc, index, carrier);
  if (candidates.length === 0) return null;
  const { parts, widthMm } = blockParts(parsed.terminals);
  const chosen = chooseRail(candidates, parsed.rail, widthMm);
  const grid = gridOf(doc, index);
  return {
    carrier,
    rail: chosen,
    railX: railLeft(grid, carrier.module, chosen.zone, chosen.rail),
    railY: railCentreY(grid, carrier.module, chosen.zone, chosen.rail),
    offsetMm: Math.max(chosen.capacityMm - widthMm, chosen.devicesMm),
    widthMm,
    overflow: chosen.devicesMm + widthMm > chosen.capacityMm + TOLERANCE_MM,
    parts,
    terminals: parsed.terminals,
    field: zoneField(carrier.module, chosen.zone),
    railTitle: railTitle(carrier.module, chosen.zone, chosen.position),
  };
}

/** §3.2's output (camelCase, millimetres `round1`); null when nothing is placed. */
export function placeControlBlock(doc: unknown, index: CatalogIndex, block: BlockArg = DERIVE): ControlBlockPlacement | null {
  const layout = controlBlockLayout(doc, index, block);
  return layout ? blockPlacement(layout) : null;
}

/** A layout as §3.2 outputs it (Python `BlockLayout.as_dict`). */
export function blockPlacement(layout: BlockLayout): ControlBlockPlacement {
  return {
    moduleId: layout.carrier.id,
    railKey: String(layout.rail.rail.key),
    field: layout.field,
    railTitle: layout.railTitle,
    railX: round1(layout.railX),
    railY: round1(layout.railY),
    offsetMm: round1(layout.offsetMm),
    widthMm: round1(layout.widthMm),
    devicesMm: round1(layout.rail.devicesMm),
    capacityMm: round1(layout.rail.capacityMm),
    overflow: layout.overflow,
    parts: layout.parts.map((part) => ({ ...part, offsetMm: round1(part.offsetMm), widthMm: round1(part.widthMm) })),
  };
}

/**
 * What the block takes of one rail (TS only, §3.2 "Occupancy"): its
 * unrounded width when it sits on `moduleId`/`railKey`, else 0. The rail
 * sheets and the drop measure add it to the devices.
 */
export function controlBlockMmOn(doc: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string): number {
  const layout = controlBlockLayout(doc, index);
  return layout && layout.carrier.id === moduleId && String(layout.rail.rail.key) === railKey ? layout.widthMm : 0;
}
