/**
 * The stock-article search the Materialliste uses twice: to tell every board
 * which article a planned line means (the row's mapping search), and to add
 * an article to one board by hand (the add form). One debounce, one result
 * list, so both behave the same under a slow connection.
 */
import { useEffect, useState } from "react";

import { listArticles, type WerkstattArticleLite } from "../../utils/werkstattArticlesApi";
import type { MaterialTexts } from "./panelMaterialTexts";

export const SEARCH_MIN_CHARS = 2;
const SEARCH_DELAY_MS = 250;
const SEARCH_LIMIT = 8;

export type ArticleSearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "error" }
  | { status: "ready"; rows: WerkstattArticleLite[] };

/** Search as the user types: nothing under two characters, 250 ms quiet before asking. */
export function useArticleSearch(token: string | null, query: string): ArticleSearchState {
  const [search, setSearch] = useState<ArticleSearchState>({ status: "idle" });
  const trimmed = query.trim();

  useEffect(() => {
    if (trimmed.length < SEARCH_MIN_CHARS) {
      setSearch({ status: "idle" });
      return undefined;
    }
    let cancelled = false;
    setSearch({ status: "searching" });
    const timer = window.setTimeout(() => {
      listArticles(token, { q: trimmed, kind: "consumable", limit: SEARCH_LIMIT })
        .then((rows) => {
          if (!cancelled) setSearch({ status: "ready", rows });
        })
        .catch(() => {
          if (!cancelled) setSearch({ status: "error" });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [token, trimmed]);

  return search;
}

type ResultsProps = {
  search: ArticleSearchState;
  t: MaterialTexts;
  busy: boolean;
  /** "Mindestens 2 Zeichen" — wrong in the add form, where one word is a valid free text. */
  showIdleHint: boolean;
  onPick: (article: WerkstattArticleLite) => void;
};

export function ArticleSearchResults({ search, t, busy, showIdleHint, onPick }: ResultsProps) {
  if (search.status === "idle") {
    return showIdleHint ? <small className="sp-mat-search-hint">{t.searchHint}</small> : null;
  }
  if (search.status === "searching") {
    return (
      <small className="sp-mat-search-hint" role="status">
        {t.searching}
      </small>
    );
  }
  if (search.status === "error") {
    return (
      <small className="sp-mat-search-hint sp-mat-search-hint--error" role="alert">
        {t.searchFailed}
      </small>
    );
  }
  if (search.rows.length === 0) return <small className="sp-mat-search-hint">{t.searchEmpty}</small>;
  return (
    <ul className="sp-mat-search-results" aria-label={t.searchResults}>
      {search.rows.map((article) => (
        <li key={article.id}>
          <button type="button" className="sp-mat-search-result" disabled={busy} onClick={() => onPick(article)}>
            <span className="sp-mat-article-no">{article.article_number}</span>
            <span className="sp-mat-search-result-name">{article.item_name}</span>
            <span className="sp-mat-search-result-stock">{`${t.stock} ${article.stock_available}`}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
