/**
 * Cabinet layer of a Verteilerplan (docs/PANEL_ENCLOSURE.md).
 *
 * Mirrors `apps/api/app/schemas/panel_enclosure.py`: the document parts that
 * live inside `panel_plans.document` (§2.2), the catalogue specs a cabinet or
 * field module is described by (§3.1), the catalogue API shapes (§7) and the
 * scene the geometry builds for every renderer (§4). Own module, like
 * `types/schaltplan.ts`, because the domain is self-contained.
 *
 * Documents come from tablets several versions behind and from hand edits,
 * so the readers in `utils/enclosure*.ts` treat every optional-looking field
 * as possibly missing even where the server always fills it.
 */

import type { DeviceKind, PanelMaterialArticle } from "./schaltplan";

export type ZoneType = "NAR" | "ZF" | "RFZ" | "AAR" | "VF" | "APZ" | "VT" | "SAS" | "MM" | "COVER";
export type MountType = "rail" | "busbar";
export type ModuleFamily =
  | "meter_ehz"
  | "meter_3p"
  | "distribution"
  | "distribution_apz"
  | "busbar"
  | "communication"
  | "multimedia"
  | "cover";
export type MeterType = "ehz" | "3punkt";
export type CatalogEntryType = "enclosure" | "module";
export type CatalogSource = "builtin" | "custom" | "override";

// ── Document parts (§2.1, §2.2) ──────────────────────────────────────────────

/** This device came pre-fitted in a cabinet module: which module instance, which of its fittings. */
export interface DeviceSuppliedBy {
  module: string;
  part: string;
}

/** An occupied meter place. A place without an entry is "frei" (reserve, blind plate). */
export interface EnclosureMeter {
  place: number;
  number: string;
  label: string;
}

/** A catalogue fitting as snapshotted into the module at placement (D5). */
export interface EnclosureFitting {
  key: string;
  label: string;
  article_no: string | null;
  device_kind: DeviceKind | null;
  removable: boolean;
}

/**
 * One field's manual WAGO strip sequence (docs/PANEL_ENCLOSURE_R2.md §2.1):
 * strip ids left → right on rail 1, then rail 2; `rail2_from` = the strip
 * that starts rail 2, null = split automatically.
 */
export interface TerminalOrderEntry {
  strips: string[];
  rail2_from: string | null;
}

export interface EnclosureModule {
  id: string;
  code: string;
  /** 0-based field from the left. */
  field: number;
  /** 0-based 150 mm raster unit from the top of the usable field height. */
  unit: number;
  label: string;
  /** Catalogue rail key → row id, lazy: a rail gets a row when it first holds something. */
  rails: Record<string, string>;
  /**
   * The snapshot taken at placement (D5). Absent or null = no snapshot (a
   * hand-made module reads the catalogue); [] = "nothing came pre-fitted",
   * which a fitting added to the catalogue later must not change.
   */
  fittings?: EnclosureFitting[] | null;
  removed_fittings: string[];
  meters: EnclosureMeter[];
  /**
   * Round 2 (§2.1): the manual strip order, keyed by the field offset inside
   * this module ("0" for every built-in). Only after a manual strip move;
   * null and absent mean the same. Read ONLY through `parseTerminalOrder`
   * (`utils/enclosureTerminals.ts`): a rollback image stores it unvalidated.
   */
  terminal_order?: Record<string, TerminalOrderEntry> | null;
}

// ── Round 4: the §14a block and the prep overrides (docs/PANEL_ENCLOSURE_R4.md §2) ──

/** Never grün-gelb (PE), hellblau/blau (N), single grün/gelb. */
export type WireColour = "braun" | "schwarz" | "grau" | "rot" | "violett" | "weiß" | "orange" | "rosa";
/** The heat-shrink tube the wire labels print on (O3/O4). */
export type TubeMaterialId = "wago-211-501" | "wago-211-502";
export type WireMm2 = 1.5 | 2.5;

/** One output of the §14a block, left → right. */
export interface ControlTerminal {
  /** "t1"…: `t` and 1–3 digits, unique in the block. */
  id: string;
  /** ≤ 12 code points; "" = unnamed (printed as an empty segment). */
  label: string;
  color: WireColour;
}

/**
 * `enclosure.control_block` (§2.1): the Steuersignal-Klemmleiste's user data.
 * Where it sits is derived (`placeControlBlock`). Read ONLY through
 * `parseControlBlock` (`utils/enclosureControlBlock.ts`): a tablet several
 * versions behind or a hand edit may store anything here.
 */
export interface ControlBlock {
  terminals: ControlTerminal[];
  /** An AAR rail key of the carrier; null = automatic (§3.2). */
  rail: string | null;
  wire_mm2: WireMm2;
  /** null = measured on the drawing; else 0,5 … 20 m, one decimal. */
  wire_length_m: number | null;
  label_material: TubeMaterialId;
  /** true = removed on this board (no Materialliste lines, no drawing). */
  off: boolean;
}

export type PrepSupplyChoice = "auto" | "SA" | "LS" | "SI" | "off";
export type PrepInfeedChoice = "auto" | "K96ESA5" | "clamps" | "off";
export type PrepToggle = "auto" | "off";

/** `enclosure.prep` (§2.2): per-board overrides of the derived items; absent ≡ every group `auto`. Read through `parsePrep`. */
export interface PrepOverrides {
  supply: PrepSupplyChoice;
  infeed: PrepInfeedChoice;
  joints: PrepToggle;
  network: PrepToggle;
  /** A stored network lead length (0,5 … 20 m); null = from Hager's table or the drawing. */
  network_m: number | null;
}

/** `document.enclosure`: the cabinet and the modules in it. */
export interface PanelEnclosure {
  code: string;
  modules: EnclosureModule[];
  /** Round 4 (§2.1): absent on boards older than round 4; seeded by `placeModule`. */
  control_block?: ControlBlock | null;
  /** Round 4 (§2.2): only once a group was overridden. */
  prep?: PrepOverrides | null;
}

// ── Catalogue specs (§3.1) ───────────────────────────────────────────────────

export interface RailSpec {
  key: string;
  /** Unit within the zone, from its top. */
  unit: number;
  /** Width in Platzeinheiten (1 PLE = 17.5 mm). */
  ple: number;
  mount: MountType;
  retired: boolean;
}

export interface ZoneSpec {
  key: string;
  type: ZoneType;
  label: string;
  /** Field offset inside the module. */
  field: number;
  unit: number;
  units: number;
  rails: RailSpec[];
  meter_places: number;
  meter_type: MeterType | null;
  sealable: boolean;
}

export interface FittingDevice {
  kind: DeviceKind;
  rail: string;
  te: number;
  poles: number;
  rating: string;
  width_mm: number | null;
}

export interface FittingSpec {
  key: string;
  label: string;
  article_no: string | null;
  removable: boolean;
  device: FittingDevice | null;
  verified: boolean;
  note: string;
  retired: boolean;
}

export interface AccessorySpec {
  article_no: string;
  label: string;
  qty: number;
  verified: boolean;
}

interface CatalogSpecBase {
  code: string;
  article_no: string;
  manufacturer: string;
  series: string;
  name: string;
  accessories: AccessorySpec[];
  verified: boolean;
  /** What is unchecked, one fact per line; the first is what the finding quotes. */
  unverified: string[];
  source_url: string | null;
  note: string;
}

export interface EnclosureSpec extends CatalogSpecBase {
  height_mm: number;
  width_mm: number;
  depth_mm: number;
  fields: number;
  door_leaves: number;
  field_width_mm: number;
  unit_mm: number;
  margin_mm: number;
  units_per_field: number;
  mounting: "surface";
  ip: string;
  door: string;
}

export interface ModuleSpec extends CatalogSpecBase {
  family: ModuleFamily;
  /** 1050 → 1100 mm cabinets, 1350 → 1400 mm; null = fits any. */
  field_height_mm: number | null;
  width_fields: number;
  height_units: number;
  wiring_mm2: 10 | 16 | null;
  zones: ZoneSpec[];
  fittings: FittingSpec[];
  free_place_cover: AccessorySpec | null;
  /**
   * R4-12: a reserve meter field (ZH33XL, ZH53XL, ZH52XL) is never the §14a
   * carrier while a meter field in use exists. Not frozen; admins set it in JSON.
   */
  reserve_field: boolean;
}

// ── Catalogue API (§7) ───────────────────────────────────────────────────────

export interface CatalogEntry<S extends EnclosureSpec | ModuleSpec = EnclosureSpec | ModuleSpec> {
  code: string;
  entry_type: CatalogEntryType;
  source: CatalogSource;
  archived: boolean;
  /** The stored spec no longer validates: still a known code, drawn as a placeholder. */
  invalid: boolean;
  spec: S | null;
  article: PanelMaterialArticle | null;
  article_source: "mapping" | "auto" | null;
  stock_available: number;
  recent_count: number;
  last_used_at: string | null;
  used_by_plans: number;
}

/** A Hager field kit on the shelf the catalogue does not know yet (managers only). */
export interface UncataloguedArticle {
  article: PanelMaterialArticle;
  code_guess: string;
}

export interface EnclosureCatalog {
  enclosures: CatalogEntry<EnclosureSpec>[];
  modules: CatalogEntry<ModuleSpec>[];
  can_manage: boolean;
  uncatalogued: UncataloguedArticle[];
}

export type CatalogEntryIn =
  | { entry_type: "enclosure"; spec: EnclosureSpec }
  | { entry_type: "module"; spec: ModuleSpec };

// ── Scene (§4) ───────────────────────────────────────────────────────────────

export type SceneView = "open" | "closed";

export type SceneBoxKind =
  | "shell"
  | "field"
  | "module"
  | "zone"
  | "rail"
  | "busbar"
  | "device"
  | "meter"
  | "meter_place"
  | "cover"
  | "cover_slot"
  | "device_front"
  | "window"
  | "meter_front"
  | "blind_plate"
  | "door"
  | "handle"
  /** Round 2 (§8): one placed WAGO strip on a terminal rail, open view only. */
  | "terminal_strip"
  /** Round 4 (R4 §5): the §14a block on its carrier's AAR rail, open view only (id `control:block`). */
  | "control_block";

/** `terminals` (round 2, §8): a reserved terminal rail, drawn even when empty. */
export type SceneBoxFlag =
  | "overflow"
  | "supplied"
  | "sealable"
  | "unknown_code"
  | "unverified"
  | "free"
  | "retired"
  | "terminals";

/**
 * One box of the drawing, in mm. Origin: top-left corner of the cabinet's
 * back face; x → right, y → down, z → toward the viewer (front at z = depth).
 */
export interface SceneBox {
  id: string;
  kind: SceneBoxKind;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  /** "" when none. */
  label: string;
  moduleId: string | null;
  railKey: string | null;
  rowId: string | null;
  deviceId: string | null;
  zoneType: ZoneType | null;
  /** Sorted. */
  flags: string[];
}

export interface EnclosureScene {
  width: number;
  height: number;
  depth: number;
  view: SceneView;
  boxes: SceneBox[];
}

// ── WAGO terminals on the rails (round 2, docs/PANEL_ENCLOSURE_R2.md) ───────

/** How a field's strips were packed (§2.3): its stored order, none, or a stored split that no longer fits. */
export type TerminalOrderStatus = "default" | "manual" | "ignored";

/** One strip (Leiste or Block) placed on a terminal rail. Every mm is `round1`ed. */
export interface PlacedTerminalStrip {
  stripId: string;
  stripNo: number;
  kind: "leiste" | "block";
  xLabel: string;
  groupId: string;
  /** R4: the field holding most of its circuits; null when none is in a field. */
  homeField: number | null;
  /** The field of its protective device; null for the supply group or a head outside the cabinet. */
  headField: number | null;
  /** From the rail's left end, the rail's back-compat devices included. */
  offsetMm: number;
  widthMm: number;
  /** `widthMm`, plus the end plate when it sits inside this strip (before its trailing 2009-305). */
  extentMm: number;
}

/**
 * A part that closes a terminal rail: one end plate matching its last
 * terminal block (R7). No end stops — the owner ruled the WAGO 249-116 out
 * on 2026-10-22.
 */
export interface TerminalRailPart {
  partId: string;
  role: "end_plate";
  offsetMm: number;
  widthMm: number;
}

export interface PlacedTerminalRail {
  moduleId: string;
  railKey: string;
  /** The rail's linked row, if any (devices placed before round 2). */
  rowId: string | null;
  /** 0 = the field's top terminal rail, 1 = the second. */
  position: number;
  /** "F2 · Verteiler 1". */
  title: string;
  capacityMm: number;
  /** Σ widths of the non-placeholder devices on the rail's row (R12). */
  devicesMm: number;
  /** devicesMm + Σ strip widths + the last strip's end plate. */
  usedMm: number;
  /** The module's served spec has the fitting `u84t` (R8). */
  insulated: boolean;
  strips: PlacedTerminalStrip[];
  parts: TerminalRailPart[];
}

export interface UnplacedTerminalStrip {
  stripId: string;
  xLabel: string;
  widthMm: number;
}

export interface TerminalFieldPlacement {
  field: number;
  order: TerminalOrderStatus;
  /** The module whose `terminal_order` the field read; null without one. */
  orderModuleId: string | null;
  rails: PlacedTerminalRail[];
  unplaced: UnplacedTerminalStrip[];
  /** Σ widths of the unplaced strips. */
  missingMm: number;
}

/** Derived, never stored (§2.3): Python emits these key names, so the fixture compares as is. */
export interface TerminalPlacement {
  /** Sorted ids of the devices that get no terminal (R3). */
  skip: string[];
  /** TERMINAL_RAIL_USABLE_MM (R16). */
  usableMm: number;
  /** Every field with terminal rails, ascending. */
  fields: TerminalFieldPlacement[];
  /** R6: strips whose home field has no terminal rails, and where they went. */
  elsewhere: { stripId: string; homeField: number; field: number }[];
  /** Strips none of whose circuits sits in a field ("Nicht im Schrank"). */
  outside: string[];
  /** Strips with a home field on a board with no terminal rails at all. */
  noRails: string[];
  /** part id → count of the rail parts, in TERMINAL_PART_ORDER. */
  railParts: Record<string, number>;
  /** U84T sets: terminal rails with a placed strip that are not insulated. */
  insulationSets: number;
}

// ── Close-up of a field's terminal rails (§7.1) ──────────────────────────────

export interface CloseupItem {
  /** No "end_stop": the owner ruled the WAGO 249-116 out on 2026-10-22. */
  kind: "terminal" | "end_clamp" | "end_plate";
  /** "2003-7641" / "WAGO 2003-7641". */
  partId: string;
  partNo: string;
  stripId: string | null;
  /** The strip's "X3"; "" for rail parts. */
  xLabel: string;
  /** On the rail, from its left end (devices included). */
  offsetMm: number;
  widthMm: number;
  /** After overrides; "" without a marker. */
  marker: string;
  /** Conductors on this terminal, top → bottom. */
  levels: string[];
  /** The same text as TerminalGroupCard's "für" column. */
  forText: string;
  /** device.cable, trimmed. */
  cable: string;
  deviceId: string | null;
}

export interface CloseupRail {
  moduleId: string;
  railKey: string;
  title: string;
  position: 0 | 1;
  capacityMm: number;
  usedMm: number;
  insulated: boolean;
  devices: { deviceId: string; label: string; offsetMm: number; widthMm: number }[];
  items: CloseupItem[];
}

export interface TerminalCloseup {
  field: number;
  order: TerminalOrderStatus;
  rails: CloseupRail[];
  unplaced: { stripId: string; xLabel: string; title: string; widthMm: number }[];
}

// ── Suggestions (§4.2) ───────────────────────────────────────────────────────

export interface RailTarget {
  moduleId: string;
  railKey: string;
  title: string;
  field: number;
}

export type TerminalSuggestion =
  | {
      rule: "encl.terminal_rail_devices";
      field: number;
      kind: "relink_rows";
      scopes: string[];
      moves: { rowId: string; target: RailTarget }[];
    }
  | {
      rule: "encl.terminals_overflow";
      field: number;
      kind: "move_group";
      scope: string;
      headId: string;
      deviceIds: string[];
      targets: RailTarget[];
    }
  | { rule: "encl.terminal_order_ignored"; field: number; kind: "reset_order"; scope: string }
  | {
      rule: "encl.terminal_placeholders";
      field: number;
      kind: "remove_placeholders";
      scopes: string[];
      deviceIds: string[];
    };

// ── Round 4: the §14a block's placement and the cabinet preparation (R4 §3) ──

export type ControlPartId = "249-116" | "2002-1671" | "2002-1692";

/** One part of the block, left → right; the non-terminal parts carry nulls. Every mm is `round1`ed. */
export interface ControlBlockPart {
  partId: ControlPartId;
  terminalId: string | null;
  label: string | null;
  color: WireColour | null;
  /** 1-based terminal position; null for end stops and the end plate. */
  position: number | null;
  /** Relative to the block's left edge. */
  offsetMm: number;
  widthMm: number;
}

/** `placeControlBlock` (§3.2): derived, never stored; Python emits these key names. */
export interface ControlBlockPlacement {
  moduleId: string;
  railKey: string;
  /** 0-based cabinet field of the AAR zone. */
  field: number;
  /** "F1 · AAR 1" (`default_rail_label`, never the row label). */
  railTitle: string;
  /** Rail left edge, scene mm. */
  railX: number;
  /** Rail centre line, scene mm. */
  railY: number;
  /** Block left edge from the rail's left end: right-aligned, never over the devices. */
  offsetMm: number;
  widthMm: number;
  devicesMm: number;
  capacityMm: number;
  overflow: boolean;
  parts: ControlBlockPart[];
}

export type PrepGroup = "supply" | "busbar" | "network" | "control";

/**
 * One derived item of the cabinet preparation (§3.3). `key` is the
 * Materialliste mapping key (`accessory:`, `part:`, `wire:`, `prep:`); an
 * item an override switched off keeps its place with `qty` 0 and `suppressed`.
 */
export interface PrepItem {
  key: string;
  articleNo: string | null;
  label: string;
  qty: number;
  unit: "Stk" | "m";
  reason: string;
  verified: boolean;
  group: PrepGroup;
  /** The matching `PrepOverrides` value; null for groups without one. */
  override: string | null;
  suppressed: boolean;
}

export type PrepRunKind = "supply" | "network" | "control";

/** A lead drawn on the open view (§3.4): vertical first, then horizontal; `lengthMm` from the unrounded ends. */
export interface PrepRun {
  kind: PrepRunKind;
  from: [number, number];
  to: [number, number];
  points: [number, number][];
  label: string;
  lengthMm: number;
}

/** What the infeed parser recognised and what it led to (the Daten hint, §8.5). */
export interface PrepInfeed {
  mm2: number | null;
  cores: number | null;
  aluminium: boolean;
  /** "K96ESA5", a clamp article, or null (no clamp fits). */
  article: string | null;
  /** The K96ESA5 is the automatic guess for an unknown cross-section. */
  assumed: boolean;
}

/** `cabinetPrep` (§3.3): null when the cabinet is unknown. */
export interface CabinetPrep {
  items: PrepItem[];
  runs: PrepRun[];
  /** null without a `main` busbar zone. */
  infeed: PrepInfeed | null;
  overrides: PrepOverrides;
}

/** `parseInfeed` (§3.5): the cross-section in a free-text cable description. */
export interface CableSection {
  mm2: number | null;
  /** 2…5, else null. */
  cores: number | null;
  aluminium: boolean;
}
