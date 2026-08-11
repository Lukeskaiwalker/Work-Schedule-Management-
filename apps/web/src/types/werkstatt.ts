/**
 * Werkstatt (workshop / inventory) types.
 *
 * This file is the SHARED contract between all Werkstatt FE agents and the
 * backend. It must stay aligned with `apps/api/app/schemas/werkstatt.py`.
 *
 * See `WERKSTATT_CONTRACT.md` at the repo root for the full spec.
 */

// Machines have their own contract file (this one is the article/stock
// contract and is already long). The scan cascade can return one, so the
// result union below needs the type — mirrors the same one-way import on the
// backend, where `schemas/werkstatt.py` imports `schemas/werkstatt_machines`.
import type { Machine } from "./werkstattMachines";

// ──────────────────────────────────────────────────────────────────────────
// Primitives
// ──────────────────────────────────────────────────────────────────────────

export type WerkstattStockStatus =
  | "available"
  | "low"
  | "empty"
  | "out"
  | "unavailable";

export type WerkstattMovementType =
  | "checkout"
  | "return"
  | "intake"
  | "correction"
  | "repair_out"
  | "repair_back";

export type WerkstattOrderStatus =
  | "draft"
  | "sent"
  | "confirmed"
  | "partially_delivered"
  | "delivered"
  | "cancelled";

export type WerkstattOrderLineStatus =
  | "pending"
  | "partial"
  | "complete"
  | "cancelled";

export type WerkstattImageSource = "unielektro" | "manual" | "catalog";

export type WerkstattLocationType =
  | "hall"
  | "shelf"
  | "vehicle"
  | "external";

// ──────────────────────────────────────────────────────────────────────────
// Taxonomy
// ──────────────────────────────────────────────────────────────────────────

export interface WerkstattCategory {
  id: number;
  name: string;
  parent_id: number | null;
  display_order: number;
  icon_key: string | null;
  notes: string | null;
  is_archived: boolean;
  article_count: number; // denormalised for list views
  created_at: string;
  updated_at: string;
}

/**
 * Availability of the place itself, as distinct from what is stored in it.
 * `null` for a shelf, which inherits its parent hall's.
 */
export type WerkstattLocationStatus = "open" | "closed" | "on_route" | "in_workshop";

export interface WerkstattLocation {
  id: number;
  name: string;
  location_type: WerkstattLocationType;
  parent_id: number | null;
  address: string | null;
  status: WerkstattLocationStatus | null;
  display_order: number;
  notes: string | null;
  is_archived: boolean;
  article_count: number;
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Suppliers
// ──────────────────────────────────────────────────────────────────────────

export interface WerkstattSupplier {
  id: number;
  name: string;
  short_name: string | null;
  email: string | null;
  order_email: string | null;
  phone: string | null;
  contact_person: string | null;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
  address_country: string | null;
  default_lead_time_days: number | null;
  notes: string | null;
  is_archived: boolean;
  article_count: number;
  last_order_at: string | null;
  created_at: string;
  updated_at: string;
}

export type WerkstattSupplierCreate = Pick<
  WerkstattSupplier,
  "name" | "short_name" | "email" | "order_email" | "phone" | "contact_person"
  | "address_street" | "address_zip" | "address_city" | "address_country"
  | "default_lead_time_days" | "notes"
>;

export interface WerkstattArticleSupplier {
  id: number;
  article_id: number;
  supplier_id: number;
  supplier_name: string;               // denormalised for display
  supplier_article_no: string | null;
  typical_price_cents: number | null;
  currency: string;
  typical_lead_time_days: number | null;
  effective_lead_time_days: number | null; // with supplier default fallback
  minimum_order_quantity: number;
  is_preferred: boolean;
  source_catalog_item_id: number | null;
  last_ordered_at: string | null;
  last_confirmed_lead_time_days: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Articles
// ──────────────────────────────────────────────────────────────────────────

export interface WerkstattArticle {
  id: number;
  article_number: string;              // "SP-0201"
  ean: string | null;
  item_name: string;
  manufacturer: string | null;
  category_id: number | null;
  category_name: string | null;
  location_id: number | null;
  location_name: string | null;
  unit: string | null;

  image_url: string | null;
  image_source: WerkstattImageSource | null;
  image_checked_at: string | null;

  source_catalog_item_id: number | null;

  stock_total: number;
  stock_available: number;
  stock_out: number;
  stock_repair: number;
  stock_min: number;
  stock_status: WerkstattStockStatus;  // computed server-side

  is_serialized: boolean;
  bg_inspection_required: boolean;
  bg_inspection_interval_days: number | null;
  last_bg_inspected_at: string | null;
  next_bg_due_at: string | null;

  purchase_price_cents: number | null;
  currency: string;
  notes: string | null;
  is_archived: boolean;

  suppliers: WerkstattArticleSupplier[];
  next_expected_delivery_at: string | null; // earliest pending order line

  created_at: string;
  updated_at: string;
}

export interface WerkstattArticleLite {
  id: number;
  article_number: string;
  ean: string | null;
  item_name: string;
  manufacturer: string | null;
  category_name: string | null;
  location_name: string | null;
  stock_available: number;
  stock_total: number;
  stock_status: WerkstattStockStatus;
  image_url: string | null;
  next_expected_delivery_at: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Movements
// ──────────────────────────────────────────────────────────────────────────

export interface WerkstattMovement {
  id: number;
  article_id: number;
  article_number: string;
  article_name: string;
  movement_type: WerkstattMovementType;
  quantity: number;
  from_location_name: string | null;
  to_location_name: string | null;
  project_id: number | null;
  project_number: string | null;
  project_name: string | null;
  user_id: number;
  user_display_name: string;
  assignee_user_id: number | null;
  assignee_display_name: string | null;
  expected_return_at: string | null;
  notes: string | null;
  created_at: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Orders
// ──────────────────────────────────────────────────────────────────────────

export interface WerkstattOrderLine {
  id: number;
  /**
   * Null on a "free" line — something we are buying but do not stock, which is
   * most of what comes back from a wholesaler cart. Such a line records the
   * purchase but moves no stock on delivery. Use `is_stocked` rather than
   * testing this, so the intent reads at the call site.
   */
  article_id: number | null;
  order_id: number;
  article_number: string | null;
  /** Always populated — the server falls back to the supplier's description. */
  article_name: string;
  article_supplier_id: number | null;
  supplier_article_no: string | null;
  /** What the supplier called it at order time, kept even for stocked lines. */
  description: string | null;
  manufacturer: string | null;
  ean: string | null;
  unit: string | null;
  source_import_id: number | null;
  is_stocked: boolean;
  quantity_ordered: number;
  quantity_received: number;
  unit_price_cents: number | null;
  currency: string;
  line_status: WerkstattOrderLineStatus;
  received_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface WerkstattOrder {
  id: number;
  order_number: string;                // "BST-2026-0042"
  supplier_id: number;
  supplier_name: string;
  status: WerkstattOrderStatus;
  total_amount_cents: number | null;
  currency: string;
  ordered_at: string | null;
  expected_delivery_at: string | null;
  delivered_at: string | null;
  delivery_reference: string | null;
  notes: string | null;
  created_by: number;
  created_by_name: string | null;
  line_count: number;
  lines: WerkstattOrderLine[];
  // ── Procurement ─────────────────────────────────────────────────────
  /** Human label. Order numbers identify; titles tell you what it is for. */
  title: string | null;
  /** Templates share this table but never ship — see the backend model. */
  is_template: boolean;
  template_name: string | null;
  task_id: number | null;
  task_title: string | null;
  project_id: number | null;
  project_name: string | null;
  /** manual | ids | template | merge | reorder */
  source: string;
  /** The wholesaler's own handle for the cart this came from. */
  external_reference: string | null;
  /** Set when this order was folded into another; it is kept, not deleted. */
  merged_into_order_id: number | null;
  merged_at: string | null;
  submitted_at: string | null;
  /** Whether the supplier has an enabled punchout — gates the shop button. */
  supplier_has_shop: boolean;
  created_at: string;
  updated_at: string;
}

export interface WerkstattOrderSummary {
  id: number;
  order_number: string;
  /** One order goes to one supplier — used to gate merge and template picks. */
  supplier_id: number;
  supplier_name: string;
  status: WerkstattOrderStatus;
  total_amount_cents: number | null;
  currency: string;
  ordered_at: string | null;
  expected_delivery_at: string | null;
  delivered_at: string | null;
  line_count: number;
  days_overdue: number | null;         // positive when expected < today and not delivered
  title: string | null;
  is_template: boolean;
  template_name: string | null;
  task_id: number | null;
  task_title: string | null;
  project_id: number | null;
  source: string;
  merged_into_order_id: number | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Reorder suggestions
// ──────────────────────────────────────────────────────────────────────────

export interface ReorderSuggestionLine {
  article_id: number;
  article_number: string;
  article_name: string;
  image_url: string | null;
  stock_available: number;
  stock_min: number;
  suggested_quantity: number;
  unit: string | null;
  unit_price_cents: number | null;
  line_total_cents: number | null;
}

export interface ReorderSuggestionGroup {
  supplier_id: number;
  supplier_name: string;
  supplier_short_name: string | null;
  default_lead_time_days: number | null;
  subtotal_cents: number | null;
  currency: string;
  lines: ReorderSuggestionLine[];
}

// ──────────────────────────────────────────────────────────────────────────
// BG-Prüfung / inspections
// ──────────────────────────────────────────────────────────────────────────

export type WerkstattInspectionUrgency = "ok" | "due_soon" | "overdue";

export interface WerkstattInspectionDue {
  article_id: number;
  article_number: string;
  article_name: string;
  category_name: string | null;
  location_name: string | null;
  last_bg_inspected_at: string | null;
  next_bg_due_at: string | null;
  days_until_due: number | null;       // negative = overdue
  urgency: WerkstattInspectionUrgency;
}

// ──────────────────────────────────────────────────────────────────────────
// Scan resolution
// ──────────────────────────────────────────────────────────────────────────

export type ScanMatchedBy =
  | "sp"                 // matched on werkstatt_articles.article_number
  | "ean"                // matched on werkstatt_articles.ean
  | "supplier_no"        // matched on werkstatt_article_suppliers.supplier_article_no
  | "catalog_ean"        // matched on material_catalog_items.ean
  | "catalog_article_no";// matched on material_catalog_items.article_no

export interface MaterialCatalogItemLite {
  id: number;
  external_key: string;
  supplier_id: number | null;
  supplier_name: string | null;
  article_no: string | null;
  item_name: string;
  ean: string | null;
  manufacturer: string | null;
  unit: string | null;
  price_text: string | null;
  image_url: string | null;
}

export type ScanResolveResult =
  | {
      /**
       * One physical machine — our own M-0001 label, or the manufacturer's
       * nameplate serial. Distinct from `werkstatt_article` because the answer
       * differs in kind: an article scan says what an item IS, a machine scan
       * says which one this is and who currently has it.
       *
       * `machine.components` is populated, so the UI can warn that the battery
       * and charger go out with it before the user confirms.
       */
      kind: "machine";
      machine: Machine;
      matched_by: "machine_number" | "serial_number";
    }
  | {
      kind: "werkstatt_article";
      article: WerkstattArticle;
      matched_by: Exclude<ScanMatchedBy, "catalog_ean" | "catalog_article_no">;
    }
  | {
      kind: "catalog_match";
      catalog_items: MaterialCatalogItemLite[]; // may contain multiple suppliers
      matched_by: Extract<ScanMatchedBy, "catalog_ean" | "catalog_article_no">;
    }
  | {
      kind: "not_found";
      code: string;
    };

// ──────────────────────────────────────────────────────────────────────────
// Datanorm import
// ──────────────────────────────────────────────────────────────────────────

export type DatanormImportStatus =
  | "uploaded"
  | "previewed"
  | "importing"
  | "committed"
  | "failed"
  | "cancelled";

export interface DatanormImportPreview {
  import_token: string;              // passed to commit endpoint
  supplier_id: number;
  supplier_name: string;
  filename: string;
  file_size_bytes: number;
  detected_version: string | null;   // "Datanorm 4" / "Datanorm 5"
  detected_encoding: string | null;  // "UTF-8" / "CP850"
  total_rows: number;
  rows_new: number;
  rows_updated: number;
  rows_unchanged: number;
  ean_conflicts: DatanormEanConflict[];
  sample_rows: DatanormSampleRow[];
  uploaded_at: string;
  expires_at: string;                // preview expires after N minutes
}

export interface DatanormSampleRow {
  article_no: string;
  item_name: string;
  ean: string | null;
  manufacturer: string | null;
  price_text: string | null;
}

export interface DatanormEanConflict {
  ean: string;
  item_name: string;
  existing_supplier_id: number;
  existing_supplier_name: string;
  existing_article_no: string | null;
}

export interface DatanormImportRecord {
  id: number;
  supplier_id: number;
  supplier_name: string;
  filename: string;
  status: DatanormImportStatus;
  total_rows: number;
  rows_new: number;
  rows_updated: number;
  rows_failed: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  created_by: number;
  created_by_name: string | null;
}

// ──────────────────────────────────────────────────────────────────────────
// Dashboard aggregate (for WerkstattPage)
// ──────────────────────────────────────────────────────────────────────────

export interface WerkstattDashboardKpis {
  total_articles: number;
  total_categories: number;
  below_min_count: number;
  on_site_count: number;
  on_site_project_count: number;
  unavailable_count: number;
  in_repair_count: number;
}

export interface WerkstattDashboard {
  kpis: WerkstattDashboardKpis;
  reorder_preview: ReorderSuggestionLine[];        // top 5
  recent_movements: WerkstattMovement[];           // last 5
  on_site_groups: WerkstattCheckoutGroupPreview[]; // top 3 projects
  maintenance_entries: WerkstattInspectionDue[];   // top 3
}

export interface WerkstattCheckoutGroupPreview {
  project_id: number;
  project_number: string;
  project_title: string;
  item_count: number;
  items: WerkstattCheckoutGroupItem[];
}

export interface WerkstattCheckoutGroupItem {
  article_id: number;
  article_number: string;
  article_name: string;
  quantity: number;
  assignee_display_name: string | null;
  expected_return_at: string | null;
  is_overdue: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Form / create payloads (FE → BE)
// ──────────────────────────────────────────────────────────────────────────

export interface WerkstattArticleCreatePayload {
  item_name: string;
  ean: string | null;
  manufacturer: string | null;
  category_id: number | null;
  location_id: number | null;
  unit: string | null;
  stock_total: number;
  stock_min: number;
  purchase_price_cents: number | null;
  is_serialized: boolean;
  bg_inspection_required: boolean;
  bg_inspection_interval_days: number | null;
  notes: string | null;
  image_url: string | null;
  source_catalog_item_id: number | null;
  suppliers: ArticleSupplierCreatePayload[];
}

export interface ArticleSupplierCreatePayload {
  supplier_id: number;
  supplier_article_no: string | null;
  typical_price_cents: number | null;
  typical_lead_time_days: number | null;
  minimum_order_quantity: number;
  is_preferred: boolean;
  source_catalog_item_id: number | null;
}

export interface CheckoutPayload {
  article_id: number;
  quantity: number;
  project_id: number | null;
  assignee_user_id: number | null;
  expected_return_at: string | null;
  notes: string | null;
}

export interface ReturnPayload {
  article_id: number;
  quantity: number;
  condition: "ok" | "repair" | "lost";
  notes: string | null;
}

export interface SubmitOrderPayload {
  supplier_id: number;
  lines: SubmitOrderLinePayload[];
  notes: string | null;
}

export interface SubmitOrderLinePayload {
  article_id: number;
  quantity: number;
  unit_price_cents: number | null;
}
