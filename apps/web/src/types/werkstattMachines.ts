/**
 * Maschinen (individually tracked machines) — the FE half of the contract with
 * `apps/api/app/schemas/werkstatt_machines.py`.
 *
 * Kept out of `types/werkstatt.ts` for the same reason the backend keeps them
 * out of `schemas/werkstatt.py`: that file is the shared article/stock contract
 * and is already past 800 lines. A machine is not another article variant — it
 * is one physical object with a custody log — so it gets its own contract file.
 *
 * Every field here mirrors a Pydantic field one-for-one. If you change one
 * side, change the other in the same commit.
 */

/**
 * Machine lifecycle. German values on purpose: they are stored in the database
 * and printed in the UI, and translating at the boundary would mean two names
 * for the same state in logs, payloads and screens.
 *
 * Only `verfuegbar` is bookable — see BOOKABLE_STATUSES in
 * `services/werkstatt_machines.py`.
 */
export type MachineStatus =
  | "verfuegbar"
  | "ausgegeben"
  | "wartung"
  | "defekt"
  | "ausgemustert";

/** A sub-component (battery, charger, case) flattened onto its parent. */
export interface MachineComponent {
  id: number;
  unit_number: string;
  article_id: number;
  article_name: string | null;
  status: MachineStatus;
  serial_number: string | null;
  next_inspection_due_at: string | null;
}

export interface Machine {
  id: number;
  /** The label stuck on the machine — "M-0001". Unique and never recycled. */
  unit_number: string;
  article_id: number;
  article_name: string | null;
  manufacturer: string | null;
  parent_unit_id: number | null;
  serial_number: string | null;
  status: MachineStatus;

  current_location_id: number | null;
  current_location_name: string | null;
  holder_user_id: number | null;
  holder_name: string | null;

  booked_from: string | null;
  booked_until: string | null;
  /** Server-computed so "late" means the same thing here and in the scanner. */
  is_overdue: boolean;

  inspection_required: boolean;
  inspection_interval_days: number | null;
  last_inspected_at: string | null;
  next_inspection_due_at: string | null;
  inspection_overdue: boolean;

  purchased_at: string | null;
  notes: string | null;
  is_archived: boolean;
  created_at: string;

  /** Populated by GET /machines/{id} only — the list view leaves it empty. */
  components: MachineComponent[];
}

/** One line of the custody log. */
export interface MachineMovement {
  id: number;
  movement_type: string;
  from_location_id: number | null;
  from_location_name: string | null;
  to_location_id: number | null;
  to_location_name: string | null;
  user_id: number;
  user_name: string | null;
  assignee_user_id: number | null;
  assignee_name: string | null;
  expected_return_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface MachineCreatePayload {
  article_id: number;
  serial_number?: string | null;
  parent_unit_id?: number | null;
  current_location_id?: number | null;
  inspection_required?: boolean | null;
  inspection_interval_days?: number | null;
  last_inspected_at?: string | null;
  purchased_at?: string | null;
  notes?: string | null;
}

export interface MachineUpdatePayload {
  serial_number?: string | null;
  parent_unit_id?: number | null;
  current_location_id?: number | null;
  status?: MachineStatus;
  inspection_required?: boolean;
  inspection_interval_days?: number | null;
  notes?: string | null;
  is_archived?: boolean;
}

export interface MachineBookPayload {
  holder_user_id?: number | null;
  to_location_id?: number | null;
  booked_from?: string | null;
  booked_until?: string | null;
  /** What the scanner sends: taking it now, back tonight. */
  for_today?: boolean;
  notes?: string | null;
}

export interface MachineReturnPayload {
  to_location_id?: number | null;
  /** Lets the person handing it back say "this came back broken". */
  status?: MachineStatus;
  notes?: string | null;
}

export interface MachineInspectionPayload {
  inspected_at?: string | null;
  interval_days?: number | null;
  passed?: boolean;
  notes?: string | null;
}

/** Confirmation from POST /machines/{id}/print-label. */
export interface MachineLabelPrintResult {
  unit_number: string;
  /** "host:port" the job went to — useful when a wrong IP needs diagnosing. */
  printer: string;
}

/** "gross" = one full 99×44 sheet; "klein" = quarter label, 4 per sheet. */
export type MachineLabelFormat = "gross" | "klein";

export interface MachineLabelBatchItem {
  unit_id: number;
  format: MachineLabelFormat;
}

/** The print queue — klein entries may be DIFFERENT machines on one sheet. */
export interface MachineLabelBatchPayload {
  items: MachineLabelBatchItem[];
}

export interface MachineLabelBatchResult {
  sheets: number;
  labels: number;
  printer: string;
}

/** Server-side filters. Mirrors the query params of GET /werkstatt/machines. */
export interface MachineListFilters {
  q?: string;
  status?: MachineStatus;
  location_id?: number;
  holder_user_id?: number;
  overdue_only?: boolean;
  inspection_due_only?: boolean;
  include_archived?: boolean;
  include_components?: boolean;
}
