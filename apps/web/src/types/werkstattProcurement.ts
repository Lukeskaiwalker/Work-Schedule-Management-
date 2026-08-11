// Types for wholesaler punchout (IDS-Connect) and order composition.
//
// Mirrors apps/api/app/schemas/werkstatt_procurement.py. The order shapes
// themselves stay in `types/werkstatt.ts` — an imported cart becomes an
// ordinary WerkstattOrder, and a second order type would fork the UI.

export interface IdsConnection {
  id: number;
  supplier_id: number;
  supplier_name: string;
  is_enabled: boolean;
  /** The wholesaler's punchout entry URL, from their IDS-Datenblatt. */
  entry_url: string;
  http_method: string;
  ids_version: string;
  /** Usually ISO-8859-1 — IDS predates universal UTF-8. */
  charset: string;
  username: string | null;
  customer_number: string | null;
  /**
   * The password is never sent to the browser. This is all a settings form
   * needs: whether one is stored. Submitting the form without a `password`
   * field leaves the stored one untouched.
   */
  has_password: boolean;
  fetch_field_map: Record<string, string>;
  submit_field_map: Record<string, string>;
  cart_field_names: string[];
  hook_base_url: string | null;
  /** Rendered with a dummy token — safe to display and to copy. */
  hook_url_preview: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdsConnectionUpsert {
  supplier_id: number;
  is_enabled: boolean;
  entry_url: string;
  http_method: "POST" | "GET";
  ids_version: string;
  charset: string;
  username: string | null;
  /** Omit to keep the stored password, "" to clear it, text to replace it. */
  password?: string;
  customer_number: string | null;
  fetch_field_map?: Record<string, string>;
  submit_field_map?: Record<string, string>;
  cart_field_names?: string[];
  hook_base_url: string | null;
  notes: string | null;
}

export interface IdsConnectionTest {
  ok: boolean;
  problems: string[];
  hook_url: string;
  /** What would be POSTed to the shop, with the password masked. */
  preview_fields: Record<string, string>;
}

export interface IdsHandoff {
  token: string;
  /** Open in a new tab — it serves a self-submitting form, not a redirect. */
  handoff_url: string;
  expires_at: string;
  warnings?: string[];
}

export interface CartPreviewLine {
  position: number;
  supplier_article_no: string | null;
  description: string | null;
  manufacturer: string | null;
  ean: string | null;
  quantity: number;
  /** What the shop wrote, before any rounding. Evidence for the warnings. */
  quantity_raw: string | null;
  unit: string | null;
  unit_price_cents: number | null;
  currency: string;
  warnings: string[];
  matched_article_id: number | null;
  matched_article_name: string | null;
}

export interface CartImportResult {
  import_id: number;
  order_id: number;
  order_number: string;
  line_count: number;
  warnings: string[];
  lines: CartPreviewLine[];
}

export interface OrderImportRow {
  id: number;
  supplier_id: number;
  supplier_name: string;
  source: string;
  /** received | parsed | failed | committed */
  status: string;
  external_reference: string | null;
  parsed_line_count: number;
  error_message: string | null;
  order_id: number | null;
  order_number: string | null;
  created_by: number | null;
  created_by_name: string | null;
  created_at: string;
}

export interface OrderLineCreate {
  article_id?: number | null;
  supplier_article_no?: string | null;
  description?: string | null;
  manufacturer?: string | null;
  ean?: string | null;
  unit?: string | null;
  quantity_ordered: number;
  unit_price_cents?: number | null;
  currency?: string | null;
  notes?: string | null;
}

export type OrderLineUpdate = Partial<OrderLineCreate>;

export interface OrderAttach {
  task_id?: number | null;
  project_id?: number | null;
  title?: string | null;
}
