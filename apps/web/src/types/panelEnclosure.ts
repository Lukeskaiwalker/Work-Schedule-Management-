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
}

/** `document.enclosure`: the cabinet and the modules in it. */
export interface PanelEnclosure {
  code: string;
  modules: EnclosureModule[];
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
  | "handle";

export type SceneBoxFlag = "overflow" | "supplied" | "sealable" | "unknown_code" | "unverified" | "free" | "retired";

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
