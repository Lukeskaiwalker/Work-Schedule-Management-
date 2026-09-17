/**
 * One supplier's reorder suggestions on the phone.
 *
 * Same data and same send path as the desktop group (`NachbestellGruppe`),
 * folded into an accordion: a phone shows one supplier at a time, and the
 * order button sits inside the group because an order is per supplier.
 */
import type { ReorderSendState } from "../../hooks/useReorderBasket";
import {
  formatCents,
  leadTimeLabel,
  severityOf,
  shortSupplierName,
  type ReorderGroupTotals,
} from "../../utils/reorderBasket";
import { resendBlocked } from "../../utils/reorderSendState";
import type {
  ReorderSuggestionGroup,
  ReorderSuggestionLine,
} from "../../utils/werkstattReorderApi";
import { ReorderSendPanel } from "./ReorderSendPanel";

export interface MobileNachbestellGruppeProps {
  group: ReorderSuggestionGroup;
  de: boolean;
  language: "de" | "en";
  expanded: boolean;
  canManage: boolean;
  busy: boolean;
  totals: ReorderGroupTotals;
  sendState: ReorderSendState | null;
  quantityFor: (line: ReorderSuggestionLine) => number;
  onToggle: () => void;
  onStep: (line: ReorderSuggestionLine, delta: number) => void;
  onSubmit: (allowUnresolved: boolean) => void;
  onDismiss: () => void;
  onOpenOrders?: () => void;
}

export function MobileNachbestellGruppe({
  group,
  de,
  language,
  expanded,
  canManage,
  busy,
  totals,
  sendState,
  quantityFor,
  onToggle,
  onStep,
  onSubmit,
  onDismiss,
  onOpenOrders,
}: MobileNachbestellGruppeProps) {
  const sent = sendState?.kind === "sent";
  const sending = sendState?.kind === "sending";
  // Hidden while sending again would risk a duplicate order — but not while
  // this group's own request is in flight, where it says "Wird übergeben…".
  const hideSubmit = resendBlocked(sendState) && !sending;
  const orderedQuantities = sendState?.kind === "sent" ? sendState.orderedQuantities : null;
  const leadTime = leadTimeLabel(group, de);
  // A collapsed group must not hide its outcome: after "alle versenden" the
  // one supplier the server refused looks exactly like an untouched one
  // unless the header says otherwise.
  const outcomeLabel =
    sendState?.kind === "sent"
      ? sendState.carriedOver
        ? `${de ? "bereits bestellt" : "already ordered"}: ${sendState.order.order_number}`
        : de ? "versendet" : "submitted"
      : sendState?.kind === "conflict"
        ? de ? "nicht versendet" : "not submitted"
        : sendState?.kind === "error"
          ? sendState.outcome === "unknown"
            ? de ? "Ergebnis unklar" : "outcome unknown"
            : de ? "fehlgeschlagen" : "failed"
          : null;

  return (
    <section className="werkstatt-mobile-nach-group">
      <button
        type="button"
        className="werkstatt-mobile-nach-group-head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span
          className={`werkstatt-mobile-nach-group-caret${
            expanded ? " werkstatt-mobile-nach-group-caret--open" : ""
          }`}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5C7895" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6 L15 12 L9 18" />
          </svg>
        </span>
        <span className="werkstatt-mobile-nach-group-icon" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F70B7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9 L12 3 L21 9 V20 A1 1 0 0 1 20 21 H4 A1 1 0 0 1 3 20 Z" />
            <path d="M9 21 V13 H15 V21" />
          </svg>
        </span>
        <span className="werkstatt-mobile-nach-group-text">
          <span className="werkstatt-mobile-nach-group-name">{group.supplier_name}</span>
          <span className="werkstatt-mobile-nach-group-meta">
            {group.lines.length} {de ? "Artikel" : "items"}
            {leadTime ? ` · ${leadTime}` : ""}
            {outcomeLabel ? ` · ${outcomeLabel}` : ""}
          </span>
        </span>
        <span className="werkstatt-mobile-nach-group-total">
          {formatCents(totals.cents, group.currency, language)}
          {totals.unpricedCount > 0 ? "*" : ""}
        </span>
      </button>

      {expanded && (
        <>
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
            />
          )}

          <ul className="werkstatt-mobile-nach-lines">
            {group.lines.map((line) => {
              const quantity = quantityFor(line);
              const severity = severityOf(line);
              const priced = line.unit_price_cents !== null;
              return (
                <li
                  key={line.article_id}
                  className={`werkstatt-mobile-nach-line${quantity < 1 ? " reorder-line--skipped" : ""}`}
                >
                  <div className="werkstatt-mobile-nach-line-head">
                    <div className="werkstatt-mobile-nach-line-name">
                      <strong>{line.article_name}</strong>
                      <div className="werkstatt-mobile-nach-line-sub">
                        <span className="werkstatt-mobile-nach-line-sku">
                          {line.article_number}
                        </span>
                        <span className="werkstatt-mobile-nach-line-price">
                          {priced
                            ? ` · ${formatCents(line.unit_price_cents ?? 0, group.currency, language)}${line.unit ? ` / ${line.unit}` : ""}`
                            : ` · ${de ? "kein Preis" : "no price"}`}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`werkstatt-mobile-nach-line-pill werkstatt-mobile-nach-line-pill--${severity}`}
                      aria-label={`${de ? "Bestand" : "Stock"}: ${line.stock_available} ${de ? "von mindestens" : "of minimum"} ${line.stock_min}`}
                    >
                      {`${line.stock_available} / ${line.stock_min}`}
                    </span>
                  </div>
                  <div className="werkstatt-mobile-nach-line-foot">
                    {sent || sending ? (
                      <span className="reorder-qty-locked">
                        {orderedQuantityLabel(
                          de,
                          quantity,
                          sent,
                          orderedQuantities?.get(line.article_id),
                        )}
                      </span>
                    ) : (
                      <div
                        className="werkstatt-mobile-nach-stepper"
                        role="group"
                        aria-label={`${de ? "Menge" : "Quantity"} ${line.article_name}`}
                      >
                        <button
                          type="button"
                          className="werkstatt-mobile-nach-stepper-btn"
                          onClick={() => onStep(line, -1)}
                          aria-label={`${de ? "Weniger" : "Less"} ${line.article_name}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F70B7" strokeWidth="2.4" strokeLinecap="round">
                            <path d="M5 12 H19" />
                          </svg>
                        </button>
                        <span className="werkstatt-mobile-nach-stepper-value">{quantity}</span>
                        <button
                          type="button"
                          className="werkstatt-mobile-nach-stepper-btn"
                          onClick={() => onStep(line, 1)}
                          aria-label={`${de ? "Mehr" : "More"} ${line.article_name}`}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F70B7" strokeWidth="2.4" strokeLinecap="round">
                            <path d="M12 5 V19" />
                            <path d="M5 12 H19" />
                          </svg>
                        </button>
                      </div>
                    )}
                    <span className="werkstatt-mobile-nach-line-total">
                      {priced
                        ? formatCents(
                            (line.unit_price_cents ?? 0) * quantity,
                            group.currency,
                            language,
                          )
                        : de
                          ? "ohne Preis"
                          : "no price"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>

          {canManage && !hideSubmit && (
            <button
              type="button"
              className="reorder-mobile-group-submit"
              disabled={busy || sending || totals.positionCount === 0}
              onClick={() => onSubmit(false)}
            >
              {sending
                ? de
                  ? "Wird übergeben…"
                  : "Submitting…"
                : de
                  ? `Bei ${shortSupplierName(group)} bestellen`
                  : `Order from ${shortSupplierName(group)}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The quantity under a locked line.
 *
 * While the request is in flight it is the draft being sent. Once an order
 * exists it is what that order carries — NOT the list's suggestion, which a
 * reload replaces — and a line the order does not contain says so instead of
 * borrowing a number from somewhere else.
 */
function orderedQuantityLabel(
  de: boolean,
  draftQuantity: number,
  ordered: boolean,
  orderedQuantity: number | undefined,
): string {
  if (!ordered) return de ? `Menge ${draftQuantity}` : `Qty ${draftQuantity}`;
  if (orderedQuantity === undefined) return de ? "nicht bestellt" : "not ordered";
  return de ? `Menge ${orderedQuantity}` : `Qty ${orderedQuantity}`;
}
