/**
 * Virtual document transforms for the terminal suggestions
 * (docs/PANEL_ENCLOSURE_R2.md §4.2) — the TypeScript twin of
 * `apps/api/app/services/panel_enclosure_terminal_virtual.py`.
 *
 * The suggestion pass asks "what would the placement be if …?" — after the
 * reserved rows were re-linked to empty rails (`virtualRelink`), or after a
 * group was moved into another field (`virtualMove`) — and answers it by
 * re-placing a transformed document. These transforms exist only for that
 * question: nothing is relabelled, and the result is never stored. The real
 * ops (`relinkRows`, `moveGroupToRails` in `enclosureOpsTerminals.ts`)
 * finish with the C§2.4 tail; tests there assert that they give the same
 * placement.
 *
 * Both transforms end like that tail: rows in the C§2.3 physical reading
 * order (`physicalRowOrder`), so a row that moved, or a row created on an
 * empty target rail, sits where the cabinet puts it; then the tail's feed
 * rule (`preserveFeeds`): a circuit whose feed the reordering changed, and
 * whose old head is still a head, is pinned to that head. Without the pins a
 * run that continues past a moved row (a group spilling over a field line,
 * or from a reserved r2 onto r3) would join another group here but not on
 * the real board, and the pass would refuse moves the button makes work.
 *
 * `fillRails` is the one filling rule of a move, shared with the suggestion
 * that picks the targets: each device onto the current rail until it is full
 * (its PLE length, 0.05 mm tolerance), then the next rail, never reordered.
 */

import type { CatalogIndex } from "./enclosureCatalog";
import { enclosureDeviceWidthMm, physicalRowOrder } from "./enclosureLayout";
import {
  STANDARD_RAIL_PLE,
  TOLERANCE_MM,
  asInt,
  compareRailKeys,
  enclosureOf,
  ident,
  isRecord,
  linkedRails,
  moduleSpec,
  modulesOf,
  railTitle,
  rowDevices,
  rowsOf,
  zoneField,
  type RailSortKey,
} from "./enclosureTerminals";
import { MODULE_WIDTH_MM } from "./schaltplanStrip";
import { buildTopology } from "./schaltplanTopologyCore";
import type { EnclosureModule, RailSpec, RailTarget, ZoneSpec } from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

export const VIRTUAL_ROW_PREFIX = "virtual";

/** A resolvable rail of the cabinet and the row linked to it, if any (Python `RailRef`). */
export interface RailRef {
  readonly field: number;
  /** (module unit + zone unit + rail unit, module id, rail key): top → bottom. */
  readonly sort: RailSortKey;
  readonly module: EnclosureModule;
  readonly zone: ZoneSpec;
  readonly rail: RailSpec;
  /** 1-based place of the rail in its zone. */
  readonly position: number;
  readonly row: PanelRow | null;
  readonly moduleId: string;
  readonly key: string;
  /** "F2 · Verteiler 3": the label a new row on it would get. */
  readonly title: string;
  /** ple × 17.5 mm. */
  readonly capacityMm: number;
  /** The suggestion's `RailTarget`. */
  target(): RailTarget;
}

/** A rail reference's identity in sets and maps: module id and rail key. */
export const railPlaceKey = (moduleId: string, railKey: string): string => `${moduleId}\u0000${railKey}`;

type RailRefInput = Omit<RailRef, "moduleId" | "key" | "title" | "capacityMm" | "target">;

function railRefOf(input: RailRefInput): RailRef {
  const moduleId = ident(input.module.id);
  const key = String(input.rail.key);
  const title = railTitle(input.module, input.zone, input.position);
  return Object.freeze({
    ...input,
    moduleId,
    key,
    title,
    capacityMm: asInt(input.rail.ple, STANDARD_RAIL_PLE) * MODULE_WIDTH_MM,
    target: (): RailTarget => ({ moduleId, railKey: key, title, field: input.field }),
  });
}

function railRefs(doc: PanelDocument, index: CatalogIndex): RailRef[] {
  const rows = new Map(rowsOf(doc).map((row) => [row.id, row] as const));
  const byRail = new Map<string, string>(); // the later name wins, as Python's inverted dict
  for (const [rowId, link] of linkedRails(doc, index)) byRail.set(railPlaceKey(ident(link.module.id), String(link.rail.key)), rowId);
  const refs: RailRef[] = [];
  const seen = new Set<string>();
  for (const module of modulesOf(doc)) {
    const moduleId = ident(module.id);
    const spec = moduleSpec(module, index);
    if (!spec || seen.has(moduleId)) continue;
    seen.add(moduleId);
    for (const zone of spec.zones) {
      zone.rails.forEach((rail, at) => {
        const key = String(rail.key);
        const rowId = byRail.get(railPlaceKey(moduleId, key));
        refs.push(railRefOf({
          field: zoneField(module, zone),
          sort: [asInt(module.unit) + asInt(zone.unit) + asInt(rail.unit), moduleId, key],
          module, zone, rail, position: at + 1,
          row: rowId !== undefined ? rows.get(rowId) ?? null : null,
        }));
      });
    }
  }
  return refs;
}

/** field → its VT rails (retired ones included), top → bottom; fields ascending. */
export function vtRails(doc: PanelDocument, index: CatalogIndex): Map<number, RailRef[]> {
  const byField = new Map<number, RailRef[]>();
  for (const ref of railRefs(doc, index)) {
    if (ref.zone.type !== "VT") continue;
    const list = byField.get(ref.field) ?? [];
    byField.set(ref.field, list);
    list.push(ref);
  }
  const out = new Map<number, RailRef[]>();
  for (const field of [...byField.keys()].sort((a, b) => a - b)) {
    out.set(field, [...byField.get(field)!].sort((a, b) => compareRailKeys(a.sort, b.sort)));
  }
  return out;
}

const findRef = (refs: readonly RailRef[], moduleId: unknown, railKey: unknown): RailRef | null =>
  refs.find((ref) => ref.moduleId === moduleId && ref.key === railKey) ?? null;

/** The rail `railKey` of the module `moduleId`; null when it does not resolve. */
export function railRef(doc: PanelDocument, index: CatalogIndex, moduleId: unknown, railKey: unknown): RailRef | null {
  return findRef(railRefs(doc, index), moduleId, railKey);
}

function rowMm(ref: RailRef): number {
  let total = 0;
  for (const device of rowDevices(ref.row ?? undefined)) total += enclosureDeviceWidthMm(device, ref.rail);
  return total;
}

/**
 * [index of the rail each device goes onto, whether all fit]. Each device
 * goes onto the current rail until it is full, then the next, never
 * reordered; a rail starts with what its row already holds. What does not
 * fit any more goes onto the last rail and makes it incomplete.
 */
export function fillRails(devices: readonly PanelDevice[], rails: readonly RailRef[]): [number[], boolean] {
  if (rails.length === 0) return [[], devices.length === 0];
  let at = 0;
  let used = rowMm(rails[0]);
  const out: number[] = [];
  let complete = true;
  for (const device of devices) {
    for (;;) {
      const width = enclosureDeviceWidthMm(device, rails[at].rail);
      const fits = used + width <= rails[at].capacityMm + TOLERANCE_MM;
      if (fits || at === rails.length - 1) {
        complete = complete && fits;
        used += width;
        out.push(at);
        break;
      }
      at += 1;
      used = rowMm(rails[at]);
    }
  }
  return [out, complete];
}

/**
 * `physicalRowOrder` of the board as the tolerant readers see it: rows and
 * modules that can mean anything, module places read as whole numbers.
 * Python reads the stored board the same way (`physical_row_order`).
 */
export function boardRowOrder(doc: PanelDocument, index: CatalogIndex): string[] {
  const enclosure = enclosureOf(doc);
  const modules = modulesOf(doc).map((module) => ({ ...module, field: asInt(module.field), unit: asInt(module.unit) }));
  const readable = { ...doc, rows: rowsOf(doc), enclosure: enclosure ? { ...enclosure, modules } : null } as PanelDocument;
  return physicalRowOrder(readable, index);
}

function inPhysicalOrder(doc: PanelDocument, index: CatalogIndex): PanelDocument {
  const rows = new Map(rowsOf(doc).map((row) => [row.id, row] as const));
  return { ...doc, rows: boardRowOrder(doc, index).map((rowId) => rows.get(rowId)!) };
}

/** [circuit id → its head's id ("" = Einspeisung), the heads], read over the rows the transforms keep. */
function feedsOf(doc: PanelDocument): [Map<string, string>, Set<string>] {
  const readable = { rows: rowsOf(doc).map((row) => ({ ...row, devices: rowDevices(row) })) } as unknown as PanelDocument;
  const feeds = new Map<string, string>();
  const heads = new Set<string>();
  for (const group of buildTopology(readable)) {
    const head = group.device ? ident(group.device.id) : "";
    if (group.device) heads.add(head);
    for (const child of group.children) feeds.set(ident(child.id), head);
  }
  return [feeds, heads];
}

/**
 * `after` with the real ops' pins (`preserveFeeds`, C§2.4): every circuit
 * whose feed changed, and whose old head is still a head, names that head
 * as its `parent_id`. The input itself when nothing is pinned (Python
 * `_with_kept_feeds`).
 */
function withKeptFeeds(before: PanelDocument, after: PanelDocument): PanelDocument {
  const [old] = feedsOf(before);
  const [now, heads] = feedsOf(after);
  const pins = new Map<string, string>();
  for (const row of rowsOf(after)) {
    for (const device of rowDevices(row)) {
      const id = ident(device.id);
      const was = old.get(id);
      const feed = now.get(id);
      if (was !== undefined && feed !== undefined && was !== feed && was !== "" && heads.has(was)) pins.set(id, was);
    }
  }
  if (pins.size === 0) return after;
  const rows = rowsOf(after).map((row) =>
    rowDevices(row).some((device) => pins.has(ident(device.id)))
      ? { ...row, devices: rowDevices(row).map((device) => (pins.has(ident(device.id)) ? { ...device, parent_id: pins.get(ident(device.id))! } : device)) }
      : row,
  );
  return { ...after, rows };
}

/** Every row in `links` named under its new (module id, rail key) only; a rail entry that is no text id stays as it is. */
function withRails(doc: PanelDocument, links: ReadonlyMap<string, readonly [string, string]>): PanelDocument {
  const enclosure = enclosureOf(doc)!;
  const modules = (Array.isArray(enclosure.modules) ? enclosure.modules : []).map((module: unknown) => {
    if (!isRecord(module) || !ident(module.id)) return module;
    const rails = isRecord(module.rails) ? module.rails : {};
    const kept = Object.entries(rails).filter(([, rowId]) => !(typeof rowId === "string" && links.has(rowId)));
    const added = [...links].filter(([, [moduleId]]) => moduleId === module.id).map(([rowId, [, key]]) => [key, rowId] as const);
    return { ...module, rails: Object.fromEntries([...kept, ...added]) };
  });
  return { ...doc, enclosure: { ...enclosure, modules } } as PanelDocument;
}

/** A rail as a move or a suggestion names it. */
export type RailName = Pick<RailTarget, "moduleId" | "railKey">;

/**
 * The board with each move's row named under its target rail instead, in
 * physical order and pinned like the real op (`withKeptFeeds`). A move whose
 * row or rail does not resolve is ignored; with none left, the document
 * comes back as it is (the same object).
 */
export function virtualRelink(
  doc: PanelDocument, index: CatalogIndex, moves: readonly { rowId: string; target: RailName }[],
): PanelDocument {
  const rows = new Set(rowsOf(doc).map((row) => row.id));
  const refs = railRefs(doc, index);
  const links = new Map<string, readonly [string, string]>();
  for (const move of (Array.isArray(moves) ? moves : []) as unknown[]) {
    const target = isRecord(move) ? move.target : null;
    if (!isRecord(move) || !isRecord(target) || typeof move.rowId !== "string" || !rows.has(move.rowId)) continue;
    const ref = findRef(refs, target.moduleId, target.railKey);
    if (ref) links.set(move.rowId, [ref.moduleId, ref.key]);
  }
  if (links.size === 0) return doc;
  return withKeptFeeds(doc, inPhysicalOrder(withRails(doc, links), index));
}

/** The targets that resolve, each rail once, in order. */
function resolvedTargets(doc: PanelDocument, index: CatalogIndex, targets: readonly RailName[]): RailRef[] {
  const all = railRefs(doc, index);
  const refs: RailRef[] = [];
  for (const target of (Array.isArray(targets) ? targets : []) as unknown[]) {
    if (!isRecord(target)) continue;
    const ref = findRef(all, target.moduleId, target.railKey);
    if (ref && refs.every((other) => other.moduleId !== ref.moduleId || other.key !== ref.key)) refs.push(ref);
  }
  return refs;
}

/**
 * The board with `deviceIds` taken out of their rows and filled, in order,
 * onto `targets` (top → bottom). A target rail without a row gets one
 * (`virtual:{module}:{rail}`, labelled like a new row), placed by the
 * physical order; circuits are pinned like the real op pins them
 * (`withKeptFeeds`). Unknown ids and targets are ignored; with nothing
 * left, the document comes back as it is (the same object).
 */
export function virtualMove(doc: PanelDocument, index: CatalogIndex, deviceIds: readonly string[], targets: readonly RailName[]): PanelDocument {
  const refs = resolvedTargets(doc, index, targets);
  const byId = new Map<string, PanelDevice>();
  for (const row of rowsOf(doc)) {
    for (const device of rowDevices(row)) if (!byId.has(ident(device.id))) byId.set(ident(device.id), device);
  }
  const wanted = [...new Set(deviceIds)].filter((id) => id && byId.has(id)).map((id) => byId.get(id)!);
  if (wanted.length === 0 || refs.length === 0) return doc;
  const leaving = new Set(wanted.map((device) => ident(device.id)));
  let rows: PanelRow[] = rowsOf(doc).map((row) =>
    rowDevices(row).some((device) => leaving.has(ident(device.id)))
      ? { ...row, devices: rowDevices(row).filter((device) => !leaving.has(ident(device.id))) }
      : row,
  );
  const [assignment] = fillRails(wanted, refs);
  const links = new Map<string, readonly [string, string]>();
  const taken = new Set(rows.map((row) => row.id));
  refs.forEach((ref, at) => {
    const moved = wanted.filter((_, i) => assignment[i] === at);
    if (moved.length === 0) return;
    if (ref.row) {
      const targetId = ref.row.id;
      rows = rows.map((row) => (row.id === targetId ? { ...row, devices: [...rowDevices(row), ...moved] } : row));
      return;
    }
    let rowId = `${VIRTUAL_ROW_PREFIX}:${ref.moduleId}:${ref.key}`;
    while (taken.has(rowId)) rowId += "'";
    taken.add(rowId);
    rows = [...rows, { id: rowId, label: ref.title, slots: asInt(ref.rail.ple, STANDARD_RAIL_PLE), devices: moved }];
    links.set(rowId, [ref.moduleId, ref.key]);
  });
  const moved = { ...doc, rows };
  return withKeptFeeds(doc, inPhysicalOrder(links.size > 0 ? withRails(moved, links) : moved, index));
}
