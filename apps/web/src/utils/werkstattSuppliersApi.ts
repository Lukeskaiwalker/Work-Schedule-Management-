// API client for the Werkstatt supplier CRUD endpoints.
//
// Backend lives in apps/api/app/routers/workflow_werkstatt_suppliers.py and is
// gated by `werkstatt:manage` for every mutation. The list endpoint only
// requires an authenticated user.
//
// Endpoints:
//   GET    /werkstatt/suppliers?include_archived=...  → listSuppliers
//   POST   /werkstatt/suppliers                       → createSupplier
//   PATCH  /werkstatt/suppliers/{id}                  → updateSupplier
//   DELETE /werkstatt/suppliers/{id}                  → archiveSupplier (soft)
//
// The canonical `WerkstattSupplier` type lives in `types/werkstatt.ts`. The
// older duplicated type in `utils/datanormApi.ts` is intentionally untouched
// here — it's bound to the Datanorm dropdown and only needs a subset of fields.

import { apiFetch } from "../api/client";
import type { WerkstattSupplier, WerkstattSupplierCreate } from "../types/werkstatt";


/** Partial-update payload. Every field is optional; pass only what changes.
 *  `is_archived` is included so the same endpoint covers unarchive flows. */
export type WerkstattSupplierUpdate = Partial<WerkstattSupplierCreate> & {
  is_archived?: boolean;
};


export async function listSuppliers(
  token: string | null,
  includeArchived = false,
): Promise<WerkstattSupplier[]> {
  const qs = includeArchived ? "?include_archived=true" : "";
  return apiFetch<WerkstattSupplier[]>(`/werkstatt/suppliers${qs}`, token);
}


export async function createSupplier(
  token: string | null,
  payload: WerkstattSupplierCreate,
): Promise<WerkstattSupplier> {
  return apiFetch<WerkstattSupplier>(`/werkstatt/suppliers`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}


export async function updateSupplier(
  token: string | null,
  id: number,
  patch: WerkstattSupplierUpdate,
): Promise<WerkstattSupplier> {
  return apiFetch<WerkstattSupplier>(`/werkstatt/suppliers/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}


/** Soft-archive (sets `is_archived=true`). The backend keeps the row so
 *  historical orders that reference the supplier still resolve. */
export async function archiveSupplier(
  token: string | null,
  id: number,
): Promise<void> {
  await apiFetch<void>(`/werkstatt/suppliers/${id}`, token, {
    method: "DELETE",
  });
}
