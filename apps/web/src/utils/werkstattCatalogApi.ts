// API client for the Werkstatt catalogue search.
//
// Backend: apps/api/app/routers/workflow_werkstatt_catalog.py
//   GET /werkstatt/catalog/search?q=&supplier_id=&limit=  → searchWerkstattCatalog
//
// The catalogue is the wholesaler's own Datanorm — the one place their
// article number is written down next to the EAN. The order picker searches
// it beside our own articles so a line can be added WITH the number the shop
// wants, instead of being resolved cold at submit time.

import { apiFetch } from "../api/client";
import type { WerkstattCatalogGroup } from "../types/werkstatt";

export interface CatalogSearchOptions {
  q: string;
  /** Restrict to one supplier's Datanorm — an order has exactly one. */
  supplierId?: number | null;
  limit?: number;
}

export async function searchWerkstattCatalog(
  token: string | null,
  options: CatalogSearchOptions,
): Promise<WerkstattCatalogGroup[]> {
  const params = new URLSearchParams();
  params.set("q", options.q);
  if (options.supplierId != null) params.set("supplier_id", String(options.supplierId));
  if (options.limit != null) params.set("limit", String(options.limit));
  return apiFetch<WerkstattCatalogGroup[]>(`/werkstatt/catalog/search?${params.toString()}`, token);
}
