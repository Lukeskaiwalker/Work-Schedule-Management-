/**
 * The shared tail of every cabinet op (docs/PANEL_ENCLOSURE.md §10.2).
 *
 * Every op is pure — the document passed in is never touched — and ends the
 * same way: `normalizeEnclosure` → physical row order → prune empty rail
 * rows → `preserveFeeds`. That tail is what makes the ops safe to chain: the
 * rows always follow the cabinet's reading order, rails do not collect empty
 * generated rows, and no circuit changes its feed without the op saying so.
 *
 * Callers import from `enclosureOps.ts`; this module only exists so the
 * module ops and the rail ops can share the tail without importing each other.
 */

import { MAX_ROWS, newId } from "./schaltplanDevices";
import { enclosureModules, moduleArticle, type CatalogIndex } from "./enclosureCatalog";
import { generatedRowLabel, linkedRows, physicalRowOrder, railRowId, resolvableRails } from "./enclosureLayout";
import { preserveFeeds, type Regroup } from "./enclosureFeeds";
import type { DeviceSuppliedBy, EnclosureModule } from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

export type OpResult =
  | { ok: true; document: PanelDocument; moduleId?: string; deviceId?: string; pinned: string[]; regrouped: Regroup[] }
  | { ok: false; error: string };

// ── What one stored module may hold (schemas/panel_enclosure.py) ─────────────
// The server refuses a document past these (422) on every save, so the ops
// stay inside them: a refused op is one message, a refused save is a board
// that stops saving until someone guesses which field to shorten.

export const MAX_RAILS_PER_MODULE = 16;
export const METER_NUMBER_MAX = 40;
export const METER_LABEL_MAX = 64;
export const MODULE_LABEL_MAX = 64;

// ── Copy (§11, plus the few refusals a stale sheet can trigger) ──────────────

export const TOO_MANY_ROWS = `Zu viele Reihen (max. ${MAX_ROWS}) — erst leere Reihen entfernen.`;
export const TOO_MANY_RAILS = `Zu viele Hutschienen in einem Modul (max. ${MAX_RAILS_PER_MODULE}).`;
export const SAME_SIZE_ONLY = "Nur Module gleicher Größe lassen sich tauschen.";
export const RAIL_NOT_EMPTY = "Hutschiene ist nicht leer.";
export const MODULE_NOT_FOUND = "Modul nicht gefunden.";
export const ROW_NOT_FOUND = "Reihe nicht gefunden.";
export const DEVICE_NOT_FOUND = "Gerät nicht gefunden.";
export const unknownCode = (code: string) => `Unbekannter Schrank- oder Modulcode: ${code}.`;
export const railUnknown = (key: string, article: string) => `Hutschiene „${key}“ gibt es in ${article} nicht.`;
export const railRetired = (key: string, article: string) => `Hutschiene „${key}“ in ${article} ist ausgemustert.`;

export function refuse(error: string): OpResult {
  return { ok: false, error };
}

/** An op that changes nothing: the input itself, so `mutate` saves nothing. */
export function unchanged(document: PanelDocument, moduleId?: string): OpResult {
  return { ok: true, document, pinned: [], regrouped: [], ...(moduleId ? { moduleId } : {}) };
}

// ── Small immutable helpers ──────────────────────────────────────────────────

export function findModule(doc: PanelDocument, moduleId: string): EnclosureModule | null {
  return enclosureModules(doc).find((module) => module.id === moduleId) ?? null;
}

export function withModules(doc: PanelDocument, change: (modules: EnclosureModule[]) => EnclosureModule[]): PanelDocument {
  if (!doc.enclosure) return doc;
  return { ...doc, enclosure: { ...doc.enclosure, modules: change(enclosureModules(doc)) } };
}

export function withModule(doc: PanelDocument, moduleId: string, change: (module: EnclosureModule) => EnclosureModule): PanelDocument {
  return withModules(doc, (modules) => modules.map((module) => (module.id === moduleId ? change(module) : module)));
}

export function withRow(doc: PanelDocument, rowId: string, change: (row: PanelRow) => PanelRow): PanelDocument {
  return { ...doc, rows: doc.rows.map((row) => (row.id === rowId ? change(row) : row)) };
}

/** Change matching devices wherever they are; untouched rows keep their identity. */
export function mapDevices(doc: PanelDocument, change: (device: PanelDevice) => PanelDevice): PanelDocument {
  return {
    ...doc,
    rows: doc.rows.map((row) => {
      const devices = row.devices.map(change);
      return devices.every((device, i) => device === row.devices[i]) ? row : { ...row, devices };
    }),
  };
}

/** Take a device out of its row and put it into `rowId` at `position` (end by default), with `patch` applied. */
export function moveDeviceInto(
  doc: PanelDocument,
  deviceId: string,
  rowId: string,
  patch: Partial<PanelDevice> = {},
  position: "start" | "end" = "end",
): PanelDocument {
  const device = doc.rows.flatMap((row) => row.devices).find((candidate) => candidate.id === deviceId);
  if (!device) return doc;
  const moved = { ...device, ...patch };
  const rows = doc.rows.map((row) => {
    const rest = row.devices.filter((candidate) => candidate.id !== deviceId);
    if (row.id !== rowId) return rest.length === row.devices.length ? row : { ...row, devices: rest };
    return { ...row, devices: position === "start" ? [moved, ...rest] : [...rest, moved] };
  });
  return { ...doc, rows };
}

export function insertDevice(doc: PanelDocument, rowId: string, device: PanelDevice, position: "start" | "end" = "end"): PanelDocument {
  return withRow(doc, rowId, (row) => ({ ...row, devices: position === "start" ? [device, ...row.devices] : [...row.devices, device] }));
}

export function sameSupplier(by: DeviceSuppliedBy | null | undefined, moduleId: string, part?: string): boolean {
  return !!by && by.module === moduleId && (part === undefined || by.part === part);
}

// ── Rail rows ────────────────────────────────────────────────────────────────

/**
 * The row a rail holds, created lazily (D15) when it has none: labelled
 * "F{n} · {zone}{ k}", `slots` = the rail's PLE, inserted where the reading
 * order puts it. Inserting an empty row moves no circuit, so this needs no
 * feed check of its own.
 */
export function ensureRailRow(
  doc: PanelDocument,
  index: CatalogIndex,
  moduleId: string,
  railKey: string,
): { document: PanelDocument; rowId: string } | { error: string } {
  const module = findModule(doc, moduleId);
  if (!module) return { error: MODULE_NOT_FOUND };
  const ref = resolvableRails(module, index).get(railKey);
  if (!ref) return { error: railUnknown(railKey, moduleArticle(module, index)) };
  const existing = railRowId(linkedRows(doc, index), module, railKey);
  if (existing) return { document: doc, rowId: existing };
  if (ref.rail.retired) return { error: railRetired(railKey, moduleArticle(module, index)) };
  if (doc.rows.length >= MAX_ROWS) return { error: TOO_MANY_ROWS };
  // Only stale keys a hand edit left can get here: a valid spec has at most 16 rails.
  if (Object.keys(module.rails ?? {}).length >= MAX_RAILS_PER_MODULE) return { error: TOO_MANY_RAILS };
  const row: PanelRow = { id: newId("row"), label: generatedRowLabel(module, ref.zone, ref.rail), slots: ref.rail.ple, devices: [] };
  const linked = withModule({ ...doc, rows: [...doc.rows, row] }, moduleId, (current) => ({
    ...current,
    rails: { ...(current.rails ?? {}), [railKey]: row.id },
  }));
  const order = physicalRowOrder(linked, index);
  const successor = order[order.indexOf(row.id) + 1];
  const at = successor ? doc.rows.findIndex((candidate) => candidate.id === successor) : -1;
  const rows = at < 0 ? [...doc.rows, row] : [...doc.rows.slice(0, at), row, ...doc.rows.slice(at)];
  return { document: { ...linked, rows }, rowId: row.id };
}

// ── The tail ─────────────────────────────────────────────────────────────────

/**
 * Give duplicate module ids new ids and drop a second rail reference to the
 * same row — the two links the server refuses (422). The hook runs this
 * before every save on a cabinet board; a clean document comes back as is.
 */
export function normalizeEnclosure(doc: PanelDocument): PanelDocument {
  if (!doc.enclosure) return doc;
  const ids = new Set<string>();
  const rowsSeen = new Set<string>();
  let changed = false;
  const modules = enclosureModules(doc).map((module) => {
    const id = ids.has(module.id) ? newId("mod") : module.id;
    ids.add(id);
    const rails: Record<string, string> = {};
    for (const [key, rowId] of Object.entries(module.rails ?? {})) {
      if (rowsSeen.has(rowId)) continue;
      rowsSeen.add(rowId);
      rails[key] = rowId;
    }
    const sameRails = Object.keys(rails).length === Object.keys(module.rails ?? {}).length;
    if (id === module.id && sameRails) return module;
    changed = true;
    return { ...module, id, rails };
  });
  return changed ? { ...doc, enclosure: { ...doc.enclosure, modules } } : doc;
}

function withPhysicalOrder(doc: PanelDocument, index: CatalogIndex): PanelDocument {
  const order = physicalRowOrder(doc, index);
  if (order.every((id, position) => doc.rows[position]?.id === id)) return doc;
  const byId = new Map(doc.rows.map((row) => [row.id, row] as const));
  return { ...doc, rows: order.map((id) => byId.get(id)!) };
}

/** Linked rows that are empty and still carry their generated label go, with their rail reference. */
function pruneEmptyRailRows(doc: PanelDocument, index: CatalogIndex): PanelDocument {
  const links = linkedRows(doc, index);
  const byId = new Map(doc.rows.map((row) => [row.id, row] as const));
  const prune = new Set<string>();
  for (const module of enclosureModules(doc)) {
    for (const [key, ref] of resolvableRails(module, index)) {
      const rowId = railRowId(links, module, key);
      const row = rowId ? byId.get(rowId) : undefined;
      if (row && row.devices.length === 0 && row.label === generatedRowLabel(module, ref.zone, ref.rail)) prune.add(row.id);
    }
  }
  if (prune.size === 0) return doc;
  const kept = { ...doc, rows: doc.rows.filter((row) => !prune.has(row.id)) };
  return withModules(kept, (modules) =>
    modules.map((module) => {
      const rails = Object.entries(module.rails ?? {}).filter(([, rowId]) => !prune.has(rowId));
      return rails.length === Object.keys(module.rails ?? {}).length ? module : { ...module, rails: Object.fromEntries(rails) };
    }),
  );
}

/**
 * Finish an op: normalise, order the rows physically, prune, refuse past
 * the row cap, then keep every circuit's feed (`created` devices are new and
 * have no feed to keep).
 */
export function finish(
  before: PanelDocument,
  after: PanelDocument,
  index: CatalogIndex,
  extra: { created?: Iterable<string>; moduleId?: string; deviceId?: string } = {},
): OpResult {
  const ordered = pruneEmptyRailRows(withPhysicalOrder(normalizeEnclosure(after), index), index);
  if (ordered.rows.length > MAX_ROWS && ordered.rows.length > before.rows.length) return refuse(TOO_MANY_ROWS);
  const { document, pinned, regrouped } = preserveFeeds(before, ordered, new Set(extra.created ?? []));
  return {
    ok: true,
    document,
    pinned,
    regrouped,
    ...(extra.moduleId ? { moduleId: extra.moduleId } : {}),
    ...(extra.deviceId ? { deviceId: extra.deviceId } : {}),
  };
}
