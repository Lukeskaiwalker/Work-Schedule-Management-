/**
 * Cabinet ops on single DIN rails (docs/PANEL_ENCLOSURE.md §10.2): hang an
 * existing row onto a rail, add a device, fill a rail from a template, move
 * a device to another rail. Import them from `enclosureOps.ts`.
 *
 * A rail gets its row the first time it holds something (`ensureRailRow`),
 * so none of these needs the rail to have a row already.
 */

import { newBreaker, rowUsedSlots } from "./schaltplanDevices";
import { rowFromTemplate } from "./schaltplanDocumentOps";
import { findDevice } from "./schaltplanTopologyCore";
import { METER_FAMILIES, moduleArticle, type CatalogIndex } from "./enclosureCatalog";
import { linkedRows, railRowId, resolvableRails } from "./enclosureLayout";
import {
  DEVICE_NOT_FOUND,
  ensureRailRow,
  findModule,
  finish,
  insertDevice,
  mapDevices,
  MODULE_NOT_FOUND,
  moveDeviceInto,
  RAIL_NOT_EMPTY,
  railRetired,
  railUnknown,
  refuse,
  ROW_NOT_FOUND,
  sameSupplier,
  unchanged,
  withModules,
  withRow,
  type OpResult,
} from "./enclosureOpsCore";
import type { DeviceKind, PanelDevice, PanelDocument } from "../types/schaltplan";

/** The row a module's rail holds right now, or null. */
function railRow(doc: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string) {
  const module = findModule(doc, moduleId);
  const rowId = module ? railRowId(linkedRows(doc, index), module, railKey) : null;
  return rowId ? doc.rows.find((row) => row.id === rowId) ?? null : null;
}

/**
 * "Vorhandene Reihe hier einhängen": an existing row moves onto the rail. A
 * row linked elsewhere is unhooked there; an empty row the rail already had
 * makes room; a rail holding devices refuses.
 */
export function assignRowToRail(doc: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string, rowId: string): OpResult {
  const module = findModule(doc, moduleId);
  if (!module) return refuse(MODULE_NOT_FOUND);
  const ref = resolvableRails(module, index).get(railKey);
  if (!ref) return refuse(railUnknown(railKey, moduleArticle(module, index)));
  if (ref.rail.retired) return refuse(railRetired(railKey, moduleArticle(module, index)));
  const row = doc.rows.find((candidate) => candidate.id === rowId);
  if (!row) return refuse(ROW_NOT_FOUND);
  const current = railRow(doc, index, moduleId, railKey);
  if (current?.id === rowId) return unchanged(doc, moduleId);
  if (current && current.devices.length > 0) return refuse(RAIL_NOT_EMPTY);
  const rows = doc.rows.filter((candidate) => candidate.id !== current?.id);
  const relinked = withModules({ ...doc, rows }, (modules) =>
    modules.map((candidate) => {
      const rails = Object.fromEntries(Object.entries(candidate.rails ?? {}).filter(([, linked]) => linked !== rowId));
      return candidate.id === moduleId ? { ...candidate, rails: { ...rails, [railKey]: rowId } } : { ...candidate, rails };
    }),
  );
  const sized = rowUsedSlots(row) <= ref.rail.ple ? withRow(relinked, rowId, (target) => ({ ...target, slots: ref.rail.ple })) : relinked;
  return finish(doc, sized, index, { moduleId });
}


/** The module's Hauptschalter without a feed — on its rails or pre-fitted by it — now name `slsId` (SLS → HS). */
function feedMainSwitches(doc: PanelDocument, index: CatalogIndex, moduleId: string, slsId: string): PanelDocument {
  const own = new Set([...linkedRows(doc, index)].filter(([, link]) => link.moduleId === moduleId).map(([rowId]) => rowId));
  const onRails = new Set(doc.rows.filter((row) => own.has(row.id)).flatMap((row) => row.devices.map((d) => d.id)));
  const unfed = (device: PanelDevice) =>
    device.kind === "hauptschalter" && !device.parent_id && (onRails.has(device.id) || sameSupplier(device.supplied_by, moduleId));
  return mapDevices(doc, (device) => (unfed(device) ? { ...device, parent_id: slsId } : device));
}

/**
 * "+ Gerät" on a rail. An SLS on a meter module's NAR also becomes the feed
 * of that module's Hauptschalter that names none (SLS → HS, owner 2026-10-09).
 */
export function addDeviceToRail(doc: PanelDocument, index: CatalogIndex, moduleId: string, railKey: string, kind: DeviceKind): OpResult {
  const rail = ensureRailRow(doc, index, moduleId, railKey);
  if ("error" in rail) return refuse(rail.error);
  // Breakers get the next free Stromkreis-Nr. and their phase straight away, as in the rail editor.
  const device = newBreaker(rail.document, rail.document.rows.find((candidate) => candidate.id === rail.rowId), kind);
  const next = insertDevice(rail.document, rail.rowId, device);
  const module = findModule(next, moduleId)!;
  const onMeterNar =
    resolvableRails(module, index).get(railKey)?.zone.type === "NAR" && METER_FAMILIES.has(index.module(module.code)?.family ?? "");
  const fed = kind === "sls" && onMeterNar ? feedMainSwitches(next, index, moduleId, device.id) : next;
  return finish(doc, fed, index, { created: [device.id], moduleId, deviceId: device.id });
}

/**
 * "Aus Vorlage füllen": an empty rail gets a template's devices, numbered as
 * if added by hand (`rowFromTemplate`), sized to the rail. The rail's row
 * keeps its id and label.
 */
export function fillRailFromTemplate(
  doc: PanelDocument,
  index: CatalogIndex,
  moduleId: string,
  railKey: string,
  templateId: string,
): OpResult {
  const module = findModule(doc, moduleId);
  if (!module) return refuse(MODULE_NOT_FOUND);
  const ref = resolvableRails(module, index).get(railKey);
  if (!ref) return refuse(railUnknown(railKey, moduleArticle(module, index)));
  if ((railRow(doc, index, moduleId, railKey)?.devices.length ?? 0) > 0) return refuse(RAIL_NOT_EMPTY);
  const rail = ensureRailRow(doc, index, moduleId, railKey);
  if ("error" in rail) return refuse(rail.error);
  const template = rowFromTemplate(rail.document, templateId, { slots: ref.rail.ple });
  const next = withRow(rail.document, rail.rowId, (row) => ({ ...row, slots: template.slots, devices: template.devices }));
  return finish(doc, next, index, { created: template.devices.map((device) => device.id), moduleId });
}

/**
 * "Auf andere Hutschiene…": the device goes to the end of the target rail.
 * It keeps `supplied_by` — a pre-fitted part moved inside the cabinet is
 * still the module's part — and its feed is kept like everyone else's.
 */
export function moveDeviceToRail(doc: PanelDocument, index: CatalogIndex, deviceId: string, moduleId: string, railKey: string): OpResult {
  if (!findDevice(doc, deviceId)) return refuse(DEVICE_NOT_FOUND);
  const rail = ensureRailRow(doc, index, moduleId, railKey);
  if ("error" in rail) return refuse(rail.error);
  return finish(doc, moveDeviceInto(rail.document, deviceId, rail.rowId), index, { moduleId, deviceId });
}
