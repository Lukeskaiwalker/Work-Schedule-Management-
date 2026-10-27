/**
 * The close-up ("Nahansicht") of each field's two terminal rails
 * (docs/PANEL_ENCLOSURE_R2.md §7.1) — the TypeScript twin of
 * `apps/api/app/services/panel_enclosure_terminal_closeup.py`, pinned on
 * `test/fixtures/enclosureFixtures.json` (`terminal_closeup`). The Schrank
 * tab's close-up sheet and the Aufbau PDF draw this one layout; they only fit
 * texts into it (`labelFit`), they never place.
 *
 * Per field with terminal rails (ascending), per rail (top → bottom):
 *
 * - `devices`: what still sits on a reserved rail (back-compat, R12), left
 *   first, drawn grey; placeholders ("Reihenklemme N/PE") are left out — the
 *   strips replace them (§3.6);
 * - `items`: every part of every placed strip at its offset on the rail
 *   (devices included), and the rail's end plate right after the last
 *   terminal block, before a trailing 2009-305 (which then moves right by the
 *   plate). The plate's open side is drawn on the right, which is UNVERIFIED
 *   (the legend says so, as it says that markers are drawn above the terminal
 *   while WAGO marks the middle/side).
 *
 * `levels` are the conductors on a terminal, top → bottom: a 2003-7641 of a
 * 1-pole outgoing carries N, its phase (`device.phase` when L1/L2/L3, else
 * "L") and PE (verified, 2003-7641 datasheet "NT/L/PE"); of a 3-pole outgoing
 * N, L1, PE, with L2, L3 on its 2003-7642 (that order is UNVERIFIED); the
 * 2016-7714 feed N; a Block cell its pole; the end clamp and the plates none.
 * `forText` is the Klemmen tab's "für" column (`terminalForText`).
 *
 * Numbers are rounded with `round1` on the way out; offsets run left → right
 * from the placement's (rounded) strip offsets, in a plain loop, as Python's.
 */

import type { CatalogIndex } from "./enclosureCatalog";
import { edgeTrimmed } from "./edgeTrim";
import { DEVICE_CATALOG } from "./schaltplanDevices";
import { enclosureDeviceWidthMm } from "./enclosureLayout";
import {
  PLACEHOLDER_KINDS,
  boardTerminals,
  enclosureOf,
  ident,
  placeTerminals,
  round1,
  rowDevices,
  rowsOf,
  type BoardTerminals,
} from "./enclosureTerminals";
import {
  END_PART_IDS,
  END_PLATE_PART_IDS,
  FEED_PART_IDS,
  TERMINAL_PARTS,
  devicePoles,
  polesAsDerived,
  type TerminalPartId,
} from "./schaltplanTerminalRules";
import type { TerminalEntry, TerminalGroup, TerminalStrip } from "./schaltplanTerminals";
import type {
  CloseupItem,
  CloseupRail,
  PlacedTerminalRail,
  TerminalCloseup,
  TerminalFieldPlacement,
  TerminalPlacement,
} from "../types/panelEnclosure";
import type { DeviceKind, PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

const PHASES: ReadonlySet<string> = new Set(["L1", "L2", "L3"]);
/** Terminal rails are DIN rails (R2 §3.2): a device's width as on any rail. */
const DIN_RAIL = { mount: "rail" } as const;

type StripEntry = { group: TerminalGroup; strip: TerminalStrip };

/** Python's `text`: a stored string, trimmed; anything else "". */
const trimmed = edgeTrimmed;
const isPart = (ids: ReadonlySet<TerminalPartId> | ReadonlySet<string>, partId: string): boolean =>
  (ids as ReadonlySet<string>).has(partId);

/** "30 mA / Typ A" for an FI head, "" for anything else. */
export function rcdDetail(head: PanelDevice | null): string {
  if (!head || head.kind !== "rcd") return "";
  const parts = [trimmed(head.residual_current), trimmed(head.rcd_type)].filter(Boolean);
  if (parts.length === 2) return `${parts[0]} / Typ ${parts[1]}`;
  return parts[0] ?? "";
}

/**
 * The "für" column of the Klemmen tab (`TerminalGroupCard`): the end clamp
 * "—", a feed "FI F1 · 30 mA / Typ A", an outgoing "F1.1 · Licht · Nr. 3".
 * Python twin: `schaltplan_terminals.terminal_for_text`.
 */
export function terminalForText(
  terminal: Pick<TerminalEntry, "partId" | "deviceId">,
  devices: ReadonlyMap<string, PanelDevice>,
  head: PanelDevice | null,
): string {
  if (isPart(END_PART_IDS, terminal.partId)) return "—";
  if (isPart(FEED_PART_IDS, terminal.partId)) {
    const parts = [head ? `FI ${trimmed(head.designation) || "?"}` : "", rcdDetail(head)];
    return parts.filter(Boolean).join(" · ") || "—";
  }
  const device = devices.get(terminal.deviceId || "");
  if (!device) return "—";
  const circuit = trimmed(device.circuit);
  return [trimmed(device.designation), trimmed(device.label), circuit ? `Nr. ${circuit}` : ""].filter(Boolean).join(" · ") || "—";
}

/** The BMK, else the catalogue's short name (as the cabinet drawing labels it). */
function deviceLabel(device: PanelDevice): string {
  return trimmed(device.designation) || (DEVICE_CATALOG[device.kind as DeviceKind]?.short ?? "");
}

function levels(terminal: TerminalEntry, device: PanelDevice | undefined): string[] {
  const partId = terminal.partId;
  if (isPart(END_PART_IDS, partId)) return [];
  if (partId === "2016-7714") return ["N"];
  if (partId === "2003-7642") return ["L2", "L3"];
  if (partId === "2003-7641") {
    if (device && polesAsDerived(devicePoles(device)) === 3) return ["N", "L1", "PE"];
    const phase = device ? trimmed(device.phase) : "";
    return ["N", PHASES.has(phase) ? phase : "L", "PE"];
  }
  return terminal.pole ? [String(terminal.pole)] : [];
}

function plateItem(partId: TerminalPartId, offset: number): CloseupItem {
  const part = TERMINAL_PARTS[partId];
  return {
    kind: "end_plate", partId, partNo: part.partNo, stripId: null, xLabel: "", offsetMm: round1(offset),
    widthMm: round1(part.widthMm), marker: "", levels: [], forText: "", cable: "", deviceId: null,
  };
}

function terminalItem(
  terminal: TerminalEntry, strip: TerminalStrip, offset: number, devices: ReadonlyMap<string, PanelDevice>, head: PanelDevice | null,
): CloseupItem {
  const deviceId = terminal.deviceId || null;
  const device = deviceId ? devices.get(deviceId) : undefined;
  return {
    kind: isPart(END_PART_IDS, terminal.partId) ? "end_clamp" : "terminal",
    partId: terminal.partId, partNo: String(terminal.partNo), stripId: String(strip.stripId), xLabel: String(strip.xLabel),
    offsetMm: round1(offset), widthMm: round1(terminal.widthMm), marker: String(terminal.label || ""),
    levels: levels(terminal, device), forText: terminalForText(terminal, devices, head),
    cable: device ? trimmed(device.cable) : "", deviceId,
  };
}

function railItems(rail: PlacedTerminalRail, strips: ReadonlyMap<string, StripEntry>, devices: ReadonlyMap<string, PanelDevice>): CloseupItem[] {
  const plates = rail.parts.map((part) => part.partId).filter((partId) => END_PLATE_PART_IDS.has(partId));
  let plate = plates.length > 0 ? (plates[0] as TerminalPartId) : null;
  const items: CloseupItem[] = [];
  const placed = rail.strips.filter((entry) => strips.has(entry.stripId));
  let cursor = 0;
  placed.forEach((entry, at) => {
    const { group, strip } = strips.get(entry.stripId)!;
    const last = at === placed.length - 1;
    cursor = entry.offsetMm;
    for (const terminal of strip.terminals) {
      if (last && plate !== null && isPart(END_PART_IDS, terminal.partId)) {
        items.push(plateItem(plate, cursor));
        cursor += TERMINAL_PARTS[plate].widthMm;
        plate = null;
      }
      items.push(terminalItem(terminal, strip, cursor, devices, group.headDevice));
      cursor += terminal.widthMm;
    }
  });
  if (plate !== null && placed.length > 0) items.push(plateItem(plate, cursor));
  return items;
}

function railDevices(row: PanelRow | undefined): CloseupRail["devices"] {
  const out: CloseupRail["devices"] = [];
  let cursor = 0;
  for (const device of rowDevices(row)) {
    if (PLACEHOLDER_KINDS.has(String(device.kind ?? ""))) continue;
    const width = enclosureDeviceWidthMm(device, DIN_RAIL);
    out.push({ deviceId: ident(device.id), label: deviceLabel(device), offsetMm: round1(cursor), widthMm: round1(width) });
    cursor += width;
  }
  return out;
}

function fieldCloseup(
  field: TerminalFieldPlacement, strips: ReadonlyMap<string, StripEntry>, rows: ReadonlyMap<string, PanelRow>,
  devices: ReadonlyMap<string, PanelDevice>,
): TerminalCloseup {
  const rails = field.rails.map((rail): CloseupRail => ({
    moduleId: rail.moduleId, railKey: rail.railKey, title: rail.title, position: rail.position as CloseupRail["position"],
    capacityMm: rail.capacityMm, usedMm: rail.usedMm, insulated: rail.insulated,
    devices: railDevices(rail.rowId ? rows.get(rail.rowId) : undefined),
    items: railItems(rail, strips, devices),
  }));
  const unplaced = field.unplaced.map((entry) => ({
    stripId: entry.stripId, xLabel: entry.xLabel,
    title: strips.has(entry.stripId) ? String(strips.get(entry.stripId)!.strip.title) : entry.xLabel,
    widthMm: entry.widthMm,
  }));
  return { field: field.field, order: field.order, rails, unplaced };
}

/**
 * The close-up of every field with terminal rails, ascending; [] without a
 * cabinet. `terms`/`placement`: the board's `boardTerminals` and
 * `placeTerminals`, when the caller already has them (derived otherwise).
 *
 * The readers here are tolerant, and broken rows (the server never stores
 * them) are read as Python reads them (`boardTerminals` is lenient). Should
 * the derivation still trip, the board gets no close-up and a console
 * warning instead of a dead sheet. `terms` not made by `boardTerminals`
 * still throw (`placeTerminals`).
 */
export function terminalCloseup(
  doc: PanelDocument, index: CatalogIndex, terms?: BoardTerminals, placement?: TerminalPlacement,
): TerminalCloseup[] {
  if (!enclosureOf(doc)) return [];
  let resolved: BoardTerminals;
  try {
    resolved = terms ?? boardTerminals(doc, index);
  } catch (error) {
    console.warn("Nahansicht der Reihenklemmen übersprungen", error);
    return [];
  }
  const placed = placement ?? placeTerminals(doc, index, resolved);
  const strips = new Map<string, StripEntry>();
  for (const group of resolved.groups) for (const strip of group.strips) strips.set(strip.stripId, { group, strip });
  const rows = new Map(rowsOf(doc).map((row) => [row.id, row] as const));
  const devices = new Map<string, PanelDevice>();
  for (const row of rows.values()) {
    for (const device of rowDevices(row)) {
      const id = ident(device.id);
      if (!devices.has(id)) devices.set(id, device);
    }
  }
  return (placed.fields ?? []).map((field) => fieldCloseup(field, strips, rows, devices));
}
