/**
 * The catalogue admin's live preview (docs/PANEL_ENCLOSURE.md §4, §9 Slice
 * F). Pure — no React.
 *
 * The entry being typed is drawn by the same `buildEnclosureScene` every
 * board uses, so what the admin sees is what a fitter will see: a stack
 * that does not add up, a rail outside its zone, a pre-fitted Hauptschalter
 * on the wrong rail. A module sits alone in a dummy cabinet exactly its
 * size (one field — or two or three for a Komplettfeld — and its height in
 * 150 mm units), with every meter place occupied and every pre-fitted
 * device on its rail, as a fresh placement would leave it. A cabinet is
 * drawn empty, so its fields and raster show.
 *
 * The Aufbau is hand-typed JSON: anything may be missing or of the wrong
 * type. Lists are reduced to their objects before `catalogIndex` fills the
 * defaults, sizes outside the catalogue's own ranges are refused with a
 * reason instead of drawn (a 900-field cabinet would only freeze the
 * tablet), and a builder error becomes a reason too — the preview never
 * takes the form down with it.
 */
import { ENCLOSURE_ZOOM_STEPS, drawingSizePx } from "./enclosureFrontLayout";
import { catalogIndex } from "../../../utils/enclosureCatalog";
import { buildEnclosureScene } from "../../../utils/enclosureGeometry";
import { makeDevice } from "../../../utils/schaltplanDevices";
import type {
  CatalogEntry,
  CatalogEntryType,
  EnclosureCatalog,
  EnclosureMeter,
  EnclosureScene,
  EnclosureSpec,
  ModuleSpec,
} from "../../../types/panelEnclosure";
import type { DeviceKind, PanelDocument, PanelRow } from "../../../types/schaltplan";

export const PREVIEW_MODULE_ID = "vorschau";
const PREVIEW_CABINET = "VORSCHAU-SCHRANK";
const PREVIEW_MODULE = "VORSCHAU-MODUL";
const UNIT_MM = 150;
const FIELD_WIDTH_MM = 250;
const MARGIN_MM = 25;

export type PreviewResult = { ok: true; scene: EnclosureScene; unitMm: number } | { ok: false; reason: string };

type Raw = Record<string, unknown>;

const objects = (value: unknown): Raw[] =>
  Array.isArray(value) ? value.filter((item): item is Raw => !!item && typeof item === "object" && !Array.isArray(item)) : [];
const integer = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
const within = (value: number, low: number, high: number) => value >= low && value <= high;
const refuse = (reason: string): PreviewResult => ({ ok: false, reason: `Vorschau nicht möglich: ${reason}` });

/** Zones with object rails only; fittings with an object device or none. */
function cleanModule(spec: Raw): Raw {
  const zones = objects(spec.zones).map((zone) => ({ ...zone, rails: objects(zone.rails) }));
  const fittings = objects(spec.fittings).map((fitting) => {
    const device = fitting.device && typeof fitting.device === "object" && !Array.isArray(fitting.device) ? fitting.device : null;
    return { ...fitting, device };
  });
  return { ...spec, code: PREVIEW_MODULE, zones, fittings, accessories: objects(spec.accessories) };
}

function moduleProblem(spec: Raw): string | null {
  if (!within(integer(spec.width_fields, 1), 1, 3)) return "Breite 1 bis 3 Felder.";
  if (!within(integer(spec.height_units, 1), 1, 9)) return "Höhe 1 bis 9 Raster.";
  const zones = objects(spec.zones);
  if (zones.length > 12) return "höchstens 12 Zonen.";
  for (const zone of zones) {
    if (!within(integer(zone.units, 1), 1, 9) || !within(integer(zone.unit, 0), 0, 18) || !within(integer(zone.field, 0), 0, 2)) {
      return "eine Zone liegt außerhalb von 3 Feldern × 9 Raster.";
    }
    if (objects(zone.rails).length > 9) return "höchstens 9 Hutschienen je Zone.";
    if (!within(integer(zone.meter_places, 0), 0, 4)) return "höchstens 4 Zählerplätze je Zone.";
  }
  return null;
}

function cabinetProblem(spec: Raw): string | null {
  if (!within(integer(spec.fields, 1), 1, 9)) return "Felder 1 bis 9.";
  if (!within(integer(spec.units_per_field, 7), 1, 19)) return "Raster je Feld 1 bis 19.";
  for (const key of ["height_mm", "width_mm", "depth_mm", "field_width_mm", "unit_mm"]) {
    if (spec[key] !== undefined && !within(integer(spec[key], 1), 1, 10_000)) return "Maße 1 bis 10 000 mm.";
  }
  if (spec.margin_mm !== undefined && !within(integer(spec.margin_mm, 0), 0, 1000)) return "Innenrand 0 bis 1000 mm.";
  return null;
}

function entry(type: CatalogEntryType, spec: Raw): CatalogEntry {
  return {
    code: String(spec.code),
    entry_type: type,
    source: "custom",
    archived: false,
    invalid: false,
    spec: spec as unknown as EnclosureSpec | ModuleSpec,
    article: null,
    article_source: null,
    stock_available: 0,
    recent_count: 0,
    last_used_at: null,
    used_by_plans: 0,
  };
}

function dummyCabinet(fields: number, units: number): Raw {
  return {
    code: PREVIEW_CABINET,
    article_no: "",
    name: "Vorschau",
    fields,
    units_per_field: units,
    unit_mm: UNIT_MM,
    field_width_mm: FIELD_WIDTH_MM,
    margin_mm: MARGIN_MM,
    height_mm: 2 * MARGIN_MM + units * UNIT_MM,
    width_mm: 2 * MARGIN_MM + fields * FIELD_WIDTH_MM,
    depth_mm: 205,
    door_leaves: 1,
    verified: true,
    unverified: [],
  };
}

const supply = (): PanelDocument["supply"] => ({ system: "TN-S", voltage: "400/230 V", incoming: "", fuse: "", meter_number: "", note: "" });

/** Every device fitting on its rail, as placing the module would put it there. */
function fittingRows(spec: ModuleSpec): { rows: PanelRow[]; rails: Record<string, string> } {
  const railKeys = new Set(spec.zones.flatMap((zone) => zone.rails.filter((rail) => !rail.retired).map((rail) => rail.key)));
  const byRail = new Map<string, PanelRow>();
  for (const fitting of spec.fittings) {
    const device = fitting.device;
    if (!device || fitting.retired || !railKeys.has(device.rail)) continue;
    const row = byRail.get(device.rail) ?? { id: `vorschau-row-${device.rail}`, label: "", slots: 24, devices: [] };
    const made = makeDevice(device.kind as DeviceKind, {
      id: `vorschau-${fitting.key}`,
      te: device.te,
      poles: device.poles,
      rating: device.rating,
      width_mm: device.width_mm,
      supplied_by: { module: PREVIEW_MODULE_ID, part: fitting.key },
    });
    byRail.set(device.rail, { ...row, devices: [...row.devices, made] });
  }
  const rows = [...byRail.values()];
  return { rows, rails: Object.fromEntries([...byRail.entries()].map(([rail, row]) => [rail, row.id])) };
}

function meters(spec: ModuleSpec): EnclosureMeter[] {
  const places = spec.zones.filter((zone) => zone.type === "ZF").reduce((total, zone) => total + zone.meter_places, 0);
  return Array.from({ length: places }, (_, place) => ({ place, number: "", label: "" }));
}

function catalogOf(cabinet: Raw, module: Raw | null): EnclosureCatalog {
  return {
    enclosures: [entry("enclosure", cabinet) as CatalogEntry<EnclosureSpec>],
    modules: module ? [entry("module", module) as CatalogEntry<ModuleSpec>] : [],
    can_manage: false,
    uncatalogued: [],
  };
}

function moduleScene(raw: Raw): PreviewResult {
  const problem = moduleProblem(raw);
  if (problem) return refuse(problem);
  const module = cleanModule(raw);
  const fields = integer(raw.width_fields, 1);
  const units = integer(raw.height_units, 1);
  const index = catalogIndex(catalogOf(dummyCabinet(fields, units), module));
  const spec = index.module(PREVIEW_MODULE);
  if (!spec) return refuse("Aufbau unvollständig.");
  const { rows, rails } = fittingRows(spec);
  const document: PanelDocument = {
    version: 1,
    supply: supply(),
    rows,
    terminal_labels: {},
    enclosure: {
      code: PREVIEW_CABINET,
      modules: [{ id: PREVIEW_MODULE_ID, code: PREVIEW_MODULE, field: 0, unit: 0, label: "", rails, fittings: null, removed_fittings: [], meters: meters(spec) }],
    },
  };
  return draw(document, index, UNIT_MM);
}

function cabinetScene(raw: Raw): PreviewResult {
  const problem = cabinetProblem(raw);
  if (problem) return refuse(problem);
  const index = catalogIndex(catalogOf({ ...raw, code: PREVIEW_CABINET, accessories: objects(raw.accessories) }, null));
  const cabinet = index.enclosure(PREVIEW_CABINET);
  if (!cabinet) return refuse("Aufbau unvollständig.");
  const document: PanelDocument = { version: 1, supply: supply(), rows: [], terminal_labels: {}, enclosure: { code: PREVIEW_CABINET, modules: [] } };
  return draw(document, index, cabinet.unit_mm);
}

function draw(document: PanelDocument, index: ReturnType<typeof catalogIndex>, unitMm: number): PreviewResult {
  try {
    const scene = buildEnclosureScene(document, index, "open");
    return scene ? { ok: true, scene, unitMm } : refuse("Aufbau unvollständig.");
  } catch {
    return refuse("Aufbau lässt sich nicht zeichnen.");
  }
}

/** The drawing of a spec as typed (fields and Aufbau merged). */
export function previewScene(entryType: CatalogEntryType, spec: Record<string, unknown>): PreviewResult {
  try {
    return entryType === "module" ? moduleScene(spec) : cabinetScene(spec);
  } catch {
    return refuse("Aufbau lässt sich nicht zeichnen.");
  }
}

/**
 * The largest zoom step at which the whole drawing fits `availablePx`
 * across and `maxHeightPx` down; the smallest when none does. The working
 * view fits the width only and scrolls down the cabinet; a preview should
 * show the module at once, and a module is tall and narrow.
 */
export function previewZoomStep(scene: Pick<EnclosureScene, "width" | "height">, availablePx: number, maxHeightPx: number): number {
  let best = 0;
  ENCLOSURE_ZOOM_STEPS.forEach((zoom, step) => {
    const size = drawingSizePx(scene, zoom);
    if (size.width <= availablePx && size.height <= maxHeightPx) best = step;
  });
  return best;
}
