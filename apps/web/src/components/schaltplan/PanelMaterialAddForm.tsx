/**
 * "Material hinzufügen": a shelf article or a free text, with a quantity and
 * an optional note, onto this one board (owner, 2026-10-09) — for what the
 * plan cannot derive: wiring duct, cable ties, ferrules, a spare breaker.
 *
 * One field does both jobs: typing searches the shelf, picking a result makes
 * it the article, and whatever is typed without a pick goes in as free text.
 * The form stays open after each line — the duct, the ties and the ferrules
 * go in one after another — and says what it added.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";

import { ArticleSearchResults, useArticleSearch } from "./PanelArticleSearch";
import { MANUAL_LABEL_MAX, MANUAL_NOTE_MAX, MANUAL_QUANTITY_MAX, parseManualQuantity } from "./manualQuantity";
import type { WerkstattArticleLite } from "../../utils/werkstattArticlesApi";
import type { PanelMaterialManualInput } from "../../types/schaltplan";
import type { MaterialTexts } from "./panelMaterialTexts";

type Props = {
  token: string | null;
  t: MaterialTexts;
  busy: boolean;
  /** Resolves true once the line is on the list; false keeps what was typed. */
  onAdd: (body: PanelMaterialManualInput) => Promise<boolean>;
  onClose: () => void;
};

function requestBody(
  picked: WerkstattArticleLite | null,
  freeText: string,
  quantity: number,
  note: string,
): PanelMaterialManualInput {
  const base = picked
    ? { article_id: picked.id, quantity }
    : { label: freeText.slice(0, MANUAL_LABEL_MAX), quantity };
  return note ? { ...base, note } : base;
}

export function PanelMaterialAddForm({ token, t, busy, onAdd, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<WerkstattArticleLite | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Bumped to put the cursor back into the search — after the render that
  // brings the input back (it is unmounted while an article is picked).
  const [focusTick, setFocusTick] = useState(0);
  useEffect(() => {
    if (focusTick > 0) searchRef.current?.focus();
  }, [focusTick]);
  // No search while an article is picked: the results would sit under it unused.
  const search = useArticleSearch(token, picked ? "" : query);
  const freeText = query.trim();
  const parsed = parseManualQuantity(quantity);
  const ready = !busy && parsed !== null && (picked !== null || freeText.length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || parsed === null) return;
    const name = picked ? picked.item_name : freeText;
    if (!(await onAdd(requestBody(picked, freeText, parsed, note.trim())))) return;
    setQuery("");
    setPicked(null);
    setQuantity("1");
    setNote("");
    setAdded(name);
    setFocusTick((tick) => tick + 1);
  };

  const pickAnother = () => {
    setPicked(null);
    setFocusTick((tick) => tick + 1);
  };

  return (
    <form className="sp-mat-form sp-mat-add" aria-label={t.addMaterial} onSubmit={(event) => void submit(event)}>
      {picked ? (
        <div className="sp-mat-picked">
          <span className="sp-mat-picked-label">{t.pickedArticle}</span>
          <span className="sp-mat-article-no">{picked.article_number}</span>
          <span className="sp-mat-picked-name">{picked.item_name}</span>
          <button type="button" className="sp-mat-link" onClick={pickAnother}>
            {t.pickAnother}
          </button>
        </div>
      ) : (
        <>
          <input
            ref={searchRef}
            type="search"
            className="sp-mat-search-input"
            aria-label={t.addSearchLabel}
            placeholder={t.addSearchPlaceholder}
            maxLength={MANUAL_LABEL_MAX}
            value={query}
            autoFocus
            onChange={(event) => {
              setQuery(event.target.value);
              setAdded(null);
            }}
          />
          {freeText && <small className="sp-mat-search-hint">{t.freeTextHint(freeText)}</small>}
          <ArticleSearchResults
            search={search}
            t={t}
            busy={busy}
            showIdleHint={false}
            onPick={(article) => setPicked(article)}
          />
        </>
      )}

      <div className="sp-mat-form-fields">
        <label className="sp-mat-field sp-mat-field--qty">
          <span>{t.quantity}</span>
          <input
            type="number"
            className="sp-mat-input"
            inputMode="numeric"
            min={1}
            max={MANUAL_QUANTITY_MAX}
            step={1}
            value={quantity}
            aria-invalid={parsed === null}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </label>
        <label className="sp-mat-field sp-mat-field--note">
          <span>{t.note}</span>
          <input
            type="text"
            className="sp-mat-input"
            maxLength={MANUAL_NOTE_MAX}
            placeholder={t.notePlaceholder}
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <div className="sp-mat-form-actions">
          <button type="submit" className="sp-btn sp-btn--primary" disabled={!ready}>
            {t.addSubmit}
          </button>
          <button type="button" className="sp-btn sp-btn--ghost" onClick={onClose}>
            {t.close}
          </button>
        </div>
      </div>
      {parsed === null && <small className="sp-mat-search-hint sp-mat-search-hint--error">{t.quantityInvalid}</small>}
      {added && (
        <small className="sp-mat-added" role="status">
          {t.added(added)}
        </small>
      )}
    </form>
  );
}
