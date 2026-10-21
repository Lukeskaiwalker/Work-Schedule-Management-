/**
 * The Kunden page's rows: debounced, server-searched, newest-wins, complete.
 *
 * The page used to search by writing the answer into the shared customer list
 * (AppContext `customers`), which every picker in the app filters — so after a
 * search there, the project form and the Kisten page knew only the hits. These
 * rows are the page's own and never reach that list; the only copy kept
 * elsewhere is App's cache of them, which nothing but this page reads.
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
 *   - **Remembered.** The answer on screen is kept in `cache` (App's, for the
 *     session), and a remount starts from it: coming back from a customer
 *     shows the same rows at once and refreshes them behind the scenes.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { CustomerListItem } from "../types";
import { listAllCustomers } from "../utils/customersApi";
import { mergeCustomerLists } from "../utils/customerRows";
import { createRequestSequence } from "../utils/latestRequest";

/** Typing pause before a search goes out. An empty box loads at once. */
export const CUSTOMER_SEARCH_DEBOUNCE_MS = 250;

export type CustomerArchiveFilter = "all" | "active" | "archived";

/** An answer and the question it answers: the trimmed query and the filter. */
export interface CustomerSearchAnswer {
  query: string;
  filter: CustomerArchiveFilter;
  rows: CustomerListItem[];
}

/**
 * Where the page's last answer outlives the page. Opening a customer unmounts
 * it; App keeps one of these for the session (`useCustomersPageMemory`), so
 * coming back shows the rows that were on screen instead of an empty table.
 */
export interface CustomerSearchCache {
  read: () => CustomerSearchAnswer | null;
  write: (answer: CustomerSearchAnswer | null) => void;
}

export function createCustomerSearchCache(): CustomerSearchCache {
  let held: CustomerSearchAnswer | null = null;
  return {
    read: () => held,
    write: (answer) => {
      held = answer;
    },
  };
}

export interface CustomerSearchOptions {
  /** False while the page is not shown: nothing is fetched. */
  active: boolean;
  token: string | null;
  query: string;
  filter: CustomerArchiveFilter;
  /** Any value that changes when the rows may have changed elsewhere; a change refetches. */
  refreshKey: unknown;
  /** Read once on mount, written with every answer shown. */
  cache: CustomerSearchCache;
}

export interface CustomerSearch {
  rows: CustomerListItem[];
  loading: boolean;
  /**
   * Set when the last request failed. Rows that answer the same question stay
   * (a failed refresh: they are what the server last said, the message says
   * they may be dated); rows for another question are cleared, never shown
   * as the answer to this one.
   */
  loadError: string | null;
}

const NO_ROWS: CustomerListItem[] = [];

function answersQuestion(answer: CustomerSearchAnswer | null, query: string, filter: CustomerArchiveFilter): boolean {
  return answer !== null && answer.query === query && answer.filter === filter;
}

async function fetchRows(token: string | null, query: string, filter: CustomerArchiveFilter): Promise<CustomerListItem[]> {
  if (filter !== "all") return listAllCustomers(token, { query, archived: filter === "archived" });
  const [active, archived] = await Promise.all([
    listAllCustomers(token, { query, archived: false }),
    listAllCustomers(token, { query, archived: true }),
  ]);
  return mergeCustomerLists(active, archived);
}

export function useCustomerSearch({
  active,
  token,
  query,
  filter,
  refreshKey,
  cache,
}: CustomerSearchOptions): CustomerSearch {
  // What was on screen when the page was last left — shown until the refresh
  // below answers, instead of an empty table and a spinner.
  const [answer, setAnswer] = useState<CustomerSearchAnswer | null>(() => cache.read());
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sequence = useMemo(() => createRequestSequence(), []);
  const trimmed = query.trim();

  const load = useCallback(async () => {
    if (!active) return;
    const ticket = sequence.issue();
    setLoading(true);
    try {
      const rows = await fetchRows(token, trimmed, filter);
      if (!sequence.isCurrent(ticket)) return;
      setAnswer({ query: trimmed, filter, rows });
      setLoadError(null);
    } catch (err) {
      if (!sequence.isCurrent(ticket)) return;
      // An empty table must not pass for "no customers": say why it is empty.
      setAnswer((shown) => (answersQuestion(shown, trimmed, filter) ? shown : null));
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

  // Remembered from state, not from the request: an answer that lands after
  // the page has gone (signed out meanwhile, the cache already cleared) is a
  // state update React drops, so it cannot reach the next visit either.
  useEffect(() => {
    cache.write(answer);
  }, [cache, answer]);

  return { rows: answer?.rows ?? NO_ROWS, loading, loadError };
}
