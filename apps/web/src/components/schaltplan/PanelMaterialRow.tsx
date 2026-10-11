/**
 * One line of the Materialliste: label and detail, `scanned / planned`, the
 * status mark, the stock article it is checked off against, and — for
 * someone with reports:create — the booking buttons and the article search.
 *
 * The search is inline rather than a sheet: assigning an article is a
 * one-off per line kind ("device:mcb:1p:b16" means SP-0152 for every panel
 * from now on), so it should cost one tap and one word, not a dialog.
 */
import { useState } from "react";

import { ArticleSearchResults, useArticleSearch } from "./PanelArticleSearch";
import { PanelMaterialManualEditor } from "./PanelMaterialManualEditor";
import type { PanelMaterialLine, PanelMaterialLineStatus, PanelMaterialManualUpdate } from "../../types/schaltplan";
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
  /** A hand-added line only: change its quantity or note; resolves true once saved. */
  onUpdateManual: (body: PanelMaterialManualUpdate) => Promise<boolean>;
  onRemoveManual: () => void;
};

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
  const search = useArticleSearch(token, query);

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
      <ArticleSearchResults search={search} t={t} busy={busy} showIdleHint onPick={(article) => onPick(article.id)} />
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
  // An extra line IS an article, and a hand-added one names its own: neither
  // key is a planned line the global mapping could mean.
  const mappable = canEdit && line.kind !== "extra" && line.kind !== "manual";

  if (!line.article) {
    return (
      <div className="sp-mat-article sp-mat-article--none">
        <span>{line.kind === "manual" ? t.freeText : t.noArticle}</span>
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

function LineText({
  line,
  t,
  editable,
  busy,
  onEdit,
  onRemove,
}: {
  line: PanelMaterialLine;
  t: MaterialTexts;
  editable: boolean;
  busy: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  if (line.kind !== "manual") {
    return (
      <div className="sp-mat-main">
        <b>{line.label}</b>
        {line.detail && <small>{line.detail}</small>}
      </div>
    );
  }
  // A hand-added line: the mark and its own note — never the server's
  // "manuell" fallback detail, which would say the same thing twice.
  return (
    <div className="sp-mat-main">
      <b>{line.label}</b>
      <small className="sp-mat-manual-meta">
        <span className="sp-mat-chip sp-mat-chip--manual">{t.manual}</span>
        {line.note && <span>{line.note}</span>}
      </small>
      {editable && (
        <span className="sp-mat-manual-actions">
          <button type="button" className="sp-mat-link" disabled={busy} title={t.editManualTitle} onClick={onEdit}>
            {t.editManual}
          </button>
          <button type="button" className="sp-mat-link" disabled={busy} title={t.removeManualTitle} onClick={onRemove}>
            {t.removeManual}
          </button>
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
  onUpdateManual,
  onRemoveManual,
}: RowProps) {
  const canBook = canEdit && line.article !== null;
  const editable = canEdit && line.kind === "manual" && line.manual_id != null;
  // A free text has no article to scan: its quantity, no "0 /" that never
  // moves (the server leaves it out of the picking totals too).
  const freeText = line.kind === "manual" && line.article === null;
  const [editing, setEditing] = useState(false);

  return (
    <li className={`sp-mat-row sp-mat-row--${line.status}`} data-key={line.key}>
      <LineText
        line={line}
        t={t}
        editable={editable && !editing}
        busy={busy}
        onEdit={() => setEditing(true)}
        onRemove={onRemoveManual}
      />

      <div className="sp-mat-qty">
        <span className="sp-mat-qty-scanned">{freeText ? "—" : line.scanned}</span>
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

      {editable && editing && (
        <PanelMaterialManualEditor
          line={line}
          t={t}
          busy={busy}
          onSave={async (body) => {
            if (await onUpdateManual(body)) setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      )}
    </li>
  );
}
