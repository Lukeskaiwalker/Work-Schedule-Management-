/**
 * The round-4 findings: §14a block, busbar runs, supply kit and infeed
 * (docs/PANEL_ENCLOSURE_R4.md §4) — the TypeScript twin of
 * `apps/api/app/services/panel_enclosure_prep_rules.py`, pinned on the
 * fixture's `findings`. Called by `enclosureRules.enclosureFindings`, which
 * sorts every finding by `RULE_ORDER`; these rules sit after
 * `encl.meter_place_invalid` and before the terminal rules.
 *
 * Let B = the parsed block, C = its carrier, L = its placement. Board-level
 * rules use scope "", as every board-level rule does; the block's rules are
 * scoped to the carrier, `busbar_role` to the customer module.
 */

import { parseFuseAmps } from "./cableSectionParse";
import type { CatalogIndex } from "./enclosureCatalog";
import {
  DERIVE,
  candidateRails,
  controlBlockLayout,
  controlCarrier,
  resolveBlock,
  type BlockArg,
  type BlockLayout,
  type Carrier,
} from "./enclosureControlBlock";
import { formatMmText } from "./enclosureGeometry";
import {
  K96ESA5_MAX_FUSE_A,
  ROLE_CUSTOMER,
  ROLE_MAIN,
  analysePrep,
  busbarZones,
  controlTarget,
  joined,
  spansOverlap,
  type BusbarZone,
  type PrepState,
} from "./enclosurePrep";
import { isRecord } from "./enclosureTerminals";
import type { ControlBlock } from "../types/panelEnclosure";
import type { PanelFinding } from "../types/schaltplan";

export const PREP_RULE_ORDER = [
  "encl.control_block_missing", "encl.control_block_reserve", "encl.control_block_rail",
  "encl.control_block_overflow", "encl.control_block_target", "encl.control_block_bdew", "encl.control_tube",
  "encl.busbar_unjoined", "encl.busbar_role", "encl.supply_height", "encl.supply_existing",
  "encl.infeed_assumed", "encl.infeed_fuse", "encl.infeed_size", "encl.pen_split",
] as const;
/** The number of terminals the BDEW Anwendungshilfe (Tab. 1) and VDE-AR-N 4100 name. */
export const BDEW_TERMINALS = 6;
const NARROW_TUBE = "wago-211-501";
const NARROW_TUBE_MAX_MM2 = 1;

/** The §4 texts, in its table order. */
const COPY = {
  missing: "Zählerschrank ohne §14a-Steuersignal-Klemmleiste: im ersten Zählerfeld anlegen.",
  reserve: (field: number) => `§14a-Klemmleiste sitzt auf einem Reserve-Zählerfeld (Feld ${field}).`,
  rail: (field: number) => `§14a-Klemmleiste: Feld ${field} hat keine AAR-Hutschiene.`,
  overflow: (rail: string, used: number, capacity: number) =>
    `§14a-Klemmleiste passt nicht auf ${rail}: ${formatMmText(used)} mm von ${formatMmText(capacity)} mm.`,
  targetApz: "§14a-Steuerleitungen ohne Ziel: im Schrank fehlt ein APZ.",
  targetRfz: (field: number) => `§14a-Steuerleitungen ohne Ziel: Feld ${field} hat keinen RfZ.`,
  bdew: (count: number) => `§14a-Klemmleiste mit ${count} statt 6 Klemmen — BDEW/VDE-AR-N 4100 sieht 6 vor.`,
  tube: (mm2: number) => `Schrumpfschlauch 211-501 passt nur auf 0,75–1 mm² — Leitung ist ${formatMmText(mm2)} mm².`,
  gap: (a: number, b: number) =>
    `Sammelschienen in Feld ${a} und Feld ${b} sind nicht verbunden: dazwischen liegt kein Feld mit Sammelschiene.`,
  height: (a: number, b: number) => `Sammelschienen in Feld ${a} und Feld ${b} liegen nicht auf gleicher Höhe.`,
  role: (customer: number, main: number) =>
    `Sammelschiene in Feld ${customer} ist Kundenverteilung (gezählt) und wird nicht mit dem NAR von Feld ${main} verbunden.`,
  supplyHeight: (height: number) =>
    `Spannungsversorgung RfZ/APZ: Schrankhöhe ${height} mm nicht im Hager-Programm — Bestückungspaket selbst wählen.`,
  supplyExisting: (bmk: string, rail: string) =>
    `Spannungsabgriff bereits geplant (${bmk}, ${rail}) — Bestückungspaket nicht ergänzt; Leitungen zu RfZ/APZ prüfen.`,
  infeedAssumed:
    "Querschnitt der Zuleitung unbekannt: Einspeiseadapter K96ESA5 (bis 25 mm²) angenommen. Im Tab Daten bei „Zuleitung“ eintragen.",
  infeedFuse: (fuse: string) => `Einspeiseadapter K96ESA5 nur hinter höchstens NH00 gG 100 A: Vorsicherung „${fuse}“ prüfen.`,
  infeedSize: (mm2: number) =>
    `Zuleitung ${formatMmText(mm2)} mm²: keine Sammelschienenklemme für 12×5 mm bis 185 mm² — Einspeisung gesondert planen.`,
  penSplit: (field: number) => `Zuleitung 4-adrig im TN-C-S-System: PEN im NAR von Feld ${field} in PE und N aufteilen.`,
} as const;

function finding(rule: (typeof PREP_RULE_ORDER)[number], level: "warn" | "info", scope: string, message: string): PanelFinding {
  return { level, scope, message, rule };
}

// ── The block (B, C, L) ──────────────────────────────────────────────────────

function blockRules(doc: unknown, index: CatalogIndex, block: ControlBlock | null, state: PrepState | null): PanelFinding[] {
  const carrier = controlCarrier(doc, index);
  if (!carrier) return [];
  const field = carrier.field + 1;
  if (!block) return [finding("encl.control_block_missing", "info", "", COPY.missing)];
  if (block.off) return [];
  const out: PanelFinding[] = [];
  if (carrier.reserve) out.push(finding("encl.control_block_reserve", "info", carrier.id, COPY.reserve(field)));
  if (block.terminals.length > 0 && candidateRails(doc, index, carrier).length === 0) {
    out.push(finding("encl.control_block_rail", "warn", carrier.id, COPY.rail(field)));
  }
  const layout = state ? state.layout : controlBlockLayout(doc, index, block);
  return layout ? [...out, ...placedRules(doc, index, block, layout, carrier)] : out;
}

function placedRules(doc: unknown, index: CatalogIndex, block: ControlBlock, layout: BlockLayout, carrier: Carrier): PanelFinding[] {
  const out: PanelFinding[] = [];
  if (layout.overflow) {
    let used = layout.rail.devicesMm;
    used += layout.widthMm;
    out.push(finding("encl.control_block_overflow", "warn", carrier.id, COPY.overflow(layout.railTitle, used, layout.rail.capacityMm)));
  }
  if (!controlTarget(doc, index, carrier)) {
    const message = carrier.family === "meter_3p" ? COPY.targetApz : COPY.targetRfz(carrier.field + 1);
    out.push(finding("encl.control_block_target", "warn", carrier.id, message));
  }
  const count = layout.terminals.length;
  if (count !== BDEW_TERMINALS) out.push(finding("encl.control_block_bdew", "info", carrier.id, COPY.bdew(count)));
  const mm2 = block.wire_mm2 || 0;
  if (block.label_material === NARROW_TUBE && mm2 > NARROW_TUBE_MAX_MM2) {
    out.push(finding("encl.control_tube", "warn", carrier.id, COPY.tube(mm2)));
  }
  return out;
}

// ── Busbars ──────────────────────────────────────────────────────────────────

function roleGaps(members: readonly BusbarZone[]): PanelFinding[] {
  const fields = [...new Set(members.map((zone) => zone.field))].sort((a, b) => a - b);
  const out: PanelFinding[] = [];
  fields.slice(1).forEach((b, i) => {
    const a = fields[i];
    if (b > a + 1) {
      out.push(finding("encl.busbar_unjoined", "warn", "", COPY.gap(a + 1, b + 1)));
      return;
    }
    const pairs = members.filter((x) => x.field === a).flatMap((x) => members.filter((y) => y.field === b).map((y) => [x, y] as const));
    if (pairs.some(([x, y]) => joined(x, y))) return;
    if (pairs.some(([x, y]) => x.moduleId !== y.moduleId)) out.push(finding("encl.busbar_unjoined", "warn", "", COPY.height(a + 1, b + 1)));
  });
  return out;
}

function busbarRules(doc: unknown, index: CatalogIndex): PanelFinding[] {
  const zones = busbarZones(doc, index);
  const out = [ROLE_MAIN, ROLE_CUSTOMER].flatMap((role) => roleGaps(zones.filter((zone) => zone.role === role)));
  const seen = new Set<string>();
  for (const main of zones.filter((zone) => zone.role === ROLE_MAIN)) {
    for (const customer of zones.filter((zone) => zone.role === ROLE_CUSTOMER)) {
      if (Math.abs(main.field - customer.field) !== 1 || main.moduleId === customer.moduleId || !spansOverlap(main, customer)) continue;
      const message = COPY.role(customer.field + 1, main.field + 1);
      const key = `${customer.moduleId}\u0000${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finding("encl.busbar_role", "info", customer.moduleId, message));
    }
  }
  return out;
}

// ── Supply kit and infeed ────────────────────────────────────────────────────

const activeItem = (state: PrepState, prefix: string) => state.items.find((entry) => entry.key.startsWith(prefix) && !entry.suppressed);

function supplyRules(doc: unknown, state: PrepState): PanelFinding[] {
  const { facts } = state;
  const out: PanelFinding[] = [];
  if (facts.supplyHeight !== undefined) out.push(finding("encl.supply_height", "warn", "", COPY.supplyHeight(facts.supplyHeight)));
  if (facts.supplyExisting) out.push(finding("encl.supply_existing", "info", "", COPY.supplyExisting(...facts.supplyExisting)));
  if (facts.infeed?.assumed) out.push(finding("encl.infeed_assumed", "info", "", COPY.infeedAssumed));
  const supply = isRecord(doc) && isRecord(doc.supply) ? doc.supply : {};
  const amps = parseFuseAmps(supply.fuse);
  if (activeItem(state, "accessory:K96ESA5") && amps !== null && amps > K96ESA5_MAX_FUSE_A) {
    const fuse = typeof supply.fuse === "string" ? supply.fuse.trim() : "";
    out.push(finding("encl.infeed_fuse", "warn", "", COPY.infeedFuse(fuse)));
  }
  if (facts.infeedSize !== undefined && facts.infeedSize !== null) out.push(finding("encl.infeed_size", "warn", "", COPY.infeedSize(facts.infeedSize)));
  if (facts.penField !== undefined) out.push(finding("encl.pen_split", "info", "", COPY.penSplit(facts.penField + 1)));
  return out;
}

/** Every round-4 finding of a board, unsorted (the caller sorts). */
export function prepFindings(doc: unknown, index: CatalogIndex, block: BlockArg = DERIVE): PanelFinding[] {
  const parsed = resolveBlock(doc, block);
  const state = analysePrep(doc, index, parsed);
  const findings = [...blockRules(doc, index, parsed, state), ...busbarRules(doc, index)];
  return state ? [...findings, ...supplyRules(doc, state)] : findings;
}
