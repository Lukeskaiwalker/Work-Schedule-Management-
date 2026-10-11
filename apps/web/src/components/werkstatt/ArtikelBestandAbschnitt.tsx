/**
 * "Bestand" inside the edit dialog: the live counters, a counted stock and a
 * Wareneingang, booked from where the person already is.
 *
 * "Can not even change the stock when we added one … There should be a more
 * easy way to change something about it." The only working route to a stock
 * change used to be hidden inside "Neuer Artikel". Here it is two fields:
 *
 *   Gezählter Bestand  what is on the SHELF. Whatever is out on a job or at
 *                      repair is added back on (as in "Bestand anpassen"),
 *                      and the total goes as a stock-take with the displayed
 *                      total as `expected_total` — a count is a claim about
 *                      one observed figure, so it is refused (409) if that
 *                      figure moved meanwhile.
 *   Wareneingang +n    a delivery. Relative, so no lock: three boxes arrived
 *                      whatever the shelf did in the meantime.
 *
 * Nothing here computes a counter: the endpoint books a ledger movement and
 * answers with the row as it now stands, which is what is shown.
 *
 * The reason. A count is a stock CORRECTION — it writes off shrinkage as
 * readily as it books a find — so it is not booked until somebody typed why,
 * exactly as "Bestand anpassen" and the endpoint insist: a correction with no
 * reason is the ledger row nobody can explain a year later. A Wareneingang
 * only ever adds and its ledger kind already says "delivery", so there the
 * Beleg stays optional and an empty one is replaced by a sentence naming where
 * the booking came from (the endpoint requires a non-empty reason).
 */
import { useEffect, useId, useState } from "react";

import { ApiError } from "../../api/client";
import type { WerkstattArticle } from "../../types/werkstatt";
import {
  adjustArticleStock,
  type StockAdjustmentInput,
  type WerkstattArticleStockSnapshot,
} from "../../utils/werkstattArticlesApi";
import { MAX_ADJUSTMENT, offShelfCount, totalFromShelfCount } from "./stockAdjustment";
import { staleStockMessage, stockAdjustmentNotice } from "./stockNotices";
import { unitLabel } from "./unitLabel";

/** The ledger's sentence for a Wareneingang booked without a Beleg. German:
 *  the ledger is. A count has no such default — see the header. */
export const DEFAULT_RECEIPT_REASON = "Wareneingang im Artikeldialog";

export interface ArtikelBestandAbschnittProps {
  de: boolean;
  token: string | null;
  article: Pick<
    WerkstattArticle,
    | "id"
    | "item_name"
    | "stock_total"
    | "stock_available"
    | "stock_out"
    | "stock_repair"
    | "unit"
    | "is_archived"
  >;
  disabled?: boolean;
  /** The row the endpoint answered with — fold it into the dialog and list. */
  onBooked: (snapshot: WerkstattArticleStockSnapshot) => void;
  /** A 409: the figures on screen are stale. Refetch the article. */
  onStale: () => Promise<void> | void;
  /** The full "Bestand anpassen" dialog (Schwund / Defekt). */
  onOpenStockDialog?: () => void;
  /** True while a field holds something not booked yet, so the dialog can
   *  refuse to close over it. */
  onPendingChange?: (pending: boolean) => void;
}

/** A whole positive count from a field, or null. */
function wholeNumber(input: string): number | null {
  const text = input.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) && value <= MAX_ADJUSTMENT ? value : null;
}

export function ArtikelBestandAbschnitt({
  de,
  token,
  article,
  disabled = false,
  onBooked,
  onStale,
  onOpenStockDialog,
  onPendingChange,
}: ArtikelBestandAbschnittProps) {
  const [counted, setCounted] = useState("");
  const [receipt, setReceipt] = useState("");
  const [reason, setReason] = useState("");
  const [booking, setBooking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonHintId = useId();
  const reasonRuleId = useId();

  const pending = counted.trim() !== "" || receipt.trim() !== "";
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  const stock = { stock_total: article.stock_total, stock_available: article.stock_available };
  const unit = unitLabel(article.unit, de);
  const offShelf = offShelfCount(stock);
  const countedValue = wholeNumber(counted);
  const targetTotal = countedValue === null ? null : totalFromShelfCount(countedValue, stock);
  const receiptValue = wholeNumber(receipt);
  const locked = disabled || booking || article.is_archived;
  const reasonText = reason.trim();
  /** A typed count that would move the total — the only count worth booking,
   *  and the moment the reason becomes mandatory. */
  const countChanges = targetTotal !== null && targetTotal !== article.stock_total;
  const countNeedsReason = countChanges && reasonText === "";
  const offShelfWord =
    article.stock_repair > 0 ? (de ? "nicht im Regal" : "off the shelf") : de ? "unterwegs" : "out";

  async function book(request: StockAdjustmentInput, amount: number) {
    if (locked) return;
    setBooking(true);
    setError(null);
    setStatus(null);
    try {
      const snapshot = await adjustArticleStock(token, article.id, request);
      onBooked(snapshot);
      setStatus(
        stockAdjustmentNotice(
          {
            kind: request.kind,
            itemName: article.item_name,
            amount,
            confirmedTotalBefore: request.expectedTotal ?? null,
            totalAfter: snapshot.stock_total,
            availableAfter: snapshot.stock_available,
          },
          de,
        ),
      );
      if (request.kind === "inventory") setCounted("");
      else setReceipt("");
      setReason("");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const stale = err instanceof ApiError && err.status === 409;
      // The typed figure stays: it is checked against the refreshed counters.
      setError(stale ? staleStockMessage(detail, de) : detail);
      if (stale) await onStale();
    } finally {
      setBooking(false);
    }
  }

  const bookCount = () => {
    if (countedValue === null || targetTotal === null || reasonText === "") return;
    void book(
      {
        kind: "inventory",
        targetTotal,
        reason: reasonText,
        expectedTotal: article.stock_total,
      },
      countedValue,
    );
  };

  const bookReceipt = () => {
    if (receiptValue === null || receiptValue < 1) return;
    void book(
      { kind: "intake", quantity: receiptValue, reason: reasonText || DEFAULT_RECEIPT_REASON },
      receiptValue,
    );
  };

  return (
    <fieldset className="stock-edit-stock">
      <legend className="werkstatt-field-label">{de ? "Bestand" : "Stock"}</legend>

      <div className="stock-edit-counts">
        <b>
          {article.stock_available} / {article.stock_total} {unit}
        </b>
        <span className="muted">{de ? "verfügbar / gesamt" : "available / total"}</span>
        {article.stock_out > 0 && (
          <span className="stock-edit-chip">
            {article.stock_out} {de ? "unterwegs" : "out"}
          </span>
        )}
        {article.stock_repair > 0 && (
          <span className="stock-edit-chip">
            {article.stock_repair} {de ? "in Reparatur" : "in repair"}
          </span>
        )}
        {onOpenStockDialog && (
          <button
            type="button"
            className="werkstatt-card-action stock-edit-more"
            disabled={disabled || booking}
            onClick={onOpenStockDialog}
          >
            {de ? "Bestand anpassen" : "Adjust stock"}
          </button>
        )}
      </div>

      {article.is_archived && (
        <p className="muted stock-edit-note">
          {de
            ? "Archiviert — Bestand lässt sich erst nach „Reaktivieren“ buchen."
            : "Archived — stock can be booked once it is reactivated."}
        </p>
      )}

      <div className="stock-edit-actions">
        <div className="stock-edit-action">
          <label className="werkstatt-field">
            <span className="werkstatt-field-label">
              {de ? "Gezählter Bestand" : "Counted stock"}
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_ADJUSTMENT}
              className="werkstatt-field-input"
              value={counted}
              disabled={locked}
              placeholder={String(article.stock_available)}
              onChange={(event) => setCounted(event.target.value)}
            />
          </label>
          <small className="muted stock-edit-hint">
            {targetTotal === null
              ? de
                ? "im Regal gezählt"
                : "counted on the shelf"
              : offShelf > 0
                ? de
                  ? `+ ${offShelf} ${offShelfWord} = ${targetTotal} gesamt`
                  : `+ ${offShelf} ${offShelfWord} = ${targetTotal} total`
                : targetTotal === article.stock_total
                  ? de
                    ? "stimmt mit dem Bestand überein"
                    : "matches the stock"
                  : de
                    ? `${targetTotal} gesamt`
                    : `${targetTotal} total`}
          </small>
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={locked || !countChanges || countNeedsReason}
            aria-describedby={countNeedsReason && !locked ? reasonHintId : undefined}
            onClick={bookCount}
          >
            {de ? "Zählung buchen" : "Book count"}
          </button>
          {countNeedsReason && !locked && (
            <small id={reasonHintId} className="stock-edit-required">
              {de ? "Begründung erforderlich" : "Reason required"}
            </small>
          )}
        </div>

        <div className="stock-edit-action">
          <label className="werkstatt-field">
            <span className="werkstatt-field-label">{de ? "Wareneingang" : "Goods receipt"}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_ADJUSTMENT}
              className="werkstatt-field-input"
              value={receipt}
              disabled={locked}
              placeholder="+"
              onChange={(event) => setReceipt(event.target.value)}
            />
          </label>
          <small className="muted stock-edit-hint">
            {receiptValue !== null && receiptValue > 0
              ? de
                ? `danach ${article.stock_total + receiptValue} ${unit} gesamt`
                : `then ${article.stock_total + receiptValue} ${unit} in total`
              : de
                ? "Stück, die angekommen sind"
                : "pieces that arrived"}
          </small>
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={locked || receiptValue === null || receiptValue < 1}
            onClick={bookReceipt}
          >
            {de ? "Wareneingang buchen" : "Book receipt"}
          </button>
        </div>
      </div>

      <label className="werkstatt-field stock-edit-reason">
        <span className="werkstatt-field-label">
          {de ? "Begründung / Beleg" : "Reason / reference"}
          {countChanges && <span className="werkstatt-required">*</span>}
        </span>
        <input
          type="text"
          className="werkstatt-field-input"
          value={reason}
          disabled={locked}
          maxLength={500}
          aria-required={countChanges}
          aria-describedby={reasonRuleId}
          placeholder={
            de
              ? "z. B. Inventur Regal 3, Schwund, Lieferschein-Nr."
              : "e.g. stock-take shelf 3, shrinkage, delivery note no."
          }
          onChange={(event) => setReason(event.target.value)}
        />
      </label>
      <small id={reasonRuleId} className="muted stock-edit-hint stock-edit-reason-rule">
        {de
          ? "Pflicht für eine Zählung · beim Wareneingang optional"
          : "Required for a count · optional for a goods receipt"}
      </small>

      {status && !error && (
        <p className="stock-edit-status" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="stock-modal-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
