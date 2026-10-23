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
import { NO_SKIP, isTerminalEligible, terminalFindings } from "./schaltplanTerminalRules";
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

/**
 * Whether "Reihenklemme am Abgang" applies to this device — the inspector's
 * checkbox and the Klemmen tab's bulk switch ask the same question. A fuse
 * qualifies only as an outgoing of its own: one that heads circuits, or is
 * the Vorsicherung of an FI/SLS/Hauptschalter, feeds others, and a flag on
 * it would turn into a 2016 block the day it stopped (review, 2026-10-09).
 * A device in the cabinet's skip set (an AAR, NAR, RfZ or APZ rail,
 * docs/PANEL_ENCLOSURE_R2.md §3.1) is offered nothing: the inspector says why.
 */
export function terminalOffered(device: PanelDevice, document: PanelDocument, skip: ReadonlySet<string> = NO_SKIP): boolean {
  if (!isTerminalEligible(device) || skip.has(device.id)) return false;
  if (device.kind !== "fuse") return true;
  const isPreFuse = allDevices(document).some((other) => isGroupDevice(other) && other.parent_id === device.id);
  return !opensGroup(device, document) && !isPreFuse;
}

// ── Legend ───────────────────────────────────────────────────────────────────

function preFuseSummary(fuse: PanelDevice | null): string {
  if (!fuse) return "—";
  const parts = [fuse.designation.trim(), fuse.rating.trim()].filter(Boolean);
  return parts.join(" ") || "Si";
}

/**
 * The fuse or SLS a group's circuits sit behind: the head itself when it is a
 * fuse, else its Vorsicherung, else up the feeding chain to the first group
 * with a Vorsicherung or the first SLS (owner, 2026-10-09: FI ← HS ← SLS
 * reads "Q0 SLS E35"). Twin of `_upstream_protection`.
 */
function upstreamProtection(group: PanelGroup, groupsByHead: ReadonlyMap<string, PanelGroup>): PanelDevice | null {
  if (group.device?.kind === "fuse") return group.device;
  if (group.preFuse) return group.preFuse;
  const seen = new Set<string>();
  let feeder = group.fedBy;
  while (feeder) {
    if (seen.has(feeder.id)) return null;
    seen.add(feeder.id);
    if (feeder.kind === "sls") return feeder;
    const feederGroup = groupsByHead.get(feeder.id);
    if (!feederGroup) return null;
    if (feederGroup.preFuse) return feederGroup.preFuse;
    feeder = feederGroup.fedBy;
  }
  return null;
}

/** "F0 35 A" for a fuse, "Q0 SLS E35" for an SLS, "—" for none. */
function upstreamSummary(device: PanelDevice | null): string {
  if (!device) return "—";
  if (device.kind === "sls") return [device.designation.trim(), "SLS", device.rating.trim()].filter(Boolean).join(" ");
  return preFuseSummary(device);
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

/** `skip`: the cabinet's skip set (docs/PANEL_ENCLOSURE_R2.md §3.1), so the X labels match the Klemmen tab. */
export function buildLegend(document: PanelDocument, skip: ReadonlySet<string> = NO_SKIP): PanelLegendRow[] {
  const rows: PanelLegendRow[] = [];
  // "X1.1, X1.2" — the Reihenklemmen a circuit ends on, from the same
  // derivation the Klemmen tab and the print sheet use.
  const terminalLabels = deviceTerminalLabels(deriveTerminals(document, skip));
  const groups = buildTopology(document);
  const groupsByHead = new Map(
    groups.filter((group) => group.device !== null).map((group) => [group.device!.id, group] as const),
  );
  for (const group of groups) {
    const inherited = rcdSummary(group.device);
    const preFuse = upstreamSummary(upstreamProtection(group, groupsByHead));
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

/** `skip`: the cabinet's skip set (§3.1), passed to the Reihenklemmen checks. */
export function validateDocument(document: PanelDocument, skip: ReadonlySet<string> = NO_SKIP): PanelFinding[] {
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
    if (group.device && group.feedCycle) {
      findings.push({
        level: "warn",
        scope: group.device.id,
        message: `${group.device.designation.trim() || catalogEntry(group.device.kind).short}: Einspeisung im Kreis — die Zuordnung wird ignoriert.`,
      });
    } else if (
      group.device &&
      isGroupDevice(group.device) &&
      group.device.parent_id &&
      group.preFuse === null &&
      group.fedBy === null
    ) {
      findings.push({
        level: "info",
        scope: group.device.id,
        message: `${group.device.designation.trim() || "FI"}: Einspeisung nicht gefunden (das angegebene Gerät fehlt oder kann nicht einspeisen — Sicherung, SLS, Hauptschalter oder Verteilerblock).`,
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
  findings.push(...terminalFindings(groups, skip));
  findings.push(...stripNameClashes(document, skip));

  return findings;
}

/** Rail devices that may carry a Klemmleiste's name: a "terminal" IS the strip's rail space, a blank prints nothing. */
const STRIP_NAMED_KINDS = new Set<PanelDevice["kind"]>(["terminal", "blank"]);

/**
 * A device whose BMK a derived Klemmleiste also carries ("X1") — mirrors
 * `strip_name_clashes` (`schaltplan_terminal_checks.py`). X is the
 * Verteilerblock's natural letter and the letter the strips count in, so one
 * label would end up on two parts.
 */
function stripNameClashes(document: PanelDocument, skip: ReadonlySet<string>): PanelFinding[] {
  const stripNames = new Set(
    deriveTerminals(document, skip)
      .flatMap((group) => group.strips.map((strip) => strip.xLabel.trim().toUpperCase()))
      .filter(Boolean),
  );
  const clashes: PanelFinding[] = [];
  for (const device of allDevices(document)) {
    const designation = device.designation.trim();
    if (!designation || STRIP_NAMED_KINDS.has(device.kind)) continue;
    if (stripNames.has(designation.toUpperCase())) {
      clashes.push({
        level: "warn",
        scope: device.id,
        message: `${designation}: so heißt auch eine Klemmleiste — Gerät umbenennen (zwei Teile mit einem BMK).`,
      });
    }
  }
  return clashes;
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
