/**
 * No silent re-feeding (docs/PANEL_ENCLOSURE.md D4, §2.4).
 *
 * The topology is "device order across rows": a circuit without a
 * `parent_id` hangs off the last group head before it. Every cabinet op
 * reorders rows (the electrical reading order follows the cabinet), so
 * without this module placing or moving a field could quietly move a
 * breaker from FI F1 to a Hauptschalter. Each op therefore compares the feed
 * of every circuit before and after, pins what it can to its old head, and
 * reports the rest for confirmation.
 *
 * Pinning is safe by construction: an explicit `parent_id` only affects its
 * own device, and the head it names was already a head.
 */

import { buildTopology } from "./schaltplanTopologyCore";
import type { PanelDocument } from "../types/schaltplan";

/** A circuit whose feed changes and cannot be pinned. Head ids; "" = straight from the Einspeisung. */
export interface Regroup {
  deviceId: string;
  from: string;
  to: string;
}

/** circuit device id → id of the group head it hangs off ("" = direkt von der Einspeisung). */
export function feedMap(doc: PanelDocument): Map<string, string> {
  const feeds = new Map<string, string>();
  for (const group of buildTopology(doc)) {
    for (const child of group.children) feeds.set(child.id, group.device?.id ?? "");
  }
  return feeds;
}

function groupHeads(doc: PanelDocument): Set<string> {
  return new Set(buildTopology(doc).flatMap((group) => (group.device ? [group.device.id] : [])));
}

/**
 * Keep every circuit's feed across an op. For each circuit in both documents,
 * not in `created`, whose feed differs: an old head that is still a head in
 * `after` is written into the circuit's `parent_id` (listed in `pinned`);
 * anything else (old head gone, or the old feed was the Einspeisung) is
 * listed in `regrouped` for the UI to confirm. Returns a new document only
 * when something was pinned.
 */
export function preserveFeeds(
  before: PanelDocument,
  after: PanelDocument,
  created: ReadonlySet<string>,
): { document: PanelDocument; pinned: string[]; regrouped: Regroup[] } {
  const old = feedMap(before);
  const now = feedMap(after);
  const heads = groupHeads(after);
  const pins = new Map<string, string>();
  const regrouped: Regroup[] = [];
  for (const row of after.rows) {
    for (const device of row.devices) {
      const from = old.get(device.id);
      const to = now.get(device.id);
      if (from === undefined || to === undefined || from === to || created.has(device.id)) continue;
      if (from !== "" && heads.has(from)) pins.set(device.id, from);
      else regrouped.push({ deviceId: device.id, from, to });
    }
  }
  if (pins.size === 0) return { document: after, pinned: [], regrouped };
  const document: PanelDocument = {
    ...after,
    rows: after.rows.map((row) =>
      row.devices.some((device) => pins.has(device.id))
        ? { ...row, devices: row.devices.map((device) => (pins.has(device.id) ? { ...device, parent_id: pins.get(device.id)! } : device)) }
        : row,
    ),
  };
  return { document, pinned: [...pins.keys()], regrouped };
}
