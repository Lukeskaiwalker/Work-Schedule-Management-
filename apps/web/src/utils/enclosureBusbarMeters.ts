/**
 * Which meter feeds a customer busbar (R4-11, docs/PANEL_ENCLOSURE_R4.md
 * §3.3) — the TypeScript twin of
 * `apps/api/app/services/panel_enclosure_busbar_meters.py`, pinned through
 * the fixture's `prep` and `findings` (board `two_meters_busbar_zb34s`).
 *
 * A customer Sammelschiene is gezählt: the distribution behind one meter.
 * Two of them side by side are joined only when the same meter feeds both —
 * a ZZ55SAVE between the busbars of two meters would put two metered
 * distributions in parallel, around a meter.
 *
 * The meter of a module = for every device on the module's live rails,
 * follow the feed upward (a circuit to the group that holds it, a group to
 * the device feeding it, `buildTopology`) to the first Hauptschalter or SLS;
 * the module holding that switch, when it is a meter module, is the meter.
 * A module collects every meter its devices lead to: none (unknown), one, or
 * several (a mix the planner made). Pure.
 */

import { METER_FAMILIES, type CatalogIndex } from "./enclosureCatalog";
import { ident, linkedRails, moduleRails, moduleSpec, modulesOf, rowDevices, rowsOf } from "./enclosureTerminals";
import { buildTopology } from "./schaltplanTopologyCore";
import type { EnclosureModule } from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

/** Where the upward walk stops: the switch behind a meter. */
const SWITCH_KINDS: ReadonlySet<string> = new Set(["hauptschalter", "sls"]);

/** What the walk needs, built once per board. */
export interface FeedIndex {
  /** device id → the device feeding it. */
  up: ReadonlyMap<string, PanelDevice>;
  /** device id → row id. */
  rowOf: ReadonlyMap<string, string>;
  /** row id → (module id, rail key) of its live rail. */
  linked: ReadonlyMap<string, { moduleId: string; railKey: string }>;
  meterModules: ReadonlySet<string>;
  rows: ReadonlyMap<string, PanelRow>;
}

/** device id → its feeder, over the readable rows (as the Python twin builds them). */
function upstream(rows: readonly PanelRow[]): Map<string, PanelDevice> {
  const readable = { rows: rows.map((row) => ({ ...row, devices: rowDevices(row) })) } as unknown as PanelDocument;
  const up = new Map<string, PanelDevice>();
  for (const group of buildTopology(readable)) {
    const head = group.device;
    if (!head) continue;
    for (const child of group.children) {
      const childId = ident(child.id);
      if (childId && !up.has(childId)) up.set(childId, head);
    }
    const headId = ident(head.id);
    if (group.fedBy && headId) up.set(headId, group.fedBy);
  }
  return up;
}

export function feedIndex(doc: unknown, index: CatalogIndex): FeedIndex {
  const readable = rowsOf(doc);
  const rows = new Map(readable.map((row) => [row.id, row] as const));
  const rowOf = new Map<string, string>();
  for (const row of readable) {
    for (const device of rowDevices(row)) {
      const deviceId = ident(device.id);
      if (deviceId && !rowOf.has(deviceId)) rowOf.set(deviceId, row.id);
    }
  }
  const meterModules = new Set<string>();
  for (const module of modulesOf(doc)) {
    const spec = moduleSpec(module, index);
    if (spec && METER_FAMILIES.has(spec.family)) meterModules.add(ident(module.id));
  }
  const linked = new Map<string, { moduleId: string; railKey: string }>();
  for (const [rowId, link] of linkedRails(doc, index)) linked.set(rowId, { moduleId: ident(link.module.id), railKey: String(link.rail.key) });
  return { up: upstream(readable), rowOf, linked, meterModules, rows };
}

function switchOf(device: PanelDevice, feeds: FeedIndex): PanelDevice | null {
  const seen = new Set<string>();
  let node: PanelDevice | undefined = device;
  while (node) {
    const nodeId = ident(node.id);
    if (seen.has(nodeId)) return null;
    seen.add(nodeId);
    if (SWITCH_KINDS.has(String(node.kind || ""))) return node;
    node = feeds.up.get(nodeId);
  }
  return null;
}

function meterOf(device: PanelDevice, feeds: FeedIndex): string | null {
  const found = switchOf(device, feeds);
  if (!found) return null;
  const link = feeds.linked.get(feeds.rowOf.get(ident(found.id)) ?? "");
  return link && feeds.meterModules.has(link.moduleId) ? link.moduleId : null;
}

/** The meter modules (by id, sorted) the devices on a module's live rails are fed through. */
export function moduleMeters(module: EnclosureModule, feeds: FeedIndex): string[] {
  const moduleId = ident(module.id);
  const found = new Set<string>();
  for (const [key, rowId] of moduleRails(module)) {
    const link = feeds.linked.get(rowId);
    if (!link || link.moduleId !== moduleId || link.railKey !== key) continue;
    for (const device of rowDevices(feeds.rows.get(rowId))) {
      const meter = meterOf(device, feeds);
      if (meter !== null) found.add(meter);
    }
  }
  return [...found].sort();
}

/** Both known and not the one same meter: never join. */
export function differentMeters(a: readonly string[], b: readonly string[]): boolean {
  return a.length > 0 && b.length > 0 && !(a.length === 1 && b.length === 1 && a[0] === b[0]);
}

/** One side's meter is unknown: a joint is planned, but unverified. */
export const meterUnknown = (a: readonly string[], b: readonly string[]): boolean => a.length === 0 || b.length === 0;
