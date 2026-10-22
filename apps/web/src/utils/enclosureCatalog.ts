/**
 * The cabinet catalogue as the editor reads it (docs/PANEL_ENCLOSURE.md §3,
 * §10.2), plus the fit helpers the module picker asks before a placement.
 *
 * There is no catalogue twin on the client (D9): everything comes from
 * `GET /schaltplan/enclosure-catalog`. `catalogIndex` only makes lookups
 * cheap and fills the defaults a spec may leave out — the server always
 * sends complete specs, but a fixture or an older answer may not, and every
 * derivation downstream reads these fields without re-checking them.
 *
 * "Unknown or invalid" is one state for the readers: `enclosure()` and
 * `module()` return null for both, exactly like the Python
 * `EnclosureCatalog`. A module whose code does not resolve is drawn as a
 * one-unit placeholder, so it also occupies one unit here.
 */

import type {
  AccessorySpec,
  CatalogEntry,
  EnclosureCatalog,
  EnclosureModule,
  EnclosureSpec,
  FittingSpec,
  ModuleFamily,
  ModuleSpec,
  RailSpec,
  ZoneSpec,
} from "../types/panelEnclosure";
import type { DeviceKind, PanelDocument } from "../types/schaltplan";

export const METER_FAMILIES: ReadonlySet<string> = new Set(["meter_ehz", "meter_3p"]);

/** What a module family is called on site — the field bar and the catalogue form share it. */
export const FAMILY_LABELS: Readonly<Record<ModuleFamily, string>> = {
  meter_ehz: "Zählerfeld eHZ",
  meter_3p: "Zählerfeld 3-Punkt",
  distribution: "Verteilerfeld",
  distribution_apz: "Verteilerfeld mit APZ",
  busbar: "Sammelschienenfeld",
  communication: "Kommunikationsfeld",
  multimedia: "Multimediafeld",
  cover: "Abdeckung",
};

/** " zh3eh16 " is ZH3EH16: codes are typed by hand on site (twin of `normalize_code`). */
export function normalizeCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

export interface CatalogIndex {
  enclosure(code: string): EnclosureSpec | null;
  module(code: string): ModuleSpec | null;
  entry(code: string): CatalogEntry<EnclosureSpec | ModuleSpec> | null;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

type Loose<T> = { [K in keyof T]?: unknown };

const num = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const nullableText = (value: unknown): string | null => (typeof value === "string" ? value : null);

function railSpec(raw: Loose<RailSpec>): RailSpec {
  return {
    key: text(raw.key),
    unit: num(raw.unit, 0),
    ple: num(raw.ple, 12),
    mount: raw.mount === "busbar" ? "busbar" : "rail",
    retired: raw.retired === true,
  };
}

function zoneSpec(raw: Loose<ZoneSpec>): ZoneSpec {
  return {
    key: text(raw.key),
    type: text(raw.type, "VT") as ZoneSpec["type"],
    label: text(raw.label),
    field: num(raw.field, 0),
    unit: num(raw.unit, 0),
    units: num(raw.units, 1),
    rails: list<Loose<RailSpec>>(raw.rails).map(railSpec),
    meter_places: num(raw.meter_places, 0),
    meter_type: raw.meter_type === "ehz" || raw.meter_type === "3punkt" ? raw.meter_type : null,
    sealable: raw.sealable === true,
  };
}

function fittingSpec(raw: Loose<FittingSpec>): FittingSpec {
  const device = raw.device && typeof raw.device === "object" ? (raw.device as Record<string, unknown>) : null;
  return {
    key: text(raw.key),
    label: text(raw.label),
    article_no: nullableText(raw.article_no),
    removable: raw.removable === true,
    device: device
      ? {
          kind: text(device.kind, "blank") as DeviceKind,
          rail: text(device.rail),
          te: num(device.te, 1),
          poles: num(device.poles, 1),
          rating: text(device.rating),
          width_mm: typeof device.width_mm === "number" ? device.width_mm : null,
        }
      : null,
    verified: raw.verified !== false,
    note: text(raw.note),
    retired: raw.retired === true,
  };
}

function accessory(raw: Loose<AccessorySpec>): AccessorySpec {
  return { article_no: text(raw.article_no), label: text(raw.label), qty: num(raw.qty, 1), verified: raw.verified !== false };
}

function baseSpec(raw: Record<string, unknown>) {
  return {
    code: normalizeCode(raw.code),
    article_no: text(raw.article_no, normalizeCode(raw.code)),
    manufacturer: text(raw.manufacturer, "Hager"),
    series: text(raw.series, "univers Z"),
    name: text(raw.name),
    accessories: list<Loose<AccessorySpec>>(raw.accessories).map(accessory),
    verified: raw.verified !== false,
    unverified: list<unknown>(raw.unverified).filter((line): line is string => typeof line === "string"),
    source_url: nullableText(raw.source_url),
    note: text(raw.note),
  };
}

function enclosureSpecWithDefaults(raw: Record<string, unknown>): EnclosureSpec {
  return {
    ...baseSpec(raw),
    height_mm: num(raw.height_mm, 1100),
    width_mm: num(raw.width_mm, 550),
    depth_mm: num(raw.depth_mm, 205),
    fields: num(raw.fields, 1),
    door_leaves: num(raw.door_leaves, 1),
    field_width_mm: num(raw.field_width_mm, 250),
    unit_mm: num(raw.unit_mm, 150),
    margin_mm: num(raw.margin_mm, 25),
    units_per_field: num(raw.units_per_field, 7),
    mounting: "surface",
    ip: text(raw.ip),
    door: text(raw.door),
  };
}

function moduleSpecWithDefaults(raw: Record<string, unknown>): ModuleSpec {
  const cover = raw.free_place_cover && typeof raw.free_place_cover === "object" ? (raw.free_place_cover as Loose<AccessorySpec>) : null;
  return {
    ...baseSpec(raw),
    family: text(raw.family, "distribution") as ModuleSpec["family"],
    field_height_mm: typeof raw.field_height_mm === "number" ? raw.field_height_mm : null,
    width_fields: num(raw.width_fields, 1),
    height_units: num(raw.height_units, 1),
    wiring_mm2: raw.wiring_mm2 === 10 || raw.wiring_mm2 === 16 ? raw.wiring_mm2 : null,
    zones: list<Loose<ZoneSpec>>(raw.zones).map(zoneSpec),
    fittings: list<Loose<FittingSpec>>(raw.fittings).map(fittingSpec),
    free_place_cover: cover ? accessory(cover) : null,
  };
}

// ── Index ────────────────────────────────────────────────────────────────────

function specOf<S>(entry: CatalogEntry | undefined, type: "enclosure" | "module", specs: Map<string, S>): S | null {
  if (!entry || entry.entry_type !== type || entry.invalid) return null;
  return specs.get(entry.code) ?? null;
}

/** Lookups by code over the catalogue answer; archived entries resolve, invalid ones do not. */
export function catalogIndex(catalog: EnclosureCatalog): CatalogIndex {
  const entries = new Map<string, CatalogEntry>();
  const enclosures = new Map<string, EnclosureSpec>();
  const modules = new Map<string, ModuleSpec>();
  const register = (items: readonly CatalogEntry[] | undefined, type: "enclosure" | "module") => {
    for (const item of items ?? []) {
      const code = normalizeCode(item?.code);
      if (!code) continue;
      const entry: CatalogEntry = { ...item, code, entry_type: item.entry_type ?? type, invalid: item.invalid === true || !item.spec };
      entries.set(code, entry);
      if (entry.invalid || !item.spec) continue;
      const raw = item.spec as unknown as Record<string, unknown>;
      if (entry.entry_type === "enclosure") enclosures.set(code, enclosureSpecWithDefaults(raw));
      else modules.set(code, moduleSpecWithDefaults(raw));
    }
  };
  register(catalog.enclosures, "enclosure");
  register(catalog.modules, "module");
  return {
    enclosure: (code) => specOf(entries.get(normalizeCode(code)), "enclosure", enclosures),
    module: (code) => specOf(entries.get(normalizeCode(code)), "module", modules),
    entry: (code) => entries.get(normalizeCode(code)) ?? null,
  };
}

// ── Sizes and occupancy ──────────────────────────────────────────────────────

/** Usable field height in mm: what a module's `field_height_mm` must equal. */
export function fieldHeightMm(cabinet: EnclosureSpec): number {
  return cabinet.units_per_field * cabinet.unit_mm;
}

/** Fields × units a module takes; an unresolved code is a 1 × 1 placeholder, as drawn. */
function moduleSize(spec: ModuleSpec | null): { widthFields: number; heightUnits: number } {
  return spec ? { widthFields: spec.width_fields, heightUnits: spec.height_units } : { widthFields: 1, heightUnits: 1 };
}

/** The article number shown for a module ("ZH3EH16"); the code itself when it does not resolve. */
export function moduleArticle(module: Pick<EnclosureModule, "code">, index: CatalogIndex): string {
  return index.module(module.code)?.article_no || normalizeCode(module.code);
}

export function enclosureModules(document: PanelDocument): EnclosureModule[] {
  return Array.isArray(document.enclosure?.modules) ? document.enclosure!.modules : [];
}

/** Every `"field:unit"` cell a module covers. */
function moduleCells(module: EnclosureModule, index: CatalogIndex): string[] {
  const { widthFields, heightUnits } = moduleSize(index.module(module.code));
  const cells: string[] = [];
  for (let field = module.field; field < module.field + widthFields; field += 1) {
    for (let unit = module.unit; unit < module.unit + heightUnits; unit += 1) cells.push(`${field}:${unit}`);
  }
  return cells;
}

function occupiedCells(document: PanelDocument, index: CatalogIndex, ignoreModuleId?: string): Set<string> {
  const cells = new Set<string>();
  for (const module of enclosureModules(document)) {
    if (module.id === ignoreModuleId) continue;
    for (const cell of moduleCells(module, index)) cells.add(cell);
  }
  return cells;
}

/** The free stretches of one field, top → bottom; [] without a resolvable cabinet. */
export function freeRuns(
  document: PanelDocument,
  index: CatalogIndex,
  field: number,
  ignoreModuleId?: string,
): { unit: number; units: number }[] {
  const cabinet = document.enclosure ? index.enclosure(document.enclosure.code) : null;
  if (!cabinet || field < 0 || field >= cabinet.fields) return [];
  const taken = occupiedCells(document, index, ignoreModuleId);
  const runs: { unit: number; units: number }[] = [];
  let start = -1;
  for (let unit = 0; unit <= cabinet.units_per_field; unit += 1) {
    const free = unit < cabinet.units_per_field && !taken.has(`${field}:${unit}`);
    if (free && start < 0) start = unit;
    if (!free && start >= 0) {
      runs.push({ unit: start, units: unit - start });
      start = -1;
    }
  }
  return runs;
}

/** Consecutive free units from `unit` down, across every field the module would span (the smallest). */
function freeUnitsFrom(taken: Set<string>, cabinet: EnclosureSpec, fields: number[], unit: number): number {
  let free = 0;
  for (let at = unit; at < cabinet.units_per_field; at += 1) {
    if (fields.some((field) => taken.has(`${field}:${at}`))) break;
    free += 1;
  }
  return free;
}

/**
 * Whether module `code` fits with its top-left at (`field`, `unit`): null
 * when it does, else the German reason the picker shows ("passt hier nicht:
 * …", §11). `ignoreModuleId` is the module being moved, whose own cells are free.
 */
export function fitsAt(
  document: PanelDocument,
  index: CatalogIndex,
  code: string,
  field: number,
  unit: number,
  ignoreModuleId?: string,
): string | null {
  if (!document.enclosure) return "Noch kein Schrank geplant.";
  const cabinet = index.enclosure(document.enclosure.code);
  if (!cabinet) return `Unbekannter Schrank- oder Modulcode: ${normalizeCode(document.enclosure.code)}.`;
  const spec = index.module(code);
  if (!spec) return `Unbekannter Schrank- oder Modulcode: ${normalizeCode(code)}.`;
  const available = fieldHeightMm(cabinet);
  if (spec.field_height_mm !== null && spec.field_height_mm !== available) {
    return `Für ${spec.field_height_mm} mm Felder — dieser Schrank hat ${available} mm.`;
  }
  if (field < 0) return "Ragt über das erste Feld hinaus.";
  if (field + spec.width_fields > cabinet.fields) return "Ragt über das letzte Feld hinaus.";
  const fields = Array.from({ length: spec.width_fields }, (_, offset) => field + offset);
  const free = unit < 0 ? 0 : freeUnitsFrom(occupiedCells(document, index, ignoreModuleId), cabinet, fields, unit);
  if (free < spec.height_units) {
    return `Nicht genug Platz: ${spec.height_units * cabinet.unit_mm} mm nötig, ${free * cabinet.unit_mm} mm frei.`;
  }
  return null;
}

/** Meter places of a module spec, ZF zones in spec order (the running `place` index, §2.1). */
export function meterZones(spec: ModuleSpec): ZoneSpec[] {
  return spec.zones.filter((zone) => zone.type === "ZF" && zone.meter_places > 0);
}

export function meterPlaceCount(spec: ModuleSpec | null): number {
  return spec ? meterZones(spec).reduce((total, zone) => total + zone.meter_places, 0) : 0;
}

/** Every rail of a module spec with its zone, in spec order, retired ones included. */
export function specRails(spec: ModuleSpec): { zone: ZoneSpec; rail: RailSpec }[] {
  return spec.zones.flatMap((zone) => zone.rails.map((rail) => ({ zone, rail })));
}
