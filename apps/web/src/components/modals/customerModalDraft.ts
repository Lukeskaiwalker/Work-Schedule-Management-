/**
 * The customer form's draft: strings for every input, and the two mappings
 * at its edges — a row into the draft, the draft into what the API takes.
 * Kept beside the modal so the payload can be tested without a render.
 *
 * The Kundenbesuch strings are for a new customer only: they become the
 * first entry of the visit feed, sent along with the create. A row never
 * seeds them — visits live on the customer page, not on the row.
 */
import type { CustomerListItem } from "../../types";
import type { CustomerType, CustomerWriteInput } from "../../utils/customersApi";

export type CustomerDraft = {
  /** "" until Firma or Privatperson is chosen; a row from before the field opens with "". */
  customer_type: CustomerType | "";
  name: string;
  address: string;
  contact_person: string;
  email: string;
  phone: string;
  mobile: string;
  tax_id: string;
  // ISO YYYY-MM-DD or "" when unset; matches the value shape of `<input
  // type="date">` so we can two-way-bind without a parser/formatter.
  birthday: string;
  marktakteur_nummer: string;
  /** The first Kundenbesuch of a new customer; ignored when editing. */
  visit_date: string;
  visit_summary: string;
};

export const EMPTY_CUSTOMER_DRAFT: CustomerDraft = {
  customer_type: "",
  name: "",
  address: "",
  contact_person: "",
  email: "",
  phone: "",
  mobile: "",
  tax_id: "",
  birthday: "",
  marktakteur_nummer: "",
  visit_date: "",
  visit_summary: "",
};

export function draftFromCustomer(customer: CustomerListItem | null): CustomerDraft {
  if (!customer) return EMPTY_CUSTOMER_DRAFT;
  return {
    customer_type: customer.customer_type ?? "",
    name: customer.name ?? "",
    address: customer.address ?? "",
    contact_person: customer.contact_person ?? "",
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    mobile: customer.mobile ?? "",
    tax_id: customer.tax_id ?? "",
    birthday: customer.birthday ?? "",
    marktakteur_nummer: customer.marktakteur_nummer ?? "",
    visit_date: "",
    visit_summary: "",
  };
}

function trimmedOrNull(value: string): string | null {
  return value.trim() || null;
}

/**
 * Trims everything and sends null for what is empty — the API takes null
 * to clear a field, and Pydantic rejects "" for a date. A private person
 * has no Ansprechpartner: the field is hidden for them, so whatever the
 * row held from a company phase is cleared rather than kept invisibly.
 * The Kundenbesuch rides along only when a summary was written: a date
 * alone is no visit, and the key is left out rather than sent empty.
 */
export function writeInputFromDraft(draft: CustomerDraft): CustomerWriteInput {
  const isPrivate = draft.customer_type === "private";
  const visitSummary = draft.visit_summary.trim();
  return {
    name: draft.name.trim(),
    customer_type: draft.customer_type || null,
    address: trimmedOrNull(draft.address),
    contact_person: isPrivate ? null : trimmedOrNull(draft.contact_person),
    email: trimmedOrNull(draft.email),
    phone: trimmedOrNull(draft.phone),
    mobile: trimmedOrNull(draft.mobile),
    tax_id: trimmedOrNull(draft.tax_id),
    birthday: trimmedOrNull(draft.birthday),
    marktakteur_nummer: trimmedOrNull(draft.marktakteur_nummer),
    ...(visitSummary ? { visit: { summary: visitSummary, visit_date: trimmedOrNull(draft.visit_date) } } : {}),
  };
}
