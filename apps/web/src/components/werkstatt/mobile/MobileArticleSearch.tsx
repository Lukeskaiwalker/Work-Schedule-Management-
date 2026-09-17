import { useEffect, useMemo, useState } from "react";

import { listArticles, type WerkstattArticleLite } from "../../../utils/werkstattArticlesApi";
import { createRequestSequence } from "../../../utils/latestRequest";
import { unitLabel } from "../unitLabel";

/**
 * MobileArticleSearch — the search field on the phone start screen.
 *
 * The field was drawn on the Paper artboard and shipped inert: tapping it
 * raised a keyboard and typing did nothing. On a phone that reads as a broken
 * app, so it now searches stock for real through `GET /werkstatt/articles`.
 *
 * Scoped to consumables. Machine TYPES have their own register (and their own
 * per-unit labels), and dropping somebody onto an article screen that cannot
 * book a machine out would be a worse answer than saying where machines live —
 * which the empty state does.
 */
const MIN_QUERY = 2;
const RESULT_LIMIT = 10;
/** Long enough that a typed word is one request, short enough to feel live. */
const DEBOUNCE_MS = 300;

export interface MobileArticleSearchProps {
  token: string | null;
  language: "de" | "en";
  onOpenArticle: (articleId: number) => void;
}

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "error"; message: string }
  | { status: "done"; rows: ReadonlyArray<WerkstattArticleLite> };

export function MobileArticleSearch({
  token,
  language,
  onOpenArticle,
}: MobileArticleSearchProps) {
  const de = language === "de";
  const [query, setQuery] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });
  // A slow answer to "kab" must not land on top of the answer to "kabel".
  const sequence = useMemo(() => createRequestSequence(), []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY) {
      // Issue a ticket so an in-flight search cannot repaint a cleared field.
      sequence.issue();
      setState({ status: "idle" });
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const ticket = sequence.issue();
      setState({ status: "searching" });
      listArticles(token, { q: trimmed, kind: "consumable", limit: RESULT_LIMIT })
        .then((rows) => {
          if (!sequence.isCurrent(ticket)) return;
          setState({ status: "done", rows });
        })
        .catch((err: unknown) => {
          if (!sequence.isCurrent(ticket)) return;
          setState({
            status: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [query, token, sequence]);

  return (
    <div className="werkstatt-mobile-searchblock">
      {/* A div, not a label: the clear button is interactive content, which a
          label may not contain. The input carries its own accessible name. */}
      <div className="werkstatt-mobile-search">
        <span className="werkstatt-mobile-search-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m16 16 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        <input
          type="search"
          className="werkstatt-mobile-search-input"
          aria-label={de ? "Artikel suchen" : "Search articles"}
          placeholder={de ? "Artikel oder Nummer suchen…" : "Search article or number…"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {/* The slot used to hold a filter glyph that was not a control. It now
            holds one that is — and only while there is something to clear. */}
        {query !== "" && (
          <button
            type="button"
            className="werkstatt-mobile-search-clear"
            aria-label={de ? "Suche leeren" : "Clear search"}
            onClick={() => setQuery("")}
          >
            ✕
          </button>
        )}
      </div>

      {state.status === "searching" && (
        <p className="werkstatt-mobile-note" role="status">
          {de ? "Suche läuft…" : "Searching…"}
        </p>
      )}

      {state.status === "error" && (
        <p className="werkstatt-mobile-note werkstatt-mobile-note--error" role="alert">
          {de ? `Suche fehlgeschlagen: ${state.message}` : `Search failed: ${state.message}`}
        </p>
      )}

      {state.status === "done" && state.rows.length === 0 && (
        <p className="werkstatt-mobile-note">
          {de
            ? "Keine Lagerartikel gefunden — Maschinen stehen unter „Maschinen“."
            : "No stock items found — machines live under “Maschinen”."}
        </p>
      )}

      {state.status === "done" && state.rows.length > 0 && (
        <ul className="werkstatt-mobile-searchresults">
          {state.rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="werkstatt-mobile-searchresult"
                onClick={() => onOpenArticle(row.id)}
              >
                <span className="werkstatt-mobile-searchresult-text">
                  <span className="werkstatt-mobile-searchresult-title">{row.item_name}</span>
                  <span className="werkstatt-mobile-searchresult-meta">
                    {`${row.article_number} · ${row.stock_available} ${unitLabel(row.unit, de)} ${
                      de ? "verfügbar" : "available"
                    }`}
                  </span>
                </span>
                <span className="werkstatt-mobile-searchresult-chevron" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M9 6l6 6-6 6"
                      stroke="#5C7895"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
