/**
 * Device drops in the cabinet — the long-press drag, the RailPicker's
 * position step and, through `followPosition`, the inspector arrows
 * (docs/PANEL_ENCLOSURE_R2.md §6.4, R10, R19).
 *
 * A drop is POSITIONAL: the device lands at an index of the target rail and
 * then belongs to whatever protects that spot — "it follows its position,
 * regrouped like the arrow buttons" (owner, O1). Nothing is re-sorted and
 * nothing is pinned, unlike the module ops (`preserveFeeds`): every feed the
 * drop changes is listed in `changes`, and the drop note offers Rückgängig.
 *
 * One rule decides a moved circuit's `parent_id` (`followPosition`): it is
 * cleared only when the circuit's POSITIONAL head differs between the old
 * and the new spot. A nudge inside a run keeps a deliberate cross-feed; a
 * circuit dragged into another head's run follows that head; a head keeps
 * its own feeder link.
 *
 * A group head (FI, Hauptschalter, flagged Neozed …) drags WITH its
 * circuits (owner, 2026-10-22, overriding R18's "FI alone"): every circuit
 * it feeds in its own field — by position or pinned to it from another
 * run — travels as one block right behind it, so its Klemmleiste stays
 * whole. A circuit of the group in another field (a deliberate cross-field
 * feed, or a run that spills over the field line) stays where it is: the
 * installer drags the FI block he sees, not wires in another field.
 *
 * The board must be in cabinet order (R19): with `rows[]` out of order the
 * feed would follow `rows[]`, not the drawn position, and the drop would
 * silently not do what the drawing shows.
 */

import { feedMap } from "./enclosureFeeds";
import { moduleArticle, type CatalogIndex } from "./enclosureCatalog";
import { linkedRows, physicalRowOrder, resolvableRails } from "./enclosureLayout";
import {
  DEVICE_NOT_FOUND,
  ensureRailRow,
  findModule,
  mapDevices,
  MODULE_NOT_FOUND,
  moveDevicesInto,
  normalizeEnclosure,
  pruneEmptyRailRows,
  railRetired,
  railUnknown,
  TOO_MANY_ROWS,
} from "./enclosureOpsCore";
import { MAX_ROWS } from "./schaltplanDevices";
import { findDevice, isCircuitDevice, isFeederFuse, isGroupDevice, opensGroup } from "./schaltplanTopologyCore";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

// ── Copy (§13) ───────────────────────────────────────────────────────────────

export const TERMINAL_RAIL_RESERVED = "Diese Hutschiene ist für Reihenklemmen reserviert.";
export const ROWS_OUT_OF_ORDER = "Reihen sind nicht in Schrankreihenfolge — erst „Reihen ordnen“.";

// ── Types ────────────────────────────────────────────────────────────────────

/** A circuit whose feed the drop changed. Head ids; "" = straight from the Einspeisung. */
export interface FeedChange {
  deviceId: string;
  from: string;
  to: string;
}

export type DropResult =
  | { ok: true; document: PanelDocument; deviceId: string; changes: FeedChange[]; unchanged: boolean }
  | { ok: false; error: string };

/** Where a device goes: a rail, and its index among the rail's OTHER devices (after the moved ones left). */
export interface DropTarget {
  moduleId: string;
  railKey: string;
  at: number;
}

export interface DropOptions {
  /** Rails reserved for WAGO terminals, as `reservedRailKey` (empty until W3 passes `terminalRailKeys`). */
  reserved?: ReadonlySet<string>;
}

/** "moduleId:railKey" — the key of a reserved rail (`terminalRailKeys`). */
export function reservedRailKey(moduleId: string, railKey: string): string {
  return `${moduleId}:${railKey}`;
}

const NONE: ReadonlySet<string> = new Set();

// ── Heads and positions ──────────────────────────────────────────────────────

/** Takes over the run after it in the topology walk (`buildTopology`'s `current`). */
function startsRun(device: PanelDevice): boolean {
  return isGroupDevice(device) || isFeederFuse(device);
}

/** A group head: a catalogue group device, or a fuse that opens a group (flagged, or named by a circuit). */
export function isGroupHead(device: PanelDevice, doc: PanelDocument): boolean {
  return isGroupDevice(device) || opensGroup(device, doc);
}

/**
 * The head a device would hang off by position alone — the last device
 * before it, in reading order, that takes over the run — ignoring the
 * device's own `parent_id`. "" before the first head (the Einspeisung),
 * null for a device the board does not hold.
 */
export function positionalHead(doc: PanelDocument, deviceId: string): string | null {
  let head = "";
  for (const row of doc.rows) {
    for (const device of row.devices) {
      if (device.id === deviceId) return head;
      if (startsRun(device)) head = device.id;
    }
  }
  return null;
}

/**
 * R10, the one regroup rule. `after` itself unless the moved circuit has an
 * explicit `parent_id`, is no head, and changed positional head — then a
 * copy with that `parent_id` cleared, so the circuit follows its new spot.
 */
export function followPosition(before: PanelDocument, after: PanelDocument, deviceId: string): PanelDocument {
  const device = findDevice(after, deviceId);
  // Only a circuit's parent_id is a feed; a head's is its feeder link and stays.
  if (!device || !device.parent_id || !isCircuitDevice(device) || isGroupHead(device, after)) return after;
  const was = positionalHead(before, deviceId);
  if (was === null || was === positionalHead(after, deviceId)) return after;
  return mapDevices(after, (candidate) => (candidate.id === deviceId ? { ...candidate, parent_id: null } : candidate));
}

/** Every circuit whose derived feed differs between the two boards, in reading order. */
export function feedChanges(before: PanelDocument, after: PanelDocument): FeedChange[] {
  const old = feedMap(before);
  const now = feedMap(after);
  const changes: FeedChange[] = [];
  for (const row of after.rows) {
    for (const device of row.devices) {
      const from = old.get(device.id);
      const to = now.get(device.id);
      if (from !== undefined && to !== undefined && from !== to) changes.push({ deviceId: device.id, from, to });
    }
  }
  return changes;
}

// ── What travels ─────────────────────────────────────────────────────────────

/** device id → cabinet field of the rail its row hangs on (resolvable rails only). */
function deviceFields(doc: PanelDocument, index: CatalogIndex): Map<string, number> {
  const links = linkedRows(doc, index);
  const fields = new Map<string, number>();
  for (const row of doc.rows) {
    const link = links.get(row.id);
    const module = link ? findModule(doc, link.moduleId) : null;
    const ref = link && module ? resolvableRails(module, index).get(link.railKey) : undefined;
    if (!module || !ref) continue;
    for (const device of row.devices) fields.set(device.id, module.field + ref.zone.field);
  }
  return fields;
}

/**
 * The devices one drag moves: a circuit (or any non-head) alone; a group
 * head first, then every circuit it feeds that sits in the head's own field
 * (outside the cabinet: every one outside it), in reading order — the
 * group as §4.2's "move circuits" names it. [] for a device the board does
 * not hold.
 */
export function dragGroup(doc: PanelDocument, index: CatalogIndex, deviceId: string): string[] {
  const device = findDevice(doc, deviceId);
  if (!device) return [];
  if (!isGroupHead(device, doc)) return [deviceId];
  const feeds = feedMap(doc);
  const fields = deviceFields(doc, index);
  const field = fields.get(deviceId);
  const circuits = doc.rows
    .flatMap((row) => row.devices)
    .filter((candidate) => candidate.id !== deviceId && feeds.get(candidate.id) === deviceId && fields.get(candidate.id) === field);
  return [deviceId, ...circuits.map((candidate) => candidate.id)];
}

// ── The drop ─────────────────────────────────────────────────────────────────

function refuse(error: string): DropResult {
  return { ok: false, error };
}

/** R19: `rows[]` stand in the cabinet's reading order (what "Reihen ordnen" makes). */
export function rowsInCabinetOrder(doc: PanelDocument, index: CatalogIndex): boolean {
  const order = physicalRowOrder(doc, index);
  return order.length === doc.rows.length && order.every((id, position) => doc.rows[position]?.id === id);
}

function sameDeviceOrder(a: PanelDocument, b: PanelDocument): boolean {
  return (
    a.rows.length === b.rows.length &&
    a.rows.every((row, i) => row.id === b.rows[i].id && row.devices.length === b.rows[i].devices.length && row.devices.every((device, k) => device.id === b.rows[i].devices[k].id))
  );
}

/** Why the target rail takes nothing, or null. */
function targetRefusal(doc: PanelDocument, index: CatalogIndex, target: DropTarget, reserved: ReadonlySet<string>): string | null {
  const module = findModule(doc, target.moduleId);
  if (!module) return MODULE_NOT_FOUND;
  const ref = resolvableRails(module, index).get(target.railKey);
  if (!ref) return railUnknown(target.railKey, moduleArticle(module, index));
  if (ref.rail.retired) return railRetired(target.railKey, moduleArticle(module, index));
  if (reserved.has(reservedRailKey(target.moduleId, target.railKey))) return TERMINAL_RAIL_RESERVED;
  if (!rowsInCabinetOrder(doc, index)) return ROWS_OUT_OF_ORDER;
  return null;
}

/**
 * Drag and RailPicker: the device (a head with its circuits) goes to
 * `target.at` on the target rail. Positional (R10): no physical re-sort,
 * no pinning. The same place again is `unchanged` with the very same
 * document, so the editor saves nothing.
 */
export function dropDevice(doc: PanelDocument, index: CatalogIndex, deviceId: string, target: DropTarget, opts: DropOptions = {}): DropResult {
  if (!findDevice(doc, deviceId)) return refuse(DEVICE_NOT_FOUND);
  const refusal = targetRefusal(doc, index, target, opts.reserved ?? NONE);
  if (refusal) return refuse(refusal);
  const rail = ensureRailRow(doc, index, target.moduleId, target.railKey);
  if ("error" in rail) return refuse(rail.error);
  const group = dragGroup(doc, index, deviceId);
  const moved = moveDevicesInto(rail.document, group, rail.rowId, target.at);
  if (rail.document === doc && sameDeviceOrder(doc, moved)) return { ok: true, document: doc, deviceId, changes: [], unchanged: true };
  const followed = group.reduce((current, id) => followPosition(doc, current, id), moved);
  const tidy = normalizeEnclosure(pruneEmptyRailRows(followed, index));
  if (tidy.rows.length > MAX_ROWS && tidy.rows.length > doc.rows.length) return refuse(TOO_MANY_ROWS);
  return { ok: true, document: tidy, deviceId, changes: feedChanges(doc, tidy), unchanged: false };
}
