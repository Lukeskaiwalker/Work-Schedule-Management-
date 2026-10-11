// Real API client for the Partner (external contractor) feature. Mirrors the
// shape of `customersApi.ts` but talks to the live backend via `apiFetch<T>`.
// The backend agent is building `/api/partners` in parallel against the
// canonical `Partner` / `PartnerListItem` shape from `types/index.ts`.
//
// Endpoint plan (coordinate with API agent):
//   GET    /partners?q=&archived=&trade=    → listPartners
//   GET    /partners/{id}                   → getPartner
//   GET    /partners/{id}/tasks             → listPartnerTasks
//   POST   /partners                        → savePartner (create)
//   PATCH  /partners/{id}                   → savePartner (update)
//   POST   /partners/{id}/archive           → archivePartner
//   POST   /partners/{id}/unarchive         → unarchivePartner

import { apiFetch } from "../api/client";
import type { Partner, PartnerHoursEntry, PartnerListItem, PartnerPortalLink, PartnerPortalUser, ProjectPartnerLink, Task } from "../types";

export type PartnerWriteInput = {
  name: string;
  contact_person?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  trade?: string | null;
  tax_id?: string | null;
  notes?: string | null;
};

function buildQuery(params: Record<string, string | boolean | null | undefined>): string {
  const entries: string[] = [];
  Object.entries(params).forEach(([key, rawValue]) => {
    if (rawValue === null || rawValue === undefined) return;
    const value = typeof rawValue === "boolean" ? (rawValue ? "true" : "false") : rawValue;
    if (typeof value === "string" && value.length === 0) return;
    entries.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  });
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

export async function listPartners(
  token: string | null,
  query: string = "",
  archived: boolean = false,
  trade: string | null = null,
): Promise<PartnerListItem[]> {
  const qs = buildQuery({ q: query.trim(), archived, trade: trade?.trim() ?? null });
  return apiFetch<PartnerListItem[]>(`/partners${qs}`, token);
}

export async function getPartner(
  token: string | null,
  id: number,
): Promise<PartnerListItem | null> {
  return apiFetch<PartnerListItem | null>(`/partners/${id}`, token);
}

export async function listPartnerTasks(
  token: string | null,
  id: number,
): Promise<Task[]> {
  return apiFetch<Task[]>(`/partners/${id}/tasks`, token);
}

export async function savePartner(
  token: string | null,
  data: PartnerWriteInput,
  id?: number,
): Promise<PartnerListItem> {
  const payload: Record<string, string | null> = {
    name: data.name,
    contact_person: data.contact_person ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    address: data.address ?? null,
    trade: data.trade ?? null,
    tax_id: data.tax_id ?? null,
    notes: data.notes ?? null,
  };
  if (id) {
    return apiFetch<PartnerListItem>(`/partners/${id}`, token, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
  return apiFetch<PartnerListItem>(`/partners`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function archivePartner(
  token: string | null,
  id: number,
): Promise<PartnerListItem> {
  return apiFetch<PartnerListItem>(`/partners/${id}/archive`, token, {
    method: "POST",
  });
}

export async function unarchivePartner(
  token: string | null,
  id: number,
): Promise<PartnerListItem> {
  return apiFetch<PartnerListItem>(`/partners/${id}/unarchive`, token, {
    method: "POST",
  });
}

// ── Partner-portal logins (office side) ─────────────────────────────────────

export function listPartnerPortalUsers(token: string | null, partnerId: number): Promise<PartnerPortalUser[]> {
  return apiFetch<PartnerPortalUser[]>(`/partners/${partnerId}/portal-users`, token);
}

export function invitePartnerPortalUser(
  token: string | null,
  partnerId: number,
  input: { full_name: string; email: string },
): Promise<PartnerPortalLink> {
  return apiFetch<PartnerPortalLink>(`/partners/${partnerId}/portal-users`, token, {
    method: "POST",
    body: JSON.stringify({ full_name: input.full_name.trim(), email: input.email.trim() }),
  });
}

export function sendPartnerPortalLink(token: string | null, partnerId: number, userId: number): Promise<PartnerPortalLink> {
  return apiFetch<PartnerPortalLink>(`/partners/${partnerId}/portal-users/${userId}/send-link`, token, { method: "POST" });
}

export function setPartnerPortalUserActive(
  token: string | null,
  partnerId: number,
  userId: number,
  active: boolean,
): Promise<PartnerPortalUser> {
  return apiFetch<PartnerPortalUser>(
    `/partners/${partnerId}/portal-users/${userId}/${active ? "activate" : "deactivate"}`,
    token,
    { method: "POST" },
  );
}

// ── Projects handed to partners ──────────────────────────────────────────────

export function listProjectPartners(token: string | null, projectId: number): Promise<ProjectPartnerLink[]> {
  return apiFetch<ProjectPartnerLink[]>(`/projects/${projectId}/partners`, token);
}

export function saveProjectPartner(
  token: string | null,
  projectId: number,
  partnerId: number,
  note: string | null,
): Promise<ProjectPartnerLink> {
  return apiFetch<ProjectPartnerLink>(`/projects/${projectId}/partners/${partnerId}`, token, {
    method: "PUT",
    body: JSON.stringify({ note: note && note.trim() ? note.trim() : null }),
  });
}

export async function removeProjectPartner(token: string | null, projectId: number, partnerId: number): Promise<void> {
  await apiFetch<unknown>(`/projects/${projectId}/partners/${partnerId}`, token, { method: "DELETE" });
}

export function listProjectPartnerHours(token: string | null, projectId: number): Promise<PartnerHoursEntry[]> {
  return apiFetch<PartnerHoursEntry[]>(`/projects/${projectId}/partner-hours`, token);
}

export function listTaskPartnerHours(token: string | null, taskId: number): Promise<PartnerHoursEntry[]> {
  return apiFetch<PartnerHoursEntry[]>(`/tasks/${taskId}/partner-hours`, token);
}

export async function deletePartnerHours(token: string | null, entryId: number): Promise<void> {
  await apiFetch<unknown>(`/partner-hours/${entryId}`, token, { method: "DELETE" });
}

export type { Partner, PartnerListItem };
