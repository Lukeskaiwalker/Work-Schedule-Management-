/**
 * What the Schrank tab's sheets read off a board — pure, shared by
 * ModuleSheet, RailSheet and RailPickerSheet so the three never disagree on
 * what a rail is called or how full it is (docs/PANEL_ENCLOSURE.md §2.3, §4).
 *
 * Fullness is measured as the drawing measures it (`railUsedMm`, shared with
 * the drag's drop label): an SLS on a busbar is 4.5 PLE, not its 3 TE, so
 * "frei" here matches the overflow flag in the drawing and the
 * `encl.rail_overflow` finding.
 */
import { railUsedMm } from "./enclosureDropTargets";
import { enclosureModules, type CatalogIndex } from "../../../utils/enclosureCatalog";
import {
  catalogFittings,
  generatedRowLabel,
  linkedRows,
  railRowId,
  resolvableRails,
  zoneLabel,
} from "../../../utils/enclosureLayout";
import { MODULE_WIDTH_MM } from "../../../utils/schaltplanStrip";
import type { EnclosureModule, RailSpec, ZoneSpec } from "../../../types/panelEnclosure";
import type { PanelDocument, PanelRow } from "../../../types/schaltplan";

export interface RailInfo {
  moduleId: string;
  railKey: string;
  zone: ZoneSpec;
  rail: RailSpec;
  /** "F2 · Verteiler 1": the label a new row on this rail gets. */
  title: string;
  /** "Verteiler 1", "NAR": the zone and, when it has several, the rail's number in it. */
  zoneName: string;
  /** 1-based field the rail sits in. */
  field: number;
  row: PanelRow | null;
  usedPle: number;
  freePle: number;
}

const tenth = (value: number) => Math.round(value * 10) / 10;

/** "7,5" / "12": PLE as the fitter reads them. */
export function formatPle(value: number): string {
  return String(tenth(value)).replace(".", ",");
}

export function railZoneName(zone: ZoneSpec, rail: RailSpec): string {
  const number = zone.rails.length > 1 ? ` ${zone.rails.findIndex((entry) => entry.key === rail.key) + 1}` : "";
  return `${zoneLabel(zone)}${number}`;
}

function info(
  document: PanelDocument,
  module: EnclosureModule,
  railKey: string,
  ref: { zone: ZoneSpec; rail: RailSpec },
  rowId: string | null,
): RailInfo {
  const row = rowId ? document.rows.find((candidate) => candidate.id === rowId) ?? null : null;
  const usedMm = railUsedMm(ref.rail, row?.devices ?? []);
  const usedPle = tenth(usedMm / MODULE_WIDTH_MM);
  return {
    moduleId: module.id,
    railKey,
    zone: ref.zone,
    rail: ref.rail,
    title: generatedRowLabel(module, ref.zone, ref.rail),
    zoneName: railZoneName(ref.zone, ref.rail),
    field: module.field + ref.zone.field + 1,
    row,
    usedPle,
    freePle: Math.max(0, tenth(ref.rail.ple - usedPle)),
  };
}

/**
 * A module's rails top → bottom. Retired rails only while their row still
 * holds devices (as drawn), unless `retired: "never"` (pickers: nothing new
 * may go onto a retired rail).
 */
export function moduleRails(
  document: PanelDocument,
  index: CatalogIndex,
  module: EnclosureModule,
  options: { retired?: "with-devices" | "never" } = {},
): RailInfo[] {
  const links = linkedRows(document, index);
  const rails: RailInfo[] = [];
  for (const [railKey, ref] of resolvableRails(module, index)) {
    const entry = info(document, module, railKey, ref, railRowId(links, module, railKey));
    if (ref.rail.retired && (options.retired === "never" || (entry.row?.devices.length ?? 0) === 0)) continue;
    rails.push(entry);
  }
  const position = (rail: RailInfo) => [rail.zone.field, rail.zone.unit + rail.rail.unit];
  return rails.sort((a, b) => position(a)[1] - position(b)[1] || position(a)[0] - position(b)[0]);
}

/** One rail of one module, or null when the module or the key no longer resolves. */
export function railInfo(document: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string): RailInfo | null {
  const module = enclosureModules(document).find((candidate) => candidate.id === moduleId);
  if (!module) return null;
  const ref = resolvableRails(module, index).get(railKey);
  if (!ref) return null;
  return info(document, module, railKey, ref, railRowId(linkedRows(document, index), module, railKey));
}

/** Every module ordered as the cabinet reads, left → right, top → bottom. */
export function modulesInOrder(document: PanelDocument): EnclosureModule[] {
  return [...enclosureModules(document)].sort((a, b) => a.field - b.field || a.unit - b.unit || (a.id < b.id ? -1 : 1));
}

/**
 * The module's snapshot no longer matches the catalogue (§3.5 rule 4): what
 * "Katalog geändert — Vorbestückung neu übernehmen" offers to refresh. A
 * module without a snapshot already reads the catalogue, so it is never stale.
 */
export function snapshotStale(module: EnclosureModule, index: CatalogIndex): boolean {
  if (!Array.isArray(module.fittings) || !index.module(module.code)) return false;
  const shape = (fittings: typeof module.fittings) =>
    JSON.stringify(
      (fittings ?? []).map((fitting) => [fitting.key, fitting.label, fitting.article_no ?? null, fitting.device_kind ?? null, fitting.removable]),
    );
  return shape(module.fittings) !== shape(catalogFittings(module.code, index));
}
