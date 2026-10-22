/**
 * What a cabinet means for the rows of a Verteilerplan (docs/PANEL_ENCLOSURE.md
 * §2.3) — the TypeScript twin of `apps/api/app/services/panel_enclosure_layout.py`.
 *
 * `rows[]` stays the only device container (D1). A module's DIN rails only
 * *reference* rows, so everything here is derived: which row hangs on which
 * rail, which devices are a module's pre-fitted parts, and the electrical
 * reading order the topology walks. The order is fixed by zone *type*, never
 * by catalogue list order, because the feed of every circuit follows it:
 * RfZ/APZ devices are fed before the SLS and must never land under a
 * customer FI.
 *
 * Pure, never throws on a half-built or hand-edited document: an unknown
 * code or rail key makes a row "Nicht im Schrank", nothing more.
 */

import { deviceWidthMm, MODULE_WIDTH_MM } from "./schaltplanStrip";
import { enclosureModules, specRails, type CatalogIndex } from "./enclosureCatalog";
import type {
  DeviceSuppliedBy,
  EnclosureFitting,
  EnclosureModule,
  RailSpec,
  ZoneSpec,
  ZoneType,
} from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

export interface RailRef {
  zone: ZoneSpec;
  rail: RailSpec;
}

export interface RailLink {
  moduleId: string;
  railKey: string;
}

/** Rank of a zone type in the reading order after the supply rails (§2.3 step 2). */
const ZONE_RANK: Readonly<Partial<Record<ZoneType, number>>> = { NAR: 1, SAS: 2, AAR: 3, VF: 4, VT: 5, MM: 6 };
/** Rails fed before the SLS: they join the supply group (§2.3 step 1). */
const SUPPLY_ZONES: ReadonlySet<ZoneType> = new Set<ZoneType>(["RFZ", "APZ"]);

export const ZONE_DEFAULT_LABELS: Readonly<Record<ZoneType, string>> = {
  NAR: "NAR",
  ZF: "Zählerfeld",
  RFZ: "RfZ",
  AAR: "AAR",
  VF: "Verteilerfeld",
  APZ: "APZ",
  VT: "Verteiler",
  SAS: "Sammelschienen",
  MM: "Multimedia",
  COVER: "Abdeckung",
};

/** Drawing default for an SLS on a busbar: HTS335E, 4.5 PLE. */
export const BUSBAR_SLS_WIDTH_MM = 78.75;

export function zoneLabel(zone: ZoneSpec): string {
  return zone.label.trim() || ZONE_DEFAULT_LABELS[zone.type] || "";
}

/** Rails of a module, by key, when its code resolves (retired rails included). */
export function resolvableRails(module: EnclosureModule, index: CatalogIndex): Map<string, RailRef> {
  const spec = index.module(module.code);
  const rails = new Map<string, RailRef>();
  if (!spec) return rails;
  for (const { zone, rail } of specRails(spec)) if (!rails.has(rail.key)) rails.set(rail.key, { zone, rail });
  return rails;
}

function railEntries(module: EnclosureModule): [string, string][] {
  const rails = module.rails && typeof module.rails === "object" ? module.rails : {};
  return Object.entries(rails).filter((entry): entry is [string, string] => typeof entry[1] === "string");
}

/**
 * row id → the rail it hangs on. Only existing rows named under a resolvable
 * rail count; the first claim wins should a hand edit name a row twice.
 */
export function linkedRows(doc: PanelDocument, index: CatalogIndex): Map<string, RailLink> {
  const links = new Map<string, RailLink>();
  if (!doc.enclosure) return links;
  const rowIds = new Set(doc.rows.map((row) => row.id));
  for (const module of enclosureModules(doc)) {
    const resolvable = resolvableRails(module, index);
    for (const [railKey, rowId] of railEntries(module)) {
      if (!resolvable.has(railKey) || !rowIds.has(rowId) || links.has(rowId)) continue;
      links.set(rowId, { moduleId: module.id, railKey });
    }
  }
  return links;
}

/** The row a module's rail holds, when that link is the live one. */
export function railRowId(links: Map<string, RailLink>, module: EnclosureModule, railKey: string): string | null {
  const rowId = module.rails?.[railKey];
  if (typeof rowId !== "string") return null;
  const link = links.get(rowId);
  return link && link.moduleId === module.id && link.railKey === railKey ? rowId : null;
}

type SortKey = (number | string)[];

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    // `<` on strings is code-unit order, which equals Python's code-point
    // order for every id this app generates (ASCII).
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/**
 * The electrical reading order of the rows (§2.3), stable and idempotent:
 * every RfZ/APZ rail of the cabinet first, then per module (field, unit) its
 * rails by zone type NAR → SAS → AAR → VF → VT → MM, top → bottom; rows not
 * in the cabinet last, in their current relative order.
 */
export function physicalRowOrder(doc: PanelDocument, index: CatalogIndex): string[] {
  const links = linkedRows(doc, index);
  const ranked: { rowId: string; key: SortKey }[] = [];
  for (const module of enclosureModules(doc)) {
    for (const [railKey, ref] of resolvableRails(module, index)) {
      const rowId = railRowId(links, module, railKey);
      if (!rowId) continue;
      const head: SortKey = [module.field, module.unit, module.id];
      // Zone field, then rail key: ties only a multi-field module can produce.
      const tail: SortKey = [ref.zone.unit, ref.rail.unit, ref.zone.field, railKey];
      const supply = SUPPLY_ZONES.has(ref.zone.type);
      ranked.push({ rowId, key: supply ? [0, ...head, 0, ...tail] : [1, ...head, ZONE_RANK[ref.zone.type] ?? 99, ...tail] });
    }
  }
  const order = sortStable(ranked).map((entry) => entry.rowId);
  const placed = new Set(order);
  return [...order, ...doc.rows.map((row) => row.id).filter((id) => !placed.has(id))];
}

function sortStable(items: { rowId: string; key: SortKey }[]) {
  return items
    .map((item, position) => ({ ...item, position }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.position - b.position);
}

/**
 * Width of a device on a cabinet rail: an explicit `width_mm`; else an SLS on
 * a busbar is the HTS335E's 78.75 mm (a drawing default); else te × 17.5.
 */
export function enclosureDeviceWidthMm(device: PanelDevice, rail: Pick<RailSpec, "mount">): number {
  const explicit = device.width_mm;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) return explicit;
  if (device.kind === "sls" && rail.mount === "busbar") return BUSBAR_SLS_WIDTH_MM;
  return deviceWidthMm(device);
}

export function railLengthMm(rail: Pick<RailSpec, "ple">): number {
  return rail.ple * MODULE_WIDTH_MM;
}

/** `PanelRow.label`'s ceiling on the server; a generated rail label is cut to it. */
export const ROW_LABEL_MAX = 64;

/**
 * `value` cut to `max` characters counted by code point, as the server
 * (Python `len`) counts them — `slice` counts UTF-16 units and could split
 * a surrogate pair, which the server refuses.
 */
export function clampText(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/**
 * "F2 · Verteiler 1", "F1 · NAR": the label a rail's row gets when it is
 * created, and is relabelled with on a move. Cut to what a row label may
 * hold, so a long zone label from the catalogue cannot make the row
 * unsaveable (the Python twin cuts the same way).
 */
export function generatedRowLabel(module: Pick<EnclosureModule, "field">, zone: ZoneSpec, rail: RailSpec): string {
  const number = zone.rails.length > 1 ? ` ${zone.rails.findIndex((entry) => entry.key === rail.key) + 1}` : "";
  return clampText(`F${module.field + zone.field + 1} · ${zoneLabel(zone)}${number}`, ROW_LABEL_MAX);
}

// ── Fittings and supplied devices ────────────────────────────────────────────

/**
 * The module's fittings: its snapshot (D5), or — for a hand-made module
 * without one (no key, or null) — the catalogue's non-retired fittings. An
 * empty list IS a snapshot ("nothing came pre-fitted"); read as "none", a
 * fitting added to the catalogue later would reach every board placed before.
 */
export function moduleFittings(module: EnclosureModule, index: CatalogIndex): EnclosureFitting[] {
  if (Array.isArray(module.fittings)) return module.fittings;
  return catalogFittings(module.code, index);
}

/** The snapshot a placement takes now: every non-retired catalogue fitting. */
export function catalogFittings(code: string, index: CatalogIndex): EnclosureFitting[] {
  const spec = index.module(code);
  if (!spec) return [];
  return spec.fittings
    .filter((fitting) => !fitting.retired)
    .map((fitting) => ({
      key: fitting.key,
      label: fitting.label,
      article_no: fitting.article_no,
      device_kind: fitting.device?.kind ?? null,
      removable: fitting.removable,
    }));
}

function suppliedKey(moduleId: string, part: string): string {
  return `${moduleId}\u0000${part}`;
}

/**
 * device id → its (module, part) for every device that IS a module's
 * pre-fitted part: the module exists, its fittings name `part` as a device
 * fitting, and the device is the first claimant in row order. A second
 * claimant is an ordinary device. Reads the snapshot, so it holds for
 * unknown and invalid codes too.
 */
export function suppliedDevices(doc: PanelDocument, index: CatalogIndex): Map<string, DeviceSuppliedBy> {
  const deviceFittings = new Map<string, Set<string>>();
  for (const module of enclosureModules(doc)) {
    if (deviceFittings.has(module.id)) continue;
    const keys = moduleFittings(module, index).filter((fitting) => fitting.device_kind).map((fitting) => fitting.key);
    deviceFittings.set(module.id, new Set(keys));
  }
  const claimed = new Set<string>();
  const supplied = new Map<string, DeviceSuppliedBy>();
  if (!doc.enclosure) return supplied;
  for (const row of doc.rows) {
    for (const device of row.devices) {
      const by = device.supplied_by;
      if (!by || !deviceFittings.get(by.module)?.has(by.part)) continue;
      const key = suppliedKey(by.module, by.part);
      if (claimed.has(key)) continue;
      claimed.add(key);
      supplied.set(device.id, { module: by.module, part: by.part });
    }
  }
  return supplied;
}

/** Whether a module's fitting has been taken out (§2.3). Only removable fittings can be. */
export function fittingRemoved(doc: PanelDocument, module: EnclosureModule, fitting: EnclosureFitting): boolean {
  if (!fitting.removable) return false;
  if (fitting.device_kind) {
    return !doc.rows.some((row) =>
      row.devices.some((device) => device.supplied_by?.module === module.id && device.supplied_by?.part === fitting.key),
    );
  }
  return Array.isArray(module.removed_fittings) && module.removed_fittings.includes(fitting.key);
}
