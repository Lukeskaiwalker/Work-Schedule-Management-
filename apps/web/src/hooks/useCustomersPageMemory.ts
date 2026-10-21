/**
 * What the Kunden page remembers between visits: the search text, the archive
 * filter and the last answer.
 *
 * Opening a customer switches the main view and unmounts the page, so all of
 * it used to be lost on every "zurück" — the project list never had that
 * problem because its search lives in App (`projectsAllSearch`). This is the
 * same for customers: App holds it, so it survives navigation but not a
 * reload.
 *
 * Unlike the project search it is also dropped when the signed-in user goes
 * away (sign-out, expired session) or changes: the answer is a list of
 * customers somebody else asked for, and the next person at a shared office
 * PC should not open the page onto it.
 */
import { useEffect, useRef, useState } from "react";

import {
  createCustomerSearchCache,
  type CustomerArchiveFilter,
  type CustomerSearchCache,
} from "./useCustomerSearch";

export interface CustomersPageMemory {
  customersSearch: string;
  setCustomersSearch: (search: string) => void;
  customersArchiveFilter: CustomerArchiveFilter;
  setCustomersArchiveFilter: (filter: CustomerArchiveFilter) => void;
  /** The last answer the page showed. One object for the session; the page reads it on mount. */
  customersSearchCache: CustomerSearchCache;
}

export function useCustomersPageMemory(userId: number | null): CustomersPageMemory {
  const [customersSearch, setCustomersSearch] = useState("");
  const [customersArchiveFilter, setCustomersArchiveFilter] = useState<CustomerArchiveFilter>("active");
  const [customersSearchCache] = useState(createCustomerSearchCache);
  const owner = useRef(userId);

  useEffect(() => {
    if (owner.current === userId) return;
    owner.current = userId;
    setCustomersSearch("");
    setCustomersArchiveFilter("active");
    customersSearchCache.write(null);
  }, [userId, customersSearchCache]);

  return {
    customersSearch,
    setCustomersSearch,
    customersArchiveFilter,
    setCustomersArchiveFilter,
    customersSearchCache,
  };
}
