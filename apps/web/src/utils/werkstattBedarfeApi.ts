// API client for Werkstatt › Projekt-Bedarfe.
//
// Backends:
//   apps/api/app/routers/workflow_werkstatt_bedarfe.py  (list, bulk, order)
//   apps/api/app/routers/workflow_materials.py          (create, patch, delete)
//
// Gating, as enforced server-side:
//   read / edit / bulk   → project visibility (an employee sees their sites)
//   create-order         → `werkstatt:manage` (it spends money)
//
// The page owns this data rather than AppContext: it is the only screen that
// reads it, it needs server-side filtering to stay usable at a few hundred
// rows, and a global cache would go stale the moment a second person edits a
// row — the previous arrangement, where the list came from App state and only
// refreshed on a manual click.

import { apiFetch } from "../api/client";
import type { MaterialCatalogItem, MaterialNeedStatus, ProjectMaterialNeed } from "../types";
import type {
  MaterialNeedFilters,
  MaterialNeedOrderRequest,
  MaterialNeedOrderResult,
  MaterialNeedPatch,
  MaterialNeedRow,
} from "../types/materialNeeds";

function buildQuery(filters: MaterialNeedFilters): string {
  const params = new URLSearchParams();
  if (filters.statuses && filters.statuses.length > 0) {
    params.set("status", filters.statuses.join(","));
  }
  if (filters.projectId != null) params.set("project_id", String(filters.projectId));
  // Either a real id or the "none" sentinel — String() carries both.
  if (filters.supplierId != null) params.set("supplier_id", String(filters.supplierId));
  const needle = (filters.q ?? "").trim();
  if (needle) params.set("q", needle);
  if (filters.includeCompleted) params.set("include_completed", "true");
  if (filters.orderableOnly) params.set("orderable_only", "true");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function listBedarfe(
  token: string | null,
  filters: MaterialNeedFilters = {},
  signal?: AbortSignal,
): Promise<MaterialNeedRow[]> {
  return apiFetch<MaterialNeedRow[]>(`/werkstatt/bedarfe${buildQuery(filters)}`, token, {
    signal,
  });
}

/**
 * Patch one need. The server answers with the fresh row, which the page puts
 * back in place — there is no optimistic lock here (nor anywhere else in the
 * app), so the last writer wins and the page shows what actually landed.
 */
export async function updateNeed(
  token: string | null,
  needId: number,
  patch: MaterialNeedPatch,
): Promise<MaterialNeedRow> {
  return apiFetch<MaterialNeedRow>(`/materials/${needId}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteNeed(token: string | null, needId: number): Promise<void> {
  await apiFetch<void>(`/materials/${needId}`, token, { method: "DELETE" });
}

export interface CreateNeedInput {
  project_id: number;
  item?: string | null;
  material_catalog_item_id?: number | null;
  quantity?: string | null;
  unit?: string | null;
  article_no?: string | null;
  /** Why it is needed. Written with the row, not in a second PATCH. */
  notes?: string | null;
}

export async function createNeed(
  token: string | null,
  payload: CreateNeedInput,
): Promise<ProjectMaterialNeed> {
  return apiFetch<ProjectMaterialNeed>(`/materials`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Set one status (and/or note) on a whole selection, in one transaction. */
export async function bulkUpdateNeeds(
  token: string | null,
  ids: readonly number[],
  patch: { status?: MaterialNeedStatus; notes?: string },
): Promise<MaterialNeedRow[]> {
  return apiFetch<MaterialNeedRow[]>(`/werkstatt/bedarfe/bulk`, token, {
    method: "POST",
    body: JSON.stringify({ ids: [...ids], ...patch }),
  });
}

export async function bulkDeleteNeeds(
  token: string | null,
  ids: readonly number[],
): Promise<{ deleted: number }> {
  return apiFetch<{ deleted: number }>(`/werkstatt/bedarfe/bulk-delete`, token, {
    method: "POST",
    body: JSON.stringify({ ids: [...ids] }),
  });
}

/**
 * Draft one order per supplier from the selection.
 *
 * Always a draft: the result opens in Werkstatt › Bestellungen where the
 * pre-send resolution gate checks every position before anything is handed to
 * a wholesaler.
 */
export async function createOrderFromNeeds(
  token: string | null,
  payload: MaterialNeedOrderRequest,
): Promise<MaterialNeedOrderResult> {
  return apiFetch<MaterialNeedOrderResult>(`/werkstatt/bedarfe/create-order`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Datanorm rows matching free text, for the "link a catalogue article" pickers.
 *
 * Server-side search against a pool of hundreds of thousands of rows — never
 * filtered client-side, because the page only ever holds one page of it.
 */
export async function searchCatalogItems(
  token: string | null,
  q: string,
  signal?: AbortSignal,
  limit = 20,
): Promise<MaterialCatalogItem[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return apiFetch<MaterialCatalogItem[]>(`/materials/catalog?${params.toString()}`, token, {
    signal,
  });
}
