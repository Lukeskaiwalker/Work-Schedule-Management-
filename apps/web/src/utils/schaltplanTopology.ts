/**
 * Topology + legend derivation for the Verteilerplan editor.
 *
 * The TypeScript twin of `build_topology` / `build_legend` /
 * `validate_document` in `apps/api/app/services/schaltplan_layout.py`. The
 * backend stays authoritative — what it returns on save is what gets printed
 * — but the editor derives the same values locally so the diagram, the
 * legend tab and the warnings all update on every keystroke instead of on
 * every round trip. On a site connection that is the difference between a
 * usable editor and an unusable one.
 *
 * The rule, in one sentence: a circuit belongs to the last protective device
 * placed before it, unless it names a different one via `parent_id`.
 */

import { catalogEntry } from "./schaltplanDevices";
import type {
  PanelDevice,
  PanelDocument,
  PanelFinding,
  PanelGroup,
  PanelLegendRow,
} from "../types/schaltplan";

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

export function buildTopology(document: PanelDocument): PanelGroup[] {
  const devices = allDevices(document);
  const groupIds = new Set(devices.filter(isGroupDevice).map((device) => device.id));

  const groups: PanelGroup[] = [];
  const indexByGroupId = new Map<string, number>();
  const supplyGroup: PanelGroup = { device: null, children: [] };
  let current: PanelGroup = supplyGroup;

  for (const device of devices) {
    if (isGroupDevice(device)) {
      current = { device, children: [] };
      groups.push(current);
      indexByGroupId.set(device.id, groups.length - 1);
      continue;
    }
    if (!isCircuitDevice(device)) continue;

    const explicit = device.parent_id;
    if (explicit) {
      if (groupIds.has(explicit)) {
        groups[indexByGroupId.get(explicit)!].children.push(device);
      } else {
        // The FI it named is gone. Show it as unprotected — visible and
        // fixable — rather than silently re-homing it.
        supplyGroup.children.push(device);
      }
      continue;
    }
    current.children.push(device);
  }

  if (supplyGroup.children.length > 0) groups.unshift(supplyGroup);
  return groups;
}

function rcdSummary(device: PanelDevice | null): string {
  if (!device) return "—";
  if (device.kind !== "rcd") return "—";
  const parts = [device.residual_current.trim(), device.rcd_type.trim()].filter(Boolean);
  if (parts.length === 0) return "FI";
  return parts.length === 2 ? `${parts[0]} / Typ ${parts[1]}` : parts[0];
}

function ownRcd(device: PanelDevice, inherited: string): string {
  if (device.kind !== "rcbo") return inherited;
  const parts = [device.residual_current.trim(), device.rcd_type.trim()].filter(Boolean);
  if (parts.length === 2) return `${parts[0]} / Typ ${parts[1]}`;
  return parts[0] || "FI/LS";
}

export function buildLegend(document: PanelDocument): PanelLegendRow[] {
  const rows: PanelLegendRow[] = [];
  for (const group of buildTopology(document)) {
    const inherited = rcdSummary(group.device);
    const groupLabel = group.device
      ? `${group.device.designation} ${catalogEntry(group.device.kind).short}`.trim()
      : "Direkt von Einspeisung";
    for (const device of group.children) {
      rows.push({
        circuit: device.circuit.trim(),
        designation: device.designation.trim(),
        label: device.label.trim(),
        room: device.room.trim(),
        device: catalogEntry(device.kind).short,
        rating: device.rating.trim(),
        rcd: ownRcd(device, inherited),
        cable: device.cable.trim(),
        phase: device.phase === "-" ? "" : device.phase,
        group: groupLabel,
        note: device.note.trim(),
      });
    }
  }
  return rows;
}

export function validateDocument(document: PanelDocument): PanelFinding[] {
  const findings: PanelFinding[] = [];

  for (const row of document.rows) {
    const used = row.devices.reduce((total, device) => total + Math.max(1, device.te || 1), 0);
    if (used > row.slots) {
      findings.push({
        level: "warn",
        scope: row.id,
        message: `${row.label || "Reihe"}: ${used} TE belegt, aber nur ${row.slots} TE vorhanden.`,
      });
    }
  }

  const circuitCounts = new Map<string, number>();
  for (const device of allDevices(document)) {
    if (!isCircuitDevice(device)) continue;
    const circuit = device.circuit.trim();
    if (!circuit) {
      findings.push({
        level: "info",
        scope: device.id,
        message: `${device.label.trim() || "Stromkreis"}: keine Stromkreis-Nr. vergeben.`,
      });
    } else {
      circuitCounts.set(circuit, (circuitCounts.get(circuit) ?? 0) + 1);
    }
    if (!device.cable.trim()) {
      findings.push({
        level: "info",
        scope: device.id,
        message: `Stromkreis ${circuit || "?"}: keine Leitung angegeben.`,
      });
    }
  }

  for (const [circuit, count] of circuitCounts) {
    if (count > 1) {
      findings.push({
        level: "warn",
        scope: "",
        message: `Stromkreis-Nr. ${circuit} ist ${count}× vergeben.`,
      });
    }
  }

  for (const group of buildTopology(document)) {
    if (group.device === null && group.children.length > 0) {
      findings.push({
        level: "warn",
        scope: "",
        message: `${group.children.length} Stromkreis(e) ohne vorgeschalteten FI-Schutzschalter.`,
      });
    }
  }

  return findings;
}

export function documentStats(document: PanelDocument) {
  const devices = allDevices(document);
  return {
    deviceCount: devices.length,
    circuitCount: devices.filter(isCircuitDevice).length,
    rcdCount: devices.filter((device) => device.kind === "rcd" || device.kind === "rcbo").length,
    usedSlots: devices.reduce((total, device) => total + Math.max(1, device.te || 1), 0),
    totalSlots: document.rows.reduce((total, row) => total + row.slots, 0),
  };
}
