/**
 * Cabinet preparation: what every Zählerschrank needs besides its modules
 * (docs/PANEL_ENCLOSURE_R4.md §2.2, §3.3–§3.5) — the TypeScript twin of
 * `apps/api/app/services/panel_enclosure_prep.py`, pinned on
 * `enclosureFixtures.json` (key `prep` per board, tables `prep_parse`,
 * `infeed_parse`, `fuse_parse`). The Materialliste reads the Python twin
 * server-side only; the editor shows this one live.
 *
 * Everything here is **derived** from the board (R4-4); each group can be
 * overridden per board (`enclosure.prep`, read through `parsePrep`). In this
 * fixed order: (a) Spannungsversorgung RfZ/APZ (Hager ZY…), (b) Einspeisung
 * (K96ESA5 or Sammelschienenklemmen), (b2) PEN-Aufteilung, (c)
 * Sammelschienenverbinder ZZ55SAVE, (d) Netzwerkleitung ZZ45WAN…, (e) the
 * §14a block, its wires and the Lüsterklemme. An item an override switches
 * off is still returned, with `qty` 0 and `suppressed`, so the editor can
 * strike it through.
 *
 * Busbar zones have a **role** (R4-11): `main` (unmetered: every NAR, the SAS
 * of a communication field, a SAS that holds an SLS) or `customer` (every
 * other SAS, after the meter). Joints and the infeed never cross roles: a
 * connector between them would bridge around the meter. A customer zone also
 * knows the meter(s) feeding its module (`enclosureBusbarMeters`): two
 * customer zones of different meters are never joined, and a joint where a
 * side's meter is unknown is planned unverified ("Zähler prüfen").
 *
 * Runs are measured in scene millimetres, vertical first then horizontal, on
 * the unrounded points; `lengthMm` is rounded once and everything downstream
 * (wire metres, the network fallback) uses that rounded value.
 */

import { parseCableSection, parseFuseAmps } from "./cableSectionParse";
import type { CatalogIndex } from "./enclosureCatalog";
import { edgeTrimmed } from "./edgeTrim";
import { differentMeters, feedIndex, meterUnknown, moduleMeters, type FeedIndex } from "./enclosureBusbarMeters";
import {
  CONTROL_PARTS,
  DERIVE,
  NETWORK_LEADS,
  NETWORK_RESERVE_MM,
  PART_END_STOP,
  PART_PLATE,
  PART_TERMINAL,
  WIRE_RESERVE_DM,
  blockPoint,
  controlBlockLayout,
  controlCarrier,
  firstMeterZone,
  firstRail,
  gridOf,
  meterPlace,
  parseLengthM,
  railCentre,
  railCentreY,
  railLeft,
  resolveBlock,
  type BlockArg,
  type BlockLayout,
  type Carrier,
  type Grid,
  type Point,
} from "./enclosureControlBlock";
import { formatMmText } from "./enclosureGeometry";
import {
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
  type LinkedRail,
  type Loose,
} from "./enclosureTerminals";
import { DEVICE_CATALOG } from "./schaltplanDevices";
import type {
  CabinetPrep,
  CableSection,
  ControlBlock,
  EnclosureModule,
  ModuleSpec,
  PrepGroup,
  PrepInfeed,
  PrepItem,
  PrepOverrides,
  PrepRun,
  PrepRunKind,
  RailSpec,
  ZoneSpec,
  ZoneType,
} from "../types/panelEnclosure";
import type { PanelDevice, PanelRow } from "../types/schaltplan";

export { parseFuseAmps };

export const ROLE_MAIN = "main";
export const ROLE_CUSTOMER = "customer";
export type BusbarRole = typeof ROLE_MAIN | typeof ROLE_CUSTOMER;
export const GROUP_SUPPLY: PrepGroup = "supply";
export const GROUP_BUSBAR: PrepGroup = "busbar";
export const GROUP_NETWORK: PrepGroup = "network";
export const GROUP_CONTROL: PrepGroup = "control";
export const PREP_CHOICES = {
  supply: ["auto", "SA", "LS", "SI", "off"],
  infeed: ["auto", "K96ESA5", "clamps", "off"],
  joints: ["auto", "off"],
  network: ["auto", "off"],
} as const satisfies Record<Exclude<keyof PrepOverrides, "network_m">, readonly string[]>;
export const DEFAULT_PREP: Readonly<PrepOverrides> = { supply: "auto", infeed: "auto", joints: "auto", network: "auto", network_m: null };
/** An LS up to 10 A may tap the NAR / sit on the RfZ (Spannungsabgriff). */
export const SMALL_TAP_A = 10;
/** The SABO sits this far right of the NAR busbar's left end. */
export const SABO_OFFSET_MM = 30;
export const K96ESA5_MAX_MM2 = 25;
export const K96ESA5_MAX_FUSE_A = 100;
export const CLAMP_MAX_MM2 = 185;
const HEIGHT_DIGITS: Readonly<Record<number, string>> = { 1100: "3", 1400: "5" };
/**
 * Hager Bestellhilfe 20DE0173, keyed "family|cabinet height|APZ top/bottom":
 * the lead for 0, 1, 2, 3 fields between the APZ and the meter field.
 */
export const HAGER_NETWORK_TABLE: Readonly<Record<string, readonly [string, string, string, string]>> = {
  "meter_ehz|1100|bottom": ["ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200"],
  "meter_ehz|1100|top": ["ZZ45WAN040", "ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150"],
  "meter_3p|1100|bottom": ["ZZ45WAN100", "ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200"],
  "meter_3p|1100|top": ["ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN150", "ZZ45WAN200"],
  "meter_3p|1400|bottom": ["ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN200", "ZZ45WAN200"],
  "meter_3p|1400|top": ["ZZ45WAN100", "ZZ45WAN150", "ZZ45WAN150", "ZZ45WAN200"],
};
const LEAD_MM = new Map(NETWORK_LEADS.map(([length, code]) => [code, length] as const));
/**
 * (min mm², max mm², article, label) on a 12×5 mm busbar, first fit wins
 * (hager.com, 2026-10-26: K96H takes 25–95 mm² on 12×5 mm; K96C 2,5–35 mm²
 * Cu is only reached below 25 mm²).
 */
type Clamp = readonly [number, number, string, string];
const CLAMPS_CU: readonly Clamp[] = [
  [25, 70, "K96F", "Sammelschienenklemme 25–70 mm² für 12×5 mm"],
  [25, 95, "K96H", "Sammelschienenklemme 25–95 mm² für 12×5 mm"],
  [50, 150, "K96K", "Sammelschienenklemme 50–150 mm² für 12×5 mm"],
  [50, 185, "KS18D", "Sammelschienenklemme 50–185 mm², Al/Cu, für 12×5 mm"],
  [2.5, 35, "K96C", "Sammelschienenklemme 2,5–35 mm² für 12×5 mm"],
];
const CLAMPS_AL: readonly Clamp[] = [
  [10, 50, "K96N", "Sammelschienenklemme 10–50 mm², Al/Cu"],
  [50, 185, "KS18D", "Sammelschienenklemme 50–185 mm², Al/Cu, für 12×5 mm"],
];
type SupplyVariant = "SA" | "LS" | "SI";
const SUPPLY_DEVICE: Readonly<Record<SupplyVariant, string>> = { SA: "SABO 1,6 A", LS: "LS 6 A", SI: "Sicherungsbox 1 A" };
const SUPPLY_PART: Readonly<Record<SupplyVariant, string>> = { SA: "SABO 1,6 A", LS: "Sammelschienen-LS 6 A", SI: "Sicherungsbox 1 A im RfZ" };

// ── Parsers and small readers, shared with the rules ─────────────────────────

/** §3.5's infeed parser: the shared cable parser. */
export function parseInfeed(text: unknown): CableSection {
  return parseCableSection(text);
}

const choice = <T extends string>(value: unknown, choices: readonly T[]): T | "auto" =>
  typeof value === "string" && (choices as readonly string[]).includes(value) ? (value as T) : "auto";

/** `enclosure.prep` (§2.2): unknown values are `auto` / null; never throws. */
export function parsePrep(value: unknown): PrepOverrides | null {
  if (!isRecord(value)) return null;
  return {
    supply: choice(value.supply, PREP_CHOICES.supply),
    infeed: choice(value.infeed, PREP_CHOICES.infeed),
    joints: choice(value.joints, PREP_CHOICES.joints),
    network: choice(value.network, PREP_CHOICES.network),
    network_m: parseLengthM(value.network_m),
  };
}

/** `enclosure.prep` parsed; absent ≡ every group `auto`. */
export function prepOverrides(doc: unknown): PrepOverrides {
  const enclosure = enclosureOf(doc);
  return (enclosure ? parsePrep(enclosure.prep) : null) ?? { ...DEFAULT_PREP };
}

const trimmed = edgeTrimmed;

/** The last number in a rating ("B16" → 16, "C 32A" → 32, "0,5 A" → 0.5); null when there is none. */
export function ratingValue(rating: unknown): number | null {
  const matches = trimmed(rating).match(/\d+(?:[.,]\d+)?/g);
  return matches ? Number(matches[matches.length - 1].replace(",", ".")) : null;
}

const kindOf = (device: Pick<PanelDevice, "kind">): string => String(device.kind || "");

/** An LS up to 10 A: the Spannungsabgriff the NAR and the RfZ allow. */
export function isSmallTap(device: Pick<PanelDevice, "kind" | "rating">): boolean {
  const amps = ratingValue(device.rating);
  return kindOf(device) === "mcb" && amps !== null && amps <= SMALL_TAP_A;
}

/** BMK, else the catalogue's short name, else "?" for a kind the catalogue does not know. */
export function deviceBmk(device: Pick<PanelDevice, "kind" | "designation">): string {
  const kind = kindOf(device);
  const entry = Object.prototype.hasOwnProperty.call(DEVICE_CATALOG, kind) ? DEVICE_CATALOG[kind as keyof typeof DEVICE_CATALOG] : null;
  return trimmed(device.designation) || (entry ? entry.short : "?");
}

// ── Zones of the board ───────────────────────────────────────────────────────

export interface PlacedZone {
  module: EnclosureModule;
  spec: ModuleSpec;
  /** Position among the board's readable modules. */
  index: number;
  zone: ZoneSpec;
  moduleId: string;
  /** 0-based cabinet field. */
  field: number;
  /** Absolute start unit and end unit (exclusive). */
  start: number;
  end: number;
}

/** Zones of one type on the board, by (field, start unit, module index, spec order). */
export function placedZones(doc: unknown, index: CatalogIndex, type: ZoneType): PlacedZone[] {
  const found: { order: number; placed: PlacedZone }[] = [];
  modulesOf(doc).forEach((module, position) => {
    const spec = moduleSpec(module, index);
    spec?.zones.forEach((zone, order) => {
      if (zone.type !== type) return;
      const start = asInt(module.unit) + asInt(zone.unit);
      const end = start + asInt(zone.units, 1);
      found.push({ order, placed: { module, spec, index: position, zone, moduleId: ident(module.id), field: zoneField(module, zone), start, end } });
    });
  });
  const key = ({ order, placed }: (typeof found)[number]) => [placed.field, placed.start, placed.index, order];
  return found.sort((a, b) => compareNumbers(key(a), key(b))).map((entry) => entry.placed);
}

function compareNumbers(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The first APZ zone (by field, unit) that has a rail to measure from. */
export function firstApz(doc: unknown, index: CatalogIndex): PlacedZone | null {
  return placedZones(doc, index, "APZ").find((placed) => firstRail(placed.zone) !== null) ?? null;
}

// ── Busbar zones, roles, joints and runs ─────────────────────────────────────

export interface BusbarZone extends PlacedZone {
  role: BusbarRole;
  /** Customer zones: the meter modules feeding the module, sorted (empty = unknown); main zones: empty. */
  meters: readonly string[];
}

/** The row on a module's rail, when that link is the live one (`linked_rows`). */
function liveRow(linked: Map<string, LinkedRail>, rows: Map<string, PanelRow>, module: EnclosureModule, key: string): PanelRow | null {
  const rowId = moduleRails(module).get(key);
  const link = rowId !== undefined ? linked.get(rowId) : undefined;
  if (!link || ident(link.module.id) !== ident(module.id) || String(link.rail.key) !== key) return null;
  return rows.get(rowId!) ?? null;
}

const rowMap = (doc: unknown): Map<string, PanelRow> => new Map(rowsOf(doc).map((row) => [row.id, row] as const));

/** Every NAR/SAS zone with a busbar rail, with its role (R4-11). */
export function busbarZones(doc: unknown, index: CatalogIndex): BusbarZone[] {
  const linked = linkedRails(doc, index);
  const rows = rowMap(doc);
  const out: BusbarZone[] = [];
  let feeds: FeedIndex | null = null;
  for (const type of ["NAR", "SAS"] as const) {
    for (const placed of placedZones(doc, index, type)) {
      const busbar = placed.zone.rails.find((rail) => rail.mount === "busbar");
      if (!busbar) continue;
      const row = liveRow(linked, rows, placed.module, String(busbar.key));
      const sls = rowDevices(row ?? undefined).some((device) => kindOf(device) === "sls");
      const main = type === "NAR" || placed.spec.family === "communication" || sls;
      if (main) {
        out.push({ ...placed, role: ROLE_MAIN, meters: [] });
        continue;
      }
      feeds = feeds ?? feedIndex(doc, index);
      out.push({ ...placed, role: ROLE_CUSTOMER, meters: moduleMeters(placed.module, feeds) });
    }
  }
  return out.sort((a, b) => a.field - b.field || a.start - b.start || a.index - b.index);
}

export const spansOverlap = (a: PlacedZone, b: PlacedZone): boolean => a.start < b.end && b.start < a.end;

/** Two customer zones fed through different meters. */
export const otherMeters = (a: BusbarZone, b: BusbarZone): boolean =>
  a.role === ROLE_CUSTOMER && b.role === ROLE_CUSTOMER && differentMeters(a.meters, b.meters);

/** Two customer zones where a side's meter is unknown. */
const uncheckedMeter = (a: BusbarZone, b: BusbarZone): boolean =>
  a.role === ROLE_CUSTOMER && b.role === ROLE_CUSTOMER && meterUnknown(a.meters, b.meters);

/** Neighbouring fields, different modules, same role, spans overlapping — and, for customer zones, not of different meters. */
export function joined(a: BusbarZone, b: BusbarZone): boolean {
  return Math.abs(a.field - b.field) === 1 && a.moduleId !== b.moduleId && a.role === b.role && spansOverlap(a, b)
    && !otherMeters(a, b);
}

/** [left, right] fields of every joined customer pair with a meter unknown, once each, by left field. */
export function uncheckedPairs(zones: readonly BusbarZone[]): [number, number][] {
  const lefts = new Set<number>();
  for (const a of zones) for (const b of zones) if (b.field === a.field + 1 && joined(a, b) && uncheckedMeter(a, b)) lefts.add(a.field);
  return [...lefts].sort((x, y) => x - y).map((left) => [left, left + 1]);
}

export interface JointPair {
  role: BusbarRole;
  /** 0-based fields, right = left + 1. */
  left: number;
  right: number;
}

/** Every joined field pair, once each, by (left, right, main first). */
export function jointPairs(zones: readonly BusbarZone[]): JointPair[] {
  const pairs = new Map<string, JointPair>();
  for (const a of zones) {
    for (const b of zones) {
      if (b.field === a.field + 1 && joined(a, b)) pairs.set(`${a.role}|${a.field}`, { role: a.role, left: a.field, right: b.field });
    }
  }
  const rank = (pair: JointPair) => [pair.left, pair.right, pair.role === ROLE_MAIN ? 0 : 1];
  return [...pairs.values()].sort((a, b) => compareNumbers(rank(a), rank(b)));
}

/** Connected components of one role's zones under `joined`, by first field. */
export function busbarRuns(zones: readonly BusbarZone[], role: BusbarRole): BusbarZone[][] {
  const members = zones.filter((zone) => zone.role === role);
  const seen = new Set<number>();
  const runs: BusbarZone[][] = [];
  members.forEach((_, start) => {
    if (seen.has(start)) return;
    const component: number[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      members.forEach((candidate, other) => {
        if (!seen.has(other) && joined(members[current], candidate)) {
          seen.add(other);
          queue.push(other);
        }
      });
    }
    runs.push([...component].sort((a, b) => a - b).map((i) => members[i]));
  });
  const first = (run: BusbarZone[]) => [Math.min(...run.map((zone) => zone.field)), run[0].start];
  return runs.sort((a, b) => compareNumbers(first(a), first(b)));
}

const runField = (run: readonly BusbarZone[]): number => Math.min(...run.map((zone) => zone.field));

// ── Runs (§3.4) ──────────────────────────────────────────────────────────────

/** A lead: rounded ends, vertical first then horizontal, repeated points dropped; length from the unrounded ends. */
export function makeRun(kind: PrepRunKind, start: Point, end: Point, label: string): PrepRun {
  const a: [number, number] = [round1(start[0]), round1(start[1])];
  const b: [number, number] = [round1(end[0]), round1(end[1])];
  const points: [number, number][] = [];
  for (const point of [a, [a[0], b[1]] as [number, number], b]) {
    const last = points[points.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) points.push(point);
  }
  let length = Math.abs(end[0] - start[0]);
  length += Math.abs(end[1] - start[1]);
  return { kind, from: a, to: b, points, label, lengthMm: round1(length) };
}

/** Where a lead ends: a point and what the reason calls it. */
export interface End {
  point: Point;
  name: "RfZ" | "Zählerplatz" | "APZ";
  /** 0-based. */
  field: number;
}

function zoneEnd(grid: Grid, placed: PlacedZone, name: End["name"]): End | null {
  const rail = firstRail(placed.zone);
  return rail ? { point: railCentre(grid, placed.module, placed.zone, rail), name, field: placed.field } : null;
}

function meterPlaceEnd(grid: Grid, carrier: Carrier): End | null {
  const zone = firstMeterZone(carrier.spec);
  return zone ? { point: meterPlace(grid, carrier.module, zone, 0), name: "Zählerplatz", field: zoneField(carrier.module, zone) } : null;
}

function carrierRfz(doc: unknown, index: CatalogIndex, grid: Grid, carrier: Carrier): End | null {
  const placed = placedZones(doc, index, "RFZ").find((zone) => zone.moduleId === carrier.id && firstRail(zone.zone) !== null);
  return placed ? zoneEnd(grid, placed, "RfZ") : null;
}

/** eHZ: the carrier's first RfZ rail; 3-Punkt: the first APZ of the cabinet (§3.4). */
export function controlTarget(doc: unknown, index: CatalogIndex, carrier: Carrier | null): End | null {
  if (!carrier) return null;
  const grid = gridOf(doc, index);
  if (carrier.family === "meter_ehz") return carrierRfz(doc, index, grid, carrier);
  const apz = firstApz(doc, index);
  return apz ? zoneEnd(grid, apz, "APZ") : null;
}

/** §3.3 (a): eHZ → its RfZ; 3-Punkt → the first RfZ of a non-meter module, else meter place 0. */
export function supplyRfzEnd(doc: unknown, index: CatalogIndex, grid: Grid, carrier: Carrier): End | null {
  if (carrier.family === "meter_ehz") return carrierRfz(doc, index, grid, carrier) ?? meterPlaceEnd(grid, carrier);
  const placed = placedZones(doc, index, "RFZ").find(
    (zone) => zone.spec.family !== "meter_ehz" && zone.spec.family !== "meter_3p" && firstRail(zone.zone) !== null,
  );
  return (placed ? zoneEnd(grid, placed, "RfZ") : null) ?? meterPlaceEnd(grid, carrier);
}

/** The SABO: on the carrier's first NAR busbar, 30 mm in from its left end. */
export function saboPoint(grid: Grid, carrier: Carrier): Point | null {
  for (const zone of carrier.spec.zones) {
    if (zone.type !== "NAR") continue;
    const rail = zone.rails.find((candidate) => candidate.mount === "busbar");
    if (rail) return [railLeft(grid, carrier.module, zone, rail) + SABO_OFFSET_MM, railCentreY(grid, carrier.module, zone, rail)];
  }
  return null;
}

// ── Items ────────────────────────────────────────────────────────────────────

interface ItemOptions {
  group: PrepGroup;
  verified: boolean;
  unit?: PrepItem["unit"];
  override?: string | null;
  suppressed?: boolean;
}

function item(key: string, articleNo: string | null, label: string, qty: number, reason: string, options: ItemOptions): PrepItem {
  const suppressed = options.suppressed ?? false;
  return {
    key, articleNo, label, qty: suppressed ? 0 : qty, unit: options.unit ?? "Stk", reason,
    verified: options.verified, group: options.group, override: options.override ?? null, suppressed,
  };
}

/** What the findings read besides the items (the Python `facts`). */
export interface PrepFacts {
  /** The cabinet height without a Hager kit. */
  supplyHeight?: number;
  /** (BMK, rail title) of the tap that suppressed the kit. */
  supplyExisting?: readonly [string, string] | null;
  infeed?: PrepInfeed;
  /** The parsed cross-section above 185 mm². */
  infeedSize?: number | null;
  /** A known cross-section no clamp holds (Cu below 2,5 mm², Al below 10 mm²). */
  infeedSmall?: { mm2: number; aluminium: boolean };
  /** 0-based field of the NAR whose PEN is split. */
  penField?: number;
}

interface Part {
  items: PrepItem[];
  runs: PrepRun[];
  facts: PrepFacts;
}

const part = (items: PrepItem[] = [], runs: PrepRun[] = [], facts: PrepFacts = {}): Part => ({ items, runs, facts });

interface Board {
  doc: unknown;
  index: CatalogIndex;
  grid: Grid;
  overrides: PrepOverrides;
  carrier: Carrier | null;
  apz: PlacedZone | null;
  zones: BusbarZone[];
  supply: Loose;
}

const fieldNo = (field: number): number => field + 1;

function endsText(ends: readonly End[]): string {
  const names = ends.map((end) => `${end.name} Feld ${fieldNo(end.field)}`);
  return names.length > 0 ? `, Leitungen zum ${names.join(" und ")}` : "";
}

/** (BMK, rail title) of an LS ≤ 10 A on the carrier's NAR or on any RfZ/APZ rail. */
function existingTap(board: Board, carrier: Carrier): readonly [string, string] | null {
  const places: { module: EnclosureModule; zone: ZoneSpec; rail: RailSpec; position: number }[] = [];
  for (const zone of carrier.spec.zones) {
    if (zone.type === "NAR") zone.rails.forEach((rail, i) => places.push({ module: carrier.module, zone, rail, position: i + 1 }));
  }
  const supplyZones = [...placedZones(board.doc, board.index, "RFZ"), ...placedZones(board.doc, board.index, "APZ")];
  const sorted = supplyZones.sort((a, b) => compareNumbers([a.field, a.start, a.index], [b.field, b.start, b.index]));
  for (const placed of sorted) {
    placed.zone.rails.forEach((rail, i) => places.push({ module: placed.module, zone: placed.zone, rail, position: i + 1 }));
  }
  const linked = linkedRails(board.doc, board.index);
  const rows = rowMap(board.doc);
  for (const { module, zone, rail, position } of places) {
    const row = liveRow(linked, rows, module, String(rail.key));
    const tap = row ? rowDevices(row).find(isSmallTap) : undefined;
    if (tap) return [deviceBmk(tap), railTitle(module, zone, position)];
  }
  return null;
}

/** (a) Spannungsversorgung RfZ/APZ (O6). */
function supplyPart(board: Board): Part {
  const carrier = board.carrier;
  if (!carrier) return part();
  const height = board.grid.heightMm;
  const digit = HEIGHT_DIGITS[height];
  if (digit === undefined) return part([], [], { supplyHeight: height });
  const leads = placedZones(board.doc, board.index, "APZ").length > 0 ? "2" : "1";
  const picked = board.overrides.supply;
  const variant: SupplyVariant = picked === "LS" || picked === "SI" ? picked : "SA";
  const article = variant === "SI" ? `ZY${digit}R${leads}SI` : `ZY${digit}N${leads}${variant}`;
  const label = `Bestückungspaket Spannungsversorgung ${leads === "2" ? "APZ/RfZ" : "RfZ"}, ${SUPPLY_PART[variant]}, Bauhöhe ${height} mm`;
  const rfz = supplyRfzEnd(board.doc, board.index, board.grid, carrier);
  const apz = board.apz ? zoneEnd(board.grid, board.apz, "APZ") : null;
  const ends = [rfz, apz].filter((end): end is End => end !== null);
  const where = variant === "SI" ? "im RfZ, Abgriff im NAR" : "im NAR";
  let reason = `Spannungsversorgung SMGW/Steuerbox: ${SUPPLY_DEVICE[variant]} ${where} von Feld ${fieldNo(carrier.field)}${endsText(ends)}`;
  if (variant === "SA") reason += ` · VNB muss die SABO zulassen (sonst ZY${digit}N${leads}LS / ZY${digit}R${leads}SI)`;
  const tap = picked === "auto" ? existingTap(board, carrier) : null;
  if (tap) reason = `Spannungsabgriff bereits geplant (${tap[0]}, ${tap[1]})`;
  const suppressed = picked === "off" || tap !== null;
  const verified = !(digit === "5" && carrier.family === "meter_ehz");
  const kit = item(`accessory:${article}`, article, label, 1, reason, { group: GROUP_SUPPLY, verified, override: picked, suppressed });
  const sabo = saboPoint(board.grid, carrier);
  const runs = suppressed || !sabo ? [] : ends.map((end) => makeRun("supply", sabo, end.point, `${article} · ${SUPPLY_DEVICE[variant]} → ${end.name}`));
  return part([kit], runs, { supplyExisting: tap });
}

/** The first clamp whose range holds the conductor; the table's first for an unknown section. */
function clampFor(mm2: number | null, aluminium: boolean): readonly [string, string] | null {
  const table = aluminium ? CLAMPS_AL : CLAMPS_CU;
  if (mm2 === null) return [table[0][2], table[0][3]];
  const hit = table.find(([low, high]) => low <= mm2 && mm2 <= high);
  return hit ? [hit[2], hit[3]] : null;
}

const sectionText = (mm2: number | null, aluminium: boolean): string =>
  mm2 !== null ? `Zuleitung ${formatMmText(mm2)} mm²${aluminium ? " Al" : ""}` : "";

function adapterReason(effective: string, mm2: number | null, aluminium: boolean): string {
  if (effective === "K96ESA5") {
    const section = sectionText(mm2, aluminium);
    return `Einspeiseadapter manuell gewählt${section ? ` · ${section}` : ""}`;
  }
  return mm2 === null ? "Querschnitt unbekannt — angenommen" : `Zuleitung ${formatMmText(mm2)} mm² ≤ 25 mm²`;
}

function clampReason(mm2: number | null, aluminium: boolean): string {
  if (mm2 === null) return `${aluminium ? "Zuleitung Al, " : ""}Querschnitt unbekannt: eine Klemme je Leiter`;
  return `${sectionText(mm2, aluminium)}${mm2 > K96ESA5_MAX_MM2 ? " > 25 mm²" : ""}: eine Klemme je Leiter`;
}

/** (b) Einspeisung (O8) and (b2) the PEN split. */
function infeedPart(board: Board): Part {
  const runs = busbarRuns(board.zones, ROLE_MAIN);
  if (runs.length === 0) return part();
  const { mm2, cores, aluminium } = parseInfeed(board.supply.incoming);
  const picked = board.overrides.infeed;
  const effective = picked === "off" ? "auto" : picked;
  const adapter = effective === "K96ESA5" || (effective === "auto" && (mm2 === null || mm2 <= K96ESA5_MAX_MM2) && !aluminium);
  const extra = runs.slice(1).map((run) => ` · Feld ${fieldNo(runField(run))}: eigene Einspeisung`).join("");
  const options = { group: GROUP_BUSBAR, override: picked, suppressed: picked === "off" };
  const items: PrepItem[] = [];
  let article: string | null = null;
  const clamp = adapter ? null : clampFor(mm2, aluminium);
  if (adapter) {
    article = "K96ESA5";
    const reason = adapterReason(effective, mm2, aluminium) + extra;
    items.push(item("accessory:K96ESA5", article, "Einspeiseadapter univers Z, 1–25 mm², 5-polig", runs.length, reason, { ...options, verified: true }));
  } else if (clamp) {
    article = clamp[0];
    const qty = (cores === 4 || cores === 5 ? cores : 5) * runs.length;
    items.push(item(`accessory:${article}`, article, clamp[1], qty, clampReason(mm2, aluminium) + extra, { ...options, verified: false }));
  }
  const small = !adapter && !clamp && mm2 !== null && mm2 <= CLAMP_MAX_MM2;
  const facts: PrepFacts = {
    infeedSize: mm2 !== null && mm2 > CLAMP_MAX_MM2 ? mm2 : null,
    ...(small ? { infeedSmall: { mm2, aluminium } } : {}),
    infeed: { mm2, cores, aluminium, article, assumed: adapter && picked === "auto" && mm2 === null },
  };
  if (board.supply.system === "TN-C-S" && cores === 4) {
    const field = runField(runs[0]);
    items.push(item("prep:pen_split", null, "PEN-Aufteilung im NAR (z. B. Hager N75B / ZM35PE)", 1,
      `Zuleitung 4-adrig im TN-C-S-System · PEN im NAR von Feld ${fieldNo(field)} aufteilen`, { group: GROUP_BUSBAR, verified: false }));
    return part(items, [], { ...facts, penField: field });
  }
  return part(items, [], facts);
}

/** (c) Sammelschienenverbinder ZZ55SAVE (O7), one per joined field pair. */
function jointsPart(board: Board): Part {
  const pairs = jointPairs(board.zones);
  if (pairs.length === 0) return part();
  const spans = pairs.map((pair) => `Feld ${fieldNo(pair.left)}–${fieldNo(pair.right)}`).join(", ");
  const unchecked = uncheckedPairs(board.zones);
  const reason = (pairs.length === 1 ? `1 Feldübergang: ${spans}` : `${pairs.length} Feldübergänge: ${spans}`)
    + unchecked.map(([a, b]) => ` · Feld ${fieldNo(a)}–${fieldNo(b)}: Zähler prüfen`).join("");
  const picked = board.overrides.joints;
  const label = "Sammelschienenverbinder Feld/Feld, 5-polig, 12×5 mm, 250 A";
  return part([item("accessory:ZZ55SAVE", "ZZ55SAVE", label, pairs.length, reason, {
    group: GROUP_BUSBAR, verified: unchecked.length === 0, override: picked, suppressed: picked === "off",
  })]);
}

const leadFor = (lengthMm: number): string | null => NETWORK_LEADS.find(([length]) => length >= lengthMm)?.[1] ?? null;

function hagerLead(board: Board, carrier: Carrier, apz: PlacedZone): string | null {
  const position = apz.start < board.grid.unitsPerField / 2 ? "top" : "bottom";
  const row = HAGER_NETWORK_TABLE[`${carrier.family}|${board.grid.heightMm}|${position}`];
  const between = Math.abs(apz.field - carrier.field) - 1;
  return row && between >= 0 && between <= 3 ? row[between] : null;
}

/** (d) Netzwerkleitung APZ → RfZ / Zählerplatz (O5). */
function networkPart(board: Board): Part {
  const { carrier, apz } = board;
  if (!carrier || !apz) return part();
  const ehz = carrier.family === "meter_ehz";
  const target = ehz ? carrierRfz(board.doc, board.index, board.grid, carrier) : meterPlaceEnd(board.grid, carrier);
  const start = zoneEnd(board.grid, apz, "APZ");
  if (!target || !start) return part();
  const run = makeRun("network", start.point, target.point, "");
  let reason = `APZ (Feld ${fieldNo(apz.field)}) → ${ehz ? "RfZ über dem Zähler" : "Zählerplatz"} (Feld ${fieldNo(target.field)})`;
  const metres = board.overrides.network_m;
  let code = metres === null ? hagerLead(board, carrier, apz) : null;
  let verified = true;
  if (metres !== null) {
    code = leadFor(metres * 1000);
    reason += ` · Länge ${formatMmText(metres)} m vorgegeben`;
  } else if (code !== null) {
    reason += " · Länge nach Hager-Bestelltabelle";
  } else {
    code = leadFor(run.lengthMm + (ehz ? 0 : NETWORK_RESERVE_MM));
    verified = false;
    reason += ` · ≈ ${formatMmText(run.lengthMm / 1000)} m gemessen`;
  }
  if (code === null) {
    code = NETWORK_LEADS[NETWORK_LEADS.length - 1][1];
    reason += " · länger als 5 m";
  }
  const picked = board.overrides.network;
  const label = `Patch-Leitung RJ45 Cat 5e, spannungsfest, ${formatMmText(LEAD_MM.get(code)! / 1000)} m`;
  const lead = item(`accessory:${code}`, code, label, 1, reason, { group: GROUP_NETWORK, verified, override: picked, suppressed: picked === "off" });
  return part([lead], picked === "off" ? [] : [{ ...run, label: `${code} · RJ45` }]);
}

/** Decimetres per wire: the stored length, else the run + reserve in 0,5 m steps (§3.3 e). */
export function wireDm(lengthM: number | null, lengthMm: number): number {
  if (lengthM !== null) return Math.floor(lengthM * 10 + 0.5);
  const runDm = Math.ceil(lengthMm / 100);
  return Math.floor((runDm + WIRE_RESERVE_DM + 4) / 5) * 5;
}

/** (e) the §14a block (O2–O4): its parts, then — with a target — wires and Lüsterklemme. */
function controlPart(board: Board, layout: BlockLayout | null, block: ControlBlock | null): Part {
  if (!layout || !block) return part();
  const count = layout.terminals.length;
  const reason = `§14a-Steuersignal-Klemmleiste, Feld ${fieldNo(layout.field)} · ${layout.railTitle}`;
  const parts = ([[PART_END_STOP, 2], [PART_TERMINAL, count], [PART_PLATE, 1]] as const).map(([id, qty]) =>
    item(`part:${id}`, id, CONTROL_PARTS[id].label, qty, reason, { group: GROUP_CONTROL, verified: true }),
  );
  const target = controlTarget(board.doc, board.index, board.carrier);
  if (!target) return part(parts);
  const mm2 = block.wire_mm2;
  const run = makeRun("control", blockPoint(layout), target.point, `${count} × H07V-K ${formatMmText(mm2)} mm²`);
  const dm = wireDm(block.wire_length_m, run.lengthMm);
  const colours = new Map<string, string[]>();
  layout.terminals.forEach((terminal, i) => {
    colours.set(terminal.color, [...(colours.get(terminal.color) ?? []), terminal.label || `Klemme ${i + 1}`]);
  });
  const size = mm2 === 1.5 ? "1.5" : "2.5";
  const wires = [...colours].map(([colour, names]) =>
    item(`wire:h07vk:${size}:${colour}`, null, `Aderleitung H07V-K 1 × ${formatMmText(mm2)} mm² ${colour}`,
      Math.floor((dm * names.length + 9) / 10),
      `${names.join(", ")} · Klemmleiste → ${target.name} · ≈ ${formatMmText(dm / 10)} m je Ader`,
      { group: GROUP_CONTROL, verified: false, unit: "m" }),
  );
  const luester = item("prep:luesterklemme", null, `Lüsterklemme ${count}-polig (von 12-poliger Leiste)`, 1,
    `Gegenstück am ${target.name} Feld ${fieldNo(target.field)}`, { group: GROUP_CONTROL, verified: false });
  return part([...parts, ...wires, luester], [run]);
}

// ── The analysis both outputs read ───────────────────────────────────────────

/** What `cabinetPrep` returns, plus the facts the prep findings need. */
export interface PrepState {
  overrides: PrepOverrides;
  carrier: Carrier | null;
  layout: BlockLayout | null;
  items: PrepItem[];
  runs: PrepRun[];
  facts: PrepFacts;
}

/** The whole §3.3 derivation; null when the cabinet is unknown. */
export function analysePrep(doc: unknown, index: CatalogIndex, block: BlockArg = DERIVE): PrepState | null {
  const code = enclosureOf(doc)?.code;
  if (typeof code !== "string" || !index.enclosure(code)) return null;
  const parsed = resolveBlock(doc, block);
  const supply = isRecord(doc) && isRecord(doc.supply) ? doc.supply : {};
  const board: Board = {
    doc, index, grid: gridOf(doc, index), overrides: prepOverrides(doc), carrier: controlCarrier(doc, index),
    apz: firstApz(doc, index), zones: busbarZones(doc, index), supply,
  };
  const layout = controlBlockLayout(doc, index, parsed);
  const parts = [supplyPart(board), infeedPart(board), jointsPart(board), networkPart(board), controlPart(board, layout, parsed)];
  return {
    overrides: board.overrides,
    carrier: board.carrier,
    layout,
    items: parts.flatMap((entry) => entry.items),
    runs: parts.flatMap((entry) => entry.runs),
    facts: parts.reduce<PrepFacts>((facts, entry) => ({ ...facts, ...entry.facts }), {}),
  };
}

/** `{ items, runs, infeed, overrides }` (§3.3); null when the cabinet is unknown. */
export function cabinetPrep(doc: unknown, index: CatalogIndex, block: BlockArg = DERIVE): CabinetPrep | null {
  const state = analysePrep(doc, index, block);
  if (!state) return null;
  return { items: state.items, runs: state.runs, infeed: state.facts.infeed ?? null, overrides: { ...state.overrides } };
}
