/**
 * What the editor around the Schrank tab reads off a cabinet board — pure,
 * so the page, the Aufbau tab, the Daten tab and the new-board dialog say
 * the same thing about the same board (docs/PANEL_ENCLOSURE.md §2.3, §11;
 * the Aufbau groups: docs/PANEL_ENCLOSURE_R2.md §9).
 *
 * Every helper takes a board that may come from an older tablet or a hand
 * edit: missing modules, unknown codes and odd meter places are read as
 * "nothing there", never thrown on.
 */
import { cabinetLine } from "./EnclosurePickerSheet";
import { modulesInOrder, moduleRails, railInfo } from "./sheetModel";
import { moduleArticle, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { linkedRows, physicalRowOrder, suppliedDevices, zoneLabel, type RailLink } from "../../../utils/enclosureLayout";
import { PLACEHOLDER_KINDS, placeTerminals, terminalRailKey, terminalRailKeys, terminalSkip } from "../../../utils/enclosureTerminals";
import { RULE_RAIL_DEVICES } from "../../../utils/enclosureTerminalSuggest";
import { setTerminalsEverywhere } from "../../../utils/schaltplanDocumentOps";
import type { EnclosureCatalog, EnclosureModule, TerminalPlacement } from "../../../types/panelEnclosure";
import type { PanelDocument, PanelFinding, PanelRow } from "../../../types/schaltplan";

// ── Pre-fitted parts (DeviceInspector banner) ────────────────────────────────

/** What the inspector says about a pre-fitted part: its module's article, and what the catalogue has not checked. */
export interface SuppliedInfo {
  article: string;
  unverifiedNote: string | null;
}

/**
 * The banner of a device that IS a module's pre-fitted part (first claimant,
 * §2.3), else null. The "ungeprüft" note comes from the live catalogue —
 * the snapshot carries no verification state — and falls back to the
 * module's first unchecked fact.
 */
export function suppliedInfo(document: PanelDocument, index: CatalogIndex, deviceId: string | null): SuppliedInfo | null {
  if (!deviceId || !document.enclosure) return null;
  const by = suppliedDevices(document, index).get(deviceId);
  if (!by) return null;
  const module = modulesInOrder(document).find((candidate) => candidate.id === by.module);
  if (!module) return null;
  const spec = index.module(module.code);
  const fitting = spec?.fittings.find((candidate) => candidate.key === by.part) ?? null;
  const unchecked = fitting ? !fitting.verified : false;
  const note = fitting?.note.trim() || spec?.unverified[0]?.trim() || "Katalogdaten nicht vollständig geprüft";
  return { article: moduleArticle(module, index), unverifiedNote: unchecked ? note : null };
}

// ── Meters (Daten tab) ───────────────────────────────────────────────────────

/** "1EBZ… (WE 1), ohne Nummer" in cabinet order, "keine" without a meter. */
export function meterSummary(document: PanelDocument): string {
  const parts = modulesInOrder(document).flatMap((module) =>
    [...(Array.isArray(module.meters) ? module.meters : [])]
      .sort((a, b) => a.place - b.place)
      .map((meter) => {
        const number = (meter.number ?? "").trim() || "ohne Nummer";
        const label = (meter.label ?? "").trim();
        return label ? `${number} (${label})` : number;
      }),
  );
  return parts.length > 0 ? parts.join(", ") : "keine";
}

// ── Aufbau tab groups ────────────────────────────────────────────────────────

/**
 * One line of a module group (docs/PANEL_ENCLOSURE_R2.md §9): a rail's row,
 * or a rail without one yet. `reserved` marks one of the field's two
 * terminal rails (R2, `terminalRailKeys`): no "+ Gerät" there. `xLabels`:
 * the strips the placement puts on that rail, left → right (empty elsewhere).
 */
export type RailEditorEntry =
  | { kind: "row"; row: PanelRow; reserved: boolean; xLabels: readonly string[] }
  | {
      kind: "empty";
      moduleId: string;
      railKey: string;
      /** "F3 · Verteiler 1": the label the row gets once the rail holds something. */
      title: string;
      ple: number;
      reserved: boolean;
      xLabels: readonly string[];
    };

export interface RailEditorGroup {
  key: string;
  /** "Feld 1 · ZH3EH16 Allgemein" or "Nicht im Schrank". */
  title: string;
  /** Rows on cabinet rails: their width is the rail's, and the module owns them. */
  linked: boolean;
  entries: RailEditorEntry[];
  /** Why a module has no entry at all (a cover, an unknown code); null otherwise. */
  note: string | null;
}

export const OUTSIDE_TITLE = "Nicht im Schrank";
export const NO_RAIL_NOTE = "Keine Hutschiene";
export const UNKNOWN_CODE_NOTE = "Modulcode unbekannt — Reihen unter „Nicht im Schrank“";

const NO_LABELS: readonly string[] = Object.freeze([]);

/** Which rails hold the WAGO terminals, and the X labels placed on each ("moduleId:railKey"). */
interface RailTerminals {
  reserved: ReadonlySet<string>;
  xLabels: ReadonlyMap<string, readonly string[]>;
}

function railTerminals(document: PanelDocument, index: CatalogIndex): RailTerminals {
  // Memoised by document identity: the page's useBoardTerminals already placed this board.
  const placement: TerminalPlacement = placeTerminals(document, index);
  const xLabels = new Map(
    placement.fields.flatMap((field) =>
      field.rails.map((rail) => [terminalRailKey(rail.moduleId, rail.railKey), rail.strips.map((strip) => strip.xLabel)] as const),
    ),
  );
  return { reserved: terminalRailKeys(document, index), xLabels };
}

/**
 * A module's rails top → bottom, each as its row or as an empty rail. A
 * retired rail is listed only while it holds devices (`moduleRails`), so a
 * linked row it drops — empty, kept for its custom label — is appended.
 */
function moduleEntries(
  document: PanelDocument,
  index: CatalogIndex,
  module: EnclosureModule,
  links: Map<string, RailLink>,
  terminals: RailTerminals,
): RailEditorEntry[] {
  const at = (railKey: string) => {
    const key = terminalRailKey(module.id, railKey);
    return { reserved: terminals.reserved.has(key), xLabels: terminals.xLabels.get(key) ?? NO_LABELS };
  };
  const entries: RailEditorEntry[] = moduleRails(document, index, module).map((rail) =>
    rail.row
      ? { kind: "row", row: rail.row, ...at(rail.railKey) }
      : { kind: "empty", moduleId: module.id, railKey: rail.railKey, title: rail.title, ple: rail.rail.ple, ...at(rail.railKey) },
  );
  const listed = new Set(entries.flatMap((entry) => (entry.kind === "row" ? [entry.row.id] : [])));
  const unlisted = document.rows.filter((row) => links.get(row.id)?.moduleId === module.id && !listed.has(row.id));
  const appended = unlisted.map((row): RailEditorEntry => ({ kind: "row", row, ...at(links.get(row.id)?.railKey ?? "") }));
  return [...entries, ...appended];
}

/**
 * Every module in field order, each with all its rails (§9), then the rows
 * that hang on no rail of the cabinet. A module without any entry says why.
 * Null without a cabinet: the Aufbau tab then stays the flat list it
 * always was.
 */
export function railEditorGroups(document: PanelDocument, index: CatalogIndex): RailEditorGroup[] | null {
  if (!document.enclosure) return null;
  const links = linkedRows(document, index);
  const terminals = railTerminals(document, index);
  const groups = modulesInOrder(document).map((module): RailEditorGroup => {
    const spec = index.module(module.code);
    const name = module.label?.trim() || spec?.name || "";
    const title = `Feld ${module.field + 1} · ${moduleArticle(module, index)}${name ? ` ${name}` : ""}`;
    const entries = moduleEntries(document, index, module, links, terminals);
    const note = entries.length > 0 ? null : spec ? NO_RAIL_NOTE : UNKNOWN_CODE_NOTE;
    return { key: module.id, title, linked: true, entries, note };
  });
  const outside = document.rows.filter((candidate) => !links.has(candidate.id));
  if (outside.length === 0) return groups;
  const entries = outside.map((row): RailEditorEntry => ({ kind: "row", row, reserved: false, xLabels: NO_LABELS }));
  return [...groups, { key: "outside", title: OUTSIDE_TITLE, linked: false, entries, note: null }];
}

// ── WAGO terminals on a cabinet board (docs/PANEL_ENCLOSURE_R2.md §3.1, §9) ──

export const RESERVED_RAIL_TEXT = "für Reihenklemmen reserviert";
/** A reserved rail's row with devices, when no `encl.terminal_rail_devices` finding names it. */
export const RESERVED_ROW_BANNER = "Diese Hutschiene ist für Reihenklemmen reserviert — Geräte tiefer setzen.";
export const RESERVED_ROW_RULE = RULE_RAIL_DEVICES;
/** X labels named before "und {k} weitere" (the findings' `{Xlist}`, §4.1). */
const X_LIST_MAX = 4;

/** "für Reihenklemmen reserviert · X7, X8, X10" — or "· noch keine" while nothing is placed there. */
export function reservedRailLine(xLabels: readonly string[]): string {
  if (xLabels.length === 0) return `${RESERVED_RAIL_TEXT} · noch keine`;
  const shown = xLabels.slice(0, X_LIST_MAX).join(", ");
  const rest = xLabels.length - X_LIST_MAX;
  return `${RESERVED_RAIL_TEXT} · ${rest > 0 ? `${shown} und ${rest} weitere` : shown}`;
}

/**
 * A row on a terminal rail whose devices must move down (R12): anything but
 * the hand-placed "Reihenklemme N/PE" placeholders, which the strips replace.
 */
export function rowHoldsDevices(row: PanelRow): boolean {
  return row.devices.some((device) => !PLACEHOLDER_KINDS.has(device.kind));
}

/** The banner of a reserved rail's row: the finding's own sentence (with its suggestion) when there is one. */
export function reservedRowNote(findings: readonly PanelFinding[], rowId: string): string {
  return findings.find((finding) => finding.rule === RESERVED_ROW_RULE && finding.scope === rowId)?.message ?? RESERVED_ROW_BANNER;
}

/**
 * The zone label ("AAR", "NAR", "RfZ", "APZ") of a device the cabinet gives
 * no terminal (`skip`, R3), for the inspector's note; null for every other
 * device, and before the catalogue is there.
 */
export function terminalBlockedZone(
  document: PanelDocument,
  index: CatalogIndex | null,
  skip: ReadonlySet<string>,
  deviceId: string | null,
): string | null {
  if (!index || !deviceId || !skip.has(deviceId) || !document.enclosure) return null;
  const row = document.rows.find((candidate) => candidate.devices.some((device) => device.id === deviceId));
  const link = row ? linkedRows(document, index).get(row.id) : undefined;
  const rail = link ? railInfo(document, index, link.moduleId, link.railKey) : null;
  return rail ? zoneLabel(rail.zone) || null : null;
}

/**
 * The Klemmen tab's "Alle …" with the cabinet's skip set: a circuit in a
 * no-WAGO zone keeps its flag both ways. A cabinet board waits for the
 * catalogue (the tab offers no switch until then), so it stays as it is.
 */
export function setAllTerminalsOnBoard(document: PanelDocument, index: CatalogIndex | null, flag: boolean): PanelDocument {
  if (!document.enclosure) return setTerminalsEverywhere(document, flag);
  return index ? setTerminalsEverywhere(document, flag, terminalSkip(document, index)) : document;
}

// ── Row order, findings ──────────────────────────────────────────────────────

/** The rows already stand in the cabinet's reading order (§2.3): "Reihen ordnen" has nothing to do. */
export function rowsInPhysicalOrder(document: PanelDocument, index: CatalogIndex): boolean {
  const order = physicalRowOrder(document, index);
  return order.length === document.rows.length && order.every((id, position) => document.rows[position]?.id === id);
}

export function warnCount(findings: readonly PanelFinding[]): number {
  return findings.filter((finding) => finding.level === "warn").length;
}

/** "Schrank: 3 Hinweise" — the Prüfen banner's one chip for the cabinet. */
export function enclosureChipText(count: number): string {
  return `Schrank: ${count} ${count === 1 ? "Hinweis" : "Hinweise"}`;
}

// ── New board dialog ─────────────────────────────────────────────────────────

export interface CabinetChoiceGroup {
  height: number;
  options: { code: string; label: string }[];
}

/** Pickable cabinets by height (archived and invalid ones left out), in the server's order inside a height. */
export function cabinetChoices(catalog: EnclosureCatalog | null, index: CatalogIndex | null): CabinetChoiceGroup[] {
  if (!catalog || !index) return [];
  const groups = new Map<number, CabinetChoiceGroup>();
  for (const entry of catalog.enclosures ?? []) {
    const spec = entry.archived ? null : index.enclosure(entry.code);
    if (!spec) continue;
    const group = groups.get(spec.height_mm) ?? { height: spec.height_mm, options: [] };
    groups.set(spec.height_mm, { ...group, options: [...group.options, { code: spec.code, label: cabinetLine(spec) }] });
  }
  return [...groups.values()].sort((a, b) => a.height - b.height);
}
