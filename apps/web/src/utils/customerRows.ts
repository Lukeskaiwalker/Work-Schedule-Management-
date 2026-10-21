/**
 * Pure helpers for holding customer rows in the order the server sends them.
 *
 * GET /customers orders by name, then id. A row written locally (a save, an
 * archive) is folded into a list that came from there, and the Kunden page's
 * "Alle" merges two server lists, so both need the same order: otherwise a
 * new customer lands at the bottom of a picker's empty-query view and "Alle"
 * shows every archived customer after every active one.
 */
import type { CustomerListItem } from "../types";

const NAME_COLLATOR = new Intl.Collator("de", { sensitivity: "base", numeric: false });

/** Name first (German collation, case- and accent-blind), then id — the server's ORDER BY. */
export function compareCustomers(a: CustomerListItem, b: CustomerListItem): number {
  return NAME_COLLATOR.compare(a.name, b.name) || a.id - b.id;
}

/** A new list with `row` at its sorted place, replacing any row with the same id. */
export function withCustomerRow(rows: CustomerListItem[], row: CustomerListItem): CustomerListItem[] {
  const others = rows.filter((existing) => existing.id !== row.id);
  const at = others.findIndex((existing) => compareCustomers(row, existing) < 0);
  return at < 0 ? [...others, row] : [...others.slice(0, at), row, ...others.slice(at)];
}

/**
 * Fold a row the server just returned into the ACTIVE-customer list: an
 * archived row leaves it (pickers must not offer an archived customer), an
 * active one is added or replaced.
 */
export function withActiveCustomerRow(rows: CustomerListItem[], row: CustomerListItem): CustomerListItem[] {
  if (row.archived_at) return rows.filter((existing) => existing.id !== row.id);
  return withCustomerRow(rows, row);
}

/**
 * The duplicate test, shared by the combobox's create row and the directory's
 * server check: the same name, ignoring case and outer spaces. Strict on
 * purpose — a near name is somebody else until a person says otherwise.
 */
export function isSameCustomerName(name: string, query: string): boolean {
  return name.trim().toLowerCase() === query.trim().toLowerCase();
}

/** Two server-ordered lists as one, in server order. */
export function mergeCustomerLists(a: CustomerListItem[], b: CustomerListItem[]): CustomerListItem[] {
  return [...a, ...b].sort(compareCustomers);
}
