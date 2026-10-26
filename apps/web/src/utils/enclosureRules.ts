/**
 * Findings for a board in a cabinet (docs/PANEL_ENCLOSURE.md §5) — the
 * TypeScript twin of `apps/api/app/services/panel_enclosure_rules.py`.
 *
 * Placement rules after VDE-AR-N 4100:2026-04 and geometric problems are
 * findings only, never refusals (D6, D10): a board captured half-built must
 * save, so every rule reads a possibly broken document and none of them
 * throws. The editor shows these live; the server appends the same list to
 * the panel detail, and a fixture written by Python pins both twins to the
 * same output. What the twins agree on beyond the §5 table:
 *
 * - the output is sorted by (rule in table order, scope, message), strings
 *   by code point, so neither side depends on the other's iteration order;
 * - millimetres via `round1` with a German comma and no ",0"; meter places
 *   count from 1; "Feld n" is the module's field for module rules and the
 *   zone's field (module field + zone offset) for APZ, meter places, SAS
 *   credit and Reihenklemmen;
 * - a row behind an unresolvable key gets `encl.stale_rail`, not also
 *   `encl.row_unlinked`; `encl.row_order` compares the whole stored order.
 *
 * Round 2 (docs/PANEL_ENCLOSURE_R2.md §4.1) replaced the one `encl.terminals`
 * note with ten WAGO terminal rules (`enclosureTerminalRules.ts`), which read
 * the board's precomputed terminals and placement. Round 4
 * (docs/PANEL_ENCLOSURE_R4.md §4) added the §14a block, busbar, supply-kit
 * and infeed rules (`enclosurePrepRules.ts`) before them.
 *
 * `validateDocument` stays untouched: these are appended, not merged.
 */

import { catalogEntry } from "./schaltplanDevices";
import { buildTopology, findRowOf, isCircuitDevice } from "./schaltplanTopologyCore";
import { enclosureModules, METER_FAMILIES, meterPlaceCount, meterZones, type CatalogIndex } from "./enclosureCatalog";
import {
  enclosureDeviceWidthMm,
  linkedRows,
  moduleFittings,
  physicalRowOrder,
  railLengthMm,
  railRowId,
  resolvableRails,
  type RailLink,
} from "./enclosureLayout";
import { formatMmText } from "./enclosureGeometry";
import { DERIVE, type BlockArg } from "./enclosureControlBlock";
import { isSmallTap, ratingValue } from "./enclosurePrep";
import { PREP_RULE_ORDER, prepFindings } from "./enclosurePrepRules";
import { TERMINAL_RULE_ORDER, terminalFindings, type TerminalPrecomputed } from "./enclosureTerminalRules";
import type { EnclosureModule, EnclosureSpec, ModuleSpec, RailSpec, ZoneSpec, ZoneType } from "../types/panelEnclosure";
import type { DeviceKind, PanelDevice, PanelDocument, PanelFinding, PanelRow } from "../types/schaltplan";

export { formatMmText, ratingValue };

export const RULE_ORDER = [
  "encl.unknown_code", "encl.out_of_bounds", "encl.overlap", "encl.height_mismatch", "encl.field_gap",
  "encl.row_unlinked", "encl.stale_rail", "encl.row_order", "encl.rail_overflow", "encl.supplied_dangling",
  "encl.cross_module_feed", "encl.unverified", "encl.meter_device", "encl.meter_place_invalid",
  ...PREP_RULE_ORDER, ...TERMINAL_RULE_ORDER, "vde.nar_sls", "vde.nar_contents", "vde.sls_rating", "vde.aar_contents", "vde.aar_circuits",
  "vde.3p_main_switch", "vde.rfz_devices", "vde.apz_missing", "vde.apz_position", "vde.meter_place_empty",
] as const;
const RANK = new Map<string, number>(RULE_ORDER.map((rule, rank) => [rule, rank]));
const VDE = "VDE-AR-N 4100: ";

const AAR_MAX_A = 16;
const AAR_PER_PLACE = 3;
const SLS_MAX_A: Readonly<Record<10 | 16, number>> = { 10: 35, 16: 50 };

/** The finding texts of the §5 table, in its order (the "VDE-AR-N 4100: " prefix is added by `finding`). */
const COPY = {
  unknownCode: (code: string) => `Unbekannter oder fehlerhafter Katalogcode ${code || "?"} — nur als Platzhalter gezeigt.`,
  outOfBounds: (art: string, field: number) => `${art}: ragt aus dem Schrank (Feld ${field}).`,
  overlap: (a: string, b: string, field: number) => `${a} und ${b} überlappen in Feld ${field}.`,
  heightMismatch: (art: string, mm: number, cabinet: string) => `${art}: für ${mm} mm Felder — passt nicht in ${cabinet}.`,
  fieldGap: (field: number, mm: string) => `Feld ${field}: ${mm} mm ohne Modul — Abdeckung einplanen.`,
  rowUnlinked: (row: string) => `${row}: keiner Hutschiene im Schrank zugeordnet.`,
  staleRail: (row: string, key: string, art: string) => `${row}: Hutschiene „${key}“ gibt es in ${art} nicht — gilt als „Nicht im Schrank“.`,
  retiredRail: (row: string, key: string, art: string) => `${row}: Hutschiene „${key}“ in ${art} ist ausgemustert — Geräte umsetzen.`,
  rowOrder: "Reihenfolge der Reihen passt nicht zum Schrank — im Tab Schrank „Reihen ordnen“ tippen.",
  railOverflow: (row: string, mm: string, ple: number) => `${row}: ${mm} mm Geräte auf ${ple} PLE Hutschiene.`,
  suppliedDangling: (bmk: string) => `${bmk}: gehört zu keinem Modul mehr — zählt als eigenes Gerät.`,
  crossModuleFeed: (row: string, count: number, head: string) =>
    `${row}: ${count} Stromkreis(e) hängen an ${head} aus einem anderen Feld — FI davor setzen oder Einspeisung prüfen.`,
  unverified: (art: string, note: string) => `${art}: Katalogdaten ungeprüft — ${note}.`,
  meterDevice: (bmk: string) => `${bmk}: Zwischenzähler auf der Hutschiene — eHZ/3-Punkt gehören auf den Zählerplatz.`,
  meterPlaceInvalid: (art: string, place: number) => `${art}: Zählerplatz ${place} gibt es nicht — Eintrag wird ignoriert.`,
  narSls: (field: number, art: string, have: number, need: number) =>
    `Feld ${field} (${art}): ${have} SLS-Schalter für ${need} Zählerplatz/-plätze im NAR.`,
  narFuse: (art: string) => `NAR ${art}: NH/Neozed ist nicht als Trennvorrichtung zulässig — SLS verwenden.`,
  narForeign: (art: string, short: string) => `NAR ${art}: ${short} gehört nicht in den NAR.`,
  slsRating: (field: number, art: string, rating: string, mm2: number, max: number) =>
    `Feld ${field} (${art}): SLS ${rating} zu groß für ${mm2} mm² Feldverdrahtung (max. E${max}).`,
  aarContents: (art: string, short: string) => `AAR ${art}: ${short} gehört nicht in den AAR — kein Stromkreisverteiler.`,
  aarCircuits: (art: string) => `AAR ${art}: höchstens drei Stromkreise je Zählerplatz, je max. 16 A.`,
  mainSwitch3p: (field: number, have: number, need: number) =>
    `Hinter jedem 3-Punkt-Zähler in Feld ${field} gehört ein Hauptschalter in den AAR (${have} von ${need}).`,
  rfzDevices: (art: string) => `RfZ/APZ (${art}) ist nur für Geräte des Netz-/Messstellenbetreibers.`,
  apzMissing: "Kein APZ im Schrank (mind. 300 mm, plombierbar).",
  apzPosition: (field: number) => `APZ in Feld ${field}: oben oder unten am Schrankrand und seitlich neben dem Zählerfeld.`,
  meterPlaceEmpty: (place: number, field: number) =>
    `Zählerplatz ${place} in Feld ${field} als Reserve geplant — Blindabdeckung steht auf der Materialliste.`,
} as const;

interface Placed {
  module: EnclosureModule;
  spec: ModuleSpec | null;
  /** Position in `enclosure.modules`. */
  order: number;
  /** The article number, or the code when the catalogue does not know it. */
  art: string;
  width: number;
  height: number;
}

/** A rail that holds a row: resolvable, and its row exists. */
interface LinkedRail {
  placed: Placed;
  zone: ZoneSpec;
  rail: RailSpec;
  row: PanelRow;
  /** Cabinet field of the zone: module field + zone offset. */
  field: number;
}

interface Board {
  doc: PanelDocument;
  index: CatalogIndex;
  cabinet: EnclosureSpec | null;
  cabinetCode: string;
  placed: Placed[];
  links: Map<string, RailLink>;
  rails: LinkedRail[];
}

function finding(rule: string, level: "warn" | "info", scope: string, message: string): PanelFinding {
  return { level, scope, message: rule.startsWith("vde.") ? VDE + message : message, rule };
}

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const shortName = (device: PanelDevice): string => catalogEntry(device.kind).short;
const bmk = (device: PanelDevice): string => trimmed(device.designation) || shortName(device);
const rowName = (row: PanelRow): string => trimmed(row.label) || row.id;
/** An LS up to 10 A may tap the NAR or sit on the RfZ (Spannungsabgriff); shared with the prep. */
const isSmallMcb = isSmallTap;

function meterPlaces(module: EnclosureModule): Set<number> {
  const places = new Set<number>();
  for (const meter of Array.isArray(module.meters) ? module.meters : []) {
    if (Number.isInteger(meter?.place) && meter.place >= 0) places.add(meter.place);
  }
  return places;
}

function need(placed: Placed): number {
  const count = meterPlaceCount(placed.spec);
  return Math.max(1, [...meterPlaces(placed.module)].filter((place) => place < count).length);
}

function cells(placed: Placed): Set<string> {
  const out = new Set<string>();
  for (let f = placed.module.field; f < placed.module.field + placed.width; f += 1) {
    for (let u = placed.module.unit; u < placed.module.unit + placed.height; u += 1) out.add(`${f}:${u}`);
  }
  return out;
}

const meterModules = (board: Board): Placed[] =>
  board.placed
    .filter((placed) => placed.spec && METER_FAMILIES.has(placed.spec.family))
    .sort((a, b) => a.module.field - b.module.field || a.module.unit - b.module.unit || a.order - b.order);

const railsOf = (board: Board, placed: Placed, ...types: ZoneType[]): LinkedRail[] =>
  board.rails.filter((rail) => rail.placed === placed && types.includes(rail.zone.type));

const devicesOn = (rails: LinkedRail[]): PanelDevice[] => rails.flatMap((rail) => rail.row.devices);

const railOfRow = (board: Board, rowId: string | null): LinkedRail | undefined =>
  rowId ? board.rails.find((rail) => rail.row.id === rowId) : undefined;

// ── encl.* ───────────────────────────────────────────────────────────────────

function unknownCodes(board: Board): PanelFinding[] {
  const out = board.cabinet ? [] : [finding("encl.unknown_code", "warn", "", COPY.unknownCode(board.cabinetCode))];
  for (const placed of board.placed) {
    if (!placed.spec) out.push(finding("encl.unknown_code", "warn", placed.module.id, COPY.unknownCode(trimmed(placed.module.code))));
  }
  return out;
}

function outOfBounds(board: Board): PanelFinding[] {
  const cabinet = board.cabinet;
  if (!cabinet) return [];
  const outside = ({ module, width, height }: Placed) =>
    module.field < 0 || module.unit < 0 || module.field + width > cabinet.fields || module.unit + height > cabinet.units_per_field;
  return board.placed
    .filter(outside)
    .map((placed) => finding("encl.out_of_bounds", "warn", placed.module.id, COPY.outOfBounds(placed.art, placed.module.field + 1)));
}

function overlaps(board: Board): PanelFinding[] {
  const covered = board.placed.map(cells);
  const out: PanelFinding[] = [];
  board.placed.forEach((later, j) => {
    for (let i = 0; i < j; i += 1) {
      const shared = [...covered[j]].filter((cell) => covered[i].has(cell)).map((cell) => Number(cell.split(":")[0]));
      if (shared.length === 0) continue;
      out.push(finding("encl.overlap", "warn", later.module.id, COPY.overlap(board.placed[i].art, later.art, Math.min(...shared) + 1)));
    }
  });
  return out;
}

function heightMismatch(board: Board): PanelFinding[] {
  const cabinet = board.cabinet;
  if (!cabinet) return [];
  const usable = cabinet.units_per_field * cabinet.unit_mm;
  return board.placed
    .filter(({ spec }) => spec && spec.field_height_mm !== null && spec.field_height_mm !== usable)
    .map((placed) => {
      const message = COPY.heightMismatch(placed.art, placed.spec!.field_height_mm!, cabinet.article_no);
      return finding("encl.height_mismatch", "warn", placed.module.id, message);
    });
}

function fieldGaps(board: Board): PanelFinding[] {
  const cabinet = board.cabinet;
  if (!cabinet) return [];
  const covered = new Set(board.placed.flatMap((placed) => [...cells(placed)]));
  const out: PanelFinding[] = [];
  for (let field = 0; field < cabinet.fields; field += 1) {
    let free = 0;
    for (let unit = 0; unit < cabinet.units_per_field; unit += 1) if (!covered.has(`${field}:${unit}`)) free += 1;
    if (free > 0) out.push(finding("encl.field_gap", "info", "", COPY.fieldGap(field + 1, formatMmText(free * cabinet.unit_mm))));
  }
  return out;
}

/** Rows outside the cabinet that a module names under a key (or code) the catalogue does not resolve; the first name wins. */
function staleNames(board: Board): Map<string, { placed: Placed; key: string }> {
  const existing = new Set(board.doc.rows.map((row) => row.id));
  const out = new Map<string, { placed: Placed; key: string }>();
  for (const placed of board.placed) {
    const resolvable = resolvableRails(placed.module, board.index);
    for (const [key, rowId] of Object.entries(placed.module.rails ?? {})) {
      if (typeof rowId !== "string" || !existing.has(rowId) || board.links.has(rowId)) continue;
      if (!resolvable.has(key) && !out.has(rowId)) out.set(rowId, { placed, key });
    }
  }
  return out;
}

function unlinkedRows(board: Board): PanelFinding[] {
  const stale = staleNames(board);
  return board.doc.rows
    .filter((row) => !board.links.has(row.id) && !stale.has(row.id))
    .map((row) => finding("encl.row_unlinked", "info", row.id, COPY.rowUnlinked(rowName(row))));
}

function staleRails(board: Board): PanelFinding[] {
  const rows = new Map(board.doc.rows.map((row) => [row.id, row] as const));
  const out = [...staleNames(board)].map(([rowId, { placed, key }]) =>
    finding("encl.stale_rail", "warn", rowId, COPY.staleRail(rowName(rows.get(rowId)!), key, placed.art)),
  );
  for (const { rail, row, placed } of board.rails) {
    if (!rail.retired || row.devices.length === 0) continue;
    out.push(finding("encl.stale_rail", "info", row.id, COPY.retiredRail(rowName(row), rail.key, placed.art)));
  }
  return out;
}

function rowOrder(board: Board): PanelFinding[] {
  const wanted = physicalRowOrder(board.doc, board.index);
  if (board.doc.rows.length === wanted.length && board.doc.rows.every((row, i) => row.id === wanted[i])) return [];
  return [finding("encl.row_order", "warn", "", COPY.rowOrder)];
}

function railOverflow(board: Board): PanelFinding[] {
  return board.rails.flatMap(({ rail, row }) => {
    const used = row.devices.reduce((total, device) => total + enclosureDeviceWidthMm(device, rail), 0);
    // Same width in TE: the existing slot warning already says it.
    const slots = Number.isInteger(row.slots) && row.slots ? row.slots : 12;
    if (used <= railLengthMm(rail) + 0.05 || slots === rail.ple) return [];
    return [finding("encl.rail_overflow", "warn", row.id, COPY.railOverflow(rowName(row), formatMmText(used), rail.ple))];
  });
}

function suppliedDangling(board: Board): PanelFinding[] {
  const fittings = new Map<string, Set<string>>();
  for (const { module } of board.placed) {
    if (fittings.has(module.id)) continue;
    fittings.set(module.id, new Set(moduleFittings(module, board.index).filter((f) => f.device_kind).map((f) => f.key)));
  }
  const dangling = (device: PanelDevice) => !!device.supplied_by && !fittings.get(device.supplied_by.module)?.has(device.supplied_by.part);
  return board.doc.rows.flatMap((row) =>
    row.devices.filter(dangling).map((device) => finding("encl.supplied_dangling", "info", device.id, COPY.suppliedDangling(bmk(device)))),
  );
}

function crossModuleFeed(board: Board): PanelFinding[] {
  const counts = new Map<string, { rowId: string; head: PanelDevice; count: number }>();
  for (const group of buildTopology(board.doc)) {
    const head = group.device;
    if (!head) continue;
    const headRail = railOfRow(board, findRowOf(board.doc, head.id));
    for (const child of group.children) {
      const childRail = railOfRow(board, findRowOf(board.doc, child.id));
      // An explicit feed is a decision; a row outside the cabinet is not ours.
      if (child.parent_id || !childRail) continue;
      if (headRail && headRail.placed === childRail.placed) continue;
      const key = `${childRail.row.id}\u0000${head.id}`;
      const entry = counts.get(key) ?? { rowId: childRail.row.id, head, count: 0 };
      counts.set(key, { ...entry, count: entry.count + 1 });
    }
  }
  const rows = new Map(board.doc.rows.map((row) => [row.id, row] as const));
  return [...counts.values()].map(({ rowId, head, count }) =>
    finding("encl.cross_module_feed", "warn", rowId, COPY.crossModuleFeed(rowName(rows.get(rowId)!), count, bmk(head))),
  );
}

function unverifiedEntries(board: Board): PanelFinding[] {
  const note = (lines: string[]) => lines.find((line) => typeof line === "string" && line) ?? "ohne Angabe";
  const out: PanelFinding[] = [];
  if (board.cabinet && !board.cabinet.verified) {
    out.push(finding("encl.unverified", "info", "", COPY.unverified(board.cabinet.article_no, note(board.cabinet.unverified))));
  }
  const seen = new Set<string>();
  for (const placed of board.placed) {
    const code = trimmed(placed.module.code);
    if (!placed.spec || placed.spec.verified || seen.has(code)) continue;
    seen.add(code);
    out.push(finding("encl.unverified", "info", placed.module.id, COPY.unverified(placed.art, note(placed.spec.unverified))));
  }
  return out;
}

function meterDevices(board: Board): PanelFinding[] {
  if (!board.placed.some(({ spec }) => meterPlaceCount(spec) > 0)) return [];
  return board.doc.rows.flatMap((row) =>
    row.devices
      .filter((device) => device.kind === "meter")
      .map((device) => finding("encl.meter_device", "info", device.id, COPY.meterDevice(bmk(device)))),
  );
}

function invalidMeterPlaces(board: Board): PanelFinding[] {
  return board.placed.flatMap((placed) => {
    if (!placed.spec) return [];
    const count = meterPlaceCount(placed.spec);
    return [...meterPlaces(placed.module)]
      .filter((place) => place >= count)
      .map((place) => finding("encl.meter_place_invalid", "info", placed.module.id, COPY.meterPlaceInvalid(placed.art, place + 1)));
  });
}

// ── vde.* (VDE-AR-N 4100:2026-04) ────────────────────────────────────────────

type SortKey = (number | string)[];
const compareKeys = (a: SortKey, b: SortKey): number => {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
};

/** (field, SLS) on every SAS rail, in the order credit is handed out. */
function sasPool(board: Board): { field: number; id: string }[] {
  const keyed: { key: SortKey; field: number; id: string }[] = [];
  for (const rail of board.rails) {
    if (rail.zone.type !== "SAS") continue;
    rail.row.devices.forEach((device, position) => {
      if (device.kind !== "sls") return;
      const key = [rail.field, rail.placed.module.unit, rail.placed.module.id, rail.zone.unit, rail.rail.unit, position];
      keyed.push({ key, field: rail.field, id: device.id });
    });
  }
  return keyed.sort((a, b) => compareKeys(a.key, b.key));
}

function narSls(board: Board): PanelFinding[] {
  const pool = sasPool(board);
  const used = new Set<number>();
  return meterModules(board).flatMap((placed) => {
    const wanted = need(placed);
    let have = devicesOn(railsOf(board, placed, "NAR")).filter((d) => d.kind === "sls").length;
    pool.forEach((sls, i) => {
      if (have >= wanted || used.has(i) || Math.abs(sls.field - placed.module.field) > 1) return;
      used.add(i);
      have += 1;
    });
    if (have >= wanted) return [];
    return [finding("vde.nar_sls", "warn", placed.module.id, COPY.narSls(placed.module.field + 1, placed.art, have, wanted))];
  });
}

function narContents(board: Board): PanelFinding[] {
  return board.rails
    .filter((rail) => rail.zone.type === "NAR")
    .flatMap((rail) =>
      rail.row.devices.flatMap((device) => {
        if (device.kind === "fuse") return [finding("vde.nar_contents", "warn", device.id, COPY.narFuse(rail.placed.art))];
        const foreign = device.kind === "rcd" || device.kind === "rcbo" || (isCircuitDevice(device) && !isSmallMcb(device));
        return foreign ? [finding("vde.nar_contents", "warn", device.id, COPY.narForeign(rail.placed.art, shortName(device)))] : [];
      }),
    );
}

function slsRating(board: Board): PanelFinding[] {
  return board.placed.flatMap((placed) => {
    const wiring = placed.spec?.wiring_mm2;
    if (!wiring) return []; // unknown wiring: silent rather than a guess from the article code
    const limit = SLS_MAX_A[wiring];
    return devicesOn(railsOf(board, placed, "NAR"))
      .filter((device) => device.kind === "sls" && (ratingValue(device.rating) ?? 0) > limit)
      .map((device) => {
        const message = COPY.slsRating(placed.module.field + 1, placed.art, trimmed(device.rating), wiring, limit);
        return finding("vde.sls_rating", "warn", device.id, message);
      });
  });
}

const AAR_ALLOWED: ReadonlySet<DeviceKind> = new Set<DeviceKind>([
  "hauptschalter", "rcd", "rcbo", "mcb", "hlak", "terminal", "spd", "blank", "pv", "wallbox",
]);

function aarContents(board: Board): PanelFinding[] {
  return board.rails
    .filter((rail) => rail.zone.type === "AAR")
    .flatMap((rail) =>
      rail.row.devices
        .filter((device) => !AAR_ALLOWED.has(device.kind))
        .map((device) => finding("vde.aar_contents", "warn", device.id, COPY.aarContents(rail.placed.art, shortName(device)))),
    );
}

function aarCircuits(board: Board): PanelFinding[] {
  return board.placed.flatMap((placed) => {
    const circuits = devicesOn(railsOf(board, placed, "AAR")).filter(isCircuitDevice);
    const tooBig = circuits.some((device) => (ratingValue(device.rating) ?? 0) > AAR_MAX_A);
    if (circuits.length <= AAR_PER_PLACE * need(placed) && !tooBig) return [];
    return [finding("vde.aar_circuits", "warn", placed.module.id, COPY.aarCircuits(placed.art))];
  });
}

function threePointMainSwitch(board: Board): PanelFinding[] {
  return meterModules(board)
    .filter((placed) => placed.spec?.family === "meter_3p")
    .flatMap((placed) => {
      const wanted = need(placed);
      const have = devicesOn(railsOf(board, placed, "AAR")).filter((d) => d.kind === "hauptschalter").length;
      if (have >= wanted) return [];
      return [finding("vde.3p_main_switch", "warn", placed.module.id, COPY.mainSwitch3p(placed.module.field + 1, have, wanted))];
    });
}

const RFZ_FORBIDDEN: ReadonlySet<DeviceKind> = new Set<DeviceKind>([
  "rcd", "rcbo", "hauptschalter", "sls", "fuse", "contactor", "impulse", "timer",
  "bell_transformer", "knx_actuator", "wallbox", "pv", "sub_feed",
]);

function rfzDevices(board: Board): PanelFinding[] {
  return board.rails
    .filter((rail) => rail.zone.type === "RFZ" || rail.zone.type === "APZ")
    .flatMap((rail) =>
      rail.row.devices
        .filter((device) => RFZ_FORBIDDEN.has(device.kind) || (device.kind === "mcb" && !isSmallMcb(device)))
        .map((device) => finding("vde.rfz_devices", "warn", device.id, COPY.rfzDevices(rail.placed.art))),
    );
}

const zonesOf = (board: Board, type: ZoneType): { placed: Placed; zone: ZoneSpec }[] =>
  board.placed.flatMap((placed) =>
    (placed.spec?.zones ?? []).filter((zone) => zone.type === type).map((zone) => ({ placed, zone })),
  );

function apzMissing(board: Board): PanelFinding[] {
  if (meterModules(board).length === 0 || zonesOf(board, "APZ").length > 0) return [];
  return [finding("vde.apz_missing", "warn", "", COPY.apzMissing)];
}

function apzPosition(board: Board): PanelFinding[] {
  const cabinet = board.cabinet;
  if (!cabinet) return [];
  const meterFields = new Set(zonesOf(board, "ZF").map(({ placed, zone }) => placed.module.field + zone.field));
  const reported = new Set<string>();
  const out: PanelFinding[] = [];
  for (const { placed, zone } of zonesOf(board, "APZ")) {
    const top = placed.module.unit + zone.unit;
    const field = placed.module.field + zone.field;
    const misplaced = (top !== 0 && top + zone.units !== cabinet.units_per_field) || meterFields.has(field);
    if (!misplaced || reported.has(placed.module.id)) continue;
    reported.add(placed.module.id);
    out.push(finding("vde.apz_position", "warn", placed.module.id, COPY.apzPosition(field + 1)));
  }
  return out;
}

function emptyMeterPlaces(board: Board): PanelFinding[] {
  const out: PanelFinding[] = [];
  for (const placed of board.placed) {
    if (!placed.spec) continue;
    const taken = meterPlaces(placed.module);
    let first = 0;
    for (const zone of meterZones(placed.spec)) {
      for (let place = first; place < first + zone.meter_places; place += 1) {
        if (taken.has(place)) continue;
        const message = COPY.meterPlaceEmpty(place + 1, placed.module.field + zone.field + 1);
        out.push(finding("vde.meter_place_empty", "info", placed.module.id, message));
      }
      first += zone.meter_places;
    }
  }
  return out;
}

// ── Entry point ──────────────────────────────────────────────────────────────

const CHECKS: readonly ((board: Board) => PanelFinding[])[] = [
  unknownCodes, outOfBounds, overlaps, heightMismatch, fieldGaps, unlinkedRows, staleRails, rowOrder,
  railOverflow, suppliedDangling, crossModuleFeed, unverifiedEntries, meterDevices, invalidMeterPlaces,
  narSls, narContents, slsRating, aarContents, aarCircuits, threePointMainSwitch,
  rfzDevices, apzMissing, apzPosition, emptyMeterPlaces,
];

function readBoard(doc: PanelDocument, index: CatalogIndex): Board {
  const placed = enclosureModules(doc).map((module, order): Placed => {
    const spec = index.module(module.code);
    const art = spec ? spec.article_no : trimmed(module.code);
    return { module, spec, order, art, width: spec?.width_fields ?? 1, height: spec?.height_units ?? 1 };
  });
  const links = linkedRows(doc, index);
  const rows = new Map(doc.rows.map((row) => [row.id, row] as const));
  const rails = placed.flatMap((entry) =>
    (entry.spec?.zones ?? []).flatMap((zone) =>
      zone.rails.flatMap((rail) => {
        const rowId = railRowId(links, entry.module, rail.key);
        const row = rowId ? rows.get(rowId) : undefined;
        return row ? [{ placed: entry, zone, rail, row, field: entry.module.field + zone.field }] : [];
      }),
    ),
  );
  const cabinetCode = trimmed(doc.enclosure?.code);
  return { doc, index, cabinet: cabinetCode ? index.enclosure(cabinetCode) : null, cabinetCode, placed, links, rails };
}

const byOrder = (a: PanelFinding, b: PanelFinding): number =>
  (RANK.get(a.rule ?? "") ?? 99) - (RANK.get(b.rule ?? "") ?? 99) || compareKeys([a.scope, a.message], [b.scope, b.message]);

/**
 * Every cabinet finding of a board, sorted; [] without a cabinet. A check
 * that trips over a hand-edited document is skipped and logged, never
 * thrown: the editor must keep drawing whatever the board looks like.
 * `pre`: the board's `boardTerminals` and `placeTerminals`, when the caller
 * already has them (round 2, §6.7); the terminal rules derive them otherwise.
 * `block`: the parsed §14a block (R4 §4); DERIVE reads it from the document.
 */
export function enclosureFindings(
  document: PanelDocument, index: CatalogIndex, pre?: TerminalPrecomputed, block: BlockArg = DERIVE,
): PanelFinding[] {
  if (!document.enclosure) return [];
  let board: Board;
  try {
    board = readBoard(document, index);
  } catch (error) {
    console.warn("Schrank-Prüfung übersprungen", error);
    return [];
  }
  const findings = CHECKS.flatMap((check) => {
    try {
      return check(board);
    } catch (error) {
      console.warn(`Schrank-Prüfung ${check.name} übersprungen`, error);
      return [];
    }
  });
  return [...findings, ...roundFourFindings(document, index, block), ...terminalFindings(document, index, pre)].sort(byOrder);
}

function roundFourFindings(document: PanelDocument, index: CatalogIndex, block: BlockArg): PanelFinding[] {
  try {
    return prepFindings(document, index, block);
  } catch (error) {
    console.warn("Schrank-Prüfung (Zählerschrank-Vorbereitung) übersprungen", error);
    return [];
  }
}
