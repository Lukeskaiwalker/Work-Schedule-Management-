/**
 * One line of the Materialliste: label and detail, `scanned / planned`, the
 * status mark, the stock article it is checked off against, and — for
 * someone with reports:create — the booking buttons and the article search.
 *
 * The search is inline rather than a sheet: assigning an article is a
 * one-off per line kind ("device:mcb:1p:b16" means SP-0152 for every panel
 * from now on), so it should cost one tap and one word, not a dialog.
 */
import { useEffect, useState } from "react";

import { listArticles, type WerkstattArticleLite } from "../../utils/werkstattArticlesApi";
import type { PanelMaterialLine, PanelMaterialLineStatus } from "../../types/schaltplan";
import type { MaterialTexts } from "./panelMaterialTexts";

type RowProps = {
  line: PanelMaterialLine;
  token: string | null;
  canEdit: boolean;
  t: MaterialTexts;
  /** A request is running somewhere in the list; every write waits for it. */
  busy: boolean;
  mappingOpen: boolean;
  onOpenMapping: () => void;
  onCloseMapping: () => void;
  onAssign: (articleId: number | null) => void;
  onBook: (direction: 1 | -1) => void;
};

const SEARCH_MIN_CHARS = 2;
const SEARCH_DELAY_MS = 250;
const SEARCH_LIMIT = 8;

type SearchState =
  | { status: "idle" }
  | { status: "searching" }
  | { status: "error" }
  | { status: "ready"; rows: WerkstattArticleLite[] };

function StatusMark({ status, t }: { status: PanelMaterialLineStatus; t: MaterialTexts }) {
  if (status === "done") {
    return (
      <span className="sp-mat-tick" role="img" aria-label={t.done}>
        ✓
      </span>
    );
  }
  if (status === "over") return <span className="sp-mat-chip sp-mat-chip--over">{t.over}</span>;
  if (status === "unplanned") return <span className="sp-mat-chip sp-mat-chip--extra">{t.unplanned}</span>;
  return null;
}

type SearchProps = {
  token: string | null;
  t: MaterialTexts;
  busy: boolean;
  onPick: (articleId: number) => void;
  onCancel: () => void;
};

function ArticleSearch({ token, t, busy, onPick, onCancel }: SearchProps) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
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

  return (
    <div className="sp-mat-search">
      <div className="sp-mat-search-bar">
        <input
          type="search"
          className="sp-mat-search-input"
          aria-label={t.searchLabel}
          placeholder={t.searchPlaceholder}
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="sp-btn sp-btn--ghost sp-mat-search-cancel" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
      {search.status === "idle" && <small className="sp-mat-search-hint">{t.searchHint}</small>}
      {search.status === "searching" && (
        <small className="sp-mat-search-hint" role="status">
          {t.searching}
        </small>
      )}
      {search.status === "error" && (
        <small className="sp-mat-search-hint sp-mat-search-hint--error" role="alert">
          {t.searchFailed}
        </small>
      )}
      {search.status === "ready" && search.rows.length === 0 && (
        <small className="sp-mat-search-hint">{t.searchEmpty}</small>
      )}
      {search.status === "ready" && search.rows.length > 0 && (
        <ul className="sp-mat-search-results" aria-label={t.searchLabel}>
          {search.rows.map((article) => (
            <li key={article.id}>
              <button
                type="button"
                className="sp-mat-search-result"
                disabled={busy}
                onClick={() => onPick(article.id)}
              >
                <span className="sp-mat-article-no">{article.article_number}</span>
                <span className="sp-mat-search-result-name">{article.item_name}</span>
                <span className="sp-mat-search-result-stock">{`${t.stock} ${article.stock_available}`}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ArticleCell({
  line,
  canEdit,
  t,
  busy,
  onOpenMapping,
  onAssign,
}: Pick<RowProps, "line" | "canEdit" | "t" | "busy" | "onOpenMapping" | "onAssign">) {
  // An extra line IS an article; its key is not a planned line anybody maps.
  const mappable = canEdit && line.kind !== "extra";

  if (!line.article) {
    return (
      <div className="sp-mat-article sp-mat-article--none">
        <span>{t.noArticle}</span>
        {mappable && (
          <button type="button" className="sp-mat-link" disabled={busy} onClick={onOpenMapping}>
            {t.assign}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="sp-mat-article">
      <span className="sp-mat-article-no">{line.article.article_number}</span>
      <span className="sp-mat-article-name" title={line.article.item_name}>
        {line.article.item_name}
      </span>
      {line.article_source === "auto" && (
        <span className="sp-mat-auto" title={t.autoTitle}>
          {t.auto}
        </span>
      )}
      {mappable && (
        <span className="sp-mat-article-actions">
          <button type="button" className="sp-mat-link" disabled={busy} onClick={onOpenMapping}>
            {t.change}
          </button>
          {line.article_source === "mapping" && (
            <button type="button" className="sp-mat-link" disabled={busy} onClick={() => onAssign(null)}>
              {t.remove}
            </button>
          )}
        </span>
      )}
    </div>
  );
}

export function PanelMaterialRow({
  line,
  token,
  canEdit,
  t,
  busy,
  mappingOpen,
  onOpenMapping,
  onCloseMapping,
  onAssign,
  onBook,
}: RowProps) {
  const canBook = canEdit && line.article !== null;

  return (
    <li className={`sp-mat-row sp-mat-row--${line.status}`} data-key={line.key}>
      <div className="sp-mat-main">
        <b>{line.label}</b>
        {line.detail && <small>{line.detail}</small>}
      </div>

      <div className="sp-mat-qty">
        <span className="sp-mat-qty-scanned">{line.scanned}</span>
        <small>{` / ${line.planned}`}</small>
      </div>

      <div className="sp-mat-state">
        <StatusMark status={line.status} t={t} />
      </div>

      <ArticleCell
        line={line}
        canEdit={canEdit}
        t={t}
        busy={busy}
        onOpenMapping={onOpenMapping}
        onAssign={onAssign}
      />

      <div className="sp-mat-actions">
        {canBook && (
          <>
            <button
              type="button"
              className="sp-mat-qty-btn"
              disabled={busy || line.scanned <= 0}
              title={t.unbookOne}
              onClick={() => onBook(-1)}
            >
              −1
            </button>
            <button
              type="button"
              className="sp-mat-qty-btn sp-mat-qty-btn--plus"
              disabled={busy}
              title={t.bookOne}
              onClick={() => onBook(1)}
            >
              +1
            </button>
          </>
        )}
      </div>

      {mappingOpen && (
        <ArticleSearch token={token} t={t} busy={busy} onPick={onAssign} onCancel={onCloseMapping} />
      )}
    </li>
  );
}
