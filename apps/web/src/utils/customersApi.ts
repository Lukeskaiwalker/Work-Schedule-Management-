// Real API client for the Customer (Kunden) feature. Mirrors the shape of
// `partnersApi.ts` — `apiFetch<T>` with `token` as the first argument.
//
// Endpoint plan (implemented in `apps/api/app/routers/workflow_customers.py`):
//   GET    /customers?q=&archived=          → listCustomers
//   GET    /customers/{id}                  → getCustomer
//   GET    /customers/{id}/projects         → listCustomerProjects
//   POST   /customers                       → saveCustomer (create)
//   PATCH  /customers/{id}                  → saveCustomer (update), saveCustomerVisit
//   POST   /customers/{id}/archive          → archiveCustomer
//   POST   /customers/{id}/unarchive        → unarchiveCustomer
//   GET    /customers/{id}/notes            → listCustomerNotes (newest first, ?before_id= pages back)
//   POST   /customers/{id}/notes            → postCustomerNote
//   DELETE /customers/{id}/notes/{noteId}   → deleteCustomerNote

import { apiFetch } from "../api/client";
import type { Customer, CustomerListItem, CustomerNote, Project } from "../types";

export type CustomerType = NonNullable<Customer["customer_type"]>;

export type CustomerWriteInput = {
  name: string;
  /** "company" or "private"; null keeps a row from before the field unset. */
  customer_type?: CustomerType | null;
  address?: string | null;
  contact_person?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  tax_id?: string | null;
  /**
   * The legacy notes text. The feed replaced it (migration 0092 made the
   * old text the first entry), so the form no longer offers it; it is only
   * sent when a caller passes it on purpose, never nulled by omission.
   */
  notes?: string | null;
  /** ISO YYYY-MM-DD or null. Sent as null to clear an existing birthday. */
  birthday?: string | null;
  /** Marktstammdatenregister "Marktakteur-Nummer" (PV/energy customers). */
  marktakteur_nummer?: string | null;
  /** What the first visit found — printed at the head of every Projektbericht. */
  visit_summary?: string | null;
  /** ISO YYYY-MM-DD of that visit, or null. */
  visit_date?: string | null;
};

/** The visit block on its own: what the overview card edits in place. */
export type CustomerVisitInput = Pick<CustomerWriteInput, "visit_summary" | "visit_date">;

/** Subset of `Project` used by `CustomerDetailPage`. The backend returns the
 *  full `ProjectOut`, so we widen this to the Project type — callers only
 *  read a handful of fields and ignore the rest. */
export type CustomerProjectSummary = Pick<
  Project,
  "id" | "project_number" | "name" | "status" | "last_state" | "last_updated_at" | "customer_id"
>;

/** The server's page size for the note feed: a page this long may have more behind it. */
export const CUSTOMER_NOTES_PAGE = 20;

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

export async function listCustomers(
  token: string | null,
  query: string = "",
  archived: boolean = false,
): Promise<CustomerListItem[]> {
  const qs = buildQuery({ q: query.trim(), archived });
  return apiFetch<CustomerListItem[]>(`/customers${qs}`, token);
}

export async function getCustomer(
  token: string | null,
  id: number,
): Promise<CustomerListItem | null> {
  return apiFetch<CustomerListItem | null>(`/customers/${id}`, token);
}

export async function listCustomerProjects(
  token: string | null,
  id: number,
): Promise<CustomerProjectSummary[]> {
  // Backend returns full `ProjectOut[]`; we narrow at the type boundary —
  // unread fields are harmless.
  return apiFetch<CustomerProjectSummary[]>(`/customers/${id}/projects`, token);
}

export async function saveCustomer(
  token: string | null,
  data: CustomerWriteInput,
  id?: number,
): Promise<CustomerListItem> {
  const payload: Record<string, string | null> = {
    name: data.name,
    customer_type: data.customer_type ?? null,
    address: data.address ?? null,
    contact_person: data.contact_person ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    mobile: data.mobile ?? null,
    tax_id: data.tax_id ?? null,
    birthday: data.birthday ?? null,
    marktakteur_nummer: data.marktakteur_nummer ?? null,
    visit_summary: data.visit_summary ?? null,
    visit_date: data.visit_date ?? null,
    ...(data.notes !== undefined ? { notes: data.notes } : {}),
  };
  if (id) {
    return apiFetch<CustomerListItem>(`/customers/${id}`, token, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
  return apiFetch<CustomerListItem>(`/customers`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** PATCH only the visit block, so a card that edits it cannot touch the rest of the row. */
export async function saveCustomerVisit(
  token: string | null,
  id: number,
  visit: CustomerVisitInput,
): Promise<CustomerListItem> {
  return apiFetch<CustomerListItem>(`/customers/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify({
      visit_summary: visit.visit_summary ?? null,
      visit_date: visit.visit_date ?? null,
    }),
  });
}

export async function archiveCustomer(
  token: string | null,
  id: number,
): Promise<CustomerListItem> {
  return apiFetch<CustomerListItem>(`/customers/${id}/archive`, token, {
    method: "POST",
  });
}

export async function unarchiveCustomer(
  token: string | null,
  id: number,
): Promise<CustomerListItem> {
  return apiFetch<CustomerListItem>(`/customers/${id}/unarchive`, token, {
    method: "POST",
  });
}

/** Newest first; `beforeId` asks for what is older than a row already held. */
export async function listCustomerNotes(
  token: string | null,
  id: number,
  beforeId: number | null = null,
): Promise<CustomerNote[]> {
  const cursor = beforeId === null ? "" : `&before_id=${beforeId}`;
  return apiFetch<CustomerNote[]>(`/customers/${id}/notes?limit=${CUSTOMER_NOTES_PAGE}${cursor}`, token);
}

export async function postCustomerNote(
  token: string | null,
  id: number,
  body: string,
): Promise<CustomerNote> {
  return apiFetch<CustomerNote>(`/customers/${id}/notes`, token, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function deleteCustomerNote(
  token: string | null,
  id: number,
  noteId: number,
): Promise<void> {
  await apiFetch<void>(`/customers/${id}/notes/${noteId}`, token, { method: "DELETE" });
}

export type { Customer, CustomerListItem, CustomerNote };
