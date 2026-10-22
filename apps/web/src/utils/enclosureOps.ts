/**
 * Document ops of the cabinet editor (docs/PANEL_ENCLOSURE.md §10.2) — the
 * module every caller imports.
 *
 * All pure: the document passed in is never mutated, and every op that can
 * move rows ends with normalize → physical order → prune → `preserveFeeds`
 * (`enclosureOpsCore.ts`), returning `pinned` / `regrouped` for the toast and
 * the confirm dialog. The ops on whole modules live in
 * `enclosureOpsModules.ts`, the ones on single rails in `enclosureOpsRails.ts`
 * (one file would pass 800 lines); this file holds the cabinet-level ops and
 * re-exports the rest.
 */

import { enclosureModules, fieldHeightMm, type CatalogIndex } from "./enclosureCatalog";
import { clampText, linkedRows, type RailLink } from "./enclosureLayout";
import {
  finish,
  findModule,
  mapDevices,
  METER_LABEL_MAX,
  METER_NUMBER_MAX,
  MODULE_LABEL_MAX,
  refuse,
  unknownCode,
  withModule,
  type OpResult,
} from "./enclosureOpsCore";
import type { EnclosureMeter } from "../types/panelEnclosure";
import type { PanelDocument } from "../types/schaltplan";

export {
  ensureRailRow,
  MAX_RAILS_PER_MODULE,
  METER_LABEL_MAX,
  METER_NUMBER_MAX,
  MODULE_LABEL_MAX,
  normalizeEnclosure,
  RAIL_NOT_EMPTY,
  SAME_SIZE_ONLY,
  TOO_MANY_RAILS,
  TOO_MANY_ROWS,
  type OpResult,
} from "./enclosureOpsCore";
export {
  moveModule,
  placeModule,
  previewClaims,
  refreshModuleSnapshot,
  removeModule,
  setFittingRemoved,
  swapModules,
} from "./enclosureOpsModules";
export { addDeviceToRail, assignRowToRail, fillRailFromTemplate, moveDeviceToRail } from "./enclosureOpsRails";

export const HEIGHT_CHANGE_REFUSED = "Höhe wechseln geht nur ohne Module — die Feldeinbausätze sind höhengebunden.";
export const fewerFieldsRefused = (fields: number, field: number) =>
  `Der neue Schrank hat nur ${fields} Felder — erst die Module aus Feld ${field} entfernen.`;

/**
 * Choose or change the cabinet. A change keeps every module, so it is
 * refused when a module would fall off the right edge, and when the field
 * height changes at all: field kits are height-bound.
 */
export function setEnclosure(doc: PanelDocument, index: CatalogIndex, code: string): OpResult {
  const spec = index.enclosure(code);
  if (!spec) return refuse(unknownCode(code.trim().toUpperCase()));
  if (!doc.enclosure) return finish(doc, { ...doc, enclosure: { code: spec.code, modules: [] } }, index);
  const modules = enclosureModules(doc);
  const current = index.enclosure(doc.enclosure.code);
  if (modules.length > 0 && current && fieldHeightMm(current) !== fieldHeightMm(spec)) return refuse(HEIGHT_CHANGE_REFUSED);
  const outside = modules
    .filter((module) => module.field + (index.module(module.code)?.width_fields ?? 1) > spec.fields)
    .map((module) => module.field);
  if (outside.length > 0) return refuse(fewerFieldsRefused(spec.fields, Math.min(...outside) + 1));
  return finish(doc, { ...doc, enclosure: { ...doc.enclosure, code: spec.code } }, index);
}

/** Take the cabinet off the plan: rows and devices stay where they are, no device is pre-fitted any more. */
export function removeEnclosure(doc: PanelDocument): PanelDocument {
  if (!doc.enclosure) return doc;
  const released = mapDevices(doc, (device) => (device.supplied_by ? { ...device, supplied_by: null } : device));
  return { ...released, enclosure: null };
}

/**
 * Set a meter place's number / label, or (`patch` null) mark it "frei" — a
 * reserve with a blind plate. Both are cut to what the server stores.
 */
export function setMeter(doc: PanelDocument, moduleId: string, place: number, patch: Partial<EnclosureMeter> | null): PanelDocument {
  const module = findModule(doc, moduleId);
  if (!module) return doc;
  const meters = Array.isArray(module.meters) ? module.meters : [];
  const existing = meters.find((meter) => meter.place === place);
  if (patch === null && !existing) return doc;
  const others = meters.filter((meter) => meter.place !== place);
  const merged = { number: "", label: "", ...existing, ...patch, place };
  const fitted = {
    ...merged,
    number: clampText(merged.number ?? "", METER_NUMBER_MAX),
    label: clampText(merged.label ?? "", METER_LABEL_MAX),
  };
  const next = patch === null ? others : [...others, fitted];
  return withModule(doc, moduleId, (current) => ({ ...current, meters: [...next].sort((a, b) => a.place - b.place) }));
}

export function setModuleLabel(doc: PanelDocument, moduleId: string, label: string): PanelDocument {
  const module = findModule(doc, moduleId);
  const fitted = clampText(label, MODULE_LABEL_MAX);
  if (!module || module.label === fitted) return doc;
  return withModule(doc, moduleId, (current) => ({ ...current, label: fitted }));
}

/** "Reihen ordnen": rows into the cabinet's reading order, feeds kept. */
export function orderRowsPhysically(doc: PanelDocument, index: CatalogIndex): OpResult {
  return finish(doc, doc, index);
}

/** The rail a row hangs on, or null when it is "Nicht im Schrank". */
export function railOfRow(doc: PanelDocument, index: CatalogIndex, rowId: string): RailLink | null {
  return linkedRows(doc, index).get(rowId) ?? null;
}
