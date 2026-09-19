/**
 * Reihenklemmen — the WAGO part table and the per-device rules.
 *
 * Twin of `apps/api/app/services/schaltplan_terminal_rules.py`. The
 * derivation over a whole document lives one level up in
 * `schaltplanTerminals.ts`; the rules are split out so that
 * `schaltplanTopology.validateDocument` can report them without an import
 * cycle (the derivation needs `buildTopology`).
 *
 * Widths were looked up per article number on 2026-09-17 — wago.com where
 * the page carries the number, else a distributor's copy of the datasheet —
 * and the URL sits next to each row. A width nobody could confirm is
 * `verified: false`, and the print dialog says so before the strip feeds: a
 * wrong pitch shifts every following marker along the strip, so a guessed
 * constant would be worse than a visible warning. If a measured carrier
 * disagrees with a row, that row's `widthMm` is the one number to change
 * (same policy as `CAP_TOP_RATIO` in werkstatt_labels.py).
 *
 * Marking. All seven parts are TOPJOB S; their marker is the 2009-110 strip
 * (11 mm, continuous, snapped into the terminal's marker slot) — the same
 * stock the BMK strip uses, so one strip is printed per FI group and slid
 * along the row. Feed and Etagenklemmen carry a marker; the two end elements
 * do not (`marker: false`) and therefore never get a segment on the strip.
 */
import { catalogEntry } from "./schaltplanDevices";
import type { DeviceKind, PanelDevice, PanelFinding, PanelGroup } from "../types/schaltplan";

export type TerminalPartId =
  | "2003-7641"
  | "2003-7642"
  | "2016-7714"
  | "2009-305"
  | "2016-7604"
  | "2016-7601"
  | "2016-7607";

export interface TerminalPart {
  id: TerminalPartId;
  /** "WAGO 2003-7641" — what the Stückliste and the purchasing hook print. */
  partNo: string;
  /** German name as the datasheet has it, not as the rule table would like it. */
  name: string;
  /** What the derivation uses the part for. */
  role: string;
  /** Rail footprint in mm per the datasheet; for a marker-carrying part this is its strip segment. */
  widthMm: number;
  /** Carries a 2009-110 marker and so gets a segment on the strip. End elements do not. */
  marker: boolean;
  /** The width was confirmed on a WAGO or distributor page (see `source`). */
  verified: boolean;
  source: string;
}

export const TERMINAL_PARTS: Readonly<Record<TerminalPartId, TerminalPart>> = {
  "2003-7641": {
    id: "2003-7641",
    partNo: "WAGO 2003-7641",
    name: "Installations-Etagenklemme NT/L/PE, 2,5 mm²",
    role: "je 1-poliger Abgang",
    // Klemmbreite 5,2 mm (BAUHAUS datasheet copy; wago.com/us/…/p/2003-7641
    // names it "Multilevel installation terminal block; NT/L/PE" but keeps
    // the width in the download section).
    widthMm: 5.2,
    marker: true,
    verified: true,
    source: "https://www.bauhaus.info/installationsklemmen/wago-topjob-installationsetagenklemme-s-2003-7641/p/27588879",
  },
  "2003-7642": {
    id: "2003-7642",
    partNo: "WAGO 2003-7642",
    // The datasheet says L/L — two potentials on three levels — not
    // "3-polig". The owner picked the part for the 3-pole outgoing; the name
    // follows WAGO so nobody orders the wrong thing off the Stückliste.
    name: "Installations-Etagenklemme L/L, 2,5 mm²",
    role: "je 3-poliger Abgang",
    // Breite 5,2 mm (elektroland24 datasheet copy; wago.com/us/…/p/2003-7642: L/L).
    widthMm: 5.2,
    marker: true,
    verified: true,
    source: "https://www.elektroland24.de/Elektroinstallation/Verteilungseinbau/Reihenklemmen/WAGO/Wago-2003-7642-Installations-Etagenklemme-L-L.html",
  },
  "2016-7714": {
    id: "2016-7714",
    partNo: "WAGO 2016-7714",
    name: "N-Einspeiseklemme mit Trennung, 16 mm² (1-Leiter-N-Trennklemme)",
    role: "Einspeisung der FI-Gruppe",
    // 12 mm breit (elanto24; wago.com/us/…/p/2016-7714: "1-conductor
    // N-disconnect terminal block; 16 mm²").
    widthMm: 12,
    marker: true,
    verified: true,
    source: "https://www.elanto24.de/elektromaterial/befestigung/reihenklemmen/wago/installationsetagenklemmen/31920/wago-2016-7714-n-einspeiseklemme-in-76-a-16mm2-12-mm-breit-blau",
  },
  "2009-305": {
    id: "2009-305",
    partNo: "WAGO 2009-305",
    // Not an end plate: a busbar carrier with end-stop function and a
    // detachable separator plate. It closes the group's N bus, carries no
    // marker, and is 7.5 mm wide on the rail (the design assumed 0 — the
    // strip is unaffected because a marker-less part gets no segment, but
    // the footprint is real and the Stückliste names the real part).
    name: "Sammelschienenträger mit Endklammerfunktion (Endelement)",
    role: "Ende der FI-Gruppe",
    widthMm: 7.5,
    marker: false,
    verified: true,
    source: "https://www.wago.com/us/rail-chassis-terminal-blocks/topjobs-busbar-carrier/p/2009-305",
  },
  "2016-7604": {
    id: "2016-7604",
    partNo: "WAGO 2016-7604",
    name: "N-Verteilereinspeiseklemme, 16 mm², blau (2-Leiter)",
    role: "Einspeisung bei einzelnem Drehstromabgang",
    // Breite 12 mm (elektroland24; wago.com/us/…/p/2016-7604: blue, 16 mm²,
    // "side and center marking").
    widthMm: 12,
    marker: true,
    verified: true,
    source: "https://www.elektroland24.de/elektroinstallation/verteilungseinbau/reihenklemmen/wago/wago-2016-7604-2-leiter-n-verteilereinspeiseklemme.html",
  },
  "2016-7601": {
    id: "2016-7601",
    partNo: "WAGO 2016-7601",
    name: "Verteilereinspeiseklemme, 16 mm², grau (2-Leiter)",
    role: "je Pol des einzelnen Drehstromabgangs",
    // 12 mm (heizung-billiger datasheet copy; wago.com/global/…/p/2016-7601:
    // gray, 16 mm², "side and center marking").
    widthMm: 12,
    marker: true,
    verified: true,
    source: "https://heizung-billiger.de/770206-wago-verteiler-einspeiseklemme-2016-2016-7601-16mm2-800v-76a-12mm-grau-wago-2016-7601-4045454725082.html",
  },
  "2016-7607": {
    id: "2016-7607",
    partNo: "WAGO 2016-7607",
    name: "2-Leiter-Schutzleiterklemme, 16 mm², grün-gelb",
    role: "PE des einzelnen Drehstromabgangs",
    // Breite 12 mm — wago.com/de/…/p/2016-7607, "Geometrische Daten": 12 mm /
    // 0.472 inch (85,7 mm hoch, 40,8 mm ab Oberkante Tragschiene), read
    // 2026-09-19. The owner confirmed the same day that 7607 is the part on
    // the shelf and that "2016-7606" never existed. It has side and centre
    // marking, so it gets a 12 mm "PE" segment on the strip.
    widthMm: 12,
    marker: true,
    verified: true,
    source: "https://www.wago.com/de/reihenklemmen/2-leiter-schutzleiterklemme/p/2016-7607",
  },
};

/** Parts in table order, for the Stückliste and the dialog's warning line. */
export const TERMINAL_PART_ORDER: readonly TerminalPartId[] = [
  "2003-7641",
  "2003-7642",
  "2009-305",
  "2016-7601",
  "2016-7604",
  "2016-7607",
  "2016-7714",
];

export const FEED_PART_IDS: ReadonlySet<TerminalPartId> = new Set(["2016-7714", "2016-7604"]);
export const OUTGOING_PART_IDS: ReadonlySet<TerminalPartId> = new Set(["2003-7641", "2003-7642", "2016-7601"]);
export const END_PART_IDS: ReadonlySet<TerminalPartId> = new Set(["2009-305"]);

/**
 * Kinds that may end on a Reihenklemme: MCB-protected outgoing circuits.
 * An RCBO is deliberately absent — its N is its own and must not sit on
 * the FI group's N bus (owner decision). Fuses, contactors, relays and SPDs
 * never get one.
 */
export const TERMINAL_ELIGIBLE_KINDS: ReadonlySet<DeviceKind> = new Set<DeviceKind>([
  "mcb",
  "wallbox",
  "sub_feed",
  "pv",
]);

export function isTerminalEligible(device: Pick<PanelDevice, "kind">): boolean {
  return TERMINAL_ELIGIBLE_KINDS.has(device.kind);
}

/** Eligible AND flagged: the device gets a terminal. */
export function hasTerminal(device: Pick<PanelDevice, "kind" | "terminal_block">): boolean {
  return isTerminalEligible(device) && device.terminal_block === true;
}

/** Pole count as the rules read it: whole, 1..4, anything odd becomes 1. */
export function devicePoles(device: Pick<PanelDevice, "poles">): number {
  const raw = Number.isFinite(device.poles) ? Math.trunc(device.poles) : 1;
  return Math.max(1, Math.min(4, raw || 1));
}

/**
 * Decision (b): a 2-pole breaker (1P+N) is treated as 1-pole, a 4-pole
 * outgoing as 3-pole. The Etagenklemmen come in exactly those two shapes.
 */
export function polesAsDerived(poles: number): 1 | 3 {
  return poles <= 2 ? 1 : 3;
}

export function outgoingPartForPoles(poles: number): TerminalPartId {
  return polesAsDerived(poles) === 1 ? "2003-7641" : "2003-7642";
}

/** The children of a group that end on a terminal, in physical order. */
export function terminalChildren(group: PanelGroup): PanelDevice[] {
  return group.children.filter(hasTerminal);
}

export type TerminalVariant = "standard" | "single3p" | "no_rcd";

/**
 * Which rule a group follows, or null when nothing in it has a terminal.
 *
 *  - `single3p`: an FI with exactly one 3- or 4-pole outgoing — the
 *    16 mm² feed, one terminal per pole, the 2016 end element;
 *  - `standard`: any other FI — N feed, one Etagenklemme per outgoing,
 *    the end clamp;
 *  - `no_rcd`: a Hauptschalter/SLS/fuse/supply group — only the per-device
 *    terminals; there is no FI whose N bus a feed terminal could open.
 */
export function terminalVariant(group: PanelGroup, children: PanelDevice[]): TerminalVariant | null {
  if (children.length === 0) return null;
  const head = group.device;
  if (!head || head.kind !== "rcd") return "no_rcd";
  if (children.length === 1 && devicePoles(children[0]) >= 3) return "single3p";
  return "standard";
}

/** "Q1" / "FI" / "Einspeisung" — how a group head reads in a finding. */
export function groupHeadLabel(group: PanelGroup): string {
  const head = group.device;
  if (!head) return "Einspeisung";
  return head.designation.trim() || catalogEntry(head.kind).short;
}

function deviceLabel(device: PanelDevice): string {
  return device.designation.trim() || device.label.trim() || "Abgang";
}

/**
 * The two advisory findings the terminal rules add to `validateDocument`:
 * a group without an FI whose outgoings still want terminals (rule 4), and
 * a pole count the Etagenklemmen do not come in (decision b). Both `info`,
 * never `warn`: the derivation is still right, the electrician just needs
 * to know what it assumed.
 */
export function terminalFindings(groups: PanelGroup[]): PanelFinding[] {
  const findings: PanelFinding[] = [];
  for (const group of groups) {
    const children = terminalChildren(group);
    const variant = terminalVariant(group, children);
    if (!variant) continue;
    if (variant === "no_rcd") {
      findings.push({
        level: "info",
        scope: group.device?.id ?? "",
        message: `Gruppe ${groupHeadLabel(group)}: Abgänge mit Reihenklemme ohne FI — Einspeiseklemme nicht abgeleitet`,
      });
    }
    // The per-pole variant honours every pole; only the Etagenklemmen round.
    if (variant === "single3p") continue;
    for (const device of children) {
      const poles = devicePoles(device);
      if (poles === 1 || poles === 3) continue;
      findings.push({
        level: "info",
        scope: device.id,
        message: `${deviceLabel(device)}: ${poles}-polig — Klemme wie ${polesAsDerived(poles)}-polig abgeleitet`,
      });
    }
  }
  return findings;
}
