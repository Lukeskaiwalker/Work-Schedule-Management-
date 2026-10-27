/**
 * The WAGO terminal findings of a cabinet board (docs/PANEL_ENCLOSURE_R2.md
 * §4.1) — the TypeScript twin of
 * `apps/api/app/services/panel_enclosure_terminal_rules.py`, pinned on
 * `test/fixtures/enclosureFixtures.json` through `findings`.
 * `enclosureFindings` (`enclosureRules.ts`) calls `terminalFindings` with
 * the board's precomputed terminals and placement and sorts the result with
 * the rest.
 *
 * Ten rules, in `TERMINAL_RULE_ORDER`. Decisions both twins keep:
 *
 * - "Feld n" is the 0-based field + 1; `{mm}` uses `formatMmText`;
 * - `encl.terminals` counts every terminal of the field's placed strips (end
 *   clamps included, plates not) and sums `usedMm` / `capacityMm` over both
 *   terminal rails;
 * - `encl.terminals_overflow` is info while `TERMINAL_RAIL_USABLE_VERIFIED`
 *   is false and says which usable length it assumed;
 * - `encl.terminals_split` and `encl.terminals_head_field` name the field a
 *   strip's terminals go to — its home field, or for a strip R6 sent on, the
 *   field it was sent to (the N feed wire runs to where the terminals are);
 * - `{Xlist}`: X labels in strip order joined with ", ", at most four, then
 *   ` und {k} weitere`.
 *
 * The trailing sentence of the overflow and reserved-rail findings comes
 * from `suggestionPass` (`enclosureTerminalSuggest.ts`), the same pass that
 * makes the action. Never throws: a finding must not take a board's page
 * down.
 */

import type { CatalogIndex } from "./enclosureCatalog";
import { edgeTrimmed } from "./edgeTrim";
import { formatMmText } from "./enclosureGeometry";
import { zoneLabel } from "./enclosureLayout";
import {
  ORDER_IGNORED,
  TERMINAL_RAIL_USABLE_MM,
  TERMINAL_RAIL_USABLE_VERIFIED,
  boardTerminals,
  deviceFields,
  enclosureOf,
  ident,
  linkedRails,
  placeTerminals,
  rowDevices,
  rowsOf,
  type BoardTerminals,
} from "./enclosureTerminals";
import { headLabel, isPlaceholder, joinAnd, suggestionPass, type SuggestionPass } from "./enclosureTerminalSuggest";
import { DEVICE_CATALOG } from "./schaltplanDevices";
import { OUTGOING_PART_IDS, hasTerminal } from "./schaltplanTerminalRules";
import { STRIP_KIND_LEISTE, type TerminalGroup, type TerminalStrip } from "./schaltplanTerminals";
import type { TerminalFieldPlacement, TerminalPlacement, ZoneSpec } from "../types/panelEnclosure";
import type { DeviceKind, PanelDevice, PanelDocument, PanelFinding, PanelRow } from "../types/schaltplan";

export const TERMINAL_RULE_ORDER = [
  "encl.terminals", "encl.terminals_overflow", "encl.terminal_order_ignored", "encl.terminal_rail_devices",
  "encl.terminal_placeholders", "encl.terminals_elsewhere", "encl.terminals_no_field", "encl.terminals_split",
  "encl.terminals_head_field", "encl.terminals_zone",
] as const;
export const XLIST_MAX = 4;

/** The board's terminals and their placement, computed once per document (§6.7). */
export interface TerminalPrecomputed {
  terms: BoardTerminals;
  placement: TerminalPlacement;
}

type Rule = (typeof TERMINAL_RULE_ORDER)[number];
type StripEntry = { group: TerminalGroup; strip: TerminalStrip };

/** What the ten checks read, computed once. */
interface Board {
  placement: TerminalPlacement;
  fields: readonly TerminalFieldPlacement[];
  rows: ReadonlyMap<string, PanelRow>;
  strips: ReadonlyMap<string, StripEntry>;
  numbers: ReadonlyMap<string, number>;
  fieldsOf: ReadonlyMap<string, number>;
  skip: ReadonlySet<string>;
  /** strip id → the field its terminals go to. */
  target: ReadonlyMap<string, number>;
  /** row id → the zone of the rail it hangs on. */
  zones: ReadonlyMap<string, ZoneSpec>;
}

type Check = (board: Board, pass: SuggestionPass) => PanelFinding[];

const finding = (rule: Rule, level: "warn" | "info", scope: string, message: string): PanelFinding => ({ level, scope, message, rule });

const trimmed = edgeTrimmed;

function xList(labels: readonly string[]): string {
  const shown = labels.slice(0, XLIST_MAX).join(", ");
  return labels.length > XLIST_MAX ? `${shown} und ${labels.length - XLIST_MAX} weitere` : shown;
}

function bmk(device: PanelDevice): string {
  return trimmed(device.designation) || (DEVICE_CATALOG[device.kind as DeviceKind]?.short ?? (trimmed(device.kind) || "?"));
}

const rowName = (row: PanelRow): string => trimmed(row.label) || String(row.id);

function readBoard(doc: PanelDocument, index: CatalogIndex, terms: BoardTerminals, placement: TerminalPlacement): Board {
  const strips = new Map<string, StripEntry>();
  for (const group of terms.groups) for (const strip of group.strips) strips.set(strip.stripId, { group, strip });
  const target = new Map<string, number>();
  for (const field of placement.fields) {
    for (const rail of field.rails) for (const strip of rail.strips) target.set(strip.stripId, field.field);
    for (const strip of field.unplaced) target.set(strip.stripId, field.field);
  }
  return {
    placement,
    fields: placement.fields,
    rows: new Map(rowsOf(doc).map((row) => [row.id, row] as const)),
    strips,
    numbers: new Map([...strips].map(([stripId, { strip }]) => [stripId, Number(strip.stripNo)] as const)),
    fieldsOf: deviceFields(doc, index),
    skip: terms.skip,
    target,
    zones: new Map([...linkedRails(doc, index)].map(([rowId, link]) => [rowId, link.zone] as const)),
  };
}

const xLabel = (board: Board, stripId: string): string => {
  const entry = board.strips.get(stripId);
  return entry ? String(entry.strip.xLabel) : stripId;
};

function terminalRows(board: Board): PanelRow[] {
  return board.fields.flatMap((field) =>
    field.rails.flatMap((rail) => (rail.rowId && board.rows.has(rail.rowId) ? [board.rows.get(rail.rowId)!] : [])),
  );
}

const placed: Check = (board) =>
  board.fields.flatMap((field) => {
    const ids = field.rails.flatMap((rail) => rail.strips.map((strip) => strip.stripId));
    if (ids.length === 0) return [];
    let count = 0;
    for (const stripId of ids) count += board.strips.get(stripId)?.strip.terminals.length ?? 0;
    let used = 0;
    let cap = 0;
    for (const rail of field.rails) {
      used += rail.usedMm;
      cap += rail.capacityMm;
    }
    return [finding("encl.terminals", "info", "",
      `Feld ${field.field + 1}: ${count} Reihenklemmen auf den oberen Hutschienen, ${formatMmText(used)} von ${formatMmText(cap)} mm belegt.`)];
  });

const overflow: Check = (board, pass) => {
  const verified = TERMINAL_RAIL_USABLE_VERIFIED;
  const assumed = verified ? "" : `, Nutzlänge ${formatMmText(TERMINAL_RAIL_USABLE_MM)} mm je Hutschiene angenommen`;
  return board.fields.flatMap((field) => {
    if (field.unplaced.length === 0 || field.rails.length === 0) return [];
    const message = `Feld ${field.field + 1}: ${field.unplaced.length} Klemmleiste(n) passen nicht auf die zwei oberen Hutschienen ` +
      `(${formatMmText(field.missingMm)} mm ohne Platz${assumed}) — eine dritte Hutschiene wird nicht belegt.` +
      (pass.overflowSentences.get(field.field) ?? "");
    return [finding("encl.terminals_overflow", verified ? "warn" : "info", field.rails[0].moduleId, message)];
  });
};

const orderIgnored: Check = (board) =>
  board.fields
    .filter((field) => field.order === ORDER_IGNORED)
    .map((field) => finding("encl.terminal_order_ignored", "info", String(field.orderModuleId || ""),
      `Feld ${field.field + 1}: Die manuelle Aufteilung der Klemmleisten passt nicht mehr — automatisch verteilt.`));

const railDevices: Check = (board, pass) =>
  terminalRows(board).flatMap((row) => {
    const count = rowDevices(row).filter((device) => !isPlaceholder(device)).length;
    if (count === 0) return [];
    return [finding("encl.terminal_rail_devices", "warn", row.id,
      `${rowName(row)}: Hutschiene ist für Reihenklemmen reserviert — ${count} Gerät(e) tiefer setzen.${pass.rowSentences.get(row.id) ?? ""}`)];
  });

const placeholders: Check = (board) =>
  terminalRows(board).flatMap((row) => {
    const count = rowDevices(row).filter(isPlaceholder).length;
    if (count === 0) return [];
    return [finding("encl.terminal_placeholders", "info", row.id,
      `${rowName(row)}: ${count} Platzhalter-Reihenklemme(n) — Reihenklemmen werden jetzt aus den Stromkreisen abgeleitet.`)];
  });

const elsewhere: Check = (board) => {
  const byHome = new Map<number, TerminalPlacement["elsewhere"]>();
  for (const entry of board.placement.elsewhere) byHome.set(entry.homeField, [...(byHome.get(entry.homeField) ?? []), entry]);
  return [...byHome.keys()].sort((a, b) => a - b).map((home) => {
    const entries = byHome.get(home)!;
    const labels = entries.map((entry) => xLabel(board, entry.stripId));
    return finding("encl.terminals_elsewhere", "info", "",
      `Feld ${home + 1} hat keine Hutschienen für Reihenklemmen — ${xList(labels)} in Feld ${entries[0].field + 1}.`);
  });
};

const noField: Check = (board) => {
  const ids = [...new Set([...board.placement.outside, ...board.placement.noRails])];
  if (ids.length === 0) return [];
  const number = (stripId: string) => board.numbers.get(stripId) ?? 0;
  const ordered = [...ids].sort((a, b) => number(a) - number(b) || (a < b ? -1 : a > b ? 1 : 0));
  return [finding("encl.terminals_no_field", "info", "",
    `${xList(ordered.map((stripId) => xLabel(board, stripId)))}: kein Platz für Reihenklemmen — Stromkreise nicht in einem Verteilerfeld.`)];
};

/** [group, strip, target field] of every Leiste that goes to a field, in strip order. */
function leisten(board: Board): [TerminalGroup, TerminalStrip, number][] {
  return [...board.strips]
    .sort(([a], [b]) => board.numbers.get(a)! - board.numbers.get(b)!)
    .filter(([stripId, { strip }]) => strip.kind === STRIP_KIND_LEISTE && board.target.has(stripId))
    .map(([stripId, { group, strip }]) => [group, strip, board.target.get(stripId)!]);
}

const split: Check = (board) =>
  leisten(board).flatMap(([group, strip, target]) => {
    const fields = new Set<number>();
    for (const terminal of strip.terminals) {
      const deviceId = terminal.deviceId;
      if (OUTGOING_PART_IDS.has(terminal.partId) && deviceId !== null && board.fieldsOf.has(deviceId)) fields.add(board.fieldsOf.get(deviceId)!);
    }
    if (fields.size < 2) return [];
    const names = [...fields].sort((a, b) => a - b).map((field) => String(field + 1));
    return [finding("encl.terminals_split", "info", "",
      `${strip.xLabel} (${headLabel(group.headDevice)}): Stromkreise in Feld ${joinAnd(names)} — Reihenklemmen in Feld ${target + 1}.`)];
  });

const headField: Check = (board) =>
  leisten(board).flatMap(([group, strip, target]) => {
    const head = group.headDevice;
    const field = head ? board.fieldsOf.get(ident(head.id)) : undefined;
    if (field === undefined || field === target) return [];
    return [finding("encl.terminals_head_field", "info", "",
      `${strip.xLabel} (${headLabel(head)}): Schutzgerät in Feld ${field + 1}, Klemmen in Feld ${target + 1} — N-Zuleitung über die Feldgrenze.`)];
  });

const zone: Check = (board) => {
  if (board.skip.size === 0) return [];
  return [...board.rows].flatMap(([rowId, row]) => {
    const where = board.zones.get(rowId);
    if (!where) return [];
    return rowDevices(row)
      .filter((device) => board.skip.has(ident(device.id)) && hasTerminal(device))
      .map((device) => finding("encl.terminals_zone", "info", ident(device.id),
        `${bmk(device)}: im ${zoneLabel(where)} — keine Reihenklemme (nur in Verteilerfeldern).`));
  });
};

const CHECKS: readonly Check[] = [placed, overflow, orderIgnored, railDevices, placeholders, elsewhere, noField, split, headField, zone];

/**
 * The terminal findings of a cabinet board, in check order; [] without a
 * cabinet. `pre`: the board's `boardTerminals` and `placeTerminals`, when the
 * caller already has them (derived otherwise). Never throws: whatever trips
 * is logged and the board shows no terminal findings.
 */
export function terminalFindings(doc: PanelDocument, index: CatalogIndex, pre?: TerminalPrecomputed): PanelFinding[] {
  try {
    if (!enclosureOf(doc)) return [];
    const terms = pre?.terms ?? boardTerminals(doc, index);
    const placement = pre?.placement ?? placeTerminals(doc, index, terms);
    const board = readBoard(doc, index, terms, placement);
    const pass = suggestionPass(doc, index, terms, placement);
    return CHECKS.flatMap((check) => check(board, pass));
  } catch (error) {
    console.warn("Reihenklemmen-Prüfung übersprungen", error);
    return [];
  }
}
