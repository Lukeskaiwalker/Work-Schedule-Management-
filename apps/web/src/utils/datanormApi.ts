// Real API client for the Werkstatt Datanorm import.
//
// Endpoints (mounted at /api/werkstatt/* by workflow_werkstatt_desktop.py):
//   GET    /werkstatt/suppliers                  → listSuppliers
//   POST   /werkstatt/datanorm/upload (multipart) → previewUpload
//   POST   /werkstatt/datanorm/commit            → commitImport
//   GET    /werkstatt/datanorm/history           → listHistory
//
// The backend enforces `werkstatt:manage` on upload / commit / history. Read
// of suppliers only needs an authenticated user.

import { API_BASE, apiFetch, ApiError } from "../api/client";

/* ── Suppliers ─────────────────────────────────────────────────────── */

export type WerkstattSupplier = {
  id: number;
  name: string;
  short_name: string | null;
  contact_person: string | null;
  email: string | null;
  order_email: string | null;
  phone: string | null;
  default_lead_time_days: number | null;
  is_archived: boolean;
  article_count: number;
};

export async function listSuppliers(
  token: string | null,
  includeArchived = false,
): Promise<WerkstattSupplier[]> {
  const qs = includeArchived ? "?include_archived=true" : "";
  return apiFetch<WerkstattSupplier[]>(`/werkstatt/suppliers${qs}`, token);
}

/* ── Datanorm types (mirror schemas/werkstatt.py §10) ──────────────── */

export type DatanormSampleRow = {
  article_no: string;
  item_name: string;
  ean: string | null;
  manufacturer: string | null;
  price_text: string | null;
};

export type DatanormEanConflict = {
  ean: string;
  item_name: string;
  existing_supplier_id: number;
  existing_supplier_name: string;
  existing_article_no: string | null;
};

export type DatanormImportPreview = {
  import_token: string;
  supplier_id: number;
  supplier_name: string;
  filename: string;
  file_size_bytes: number;
  detected_version: string | null;
  detected_encoding: string | null;
  total_rows: number;
  rows_new: number;
  rows_updated: number;
  rows_unchanged: number;
  ean_conflicts: DatanormEanConflict[];
  sample_rows: DatanormSampleRow[];
  uploaded_at: string;
  expires_at: string;
};

export type DatanormImportStatus = "pending" | "in_progress" | "succeeded" | "failed";

export type DatanormImportRecord = {
  id: number;
  supplier_id: number;
  supplier_name: string;
  filename: string;
  status: DatanormImportStatus;
  total_rows: number;
  rows_new: number;
  rows_updated: number;
  rows_failed: number;
  started_at: string;
  finished_at: string | null;
  error_message: string | null;
  created_by: number | null;
  created_by_name: string | null;
};

/* ── Upload / commit / history ─────────────────────────────────────── */

/**
 * Multipart POST the raw Datanorm file. Uses plain `fetch` directly because
 * `apiFetch` forces `Content-Type: application/json` except when the body is
 * FormData — which it is here — but we also need to preserve the same error
 * handling path.
 */
export async function previewUpload(
  token: string | null,
  supplierId: number,
  file: File,
): Promise<DatanormImportPreview> {
  const form = new FormData();
  form.append("supplier_id", String(supplierId));
  form.append("file", file);

  const response = await fetch(`${API_BASE}/werkstatt/datanorm/upload`, {
    method: "POST",
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });

  if (!response.ok) {
    let detail: unknown = response.statusText;
    let body: unknown = null;
    try {
      const data = await response.json();
      body = data;
      detail = data.detail ?? detail;
    } catch {
      // response had no JSON body
    }
    const message =
      typeof detail === "string"
        ? detail
        : response.statusText || `HTTP ${response.status}`;
    throw new ApiError(message, response.status, detail, body);
  }
  return response.json() as Promise<DatanormImportPreview>;
}

export async function commitImport(
  token: string | null,
  importToken: string,
  replaceMode = true,
): Promise<DatanormImportRecord> {
  return apiFetch<DatanormImportRecord>(`/werkstatt/datanorm/commit`, token, {
    method: "POST",
    body: JSON.stringify({ import_token: importToken, replace_mode: replaceMode }),
  });
}

export async function listHistory(
  token: string | null,
): Promise<DatanormImportRecord[]> {
  return apiFetch<DatanormImportRecord[]>(`/werkstatt/datanorm/history`, token);
}

/* ── Legacy reassignment ───────────────────────────────────────────── */

export type DatanormReassignResult = {
  reassigned: number;
  supplier_id: number;
  supplier_name: string;
  audit_id: number | null;
};

export async function fetchUnassignedCount(
  token: string | null,
): Promise<number> {
  const res = await apiFetch<{ count: number }>(
    `/werkstatt/datanorm/unassigned-count`,
    token,
  );
  return res.count;
}

export async function reassignLegacy(
  token: string | null,
  supplierId: number,
): Promise<DatanormReassignResult> {
  return apiFetch<DatanormReassignResult>(
    `/werkstatt/datanorm/reassign-legacy`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ supplier_id: supplierId }),
    },
  );
}
