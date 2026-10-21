/**
 * What a customer pick in the Baustellenbericht form writes into the report.
 *
 * Lifted out of App.tsx so it can be tested: the rule that matters is which
 * row stands for the pick. The combobox's server check can offer a customer
 * the directory does not hold yet (created in another browser since the list
 * loaded); that pick carries its row, and looking the id up in `customers`
 * instead came back empty — the report then kept the bare name as if typed,
 * without address or contact.
 */
import type { CustomerListItem, ReportDraft } from "../types";

/** The customer a pick stands for: the picked row when it is that customer, else the list's row; null for free text. */
export function pickedReportCustomer(
  customerId: number | null,
  pickedRow: CustomerListItem | null | undefined,
  customers: CustomerListItem[],
): CustomerListItem | null {
  if (customerId == null) return null;
  if (pickedRow?.id === customerId) return pickedRow;
  return customers.find((entry) => entry.id === customerId) ?? null;
}

/**
 * The draft after a pick. A linked customer fills the master data (keeping
 * what the record lacks); free text only sets the name, so a manually typed
 * address is never silently overwritten.
 */
export function reportDraftWithCustomer(
  current: ReportDraft,
  picked: CustomerListItem | null,
  typedName: string,
): ReportDraft {
  if (!picked) return { ...current, customer: typedName };
  return {
    ...current,
    customer: picked.name,
    customer_address: picked.address ?? current.customer_address,
    customer_contact: picked.contact_person ?? current.customer_contact,
    customer_email: picked.email ?? current.customer_email,
    customer_phone: picked.phone ?? current.customer_phone,
  };
}
