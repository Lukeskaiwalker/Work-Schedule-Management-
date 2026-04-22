// Real API client for the Customer (Kunden) feature. Mirrors the shape of
// `partnersApi.ts` — `apiFetch<T>` with `token` as the first argument.
//
// Endpoint plan (implemented in `apps/api/app/routers/workflow_customers.py`):
//   GET    /customers?q=&archived=          → listCustomers
//   GET    /customers/{id}                  → getCustomer
//   GET    /customers/{id}/projects         → listCustomerProjects
//   POST   /customers                       → saveCustomer (create)
//   PATCH  /customers/{id}                  → saveCustomer (update)
//   POST   /customers/{id}/archive          → archiveCustomer
//   POST   /customers/{id}/unarchive        → unarchiveCustomer

import { apiFetch } from "../api/client";
import type { Customer, CustomerListItem, Project } from "../types";

export type CustomerWriteInput = {
  name: string;
  address?: string | null;
  contact_person?: string | null;
  email?: string | null;
  phone?: string | null;
  tax_id?: string | null;
  notes?: string | null;
};

/** Subset of `Project` used by `CustomerDetailPage`. The backend returns the
 *  full `ProjectOut`, so we widen this to the Project type — callers only
 *  read a handful of fields and ignore the rest. */
export type CustomerProjectSummary = Pick<
  Project,
  "id" | "project_number" | "name" | "status" | "last_state" | "last_updated_at" | "customer_id"
>;

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
    address: data.address ?? null,
    contact_person: data.contact_person ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    tax_id: data.tax_id ?? null,
    notes: data.notes ?? null,
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

export type { Customer, CustomerListItem };
