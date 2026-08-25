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
  /** Width in Teilungseinheiten (1 TE = 18 mm on the rail). */
  te: number;
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
  note: string;
}

export interface PanelFinding {
  level: string;
  scope: string;
  message: string;
}

export interface PanelPlanSummary {
  id: number;
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

export interface PanelPlan extends PanelPlanSummary {
  document: PanelDocument;
  notes: string | null;
  legend: PanelLegendRow[];
  findings: PanelFinding[];
  created_at: string;
  created_by_name: string | null;
}

/** One protection group: an FI / main switch and everything hanging off it. */
export interface PanelGroup {
  /** null = circuits sitting straight on the busbar with no protection. */
  device: PanelDevice | null;
  children: PanelDevice[];
}
