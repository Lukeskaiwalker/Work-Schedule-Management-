// API client for Werkstatt categories and storage locations (Lagerorte).
//
// Backend: apps/api/app/routers/workflow_werkstatt_taxonomy.py
//   GET    /werkstatt/categories?include_archived=…  → listCategories
//   POST   /werkstatt/categories                     → createCategory
//   PATCH  /werkstatt/categories/{id}                → updateCategory
//   DELETE /werkstatt/categories/{id}                → archiveCategory (soft)
//   GET    /werkstatt/locations?include_archived=…   → listLocations
//   POST   /werkstatt/locations                      → createLocation
//   PATCH  /werkstatt/locations/{id}                 → updateLocation
//   DELETE /werkstatt/locations/{id}                 → archiveLocation (soft)
//
// Reads need only an authenticated user; every mutation requires
// `werkstatt:manage`.
//
// DELETE is a soft archive on both. Nothing is ever really removed: a location
// still referenced by a machine's `current_location_id`, or a category by an
// article, has to keep resolving to a name or historical rows render as blanks.

import { apiFetch } from "../api/client";
import type {
  WerkstattCategory,
  WerkstattLocation,
  WerkstattLocationStatus,
  WerkstattLocationType,
} from "../types/werkstatt";

export interface WerkstattCategoryCreate {
  name: string;
  parent_id?: number | null;
  display_order?: number;
  icon_key?: string | null;
  notes?: string | null;
}

export type WerkstattCategoryUpdate = Partial<WerkstattCategoryCreate> & {
  is_archived?: boolean;
};

export interface WerkstattLocationCreate {
  name: string;
  location_type: WerkstattLocationType;
  parent_id?: number | null;
  address?: string | null;
  status?: WerkstattLocationStatus | null;
  display_order?: number;
  notes?: string | null;
}

export type WerkstattLocationUpdate = Partial<WerkstattLocationCreate> & {
  is_archived?: boolean;
};

function archivedQuery(includeArchived: boolean): string {
  return includeArchived ? "?include_archived=true" : "";
}

/* ── Categories ────────────────────────────────────────────────────────── */

export async function listCategories(
  token: string | null,
  includeArchived = false,
): Promise<WerkstattCategory[]> {
  return apiFetch<WerkstattCategory[]>(
    `/werkstatt/categories${archivedQuery(includeArchived)}`,
    token,
  );
}

export async function createCategory(
  token: string | null,
  payload: WerkstattCategoryCreate,
): Promise<WerkstattCategory> {
  return apiFetch<WerkstattCategory>(`/werkstatt/categories`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateCategory(
  token: string | null,
  id: number,
  patch: WerkstattCategoryUpdate,
): Promise<WerkstattCategory> {
  return apiFetch<WerkstattCategory>(`/werkstatt/categories/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function archiveCategory(
  token: string | null,
  id: number,
): Promise<WerkstattCategory> {
  return apiFetch<WerkstattCategory>(`/werkstatt/categories/${id}`, token, {
    method: "DELETE",
  });
}

/** Bring an archived category back. The API models this as a plain PATCH. */
export async function unarchiveCategory(
  token: string | null,
  id: number,
): Promise<WerkstattCategory> {
  return updateCategory(token, id, { is_archived: false });
}

/* ── Locations ─────────────────────────────────────────────────────────── */

export async function listLocations(
  token: string | null,
  includeArchived = false,
): Promise<WerkstattLocation[]> {
  return apiFetch<WerkstattLocation[]>(
    `/werkstatt/locations${archivedQuery(includeArchived)}`,
    token,
  );
}

export async function createLocation(
  token: string | null,
  payload: WerkstattLocationCreate,
): Promise<WerkstattLocation> {
  return apiFetch<WerkstattLocation>(`/werkstatt/locations`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateLocation(
  token: string | null,
  id: number,
  patch: WerkstattLocationUpdate,
): Promise<WerkstattLocation> {
  return apiFetch<WerkstattLocation>(`/werkstatt/locations/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function archiveLocation(
  token: string | null,
  id: number,
): Promise<WerkstattLocation> {
  return apiFetch<WerkstattLocation>(`/werkstatt/locations/${id}`, token, {
    method: "DELETE",
  });
}

export async function unarchiveLocation(
  token: string | null,
  id: number,
): Promise<WerkstattLocation> {
  return updateLocation(token, id, { is_archived: false });
}
