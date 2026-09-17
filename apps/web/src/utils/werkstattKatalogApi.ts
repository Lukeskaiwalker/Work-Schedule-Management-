/**
 * API client for the Katalog page's own calls.
 *
 * The catalogue SEARCH and the supplier list already have clients
 * (`werkstattCatalogApi.ts`, `werkstattSuppliersApi.ts`) and are reused as
 * they are. What had no client at all is the per-row product image: it lived
 * only as two methods on AppContext that also rewrote the legacy
 * `/materials/catalog` rows in context state. The Katalog page no longer reads
 * those rows, so it needs the plain calls and updates its own list from the
 * answer.
 *
 * Backend: apps/api/app/routers/workflow_materials.py
 *   POST   /materials/catalog/images/{external_key}  → uploadCatalogImage
 *   DELETE /materials/catalog/images/{external_key}  → deleteCatalogImage
 *
 * Both are gated on an authenticated user only — no `werkstatt:manage` — so
 * the page offers them to everyone who can see the catalogue.
 */

import { apiFetch } from "../api/client";

/** What the upload answers with. `image_source` is always "manual" after an
 *  upload: that is the flag that stops the background scraper overwriting the
 *  picture somebody deliberately chose. */
export interface CatalogImageUploadResult {
  ok: boolean;
  external_key: string;
  image_url: string;
  image_source: string;
}

export async function uploadCatalogImage(
  token: string | null,
  externalKey: string,
  file: File,
): Promise<CatalogImageUploadResult> {
  const form = new FormData();
  form.append("file", file);
  return apiFetch<CatalogImageUploadResult>(
    `/materials/catalog/images/${encodeURIComponent(externalKey)}`,
    token,
    { method: "POST", body: form },
  );
}

/** Drops the stored picture AND the row's image state, so the automatic
 *  lookup is free to search again on its next pass. */
export async function deleteCatalogImage(
  token: string | null,
  externalKey: string,
): Promise<void> {
  await apiFetch<{ ok: boolean }>(
    `/materials/catalog/images/${encodeURIComponent(externalKey)}`,
    token,
    { method: "DELETE" },
  );
}
