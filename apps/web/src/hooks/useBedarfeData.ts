import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRequestSequence } from "../utils/latestRequest";
import type { MaterialNeedFilters, MaterialNeedRow } from "../types/materialNeeds";
import { listBedarfe } from "../utils/werkstattBedarfeApi";

/**
 * The Bedarfe list, owned by the page rather than by App state.
 *
 * Why here and not in AppContext: the list is filtered SERVER-side (a few
 * hundred rows across every active site is too many to hold, and the toolbar's
 * filters are query parameters), it is read by exactly one screen, and a
 * global copy went stale the moment a second person edited a row. The old
 * arrangement loaded once on a manual click and showed an empty page when the
 * user arrived from the Werkstatt banner, because the load was gated on a
 * view that no longer existed.
 *
 * Out-of-order protection is the same ticket mechanism `tasks` uses: typing in
 * the search box issues a request per keystroke-batch, and the slowest must
 * not be the one that lands.
 */
export interface BedarfeData {
  rows: MaterialNeedRow[];
  loading: boolean;
  /** German message when the last load failed; null while things are fine. */
  error: string | null;
  reload: () => void;
  /** Put a server-returned row back in place, keeping list order. */
  applyRow: (row: MaterialNeedRow) => void;
  applyRows: (rows: readonly MaterialNeedRow[]) => void;
  removeRows: (ids: readonly number[]) => void;
}

export function useBedarfeData(
  token: string | null,
  active: boolean,
  filters: MaterialNeedFilters,
): BedarfeData {
  const [rows, setRows] = useState<MaterialNeedRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const sequenceRef = useRef(createRequestSequence());

  // The filter object is rebuilt on every render of the page; comparing its
  // serialised form keeps the effect from firing on identity alone.
  const filterKey = JSON.stringify({
    statuses: filters.statuses ?? [],
    projectId: filters.projectId ?? null,
    supplierId: filters.supplierId ?? null,
    q: (filters.q ?? "").trim(),
    includeCompleted: Boolean(filters.includeCompleted),
    orderableOnly: Boolean(filters.orderableOnly),
  });

  useEffect(() => {
    if (!active) return undefined;
    const parsed = JSON.parse(filterKey) as MaterialNeedFilters;
    const ticket = sequenceRef.current.issue();
    const controller = new AbortController();
    setLoading(true);
    void listBedarfe(token, parsed, controller.signal)
      .then((found) => {
        if (!sequenceRef.current.isCurrent(ticket)) return;
        setRows(found);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (!sequenceRef.current.isCurrent(ticket)) return;
        setError(
          err instanceof Error && err.message
            ? err.message
            : "Bedarfe konnten nicht geladen werden.",
        );
      })
      .finally(() => {
        if (sequenceRef.current.isCurrent(ticket)) setLoading(false);
      });
    return () => controller.abort();
  }, [active, token, filterKey, reloadTick]);

  const reload = useCallback(() => setReloadTick((tick) => tick + 1), []);

  const applyRow = useCallback((row: MaterialNeedRow) => {
    setRows((current) => current.map((entry) => (entry.id === row.id ? row : entry)));
  }, []);

  const applyRows = useCallback((updated: readonly MaterialNeedRow[]) => {
    const byId = new Map(updated.map((row) => [row.id, row]));
    setRows((current) => current.map((entry) => byId.get(entry.id) ?? entry));
  }, []);

  const removeRows = useCallback((ids: readonly number[]) => {
    const gone = new Set(ids);
    setRows((current) => current.filter((entry) => !gone.has(entry.id)));
  }, []);

  return useMemo(
    () => ({ rows, loading, error, reload, applyRow, applyRows, removeRows }),
    [rows, loading, error, reload, applyRow, applyRows, removeRows],
  );
}
