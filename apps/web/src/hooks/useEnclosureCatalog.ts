/**
 * The cabinet catalogue for the editor (docs/PANEL_ENCLOSURE.md §10.2).
 *
 * Fetched once per session and shared: every board with a cabinet needs it
 * to draw at all, and a tablet on a site connection should not wait for the
 * same answer each time a board opens. The cache is keyed on the token — a
 * different login may see a different `can_manage` and different stock.
 * `reload()` fetches again (after an admin edit); a failed reload keeps the
 * catalogue it had, because an empty picker reads as "no such module".
 * Concurrent mounts share one request.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { catalogIndex, type CatalogIndex } from "../utils/enclosureCatalog";
import { getEnclosureCatalog } from "../utils/schaltplanEnclosureApi";
import type { EnclosureCatalog } from "../types/panelEnclosure";

export interface EnclosureCatalogState {
  catalog: EnclosureCatalog | null;
  index: CatalogIndex | null;
  loading: boolean;
  error: string | null;
  reload(): Promise<void>;
}

let cached: { token: string; catalog: EnclosureCatalog } | null = null;
let inflight: { token: string; promise: Promise<EnclosureCatalog> } | null = null;

/** Forget the session copy (sign-out, tests). */
export function resetEnclosureCatalogCache(): void {
  cached = null;
  inflight = null;
}

function fetchShared(token: string, force: boolean): Promise<EnclosureCatalog> {
  if (!force && cached?.token === token) return Promise.resolve(cached.catalog);
  if (inflight?.token === token) return inflight.promise;
  const promise = getEnclosureCatalog(token).then((catalog) => {
    cached = { token, catalog };
    return catalog;
  });
  const entry = { token, promise };
  inflight = entry;
  const clear = () => {
    if (inflight === entry) inflight = null;
  };
  promise.then(clear, clear);
  return promise;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Schrankkatalog konnte nicht geladen werden.";
}

export function useEnclosureCatalog(token: string | null): EnclosureCatalogState {
  const initial = token && cached?.token === token ? cached.catalog : null;
  const [catalog, setCatalog] = useState<EnclosureCatalog | null>(initial);
  const [loading, setLoading] = useState<boolean>(!!token && initial === null);
  const [error, setError] = useState<string | null>(null);
  // Only the newest request of this mount lands; nothing lands after unmount.
  const sequence = useRef(0);

  const load = useCallback(
    async (force: boolean) => {
      const ticket = ++sequence.current;
      if (!token) {
        setCatalog(null);
        setLoading(false);
        return;
      }
      if (!force && cached?.token === token) {
        setCatalog(cached.catalog);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const next = await fetchShared(token, force);
        if (ticket !== sequence.current) return;
        setCatalog(next);
        setError(null);
      } catch (failure) {
        if (ticket !== sequence.current) return;
        setError(errorText(failure));
      } finally {
        if (ticket === sequence.current) setLoading(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load(false);
    return () => {
      sequence.current += 1;
    };
  }, [load]);

  const reload = useCallback(() => load(true), [load]);
  const index = useMemo(() => (catalog ? catalogIndex(catalog) : null), [catalog]);
  return { catalog, index, loading, error, reload };
}
