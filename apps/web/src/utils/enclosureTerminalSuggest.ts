/**
 * What to do about the terminal findings: one sequential pass
 * (docs/PANEL_ENCLOSURE_R2.md §4.2) — the TypeScript twin of
 * `apps/api/app/services/panel_enclosure_terminal_suggest.py`, pinned on
 * `test/fixtures/enclosureFixtures.json` (`terminal_suggestions`). The
 * finding's sentence comes out of the same pass as the action
 * (`suggestionPass`), so the text and the button cannot disagree. `taken`
 * (rails already named as a target) carries through all steps:
 *
 * 1. **Vacate** (`relink_rows`), per field with reserved rows, ascending: the
 *    field's terminal-rail rows that hold real devices move together onto the
 *    first field (same field first, then by `(|Δ|, index)`) with that many
 *    eligible rails, top → bottom; failing that, each row onto the first
 *    eligible rail anywhere, in the same order. Eligible: a non-reserved,
 *    non-retired VT rail without a row or with an empty one, not taken, whose
 *    PLE length holds the row.
 * 2. **Hypothetical board**: if step 1 moved anything, the board is re-placed
 *    as if it were done, and every overflowing field says whether vacating
 *    alone would make its strips fit. No move is suggested anywhere then.
 * 3. **Move a group** (`move_group`, only without a vacate), per overflowing
 *    field ascending: the first unplaced strip of the field's own (strips R6
 *    brought in are skipped) whose group has a head. The head and the group's
 *    circuits on the field's rails travel together (owner, 2026-10-22: an FI
 *    moves with its circuits) onto the shortest prefix of another field's
 *    eligible rails that takes them, fields by `(|Δ|, index)`. A field is
 *    accepted only when a virtual move and a re-placement show fewer
 *    unplaced strips and no placed strip lost its place.
 * 4. `reset_order` for an ignored manual order, `remove_placeholders` for
 *    the hand-placed "Reihenklemme N/PE" on terminal rails.
 */

import type { CatalogIndex } from "./enclosureCatalog";
import { enclosureDeviceWidthMm } from "./enclosureLayout";
import { formatMmText } from "./enclosureGeometry";
import {
  ORDER_IGNORED,
  PLACEHOLDER_KINDS,
  TOLERANCE_MM,
  boardTerminals,
  deviceFields,
  enclosureOf,
  ident,
  placeTerminals,
  rowDevices,
  rowsOf,
  type BoardTerminals,
} from "./enclosureTerminals";
import { boardRowOrder, fillRails, railPlaceKey, virtualMove, virtualRelink, vtRails, type RailRef } from "./enclosureTerminalVirtual";
import { DEVICE_CATALOG } from "./schaltplanDevices";
import type { TerminalGroup } from "./schaltplanTerminals";
import { buildTopology } from "./schaltplanTopologyCore";
import type { TerminalFieldPlacement, TerminalPlacement, TerminalSuggestion } from "../types/panelEnclosure";
import type { DeviceKind, PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

export const RULE_RAIL_DEVICES = "encl.terminal_rail_devices";
export const RULE_OVERFLOW = "encl.terminals_overflow";
export const RULE_ORDER_IGNORED = "encl.terminal_order_ignored";
export const RULE_PLACEHOLDERS = "encl.terminal_placeholders";

export const VACATE_NOWHERE = " Keine leere Hutschiene frei — Geräte einzeln wegziehen (gedrückt halten).";
export const VACATE_FIRST_FITS = " Zuerst die reservierten Hutschienen räumen (Vorschlag „umhängen“) — danach passen alle Klemmleisten.";
export const MOVE_NONE = " Kein anderes Feld hat genug Platz — Verteilerfeld ergänzen oder bei einzelnen Stromkreisen „Reihenklemme“ abwählen.";
export const MOVE_SUPPLY = " Stromkreise vor dem ersten Schutzgerät — einzeln in ein anderes Feld ziehen.";

/** The pass's actions, and the sentences their findings end with. */
export interface SuggestionPass {
  suggestions: TerminalSuggestion[];
  /** Reserved row id → the sentence its `encl.terminal_rail_devices` ends with. */
  rowSentences: ReadonlyMap<string, string>;
  /** Field → the sentence its `encl.terminals_overflow` ends with. */
  overflowSentences: ReadonlyMap<number, string>;
}

const EMPTY_PASS: SuggestionPass = Object.freeze({ suggestions: [], rowSentences: new Map(), overflowSentences: new Map() });

/** "a", "a und b", "a, b und c". */
export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} und ${items[items.length - 1]}`;
}

export const isPlaceholder = (device: PanelDevice): boolean => PLACEHOLDER_KINDS.has(String(device.kind ?? ""));

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** "Q1" / "FI" / "Einspeisung": how a group head reads in a sentence (`group_head_label`). */
export function headLabel(head: PanelDevice | null): string {
  if (!head) return "Einspeisung";
  return trimmed(head.designation) || (DEVICE_CATALOG[head.kind as DeviceKind]?.short ?? "?");
}

/** field → the rows linked to its terminal rails, in rail order. */
export function reservedRows(doc: PanelDocument, placement: TerminalPlacement): Map<number, PanelRow[]> {
  const rows = new Map(rowsOf(doc).map((row) => [row.id, row] as const));
  const out = new Map<number, PanelRow[]>();
  for (const field of placement.fields) {
    const found = field.rails.flatMap((rail) => (rail.rowId && rows.has(rail.rowId) ? [rows.get(rail.rowId)!] : []));
    if (found.length > 0) out.set(field.field, found);
  }
  return out;
}

const realDevices = (row: PanelRow): PanelDevice[] => rowDevices(row).filter((device) => !isPlaceholder(device));

/** What every step reads; `taken` grows step by step as a new context. */
interface Context {
  readonly doc: PanelDocument;
  readonly index: CatalogIndex;
  readonly placement: TerminalPlacement;
  readonly vt: ReadonlyMap<number, readonly RailRef[]>;
  readonly reserved: ReadonlySet<string>;
  readonly taken: ReadonlySet<string>;
}

const placeOf = (ref: RailRef): string => railPlaceKey(ref.moduleId, ref.key);

const eligible = (ctx: Context, ref: RailRef): boolean =>
  !ctx.reserved.has(placeOf(ref)) && !ctx.taken.has(placeOf(ref)) && !ref.rail.retired && rowDevices(ref.row ?? undefined).length === 0;

const free = (ctx: Context, field: number): RailRef[] => (ctx.vt.get(field) ?? []).filter((ref) => eligible(ctx, ref));

const taking = (ctx: Context, refs: readonly RailRef[]): Context => ({ ...ctx, taken: new Set([...ctx.taken, ...refs.map(placeOf)]) });

/** Candidates nearest first: by (|m − field|, m). */
const byDistance = (field: number, candidates: readonly number[]): number[] =>
  [...candidates].sort((a, b) => Math.abs(a - field) - Math.abs(b - field) || a - b);

/** The row's devices, placeholders included (they travel with the row), fit the rail's PLE length. */
function holds(ref: RailRef, row: PanelRow): boolean {
  let width = 0;
  for (const device of rowDevices(row)) width += enclosureDeviceWidthMm(device, ref.rail);
  return width <= ref.capacityMm + TOLERANCE_MM;
}

// ── 1. vacate ────────────────────────────────────────────────────────────────

function vacateTargets(start: Context, field: number, rows: readonly PanelRow[]): [(RailRef | null)[], Context] {
  const order = byDistance(field, [...start.vt.keys()]);
  for (const m of order) {
    const rails = free(start, m);
    if (rails.length >= rows.length && rows.every((row, k) => holds(rails[k], row))) {
      const chosen = rails.slice(0, rows.length);
      return [chosen, taking(start, chosen)];
    }
  }
  let ctx = start;
  const targets: (RailRef | null)[] = [];
  for (const row of rows) {
    const target = order.flatMap((m) => free(ctx, m)).find((ref) => holds(ref, row)) ?? null;
    if (target) ctx = taking(ctx, [target]);
    targets.push(target);
  }
  return [targets, ctx];
}

type Vacate = Extract<TerminalSuggestion, { kind: "relink_rows" }>;

function vacate(start: Context, rowsOfField: ReadonlyMap<number, PanelRow[]>): [Vacate[], Map<string, string>, Context] {
  let ctx = start;
  const suggestions: Vacate[] = [];
  const sentences = new Map<string, string>();
  for (const field of [...rowsOfField.keys()].sort((a, b) => a - b)) {
    const rows = rowsOfField.get(field)!.filter((row) => realDevices(row).length > 0);
    if (rows.length === 0) continue;
    const [targets, next] = vacateTargets(ctx, field, rows);
    ctx = next;
    const moves = rows.flatMap((row, k) => (targets[k] ? [{ rowId: row.id, target: targets[k]!.target() }] : []));
    let sentence = "";
    if (moves.length > 0) {
      const titles = joinAnd(moves.map((move) => move.target.title));
      sentence = ` Vorschlag: ${moves.length === 1 ? "Reihe" : "Reihen"} auf ${titles} umhängen.`;
      suggestions.push({ rule: RULE_RAIL_DEVICES, field, kind: "relink_rows", scopes: moves.map((move) => move.rowId), moves });
    }
    rows.forEach((row, k) => sentences.set(row.id, targets[k] ? sentence : VACATE_NOWHERE));
  }
  return [suggestions, sentences, ctx];
}

// ── 2. the hypothetical board ────────────────────────────────────────────────

function afterVacate(ctx: Context, moves: Vacate["moves"], overflowing: readonly TerminalFieldPlacement[]): Map<number, string> {
  const relinked = virtualRelink(ctx.doc, ctx.index, moves);
  const after = new Map(placeTerminals(relinked, ctx.index).fields.map((field) => [field.field, field] as const));
  const sentences = new Map<number, string>();
  for (const field of overflowing) {
    const again = after.get(field.field);
    sentences.set(field.field, !again || again.unplaced.length === 0
      ? VACATE_FIRST_FITS
      : ` Zuerst die reservierten Hutschienen räumen — danach fehlen noch ${formatMmText(again.missingMm)} mm.`);
  }
  return sentences;
}

// ── 3. move a group ──────────────────────────────────────────────────────────

/** The head and its group's circuits on the field's rails, in reading order. */
function groupDevices(ctx: Context, head: PanelDevice, field: number): string[] {
  const headId = ident(head.id);
  const fieldsOf = deviceFields(ctx.doc, ctx.index);
  const group = buildTopology(ctx.doc).find((candidate) => candidate.device !== null && ident(candidate.device.id) === headId);
  const members = new Set([headId, ...(group?.children ?? []).map((child) => ident(child.id)).filter((id) => fieldsOf.get(id) === field)]);
  const rows = new Map(rowsOf(ctx.doc).map((row) => [row.id, row] as const));
  const ordered: string[] = [];
  for (const rowId of boardRowOrder(ctx.doc, ctx.index)) {
    for (const device of rowDevices(rows.get(rowId))) {
      const id = ident(device.id);
      if (members.has(id) && !ordered.includes(id)) ordered.push(id);
    }
  }
  return ordered;
}

function stripSets(placement: TerminalPlacement): { placed: Set<string>; unplaced: Set<string> } {
  const placed = new Set(placement.fields.flatMap((field) => field.rails.flatMap((rail) => rail.strips.map((strip) => strip.stripId))));
  const unplaced = new Set(placement.fields.flatMap((field) => field.unplaced.map((strip) => strip.stripId)));
  return { placed, unplaced };
}

/** The first other field's rails that take the group and really place more, or null. */
function tryMove(ctx: Context, field: number, deviceIds: readonly string[]): RailRef[] | null {
  const byId = new Map<string, PanelDevice>(); // the later id wins, as Python's dict
  for (const row of rowsOf(ctx.doc)) for (const device of rowDevices(row)) byId.set(ident(device.id), device);
  const devices = deviceIds.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  const { placed, unplaced } = stripSets(ctx.placement);
  const fields = ctx.placement.fields.map((candidate) => candidate.field).filter((candidate) => candidate !== field);
  for (const m of byDistance(field, fields)) {
    const rails = free(ctx, m);
    const [assignment, complete] = fillRails(devices, rails);
    if (!complete || assignment.length === 0) continue;
    const targets = rails.slice(0, Math.max(...assignment) + 1);
    const moved = virtualMove(ctx.doc, ctx.index, deviceIds, targets.map((ref) => ref.target()));
    const after = stripSets(placeTerminals(moved, ctx.index)).unplaced;
    if (after.size < unplaced.size && ![...after].some((stripId) => placed.has(stripId))) return targets;
  }
  return null;
}

type MoveGroup = Extract<TerminalSuggestion, { kind: "move_group" }>;

function moveGroups(start: Context, terms: BoardTerminals, overflowing: readonly TerminalFieldPlacement[]): [MoveGroup[], Map<number, string>] {
  let ctx = start;
  const groups = new Map<string, TerminalGroup>();
  for (const group of terms.groups) for (const strip of group.strips) groups.set(strip.stripId, group);
  const elsewhere = new Set(ctx.placement.elsewhere.map((entry) => entry.stripId));
  const suggestions: MoveGroup[] = [];
  const sentences = new Map<number, string>();
  for (const field of overflowing) {
    const number = field.field;
    const own = field.unplaced.map((strip) => strip.stripId).filter((stripId) => !elsewhere.has(stripId) && groups.has(stripId));
    const headed = own.find((stripId) => groups.get(stripId)!.headDevice !== null);
    if (headed === undefined) {
      sentences.set(number, own.length > 0 ? MOVE_SUPPLY : MOVE_NONE);
      continue;
    }
    const head = groups.get(headed)!.headDevice!;
    const deviceIds = groupDevices(ctx, head, number);
    const targets = tryMove(ctx, number, deviceIds);
    if (!targets) {
      sentences.set(number, MOVE_NONE);
      continue;
    }
    ctx = taking(ctx, targets);
    const titles = joinAnd(targets.map((ref) => ref.title));
    sentences.set(number, ` Vorschlag: ${headLabel(head)} mit ${deviceIds.length - 1} Stromkreis(en) nach ${titles} verschieben.`);
    suggestions.push({
      rule: RULE_OVERFLOW, field: number, kind: "move_group", scope: field.rails[0].moduleId, headId: ident(head.id),
      deviceIds: [...deviceIds], targets: targets.map((ref) => ref.target()),
    });
  }
  return [suggestions, sentences];
}

// ── 4. order and placeholders ────────────────────────────────────────────────

function tidy(placement: TerminalPlacement, rowsOfField: ReadonlyMap<number, PanelRow[]>): TerminalSuggestion[] {
  const out: TerminalSuggestion[] = [];
  for (const field of placement.fields) {
    const number = field.field;
    if (field.order === ORDER_IGNORED && field.orderModuleId) {
      out.push({ rule: RULE_ORDER_IGNORED, field: number, kind: "reset_order", scope: field.orderModuleId });
    }
    const rows = (rowsOfField.get(number) ?? []).filter((row) => rowDevices(row).some(isPlaceholder));
    if (rows.length > 0) {
      out.push({
        rule: RULE_PLACEHOLDERS, field: number, kind: "remove_placeholders", scopes: rows.map((row) => row.id),
        deviceIds: rows.flatMap((row) => rowDevices(row).filter(isPlaceholder).map((device) => ident(device.id))),
      });
    }
  }
  return out;
}

// ── entry points ─────────────────────────────────────────────────────────────

interface PassMemo {
  index: CatalogIndex;
  terms: BoardTerminals;
  placement: TerminalPlacement;
  pass: SuggestionPass;
}

/**
 * The last pass per document. The page's findings, the Schrank tab and the
 * Aufbau tab all ask for the same board's pass (§6.7); the inputs are never
 * changed in place, so identity is enough.
 */
const PASS_MEMO = new WeakMap<PanelDocument, PassMemo>();

/** The four steps in order (see the module doc); memoised per (document, index, terms, placement). */
export function suggestionPass(doc: PanelDocument, index: CatalogIndex, terms: BoardTerminals, placement: TerminalPlacement): SuggestionPass {
  if (!enclosureOf(doc) || placement.fields.length === 0) return EMPTY_PASS;
  const hit = PASS_MEMO.get(doc);
  if (hit && hit.index === index && hit.terms === terms && hit.placement === placement) return hit.pass;
  const pass = computePass(doc, index, terms, placement);
  PASS_MEMO.set(doc, { index, terms, placement, pass });
  return pass;
}

function computePass(doc: PanelDocument, index: CatalogIndex, terms: BoardTerminals, placement: TerminalPlacement): SuggestionPass {
  const reserved = new Set(placement.fields.flatMap((field) => field.rails.map((rail) => railPlaceKey(rail.moduleId, rail.railKey))));
  const start: Context = { doc, index, placement, vt: vtRails(doc, index), reserved, taken: new Set() };
  const rowsOfField = reservedRows(doc, placement);
  const [vacates, rowSentences, ctx] = vacate(start, rowsOfField);
  const overflowing = placement.fields.filter((field) => field.unplaced.length > 0);
  const moves = vacates.flatMap((suggestion) => suggestion.moves);
  const [moved, overflowSentences] = moves.length > 0
    ? [[] as MoveGroup[], afterVacate(ctx, moves, overflowing)]
    : moveGroups(ctx, terms, overflowing);
  return { suggestions: [...vacates, ...moved, ...tidy(placement, rowsOfField)], rowSentences, overflowSentences };
}

/**
 * Every suggestion of the board, in pass order (§4.2); [] without a
 * cabinet. `terms`/`placement`: the board's `boardTerminals` and
 * `placeTerminals`, when the caller already has them. Broken rows (the
 * server never stores them) are read as Python reads them; whatever still
 * trips gives no suggestions and a console warning, never a throw.
 */
export function terminalSuggestions(
  doc: PanelDocument, index: CatalogIndex, terms?: BoardTerminals, placement?: TerminalPlacement,
): TerminalSuggestion[] {
  if (!enclosureOf(doc)) return [];
  let resolved: BoardTerminals;
  try {
    resolved = terms ?? boardTerminals(doc, index);
  } catch (error) {
    console.warn("Vorschläge für Reihenklemmen übersprungen", error);
    return [];
  }
  const placed = placement ?? placeTerminals(doc, index, resolved);
  try {
    return [...suggestionPass(doc, index, resolved, placed).suggestions];
  } catch (error) {
    console.warn("Vorschläge für Reihenklemmen übersprungen", error);
    return [];
  }
}
