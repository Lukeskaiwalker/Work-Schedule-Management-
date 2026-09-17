/**
 * Presentation helpers for Bestellungen — money, dates, status tones, filters.
 *
 * These are pure functions typed against the real `/api/werkstatt/orders`
 * shapes. They used to live in `components/werkstatt/mockData.ts` because that
 * is where they were first written, beside the fixtures; the fixtures are gone
 * and the module is being deleted, so they move here rather than disappear.
 * Nothing in this file has ever been demo data.
 */
import type { WerkstattOrderStatus } from "../../types/werkstatt";

/**
 * The slice of an order these helpers actually read.
 *
 * Typed structurally rather than as the full `WerkstattOrder` so the list
 * (which receives summaries) and the drawer (which receives whole orders) can
 * share one set of helpers. The alternative was a cast at every call site,
 * which would have compiled just as happily on an object missing the fields.
 */
export interface OrderTiming {
  status: WerkstattOrderStatus;
  expected_delivery_at: string | null;
  delivered_at: string | null;
}

export type OrdersFilterKey =
  | "all"
  | "draft"
  | "sent"
  | "in_transit"
  | "overdue"
  | "delivered";

export function orderMatchesFilter(
  order: Pick<OrderTiming, "status">,
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

/* ── Pure date + money utilities ────────────────────────────────────── */

const MS_PER_DAY = 86_400_000;

export function daysSinceIso(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor((nowMs - parsed.getTime()) / MS_PER_DAY);
}

export function orderOverdueDays(order: OrderTiming, nowMs: number): number | null {
  if (order.status === "delivered" || order.status === "cancelled") return null;
  const diff = daysSinceIso(order.expected_delivery_at, nowMs);
  if (diff === null) return null;
  return diff > 0 ? diff : 0;
}

export type DeliveryTone = "neutral" | "amber" | "red" | "mint";

export function deliveryLabel(
  order: OrderTiming,
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
