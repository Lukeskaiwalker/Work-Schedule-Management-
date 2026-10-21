/**
 * The customer directory: every ACTIVE customer, the one list each customer
 * picker filters locally (project form, Kisten, Baustellenbericht, Schaltplan,
 * task modal) and every "Kunde #id" label resolves through.
 *
 * Lifted out of App.tsx because the rules that make the pickers trustworthy
 * live here and nowhere else:
 *
 *   - **Always complete.** It is loaded with `listAllCustomers`, page by page.
 *     It used to be one GET with the server's 200-row default, so from the
 *     201st customer on the alphabetically last ones did not exist for any
 *     picker — the Kisten page could not pack a box for customer #208 of 222,
 *     and the project form offered to create them a second time.
 *   - **Only this hook writes it.** There is no setter in the context and no
 *     search parameter on `reloadCustomers`: the Kunden page's search used to
 *     replace the list with its hits, leaving every picker with one customer.
 *     A search goes through `searchCustomers`, which returns its rows and
 *     never stores them.
 *   - **Only the newest reload lands**, and a failed one keeps the list it had
 *     (an empty picker reads as "this customer does not exist").
 *   - **Active only.** Archiving removes the row, restoring adds it back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CustomerListItem, Language } from "../types";
import {
  archiveCustomer as apiArchiveCustomer,
  listAllCustomers,
  listCustomers,
  saveCustomer as apiSaveCustomer,
  unarchiveCustomer as apiUnarchiveCustomer,
  type CustomerWriteInput,
} from "../utils/customersApi";
import { isSameCustomerName, withActiveCustomerRow } from "../utils/customerRows";
import { createRequestSequence } from "../utils/latestRequest";

/** Hits a picker's server check asks for — it looks for one name, not a list to browse. */
export const CUSTOMER_SEARCH_LIMIT = 20;

export interface CustomerDirectoryOptions {
  /** Null while signed out: nothing is fetched. */
  token: string | null;
  language: Language;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}

export interface CustomerDirectory {
  /** Every active customer, in the server's order (name, then id). */
  customers: CustomerListItem[];
  /** Fetch the complete list again. Resolves when it has landed, or failed (reported via `setError`). */
  reloadCustomers: () => Promise<void>;
  /**
   * Ask the server for active customers matching `query` (name, address,
   * contact, e-mail, phone). Returns the first 20 hits — or every hit, when 20
   * fill the page without one of exactly that name, so "no exact name in the
   * answer" always means nobody is called that. Stores nothing; a hit the
   * directory lacks — created elsewhere since it loaded — triggers a reload
   * in the background unless one is under way. Rejects on failure, for the
   * caller to handle.
   */
  searchCustomers: (query: string) => Promise<CustomerListItem[]>;
  /** Create (no id) or update. Throws on failure, for the form to show. */
  saveCustomer: (data: CustomerWriteInput, id?: number) => Promise<CustomerListItem>;
  archiveCustomer: (id: number) => Promise<void>;
  unarchiveCustomer: (id: number) => Promise<void>;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useCustomerDirectory({
  token,
  language,
  setError,
  setNotice,
}: CustomerDirectoryOptions): CustomerDirectory {
  const [customers, setCustomers] = useState<CustomerListItem[]>([]);
  const sequence = useMemo(() => createRequestSequence(), []);
  // The ticket of the reload in flight, or null. A local write while one is in
  // flight cannot trust it: it may have been answered before the write.
  const reloadInFlight = useRef<number | null>(null);
  // Read by `searchCustomers` without making it change with every list.
  const customersRef = useRef(customers);
  customersRef.current = customers;
  // Messages follow the language at the time they are shown; a language
  // switch is no reason to fetch the whole list again.
  const languageRef = useRef(language);
  languageRef.current = language;
  const de = () => languageRef.current === "de";

  const reloadCustomers = useCallback(async (): Promise<void> => {
    const ticket = sequence.issue();
    reloadInFlight.current = ticket;
    try {
      const rows = await listAllCustomers(token);
      if (!sequence.isCurrent(ticket)) return;
      setCustomers(rows);
    } catch (err) {
      if (!sequence.isCurrent(ticket)) return;
      setError(errorText(err) || (de() ? "Kunden konnten nicht geladen werden" : "Failed to load customers"));
    } finally {
      if (reloadInFlight.current === ticket) reloadInFlight.current = null;
    }
  }, [token, setError, sequence]);

  useEffect(() => {
    if (!token) return;
    void reloadCustomers();
  }, [token, reloadCustomers]);

  /** Fold a row the server returned into the list, and re-ask a reload that may predate it. */
  const applyServerRow = useCallback(
    (row: CustomerListItem) => {
      setCustomers((current) => withActiveCustomerRow(current, row));
      if (reloadInFlight.current !== null) void reloadCustomers();
    },
    [reloadCustomers],
  );

  const searchCustomers = useCallback(
    async (query: string): Promise<CustomerListItem[]> => {
      const page = await listCustomers(token, query, false, { limit: CUSTOMER_SEARCH_LIMIT, offset: 0 });
      // The combobox's duplicate guard reads "no exact name in the answer" as
      // "nobody is called that". A full page cannot say so: the server matches
      // address, contact, e-mail and phone too and stops after 20 in name
      // order, so a "Müller" can sit behind twenty customers on the
      // Müllerstraße. Only the complete answer can — the same capped-list
      // mistake that hid customers from every picker.
      const settled = page.length < CUSTOMER_SEARCH_LIMIT || page.some((row) => isSameCustomerName(row.name, query));
      const rows = settled ? page : await listAllCustomers(token, { query });
      const known = new Set(customersRef.current.map((row) => row.id));
      // One reload at a time. The one under way answers with the server's
      // list as well; starting another for every search threw it away, so on
      // a slow link the list never landed while somebody was typing.
      if (reloadInFlight.current === null && rows.some((row) => !known.has(row.id))) void reloadCustomers();
      return rows;
    },
    [token, reloadCustomers],
  );

  const saveCustomer = useCallback(
    async (data: CustomerWriteInput, id?: number): Promise<CustomerListItem> => {
      const saved = await apiSaveCustomer(token, data, id);
      applyServerRow(saved);
      setNotice(
        de()
          ? id
            ? "Kunde aktualisiert"
            : "Kunde angelegt"
          : id
            ? "Customer updated"
            : "Customer created",
      );
      return saved;
    },
    [token, applyServerRow, setNotice],
  );

  const archiveCustomer = useCallback(
    async (id: number): Promise<void> => {
      try {
        applyServerRow(await apiArchiveCustomer(token, id));
        setNotice(de() ? "Kunde archiviert" : "Customer archived");
      } catch (err) {
        setError(errorText(err));
      }
    },
    [token, applyServerRow, setError, setNotice],
  );

  const unarchiveCustomer = useCallback(
    async (id: number): Promise<void> => {
      try {
        applyServerRow(await apiUnarchiveCustomer(token, id));
        setNotice(de() ? "Kunde wiederhergestellt" : "Customer restored");
      } catch (err) {
        setError(errorText(err));
      }
    },
    [token, applyServerRow, setError, setNotice],
  );

  return { customers, reloadCustomers, searchCustomers, saveCustomer, archiveCustomer, unarchiveCustomer };
}
