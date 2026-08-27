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
}

export interface ArticleListOptions {
  q?: string;
  categoryId?: number | null;
  locationId?: number | null;
  supplierId?: number | null;
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
  if (options.status) params.set("status", options.status);
  if (options.includeArchived) params.set("include_archived", "true");
  if (options.limit != null) params.set("limit", String(options.limit));
  const qs = params.toString();
  return apiFetch<WerkstattArticleLite[]>(`/werkstatt/articles${qs ? `?${qs}` : ""}`, token);
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
