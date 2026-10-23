/**
 * The ops on WAGO terminals in the cabinet (docs/PANEL_ENCLOSURE_R2.md
 * §2.1, §4.2, §6.4, R5, R11, R12). Import them from here; each is pure.
 *
 * - `moveTerminalStrip`: the manual WAGO order. A whole strip (Leiste or
 *   Block) moves within its field's two terminal rails (owner, 2026-10-22).
 *   The field's ONE stored sequence is rewritten from the strips as they are
 *   placed right now (stale ids drop out at that moment), on the module
 *   holding the field's first terminal rail; the field's entry goes off its
 *   other modules, and goes altogether when the result is the default
 *   placement. A split (`rail2_from`) is stored only where it is needed and
 *   fits; while strips are without place it cannot fit (they count onto
 *   rail 2, R5), so the order is stored without one ("split
 *   automatically", §2.1) whenever that packs exactly the rails asked for.
 *   Anything else is refused, never stored: the placement would only
 *   ignore it.
 * - `resetTerminalOrder`: "Reihenfolge zurücksetzen".
 * - `relinkRows`: the vacate — rows re-pointed to empty rails, devices and
 *   row ids untouched, generated labels follow their rail, one C§2.4 finish.
 * - `moveGroupToRails`: "move circuits" — the devices filled onto the target
 *   rails in order, never reordered (`fillRails`, the suggestion's own rule),
 *   one finish.
 * - `removeTerminalPlaceholders`: the hand-placed "Reihenklemme N/PE" on
 *   terminal rails, through `removeDevices`.
 *
 * The fit numbers (`planStripMove`, `stripMoveOverMm`) are the placement's
 * own: devices on the rail, every strip's parts, the end plate after the
 * rail's last terminal block, 0,05 mm tolerance. The drag label uses the same
 * number, so it and the refusal cannot disagree.
 */

import type { CatalogIndex } from "./enclosureCatalog";
import { formatMmText, round1 } from "./enclosureGeometry";
import { generatedRowLabel, linkedRows, railRowId, resolvableRails } from "./enclosureLayout";
import {
  DEVICE_NOT_FOUND,
  ensureRailRow,
  findModule,
  finish,
  MODULE_NOT_FOUND,
  moveDevicesInto,
  RAIL_NOT_EMPTY,
  railRetired,
  railUnknown,
  refuse,
  ROW_NOT_FOUND,
  unchanged,
  withModules,
  type OpResult,
} from "./enclosureOpsCore";
import { moduleArticle } from "./enclosureCatalog";
import {
  FIELD_OFFSET_KEYS,
  PLACEHOLDER_KINDS,
  TOLERANCE_MM,
  asInt,
  boardTerminals,
  parseTerminalOrder,
  placeTerminals,
  terminalRails,
  type BoardTerminals,
  type TerminalRail,
} from "./enclosureTerminals";
import { fillRails, railRef, type RailName, type RailRef } from "./enclosureTerminalVirtual";
import { rowUsedSlots } from "./schaltplanDevices";
import { removeDevices } from "./schaltplanDocumentOps";
import { END_PART_IDS, TERMINAL_PARTS } from "./schaltplanTerminalRules";
import { findDevice } from "./schaltplanTopologyCore";
import type { EnclosureModule, TerminalFieldPlacement, TerminalOrderEntry, TerminalPlacement } from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

// ── Copy (§13) ───────────────────────────────────────────────────────────────

export const STRIP_NOT_FOUND = "Klemmleiste nicht gefunden.";
export const RAIL_NOT_FOUND = "Hutschiene nicht gefunden.";
/** `field` 0-based: the field the strip's circuits are in. */
export const stripOtherField = (field: number) => `Klemmen gehören zu Feld ${field + 1} — die Stromkreise verschieben, nicht die Klemmen.`;
/** `rail` 0-based. */
export const stripTooFull = (mm: number, rail: number) => `Passt nicht: ${formatMmText(mm)} mm zu viel auf Hutschiene ${rail + 1}.`;
export const noTerminalRail = (field: number, rail: number) => `Feld ${field + 1} hat keine Hutschiene ${rail + 1} für Reihenklemmen.`;

// ── Strips ───────────────────────────────────────────────────────────────────

/** Where a strip goes: its field, rail 0 (top) or 1, and its index among that rail's OTHER strips. */
export interface StripTarget {
  field: number;
  rail: 0 | 1;
  at: number;
}

export interface Precomputed {
  terms: BoardTerminals;
  placement: TerminalPlacement;
}

/** What a strip move would make of its field. */
export interface StripPlan {
  field: number;
  /** The holder of the field's first terminal rail: where the order is stored. */
  holderId: string;
  /** Strip ids per terminal rail, after the move. */
  rails: string[][];
  /** Strips still without place (they stay last in the sequence). */
  unplaced: string[];
  /** The rail that would run over, and by how much (0,1 mm); null when it fits. */
  over: { rail: 0 | 1; mm: number } | null;
  /** Rail 2 must start at its first strip (`rail2_from`); false: the field packs itself into exactly `rails`. */
  split: boolean;
  unchanged: boolean;
}

interface StripMeasure {
  width: number;
  plateMm: number;
}

/** Per strip: Σ part widths left → right, and the end plate a rail ending in it takes (as `placeTerminals` measures). */
function stripMeasures(terms: BoardTerminals): Map<string, StripMeasure> {
  const out = new Map<string, StripMeasure>();
  for (const group of terms.groups) {
    for (const strip of group.strips) {
      let width = 0;
      for (const terminal of strip.terminals) width += terminal.widthMm;
      const last = [...strip.terminals].reverse().find((terminal) => !END_PART_IDS.has(terminal.partId));
      const plate = last ? TERMINAL_PARTS[last.partId].endPlate : null;
      out.set(strip.stripId, { width, plateMm: plate ? TERMINAL_PARTS[plate].widthMm : 0 });
    }
  }
  return out;
}

function usedMm(rail: TerminalRail, ids: readonly string[], measures: ReadonlyMap<string, StripMeasure>): number {
  let used = rail.devicesMm;
  if (ids.length === 0) return used;
  for (const id of ids) used += measures.get(id)?.width ?? 0;
  return used + (measures.get(ids[ids.length - 1])?.plateMm ?? 0);
}

function overOf(rail: TerminalRail, ids: readonly string[], measures: ReadonlyMap<string, StripMeasure>): number {
  const used = usedMm(rail, ids, measures);
  return used > rail.capacityMm + TOLERANCE_MM ? round1(used - rail.capacityMm) : 0;
}

const fitsOn = (rail: TerminalRail, ids: readonly string[], measures: ReadonlyMap<string, StripMeasure>): boolean =>
  usedMm(rail, ids, measures) <= rail.capacityMm + TOLERANCE_MM;

/**
 * The field's rails for `seq` without a split, as `placeTerminals` packs
 * them: next-fit in sequence order, then each strip left over first-fit at
 * the end of rail 1, else rail 2. Strip ids only.
 */
function autoPacked(rails: readonly TerminalRail[], seq: readonly string[], measures: ReadonlyMap<string, StripMeasure>): string[][] {
  let content: string[][] = rails.map(() => []);
  const put = (at: number, id: string) => {
    content = content.map((ids, i) => (i === at ? [...ids, id] : ids));
  };
  let cursor = 0;
  let left: string[] = [];
  for (const id of seq) {
    let at = cursor;
    while (at < rails.length && !fitsOn(rails[at], [...content[at], id], measures)) at += 1;
    if (at < rails.length) {
      put(at, id);
      cursor = at;
    } else {
      left = [...left, id];
    }
  }
  for (const id of left) {
    const at = rails.findIndex((rail, i) => fitsOn(rail, [...content[i], id], measures));
    if (at >= 0) put(at, id);
  }
  return content;
}

/** The first of `checks` whose rail runs over, and by how much. */
function firstOver(rails: readonly TerminalRail[], checks: readonly (readonly [0 | 1, readonly string[]])[], measures: ReadonlyMap<string, StripMeasure>): StripPlan["over"] {
  for (const [rail, ids] of checks) {
    const mm = rails[rail] ? overOf(rails[rail], ids, measures) : 0;
    if (mm > 0) return { rail, mm };
  }
  return null;
}

/** The field placement holding the strip, placed or not. */
export function fieldOfStrip(placement: TerminalPlacement, stripId: string): TerminalFieldPlacement | null {
  return (
    placement.fields.find(
      (field) => field.rails.some((rail) => rail.strips.some((strip) => strip.stripId === stripId)) || field.unplaced.some((strip) => strip.stripId === stripId),
    ) ?? null
  );
}

const sameLists = (a: readonly (readonly string[])[], b: readonly (readonly string[])[]) =>
  a.length === b.length && a.every((list, i) => list.length === b[i].length && list.every((id, k) => id === b[i][k]));

/**
 * What moving `stripId` to `target` makes of its field, or why it cannot go
 * there. The sequence is rail 1, then rail 2, then the strips still without
 * place. With strips on rail 2 a split at its first strip is tried first:
 * rail 1 must hold its strips and rail 2 the rest (the unplaced ones
 * included, R5). When it does not fit, the sequence without a split is
 * taken if the field then packs into exactly the rails asked for — the only
 * way to reorder a field that has strips without place. Without strips on
 * rail 2 the field packs automatically, and only the target rail must hold
 * its own.
 */
export function planStripMove(doc: PanelDocument, index: CatalogIndex, stripId: string, target: StripTarget, pre?: Precomputed): StripPlan | { error: string } {
  const terms = pre?.terms ?? boardTerminals(doc, index);
  const placement = pre?.placement ?? placeTerminals(doc, index, terms);
  const field = fieldOfStrip(placement, stripId);
  if (!field) return { error: STRIP_NOT_FOUND };
  if (target.field !== field.field) return { error: stripOtherField(field.field) };
  if (target.rail < 0 || target.rail >= field.rails.length) return { error: noTerminalRail(field.field, target.rail) };
  const before = field.rails.map((rail) => rail.strips.map((strip) => strip.stripId));
  const lists = before.map((ids) => ids.filter((id) => id !== stripId));
  const at = Math.max(0, Math.min(lists[target.rail].length, Math.floor(Number.isFinite(target.at) ? target.at : 0)));
  lists[target.rail] = [...lists[target.rail].slice(0, at), stripId, ...lists[target.rail].slice(at)];
  const unplaced = field.unplaced.map((strip) => strip.stripId).filter((id) => id !== stripId);
  const wasUnplaced = field.unplaced.length !== unplaced.length;
  const rails = terminalRails(doc, index).get(field.field) ?? [];
  const measures = stripMeasures(terms);
  let over: StripPlan["over"];
  let split = false;
  if (lists.length > 1 && lists[1].length > 0) {
    over = firstOver(rails, [[0, lists[0]], [1, [...lists[1], ...unplaced]]], measures);
    split = over === null;
    if (over && sameLists(autoPacked(rails, [...lists.flat(), ...unplaced], measures), lists)) over = null;
  } else {
    over = firstOver(rails, [[target.rail, lists[target.rail]]], measures);
  }
  return {
    field: field.field,
    holderId: field.rails[0].moduleId,
    rails: lists,
    unplaced,
    over,
    split,
    unchanged: !wasUnplaced && sameLists(before, lists),
  };
}

/** How far the move would run a rail over (0,1 mm); 0 when it fits or cannot be made at all. */
export function stripMoveOverMm(doc: PanelDocument, index: CatalogIndex, stripId: string, target: StripTarget, pre?: Precomputed): number {
  const plan = planStripMove(doc, index, stripId, target, pre);
  return "error" in plan || !plan.over ? 0 : plan.over.mm;
}

function withoutKey(order: Record<string, TerminalOrderEntry>, key: string): Record<string, TerminalOrderEntry> {
  return Object.fromEntries(Object.entries(order).filter(([candidate]) => candidate !== key));
}

/** The module with `order` as its terminal_order; the key goes when the order is empty. */
function withOrder(module: EnclosureModule, order: Record<string, TerminalOrderEntry>): EnclosureModule {
  if (Object.keys(order).length > 0) return { ...module, terminal_order: order };
  const { terminal_order: _gone, ...rest } = module;
  return rest;
}

/**
 * The field's entry written to `holderId` (`entry` null: written nowhere)
 * and taken off every other module of the field. Untouched modules keep
 * their identity; with nothing to change the document comes back as it is.
 */
function writeFieldOrder(doc: PanelDocument, field: number, entry: TerminalOrderEntry | null, holderId: string | null): PanelDocument {
  if (!doc.enclosure) return doc;
  let changed = false;
  const next = withModules(doc, (modules) =>
    modules.map((module) => {
      const key = String(field - asInt(module.field));
      const holds = entry !== null && module.id === holderId;
      if (!(FIELD_OFFSET_KEYS as readonly string[]).includes(key)) return module;
      const parsed = parseTerminalOrder(module.terminal_order);
      if (!holds && !(parsed && key in parsed)) return module;
      changed = true;
      const rest = withoutKey(parsed ?? {}, key);
      return withOrder(module, holds ? { ...rest, [key]: entry! } : rest);
    }),
  );
  return changed ? next : doc;
}

function fieldLayout(document: PanelDocument, index: CatalogIndex, field: number): { rails: string[][]; unplaced: string[]; order: string } | null {
  const placed = placeTerminals(document, index).fields.find((candidate) => candidate.field === field);
  if (!placed) return null;
  return { rails: placed.rails.map((rail) => rail.strips.map((strip) => strip.stripId)), unplaced: placed.unplaced.map((strip) => strip.stripId), order: placed.order };
}

const applied = (document: PanelDocument): OpResult => ({ ok: true, document, pinned: [], regrouped: [] });

/** §6.4: a whole strip to another place on its field's terminal rails (R11). */
export function moveTerminalStrip(doc: PanelDocument, index: CatalogIndex, stripId: string, target: StripTarget): OpResult {
  const plan = planStripMove(doc, index, stripId, target);
  if ("error" in plan) return refuse(plan.error);
  if (plan.unchanged) return unchanged(doc);
  if (plan.over) return refuse(stripTooFull(plan.over.mm, plan.over.rail));
  const sequence = [...plan.rails.flat(), ...plan.unplaced];
  const entry: TerminalOrderEntry = { strips: sequence, rail2_from: plan.split ? plan.rails[1][0] : null };
  const fallback = writeFieldOrder(doc, plan.field, null, null);
  const candidate = writeFieldOrder(doc, plan.field, entry, plan.holderId);
  const wanted = fieldLayout(candidate, index, plan.field);
  const plain = fieldLayout(fallback, index, plan.field);
  if (wanted && plain && sameLists([...wanted.rails, wanted.unplaced], [...plain.rails, plain.unplaced])) {
    return fallback === doc ? unchanged(doc) : applied(fallback);
  }
  return applied(candidate);
}

/** "Reihenfolge zurücksetzen": the field's stored order goes, wherever it is; the same document without one. */
export function resetTerminalOrder(doc: PanelDocument, _index: CatalogIndex, field: number): PanelDocument {
  return writeFieldOrder(doc, field, null, null);
}

// ── Rows (the vacate) ────────────────────────────────────────────────────────

export interface RowMove {
  rowId: string;
  target: RailName;
}

interface RowPlan {
  row: PanelRow;
  module: EnclosureModule;
  railKey: string;
  ple: number;
  /** The label the row gets: its target rail's generated one when it carried its old rail's. */
  label: string;
  /** The empty row the target held, which makes room. */
  displaced: string | null;
}

function oldGeneratedLabel(doc: PanelDocument, index: CatalogIndex, rowId: string, links: ReturnType<typeof linkedRows>): string | null {
  const link = links.get(rowId);
  const module = link ? findModule(doc, link.moduleId) : null;
  const ref = module && link ? resolvableRails(module, index).get(link.railKey) : undefined;
  return module && ref ? generatedRowLabel(module, ref.zone, ref.rail) : null;
}

function planRows(doc: PanelDocument, index: CatalogIndex, moves: readonly RowMove[]): RowPlan[] | { error: string } {
  const links = linkedRows(doc, index);
  const rows = new Map(doc.rows.map((candidate) => [candidate.id, candidate] as const));
  const moving = new Set(moves.map((move) => move.rowId));
  const targets = new Set<string>();
  const plans: RowPlan[] = [];
  for (const move of moves) {
    const row = rows.get(move.rowId);
    if (!row) return { error: ROW_NOT_FOUND };
    const module = findModule(doc, move.target.moduleId);
    if (!module) return { error: MODULE_NOT_FOUND };
    const ref = resolvableRails(module, index).get(move.target.railKey);
    if (!ref) return { error: railUnknown(move.target.railKey, moduleArticle(module, index)) };
    if (ref.rail.retired) return { error: railRetired(move.target.railKey, moduleArticle(module, index)) };
    const place = `${module.id}\u0000${move.target.railKey}`;
    const current = railRowId(links, module, move.target.railKey);
    const held = current !== null && !moving.has(current) ? rows.get(current) ?? null : null;
    if (targets.has(place) || (held && held.devices.length > 0)) return { error: RAIL_NOT_EMPTY };
    targets.add(place);
    const generated = oldGeneratedLabel(doc, index, row.id, links);
    const label = generated !== null && row.label === generated ? generatedRowLabel(module, ref.zone, ref.rail) : row.label;
    plans.push({ row, module, railKey: move.target.railKey, ple: ref.rail.ple, label, displaced: held ? held.id : null });
  }
  return plans;
}

/**
 * The vacate (R12): each row re-pointed to an empty rail, all in one op.
 * Rows stay the device container — ids and devices untouched; a generated
 * label follows its rail, a hand-named one stays. A target holding an empty
 * row makes room (that row goes); one holding devices refuses. Ends with the
 * C§2.4 finish: physical order, pins, and the regroup question.
 */
export function relinkRows(doc: PanelDocument, index: CatalogIndex, moves: readonly RowMove[]): OpResult {
  if (moves.length === 0) return unchanged(doc);
  const plans = planRows(doc, index, moves);
  if ("error" in plans) return refuse(plans.error);
  const byRow = new Map(plans.map((plan) => [plan.row.id, plan] as const));
  const displaced = new Set(plans.flatMap((plan) => (plan.displaced ? [plan.displaced] : [])));
  const unlinked = new Set([...byRow.keys(), ...displaced]);
  const rows = doc.rows
    .filter((candidate) => !displaced.has(candidate.id))
    .map((candidate) => {
      const plan = byRow.get(candidate.id);
      if (!plan) return candidate;
      // Sized to the rail when the devices fit, as "Vorhandene Reihe hier einhängen" does.
      const slots = rowUsedSlots(candidate) <= plan.ple ? plan.ple : candidate.slots;
      return plan.label === candidate.label && slots === candidate.slots ? candidate : { ...candidate, label: plan.label, slots };
    });
  const next = withModules({ ...doc, rows }, (modules) =>
    modules.map((module) => {
      const added = plans.filter((plan) => plan.module.id === module.id).map((plan) => [plan.railKey, plan.row.id] as const);
      const addedKeys = new Set(added.map(([key]) => key));
      const own = Object.entries(module.rails ?? {});
      const kept = own.filter(([key, rowId]) => !unlinked.has(rowId) && !addedKeys.has(key));
      if (added.length === 0 && kept.length === own.length) return module;
      return { ...module, rails: Object.fromEntries([...kept, ...added]) };
    }),
  );
  return finish(doc, next, index);
}

// ── Devices (move circuits) ──────────────────────────────────────────────────

function resolvedRails(doc: PanelDocument, index: CatalogIndex, targets: readonly RailName[]): RailRef[] {
  const refs: RailRef[] = [];
  for (const target of targets) {
    const ref = railRef(doc, index, target.moduleId, target.railKey);
    if (ref && refs.every((other) => other.moduleId !== ref.moduleId || other.key !== ref.key)) refs.push(ref);
  }
  return refs;
}

/**
 * "Move circuits" (§4.2 step 3): the devices, in the order given, filled
 * onto the target rails top → bottom — each onto the current rail until it
 * is full, then the next, never reordered — at the end of each rail. One
 * finish (pins, regroup question).
 */
export function moveGroupToRails(doc: PanelDocument, index: CatalogIndex, deviceIds: readonly string[], targets: readonly RailName[]): OpResult {
  const refs = resolvedRails(doc, index, targets);
  if (refs.length === 0) return refuse(RAIL_NOT_FOUND);
  const devices = [...new Set(deviceIds)].map((id) => findDevice(doc, id)).filter((device): device is PanelDevice => device !== null);
  if (devices.length === 0) return refuse(DEVICE_NOT_FOUND);
  const [assignment] = fillRails(devices, refs);
  let next = doc;
  for (const [at, ref] of refs.entries()) {
    const ids = devices.filter((_, i) => assignment[i] === at).map((device) => device.id);
    if (ids.length === 0) continue;
    const rail = ensureRailRow(next, index, ref.moduleId, ref.key);
    if ("error" in rail) return refuse(rail.error);
    next = moveDevicesInto(rail.document, ids, rail.rowId, "end");
  }
  return finish(doc, next, index);
}

// ── Placeholders ─────────────────────────────────────────────────────────────

/** "Platzhalter entfernen": the given devices that are "Reihenklemme N/PE" placeholders go; anything else stays. */
export function removeTerminalPlaceholders(doc: PanelDocument, _index: CatalogIndex, deviceIds: readonly string[]): PanelDocument {
  const placeholders = deviceIds.filter((id) => PLACEHOLDER_KINDS.has(String(findDevice(doc, id)?.kind ?? "")));
  return placeholders.length === 0 ? doc : removeDevices(doc, placeholders);
}
