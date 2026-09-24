// Real API client for the Customer (Kunden) feature. Mirrors the shape of
// `partnersApi.ts` — `apiFetch<T>` with `token` as the first argument.
//
// Endpoint plan (implemented in `apps/api/app/routers/workflow_customers.py`):
//   GET    /customers?q=&archived=          → listCustomers
//   GET    /customers/{id}                  → getCustomer
//   GET    /customers/{id}/projects         → listCustomerProjects
//   POST   /customers                       → saveCustomer (create; may carry the first `visit`)
//   PATCH  /customers/{id}                  → saveCustomer (update)
//   POST   /customers/{id}/archive          → archiveCustomer
//   POST   /customers/{id}/unarchive        → unarchiveCustomer
//   GET    /customers/{id}/notes            → listCustomerNotes (newest first, ?before_id= pages back)
//   POST   /customers/{id}/notes            → postCustomerNote
//   DELETE /customers/{id}/notes/{noteId}   → deleteCustomerNote
//   GET    /customers/{id}/visits           → listCustomerVisits (newest posted first, no paging)
//   POST   /customers/{id}/visits           → postCustomerVisit
//   PATCH  /customers/{id}/visits/{visitId} → updateCustomerVisit (partial)
//   DELETE /customers/{id}/visits/{visitId} → deleteCustomerVisit
//   GET    /customers/{id}/credentials             → listCustomerCredentials (ordered by label, no secrets)
//   POST   /customers/{id}/credentials             → createCustomerCredential
//   PATCH  /customers/{id}/credentials/{cid}       → updateCustomerCredential (partial; secret "" clears)
//   DELETE /customers/{id}/credentials/{cid}       → deleteCustomerCredential
//   POST   /customers/{id}/credentials/{cid}/reveal → revealCustomerCredential (audited)

import { apiFetch } from "../api/client";
import type {
  Customer,
  CustomerCredential,
  CustomerCredentialCategory,
  CustomerListItem,
  CustomerNote,
  CustomerVisit,
  Project,
} from "../types";

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
  /**
   * The first Kundenbesuch, written with the customer in one go. Only a
   * create (POST) carries it; an update never does — visits are a feed on
   * the customer page (`listCustomerVisits` and friends) once the row exists.
   */
  visit?: CustomerFirstVisit | null;
};

/** What the customer form sends along with a new customer. */
export type CustomerFirstVisit = {
  summary: string;
  /** ISO YYYY-MM-DD or null. */
  visit_date: string | null;
};

/** What POST /customers/{id}/visits takes. */
export type CustomerVisitCreate = {
  /** Trimmed, 1..8000 characters. */
  summary: string;
  /** ISO YYYY-MM-DD or null. */
  visit_date?: string | null;
  /** One of this customer's projects, or null: applies to all of them. */
  project_id?: number | null;
  /** Who went; omitted = the poster. */
  visit_by_user_id?: number | null;
};

/** PATCH /customers/{id}/visits/{visitId}: only the keys sent change; `project_id: null` unlinks. */
export type CustomerVisitUpdate = Partial<CustomerVisitCreate>;

/** What POST /customers/{id}/credentials takes. */
export type CustomerCredentialCreate = {
  /** Trimmed, 1..160 characters. */
  label: string;
  /** Omitted = "other". */
  category?: CustomerCredentialCategory;
  username?: string | null;
  /** The password, ≤ 512 characters; omitted = none stored. */
  secret?: string;
  url?: string | null;
  notes?: string | null;
};

/**
 * PATCH /customers/{id}/credentials/{cid}: only the keys sent change.
 * `secret` absent keeps the stored password, "" removes it, text replaces it.
 */
export type CustomerCredentialUpdate = Partial<CustomerCredentialCreate>;

/** What a reveal answers: the password, and when the reveal was logged. */
export type CustomerCredentialReveal = {
  secret: string;
  revealed_at: string;
};

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
  const payload: Record<string, unknown> = {
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
    ...(data.notes !== undefined ? { notes: data.notes } : {}),
  };
  if (id) {
    return apiFetch<CustomerListItem>(`/customers/${id}`, token, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  }
  // The first visit rides along only when a customer is created: the
  // update endpoint knows no visit field.
  const createPayload = data.visit ? { ...payload, visit: data.visit } : payload;
  return apiFetch<CustomerListItem>(`/customers`, token, {
    method: "POST",
    body: JSON.stringify(createPayload),
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

/** Every visit of the customer, newest posted first — the server does not page this feed. */
export async function listCustomerVisits(
  token: string | null,
  id: number,
): Promise<CustomerVisit[]> {
  return apiFetch<CustomerVisit[]>(`/customers/${id}/visits`, token);
}

export async function postCustomerVisit(
  token: string | null,
  id: number,
  visit: CustomerVisitCreate,
): Promise<CustomerVisit> {
  return apiFetch<CustomerVisit>(`/customers/${id}/visits`, token, {
    method: "POST",
    body: JSON.stringify(visit),
  });
}

/** Partial: only the keys in `changes` are touched on the server. */
export async function updateCustomerVisit(
  token: string | null,
  id: number,
  visitId: number,
  changes: CustomerVisitUpdate,
): Promise<CustomerVisit> {
  return apiFetch<CustomerVisit>(`/customers/${id}/visits/${visitId}`, token, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

export async function deleteCustomerVisit(
  token: string | null,
  id: number,
  visitId: number,
): Promise<void> {
  await apiFetch<void>(`/customers/${id}/visits/${visitId}`, token, { method: "DELETE" });
}

/** Every credential of the customer, ordered by label — never with a secret in it. */
export async function listCustomerCredentials(
  token: string | null,
  id: number,
): Promise<CustomerCredential[]> {
  return apiFetch<CustomerCredential[]>(`/customers/${id}/credentials`, token);
}

export async function createCustomerCredential(
  token: string | null,
  id: number,
  credential: CustomerCredentialCreate,
): Promise<CustomerCredential> {
  return apiFetch<CustomerCredential>(`/customers/${id}/credentials`, token, {
    method: "POST",
    body: JSON.stringify(credential),
  });
}

/** Partial: only the keys in `changes` are touched on the server. */
export async function updateCustomerCredential(
  token: string | null,
  id: number,
  credentialId: number,
  changes: CustomerCredentialUpdate,
): Promise<CustomerCredential> {
  return apiFetch<CustomerCredential>(`/customers/${id}/credentials/${credentialId}`, token, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });
}

/** The creator or a project manager; anyone else gets a 403 to show. */
export async function deleteCustomerCredential(
  token: string | null,
  id: number,
  credentialId: number,
): Promise<void> {
  await apiFetch<void>(`/customers/${id}/credentials/${credentialId}`, token, { method: "DELETE" });
}

/**
 * Fetch the stored password — one explicit call, audited on the server.
 * 404 when the entry has no secret.
 */
export async function revealCustomerCredential(
  token: string | null,
  id: number,
  credentialId: number,
): Promise<CustomerCredentialReveal> {
  return apiFetch<CustomerCredentialReveal>(`/customers/${id}/credentials/${credentialId}/reveal`, token, {
    method: "POST",
  });
}

export type { Customer, CustomerCredential, CustomerCredentialCategory, CustomerListItem, CustomerNote, CustomerVisit };
