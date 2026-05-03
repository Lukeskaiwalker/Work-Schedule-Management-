// API client for the v2.4.0 ProjectLineItem endpoints.
//
// Two backends behind this single module:
//   - Manual CRUD:        apps/api/app/routers/workflow_line_items.py
//   - LLM extraction:     apps/api/app/routers/workflow_line_items_extract.py
//
// Permission: projects:manage on every mutation; list/get require auth only.

import { apiFetch } from "../api/client";
import type {
  ExtractionConfirmItem,
  ExtractionConfirmResult,
  LineItemExtractionDocType,
  LineItemExtractionEnqueueResponse,
  LineItemExtractionJob,
  ProjectLineItem,
  ProjectLineItemCreate,
  ProjectLineItemUpdate,
} from "../types";


export async function listProjectLineItems(
  token: string | null,
  projectId: number,
  includeInactive = false,
): Promise<ProjectLineItem[]> {
  const qs = includeInactive ? "?include_inactive=true" : "";
  return apiFetch<ProjectLineItem[]>(
    `/projects/${projectId}/line-items${qs}`,
    token,
  );
}


export async function getProjectLineItem(
  token: string | null,
  projectId: number,
  itemId: number,
): Promise<ProjectLineItem> {
  return apiFetch<ProjectLineItem>(
    `/projects/${projectId}/line-items/${itemId}`,
    token,
  );
}


export async function createProjectLineItem(
  token: string | null,
  projectId: number,
  payload: ProjectLineItemCreate,
): Promise<ProjectLineItem> {
  return apiFetch<ProjectLineItem>(
    `/projects/${projectId}/line-items`,
    token,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}


export async function updateProjectLineItem(
  token: string | null,
  projectId: number,
  itemId: number,
  payload: ProjectLineItemUpdate,
): Promise<ProjectLineItem> {
  return apiFetch<ProjectLineItem>(
    `/projects/${projectId}/line-items/${itemId}`,
    token,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}


export async function softDeleteProjectLineItem(
  token: string | null,
  projectId: number,
  itemId: number,
): Promise<{ ok: boolean; id: number; soft_deleted: boolean }> {
  return apiFetch<{ ok: boolean; id: number; soft_deleted: boolean }>(
    `/projects/${projectId}/line-items/${itemId}`,
    token,
    { method: "DELETE" },
  );
}


// ── v2.4.0 LLM extraction ─────────────────────────────────────────────────


/** Enqueue an extraction job. Exactly one of `file` or `emailText` must
 *  be provided. The backend handles the XOR validation; we just pack
 *  whichever is set into the multipart form. */
export async function enqueueLineItemExtraction(
  token: string | null,
  projectId: number,
  args: {
    docType: LineItemExtractionDocType;
    file?: File;
    emailText?: string;
  },
): Promise<LineItemExtractionEnqueueResponse> {
  const form = new FormData();
  form.append("doc_type", args.docType);
  if (args.file) {
    form.append("file", args.file);
  } else if (args.emailText !== undefined) {
    form.append("email_text", args.emailText);
  }
  return apiFetch<LineItemExtractionEnqueueResponse>(
    `/projects/${projectId}/line-items/extract`,
    token,
    {
      method: "POST",
      body: form,
    },
  );
}


export async function getLineItemExtractionJob(
  token: string | null,
  projectId: number,
  jobId: number,
): Promise<LineItemExtractionJob> {
  return apiFetch<LineItemExtractionJob>(
    `/projects/${projectId}/line-items/extract/${jobId}`,
    token,
  );
}


export async function listLineItemExtractionJobs(
  token: string | null,
  projectId: number,
): Promise<LineItemExtractionJob[]> {
  return apiFetch<LineItemExtractionJob[]>(
    `/projects/${projectId}/line-items/extract`,
    token,
  );
}


/** Confirm an operator-reviewed extraction job — creates real
 *  ProjectLineItem rows from the (possibly edited) items array. */
export async function confirmLineItemExtraction(
  token: string | null,
  projectId: number,
  jobId: number,
  items: ExtractionConfirmItem[],
): Promise<ExtractionConfirmResult> {
  return apiFetch<ExtractionConfirmResult>(
    `/projects/${projectId}/line-items/extract/${jobId}/confirm`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ items }),
    },
  );
}
