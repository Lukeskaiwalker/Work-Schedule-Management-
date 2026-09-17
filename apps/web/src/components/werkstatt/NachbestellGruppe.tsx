/**
 * One supplier's reorder suggestions on the desktop screen.
 *
 * A group is also the unit of ordering: `POST /werkstatt/reorder/submit` takes
 * exactly one `supplier_id`, so the "Bestellen bei …" button lives in the
 * group header and there is deliberately no page-wide send button that would
 * have to fan out behind the buyer's back.
 *
 * Lines the buyer has zeroed stay visible but leave the basket — the server
 * refuses a quantity below 1, so they are not submitted at all.
 *
 * The "Bestellen bei …" button is gone for as long as re-sending could
 * duplicate a real order (`resendBlocked`): after a success, while a request
 * is in flight, and after a failure whose outcome nobody knows. Dismissing the
 * panel is the only way back to it.
 */
import type { ReorderSendState } from "../../hooks/useReorderBasket";
import {
  currencySymbol,
  formatCents,
  formatUnitPrice,
  severityOf,
  shortSupplierName,
  leadTimeLabel,
  type ReorderGroupTotals,
} from "../../utils/reorderBasket";
import { resendBlocked, type OrderedQuantities } from "../../utils/reorderSendState";
import type {
  ReorderSuggestionGroup,
  ReorderSuggestionLine,
} from "../../utils/werkstattReorderApi";
import { ReorderQuantityField } from "./ReorderQuantityField";
import { ReorderSendPanel, type ReorderExportAction } from "./ReorderSendPanel";

export interface NachbestellGruppeProps {
  group: ReorderSuggestionGroup;
  de: boolean;
  language: "de" | "en";
  canManage: boolean;
  busy: boolean;
  totals: ReorderGroupTotals;
  sendState: ReorderSendState | null;
  quantityFor: (line: ReorderSuggestionLine) => number;
  onStep: (line: ReorderSuggestionLine, delta: number) => void;
  onSetQuantity: (line: ReorderSuggestionLine, quantity: number) => void;
  onSubmit: (allowUnresolved: boolean) => void;
  onDismiss: () => void;
  onOpenOrders?: () => void;
  exportAction?: ReorderExportAction;
}

export function NachbestellGruppe({
  group,
  de,
  language,
  canManage,
  busy,
  totals,
  sendState,
  quantityFor,
  onStep,
  onSetQuantity,
  onSubmit,
  onDismiss,
  onOpenOrders,
  exportAction,
}: NachbestellGruppeProps) {
  const sent = sendState?.kind === "sent";
  const sending = sendState?.kind === "sending";
  // Hidden while a second send would risk a duplicate — but NOT while this
  // group's own request is in flight: there the button stays, disabled, and
  // says what it is doing.
  const hideSubmit = resendBlocked(sendState) && !sending;
  const leadTime = leadTimeLabel(group, de);
  // The order this group already produced, if any. A reload replaces the
  // suggested quantities, so the locked numbers come from the order itself.
  const orderedQuantities: OrderedQuantities | null =
    sendState?.kind === "sent" ? sendState.orderedQuantities : null;
  const alreadyOrdered =
    sendState?.kind === "sent" && sendState.carriedOver ? sendState.order.order_number : null;

  return (
    <article className="werkstatt-nachbestell-group">
      <header className="werkstatt-nachbestell-group-head">
        <div className="werkstatt-nachbestell-group-identity">
          <div className="werkstatt-nachbestell-group-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
              <path d="M3.5 9.5h17" />
            </svg>
          </div>
          <div>
            <h3 className="werkstatt-nachbestell-group-name">{group.supplier_name}</h3>
            <p className="werkstatt-nachbestell-group-meta">
              {group.lines.length} {de ? "Artikel unter Mindestbestand" : "items below minimum"}
              {totals.positionCount !== group.lines.length
                ? ` · ${totals.positionCount} ${de ? "im Warenkorb" : "in the basket"}`
                : ""}
              {leadTime ? ` · ${leadTime}` : ""}
              {alreadyOrdered
                ? ` · ${de ? "bereits bestellt" : "already ordered"}: ${alreadyOrdered}`
                : ""}
            </p>
          </div>
        </div>
        <div className="werkstatt-nachbestell-group-totals">
          <div>
            <span className="werkstatt-nachbestell-group-subtotal-label">
              {de ? "ZWISCHENSUMME" : "SUBTOTAL"}
            </span>
            <span className="werkstatt-nachbestell-group-subtotal">
              {formatCents(totals.cents, group.currency, language)}
            </span>
            {totals.unpricedCount > 0 && (
              <span className="reorder-unpriced-note">
                {de
                  ? `zzgl. ${totals.unpricedCount} ${totals.unpricedCount === 1 ? "Position" : "Positionen"} ohne Preis`
                  : `plus ${totals.unpricedCount} ${totals.unpricedCount === 1 ? "line" : "lines"} without a price`}
              </span>
            )}
          </div>
          {canManage && !hideSubmit && (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              disabled={busy || sending || totals.positionCount === 0}
              onClick={() => onSubmit(false)}
              title={
                totals.positionCount === 0
                  ? de
                    ? "Keine Position mit Menge — nichts zu bestellen"
                    : "No line with a quantity — nothing to order"
                  : undefined
              }
            >
              {sending
                ? de
                  ? "Wird übergeben…"
                  : "Submitting…"
                : de
                  ? `Bestellen bei ${shortSupplierName(group)} →`
                  : `Order from ${shortSupplierName(group)} →`}
            </button>
          )}
        </div>
      </header>

      {sendState && (
        <ReorderSendPanel
          group={group}
          state={sendState}
          de={de}
          busy={busy}
          onOverride={() => onSubmit(true)}
          onRetry={() => onSubmit(false)}
          onDismiss={onDismiss}
          onOpenOrders={onOpenOrders}
          exportAction={exportAction}
        />
      )}

      <ul className="werkstatt-nachbestell-lines">
        {group.lines.map((line) => (
          <NachbestellZeile
            key={line.article_id}
            line={line}
            group={group}
            de={de}
            language={language}
            locked={sent || sending}
            quantity={quantityFor(line)}
            ordered={sent}
            orderedQuantity={orderedQuantities?.get(line.article_id) ?? null}
            onStep={onStep}
            onSetQuantity={onSetQuantity}
          />
        ))}
      </ul>
    </article>
  );
}

interface NachbestellZeileProps {
  line: ReorderSuggestionLine;
  group: ReorderSuggestionGroup;
  de: boolean;
  language: "de" | "en";
  /** Sent or in flight: the quantity is part of an order now, not a draft. */
  locked: boolean;
  quantity: number;
  /** An order exists for this group — the numbers below belong to it. */
  ordered: boolean;
  /**
   * What this article was ordered with, once an order exists. Null while the
   * request is still in flight, and null for a line the order does not contain
   * — after a reload the list may hold lines that were never part of it, and
   * those must not borrow the order's authority.
   */
  orderedQuantity: number | null;
  onStep: (line: ReorderSuggestionLine, delta: number) => void;
  onSetQuantity: (line: ReorderSuggestionLine, quantity: number) => void;
}

function NachbestellZeile({
  line,
  group,
  de,
  language,
  locked,
  quantity,
  ordered,
  orderedQuantity,
  onStep,
  onSetQuantity,
}: NachbestellZeileProps) {
  const severity = severityOf(line);
  const severityLabel =
    severity === "out" ? (de ? "leer" : "out of stock") : de ? "niedrig" : "low stock";
  const stockLabel = `${line.stock_available} / ${line.stock_min}`;
  const priced = line.unit_price_cents !== null;

  return (
    <li
      className={`werkstatt-nachbestell-line${quantity < 1 ? " reorder-line--skipped" : ""}`}
    >
      <div className="werkstatt-nachbestell-line-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" />
          <path d="M3 7.5 12 12m0 0 9-4.5M12 12v9" />
        </svg>
      </div>
      <div className="werkstatt-nachbestell-line-main">
        <div className="werkstatt-nachbestell-line-title">{line.article_name}</div>
        <div className="werkstatt-nachbestell-line-meta">
          <span className="werkstatt-nachbestell-line-sp">{line.article_number}</span>
          {line.unit ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{de ? `Einheit ${line.unit}` : `unit ${line.unit}`}</span>
            </>
          ) : null}
          {quantity < 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{de ? "wird nicht bestellt" : "not ordered"}</span>
            </>
          )}
        </div>
      </div>
      <div className="werkstatt-nachbestell-line-stock">
        <span className="werkstatt-nachbestell-stock-label">{de ? "BESTAND" : "STOCK"}</span>
        <span
          className={`werkstatt-pill werkstatt-nachbestell-stock--${severity === "out" ? "out" : "low"}`}
          aria-label={`${severityLabel}: ${stockLabel}`}
        >
          {stockLabel}
        </span>
      </div>
      <div className="werkstatt-nachbestell-line-qty">
        <span className="werkstatt-nachbestell-stock-label">
          {de ? "BESTELLMENGE" : "ORDER QTY"}
        </span>
        {locked ? (
          ordered && orderedQuantity === null ? (
            // In the list, but not in the order: zeroed before sending, or
            // added to the list by the reload that ran after it.
            <span className="reorder-qty-locked reorder-qty-locked--none">
              {de ? "nicht bestellt" : "not ordered"}
            </span>
          ) : (
            <span className="reorder-qty-locked">{orderedQuantity ?? quantity}</span>
          )
        ) : (
          <div
            className="werkstatt-stepper"
            role="group"
            aria-label={`${de ? "Bestellmenge" : "Order quantity"} ${line.article_name}`}
          >
            <button
              type="button"
              className="werkstatt-stepper-btn"
              aria-label={`${de ? "weniger" : "less"} ${line.article_name}`}
              onClick={() => onStep(line, -1)}
            >
              −
            </button>
            <ReorderQuantityField
              value={quantity}
              label={`${de ? "Bestellmenge" : "Order quantity"} ${line.article_name}`}
              onCommit={(next) => onSetQuantity(line, next)}
            />
            <button
              type="button"
              className="werkstatt-stepper-btn"
              aria-label={`${de ? "mehr" : "more"} ${line.article_name}`}
              onClick={() => onStep(line, 1)}
            >
              +
            </button>
          </div>
        )}
      </div>
      <div className="werkstatt-nachbestell-line-total">
        <span className="werkstatt-nachbestell-stock-label">{de ? "SUMME" : "LINE TOTAL"}</span>
        {priced ? (
          <>
            <span className="werkstatt-nachbestell-line-total-value">
              {formatCents((line.unit_price_cents ?? 0) * quantity, group.currency, language)}
            </span>
            <span className="werkstatt-nachbestell-line-unit-price">
              {formatUnitPrice(line.unit_price_cents ?? 0, language)}{" "}
              {currencySymbol(group.currency)} / {line.unit ?? (de ? "Stück" : "pc")}
            </span>
          </>
        ) : (
          <span className="reorder-unpriced-note">
            {de ? "kein Preis hinterlegt" : "no price on file"}
          </span>
        )}
      </div>
    </li>
  );
}
