// Types for the Werkstatt › Projekt-Bedarfe screen.
//
// `ProjectMaterialNeed` in types/index.ts is the shape the legacy endpoint
// (`GET /materials`) returns and several older call sites still consume. The
// Bedarfe view reads `GET /werkstatt/bedarfe`, which answers the same row
// PLUS the catalogue and order context the screen needs to decide anything —
// who sells it, whether it can be ordered at all, and which Bestellung it
// already went into.
//
// Extending here rather than widening the shared type keeps that context out
// of every unrelated consumer, and out of a file three other areas are
// editing this cycle.

import type { MaterialNeedStatus, ProjectMaterialNeed } from "./index";
import type { WerkstattOrder } from "./werkstatt";

/** One row of the Bedarfe list. Every added field is server-derived. */
export interface MaterialNeedRow extends ProjectMaterialNeed {
  /** The supplier of the linked catalogue row — the order's addressee. */
  supplier_id?: number | null;
  supplier_name?: string | null;
  /** What the wholesaler's Datanorm calls it, which can differ from `item`. */
  catalog_item_name?: string | null;
  manufacturer?: string | null;
  ean?: string | null;
  /**
   * True when this row can become an order line: it has a catalogue match and
   * that match names a supplier. Independent of whether the supplier has a
   * webshop — a CSV or e-mail supplier is orderable too.
   */
  orderable?: boolean;
  /** "report" when a Bautagesbericht created it, "manual" otherwise. */
  source?: string;
  werkstatt_order_id?: number | null;
  werkstatt_order_number?: string | null;
  werkstatt_order_line_id?: number | null;
  ordered_at?: string | null;
}

/**
 * The toolbar's "Lieferant: ohne Katalog" option — rows with no catalogue
 * supplier at all, which is precisely the queue that blocks the order
 * hand-off. Sent as `supplier_id=none`; the router matches it to IS NULL.
 */
export const SUPPLIER_WITHOUT_CATALOG = "none";
export type SupplierFilter = number | typeof SUPPLIER_WITHOUT_CATALOG | null;

/** Query for `GET /werkstatt/bedarfe`. Empty fields are simply not sent. */
export interface MaterialNeedFilters {
  /** Canonical statuses; empty means "everything except completed". */
  statuses?: readonly MaterialNeedStatus[];
  projectId?: number | null;
  supplierId?: SupplierFilter;
  q?: string;
  includeCompleted?: boolean;
  orderableOnly?: boolean;
}

/** Fields a single row's inline edit may change. Omit what stays. */
export interface MaterialNeedPatch {
  status?: MaterialNeedStatus;
  notes?: string | null;
  item?: string;
  quantity?: string | null;
  unit?: string | null;
  article_no?: string | null;
  /** Explicit `null` unlinks the catalogue row; omitting keeps the link. */
  material_catalog_item_id?: number | null;
}

/** Why a selected need did not become an order line. Mirrors the API. */
export type MaterialNeedSkipReason =
  | "already_ordered"
  | "completed"
  | "no_catalog_item"
  | "no_supplier"
  | "other_supplier";

export interface MaterialNeedOrderAdded {
  need_id: number;
  order_id: number;
  line_id: number;
  /** German, ready to render. Null when the quantity carried over exactly. */
  quantity_warning: string | null;
}

export interface MaterialNeedOrderSkipped {
  need_id: number;
  reason: MaterialNeedSkipReason;
  order_number: string | null;
}

export interface MaterialNeedOrderResult {
  orders: WerkstattOrder[];
  added: MaterialNeedOrderAdded[];
  skipped: MaterialNeedOrderSkipped[];
  created_at: string | null;
}

/** What "Bestellung erstellen" sends. */
export interface MaterialNeedOrderRequest {
  need_ids: number[];
  supplier_id?: number | null;
  /** Append to this draft instead of creating one. */
  order_id?: number | null;
  title?: string | null;
}
