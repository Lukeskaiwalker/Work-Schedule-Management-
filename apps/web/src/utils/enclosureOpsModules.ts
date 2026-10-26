/**
 * Cabinet ops on whole field modules (docs/PANEL_ENCLOSURE.md §10.2):
 * place, move, swap, remove, the fitting toggle and the snapshot refresh.
 * Import them from `enclosureOps.ts`.
 *
 * Placement is where a legacy board meets its cabinet, so it is careful
 * about what already exists (R1-4): with `claim` a pre-fitted part takes
 * over a matching device that is not in the cabinet yet instead of putting a
 * second Hauptschalter next to it, and `meter` devices become the cabinet's
 * meter places instead of staying on a rail as devices.
 */

import { makeDevice, newId, rowUsedSlots } from "./schaltplanDevices";
import { removeDevices } from "./schaltplanDocumentOps";
import { enclosureModules, fitsAt, meterPlaceCount, type CatalogIndex } from "./enclosureCatalog";
import {
  catalogFittings,
  clampText,
  generatedRowLabel,
  linkedRows,
  moduleFittings,
  railRowId,
  resolvableRails,
  suppliedDevices,
} from "./enclosureLayout";
import {
  ensureRailRow,
  findModule,
  finish,
  insertDevice,
  mapDevices,
  METER_LABEL_MAX,
  METER_NUMBER_MAX,
  MODULE_NOT_FOUND,
  moveDeviceInto,
  refuse,
  SAME_SIZE_ONLY,
  sameSupplier,
  unchanged,
  unknownCode,
  withModule,
  withModules,
  withRow,
  type OpResult,
} from "./enclosureOpsCore";
import { seedControlBlock } from "./enclosureOpsControlBlock";
import { terminalRailKey, terminalRailKeys } from "./enclosureTerminals";
import type { EnclosureMeter, EnclosureModule, FittingSpec, ModuleSpec } from "../types/panelEnclosure";
import type { PanelDevice, PanelDocument } from "../types/schaltplan";

// ── Claims ───────────────────────────────────────────────────────────────────

interface ClaimPlan {
  /** fitting key → the existing device that becomes it. */
  fittings: Map<string, string>;
  meters: PanelDevice[];
}

type DeviceFitting = FittingSpec & { device: NonNullable<FittingSpec["device"]> };

/** The parts a placement fits as devices: non-retired fittings with a device. */
const deviceFittings = (spec: ModuleSpec): DeviceFitting[] =>
  spec.fittings.filter((fitting): fitting is DeviceFitting => !fitting.retired && !!fitting.device);

/** Devices not yet in the cabinet, in row order, that no module claims. */
function claimable(doc: PanelDocument, index: CatalogIndex): PanelDevice[] {
  const links = linkedRows(doc, index);
  return doc.rows.filter((row) => !links.has(row.id)).flatMap((row) => row.devices.filter((device) => !device.supplied_by));
}

function claimPlan(doc: PanelDocument, index: CatalogIndex, spec: ModuleSpec): ClaimPlan {
  const pool = claimable(doc, index);
  const taken = new Set<string>();
  const fittings = new Map<string, string>();
  for (const fitting of deviceFittings(spec)) {
    const match = pool.find((device) => device.kind === fitting.device.kind && !taken.has(device.id));
    if (!match) continue;
    taken.add(match.id);
    fittings.set(fitting.key, match.id);
  }
  const meters = pool.filter((device) => device.kind === "meter" && !taken.has(device.id)).slice(0, meterPlaceCount(spec));
  return { fittings, meters };
}

/** What `placeModule` with `claim` would take over — the picker's "Übernimmt: …". */
export function previewClaims(doc: PanelDocument, index: CatalogIndex, code: string): { deviceIds: string[]; meterDeviceIds: string[] } {
  const spec = index.module(code);
  if (!spec) return { deviceIds: [], meterDeviceIds: [] };
  const plan = claimPlan(doc, index, spec);
  return { deviceIds: [...plan.fittings.values()], meterDeviceIds: plan.meters.map((device) => device.id) };
}

// ── Place ────────────────────────────────────────────────────────────────────

type Step = { ok: true; document: PanelDocument; created: string[] } | { ok: false; error: string };

/** Every device fitting onto its rail: the claimed device moved there, else a new one. */
function fitDevices(doc: PanelDocument, index: CatalogIndex, module: EnclosureModule, spec: ModuleSpec, plan: ClaimPlan): Step {
  let next = doc;
  const created: string[] = [];
  for (const fitting of deviceFittings(spec)) {
    const rail = ensureRailRow(next, index, module.id, fitting.device.rail);
    if ("error" in rail) return { ok: false, error: rail.error };
    const supplied_by = { module: module.id, part: fitting.key };
    const claimed = plan.fittings.get(fitting.key);
    if (claimed) {
      next = moveDeviceInto(rail.document, claimed, rail.rowId, { supplied_by });
      continue;
    }
    const device = makeDevice(fitting.device.kind, {
      te: fitting.device.te,
      poles: fitting.device.poles,
      rating: fitting.device.rating,
      width_mm: fitting.device.width_mm,
      supplied_by,
    });
    created.push(device.id);
    next = insertDevice(rail.document, rail.rowId, device);
  }
  return { ok: true, document: next, created };
}

/**
 * One entry per meter place (D7): claimed `meter` devices first, the rest
 * empty. The board's old free-text meter number seeds place 0 once — when no
 * meter in the cabinet carries a number yet.
 */
function meterEntries(doc: PanelDocument, spec: ModuleSpec, claimed: PanelDevice[]): EnclosureMeter[] {
  // Cut to the meter place's limits (40 / 64): the sources may be longer
  // (supply.meter_number 96, a device label 160), and a place the server
  // refuses would fail every save from the placement on.
  const entries = Array.from({ length: meterPlaceCount(spec) }, (_, place): EnclosureMeter => {
    const device = claimed[place];
    const label = device ? device.label.trim() || device.designation.trim() : "";
    return { place, number: "", label: clampText(label, METER_LABEL_MAX) };
  });
  const seed = (doc.supply?.meter_number ?? "").trim();
  const numbered = enclosureModules(doc).some((module) => (module.meters ?? []).some((meter) => meter.number.trim()));
  if (entries.length === 0 || !seed || numbered) return entries;
  return [{ ...entries[0], number: clampText(seed, METER_NUMBER_MAX) }, ...entries.slice(1)];
}

/**
 * Empty VT/VF rails top → bottom take the rows that are not in the cabinet,
 * in their order — never the field's terminal rails, which are reserved for
 * the WAGO terminals (docs/PANEL_ENCLOSURE_R2.md R2, §3.6).
 */
function adoptRows(doc: PanelDocument, index: CatalogIndex, moduleId: string): PanelDocument {
  const module = findModule(doc, moduleId);
  if (!module) return doc;
  const links = linkedRows(doc, index);
  const reserved = terminalRailKeys(doc, index);
  const rails = [...resolvableRails(module, index).entries()]
    .filter(([key, ref]) => (ref.zone.type === "VT" || ref.zone.type === "VF") && !ref.rail.retired && !railRowId(links, module, key))
    .filter(([key]) => !reserved.has(terminalRailKey(moduleId, key)))
    .sort(([, a], [, b]) => a.zone.unit + a.rail.unit - (b.zone.unit + b.rail.unit) || a.zone.field - b.zone.field);
  const rows = doc.rows.filter((row) => !links.has(row.id) && row.devices.length > 0);
  let next = doc;
  rails.slice(0, rows.length).forEach(([key, ref], i) => {
    const row = rows[i];
    next = withModule(next, moduleId, (current) => ({ ...current, rails: { ...(current.rails ?? {}), [key]: row.id } }));
    // Sized to the rail when the devices fit; otherwise kept, and the overflow finding says so.
    if (rowUsedSlots(row) <= ref.rail.ple) next = withRow(next, row.id, (current) => ({ ...current, slots: ref.rail.ple }));
  });
  return next;
}

/**
 * Place a module with its top-left at (`field`, `unit`). Snapshots the
 * non-retired fittings; rows are created only for rails that receive a
 * fitting device (D15). `claim` (default on) takes over matching devices and
 * meters outside the cabinet; `adoptRows` hangs the remaining outside rows
 * onto empty VT/VF rails, skipping the field's terminal rails (R2 §3.6).
 * A meter field on a board without a §14a block seeds the default block
 * (docs/PANEL_ENCLOSURE_R4.md R4-2); a present or removed one is kept.
 */
export function placeModule(
  doc: PanelDocument,
  index: CatalogIndex,
  args: { code: string; field: number; unit: number; adoptRows?: boolean; claim?: boolean },
): OpResult {
  const spec = index.module(args.code);
  if (!spec) return refuse(unknownCode(args.code.trim().toUpperCase()));
  const reason = fitsAt(doc, index, args.code, args.field, args.unit);
  if (reason) return refuse(reason);
  const plan: ClaimPlan = args.claim === false ? { fittings: new Map(), meters: [] } : claimPlan(doc, index, spec);
  const module: EnclosureModule = {
    id: newId("mod"),
    code: spec.code,
    field: args.field,
    unit: args.unit,
    label: "",
    rails: {},
    fittings: catalogFittings(spec.code, index),
    removed_fittings: [],
    meters: meterEntries(doc, spec, plan.meters),
  };
  const placed = seedControlBlock(withModules(doc, (modules) => [...modules, module]), spec.family);
  const fitted = fitDevices(placed, index, module, spec, plan);
  if (!fitted.ok) return refuse(fitted.error);
  let next = removeDevices(fitted.document, plan.meters.map((device) => device.id));
  if (args.adoptRows) next = adoptRows(next, index, module.id);
  return finish(doc, next, index, { created: fitted.created, moduleId: module.id });
}

// ── Move, swap ───────────────────────────────────────────────────────────────

/** Rows still carrying the label generated for `from` get the one for `to`; hand-named rows keep theirs. */
function relabel(doc: PanelDocument, index: CatalogIndex, from: EnclosureModule, to: Pick<EnclosureModule, "field">): PanelDocument {
  const links = linkedRows(doc, index);
  let next = doc;
  for (const [key, ref] of resolvableRails(from, index)) {
    const rowId = railRowId(links, from, key);
    if (!rowId) continue;
    const old = generatedRowLabel(from, ref.zone, ref.rail);
    const fresh = generatedRowLabel(to, ref.zone, ref.rail);
    next = withRow(next, rowId, (row) => (row.label === old && old !== fresh ? { ...row, label: fresh } : row));
  }
  return next;
}

function reposition(doc: PanelDocument, index: CatalogIndex, module: EnclosureModule, to: { field: number; unit: number }): PanelDocument {
  return withModule(relabel(doc, index, module, to), module.id, (current) => ({ ...current, field: to.field, unit: to.unit }));
}

export function moveModule(doc: PanelDocument, index: CatalogIndex, moduleId: string, to: { field: number; unit: number }): OpResult {
  const module = findModule(doc, moduleId);
  if (!module) return refuse(MODULE_NOT_FOUND);
  const reason = fitsAt(doc, index, module.code, to.field, to.unit, moduleId);
  if (reason) return refuse(reason);
  return finish(doc, reposition(doc, index, module, to), index, { moduleId });
}

/** Two modules of the same size trade places — exactly the cells each one left. */
export function swapModules(doc: PanelDocument, index: CatalogIndex, a: string, b: string): OpResult {
  const first = findModule(doc, a);
  const second = findModule(doc, b);
  if (!first || !second) return refuse(MODULE_NOT_FOUND);
  const one = index.module(first.code);
  const two = index.module(second.code);
  if (!one || !two || one.width_fields !== two.width_fields || one.height_units !== two.height_units) return refuse(SAME_SIZE_ONLY);
  const swapped = reposition(reposition(doc, index, first, second), index, second, first);
  return finish(doc, swapped, index, { moduleId: a });
}

// ── Remove ───────────────────────────────────────────────────────────────────

/**
 * Take a module out: its pre-fitted devices go with it, its rows that are
 * then empty go too, and rows with the fitter's own devices stay in the plan
 * as "Nicht im Schrank". Other devices naming the module lose the claim.
 */
export function removeModule(doc: PanelDocument, index: CatalogIndex, moduleId: string): OpResult {
  if (!findModule(doc, moduleId)) return refuse(MODULE_NOT_FOUND);
  const links = linkedRows(doc, index);
  const ownRows = new Set([...links].filter(([, link]) => link.moduleId === moduleId).map(([rowId]) => rowId));
  const supplied = [...suppliedDevices(doc, index)].filter(([, by]) => by.module === moduleId).map(([id]) => id);
  const cleared = removeDevices(doc, supplied);
  const rows = cleared.rows.filter((row) => !(ownRows.has(row.id) && row.devices.length === 0));
  const unclaimed = mapDevices({ ...cleared, rows }, (device) =>
    sameSupplier(device.supplied_by, moduleId) ? { ...device, supplied_by: null } : device,
  );
  return finish(doc, withModules(unclaimed, (modules) => modules.filter((module) => module.id !== moduleId)), index);
}

// ── Fittings ─────────────────────────────────────────────────────────────────

const fittingUnknown = (key: string) => `Vorbestücktes Teil „${key}“ gibt es in diesem Modul nicht.`;

/**
 * Take a pre-fitted part out (`removed` true) or put it back. A device part
 * is "removed" exactly when no device claims it, so removing deletes the
 * claimant and restoring re-creates it at the front of its rail — and
 * restoring twice still gives one. Other parts are listed in `removed_fittings`.
 */
export function setFittingRemoved(
  doc: PanelDocument,
  index: CatalogIndex,
  moduleId: string,
  fittingKey: string,
  removed: boolean,
): OpResult {
  const module = findModule(doc, moduleId);
  if (!module) return refuse(MODULE_NOT_FOUND);
  const fitting = moduleFittings(module, index).find((candidate) => candidate.key === fittingKey);
  if (!fitting) return refuse(fittingUnknown(fittingKey));
  // "fest verbaut": the derivations ignore it in removed_fittings anyway.
  if (!fitting.removable) return unchanged(doc, moduleId);
  if (!fitting.device_kind) return toggleListed(doc, index, module, fittingKey, removed);
  const claimant = [...suppliedDevices(doc, index)].find(([, by]) => sameSupplier(by, moduleId, fittingKey))?.[0];
  if (removed) return claimant ? finish(doc, removeDevices(doc, [claimant]), index, { moduleId }) : unchanged(doc, moduleId);
  if (claimant) return unchanged(doc, moduleId);
  return restoreDevice(doc, index, module, fittingKey);
}

function toggleListed(doc: PanelDocument, index: CatalogIndex, module: EnclosureModule, key: string, removed: boolean): OpResult {
  const listed = (module.removed_fittings ?? []).includes(key);
  if (listed === removed) return unchanged(doc, module.id);
  const next = withModule(doc, module.id, (current) => {
    const listedNow = current.removed_fittings ?? [];
    return { ...current, removed_fittings: removed ? [...listedNow, key] : listedNow.filter((entry) => entry !== key) };
  });
  return finish(doc, next, index, { moduleId: module.id });
}

function restoreDevice(doc: PanelDocument, index: CatalogIndex, module: EnclosureModule, key: string): OpResult {
  const spec = index.module(module.code)?.fittings.find((fitting) => fitting.key === key)?.device;
  if (!spec) return refuse(unknownCode(module.code));
  const rail = ensureRailRow(doc, index, module.id, spec.rail);
  if ("error" in rail) return refuse(rail.error);
  const device = makeDevice(spec.kind, {
    te: spec.te,
    poles: spec.poles,
    rating: spec.rating,
    width_mm: spec.width_mm,
    supplied_by: { module: module.id, part: key },
  });
  const next = insertDevice(rail.document, rail.rowId, device, "start");
  return finish(doc, next, index, { created: [device.id], moduleId: module.id, deviceId: device.id });
}

/**
 * "Katalogstand übernehmen" (draft boards only, enforced by the UI): the
 * module's snapshot becomes the current catalogue. Devices claiming a part
 * the catalogue no longer lists as a device become ordinary devices.
 */
export function refreshModuleSnapshot(doc: PanelDocument, index: CatalogIndex, moduleId: string): OpResult {
  const module = findModule(doc, moduleId);
  if (!module) return refuse(MODULE_NOT_FOUND);
  if (!index.module(module.code)) return refuse(unknownCode(module.code));
  const fittings = catalogFittings(module.code, index);
  const deviceKeys = new Set(fittings.filter((fitting) => fitting.device_kind).map((fitting) => fitting.key));
  const released = mapDevices(doc, (device) =>
    sameSupplier(device.supplied_by, moduleId) && !deviceKeys.has(device.supplied_by!.part) ? { ...device, supplied_by: null } : device,
  );
  return finish(doc, withModule(released, moduleId, (current) => ({ ...current, fittings })), index, { moduleId });
}
