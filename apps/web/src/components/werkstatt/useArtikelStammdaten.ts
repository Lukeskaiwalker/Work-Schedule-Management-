/**
 * The three lists every article form needs, loaded once per opening.
 *
 * Categories, locations and suppliers are small, change rarely, and are
 * needed by both the create dialog and the edit dialog. Fetching them in a
 * hook rather than in each modal keeps the two from drifting into different
 * ideas of what "no category" means, and keeps either file from growing a
 * loading state that is really the same loading state.
 *
 * Failure is deliberately soft. A supplier list that does not load must not
 * stop somebody entering the article they are holding: the selects degrade to
 * "— keiner —" and everything else still saves. The one thing it must not do
 * is pretend — `error` says the lists are incomplete so the dialog can show it.
 */
import { useCallback, useEffect, useState } from "react";

import type {
  WerkstattCategory,
  WerkstattLocation,
  WerkstattSupplier,
} from "../../types/werkstatt";
import { listCategories, listLocations } from "../../utils/werkstattTaxonomyApi";
import { listSuppliers } from "../../utils/werkstattSuppliersApi";

export interface ArtikelStammdaten {
  categories: WerkstattCategory[];
  locations: WerkstattLocation[];
  suppliers: WerkstattSupplier[];
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** Fold a freshly created row in without a refetch, so the select can be
   *  set to it in the same tick the dialog closes. Immutable. */
  addCategory: (category: WerkstattCategory) => void;
  addLocation: (location: WerkstattLocation) => void;
}

export function useArtikelStammdaten(token: string | null, active: boolean): ArtikelStammdaten {
  const [categories, setCategories] = useState<WerkstattCategory[]>([]);
  const [locations, setLocations] = useState<WerkstattLocation[]>([]);
  const [suppliers, setSuppliers] = useState<WerkstattSupplier[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextCategories, nextLocations, nextSuppliers] = await Promise.all([
        listCategories(token),
        listLocations(token),
        listSuppliers(token),
      ]);
      setCategories(nextCategories);
      setLocations(nextLocations);
      setSuppliers(nextSuppliers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!active) return;
    void reload();
  }, [active, reload]);

  const addCategory = useCallback((category: WerkstattCategory) => {
    setCategories((prev) =>
      [...prev.filter((row) => row.id !== category.id), category].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    );
  }, []);

  const addLocation = useCallback((location: WerkstattLocation) => {
    setLocations((prev) =>
      [...prev.filter((row) => row.id !== location.id), location].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    );
  }, []);

  return {
    categories,
    locations,
    suppliers,
    loading,
    error,
    reload,
    addCategory,
    addLocation,
  };
}
