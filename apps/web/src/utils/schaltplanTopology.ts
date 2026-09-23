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
 * The builder itself lives in `schaltplanTopologyCore.ts` and is re-exported
 * here: the legend's "Klemmen" column needs the Reihenklemmen derivation,
 * and the derivation needs the builder, so the builder sits one module
 * below both (the backend's `build_legend` breaks the same cycle with a
 * local import).
 */

import { catalogEntry } from "./schaltplanDevices";
import { terminalFindings } from "./schaltplanTerminalRules";
import { deriveTerminals, deviceTerminalLabels } from "./schaltplanTerminals";
import {
  allDevices,
  buildTopology,
  isCircuitDevice,
  isGroupDevice,
  isFeederFuse,
  opensGroup,
} from "./schaltplanTopologyCore";
import type { PanelDevice, PanelDocument, PanelFinding, PanelGroup, PanelLegendRow } from "../types/schaltplan";

export {
  allDevices,
  buildTopology,
  feederFuseIds,
  findDevice,
  findRowOf,
  isCircuitDevice,
  isGroupDevice,
  neighbourDeviceId,
  opensGroup,
} from "./schaltplanTopologyCore";

// ── Legend ───────────────────────────────────────────────────────────────────

function preFuseSummary(fuse: PanelDevice | null): string {
  if (!fuse) return "—";
  const parts = [fuse.designation.trim(), fuse.rating.trim()].filter(Boolean);
  return parts.join(" ") || "Si";
}

/** The fuse a group's circuits sit behind: the head itself when it is one, else the FI's Vorsicherung. */
function groupFuse(group: PanelGroup): PanelDevice | null {
  if (group.device?.kind === "fuse") return group.device;
  return group.preFuse;
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
  // "X1.1, X1.2" — the Reihenklemmen a circuit ends on, from the same
  // derivation the Klemmen tab and the print sheet use.
  const terminalLabels = deviceTerminalLabels(deriveTerminals(document));
  for (const group of buildTopology(document)) {
    const inherited = rcdSummary(group.device);
    const preFuse = preFuseSummary(groupFuse(group));
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
        pre_fuse: preFuse,
        note: device.note.trim(),
        terminals: (terminalLabels[device.id] ?? []).join(", "),
      });
    }
  }
  return rows;
}

// ── Validation ───────────────────────────────────────────────────────────────

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
    // A fuse that heads a group is protection, not a load: no legend row,
    // so no Stromkreis-Nr./Leitung nag and no part in the duplicate count.
    if (!isCircuitDevice(device) || opensGroup(device, document)) continue;
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

  const groups = buildTopology(document);
  for (const group of groups) {
    // Only a catalogue group reads its parent_id as a Vorsicherung; a
    // fuse-headed group's parent_id is not a reference at all.
    if (group.device && isGroupDevice(group.device) && group.device.parent_id && group.preFuse === null) {
      findings.push({
        level: "info",
        scope: group.device.id,
        message: `${group.device.designation.trim() || "FI"}: Vorsicherung nicht gefunden (die angegebene Sicherung fehlt oder ist keine Sicherung).`,
      });
    }
    // A flagged fuse with nothing behind it is a flag set on the wrong
    // device, or a rail not yet filled in — either way worth a glance.
    // The flag claims the rail after the fuse. A circuit naming the fuse from
    // elsewhere is fed by it anyway, so only positional children (those without
    // a parent_id of their own) show the flag doing any work.
    const positional = group.children.filter((child) => !child.parent_id);
    if (group.device && isFeederFuse(group.device) && positional.length === 0) {
      findings.push({
        level: "info",
        scope: group.device.id,
        message: `${group.device.designation.trim() || "Sicherung"}: Vorsicherung speist keine Abgänge`,
      });
    }
    if (group.device === null && group.children.length > 0) {
      findings.push({
        level: "warn",
        scope: "",
        message: `${group.children.length} Stromkreis(e) ohne vorgeschalteten FI-Schutzschalter.`,
      });
    }
  }

  // Reihenklemmen: a group without an FI that still wants terminals, and
  // pole counts the Etagenklemmen round. Info, not warn — see the rules.
  findings.push(...terminalFindings(groups));

  return findings;
}

export function documentStats(document: PanelDocument) {
  const devices = allDevices(document);
  return {
    deviceCount: devices.length,
    // A fuse heading a group is protection, not a load (mirrors document_stats).
    circuitCount: devices.filter((device) => isCircuitDevice(device) && !opensGroup(device, document)).length,
    rcdCount: devices.filter((device) => device.kind === "rcd" || device.kind === "rcbo").length,
    usedSlots: devices.reduce((total, device) => total + Math.max(1, device.te || 1), 0),
    totalSlots: document.rows.reduce((total, row) => total + row.slots, 0),
  };
}
