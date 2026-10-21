/**
 * The customer combobox's server check: debounced, newest-wins.
 *
 * The combobox filters the customer list it is handed, and decides from that
 * same list whether to offer "+ Neuen Kunden anlegen". When the list lacked
 * somebody (it stopped at 200 rows until 2026-10), the project form offered to
 * create an existing customer a second time. The list is complete now, but a
 * customer created in another browser since it loaded is still missing from
 * it — so before the create row appears, the server is asked.
 *
 *   - Short queries are not sent: one letter proves nothing either way.
 *   - The answer for a query counts only for that exact query; while the text
 *     has moved on, the check is "pending" again.
 *   - Only the newest request may answer: a slow reply to "Must" arriving
 *     after the reply to "Neumann" is dropped. Going back to text that is
 *     already answered counts as newest too (one letter more, a pause, then
 *     Backspace): the reply for the longer text is dropped, or it would
 *     replace the answer on screen and leave the check pending for good.
 *   - The function prop is read through a ref, so a caller passing a fresh
 *     arrow on every render does not restart the timer (or loop).
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { CustomerListItem } from "../../types";
import { createRequestSequence } from "../../utils/latestRequest";

/** Typing pause before the server is asked. */
export const CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS = 250;
/** Shorter queries are never sent. */
export const CUSTOMER_REMOTE_SEARCH_MIN_LENGTH = 2;

export type RemoteCustomerSearchState =
  /** No server check: none wired, or the query is too short. */
  | { status: "off" }
  /** Waiting for the typing pause or for the answer. */
  | { status: "pending" }
  | { status: "done"; rows: CustomerListItem[] }
  | { status: "failed" };

type Answer = { query: string; rows: CustomerListItem[] | null };

/**
 * @param searchRemote the caller's server search, or undefined for none
 * @param query the trimmed text in the box
 * @param enabled false while the dropdown is closed: nothing is sent
 */
export function useRemoteCustomerSearch(
  searchRemote: ((query: string) => Promise<CustomerListItem[]>) | undefined,
  query: string,
  enabled: boolean,
): RemoteCustomerSearchState {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const searchRef = useRef(searchRemote);
  searchRef.current = searchRemote;
  // Read in the effect to skip a query already answered (reopening the
  // dropdown), without re-running the effect whenever an answer lands.
  const answerRef = useRef(answer);
  answerRef.current = answer;
  const sequence = useMemo(() => createRequestSequence(), []);
  const wanted = searchRemote !== undefined && query.length >= CUSTOMER_REMOTE_SEARCH_MIN_LENGTH;

  useEffect(() => {
    if (!wanted || !enabled) return;
    const known = answerRef.current;
    if (known && known.query === query && known.rows !== null) {
      // Nothing to ask, but a request for other text may still be out.
      sequence.issue();
      return;
    }
    const timer = window.setTimeout(() => {
      const search = searchRef.current;
      if (!search) return;
      const ticket = sequence.issue();
      search(query).then(
        (rows) => {
          if (sequence.isCurrent(ticket)) setAnswer({ query, rows });
        },
        () => {
          if (sequence.isCurrent(ticket)) setAnswer({ query, rows: null });
        },
      );
    }, CUSTOMER_REMOTE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [wanted, enabled, query, sequence]);

  if (!wanted) return { status: "off" };
  if (!answer || answer.query !== query) return { status: "pending" };
  return answer.rows === null ? { status: "failed" } : { status: "done", rows: answer.rows };
}
