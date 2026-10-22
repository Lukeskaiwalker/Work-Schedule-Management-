/**
 * A small cabinet catalogue for the TS core tests (docs/PANEL_ENCLOSURE.md
 * §3.2 shapes), so the op and rule tests do not depend on the Python-written
 * parity fixture. The zone stacks follow the built-in data module; the
 * parity tests (`enclosure*Parity.test.ts`) use the server's own catalogue.
 * Invented boards only — the repo is public.
 */
import { expect } from "vitest";

import { catalogIndex } from "../utils/enclosureCatalog";
import { feedMap } from "../utils/enclosureFeeds";
import type { OpResult } from "../utils/enclosureOps";
import { makeDevice } from "../utils/schaltplanDevices";
import type {
  CatalogEntry,
  EnclosureCatalog,
  EnclosureSpec,
  FittingSpec,
  ModuleSpec,
  RailSpec,
  ZoneSpec,
} from "../types/panelEnclosure";
import type { DeviceKind, PanelDevice, PanelDocument, PanelRow } from "../types/schaltplan";

function entry<S extends EnclosureSpec | ModuleSpec>(type: "enclosure" | "module", spec: S): CatalogEntry<S> {
  return {
    code: spec.code,
    entry_type: type,
    source: "builtin",
    archived: false,
    invalid: false,
    spec,
    article: null,
    article_source: null,
    stock_available: 0,
    recent_count: 0,
    last_used_at: null,
    used_by_plans: 0,
  };
}

function cabinet(code: string, height: 1100 | 1400, fields: number, leaves: number): EnclosureSpec {
  return {
    code,
    article_no: code,
    manufacturer: "Hager",
    series: "univers Z",
    name: `Zählerschrank ${code}`,
    accessories: [],
    verified: true,
    unverified: [],
    source_url: null,
    note: "",
    height_mm: height,
    width_mm: 50 + fields * 250,
    depth_mm: 205,
    fields,
    door_leaves: leaves,
    field_width_mm: 250,
    unit_mm: 150,
    margin_mm: 25,
    units_per_field: height === 1100 ? 7 : 9,
    mounting: "surface",
    ip: "IP44",
    door: "Klappgriff mit Vorreiber",
  };
}

const rail = (key: string, unit = 0, extra: Partial<RailSpec> = {}): RailSpec => ({ key, unit, ple: 12, mount: "rail", retired: false, ...extra });
const numbered = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => rail(`${prefix}${i + 1}`, i));

function zone(key: string, type: ZoneSpec["type"], unit: number, units: number, rails: RailSpec[] = [], extra: Partial<ZoneSpec> = {}): ZoneSpec {
  return { key, type, label: "", field: 0, unit, units, rails, meter_places: 0, meter_type: null, sealable: false, ...extra };
}

const part = (key: string, label: string): FittingSpec => ({
  key, label, article_no: null, removable: false, device: null, verified: true, note: "", retired: false,
});

function devicePart(key: string, label: string, kind: DeviceKind, railKey: string, te: number): FittingSpec {
  return {
    key, label, article_no: null, removable: true,
    device: { kind, rail: railKey, te, poles: 3, rating: "", width_mm: null },
    verified: false, note: "angenommen", retired: false,
  };
}

function moduleSpec(code: string, family: ModuleSpec["family"], fieldHeight: number | null, zones: ZoneSpec[], extra: Partial<ModuleSpec> = {}): ModuleSpec {
  return {
    code, article_no: code, manufacturer: "Hager", series: "univers Z", name: `Modul ${code}`, accessories: [],
    verified: true, unverified: [], source_url: null, note: "",
    family, field_height_mm: fieldHeight, width_fields: 1,
    height_units: fieldHeight === 1050 ? 7 : fieldHeight === 1350 ? 9 : zones.reduce((sum, z) => sum + z.units, 0),
    wiring_mm2: null, zones, fittings: [], free_place_cover: null, ...extra,
  };
}

const aar = (unit: number) => zone("aar", "AAR", unit, 2, numbered("aar", 2));
const rfz = (unit: number) => zone("rfz", "RFZ", unit, 1, [rail("rfz")], { sealable: true });
const nar = (unit: number) => zone("nar", "NAR", unit, 2, [rail("nar", 0, { mount: "busbar" })], { sealable: true });
const zf = (unit: number, units: number, places: number, type: "ehz" | "3punkt") =>
  zone("zf", "ZF", unit, units, [], { meter_places: places, meter_type: type, sealable: true });
const apz = (unit: number) => zone("apz", "APZ", unit, 2, [rail("apz", 0, { ple: 6 })], { sealable: true });
const sas = (unit: number) => zone("sas", "SAS", unit, 2, [rail("sas", 0, { mount: "busbar" })], { sealable: true });
const busbar = part("busbar", "Sammelschiene 5-polig 12×5 mm (NAR)");
const bke = part("bke", "BKE-I Zählerplatz");
const cover = { article_no: "KU40XXE", label: "Blindabdeckung freier eHZ-Zählerplatz", qty: 1, verified: false };

export const MODULES: Record<string, ModuleSpec> = {
  ZH3EH16: moduleSpec("ZH3EH16", "meter_ehz", 1050, [aar(0), rfz(2), zf(3, 2, 1, "ehz"), nar(5)], {
    fittings: [busbar, bke, devicePart("hs", "Hauptschalter", "hauptschalter", "aar1", 3), devicePart("hlak", "Hauptleitungsabzweigklemme", "hlak", "aar2", 4)],
    free_place_cover: cover, verified: false, unverified: ["Feldaufbau angenommen"],
  }),
  ZH3EL22: moduleSpec("ZH3EL22", "meter_ehz", 1050, [aar(0), rfz(2), zf(3, 2, 2, "ehz"), nar(5)], { fittings: [busbar, bke], free_place_cover: cover }),
  ZH3EL27: moduleSpec("ZH3EL27", "meter_ehz", 1050, [aar(0), rfz(2), zf(3, 2, 1, "ehz"), nar(5)], { fittings: [busbar, bke], wiring_mm2: 10, free_place_cover: cover }),
  ZH33X7: moduleSpec("ZH33X7", "meter_3p", 1050, [aar(0), zf(2, 3, 1, "3punkt"), nar(5)], { fittings: [busbar] }),
  ZU37KS: moduleSpec("ZU37KS", "distribution", 1050, [zone("vt", "VT", 0, 7, numbered("r", 7))], { fittings: [part("pe_n", "PE/N-Klemmen waagerecht")] }),
  ZU37RK: moduleSpec("ZU37RK", "distribution", 1050, [zone("vt", "VT", 0, 7, numbered("r", 7))]),
  ZU37VT5APZ2: moduleSpec("ZU37VT5APZ2", "distribution_apz", 1050, [zone("vt", "VT", 0, 5, numbered("r", 5)), apz(5)], {
    fittings: [{ ...part("rj45", "RJ45-Buchse"), removable: true }],
  }),
  ZH3ES5: moduleSpec("ZH3ES5", "busbar", 1050, [sas(0), zone("vt", "VT", 2, 5, numbered("r", 5))], { fittings: [busbar] }),
  ZH5EL27: moduleSpec("ZH5EL27", "meter_ehz", 1350, [zone("vf", "VF", 0, 2, numbered("vf", 2)), aar(2), rfz(4), zf(5, 2, 1, "ehz"), nar(7)], {
    fittings: [busbar, bke],
  }),
  ZU62A: moduleSpec("ZU62A", "cover", null, [zone("cover", "COVER", 0, 1)]),
  ZY150RFZ: moduleSpec("ZY150RFZ", "communication", null, [rfz(0)]),
};

export const CABINETS: Record<string, EnclosureSpec> = {
  ZB32S: cabinet("ZB32S", 1100, 2, 1),
  ZB33S: cabinet("ZB33S", 1100, 3, 2),
  ZB35S: cabinet("ZB35S", 1100, 5, 2),
  ZB52S: cabinet("ZB52S", 1400, 2, 1),
};

export function testCatalog(overrides: { modules?: Record<string, ModuleSpec> } = {}): EnclosureCatalog {
  const modules = { ...MODULES, ...(overrides.modules ?? {}) };
  return {
    enclosures: Object.values(CABINETS).map((spec) => entry("enclosure", spec)),
    modules: Object.values(modules).map((spec) => entry("module", spec)),
    can_manage: false,
    uncatalogued: [],
  };
}

export const INDEX = catalogIndex(testCatalog());

/** Freeze a value and everything inside it: an op that mutates its input throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

export function dev(kind: DeviceKind, overrides: Partial<PanelDevice> = {}): PanelDevice {
  return makeDevice(kind, overrides);
}

export function row(id: string, devices: PanelDevice[], label = id, slots = 12): PanelRow {
  return { id, label, slots, devices };
}

export function board(rows: PanelRow[], enclosure: PanelDocument["enclosure"] = null, meterNumber = ""): PanelDocument {
  return {
    version: 1,
    supply: { system: "TN-S", voltage: "400/230 V", incoming: "", fuse: "", meter_number: meterNumber, note: "" },
    rows,
    terminal_labels: {},
    enclosure,
  };
}

export function allDeviceIds(doc: PanelDocument): string[] {
  return doc.rows.flatMap((candidate) => candidate.devices.map((device) => device.id));
}

/** Feeds kept for every circuit present before and after, except the ones the op reported (§2.4). */
export function expectFeedsKept(before: PanelDocument, result: OpResult): void {
  if (!result.ok) throw new Error(`op refused: ${result.error}`);
  const old = feedMap(before);
  const now = feedMap(result.document);
  const reported = new Set(result.regrouped.map((entry) => entry.deviceId));
  for (const [id, head] of old) {
    if (!now.has(id) || reported.has(id)) continue;
    expect(now.get(id), `feed of ${id}`).toBe(head);
  }
}
