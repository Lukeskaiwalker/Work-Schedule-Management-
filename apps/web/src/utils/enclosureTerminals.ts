/**
 * WAGO terminals on the cabinet's rails (docs/PANEL_ENCLOSURE_R2.md §2.1–§3)
 * — the TypeScript twin of `apps/api/app/services/panel_enclosure_terminals.py`.
 * Both are pinned on `test/fixtures/enclosureFixtures.json` (keys
 * `terminal_skip`, `terminal_placement`).
 *
 * The terminals stay **derived** (R1). The placement is a pure function of
 * the document and the catalogue:
 *
 * - the **skip set** (R3): every device on a rail whose zone is not a WAGO
 *   zone (AAR, NAR, RfZ, APZ) gets no terminal, whatever its flag says;
 * - the **terminal rails** (R2): the first two VT rails of each cabinet
 *   field, top → bottom, reserved whether or not anything is on them;
 * - the **home field** of a strip (R4): where most of its circuits are; a
 *   field without terminal rails sends its strips to the nearest one (R6);
 * - the **packing** (R5): the stored order or Leisten-then-Blocks, next-fit
 *   onto rail 1 then rail 2, then first-fit for what is left; never a third
 *   rail, never another field;
 * - the **rail parts** (R7): one end plate per rail that holds a strip,
 *   matching its last terminal block. No end stops (owner, 2026-10-22).
 *
 * The only stored input is `module.terminal_order` (§2.1), read through the
 * lenient `parseTerminalOrder` and nowhere else.
 *
 * Numbers are computed unrounded and `round1` is applied on the way out.
 * Every float sum runs left → right in a plain loop, as the Python twin's
 * do, so both add the same numbers in the same order and agree to the bit.
 * The documents come from tablets several versions behind and from hand
 * edits, so the enclosure block and the rows are read as possibly anything;
 * it never throws on either.
 */

import type { CatalogIndex } from "./enclosureCatalog";
import { ROW_LABEL_MAX, clampText, enclosureDeviceWidthMm, zoneLabel } from "./enclosureLayout";
import { MODULE_WIDTH_MM } from "./schaltplanStrip";
import {
  END_PART_IDS,
  NO_SKIP,
  OUTGOING_PART_IDS,
  TERMINAL_PARTS,
  TERMINAL_PART_ORDER,
  type TerminalPartId,
} from "./schaltplanTerminalRules";
import {
  STRIP_KIND_BLOCK,
  STRIP_KIND_LEISTE,
  deriveTerminals,
  type StripKind,
  type TerminalEntry,
  type TerminalGroup,
  type TerminalStrip,
} from "./schaltplanTerminals";
import type {
  EnclosureModule,
  ModuleSpec,
  PlacedTerminalRail,
  PlacedTerminalStrip,
  RailSpec,
  TerminalFieldPlacement,
  TerminalOrderEntry,
  TerminalOrderStatus,
  TerminalPlacement,
  TerminalRailPart,
  ZoneSpec,
  ZoneType,
} from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

/** Zones whose circuits keep their WAGO terminals (R3); AAR, NAR, RfZ, APZ are the grid operator's side. */
export const WAGO_ZONE_TYPES: ReadonlySet<ZoneType> = new Set<ZoneType>(["VT", "VF", "MM", "SAS"]);
/** Zones whose rails can be terminal rails (R2). */
export const TERMINAL_RAIL_ZONE_TYPES: ReadonlySet<ZoneType> = new Set<ZoneType>(["VT"]);
export const TERMINAL_RAILS_PER_FIELD = 2;
/**
 * What terminals may use of a 12-PLE rail. UNVERIFIED (Q1a): the U842B rail
 * is ≈ 248 mm, but frame screws, U84T pieces and the cover edges have not
 * been measured; 210 mm is the 12-PLE figure, the one length known to be
 * clear of the frame. The Werkstatt measures; then set _VERIFIED (twice).
 */
export const TERMINAL_RAIL_USABLE_MM = 210;
/** True flips `encl.terminals_overflow` from info to warn (§4.1). */
export const TERMINAL_RAIL_USABLE_VERIFIED: boolean = false;
export const STANDARD_RAIL_PLE = 12;
export const TOLERANCE_MM = 0.05;
/** A served spec with this non-retired fitting has insulated rails (R8, §2.2). */
export const INSULATED_RAILS_FITTING = "u84t";
/** A hand-placed "Reihenklemme N/PE" on a terminal rail: a placeholder, never counted (§3.6). */
export const PLACEHOLDER_KINDS: ReadonlySet<string> = new Set(["terminal"]);
/** A 210 mm rail holds ≤ 8 Leisten; 40 is a DoS cap, not a model limit (§2.1). */
export const MAX_ORDER_STRIPS = 40;
export const STRIP_ID_MAX = 80;
export const FIELD_OFFSET_KEYS = ["0", "1", "2"] as const;

export const ORDER_DEFAULT: TerminalOrderStatus = "default";
export const ORDER_MANUAL: TerminalOrderStatus = "manual";
export const ORDER_IGNORED: TerminalOrderStatus = "ignored";

/** `floor(v·10 + 0.5) / 10`, as `enclosureGeometry.round1` (not imported: the geometry reads the placement). */
export function round1(value: number): number {
  return Math.floor(value * 10 + 0.5) / 10;
}

// ── Tolerant readers (the Python layout module's; the T2 twins use them) ─────

export type Loose = Record<string, unknown>;

export const isRecord = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
/** An int from stored JSON; anything else is the fallback (Python `as_int`). */
export const asInt = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isInteger(value) ? value : fallback;
export const ident = (value: unknown): string => (typeof value === "string" ? value : "");

export function enclosureOf(doc: unknown): Loose | null {
  return isRecord(doc) && isRecord(doc.enclosure) ? doc.enclosure : null;
}

/** The modules that can mean anything: an object with a text id. */
export function modulesOf(doc: unknown): EnclosureModule[] {
  const modules = enclosureOf(doc)?.modules;
  if (!Array.isArray(modules)) return [];
  return modules.filter((module): module is EnclosureModule => isRecord(module) && ident(module.id) !== "");
}

/** Rows with a text id, in stored order; a repeated id counts once (the first). */
export function rowsOf(doc: unknown): PanelRow[] {
  const rows = isRecord(doc) ? doc.rows : null;
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  return rows.filter((row): row is PanelRow => {
    const id = isRecord(row) ? ident(row.id) : "";
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export const rowDevices = (row: PanelRow | undefined): PanelDevice[] =>
  row && Array.isArray(row.devices) ? (row.devices as unknown[]).filter(isRecord) as unknown as PanelDevice[] : [];

/** `module.rails` with text row ids only. */
export function moduleRails(module: EnclosureModule): Map<string, string> {
  const rails: unknown = module.rails;
  if (!isRecord(rails)) return new Map();
  return new Map(
    Object.entries(rails).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""),
  );
}

export const moduleSpec = (module: EnclosureModule, index: CatalogIndex): ModuleSpec | null =>
  typeof module.code === "string" ? index.module(module.code) : null;

/** The cabinet field a zone sits in (0-based): module field + zone offset. */
export const zoneField = (module: EnclosureModule, zone: ZoneSpec): number => asInt(module.field) + asInt(zone.field);

export interface LinkedRail {
  module: EnclosureModule;
  zone: ZoneSpec;
  rail: RailSpec;
}

/** row id → (module, zone, rail) for every row "im Schrank"; the first name wins. */
export function linkedRails(doc: unknown, index: CatalogIndex): Map<string, LinkedRail> {
  const existing = new Set(rowsOf(doc).map((row) => row.id));
  const out = new Map<string, LinkedRail>();
  for (const module of modulesOf(doc)) {
    const spec = moduleSpec(module, index);
    if (!spec) continue;
    const rails = new Map<string, { zone: ZoneSpec; rail: RailSpec }>();
    for (const zone of spec.zones) for (const rail of zone.rails) rails.set(String(rail.key), { zone, rail });
    for (const [key, rowId] of moduleRails(module)) {
      const hit = rails.get(key);
      if (hit && existing.has(rowId) && !out.has(rowId)) out.set(rowId, { module, ...hit });
    }
  }
  return out;
}

// ── The stored order (§2.1) ──────────────────────────────────────────────────

const codePoints = (text: string): number => Array.from(text).length;

/**
 * `module.terminal_order` as the derivations may read it, or null. Never
 * throws: a v2.15.0 image during a rollback stores the key unvalidated.
 * Strip ids are cut to text of 1–80 code points, de-duplicated and capped at
 * 40; a `rail2_from` that is not one of them reads as null.
 */
export function parseTerminalOrder(value: unknown): Record<string, TerminalOrderEntry> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, TerminalOrderEntry> = {};
  for (const key of FIELD_OFFSET_KEYS) {
    const entry = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
    if (!isRecord(entry) || !Array.isArray(entry.strips)) continue;
    const valid = (entry.strips as unknown[]).filter(
      (id): id is string => typeof id === "string" && id.length > 0 && codePoints(id) <= STRIP_ID_MAX,
    );
    const strips = [...new Set(valid)].slice(0, MAX_ORDER_STRIPS);
    if (strips.length === 0) continue;
    const mark = entry.rail2_from;
    out[key] = { strips, rail2_from: typeof mark === "string" && strips.includes(mark) ? mark : null };
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ── Which circuits get terminals (§3.1) ──────────────────────────────────────

/**
 * The groups the placement may use: derived WITH the board's skip set. Only
 * `boardTerminals` makes one, so groups derived without the skip set (other
 * X numbers) cannot be placed by mistake — the brand at compile time, a
 * registry at run time.
 */
export type BoardTerminals = {
  readonly skip: ReadonlySet<string>;
  readonly groups: readonly TerminalGroup[];
  readonly __brand: "BoardTerminals";
};

const MADE_BY_BOARD_TERMINALS = new WeakSet<object>();

function isBoardTerminals(value: unknown): value is BoardTerminals {
  return typeof value === "object" && value !== null && MADE_BY_BOARD_TERMINALS.has(value);
}

/** Ids of every device on a resolvable rail outside `WAGO_ZONE_TYPES`; empty without a cabinet. */
export function terminalSkip(doc: PanelDocument, index: CatalogIndex): ReadonlySet<string> {
  if (!enclosureOf(doc)) return NO_SKIP;
  const linked = linkedRails(doc, index);
  const skip = new Set<string>();
  for (const row of rowsOf(doc)) {
    const link = linked.get(row.id);
    if (!link || WAGO_ZONE_TYPES.has(link.zone.type)) continue;
    for (const device of rowDevices(row)) if (ident(device.id)) skip.add(device.id);
  }
  return skip;
}

/** Per catalogue index, per document (by identity): what was derived for it. */
function cacheFor<V>(caches: WeakMap<CatalogIndex, WeakMap<object, V>>, index: CatalogIndex): WeakMap<object, V> {
  const known = caches.get(index);
  if (known) return known;
  const fresh = new WeakMap<object, V>();
  caches.set(index, fresh);
  return fresh;
}

const termsCache = new WeakMap<CatalogIndex, WeakMap<object, BoardTerminals>>();

const wellFormedRow = (row: unknown): boolean =>
  isRecord(row) && Array.isArray(row.devices) && (row.devices as unknown[]).every(isRecord);

/**
 * The rows as the derivation may read them: objects only, and their devices
 * objects only (Python's `iter_devices` skips the rest), or null when there
 * are no rows to read. A well-formed document is passed as it is, so the
 * groups are exactly the ones the Klemmen tab derives.
 */
function derivable(doc: unknown): PanelDocument | null {
  if (!isRecord(doc) || !Array.isArray(doc.rows)) return null;
  const rows: unknown[] = doc.rows;
  if (rows.every(wellFormedRow)) return doc as unknown as PanelDocument;
  const kept = rows.filter(isRecord).map((row) => ({ ...row, devices: Array.isArray(row.devices) ? row.devices.filter(isRecord) : [] }));
  return { ...doc, rows: kept } as unknown as PanelDocument;
}

/** The only way to the groups a placement uses (§3.1); memoised by document identity, per index. */
export function boardTerminals(doc: PanelDocument, index: CatalogIndex): BoardTerminals {
  const cache = isRecord(doc) ? cacheFor(termsCache, index) : null;
  const known = cache?.get(doc);
  if (known) return known;
  const skip = terminalSkip(doc, index);
  const readable = derivable(doc);
  const groups = readable ? deriveTerminals(readable, skip) : [];
  const terms: BoardTerminals = Object.freeze({ skip, groups, __brand: "BoardTerminals" as const });
  MADE_BY_BOARD_TERMINALS.add(terms);
  cache?.set(doc, terms);
  return terms;
}

// ── Terminal rails (§3.2) ────────────────────────────────────────────────────

export interface TerminalRail {
  /** Cabinet field (module field + zone offset). */
  field: number;
  /** 0 = top terminal rail, 1 = second. */
  position: number;
  moduleId: string;
  railKey: string;
  /** The linked row, if any (back-compat devices). */
  rowId: string | null;
  /** Generated label, "F2 · Verteiler 1". */
  title: string;
  /** TERMINAL_RAIL_USABLE_MM on a 12-PLE rail, else ple × 17.5 (custom rails). */
  capacityMm: number;
  /** Σ widths of the non-placeholder devices on `rowId`. */
  devicesMm: number;
  /** The served spec has the fitting `u84t`. */
  insulated: boolean;
}

/** The key a reserved rail goes by in the UI's sets: `"<module id>:<rail key>"`. */
export const terminalRailKey = (moduleId: string, railKey: string): string => `${moduleId}:${railKey}`;

const insulatedSpec = (spec: ModuleSpec): boolean =>
  spec.fittings.some((fitting) => fitting.key === INSULATED_RAILS_FITTING && !fitting.retired);

function devicesMm(row: PanelRow | undefined, rail: RailSpec): number {
  let total = 0;
  for (const device of rowDevices(row)) {
    if (!PLACEHOLDER_KINDS.has(String(device.kind ?? ""))) total += enclosureDeviceWidthMm(device, rail);
  }
  return total;
}

/** "F2 · Verteiler 1" — `default_rail_label`: the number only when the zone has more than one rail. */
export function railTitle(module: EnclosureModule, zone: ZoneSpec, position: number): string {
  const suffix = zone.rails.length > 1 ? ` ${position}` : "";
  return clampText(`F${zoneField(module, zone) + 1} · ${zoneLabel(zone)}${suffix}`, ROW_LABEL_MAX);
}

export type RailSortKey = [number, string, string];

export function compareRailKeys(a: RailSortKey, b: RailSortKey): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  // Code-unit order equals Python's code-point order for every id this app generates.
  for (const i of [1, 2] as const) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

type RailData = Omit<TerminalRail, "field" | "position">;

/**
 * field → its terminal rails: the first two non-retired VT rails on a DIN
 * mount, by (module unit + zone unit + rail unit, module id, rail key).
 */
export function terminalRails(doc: PanelDocument, index: CatalogIndex): Map<number, TerminalRail[]> {
  const rows = new Map(rowsOf(doc).map((row) => [row.id, row] as const));
  const linked = linkedRails(doc, index);
  const candidates = new Map<number, { key: RailSortKey; data: RailData }[]>();
  for (const module of modulesOf(doc)) {
    const spec = moduleSpec(module, index);
    if (!spec) continue;
    const moduleId = ident(module.id);
    const names = moduleRails(module);
    const insulated = insulatedSpec(spec);
    for (const zone of spec.zones) {
      zone.rails.forEach((rail, at) => {
        if (!TERMINAL_RAIL_ZONE_TYPES.has(zone.type) || rail.mount !== "rail" || rail.retired) return;
        const railKey = String(rail.key);
        const named = names.get(railKey);
        const link = named !== undefined ? linked.get(named) : undefined;
        // The row counts only where it is linked: the first name wins.
        const rowId = link && link.module === module && String(link.rail.key) === railKey ? named! : null;
        const ple = asInt(rail.ple, STANDARD_RAIL_PLE);
        const field = zoneField(module, zone);
        const list = candidates.get(field) ?? [];
        candidates.set(field, list);
        list.push({
          key: [asInt(module.unit) + asInt(zone.unit) + asInt(rail.unit), moduleId, railKey],
          data: {
            moduleId,
            railKey,
            rowId,
            title: railTitle(module, zone, at + 1),
            capacityMm: ple === STANDARD_RAIL_PLE ? TERMINAL_RAIL_USABLE_MM : ple * MODULE_WIDTH_MM,
            devicesMm: devicesMm(rowId ? rows.get(rowId) : undefined, rail),
            insulated,
          },
        });
      });
    }
  }
  const out = new Map<number, TerminalRail[]>();
  for (const field of [...candidates.keys()].sort((a, b) => a - b)) {
    const chosen = [...candidates.get(field)!].sort((a, b) => compareRailKeys(a.key, b.key)).slice(0, TERMINAL_RAILS_PER_FIELD);
    out.set(field, chosen.map(({ data }, position) => ({ field, position, ...data })));
  }
  return out;
}

/** `"<module id>:<rail key>"` of every terminal rail: the reserved rails. */
export function terminalRailKeys(doc: PanelDocument, index: CatalogIndex): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const rails of terminalRails(doc, index).values()) for (const rail of rails) keys.add(terminalRailKey(rail.moduleId, rail.railKey));
  return keys;
}

// ── Home fields (§3.3) ───────────────────────────────────────────────────────

/** device id → cabinet field of the rail its row is linked to (resolvable rails only). */
export function deviceFields(doc: PanelDocument, index: CatalogIndex): Map<string, number> {
  const linked = linkedRails(doc, index);
  const out = new Map<string, number>();
  for (const row of rowsOf(doc)) {
    const link = linked.get(row.id);
    if (!link) continue;
    const field = zoneField(link.module, link.zone);
    for (const device of rowDevices(row)) {
      const id = ident(device.id);
      if (id && !out.has(id)) out.set(id, field);
    }
  }
  return out;
}

/** What `stripHomeField` reads of a strip. */
export interface HomeStrip {
  kind: StripKind;
  deviceId: string | null;
  terminals: readonly Pick<TerminalEntry, "partId" | "deviceId">[];
}

/**
 * R4: a Block's own device's field; a Leiste's field with the most of its
 * circuits, a tie to the first circuit's field; null when none is in a field.
 */
export function stripHomeField(strip: HomeStrip, fieldsOf: ReadonlyMap<string, number>): number | null {
  if (strip.kind === STRIP_KIND_BLOCK) return fieldsOf.get(strip.deviceId ?? "") ?? null;
  const order: number[] = []; // field of each distinct circuit, in strip order
  const seen = new Set<string>();
  for (const terminal of strip.terminals) {
    const deviceId = terminal.deviceId;
    if (!OUTGOING_PART_IDS.has(terminal.partId) || !deviceId || seen.has(deviceId)) continue;
    seen.add(deviceId);
    const field = fieldsOf.get(deviceId);
    if (field !== undefined) order.push(field);
  }
  if (order.length === 0) return null;
  const counts = new Map<number, number>();
  for (const field of order) counts.set(field, (counts.get(field) ?? 0) + 1);
  const best = Math.max(...counts.values());
  return order.find((field) => counts.get(field) === best)!;
}

// ── Packing (§3.4) ───────────────────────────────────────────────────────────

interface PackStrip {
  id: string;
  no: number;
  kind: StripKind;
  xLabel: string;
  groupId: string;
  homeField: number | null;
  headField: number | null;
  /** Σ part widths, left → right. */
  width: number;
  /** The plate a rail ending in this strip takes. */
  endPlate: TerminalPartId | null;
  /** Width of its trailing END_PART_IDS parts (the 2009-305). */
  tailMm: number;
}

function packStrip(group: TerminalGroup, strip: TerminalStrip, fieldsOf: ReadonlyMap<string, number>): PackStrip {
  let width = 0;
  for (const terminal of strip.terminals) width += terminal.widthMm;
  let tail = 0;
  let lastBlock: TerminalEntry | null = null;
  for (let at = strip.terminals.length - 1; at >= 0; at -= 1) {
    const terminal = strip.terminals[at];
    if (!END_PART_IDS.has(terminal.partId)) {
      lastBlock = terminal;
      break;
    }
    tail += terminal.widthMm;
  }
  const headId = group.headDevice ? ident(group.headDevice.id) : "";
  return {
    id: strip.stripId,
    no: strip.stripNo,
    kind: strip.kind,
    xLabel: strip.xLabel,
    groupId: group.groupId,
    homeField: stripHomeField(strip, fieldsOf),
    headField: headId ? fieldsOf.get(headId) ?? null : null,
    width,
    endPlate: lastBlock ? TERMINAL_PARTS[lastBlock.partId].endPlate : null,
    tailMm: tail,
  };
}

const plateMm = (strip: PackStrip): number => (strip.endPlate ? TERMINAL_PARTS[strip.endPlate].widthMm : 0);

/** Devices, then each strip left → right, then the last strip's end plate. */
function usedMm(rail: TerminalRail, strips: readonly PackStrip[]): number {
  let used = rail.devicesMm;
  if (strips.length === 0) return used;
  for (const strip of strips) used += strip.width;
  return used + plateMm(strips[strips.length - 1]);
}

const fits = (rail: TerminalRail, strips: readonly PackStrip[]): boolean => usedMm(rail, strips) <= rail.capacityMm + TOLERANCE_MM;

/** A field's stored order, with the module it came from. */
export interface FieldOrder extends TerminalOrderEntry {
  moduleId: string;
}

/**
 * The stored order of a field. The field's modules are walked in
 * terminal-rail order; the first one carrying an entry for this field (keyed
 * by the field's offset inside the module) wins.
 */
export function fieldOrder(
  doc: PanelDocument,
  index: CatalogIndex,
  field: number,
  rails: ReadonlyMap<number, readonly TerminalRail[]> = terminalRails(doc, index),
): FieldOrder | null {
  const byId = new Map<string, EnclosureModule>();
  for (const module of modulesOf(doc)) if (!byId.has(module.id)) byId.set(module.id, module);
  const seen = new Set<string>();
  for (const rail of rails.get(field) ?? []) {
    const module = byId.get(rail.moduleId);
    if (seen.has(rail.moduleId) || !module) continue;
    seen.add(rail.moduleId);
    const entry = parseTerminalOrder(module.terminal_order)?.[String(field - asInt(module.field))];
    if (entry) return { moduleId: rail.moduleId, ...entry };
  }
  return null;
}

/**
 * The stored ids that are current strips, in stored order; every other strip
 * merged in right after its predecessor in `fallback` (at the front if none).
 */
export function effectiveSequence<T extends { id: string }>(fallback: readonly T[], stored: readonly string[]): T[] {
  const byId = new Map(fallback.map((strip) => [strip.id, strip] as const));
  const seq: T[] = [];
  for (const id of new Set(stored)) {
    const strip = byId.get(id);
    if (strip) seq.push(strip);
  }
  const listed = new Set(seq.map((strip) => strip.id));
  fallback.forEach((strip, n) => {
    if (listed.has(strip.id)) return;
    const at = n === 0 ? 0 : seq.findIndex((other) => other.id === fallback[n - 1].id) + 1;
    seq.splice(at, 0, strip);
    listed.add(strip.id);
  });
  return seq;
}

function railOut(rail: TerminalRail, strips: readonly PackStrip[]): PlacedTerminalRail {
  let cursor = rail.devicesMm;
  let offset = cursor;
  const placed: PlacedTerminalStrip[] = [];
  strips.forEach((strip, at) => {
    offset = cursor;
    // The plate sits inside the last strip when it ends in a 2009-305.
    const extent = strip.width + (at === strips.length - 1 && strip.tailMm > 0 ? plateMm(strip) : 0);
    placed.push({
      stripId: strip.id, stripNo: strip.no, kind: strip.kind, xLabel: strip.xLabel, groupId: strip.groupId,
      homeField: strip.homeField, headField: strip.headField,
      offsetMm: round1(offset), widthMm: round1(strip.width), extentMm: round1(extent),
    });
    cursor += extent;
  });
  const last = strips.length > 0 ? strips[strips.length - 1] : null;
  // After the last terminal block, before a trailing 2009-305. Drawn on the
  // right: the plate's open-side orientation is UNVERIFIED.
  const parts: TerminalRailPart[] = last?.endPlate
    ? [{ partId: last.endPlate, role: "end_plate", offsetMm: round1(offset + last.width - last.tailMm), widthMm: round1(plateMm(last)) }]
    : [];
  return {
    moduleId: rail.moduleId, railKey: rail.railKey, rowId: rail.rowId, position: rail.position, title: rail.title,
    capacityMm: round1(rail.capacityMm), devicesMm: round1(rail.devicesMm), usedMm: round1(usedMm(rail, strips)),
    insulated: rail.insulated, strips: placed, parts,
  };
}

function layout(
  field: number, rails: readonly TerminalRail[], content: readonly (readonly PackStrip[])[],
  unplaced: readonly PackStrip[], status: TerminalOrderStatus, order: FieldOrder | null,
): TerminalFieldPlacement {
  let missing = 0;
  for (const strip of unplaced) missing += strip.width;
  return {
    field,
    order: status,
    orderModuleId: order ? order.moduleId : null,
    rails: rails.map((rail, at) => railOut(rail, content[at])),
    unplaced: unplaced.map((strip) => ({ stripId: strip.id, xLabel: strip.xLabel, widthMm: round1(strip.width) })),
    missingMm: round1(missing),
  };
}

function placeField(field: number, rails: readonly TerminalRail[], strips: readonly PackStrip[], order: FieldOrder | null): TerminalFieldPlacement {
  const leisteFirst = (strip: PackStrip) => (strip.kind === STRIP_KIND_LEISTE ? 0 : 1);
  const fallback = [...strips].sort((a, b) => leisteFirst(a) - leisteFirst(b) || a.no - b.no);
  const seq = effectiveSequence(fallback, order ? order.strips : []);
  let status = order ? ORDER_MANUAL : ORDER_DEFAULT;
  const mark = order ? order.rail2_from : null;
  if (mark !== null && rails.length === 2) {
    const k = seq.findIndex((strip) => strip.id === mark);
    if (k >= 0 && fits(rails[0], seq.slice(0, k)) && fits(rails[1], seq.slice(k))) {
      return layout(field, rails, [seq.slice(0, k), seq.slice(k)], [], status, order);
    }
    if (k >= 0) status = ORDER_IGNORED; // a stored split that no longer fits is never kept
  }
  const content: PackStrip[][] = rails.map(() => []);
  let cursor = 0;
  const left: PackStrip[] = [];
  for (const strip of seq) {
    // Next-fit keeps X1, X2 … in reading order.
    let at = cursor;
    while (at < rails.length && !fits(rails[at], [...content[at], strip])) at += 1;
    if (at < rails.length) {
      content[at].push(strip);
      cursor = at;
    } else {
      left.push(strip);
    }
  }
  const unplaced: PackStrip[] = [];
  for (const strip of left) {
    // First-fit: the end of rail 1, else the end of rail 2.
    const at = rails.findIndex((rail, i) => fits(rail, [...content[i], strip]));
    if (at >= 0) content[at].push(strip);
    else unplaced.push(strip);
  }
  return layout(field, rails, content, unplaced, status, order);
}

interface Assigned {
  target: Map<number, PackStrip[]>;
  elsewhere: TerminalPlacement["elsewhere"];
  outside: string[];
  noRails: string[];
}

/** R4/R6: each strip to its home field, or the nearest field with terminal rails (ties to the left). */
function assignFields(strips: readonly PackStrip[], fields: readonly number[]): Assigned {
  const target = new Map<number, PackStrip[]>(fields.map((field) => [field, []]));
  const out: Assigned = { target, elsewhere: [], outside: [], noRails: [] };
  for (const strip of strips) {
    const home = strip.homeField;
    if (home === null) out.outside.push(strip.id);
    else if (target.has(home)) target.get(home)!.push(strip);
    else if (fields.length === 0) out.noRails.push(strip.id);
    else {
      const distance = (field: number) => Math.abs(field - home);
      const field = fields.reduce((best, candidate) =>
        distance(candidate) < distance(best) || (distance(candidate) === distance(best) && candidate < best) ? candidate : best);
      target.get(field)!.push(strip);
      out.elsewhere.push({ stripId: strip.id, homeField: home, field });
    }
  }
  return out;
}

/** The placement of a board without a cabinet. */
export function emptyPlacement(): TerminalPlacement {
  return { skip: [], usableMm: TERMINAL_RAIL_USABLE_MM, fields: [], elsewhere: [], outside: [], noRails: [], railParts: {}, insulationSets: 0 };
}

function computePlacement(doc: PanelDocument, index: CatalogIndex, terms: BoardTerminals): TerminalPlacement {
  const rails = terminalRails(doc, index);
  const fieldsOf = deviceFields(doc, index);
  const strips = terms.groups.flatMap((group) => group.strips.map((strip) => packStrip(group, strip, fieldsOf)));
  const fieldNumbers = [...rails.keys()];
  const { target, elsewhere, outside, noRails } = assignFields(strips, fieldNumbers);
  const fields = fieldNumbers.map((field) => placeField(field, rails.get(field)!, target.get(field)!, fieldOrder(doc, index, field, rails)));
  const counts = new Map<string, number>();
  let sets = 0;
  for (const field of fields) {
    for (const rail of field.rails) {
      if (rail.strips.length === 0) continue;
      for (const part of rail.parts) counts.set(part.partId, (counts.get(part.partId) ?? 0) + 1);
      sets += rail.insulated ? 0 : 1;
    }
  }
  const railParts: Record<string, number> = {};
  for (const partId of TERMINAL_PART_ORDER) {
    const count = counts.get(partId) ?? 0;
    if (count > 0) railParts[partId] = count;
  }
  return { skip: [...terms.skip].sort(), usableMm: TERMINAL_RAIL_USABLE_MM, fields, elsewhere, outside, noRails, railParts, insulationSets: sets };
}

const placementCache = new WeakMap<CatalogIndex, WeakMap<object, { terms: BoardTerminals; placement: TerminalPlacement }>>();

/**
 * The board's terminal placement (§2.3). `terms` only from `boardTerminals`
 * (anything else throws a TypeError). Memoised by document identity, per
 * index and terms: callers treat the answer as read-only.
 */
export function placeTerminals(doc: PanelDocument, index: CatalogIndex, terms?: BoardTerminals): TerminalPlacement {
  if (terms !== undefined && !isBoardTerminals(terms)) {
    throw new TypeError("placeTerminals needs boardTerminals(); groups without the skip set are refused");
  }
  if (!enclosureOf(doc)) return emptyPlacement();
  const resolved = terms ?? boardTerminals(doc, index);
  const cache = cacheFor(placementCache, index);
  const known = cache.get(doc);
  if (known && known.terms === resolved) return known.placement;
  const placement = computePlacement(doc, index, resolved);
  cache.set(doc, { terms: resolved, placement });
  return placement;
}

/** part id → count of the rail parts (the end plates), for `terminalBom(groups, extra)`. */
export function terminalRailParts(placement: TerminalPlacement): Record<string, number> {
  return { ...placement.railParts };
}

/** U84T sets the board needs: terminal rails with strips that are not insulated. */
export function insulationSets(placement: TerminalPlacement): number {
  return placement.insulationSets;
}
