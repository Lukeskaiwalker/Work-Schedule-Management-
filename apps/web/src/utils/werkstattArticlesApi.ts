// API client for the Werkstatt stock (Bestand) endpoints.
//
// Backend lives in apps/api/app/routers/workflow_werkstatt_articles.py.
//
//   GET /werkstatt/articles → listArticles
//
// Filtering is done server-side wherever the backend already supports it
// (category, location, stock status, free text) rather than fetching
// everything and filtering in the browser: the catalogue is a million Datanorm
// rows deep and the article table grows with every stock-take, so "just load
// them all" stops working quietly rather than loudly.

import { apiFetch } from "../api/client";
import type { WerkstattArticleSupplier } from "../types/werkstatt";

/** Mirrors WerkstattStockStatus in apps/api/app/schemas/werkstatt.py. */
export type WerkstattStockStatus = "available" | "low" | "empty" | "out" | "unavailable";

/** Mirrors WerkstattArticleLiteOut. */
export interface WerkstattArticleLite {
  /** The barcode we printed ourselves, when the article has no manufacturer one. */
  internal_code?: string | null;
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
  /** How this article is counted: "Stk", "m", "Rolle", "Pack". Every place
   *  that prints one of its counters prints this beside it, so a drum of cable
   *  is not silently quoted in pieces. Null for articles that carry no unit;
   *  see `unitLabel` for the per-language fallback. */
  unit: string | null;
  /** What the supplier named by `supplierId` or `annotateSupplierId` calls
   *  this article. Null (or absent) otherwise — the question has no answer
   *  without a supplier, and null under one means "no link yet". */
  supplier_article_no?: string | null;
}

export interface ArticleListOptions {
  q?: string;
  categoryId?: number | null;
  locationId?: number | null;
  /** Only articles linked to this supplier, each with its number. */
  supplierId?: number | null;
  /** Every matching article, each with THIS supplier's number where a link
   *  exists — the order picker's question, which must still surface the
   *  stocked article that has no link yet. */
  annotateSupplierId?: number | null;
  status?: WerkstattStockStatus | null;
  includeArchived?: boolean;
  limit?: number;
}

export async function listArticles(
  token: string | null,
  options: ArticleListOptions = {},
): Promise<WerkstattArticleLite[]> {
  const params = new URLSearchParams();
  if (options.q) params.set("q", options.q);
  if (options.categoryId != null) params.set("category_id", String(options.categoryId));
  if (options.locationId != null) params.set("location_id", String(options.locationId));
  if (options.supplierId != null) params.set("supplier_id", String(options.supplierId));
  if (options.annotateSupplierId != null) {
    params.set("annotate_supplier_id", String(options.annotateSupplierId));
  }
  if (options.status) params.set("status", options.status);
  if (options.includeArchived) params.set("include_archived", "true");
  if (options.limit != null) params.set("limit", String(options.limit));
  const qs = params.toString();
  return apiFetch<WerkstattArticleLite[]>(`/werkstatt/articles${qs ? `?${qs}` : ""}`, token);
}


/* ─────────────────────────────────────────────────────────────────────
   Stock write paths
   ──────────────────────────────────────────────────────────────────── */

/**
 * The article snapshot both write paths return.
 *
 * Deliberately narrower than the endpoints' real response bodies: checkout
 * answers with `WerkstattArticleOut` (~30 fields) and the movements endpoint
 * with the updated article too. Typing only what this UI reads back means a
 * field being added or renamed elsewhere in that payload cannot break the
 * build, and the counters — the part that has to be right — stay checked.
 *
 * Every counter here is DERIVED by the server from the movement ledger. The
 * browser must never compute a new stock figure and store it; it displays what
 * came back, or it refetches.
 */
export interface WerkstattArticleStockSnapshot {
  id: number;
  stock_total: number;
  stock_available: number;
  stock_status: WerkstattStockStatus;
  /** Present on `WerkstattArticleOut` (checkout), absent from the list-row
   *  payload the movements endpoint answers with. */
  unit?: string | null;
}

/** The three adjustments "Bestand anpassen" offers. */
export type StockAdjustmentKind = "intake" | "defect" | "inventory";

/**
 * Mirrors `WerkstattStockAdjustPayload` in apps/api/app/schemas/werkstatt.py.
 *
 * Two shapes, because the dialog has two. `intake` and `defect` are RELATIVE
 * and send a positive `quantity`; `inventory` is ABSOLUTE and sends
 * `target_total`, the number somebody actually counted on the shelf. The
 * server subtracts the article's current total itself, so a checkout booked
 * while the dialog was open cannot compound with a delta the browser worked
 * out from a stale figure. A union rather than one optional-everything object:
 * sending `quantity` for a stock-take is then not expressible.
 */
export type StockAdjustmentInput =
  | {
      kind: "intake" | "defect";
      /** Pieces that arrived or were written off. Always positive — the kind
       *  carries the direction. */
      quantity: number;
      reason: string;
      expectedTotal?: number;
    }
  | {
      kind: "inventory";
      /** The counted total, not a delta. */
      targetTotal: number;
      reason: string;
      expectedTotal?: number;
    };

/**
 * Book a manual stock adjustment — the single entry point for the
 * "Bestand anpassen" dialog.
 *
 * The server maps `kind` onto a ledger movement (`intake`, `inventory_plus`,
 * `inventory_minus`) and recomputes the article's counters from the ledger.
 * The UI neither chooses the movement type nor stores the arithmetic it
 * previews: the row that comes back is the truth.
 *
 * `expectedTotal` is the opt-in optimistic lock. Passing the total the dialog
 * displayed turns "somebody moved this stock while you were typing" into a
 * 409 naming both numbers, instead of a booking against a figure the user
 * never saw — which is the failure the workshop reported from the other side.
 *
 * Kept as ONE function on purpose: this is the only place the request shape of
 * `POST /werkstatt/articles/{id}/movements` is written down, so a contract
 * change is a single edit.
 */
export async function adjustArticleStock(
  token: string | null,
  articleId: number,
  input: StockAdjustmentInput,
): Promise<WerkstattArticleStockSnapshot> {
  const body =
    input.kind === "inventory"
      ? { kind: input.kind, target_total: input.targetTotal, reason: input.reason }
      : { kind: input.kind, quantity: input.quantity, reason: input.reason };
  return apiFetch<WerkstattArticleStockSnapshot>(
    `/werkstatt/articles/${articleId}/movements`,
    token,
    {
      method: "POST",
      body: JSON.stringify(
        input.expectedTotal == null ? body : { ...body, expected_total: input.expectedTotal },
      ),
    },
  );
}

export interface CheckoutInput {
  articleId: number;
  /** Pieces to take out; the server rejects more than `stock_available`. */
  quantity: number;
  projectId: number | null;
  /** ISO 8601, or null when no return date was picked. */
  expectedReturnAt: string | null;
  notes: string | null;
}

/**
 * Check stock out of the workshop.
 *
 * Mirrors `CheckoutPayload` in apps/api/app/schemas/werkstatt.py. `assignee_user_id`
 * is omitted, which the endpoint reads as "the caller is taking it themselves" —
 * the desktop inventory list has no one else to assign to.
 */
export async function checkoutArticle(
  token: string | null,
  input: CheckoutInput,
): Promise<WerkstattArticleStockSnapshot> {
  return apiFetch<WerkstattArticleStockSnapshot>("/werkstatt/mobile/checkout", token, {
    method: "POST",
    body: JSON.stringify({
      article_id: input.articleId,
      quantity: input.quantity,
      project_id: input.projectId,
      expected_return_at: input.expectedReturnAt,
      notes: input.notes,
    }),
  });
}


export interface ArticleLabelPrintResult {
  article_id: number;
  internal_code: string;
  /** False when the article already had a code and this was a reprint. */
  minted: boolean;
  printer: string;
}

/**
 * Print a shelf label, minting the article's in-house code on first use.
 *
 * The server writes the code in the same transaction that prints it, so a
 * failed print leaves no code behind — which is why the returned code is the
 * one now physically on the shelf, not merely one that was allocated.
 */
export async function printArticleLabel(
  token: string,
  articleId: number,
): Promise<ArticleLabelPrintResult> {
  return apiFetch<ArticleLabelPrintResult>(
    `/werkstatt/articles/${articleId}/print-label`,
    token,
    { method: "POST" },
  );
}


/* ─────────────────────────────────────────────────────────────────────
   Article ↔ supplier links
   ──────────────────────────────────────────────────────────────────── */

/** Mirrors `WerkstattArticleSupplierCreate`; only what the order drawer sends. */
export interface ArticleSupplierLinkCreate {
  supplier_id: number;
  supplier_article_no?: string | null;
  typical_price_cents?: number | null;
  is_preferred?: boolean;
  source_catalog_item_id?: number | null;
  notes?: string | null;
}

export type ArticleSupplierLinkUpdate = Partial<Omit<ArticleSupplierLinkCreate, "supplier_id">>;

/**
 * Record what a supplier calls an article.
 *
 * Backend: `POST /werkstatt/articles/{id}/suppliers` in
 * workflow_werkstatt_article_suppliers.py. The link is what the resolver
 * consults first on every later order, so typing the number once from the
 * order drawer means the next order for the same article resolves without
 * asking — that is why the drawer writes here and not only onto its line.
 */
export async function addArticleSupplierLink(
  token: string | null,
  articleId: number,
  payload: ArticleSupplierLinkCreate,
): Promise<WerkstattArticleSupplier> {
  return apiFetch<WerkstattArticleSupplier>(`/werkstatt/articles/${articleId}/suppliers`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** `PATCH /werkstatt/articles/{id}/suppliers/{link_id}` — only the sent fields change. */
export async function updateArticleSupplierLink(
  token: string | null,
  articleId: number,
  linkId: number,
  patch: ArticleSupplierLinkUpdate,
): Promise<WerkstattArticleSupplier> {
  return apiFetch<WerkstattArticleSupplier>(
    `/werkstatt/articles/${articleId}/suppliers/${linkId}`,
    token,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}
