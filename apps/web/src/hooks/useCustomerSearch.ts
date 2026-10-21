/**
 * The Kunden page's rows: debounced, server-searched, newest-wins, complete.
 *
 * The page used to search by writing the answer into the shared customer list
 * (AppContext `customers`), which every picker in the app filters — so after a
 * search there, the project form and the Kisten page knew only the hits. These
 * rows are the page's own and never leave it.
 *
 *   - **Complete.** Every request pages through the whole result
 *     (`listAllCustomers`); without a query that is every customer, so the
 *     table and the CSV export no longer stop at the server's 200-row default.
 *   - **"Alle" is active plus archived** — the server answers one or the
 *     other, so it is two lists merged in the server's order.
 *   - **Only the newest request may paint.** A slow answer to "Mü" landing
 *     after the answer to "Müller" used to replace it.
 *   - **Follows the shared list.** `refreshKey` is the directory's `customers`:
 *     a save in the customer form, an archive or a restore changes it, and the
 *     page fetches again rather than patching its own copy by hand.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CustomerListItem } from "../types";
import { listAllCustomers } from "../utils/customersApi";
import { mergeCustomerLists } from "../utils/customerRows";
import { createRequestSequence } from "../utils/latestRequest";

/** Typing pause before a search goes out. An empty box loads at once. */
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 250;

export type CustomerArchiveFilter = "all" | "active" | "archived";

export interface CustomerSearchOptions {
  /** False while the page is not shown: nothing is fetched. */
  active: boolean;
  token: string | null;
  query: string;
  filter: CustomerArchiveFilter;
  /** Any value that changes when the rows may have changed elsewhere; a change refetches. */
  refreshKey: unknown;
}

export interface CustomerSearch {
  rows: CustomerListItem[];
  loading: boolean;
  /** Set when the last request failed; the rows are then empty, never a stale or partial list. */
  loadError: string | null;
}

async function fetchRows(token: string | null, query: string, filter: CustomerArchiveFilter): Promise<CustomerListItem[]> {
  if (filter !== "all") return listAllCustomers(token, { query, archived: filter === "archived" });
  const [active, archived] = await Promise.all([
    listAllCustomers(token, { query, archived: false }),
    listAllCustomers(token, { query, archived: true }),
  ]);
  return mergeCustomerLists(active, archived);
}

export function useCustomerSearch({ active, token, query, filter, refreshKey }: CustomerSearchOptions): CustomerSearch {
  const [rows, setRows] = useState<CustomerListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sequence = useMemo(() => createRequestSequence(), []);
  const trimmed = query.trim();

  const load = useCallback(async () => {
    if (!active) return;
    const ticket = sequence.issue();
    setLoading(true);
    try {
      const next = await fetchRows(token, trimmed, filter);
      if (!sequence.isCurrent(ticket)) return;
      setRows(next);
      setLoadError(null);
    } catch (err) {
      if (!sequence.isCurrent(ticket)) return;
      // An empty table must not pass for "no customers": say why it is empty.
      setRows([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (sequence.isCurrent(ticket)) setLoading(false);
    }
    // refreshKey is not read; it is here so that a change to it refetches.
  }, [active, token, trimmed, filter, refreshKey, sequence]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), trimmed ? CUSTOMER_SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [load, trimmed]);

  return { rows, loading, loadError };
}
