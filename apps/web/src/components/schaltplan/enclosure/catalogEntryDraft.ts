/**
 * The catalogue admin's form model (docs/PANEL_ENCLOSURE.md §3.1, §3.5, §7,
 * §11). Pure — no React, no I/O.
 *
 * A spec is split in two for editing. The facts a Werkstatt admin checks on
 * a data sheet (code, article number, name, family, size, source, checked
 * or not, notes) and the accessories that always go on the Materialliste
 * (owner decision: added by the admin, with a quantity) are plain fields.
 * Everything else — zones, rails, fittings, a cabinet's grid — is the
 * "Aufbau (JSON, für Fortgeschrittene)": structural data that a form of
 * nested lists would make slower to edit, not safer. A key lives in exactly
 * one of the two places; one typed into both is refused rather than
 * silently overruled, because either choice would discard what the admin
 * meant.
 *
 * The server is the judge of a spec (strict Pydantic models, German errors
 * with the JSON path). The checks here only answer what would otherwise
 * cost a round trip, in the server's own words: bad JSON, missing names,
 * "ungeprüft" without saying what, a non-https source, half an accessory,
 * the 32 KB ceiling, and the §3.5 change rules (a dropped key, a frozen
 * size on a code that boards use).
 */
import { FAMILY_LABELS, normalizeCode } from "../../../utils/enclosureCatalog";
import type {
  AccessorySpec,
  CatalogEntry,
  CatalogEntryIn,
  CatalogEntryType,
  EnclosureSpec,
  ModuleFamily,
  ModuleSpec,
  UncataloguedArticle,
} from "../../../types/panelEnclosure";

export type AnySpec = EnclosureSpec | ModuleSpec;

/** The raw-body ceiling of one entry, checked by the server before parsing (§7). */
export const ENTRY_MAX_BYTES = 32 * 1024;
export const ACCESSORIES_MAX = 20;
export const ACCESSORY_QTY_MAX = 99;
export const CODE_MAX = 40;
export const ARTICLE_MAX = 40;
export const NAME_MAX = 160;
export const NOTE_MAX = 500;
export const SOURCE_MAX = 500;
export const ACCESSORY_LABEL_MAX = 160;
const UNVERIFIED_LINES_MAX = 12;
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,39}$/;

export { FAMILY_LABELS };
export const FAMILIES = Object.keys(FAMILY_LABELS) as ModuleFamily[];
/** `field_height_mm` of the two cabinet heights (§3.1); null = fits any. */
export const FIELD_HEIGHTS: readonly number[] = [1050, 1350];
export const MAX_WIDTH_FIELDS = 3;
export const MAX_HEIGHT_UNITS = 9;

export const KEY_KEPT = (key: string) => `Schlüssel „${key}“ bleibt — ausmustern statt löschen oder umbenennen.`;
export const FROZEN_WHILE_USED = (n: number) =>
  `In ${n} Verteilerplänen verwendet — Größe, Familie und Zählerplätze bleiben. Als neuen Eintrag anlegen.`;
const TOO_LARGE = "Eintrag zu groß (max. 32 KB).";

export interface AccessoryDraft {
  article_no: string;
  label: string;
  qty: number;
  verified: boolean;
}

export interface CatalogDraft {
  entryType: CatalogEntryType;
  code: string;
  article_no: string;
  name: string;
  source_url: string;
  verified: boolean;
  /** What is unchecked, one fact per line. */
  unverified: string;
  note: string;
  // Module only (ignored for a cabinet).
  family: ModuleFamily;
  field_height_mm: number | null;
  width_fields: number;
  height_units: number;
  accessories: AccessoryDraft[];
  /** Every other key of the spec, as JSON text. */
  aufbau: string;
}

const COMMON_KEYS = ["code", "article_no", "name", "source_url", "verified", "unverified", "note", "accessories"] as const;
const MODULE_KEYS = ["family", "field_height_mm", "width_fields", "height_units"] as const;

/** The spec keys the form edits as fields; the Aufbau JSON holds the rest. */
export function metadataKeys(entryType: CatalogEntryType): readonly string[] {
  return entryType === "module" ? [...COMMON_KEYS, ...MODULE_KEYS] : COMMON_KEYS;
}

// ── Spec → draft ─────────────────────────────────────────────────────────────

const stringOr = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const intOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isInteger(value) ? value : fallback);

function omit(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

function accessoryDrafts(value: unknown): AccessoryDraft[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      article_no: stringOr(item.article_no),
      label: stringOr(item.label),
      qty: intOr(item.qty, 1),
      verified: item.verified !== false,
    }));
}

/** A stored spec as the form shows it. */
export function draftFromSpec(entryType: CatalogEntryType, spec: AnySpec | Record<string, unknown>): CatalogDraft {
  const raw = spec as Record<string, unknown>;
  const family = FAMILIES.includes(raw.family as ModuleFamily) ? (raw.family as ModuleFamily) : "distribution";
  return {
    entryType,
    code: stringOr(raw.code),
    article_no: stringOr(raw.article_no),
    name: stringOr(raw.name),
    source_url: stringOr(raw.source_url),
    verified: raw.verified !== false,
    unverified: Array.isArray(raw.unverified) ? raw.unverified.filter((line) => typeof line === "string").join("\n") : "",
    note: stringOr(raw.note),
    family,
    field_height_mm: typeof raw.field_height_mm === "number" ? raw.field_height_mm : null,
    width_fields: intOr(raw.width_fields, 1),
    height_units: intOr(raw.height_units, 7),
    accessories: accessoryDrafts(raw.accessories),
    aufbau: JSON.stringify(omit(raw, metadataKeys(entryType)), null, 2),
  };
}

// ── New drafts ───────────────────────────────────────────────────────────────

const BLANK_NOTE = "Aufbau nicht am Gerät geprüft";

/** A seven-rail distribution field: the most common kit, and a valid spec as it stands. */
const BLANK_MODULE: Record<string, unknown> = {
  code: "",
  article_no: "",
  name: "",
  family: "distribution",
  field_height_mm: 1050,
  width_fields: 1,
  height_units: 7,
  manufacturer: "Hager",
  series: "univers Z",
  wiring_mm2: null,
  zones: [
    {
      key: "vt",
      type: "VT",
      label: "",
      field: 0,
      unit: 0,
      units: 7,
      rails: Array.from({ length: 7 }, (_, i) => ({ key: `r${i + 1}`, unit: i, ple: 12, mount: "rail", retired: false })),
      meter_places: 0,
      meter_type: null,
      sealable: false,
    },
  ],
  fittings: [],
  free_place_cover: null,
  accessories: [],
  verified: false,
  unverified: [BLANK_NOTE],
  source_url: null,
  note: "",
};

/** A three-field 1100 mm cabinet's grid (§3.2 arithmetic). */
const BLANK_ENCLOSURE: Record<string, unknown> = {
  code: "",
  article_no: "",
  name: "",
  manufacturer: "Hager",
  series: "univers Z",
  height_mm: 1100,
  width_mm: 800,
  depth_mm: 205,
  fields: 3,
  door_leaves: 2,
  field_width_mm: 250,
  unit_mm: 150,
  margin_mm: 25,
  units_per_field: 7,
  mounting: "surface",
  ip: "IP44",
  door: "Klappgriff mit Vorreiber",
  accessories: [],
  verified: false,
  unverified: [BLANK_NOTE],
  source_url: null,
  note: "",
};

export function blankDraft(entryType: CatalogEntryType): CatalogDraft {
  return draftFromSpec(entryType, entryType === "module" ? BLANK_MODULE : BLANK_ENCLOSURE);
}

/** "Eintrag anlegen" for a Hager kit on the shelf: its code is the Hager article number. */
export function draftFromUncatalogued(item: UncataloguedArticle): CatalogDraft {
  const code = normalizeCode(item.code_guess).slice(0, CODE_MAX);
  return { ...blankDraft("module"), code, article_no: code.slice(0, ARTICLE_MAX), name: stringOr(item.article?.item_name).slice(0, NAME_MAX) };
}

/** Another type: its blank structure, with what identifies the entry kept. */
export function switchEntryType(draft: CatalogDraft, entryType: CatalogEntryType): CatalogDraft {
  if (draft.entryType === entryType) return draft;
  return { ...blankDraft(entryType), code: draft.code, article_no: draft.article_no, name: draft.name };
}

/**
 * "Vorlage: wie …": the template's structure, family, size and accessories.
 * The new entry keeps its own code, article number, source and note, takes
 * the template's name only when none was typed, and is "ungeprüft" until
 * someone checks it — its stack is borrowed, not measured.
 */
export function applyTemplate(draft: CatalogDraft, template: CatalogEntry): CatalogDraft {
  if (!template.spec || template.entry_type !== draft.entryType) return draft;
  const base = draftFromSpec(draft.entryType, template.spec);
  const borrowed = [`Aufbau wie ${template.code} übernommen`, ...base.unverified.split("\n")].filter((line) => line.trim());
  return {
    ...base,
    code: draft.code,
    article_no: draft.article_no,
    name: draft.name.trim() ? draft.name : base.name,
    source_url: draft.source_url,
    note: draft.note,
    verified: false,
    unverified: borrowed.slice(0, UNVERIFIED_LINES_MAX).join("\n"),
  };
}

// ── Draft → spec ─────────────────────────────────────────────────────────────

export type AufbauResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

export function parseAufbau(text: string): AufbauResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "Aufbau (JSON) ist kein gültiges JSON — Klammern, Kommas und Anführungszeichen prüfen." };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Aufbau (JSON) muss ein Objekt sein: { … }." };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

const isBlankAccessory = (item: AccessoryDraft) => !item.article_no.trim() && !item.label.trim();

function accessorySpecs(items: readonly AccessoryDraft[]): AccessorySpec[] {
  return items
    .filter((item) => !isBlankAccessory(item))
    .map((item) => ({ article_no: item.article_no.trim(), label: item.label.trim(), qty: item.qty, verified: item.verified }));
}

function metadata(draft: CatalogDraft): Record<string, unknown> {
  const common = {
    code: normalizeCode(draft.code),
    article_no: draft.article_no.trim(),
    name: draft.name.trim(),
    accessories: accessorySpecs(draft.accessories),
    verified: draft.verified,
    unverified: lines(draft.unverified),
    source_url: draft.source_url.trim() || null,
    note: draft.note.trim(),
  };
  if (draft.entryType !== "module") return common;
  const sizes = { family: draft.family, field_height_mm: draft.field_height_mm, width_fields: draft.width_fields, height_units: draft.height_units };
  return { ...common, ...sizes };
}

export type SpecResult = { ok: true; spec: Record<string, unknown> } | { ok: false; error: string };

/** Aufbau and fields merged — also while the fields are incomplete (the preview draws it). */
export function specFromDraft(draft: CatalogDraft): SpecResult {
  const parsed = parseAufbau(draft.aufbau);
  if (!parsed.ok) return parsed;
  const doubled = metadataKeys(draft.entryType).find((key) => key in parsed.value);
  if (doubled) {
    return { ok: false, error: `„${doubled}“ steht oben im Formular — dort ändern und aus dem Aufbau (JSON) löschen.` };
  }
  return { ok: true, spec: { ...metadata(draft), ...parsed.value } };
}

function fieldProblem(draft: CatalogDraft): string | null {
  const code = normalizeCode(draft.code);
  if (!CODE_PATTERN.test(code)) return "Code: A–Z, 0–9, Punkt, _ oder -, 2 bis 40 Zeichen.";
  if (!draft.article_no.trim()) return "Artikelnummer fehlt.";
  if (!draft.name.trim()) return "Bezeichnung fehlt.";
  if (!draft.verified && lines(draft.unverified).length === 0) {
    return "Bei „ungeprüft“ angeben, was nicht geprüft ist (eine Angabe je Zeile).";
  }
  if (lines(draft.unverified).length > UNVERIFIED_LINES_MAX) return `Höchstens ${UNVERIFIED_LINES_MAX} Angaben unter „ungeprüft“.`;
  const source = draft.source_url.trim();
  if (source && !/^https:\/\/[^\s/]+\S*$/.test(source)) return "Quelle muss ein https-Link sein.";
  return accessoryProblem(draft.accessories);
}

function accessoryProblem(items: readonly AccessoryDraft[]): string | null {
  const kept = items.filter((item) => !isBlankAccessory(item));
  if (kept.length > ACCESSORIES_MAX) return `Höchstens ${ACCESSORIES_MAX} Zubehörteile je Eintrag.`;
  const at = items.findIndex(
    (item) =>
      !isBlankAccessory(item) &&
      (!item.article_no.trim() || !item.label.trim() || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > ACCESSORY_QTY_MAX),
  );
  return at < 0 ? null : `Zubehör ${at + 1}: Artikelnummer und Bezeichnung angeben, Menge 1 bis ${ACCESSORY_QTY_MAX}.`;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export type EntryResult = { ok: true; body: CatalogEntryIn } | { ok: false; error: string };

/**
 * The body to send, or the first reason it would be refused. `original` is
 * the stored spec of an edit (null or absent when creating): the keys and
 * frozen fields it binds (§3.5).
 */
export function entryFromDraft(draft: CatalogDraft, options: { original?: AnySpec | null; usedByPlans?: number } = {}): EntryResult {
  const merged = specFromDraft(draft);
  if (!merged.ok) return merged;
  const problem = fieldProblem(draft);
  if (problem) return { ok: false, error: problem };
  // The spec is what the admin typed; the server's strict models are what make it a spec.
  const body = { entry_type: draft.entryType, spec: merged.spec } as unknown as CatalogEntryIn;
  if (options.original) {
    const refusal = changeRuleError(draft.entryType, options.original, body.spec, options.usedByPlans ?? 0);
    if (refusal) return { ok: false, error: refusal };
  }
  if (utf8Bytes(JSON.stringify(body)) > ENTRY_MAX_BYTES) return { ok: false, error: TOO_LARGE };
  return { ok: true, body };
}

// ── §3.5 change rules (twin of `check_change`) ───────────────────────────────

const records = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object") : [];

function railKeys(spec: Record<string, unknown>): string[] {
  return records(spec.zones).flatMap((zone) => records(zone.rails).map((rail) => String(rail.key)));
}

function fittingKinds(spec: Record<string, unknown>): Map<string, string | null> {
  return new Map(
    records(spec.fittings).map((fitting) => {
      const device = fitting.device && typeof fitting.device === "object" ? (fitting.device as Record<string, unknown>) : null;
      return [String(fitting.key), device ? String(device.kind) : null] as const;
    }),
  );
}

function frozenFields(entryType: CatalogEntryType, spec: Record<string, unknown>): string {
  if (entryType === "enclosure") return JSON.stringify([spec.fields ?? null, spec.units_per_field ?? null]);
  const zones = records(spec.zones)
    .map((zone) => `${String(zone.type)}:${intOr(zone.meter_places, 0)}`)
    .sort();
  return JSON.stringify([spec.family ?? null, spec.width_fields ?? null, spec.height_units ?? null, spec.field_height_mm ?? null, zones]);
}

/**
 * Whether `next` may replace `original`: rail and fitting keys stay (a
 * fitting keeps its device kind), and while boards use the code its size,
 * family and meter places stay too. Null when allowed.
 */
export function changeRuleError(
  entryType: CatalogEntryType,
  original: AnySpec | Record<string, unknown>,
  next: AnySpec | Record<string, unknown>,
  usedByPlans: number,
): string | null {
  const before = original as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const kept = new Set(railKeys(after));
  const droppedRail = railKeys(before).find((key) => !kept.has(key));
  if (droppedRail !== undefined) return KEY_KEPT(droppedRail);
  const nextKinds = fittingKinds(after);
  for (const [key, kind] of fittingKinds(before)) {
    if (!nextKinds.has(key) || nextKinds.get(key) !== kind) return KEY_KEPT(key);
  }
  if (usedByPlans > 0 && frozenFields(entryType, before) !== frozenFields(entryType, after)) return FROZEN_WHILE_USED(usedByPlans);
  return null;
}

/** "In 1 Plan verwendet" / "In 3 Plänen verwendet". */
export function usedByText(count: number): string {
  return count === 1 ? "In 1 Plan verwendet" : `In ${count} Plänen verwendet`;
}
