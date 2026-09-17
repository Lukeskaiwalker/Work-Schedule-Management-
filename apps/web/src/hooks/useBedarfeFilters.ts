import { useCallback, useEffect, useMemo, useState } from "react";
import type { MaterialNeedStatus } from "../types";
import type { MaterialNeedFilters, SupplierFilter } from "../types/materialNeeds";

/**
 * What the toolbar is asking for.
 *
 * Separate from the page because these are query parameters, not view state:
 * every one of them narrows the SERVER query (the list is far too long to
 * filter in the browser), and the search box needs a debounce so a fast typist
 * does not fire a request per keystroke.
 *
 * `query` is the debounced value the request uses; `queryInput` is what the
 * field shows. Keeping both here is the whole reason this is a hook — a page
 * that stores only one of them either lags a character behind or hammers the
 * API.
 */
export interface BedarfeFilterState {
  /** Live value for the input element. */
  queryInput: string;
  setQueryInput: (value: string) => void;
  statuses: readonly MaterialNeedStatus[];
  toggleStatus: (status: MaterialNeedStatus) => void;
  projectId: number | null;
  setProjectId: (value: number | null) => void;
  supplierId: SupplierFilter;
  setSupplierId: (value: SupplierFilter) => void;
  includeCompleted: boolean;
  setIncludeCompleted: (value: boolean) => void;
  orderableOnly: boolean;
  setOrderableOnly: (value: boolean) => void;
  /** Debounced, ready to send. */
  filters: MaterialNeedFilters;
  hasActiveFilters: boolean;
  reset: () => void;
}

export function useBedarfeFilters(debounceMs = 250): BedarfeFilterState {
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [statuses, setStatuses] = useState<readonly MaterialNeedStatus[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState<SupplierFilter>(null);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [orderableOnly, setOrderableOnly] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => setQuery(queryInput), debounceMs);
    return () => window.clearTimeout(timeout);
  }, [queryInput, debounceMs]);

  const toggleStatus = useCallback((status: MaterialNeedStatus) => {
    setStatuses((current) =>
      current.includes(status)
        ? current.filter((entry) => entry !== status)
        : [...current, status],
    );
  }, []);

  const reset = useCallback(() => {
    setQueryInput("");
    setQuery("");
    setStatuses([]);
    setProjectId(null);
    setSupplierId(null);
    setIncludeCompleted(false);
    setOrderableOnly(false);
  }, []);

  const filters = useMemo<MaterialNeedFilters>(
    () => ({ statuses, projectId, supplierId, q: query, includeCompleted, orderableOnly }),
    [statuses, projectId, supplierId, query, includeCompleted, orderableOnly],
  );

  const hasActiveFilters =
    query.trim().length > 0 ||
    statuses.length > 0 ||
    projectId != null ||
    supplierId != null ||
    includeCompleted ||
    orderableOnly;

  return {
    queryInput,
    setQueryInput,
    statuses,
    toggleStatus,
    projectId,
    setProjectId,
    supplierId,
    setSupplierId,
    includeCompleted,
    setIncludeCompleted,
    orderableOnly,
    setOrderableOnly,
    filters,
    hasActiveFilters,
    reset,
  };
}
