/**
 * Werkstatt — placeholder module.
 *
 * This file used to ship realistic German demo data so the Werkstatt UI
 * could be reviewed in isolation from the data layer. For the v2.0.0
 * release the demo payloads were stripped out — every `MOCK_*` export is
 * now an empty array / zero / empty string. Types + pure utility
 * functions are retained because they're consumed across ~16 importers.
 *
 * Pages that consume these constants render their empty states until the
 * Werkstatt backend endpoints land. Renaming would have cascaded to every
 * importer; we kept the filename so imports stay stable.
 *
 * TODO(werkstatt): wire each `MOCK_*` to its `/api/werkstatt/*` endpoint
 * as those land — see the Werkstatt contract document for the shape map.
 */

import type { WerkstattStockSeverity } from "./WerkstattReorderRow";
import type { WerkstattMovementKind } from "./WerkstattMovementRow";
import type { WerkstattCheckedOutStatus } from "./WerkstattProjectGroup";
import type { WerkstattMaintenanceBadge } from "./WerkstattMaintenanceRow";
import type {
  WerkstattOrder,
  WerkstattOrderLine,
  WerkstattOrderStatus,
} from "../../types/werkstatt";

/* ─────────────────────────────────────────────────────────────────────
   Dashboard feed fixtures (now empty)
   ──────────────────────────────────────────────────────────────────── */

export type MockReorderItem = {
  id: string;
  item_name: string;
  article_no: string;
  category: string;
  location: string;
  stock_label: string;
  severity: WerkstattStockSeverity;
};

export type MockMovement = {
  id: string;
  kind: WerkstattMovementKind;
  title_de: string;
  title_en: string;
  subtitle: string;
  timestamp_de: string;
  timestamp_en: string;
};

export type MockCheckoutItem = {
  id: string;
  title: string;
  trailing: string;
  status: WerkstattCheckedOutStatus;
};

export type MockCheckoutGroup = {
  id: string;
  project_number: string;
  project_title: string;
  item_count: number;
  items: ReadonlyArray<MockCheckoutItem>;
};

export type MockMaintenanceEntry = {
  id: string;
  tool_name: string;
  context_de: string;
  context_en: string;
  badge: WerkstattMaintenanceBadge;
  badge_label_de: string;
  badge_label_en: string;
};

export const MOCK_REORDER: ReadonlyArray<MockReorderItem> = [];
export const MOCK_MOVEMENTS: ReadonlyArray<MockMovement> = [];
export const MOCK_CHECKOUT_GROUPS: ReadonlyArray<MockCheckoutGroup> = [];
export const MOCK_MAINTENANCE: ReadonlyArray<MockMaintenanceEntry> = [];

/* ─────────────────────────────────────────────────────────────────────
   Inventory fixtures (now empty)
   ──────────────────────────────────────────────────────────────────── */

export type MockStockTone = "available" | "low" | "empty" | "out";

export type MockInventoryRow = {
  id: string;
  article_no: string;
  item_name: string;
  sub_meta: string;
  category: string;
  location: string;
  stock_label: string;
  stock_tone: MockStockTone;
  out_initials: string | null;
  out_label: string | null;
  in_transit_label: string | null;
};

export const MOCK_INVENTORY_ROWS: ReadonlyArray<MockInventoryRow> = [];

/* ─────────────────────────────────────────────────────────────────────
   Categories + locations (now empty)
   ──────────────────────────────────────────────────────────────────── */

export type MockCategory = {
  id: string;
  name: string;
  article_count: number;
  subcategory_count: number;
  expanded: boolean;
  subcategories: ReadonlyArray<{ id: string; name: string; article_count: number }>;
};

export const MOCK_CATEGORIES: ReadonlyArray<MockCategory> = [];

export type MockLocationStatus = "open" | "on_route" | "in_workshop";

export type MockLocation = {
  id: string;
  name: string;
  sub: string;
  icon: "hall" | "vehicle";
  address: string;
  article_count: number;
  status: MockLocationStatus;
  expanded: boolean;
  shelves: ReadonlyArray<{ id: string; name: string; article_count: number }>;
  children?: ReadonlyArray<{ id: string; name: string; article_count: number }>;
};

export const MOCK_LOCATIONS: ReadonlyArray<MockLocation> = [];

/* ─────────────────────────────────────────────────────────────────────
   Suppliers (now empty)
   ──────────────────────────────────────────────────────────────────── */

export type MockSupplier = {
  id: string;
  name: string;
  short_name: string;
  contact_person: string;
  contact_email: string;
  lead_time_days: string;
  default_currency: string;
  article_count: number;
  order_count: number;
};

export const MOCK_SUPPLIERS: ReadonlyArray<MockSupplier> = [];

/* ─────────────────────────────────────────────────────────────────────
   Catalog + Datanorm fixtures (now empty)
   ──────────────────────────────────────────────────────────────────── */

export type MockCatalogSupplierOffer = {
  id: string;
  supplier_name: string;
  supplier_article_no: string;
  lead_time_days: number;
  price_text: string;
  is_preferred: boolean;
  // Optional / future fields — not all consumers populate these.
  supplier_id?: string;
  unit_price_cents?: number;
  currency?: string;
  delivery_days?: number | null;
};

export type MockCatalogEntry = {
  id: string;
  item_name: string;
  manufacturer: string | null;
  ean: string | null;
  offers: ReadonlyArray<MockCatalogSupplierOffer>;
  // Optional — not populated by every consumer.
  article_no?: string;
  category?: string;
  unit?: string;
};

export const MOCK_CATALOG_ENTRIES: ReadonlyArray<MockCatalogEntry> = [];

export type MockDatanormImportRow = {
  id: string;
  supplier: string;
  filename: string;
  row_count: number;
  when_de: string;
  when_en: string;
  sub_de: string;
  sub_en: string;
  outcome_variant: "ok" | "warn" | "error";
  outcome_label: string;
  status: "ok" | "warn" | "error";
  message_de: string;
  message_en: string;
};

export const MOCK_DATANORM_IMPORTS: ReadonlyArray<MockDatanormImportRow> = [];

/* ─────────────────────────────────────────────────────────────────────
   Orders (Bestellungen) fixtures (now empty) + filter chip config
   ──────────────────────────────────────────────────────────────────── */

export type MockOrderLine = WerkstattOrderLine;
export type MockOrder = WerkstattOrder;

export type OrdersFilterKey =
  | "all"
  | "draft"
  | "sent"
  | "in_transit"
  | "overdue"
  | "delivered";

export const MOCK_ORDERS: ReadonlyArray<MockOrder> = [];

export function orderMatchesFilter(
  order: MockOrder,
  filter: OrdersFilterKey,
  daysOverdue: number | null,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "draft":
      return order.status === "draft";
    case "sent":
      return order.status === "sent";
    case "in_transit":
      return (
        order.status === "sent" ||
        order.status === "confirmed" ||
        order.status === "partially_delivered"
      );
    case "overdue":
      return (
        daysOverdue !== null &&
        daysOverdue > 0 &&
        order.status !== "delivered" &&
        order.status !== "cancelled"
      );
    case "delivered":
      return order.status === "delivered";
  }
}

export interface MockAvailability {
  id: string;
  article_name: string;
  stock_available: number;
  next_expected_delivery_at: string | null;
  unit: string | null;
}

export const MOCK_AVAILABILITY: ReadonlyArray<MockAvailability> = [];

export type OrderStatusTone = "neutral" | "mint" | "amber" | "red" | "grey";

/** Maps an order status to a palette tone used by the status pill. */
export function orderStatusToTone(status: WerkstattOrderStatus): OrderStatusTone {
  switch (status) {
    case "draft":
      return "grey";
    case "sent":
      return "amber";
    case "confirmed":
    case "partially_delivered":
      return "amber";
    case "delivered":
      return "mint";
    case "cancelled":
      return "red";
  }
}

export function orderStatusLabel(
  status: WerkstattOrderStatus,
  de: boolean,
): string {
  switch (status) {
    case "draft":
      return de ? "Entwurf" : "Draft";
    case "sent":
      return de ? "Versendet" : "Sent";
    case "confirmed":
      return de ? "Bestätigt" : "Confirmed";
    case "partially_delivered":
      return de ? "Teilgeliefert" : "Partial";
    case "delivered":
      return de ? "Geliefert" : "Delivered";
    case "cancelled":
      return de ? "Storniert" : "Cancelled";
  }
}

/* ── Pure date + money utilities (kept; no placeholder content) ─────── */

const MS_PER_DAY = 86_400_000;

export function daysSinceIso(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor((nowMs - parsed.getTime()) / MS_PER_DAY);
}

export function orderOverdueDays(order: MockOrder, nowMs: number): number | null {
  if (order.status === "delivered" || order.status === "cancelled") return null;
  const diff = daysSinceIso(order.expected_delivery_at, nowMs);
  if (diff === null) return null;
  return diff > 0 ? diff : 0;
}

export type DeliveryTone = "neutral" | "amber" | "red" | "mint";

export function deliveryLabel(
  order: MockOrder,
  de: boolean,
  nowMs: number,
): { text: string; tone: DeliveryTone } {
  if (order.status === "delivered" && order.delivered_at) {
    const ago = daysSinceIso(order.delivered_at, nowMs) ?? 0;
    return {
      text: ago === 0
        ? de ? "heute geliefert" : "delivered today"
        : de ? `vor ${ago} Tagen geliefert` : `delivered ${ago}d ago`,
      tone: "mint",
    };
  }
  if (!order.expected_delivery_at) {
    return { text: de ? "kein Termin" : "no ETA", tone: "neutral" };
  }
  const diff = daysSinceIso(order.expected_delivery_at, nowMs);
  if (diff === null) return { text: "—", tone: "neutral" };
  if (diff > 0) {
    return {
      text: de
        ? `überfällig ${diff} Tag${diff === 1 ? "" : "e"}`
        : `${diff}d overdue`,
      tone: "red",
    };
  }
  if (diff === 0) return { text: de ? "heute" : "today", tone: "amber" };
  const inDays = Math.abs(diff);
  return {
    text: de ? `in ${inDays} Tag${inDays === 1 ? "" : "en"}` : `in ${inDays}d`,
    tone: "neutral",
  };
}

export function formatMoney(cents: number | null, currency: string): string {
  if (cents === null) return "—";
  return (cents / 100).toLocaleString(
    currency === "EUR" ? "de-DE" : "en-US",
    { style: "currency", currency, maximumFractionDigits: 2 },
  );
}

export function shortDate(iso: string | null, de: boolean): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(de ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
}

export function canMarkSent(status: WerkstattOrderStatus): boolean {
  return status === "draft";
}

export function canMarkDelivered(status: WerkstattOrderStatus): boolean {
  return (
    status === "sent" ||
    status === "confirmed" ||
    status === "partially_delivered"
  );
}

export interface OrdersFilterChip {
  key: OrdersFilterKey;
  label_de: string;
  label_en: string;
}

/** Filter-chip config (UI metadata, not demo data). */
export const ORDERS_FILTER_CHIPS: ReadonlyArray<OrdersFilterChip> = [
  { key: "all", label_de: "Alle", label_en: "All" },
  { key: "draft", label_de: "Entwurf", label_en: "Draft" },
  { key: "sent", label_de: "Versendet", label_en: "Sent" },
  { key: "in_transit", label_de: "Unterwegs", label_en: "In transit" },
  { key: "overdue", label_de: "Überfällig", label_en: "Overdue" },
  { key: "delivered", label_de: "Geliefert", label_en: "Delivered" },
];

/* ─────────────────────────────────────────────────────────────────────
   Mobile Werkstatt fixtures (now empty)
   ──────────────────────────────────────────────────────────────────── */

export type MobileCheckoutStatus = "on_site" | "overdue";

export type MockMobileCheckout = {
  id: string;
  article_id: number;
  article_number: string;
  item_name: string;
  quantity: number;
  since_de: string;
  since_en: string;
  project_label: string;
  status: MobileCheckoutStatus;
};

export const MOCK_MOBILE_CHECKOUTS: ReadonlyArray<MockMobileCheckout> = [];

export const MOCK_MOBILE_BELOW_MIN_COUNT = 0;
export const MOCK_MOBILE_SUPPLIER_COUNT = 0;

export const MOCK_MOBILE_RECENT_SCANS: ReadonlyArray<string> = [];

export type MobileReorderSeverity = "out" | "low";

export type MockMobileReorderLine = {
  id: string;
  article_id: number;
  article_number: string;
  item_name: string;
  unit_price_label: string;
  current_stock: number;
  stock_min: number;
  severity: MobileReorderSeverity;
  suggested_quantity: number;
  line_total_label: string;
};

export type MockMobileReorderGroup = {
  id: string;
  supplier_id: number;
  supplier_name: string;
  article_count: number;
  lead_time_label_de: string;
  lead_time_label_en: string;
  subtotal_label: string;
  expanded: boolean;
  lines: ReadonlyArray<MockMobileReorderLine>;
};

export const MOCK_MOBILE_REORDER_GROUPS: ReadonlyArray<MockMobileReorderGroup> = [];

export const MOCK_MOBILE_REORDER_TOTAL_LABEL = "";
export const MOCK_MOBILE_REORDER_TOTAL_ITEMS = 0;

export type MockMobileArticleMovement = {
  id: string;
  kind: "checkout" | "return" | "inspection";
  title_de: string;
  title_en: string;
  subtitle_de: string;
  subtitle_en: string;
};

export type MockMobileArticleDetail = {
  article_id: number;
  article_number: string;
  item_name: string;
  category_name: string;
  location_name: string;
  location_address: string;
  stock_available: number;
  stock_out: number;
  stock_total: number;
  next_expected_delivery_at: string | null;
  total_movements: number;
  movements: ReadonlyArray<MockMobileArticleMovement>;
};

/** Empty placeholder — mobile Artikel-Detail renders "no article selected"
 *  guard when the real payload isn't available. */
export const MOCK_MOBILE_ARTICLE_DETAIL: MockMobileArticleDetail = {
  article_id: 0,
  article_number: "",
  item_name: "",
  category_name: "",
  location_name: "",
  location_address: "",
  stock_available: 0,
  stock_out: 0,
  stock_total: 0,
  next_expected_delivery_at: null,
  total_movements: 0,
  movements: [],
};

/* ─────────────────────────────────────────────────────────────────────
   Nachbestellen (Bestell-Bericht) — now empty
   ──────────────────────────────────────────────────────────────────── */

export type NachbestellSeverity = "low" | "out";

export interface NachbestellLine {
  id: string;
  item_name: string;
  article_no: string;
  supplier_article_no: string;
  stock_label: string;
  severity: NachbestellSeverity;
  unit_label: string;
  suggested_quantity: number;
  unit_price_cents: number;
}

export interface NachbestellGroup {
  id: string;
  supplier_id: string;
  supplier_name: string;
  supplier_category_de: string;
  supplier_category_en: string;
  lead_time_days_label: string;
  contact_email: string;
  subtotal_cents: number;
  lines: ReadonlyArray<NachbestellLine>;
}

export const MOCK_NACHBESTELL_GROUPS: ReadonlyArray<NachbestellGroup> = [];

/* ─────────────────────────────────────────────────────────────────────
   On-site (Auf Baustelle) — now empty
   ──────────────────────────────────────────────────────────────────── */

export type OnSiteItemStatus = "on_site" | "due_today" | "due_soon" | "overdue";

export interface OnSiteItem {
  id: string;
  article_name: string;
  article_no: string;
  quantity: number;
  assignee_name: string;
  assignee_initials: string;
  expected_return_iso: string | null;
  expected_return_label_de: string;
  expected_return_label_en: string;
  checked_out_label_de: string;
  checked_out_label_en: string;
  status: OnSiteItemStatus;
}

export interface OnSiteProject {
  id: string;
  project_number: string;
  project_title: string;
  site_city: string;
  customer_short: string;
  items: ReadonlyArray<OnSiteItem>;
}

export const MOCK_ON_SITE_PROJECTS: ReadonlyArray<OnSiteProject> = [];
