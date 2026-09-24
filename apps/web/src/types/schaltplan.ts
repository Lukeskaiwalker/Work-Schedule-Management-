/**
 * Verteilerplan (panel schematic) types.
 *
 * Mirrors `apps/api/app/schemas/schaltplan.py`. Own module rather than an
 * addition to `types/index.ts`: that file is already 1400 lines and this
 * domain is self-contained.
 */

export type PanelType = "main" | "sub" | "meter";
export type PanelStatus = "draft" | "final";
export type SupplySystem = "TN-S" | "TN-C-S" | "TT" | "IT";
export type PhaseLabel = "L1" | "L2" | "L3" | "L1-L3" | "L1/N" | "N" | "-";

/** Every device kind the catalogue knows. Kept in step with DEVICE_CATALOG. */
export type DeviceKind =
  | "hauptschalter"
  | "sls"
  | "rcd"
  | "rcbo"
  | "mcb"
  | "fuse"
  | "spd"
  | "meter"
  | "contactor"
  | "impulse"
  | "timer"
  | "bell_transformer"
  | "power_supply"
  | "knx_actuator"
  | "wallbox"
  | "pv"
  | "sub_feed"
  | "terminal"
  | "blank";

export type DeviceSymbol =
  | "switch"
  | "sls"
  | "rcd"
  | "rcbo"
  | "mcb"
  | "fuse"
  | "spd"
  | "meter"
  | "contactor"
  | "relay"
  | "transformer"
  | "bus"
  | "wallbox"
  | "pv"
  | "subfeed"
  | "terminal"
  | "blank";

export interface PanelDevice {
  id: string;
  kind: DeviceKind;
  /** Width in Teilungseinheiten (1 TE = 17.5 mm nominal, DIN 43880). */
  te: number;
  /**
   * Real mounted width in millimetres; null means "derive from `te`".
   * Drives the BMK strip: a Hager FI is 70 mm, not the 72 mm that 4 × 18
   * would give — see `utils/schaltplanStrip.ts`.
   */
  width_mm: number | null;
  poles: number;
  /** Betriebsmittelkennzeichen, e.g. "F1.3". */
  designation: string;
  /** Stromkreis-Nr. printed in the legend. */
  circuit: string;
  label: string;
  room: string;
  rating: string;
  residual_current: string;
  rcd_type: string;
  cable: string;
  phase: PhaseLabel;
  /** Explicit feed override; null means "derive from position". */
  parent_id: string | null;
  /**
   * Kind "fuse" only: this Neozed/NH block feeds the circuits after it on
   * the rail, up to the next FI/SLS/Hauptschalter — an RCBO row or a row of
   * MCBs that need no FI. It then heads a group of its own, exactly like an
   * FI would. See `opensGroup` in `utils/schaltplanTopology.ts`.
   */
  feeds_following: boolean;
  /**
   * The outgoing ends on a WAGO Reihenklemme. Opt-in per device; only
   * MCB-protected outgoing kinds (LS, Wallbox, UV-Abgang, PV) read it —
   * see `utils/schaltplanTerminalRules.ts`. Off on every old document.
   */
  terminal_block: boolean;
  note: string;
}

export interface PanelRow {
  id: string;
  label: string;
  slots: number;
  devices: PanelDevice[];
}

export interface PanelSupply {
  system: SupplySystem;
  voltage: string;
  incoming: string;
  fuse: string;
  meter_number: string;
  note: string;
}

export interface PanelDocument {
  version: number;
  supply: PanelSupply;
  rows: PanelRow[];
  /**
   * Reihenklemmen marker texts the user overrode, keyed `"<device id>:<slot>"`
   * (see `overrideKey` in `utils/schaltplanTerminals.ts`): slot `feed` for the
   * FI's feed terminal, `1`/`2` for an outgoing's Etagenklemmen, `N`/`L1`…/`PE`
   * for a Block's cells, `name`/`x` for the Block's two text rows. A blank
   * value means "no text". Absent on every document written before 2026-09-23.
   */
  terminal_labels?: Record<string, string>;
}

export interface PanelLegendRow {
  circuit: string;
  designation: string;
  label: string;
  room: string;
  device: string;
  rating: string;
  rcd: string;
  cable: string;
  phase: string;
  group: string;
  /** "F0 35 A" when the circuit's FI has a Vorsicherung, else "—". */
  pre_fuse: string;
  note: string;
  /** "X1.1, X1.2" — the Reihenklemmen the circuit ends on; "" without one. */
  terminals: string;
}

export interface PanelFinding {
  level: string;
  scope: string;
  message: string;
}

export interface PanelPlanSummary {
  id: number;
  /** "VT-0007" — the panel's own number, printed as a DataMatrix on the Schrank-Etikett and scanned at the Regal station. */
  panel_number: string;
  customer_id: number;
  customer_name: string | null;
  project_id: number | null;
  project_number: string | null;
  project_name: string | null;
  name: string;
  designation: string;
  panel_type: PanelType;
  location: string | null;
  fed_from_panel_id: number | null;
  fed_from_designation: string | null;
  status: PanelStatus;
  revision: number;
  device_count: number;
  circuit_count: number;
  rcd_count: number;
  used_slots: number;
  total_slots: number;
  row_count: number;
  updated_at: string;
  updated_by_name: string | null;
}

/** One line of the server-side Reihenklemmen Stückliste (mirrors `PanelTerminalBomRow`). */
export interface PanelTerminalBomRow {
  part_id: string;
  part_no: string;
  name: string;
  count: number;
  width_mm: number;
  verified: boolean;
}

export interface PanelPlan extends PanelPlanSummary {
  document: PanelDocument;
  notes: string | null;
  legend: PanelLegendRow[];
  findings: PanelFinding[];
  /** The server's derivation; the editor renders its own twin and uses this only as the truth to compare against. */
  terminal_bom: PanelTerminalBomRow[];
  created_at: string;
  created_by_name: string | null;
}

/** One protection group: an FI / main switch and everything hanging off it. */
export interface PanelGroup {
  /** null = circuits sitting straight on the busbar with no protection. */
  device: PanelDevice | null;
  /** The Neozed/NH block feeding this group, when the group device names one. */
  preFuse: PanelDevice | null;
  children: PanelDevice[];
}

// ── Materialliste / Kommissionierung ─────────────────────────────────────────
// Mirrors `PanelMaterialOut` in apps/api/app/schemas/schaltplan.py. Planned
// lines are derived from the document on every read; scanned quantities come
// from the Werkstatt ledger (`consumption` minus `consumption_undo` rows that
// carry this panel's id).

export type PanelMaterialLineKind = "device" | "terminal" | "extra";
export type PanelMaterialLineStatus = "open" | "done" | "over" | "unplanned";
export type PanelMaterialArticleSource = "mapping" | "auto";

/** The stock article a line is checked off against — a slim projection, not the full WerkstattArticleOut. */
export interface PanelMaterialArticle {
  id: number;
  article_number: string;
  item_name: string;
  manufacturer: string | null;
  unit: string | null;
  internal_code: string | null;
  stock_available: number;
}

export interface PanelMaterialLine {
  /** "device:mcb:1p:b16" | "part:2003-7641" | "article:218" — also the mapping key. */
  key: string;
  kind: PanelMaterialLineKind;
  label: string;
  detail: string;
  planned: number;
  scanned: number;
  status: PanelMaterialLineStatus;
  article: PanelMaterialArticle | null;
  article_source: PanelMaterialArticleSource | null;
  last_scanned_at: string | null;
}

export interface PanelMaterialPanel {
  id: number;
  panel_number: string;
  designation: string;
  name: string;
  panel_type: PanelType;
  status: PanelStatus;
  customer_id: number;
  customer_name: string | null;
  project_id: number | null;
  project_number: string | null;
  project_name: string | null;
  updated_at: string;
}

export interface PanelMaterial {
  panel: PanelMaterialPanel;
  lines: PanelMaterialLine[];
  planned_total: number;
  scanned_total: number;
  open_lines: number;
  last_scanned_at: string | null;
}

/** One row of the Werkstatt "Verteiler" overview (`GET /schaltplan/material/overview`). */
export interface PanelMaterialSummary {
  panel: PanelMaterialPanel;
  planned_total: number;
  scanned_total: number;
  open_lines: number;
  last_scanned_at: string | null;
}

export interface PanelMaterialMappingResult {
  key: string;
  article: PanelMaterialArticle | null;
}
