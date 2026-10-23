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
 * Marking. All seven terminals are TOPJOB S; their marker is the 2009-110
 * strip (11 mm, continuous, snapped into the terminal's marker slot) — the
 * same stock the BMK strip uses, so one strip is printed per Leiste and slid
 * along the row, and one 60 mm piece per 16 mm² Block. Feed and
 * Etagenklemmen carry a marker; the end elements do not (`marker: false`)
 * and therefore never get a segment on the strip.
 *
 * Rail parts (docs/PANEL_ENCLOSURE_R2.md §5.3, round 2). On a cabinet board
 * every terminal rail that holds a strip is closed by one end plate matching
 * its last terminal block (`TerminalPart.endPlate`). They are counted by the
 * placement (`enclosureTerminals.ts`), never by a group, so a legacy
 * Stückliste is unchanged. No end stops: the owner ruled the WAGO 249-116
 * out on 2026-10-22.
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
  | "2016-7607"
  | "2003-7692"
  | "2016-7691";

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
  /**
   * The end plate that closes a rail whose last terminal block is this part;
   * null for parts that never end a rail's terminal row (feed, end clamp,
   * the plates themselves).
   */
  endPlate: TerminalPartId | null;
}

export const TERMINAL_PARTS: Readonly<Record<TerminalPartId, TerminalPart>> = {
  "2003-7641": {
    id: "2003-7641",
    partNo: "WAGO 2003-7641",
    name: "Installations-Etagenklemme NT/L/PE, 2,5 mm²",
    role: "je Abgang (erste Etagenklemme)",
    // Klemmbreite 5,2 mm (BAUHAUS datasheet copy; wago.com/us/…/p/2003-7641
    // names it "Multilevel installation terminal block; NT/L/PE" but keeps
    // the width in the download section).
    widthMm: 5.2,
    marker: true,
    verified: true,
    source: "https://www.bauhaus.info/installationsklemmen/wago-topjob-installationsetagenklemme-s-2003-7641/p/27588879",
    // Verified: the 2003-7641 datasheet (Stand 28.05.2026) lists 2003-7692
    // as "Notwendiges Zubehör".
    endPlate: "2003-7692",
  },
  "2003-7642": {
    id: "2003-7642",
    partNo: "WAGO 2003-7642",
    // The datasheet says L/L — two potentials on three levels — not
    // "3-polig". The owner picked the part for L2 and L3 of a three-phase
    // outgoing; the name follows WAGO so nobody orders the wrong thing off
    // the Stückliste.
    name: "Installations-Etagenklemme L/L, 2,5 mm²",
    role: "je 3-poliger Abgang (zweite Etagenklemme, L2/L3)",
    // Breite 5,2 mm (elektroland24 datasheet copy; wago.com/us/…/p/2003-7642: L/L).
    widthMm: 5.2,
    marker: true,
    verified: true,
    source: "https://www.elektroland24.de/Elektroinstallation/Verteilungseinbau/Reihenklemmen/WAGO/Wago-2003-7642-Installations-Etagenklemme-L-L.html",
    // UNVERIFIED: the same 2003-76xx housing as 2003-7641 is assumed.
    endPlate: "2003-7692",
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
    // Never a rail's last terminal block: a Leiste with a feed ends in an
    // outgoing and the 2009-305. Its series plate would be 2016-7792
    // (unverified), which is not modelled.
    endPlate: null,
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
    // Skipped when looking for a rail's last terminal block: its break-out
    // plate closes the N busbar, not the terminal's open side.
    endPlate: null,
  },
  "2016-7604": {
    id: "2016-7604",
    partNo: "WAGO 2016-7604",
    name: "N-Verteilereinspeiseklemme, 16 mm², blau (2-Leiter)",
    role: "N des 16-mm²-Blocks",
    // Breite 12 mm (elektroland24; wago.com/us/…/p/2016-7604: blue, 16 mm²,
    // "side and center marking").
    widthMm: 12,
    marker: true,
    verified: true,
    source: "https://www.elektroland24.de/elektroinstallation/verteilungseinbau/reihenklemmen/wago/wago-2016-7604-2-leiter-n-verteilereinspeiseklemme.html",
    // UNVERIFIED: the same 2016-76xx housing as 2016-7601 is assumed.
    endPlate: "2016-7691",
  },
  "2016-7601": {
    id: "2016-7601",
    partNo: "WAGO 2016-7601",
    name: "Verteilereinspeiseklemme, 16 mm², grau (2-Leiter)",
    role: "je Außenleiter des 16-mm²-Blocks",
    // 12 mm (heizung-billiger datasheet copy; wago.com/global/…/p/2016-7601:
    // gray, 16 mm², "side and center marking").
    widthMm: 12,
    marker: true,
    verified: true,
    source: "https://heizung-billiger.de/770206-wago-verteiler-einspeiseklemme-2016-2016-7601-16mm2-800v-76a-12mm-grau-wago-2016-7601-4045454725082.html",
    // Verified: the 2016-7601 datasheet (Stand 03.06.2026), "Notwendiges
    // Zubehör: 2016-7691 Abschlussplatte; 1 mm dick; grau".
    endPlate: "2016-7691",
  },
  "2016-7607": {
    id: "2016-7607",
    partNo: "WAGO 2016-7607",
    name: "2-Leiter-Schutzleiterklemme, 16 mm², grün-gelb",
    role: "PE des 16-mm²-Blocks",
    // Breite 12 mm — wago.com/de/…/p/2016-7607, "Geometrische Daten": 12 mm /
    // 0.472 inch (85,7 mm hoch, 40,8 mm ab Oberkante Tragschiene), read
    // 2026-09-19. The owner confirmed the same day that 7607 is the part on
    // the shelf and that "2016-7606" never existed. It has side and centre
    // marking, so it gets a 12 mm "PE" cell on the block label.
    widthMm: 12,
    marker: true,
    verified: true,
    source: "https://www.wago.com/de/reihenklemmen/2-leiter-schutzleiterklemme/p/2016-7607",
    // UNVERIFIED: the same 2016-76xx housing as 2016-7601 is assumed.
    endPlate: "2016-7691",
  },
  "2003-7692": {
    id: "2003-7692",
    partNo: "WAGO 2003-7692",
    name: "Abschluss- und Zwischenplatte, 0,8 mm, orange",
    role: "rail_part",
    // 0,8 mm (WAGO datasheet 2003-7641, Stand 28.05.2026, "Notwendiges Zubehör").
    widthMm: 0.8,
    marker: false,
    verified: true,
    source: "https://www.wago.com/gb/10001/p/2003-7692",
    endPlate: null,
  },
  "2016-7691": {
    id: "2016-7691",
    partNo: "WAGO 2016-7691",
    name: "Abschlussplatte, 1 mm, grau",
    role: "rail_part",
    // 1 mm (WAGO datasheet 2016-7601, Stand 03.06.2026: "Abschlussplatte; 1 mm dick; grau").
    widthMm: 1.0,
    marker: false,
    verified: true,
    source: "https://www.wago.com/nl/rijgklemmen/afsluitplaat/p/2016-7691",
    endPlate: null,
  },
};

/** Parts in table order, for the Stückliste and the dialog's warning line. */
export const TERMINAL_PART_ORDER: readonly TerminalPartId[] = [
  "2003-7641",
  "2003-7642",
  "2003-7692",
  "2009-305",
  "2016-7601",
  "2016-7604",
  "2016-7607",
  "2016-7691",
  "2016-7714",
];

export const FEED_PART_IDS: ReadonlySet<TerminalPartId> = new Set(["2016-7714", "2016-7604"]);
export const OUTGOING_PART_IDS: ReadonlySet<TerminalPartId> = new Set(["2003-7641", "2003-7642", "2016-7601"]);
export const END_PART_IDS: ReadonlySet<TerminalPartId> = new Set(["2009-305"]);
export const END_PLATE_PART_IDS: ReadonlySet<string> = new Set<TerminalPartId>(["2003-7692", "2016-7691"]);
/** What closes a terminal rail. Only the end plates: no end stops (owner, 2026-10-22). */
export const RAIL_PART_IDS: ReadonlySet<string> = END_PLATE_PART_IDS;

/**
 * Device ids that get no terminal whatever their flag says — on a cabinet
 * board, everything on an AAR, NAR, RfZ or APZ rail (docs/PANEL_ENCLOSURE_R2.md
 * §3.1, `terminalSkip`). Empty on a board without a cabinet.
 */
export const NO_SKIP: ReadonlySet<string> = new Set<string>();

/**
 * Kinds that may end on a Reihenklemme: MCB-protected outgoing circuits, and
 * a Neozed module that goes straight on to the 16 mm² block (owner,
 * 2026-10-09: the PV / callbox outputs, "without an extra MCB or other
 * device between it and the Neozed block") — always the block, see
 * `isBlockDevice`. Only a fuse that IS an outgoing: as the Vorsicherung of an
 * FI or the head of a row of LS it is no group child, so it never reaches the
 * derivation. An RCBO is deliberately absent — its N is its own and must not
 * sit on the FI group's N bus (owner decision). Contactors, relays and SPDs
 * never get one.
 */
export const TERMINAL_ELIGIBLE_KINDS: ReadonlySet<DeviceKind> = new Set<DeviceKind>([
  "mcb",
  "wallbox",
  "sub_feed",
  "pv",
  "fuse",
]);

export type TerminalVariant = "standard" | "no_rcd";

/**
 * Above this rating a three-phase outgoing leaves the 2.5 mm² Etagenklemmen
 * and gets the 16 mm² Block (owner's rule, 2026-09-23): "the terminals we
 * use for a 3-pole MCB with more than 16 A".
 */
export const BLOCK_MIN_AMPS_EXCLUSIVE = 16;

/** The first number in a rating, decimal comma or point: "B16" → 16, "C 32A" → 32, "0,5 A" → 0.5. */
const AMPS_RE = /(\d+(?:[.,]\d+)?)/;

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

/**
 * The Etagenklemmen an outgoing needs: the N/L/PE terminal for one phase;
 * for three phases the N/L/PE terminal plus the L/L terminal carrying L2
 * and L3 — two terminals, two markers.
 */
export function outgoingPartsForPoles(poles: number): TerminalPartId[] {
  return polesAsDerived(poles) === 1 ? ["2003-7641"] : ["2003-7641", "2003-7642"];
}

/**
 * The ampere figure in a rating as the office writes it — "B16", "C 32A",
 * "16 A", "63" — or null when there is no number in it.
 */
export function ratingAmps(rating: string | null | undefined): number | null {
  const match = AMPS_RE.exec(String(rating ?? ""));
  if (!match) return null;
  const amps = Number(match[1].replace(",", "."));
  return Number.isFinite(amps) ? amps : null;
}

/**
 * A 3- or 4-pole outgoing above 16 A ends on the 16 mm² Block (N feed,
 * L1–L3, PE) instead of the Etagenklemmen. A Neozed always does: the
 * owner's combo block is what it goes straight on to, whatever its rating.
 */
export function isBlockDevice(device: Pick<PanelDevice, "poles" | "rating"> & { kind?: PanelDevice["kind"] }): boolean {
  if (device.kind === "fuse") return true;
  const amps = ratingAmps(device.rating);
  return devicePoles(device) >= 3 && amps !== null && amps > BLOCK_MIN_AMPS_EXCLUSIVE;
}

/** The children of a group that end on a terminal, in physical order; `skip` (§3.1) leaves devices out. */
export function terminalChildren(group: PanelGroup, skip: ReadonlySet<string> = NO_SKIP): PanelDevice[] {
  return group.children.filter((device) => hasTerminal(device) && !skip.has(device.id));
}

/**
 * Which rule a group follows, or null when nothing in it has a terminal.
 *
 *  - `standard`: an FI — its Leiste opens with the N feed terminal, then
 *    the Etagenklemmen of the small outgoings, then the end clamp; every
 *    three-phase outgoing above 16 A gets a 16 mm² Block of its own
 *    (see `isBlockDevice`);
 *  - `no_rcd`: a Hauptschalter/SLS/fuse/supply group — the same terminals
 *    without a feed; there is no FI whose N bus a feed terminal could open.
 */
export function terminalVariant(group: PanelGroup, children: PanelDevice[]): TerminalVariant | null {
  if (children.length === 0) return null;
  const head = group.device;
  if (!head || head.kind !== "rcd") return "no_rcd";
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
export function terminalFindings(groups: PanelGroup[], skip: ReadonlySet<string> = NO_SKIP): PanelFinding[] {
  const findings: PanelFinding[] = [];
  for (const group of groups) {
    const children = terminalChildren(group, skip);
    const variant = terminalVariant(group, children);
    if (!variant) continue;
    // Only a Leiste lacks the feed terminal; a block brings its own N
    // (2016-7604), so a group of blocks alone has nothing to report.
    if (variant === "no_rcd" && children.some((device) => !isBlockDevice(device))) {
      findings.push({
        level: "info",
        scope: group.device?.id ?? "",
        message: `Gruppe ${groupHeadLabel(group)}: Abgänge mit Reihenklemme ohne FI — Einspeiseklemme nicht abgeleitet`,
      });
    }
    for (const device of children) {
      const poles = devicePoles(device);
      // The Block honours its poles (N sits on the feed terminal); only the
      // Etagenklemmen round.
      if (poles === 1 || poles === 3 || isBlockDevice(device)) continue;
      findings.push({
        level: "info",
        scope: device.id,
        message: `${deviceLabel(device)}: ${poles}-polig — Klemme wie ${polesAsDerived(poles)}-polig abgeleitet`,
      });
    }
  }
  return findings;
}
