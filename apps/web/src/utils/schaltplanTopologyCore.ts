/**
 * Protection groups — the topology builder of the Verteilerplan editor.
 *
 * The TypeScript twin of `build_topology` in
 * `apps/api/app/services/schaltplan_layout.py`. Split out of
 * `schaltplanTopology.ts` so the Reihenklemmen derivation
 * (`schaltplanTerminals.ts`) can build groups without importing the legend,
 * which in turn needs the derivation for its "Klemmen" column — the same
 * reason the backend's `build_legend` imports `derive_terminals` locally.
 * Everything here is re-exported from `schaltplanTopology.ts`, which stays
 * the module callers import.
 *
 * The rule, in one sentence: a circuit belongs to the last protective device
 * placed before it, unless it names a different one via `parent_id`.
 *
 * "Protective device" is wider than the catalogue's `group` flag. A Neozed
 * block feeding an RCBO row, or a row of MCBs that needs no FI, is one too —
 * see `opensGroup`. The catalogue flag stays what it is (`isGroupDevice`);
 * the builder asks both.
 */

import { catalogEntry } from "./schaltplanDevices";
import type { PanelDevice, PanelDocument, PanelGroup } from "../types/schaltplan";

export function isGroupDevice(device: PanelDevice): boolean {
  return catalogEntry(device.kind).group;
}

export function isCircuitDevice(device: PanelDevice): boolean {
  return catalogEntry(device.kind).circuit;
}

export function allDevices(document: PanelDocument): PanelDevice[] {
  return document.rows.flatMap((row) => row.devices);
}

export function findDevice(document: PanelDocument, deviceId: string | null): PanelDevice | null {
  if (!deviceId) return null;
  for (const row of document.rows) {
    const hit = row.devices.find((device) => device.id === deviceId);
    if (hit) return hit;
  }
  return null;
}

export function findRowOf(document: PanelDocument, deviceId: string): string | null {
  for (const row of document.rows) {
    if (row.devices.some((device) => device.id === deviceId)) return row.id;
  }
  return null;
}

// ── Fuses that feed circuits directly ────────────────────────────────────────

/** A fuse the user flagged: it captures the rail after it like an FI (C2a). */
export function isFeederFuse(device: PanelDevice): boolean {
  return device.kind === "fuse" && device.feeds_following === true;
}

/**
 * Ids of every fuse that at least one circuit device names as its parent
 * (C2b). Twin of `feeder_fuse_ids` on the backend. A circuit device is one
 * whose catalogue entry says circuit and not group — an RCBO, an MCB, a
 * contactor; never an FI.
 */
export function feederFuseIds(document: PanelDocument): Set<string> {
  const devices = allDevices(document);
  const fuseIds = new Set(devices.filter((device) => device.kind === "fuse").map((device) => device.id));
  const named = new Set<string>();
  for (const device of devices) {
    // A fuse's own parent_id is never read by the topology, so it must not
    // promote the fuse it names either: on the ordinary NH → Neozed → FI board
    // that would conjure an empty group and drop the NH's own legend row.
    if (!isCircuitDevice(device) || isGroupDevice(device) || device.kind === "fuse") continue;
    const parent = device.parent_id;
    // A fuse pointing at itself is ignored, like every self-reference here.
    if (!parent || parent === device.id) continue;
    if (fuseIds.has(parent)) named.add(parent);
  }
  return named;
}

/**
 * The device before/after `deviceId` in physical order — row by row, left to
 * right, crossing row boundaries — or null at either end and for an unknown
 * id. This is the order the rail editor draws, so "next" means the tile to
 * the right (or the first tile of the next rail).
 */
export function neighbourDeviceId(
  document: PanelDocument,
  deviceId: string | null,
  direction: -1 | 1,
): string | null {
  if (!deviceId) return null;
  const order = allDevices(document).map((device) => device.id);
  const index = order.indexOf(deviceId);
  if (index < 0) return null;
  return order[index + direction] ?? null;
}

function fuseOpensGroup(device: PanelDevice, feeders: ReadonlySet<string>): boolean {
  return device.kind === "fuse" && (isFeederFuse(device) || feeders.has(device.id));
}

/**
 * Does this device head a group of its own although the catalogue says it
 * does not? True for a fuse that is flagged `feeds_following`, or that a
 * circuit points at via `parent_id`. Twin of `opens_group` on the backend.
 *
 * `isGroupDevice` stays catalogue-based on purpose; the two are combined
 * only where the topology is built.
 */
export function opensGroup(device: PanelDevice, document: PanelDocument): boolean {
  return fuseOpensGroup(device, feederFuseIds(document));
}

// ── Topology ─────────────────────────────────────────────────────────────────

export function buildTopology(document: PanelDocument): PanelGroup[] {
  const devices = allDevices(document);
  const feeders = feederFuseIds(document);

  // Two passes on purpose. Placement order is physical; `parent_id` is
  // electrical, and the two may disagree — a circuit can name a group device
  // that sits to its RIGHT on the rail. A single walk that indexed a group
  // only on reaching it, plus a `!` on the lookup, turned exactly that case
  // (an RCBO parented to a Hauptschalter one slot later) into
  // `undefined.children` mid-render and took the page down. Register every
  // group first; then no explicit reference can be ahead of the index.
  const groups: PanelGroup[] = [];
  const indexByGroupId = new Map<string, number>();
  for (const device of devices) {
    if (!isGroupDevice(device) && !fuseOpensGroup(device, feeders)) continue;
    groups.push({ device, preFuse: null, children: [] });
    indexByGroupId.set(device.id, groups.length - 1);
  }

  // A catalogue group device naming a parent means one thing: the Neozed/NH
  // block that feeds it. That fuse is a FEEDER, not a load — it leaves the
  // circuit walk and shows on the legend as the upstream protection of the
  // whole group. Only kind "fuse" qualifies; anything else degrades to none
  // and is reported by validateDocument.
  //
  // Unless the fuse also opens a group of its own: then it is drawn twice —
  // as the plate above the FI and as its own group — and stays in the walk.
  // A fuse-headed group never has a plate: its own parent_id is not a
  // pre-fuse reference.
  const byId = new Map(devices.map((device) => [device.id, device] as const));
  const consumedFuses = new Set<string>();
  for (const group of groups) {
    if (!group.device || !isGroupDevice(group.device)) continue;
    const parent = group.device.parent_id ?? "";
    const candidate = parent ? byId.get(parent) : undefined;
    if (candidate && candidate.kind === "fuse") {
      group.preFuse = candidate;
      if (!fuseOpensGroup(candidate, feeders)) consumedFuses.add(candidate.id);
    }
  }

  const supplyGroup: PanelGroup = { device: null, preFuse: null, children: [] };
  let current: PanelGroup = supplyGroup;

  for (const device of devices) {
    if (consumedFuses.has(device.id)) continue;
    const ownGroup = indexByGroupId.get(device.id);
    if (ownGroup !== undefined) {
      // Implicit parenting still follows physical order: what comes after
      // this device, without a parent_id of its own, is fed by it. A fuse
      // that opens a group only because a circuit names it is a head too,
      // but leaves `current` alone — a Neozed sitting in a row must not
      // silently take the row's MCBs off their FI.
      if (isGroupDevice(device) || isFeederFuse(device)) current = groups[ownGroup];
      continue;
    }
    if (!isCircuitDevice(device)) continue;

    const explicit = device.parent_id;
    if (explicit) {
      const index = indexByGroupId.get(explicit);
      if (index !== undefined) {
        groups[index].children.push(device);
      } else {
        // The FI it named is gone. Show it as unprotected — visible and
        // fixable — rather than silently re-homing it. And never let a
        // lookup miss become a crashed page.
        supplyGroup.children.push(device);
      }
      continue;
    }
    current.children.push(device);
  }

  if (supplyGroup.children.length > 0) groups.unshift(supplyGroup);
  return groups;
}

