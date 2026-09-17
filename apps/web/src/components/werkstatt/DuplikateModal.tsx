/**
 * "Duplikate prüfen" — the review queue for articles that look like one item.
 *
 * The owner's words: "when an item from our catalog is present more than once
 * we should see that and merge them with the different article numbers." The
 * finding has existed server-side since the Werkstatt shipped and nothing ever
 * showed it, so the duplicates simply accumulated — two rows for one socket,
 * the stock split between them, each with a different supplier's number.
 *
 * Both answers are first-class. "Zusammenführen" opens a confirmation that
 * spells out what will move; "Kein Duplikat" is remembered server-side, so the
 * 1.5 mm² and the 2.5 mm² of the same cable stop being offered as a pair for
 * ever after one person has looked at them.
 *
 * Which side survives is a real decision, so it is a radio rather than an
 * assumption — defaulted to the side with an EAN (the identifier that makes
 * an article scannable), and to the fuller shelf when neither has one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError } from "../../api/client";
import type {
  WerkstattDuplicateCandidate,
  WerkstattDuplicateSide,
} from "../../types/werkstatt";
import {
  DUPLICATE_PAGE_LIMIT,
  dismissDuplicatePair,
  listDuplicateCandidates,
  mergeArticles,
  mergeSummary,
  restoreDuplicatePair,
} from "../../utils/werkstattDuplicatesApi";
import { ArtikelZusammenfuehrenModal } from "./ArtikelZusammenfuehrenModal";
import { unitLabel } from "./unitLabel";
import "../../styles/stock.css";

export interface DuplikateModalProps {
  open: boolean;
  language: "de" | "en";
  token: string | null;
  onClose: () => void;
  /** A merge changed the stock list; the page reloads and reports. */
  onMerged: (message: string) => void;
  onError: (message: string) => void;
}

/** The side to keep unless a person says otherwise. */
function defaultSurvivor(pair: WerkstattDuplicateCandidate): number {
  const left = pair.left;
  const right = pair.right;
  if (!left || !right) return pair.article_id;
  if (Boolean(left.ean) !== Boolean(right.ean)) return left.ean ? left.id : right.id;
  if (left.stock_total !== right.stock_total) {
    return left.stock_total > right.stock_total ? left.id : right.id;
  }
  return left.id;
}

export function DuplikateModal({
  open,
  language,
  token,
  onClose,
  onMerged,
  onError,
}: DuplikateModalProps) {
  const de = language === "de";
  const [pairs, setPairs] = useState<WerkstattDuplicateCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [survivors, setSurvivors] = useState<Record<string, number>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<WerkstattDuplicateCandidate | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);
  /* The pair just dismissed, kept for one undo. "Kein Duplikat" is persisted
   * and the row leaves the list immediately, so a mis-tap would otherwise be
   * silent and permanent — and the person would have no way to find the pair
   * again, because the queue no longer offers it. */
  const [undoable, setUndoable] = useState<WerkstattDuplicateCandidate | null>(null);
  const [truncated, setTruncated] = useState(false);

  /* The callers pass these as inline arrows, so they are a new function on
   * every parent render. Holding them in a ref keeps `reload` stable — without
   * it, the list is re-fetched (an O(n²) scan server-side) every time anything
   * on the page behind the dialog happens to re-render. */
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listDuplicateCandidates(token, DUPLICATE_PAGE_LIMIT);
      setPairs(rows);
      /* Exactly `limit` rows means the server had at least that many and may
       * have had more. The badge and this list ask for the same number now,
       * but a workshop past the cap still deserves to be told the queue was
       * cut off rather than to work through it and find the badge unchanged. */
      setTruncated(rows.length >= DUPLICATE_PAGE_LIMIT);
      setSurvivors(
        rows.reduce<Record<string, number>>((acc, pair) => {
          acc[pair.pair_key] = defaultSurvivor(pair);
          return acc;
        }, {}),
      );
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : String(err));
      setPairs([]);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!open) return;
    void reload();
  }, [open, reload]);

  const dismiss = useCallback(
    async (pair: WerkstattDuplicateCandidate) => {
      setBusyKey(pair.pair_key);
      try {
        await dismissDuplicatePair(token, pair.article_id, pair.duplicate_id);
        setPairs((prev) => prev.filter((row) => row.pair_key !== pair.pair_key));
        setUndoable(pair);
      } catch (err) {
        onErrorRef.current(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [token],
  );

  const runMerge = useCallback(async () => {
    if (!confirming) return;
    const survivorId = survivors[confirming.pair_key] ?? confirming.article_id;
    const duplicateId =
      survivorId === confirming.article_id ? confirming.duplicate_id : confirming.article_id;
    setBusyKey(confirming.pair_key);
    setMergeError(null);
    try {
      const result = await mergeArticles(token, survivorId, duplicateId);
      setConfirming(null);
      onMerged(mergeSummary(result, de));
      await reload();
    } catch (err) {
      setMergeError(
        err instanceof ApiError && typeof err.detail === "string"
          ? err.detail
          : err instanceof Error
            ? err.message
            : String(err),
      );
    } finally {
      setBusyKey(null);
    }
  }, [confirming, survivors, token, de, onMerged, reload]);

  const undoDismiss = useCallback(async () => {
    if (!undoable) return;
    setBusyKey(undoable.pair_key);
    try {
      await restoreDuplicatePair(token, undoable.article_id, undoable.duplicate_id);
      setUndoable(null);
      await reload();
    } catch (err) {
      onErrorRef.current(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }, [undoable, token, reload]);

  const confirmSides = useMemo(() => {
    if (!confirming || !confirming.left || !confirming.right) return null;
    const survivorId = survivors[confirming.pair_key] ?? confirming.article_id;
    const survivor = confirming.left.id === survivorId ? confirming.left : confirming.right;
    const duplicate = confirming.left.id === survivorId ? confirming.right : confirming.left;
    return { survivor, duplicate };
  }, [confirming, survivors]);

  if (!open) return null;

  const title = de ? "Duplikate prüfen" : "Review duplicates";

  return (
    /* The confirmation is a SIBLING of this backdrop, not a child of it.
     * Nested, its own backdrop click cleared `confirming` and then bubbled to
     * this one — so tapping beside a merge confirmation closed the whole
     * review queue and lost every survivor choice in it, at exactly the moment
     * somebody was being careful. */
    <>
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--wide stock-duplicates"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "WERKSTATT · BESTAND" : "WORKSHOP · STOCK"}
            </span>
            <h2 className="werkstatt-modal-title">{title}</h2>
            <small className="muted">
              {de
                ? "Paare, die dasselbe Produkt sein könnten. Nichts wird automatisch zusammengeführt."
                : "Pairs that might be the same product. Nothing is merged automatically."}
            </small>
          </div>
          <button
            type="button"
            className="werkstatt-modal-close"
            onClick={onClose}
            aria-label={de ? "Schließen" : "Close"}
          >
            ✕
          </button>
        </header>

        <div className="werkstatt-modal-body">
          {loading && <p className="muted">{de ? "Wird geprüft…" : "Checking…"}</p>}
          {!loading && pairs.length === 0 && (
            <p className="muted">
              {de
                ? "Keine Duplikate gefunden. Artikel mit zwei verschiedenen EANs sind zwei Produkte — die tauchen hier nie auf."
                : "No duplicates found. Two articles with different EANs are two products, so they never appear here."}
            </p>
          )}

          {truncated && (
            <p className="stock-duplicates-truncated muted" role="status">
              {de
                ? `Nur die ersten ${DUPLICATE_PAGE_LIMIT} Paare werden gezeigt — nach dem Zusammenführen erneut öffnen, um den Rest zu sehen.`
                : `Only the first ${DUPLICATE_PAGE_LIMIT} pairs are shown — reopen after merging to see the rest.`}
            </p>
          )}

          <ul className="stock-duplicates-list">
            {pairs.map((pair) => {
              const survivorId = survivors[pair.pair_key] ?? pair.article_id;
              const sides = [pair.left, pair.right].filter(Boolean) as WerkstattDuplicateSide[];
              return (
                <li key={pair.pair_key} className="stock-duplicates-pair">
                  <p className="stock-duplicates-reason">{pair.reason_de || pair.reason}</p>
                  <div className="stock-duplicates-sides">
                    {sides.map((side) => (
                      <label
                        key={side.id}
                        className={`stock-duplicates-card${survivorId === side.id ? " is-survivor" : ""}`}
                      >
                        <span className="stock-duplicates-keep">
                          <input
                            type="radio"
                            name={`survivor-${pair.pair_key}`}
                            checked={survivorId === side.id}
                            onChange={() =>
                              setSurvivors((prev) => ({ ...prev, [pair.pair_key]: side.id }))
                            }
                          />
                          {de ? "Behalten" : "Keep"}
                        </span>
                        <b>
                          {side.article_number} · {side.item_name}
                        </b>
                        <small className="muted">
                          {side.ean
                            ? `EAN ${side.ean}`
                            : side.internal_code
                              ? `Code ${side.internal_code}`
                              : de
                                ? "kein Code"
                                : "no code"}
                        </small>
                        <small>
                          {side.stock_available} / {side.stock_total}{" "}
                          {unitLabel(side.unit, de)}
                        </small>
                        <small className="muted">
                          {[side.category_name, side.location_name].filter(Boolean).join(" · ") ||
                            "—"}
                        </small>
                        {side.supplier_numbers.length > 0 && (
                          <small className="muted">
                            {de ? "Lieferanten-Nr.: " : "Supplier no.: "}
                            {side.supplier_numbers.join(", ")}
                          </small>
                        )}
                      </label>
                    ))}
                  </div>
                  <div className="stock-duplicates-actions">
                    <button
                      type="button"
                      className="werkstatt-action-btn"
                      disabled={busyKey === pair.pair_key}
                      onClick={() => void dismiss(pair)}
                    >
                      {de ? "Kein Duplikat" : "Not a duplicate"}
                    </button>
                    <button
                      type="button"
                      className="werkstatt-action-btn werkstatt-action-btn--primary"
                      disabled={busyKey === pair.pair_key || !pair.left || !pair.right}
                      onClick={() => {
                        setMergeError(null);
                        setConfirming(pair);
                      }}
                    >
                      {de ? "Zusammenführen" : "Merge"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>

        <footer className="werkstatt-modal-foot">
          <small className="muted">
            {pairs.length > 0
              ? de
                ? `${pairs.length} Paar(e) offen`
                : `${pairs.length} pair(s) open`
              : ""}
          </small>
          <div className="werkstatt-modal-foot-actions">
            {undoable && (
              <button
                type="button"
                className="werkstatt-card-action"
                disabled={busyKey === undoable.pair_key}
                onClick={() => void undoDismiss()}
              >
                {de
                  ? `„Kein Duplikat“ rückgängig (${undoable.article_number})`
                  : `Undo “not a duplicate” (${undoable.article_number})`}
              </button>
            )}
            <button type="button" className="werkstatt-action-btn" onClick={onClose}>
              {de ? "Schließen" : "Close"}
            </button>
          </div>
        </footer>
      </div>
    </div>

    {confirming && confirmSides && (
      <ArtikelZusammenfuehrenModal
        open
        language={language}
        survivor={confirmSides.survivor}
        duplicate={confirmSides.duplicate}
        busy={busyKey === confirming.pair_key}
        error={mergeError}
        onClose={() => {
          setConfirming(null);
          setMergeError(null);
        }}
        onConfirm={() => void runMerge()}
      />
    )}
    </>
  );
}
