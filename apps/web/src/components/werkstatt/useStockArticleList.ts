/**
 * The Bestand page's list request: debounced, server-searched, newest-wins.
 *
 * Lifted out of WerkstattInventarPage (past its size budget) because the two
 * rules that make the search trustworthy live here and nowhere else:
 *
 *   - **The server is the only text filter.** `q` goes to
 *     `GET /werkstatt/articles`, which matches name, SP number, EAN, our own
 *     code, manufacturer, category, location and every supplier's article
 *     number. The page used to filter the answer AGAIN by name/number/category/
 *     location, so a hit by EAN or supplier number came back and was thrown
 *     away — and so did the article just created after a scan miss, because
 *     the scanned EAN was still in the box. Category, location and status
 *     chips remain client-side; they are exact selections, not text.
 *   - **Only the newest request may paint.** A slow answer to "ka" landing
 *     after the answer to "kabel" used to replace it. Each request takes a
 *     ticket; a response whose ticket is no longer current drops itself.
 */
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

import { createRequestSequence } from "../../utils/latestRequest";
import { listArticles, type WerkstattArticleLite } from "../../utils/werkstattArticlesApi";

/** Typing pause before a search goes out. An empty box loads at once. */
export const STOCK_SEARCH_DEBOUNCE_MS = 250;

export interface StockArticleListOptions {
  /** False while the tab is not shown: nothing is fetched. */
  active: boolean;
  token: string | null;
  search: string;
  showArchived: boolean;
  limit: number;
}

export interface StockArticleList {
  articles: WerkstattArticleLite[];
  /** For folding a write's answer into the list without a refetch. */
  setArticles: Dispatch<SetStateAction<WerkstattArticleLite[]>>;
  loading: boolean;
  loadError: string | null;
  reload: () => Promise<void>;
}

export function useStockArticleList({
  active,
  token,
  search,
  showArchived,
  limit,
}: StockArticleListOptions): StockArticleList {
  const [articles, setArticles] = useState<WerkstattArticleLite[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sequence = useMemo(() => createRequestSequence(), []);

  const reload = useCallback(async () => {
    if (!active) return;
    const ticket = sequence.issue();
    setLoading(true);
    try {
      // Consumables only. The Bestand page is "what we use up"; machine TYPES
      // live in the Maschinen tab, where units carry their own labels and
      // inspection dates. Filtered server-side so the counts under the filter
      // chips describe the list somebody is actually looking at.
      const rows = await listArticles(token, {
        q: search.trim() || undefined,
        kind: "consumable",
        // Archived rows are out of the way by default and reachable on
        // demand: "Archivieren" promises the article can be brought back.
        includeArchived: showArchived,
        limit,
      });
      if (!sequence.isCurrent(ticket)) return;
      setArticles(rows);
      setLoadError(null);
    } catch (err) {
      if (!sequence.isCurrent(ticket)) return;
      // An empty table must never be mistaken for "no stock" — that is exactly
      // the failure this page shipped with.
      setArticles([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      if (sequence.isCurrent(ticket)) setLoading(false);
    }
  }, [active, token, search, showArchived, limit, sequence]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), search ? STOCK_SEARCH_DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [reload, search]);

  return { articles, setArticles, loading, loadError, reload };
}
