/**
 * Ops on the §14a Steuersignal-Klemmleiste and the cabinet preparation's
 * per-board overrides (docs/PANEL_ENCLOSURE_R4.md §8.3, §2.1, §2.2).
 *
 * All pure: the document passed in is never touched. Every block op reads
 * the stored block through `parseControlBlock` — a tablet several versions
 * behind or a hand edit may have stored anything there — changes the parsed
 * copy and stores it back whole, in the parser's key order. None of them
 * moves a row, so none runs the cabinet ops' tail (`finish`): no circuit
 * can change its feed here. An op that changes nothing hands the input back
 * (`unchanged`), so the editor's `mutate` saves nothing.
 *
 * The block is seeded by `placeModule` (R4-2, `seedControlBlock`) when a
 * meter field arrives on a board without one; a removed block stays
 * removed (`off`) with its labels, so "wieder anlegen" brings them back.
 */

import {
  MAX_CONTROL_TERMINALS,
  TUBE_MATERIAL_IDS,
  WIRE_COLOURS,
  WIRE_MM2_CHOICES,
  defaultControlBlock,
  normaliseControlLabel,
  parseControlBlock,
  parseLengthM,
} from "./enclosureControlBlock";
import { DEFAULT_PREP, PREP_CHOICES, prepOverrides } from "./enclosurePrep";
import { refuse, unchanged, type OpResult } from "./enclosureOpsCore";
import type { ControlBlock, ControlTerminal, PanelEnclosure, PrepOverrides, TubeMaterialId, WireColour, WireMm2 } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";

// ── Refusals (a stale sheet or a hand-built call can trigger each) ───────────

export const CONTROL_NO_CABINET = "Noch kein Schrank geplant.";
export const CONTROL_BLOCK_ABSENT = "Keine §14a-Klemmleiste geplant.";
export const CONTROL_TERMINALS_FULL = `Höchstens ${MAX_CONTROL_TERMINALS} Klemmen.`;
export const CONTROL_TERMINAL_LAST = "Mindestens eine Klemme bleibt — sonst die ganze §14a-Klemmleiste entfernen.";
export const CONTROL_TERMINAL_GONE = "Diese Klemme ist nicht mehr in der §14a-Klemmleiste.";
export const CONTROL_COLOUR_INVALID = "Diese Aderfarbe gibt es nicht — Schutzleiter- und Neutralleiterfarben sind ausgeschlossen.";
export const CONTROL_WIRE_INVALID = "Leitung nur 1,5 oder 2,5 mm².";
export const CONTROL_LENGTH_INVALID = "Länge 0,5 bis 20 m — leer lassen für die Länge aus der Zeichnung.";
export const CONTROL_TUBE_INVALID = "Nur Schrumpfschlauch WAGO 211-501 oder 211-502.";
export const CONTROL_RAIL_INVALID = "Diese Hutschiene gibt es nicht.";
export const PREP_CHOICE_INVALID = "Diese Auswahl gibt es nicht.";

const METER_FAMILIES: ReadonlySet<string> = new Set(["meter_ehz", "meter_3p"]);
const KEY_PATTERN = /^[a-z0-9_-]{1,40}$/;

// ── Storing ──────────────────────────────────────────────────────────────────

function applied(document: PanelDocument): OpResult {
  return { ok: true, document, pinned: [], regrouped: [] };
}

/** `enclosure` with `key` set to `value`, or without `key` when `value` is undefined. */
function withEnclosureKey<K extends "control_block" | "prep">(enclosure: PanelEnclosure, key: K, value: PanelEnclosure[K] | undefined): PanelEnclosure {
  if (value !== undefined) return { ...enclosure, [key]: value };
  const rest: Partial<PanelEnclosure> = { ...enclosure };
  delete rest[key];
  return rest as PanelEnclosure;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function storeBlock(doc: PanelDocument, enclosure: PanelEnclosure, block: ControlBlock): OpResult {
  if (same(enclosure.control_block, block)) return unchanged(doc);
  return applied({ ...doc, enclosure: withEnclosureKey(enclosure, "control_block", block) });
}

/** Change the parsed block; a string from `change` is the refusal. */
function editBlock(doc: PanelDocument, change: (block: ControlBlock) => ControlBlock | string): OpResult {
  const enclosure = doc.enclosure;
  if (!enclosure) return refuse(CONTROL_NO_CABINET);
  const block = parseControlBlock(enclosure.control_block);
  if (!block) return refuse(CONTROL_BLOCK_ABSENT);
  const next = change(block);
  return typeof next === "string" ? refuse(next) : storeBlock(doc, enclosure, next);
}

function editTerminal(doc: PanelDocument, id: string, change: (terminal: ControlTerminal) => ControlTerminal): OpResult {
  return editBlock(doc, (block) => {
    if (!block.terminals.some((terminal) => terminal.id === id)) return CONTROL_TERMINAL_GONE;
    return { ...block, terminals: block.terminals.map((terminal) => (terminal.id === id ? change(terminal) : terminal)) };
  });
}

// ── The block ────────────────────────────────────────────────────────────────

/** `placeModule`'s seed (R4-2): the default block with a meter field, when the board has none — never over a present or removed one. */
export function seedControlBlock(doc: PanelDocument, family: string): PanelDocument {
  const enclosure = doc.enclosure;
  if (!enclosure || !METER_FAMILIES.has(family) || parseControlBlock(enclosure.control_block) !== null) return doc;
  return { ...doc, enclosure: withEnclosureKey(enclosure, "control_block", defaultControlBlock()) };
}

/** "§14a-Klemmleiste anlegen": the default block; a removed one comes back as it was; a present one stays. */
export function addControlBlock(doc: PanelDocument): OpResult {
  const enclosure = doc.enclosure;
  if (!enclosure) return refuse(CONTROL_NO_CABINET);
  const block = parseControlBlock(enclosure.control_block);
  if (block && !block.off) return unchanged(doc);
  return storeBlock(doc, enclosure, block ? { ...block, off: false } : defaultControlBlock());
}

/** "wieder anlegen": the same move as `addControlBlock`. */
export function restoreControlBlock(doc: PanelDocument): OpResult {
  return addControlBlock(doc);
}

/** "§14a-Klemmleiste entfernen": `off`, labels kept; nothing to do without a block. */
export function removeControlBlock(doc: PanelDocument): OpResult {
  if (doc.enclosure && parseControlBlock(doc.enclosure.control_block) === null) return unchanged(doc);
  return editBlock(doc, (block) => ({ ...block, off: true }));
}

/** "Standard wiederherstellen": the six default terminals; wire, tube, length and rail stay. */
export function resetControlBlock(doc: PanelDocument): OpResult {
  return editBlock(doc, (block) => ({ ...block, terminals: defaultControlBlock().terminals }));
}

// ── Terminals ────────────────────────────────────────────────────────────────

function freeTerminalId(terminals: readonly ControlTerminal[]): string {
  const taken = new Set(terminals.map((terminal) => terminal.id));
  let n = 1;
  while (taken.has(`t${n}`)) n += 1;
  return `t${n}`;
}

/** "+ Klemme": at the right end, the smallest free `t<n>`, the default colour of its position, no label yet. */
export function addControlTerminal(doc: PanelDocument): OpResult {
  return editBlock(doc, (block) => {
    if (block.terminals.length >= MAX_CONTROL_TERMINALS) return CONTROL_TERMINALS_FULL;
    const position = block.terminals.length;
    const added: ControlTerminal = { id: freeTerminalId(block.terminals), label: "", color: WIRE_COLOURS[position % WIRE_COLOURS.length] };
    return { ...block, terminals: [...block.terminals, added] };
  });
}

export function removeControlTerminal(doc: PanelDocument, id: string): OpResult {
  return editBlock(doc, (block) => {
    if (!block.terminals.some((terminal) => terminal.id === id)) return CONTROL_TERMINAL_GONE;
    if (block.terminals.length <= 1) return CONTROL_TERMINAL_LAST;
    return { ...block, terminals: block.terminals.filter((terminal) => terminal.id !== id) };
  });
}

/** An edit as typed: control characters out, outer spaces off, cut to 12 code points (the parser's step 4). */
export function renameControlTerminal(doc: PanelDocument, id: string, label: string): OpResult {
  const fitted = normaliseControlLabel(label);
  return editTerminal(doc, id, (terminal) => ({ ...terminal, label: fitted }));
}

export function setControlTerminalColour(doc: PanelDocument, id: string, colour: WireColour): OpResult {
  if (!(WIRE_COLOURS as readonly string[]).includes(colour)) return refuse(CONTROL_COLOUR_INVALID);
  return editTerminal(doc, id, (terminal) => ({ ...terminal, color: colour }));
}

// ── Rail, wire, tube ─────────────────────────────────────────────────────────

/** An AAR rail of the carrier by key, or null for automatic (§3.2 picks a candidate; a stale key falls back there too). */
export function setControlBlockRail(doc: PanelDocument, rail: string | null): OpResult {
  if (rail !== null && !KEY_PATTERN.test(rail)) return refuse(CONTROL_RAIL_INVALID);
  return editBlock(doc, (block) => ({ ...block, rail }));
}

export function setControlWire(doc: PanelDocument, mm2: WireMm2): OpResult {
  if (!WIRE_MM2_CHOICES.includes(mm2)) return refuse(CONTROL_WIRE_INVALID);
  return editBlock(doc, (block) => ({ ...block, wire_mm2: mm2 }));
}

/** Metres per wire by rule 8 (0,5 … 20, one decimal, half up); null = measured on the drawing. */
export function setControlWireLength(doc: PanelDocument, metres: number | null): OpResult {
  const stored = metres === null ? null : parseLengthM(metres);
  if (metres !== null && stored === null) return refuse(CONTROL_LENGTH_INVALID);
  return editBlock(doc, (block) => ({ ...block, wire_length_m: stored }));
}

export function setControlLabelMaterial(doc: PanelDocument, id: TubeMaterialId): OpResult {
  if (!TUBE_MATERIAL_IDS.has(id)) return refuse(CONTROL_TUBE_INVALID);
  return editBlock(doc, (block) => ({ ...block, label_material: id }));
}

// ── Prep overrides (§2.2) ────────────────────────────────────────────────────

export type PrepOverrideKey = keyof PrepOverrides;
type ChoiceKey = keyof typeof PREP_CHOICES;

function overrideValue(key: PrepOverrideKey, value: unknown): PrepOverrides[PrepOverrideKey] | undefined {
  if (key === "network_m") {
    if (value === null) return null;
    return parseLengthM(value) ?? undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(PREP_CHOICES, key)) return undefined;
  const choices: readonly string[] = PREP_CHOICES[key as ChoiceKey];
  return typeof value === "string" && choices.includes(value) ? (value as PrepOverrides[ChoiceKey]) : undefined;
}

/**
 * One group back to `auto`, switched `off`, or a variant; `network_m` a
 * length or null. Stores the whole parsed object; once every group is
 * automatic again (and no length is set) the key goes.
 */
export function setPrepOverride(doc: PanelDocument, key: PrepOverrideKey, value: string | number | null): OpResult {
  const enclosure = doc.enclosure;
  if (!enclosure) return refuse(CONTROL_NO_CABINET);
  const parsed = overrideValue(key, value);
  if (parsed === undefined) return refuse(key === "network_m" ? CONTROL_LENGTH_INVALID : PREP_CHOICE_INVALID);
  const current = prepOverrides(doc);
  const next: PrepOverrides = { ...current, [key]: parsed };
  const stored = same(next, DEFAULT_PREP) ? undefined : next;
  if (same(enclosure.prep ?? undefined, stored)) return unchanged(doc);
  return applied({ ...doc, enclosure: withEnclosureKey(enclosure, "prep", stored) });
}
