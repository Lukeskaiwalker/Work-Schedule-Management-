// API client for the v2.4.0 ProjectLineItem CRUD endpoints (manual path).
// The LLM extraction endpoints will be added here in a follow-up commit
// alongside the importer UI — keeping this file focused on the manual
// path for the foundation release.
//
// Backend: apps/api/app/routers/workflow_line_items.py
// Permission: projects:manage on every mutation; list/get require auth only.

import { apiFetch } from "../api/client";
import type {
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
