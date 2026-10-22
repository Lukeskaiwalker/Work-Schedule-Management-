/**
 * What the editor around the Schrank tab reads off a cabinet board — pure,
 * so the page, the Aufbau tab, the Daten tab and the new-board dialog say
 * the same thing about the same board (docs/PANEL_ENCLOSURE.md §2.3, §11).
 *
 * Every helper takes a board that may come from an older tablet or a hand
 * edit: missing modules, unknown codes and odd meter places are read as
 * "nothing there", never thrown on.
 */
import { cabinetLine } from "./EnclosurePickerSheet";
import { modulesInOrder, moduleRails } from "./sheetModel";
import { moduleArticle, type CatalogIndex } from "../../../utils/enclosureCatalog";
import { linkedRows, physicalRowOrder, suppliedDevices } from "../../../utils/enclosureLayout";
import type { EnclosureCatalog } from "../../../types/panelEnclosure";
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

export interface RailEditorGroup {
  key: string;
  /** "Feld 1 · ZH3EH16 Allgemein" or "Nicht im Schrank". */
  title: string;
  /** Rows on cabinet rails: their width is the rail's, and the module owns them. */
  linked: boolean;
  rows: PanelRow[];
}

export const OUTSIDE_TITLE = "Nicht im Schrank";

/**
 * Rows grouped by module (field order, rails top → bottom), then the rows
 * that hang on no rail of the cabinet. Null without a cabinet: the Aufbau
 * tab then stays the flat list it always was.
 */
export function railEditorGroups(document: PanelDocument, index: CatalogIndex): RailEditorGroup[] | null {
  if (!document.enclosure) return null;
  const links = linkedRows(document, index);
  const groups: RailEditorGroup[] = [];
  for (const module of modulesInOrder(document)) {
    const rows = moduleRails(document, index, module)
      .map((rail) => rail.row)
      .filter((candidate): candidate is PanelRow => candidate !== null && links.has(candidate.id));
    if (rows.length === 0) continue;
    const name = module.label?.trim() || index.module(module.code)?.name || "";
    const title = `Feld ${module.field + 1} · ${moduleArticle(module, index)}${name ? ` ${name}` : ""}`;
    groups.push({ key: module.id, title, linked: true, rows });
  }
  const outside = document.rows.filter((candidate) => !links.has(candidate.id));
  if (outside.length > 0) groups.push({ key: "outside", title: OUTSIDE_TITLE, linked: false, rows: outside });
  return groups;
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
