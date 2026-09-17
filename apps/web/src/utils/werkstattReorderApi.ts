// API client for Werkstatt › Nachbestellen (desktop + mobile).
//
// Backend:
//   apps/api/app/routers/workflow_werkstatt_reorder.py
//
// Gating, as enforced server-side:
//   GET  /werkstatt/reorder/suggestions → any authenticated user
//   POST /werkstatt/reorder/submit      → `werkstatt:manage` (it spends money)
//
// The submit path AUTO-SENDS: one request creates the draft, runs the same
// pre-send resolution as the shop hand-over, and transitions the order to
// `sent`. A line whose supplier article number cannot be resolved therefore
// answers 409 `unresolved_lines` and NOTHING is created — the whole
// transaction is rolled back. The buyer's way through is `allow_unresolved`
// ("Trotzdem übergeben"), exactly as in the Bestellungen drawer; the 409
// detail is read with `unresolvedLinesConflict` from `werkstattOrdersApi`.

import { apiFetch } from "../api/client";
import type { WerkstattOrder } from "../types/werkstatt";

/** One article below its minimum stock, as the suggestion engine sees it. */
export interface ReorderSuggestionLine {
  article_id: number;
  article_number: string;
  article_name: string;
  image_url: string | null;
  stock_available: number;
  stock_min: number;
  suggested_quantity: number;
  unit: string | null;
  /** Null when the article↔supplier link carries no price — then no total. */
  unit_price_cents: number | null;
  line_total_cents: number | null;
}

/** Suggestions for one supplier. One order can only ever hold one supplier. */
export interface ReorderSuggestionGroup {
  supplier_id: number;
  supplier_name: string;
  supplier_short_name: string | null;
  default_lead_time_days: number | null;
  /** Null when not a single line in the group carries a price. */
  subtotal_cents: number | null;
  currency: string;
  lines: ReorderSuggestionLine[];
}

/** One submitted position. The server refuses `quantity` below 1. */
export interface ReorderSubmitLine {
  article_id: number;
  quantity: number;
  unit_price_cents: number | null;
}

export interface ReorderSubmitRequest {
  supplier_id: number;
  lines: ReorderSubmitLine[];
  notes: string | null;
  /** The buyer clicked "Trotzdem übergeben" on the 409. */
  allow_unresolved: boolean;
}

export async function listReorderSuggestions(
  token: string | null,
  signal?: AbortSignal,
): Promise<ReorderSuggestionGroup[]> {
  return apiFetch<ReorderSuggestionGroup[]>("/werkstatt/reorder/suggestions", token, {
    signal,
  });
}

/**
 * Create AND send one supplier's reorder. Answers the full order, or 409
 * `unresolved_lines` while a position has no supplier article number.
 */
export async function submitReorder(
  token: string | null,
  payload: ReorderSubmitRequest,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>("/werkstatt/reorder/submit", token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
