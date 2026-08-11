/**
 * BestellungZusammenfuehrenModal — fold one draft order into another.
 *
 * The everyday case: three people shopped for the same job on three days, and
 * nobody wants to place three orders with one wholesaler. Merging moves the
 * source's lines onto the target and retires the source — kept, not deleted,
 * so "where did my order go?" has an answer.
 *
 * Only same-supplier drafts are offered. A merged order addressed to two
 * wholesalers cannot be sent to either, and a sent order must not gain lines
 * after the wholesaler already has it.
 */
import { useEffect, useMemo, useState } from "react";

import type { Language } from "../../types";
import type { WerkstattOrder, WerkstattOrderSummary } from "../../types/werkstatt";

export interface BestellungZusammenfuehrenModalProps {
  open: boolean;
  language: Language;
  /** The order that will absorb the other. */
  target: WerkstattOrder;
  candidates: ReadonlyArray<WerkstattOrderSummary>;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: (sourceOrderId: number, combineDuplicates: boolean) => void;
}

export function BestellungZusammenfuehrenModal({
  open,
  language,
  target,
  candidates,
  busy = false,
  error = null,
  onClose,
  onConfirm,
}: BestellungZusammenfuehrenModalProps) {
  const de = language === "de";
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [combine, setCombine] = useState(true);

  useEffect(() => {
    if (!open) return;
    setSourceId(null);
    setCombine(true);
  }, [open, target.id]);

  const eligible = useMemo(
    () =>
      candidates.filter(
        (order) =>
          order.id !== target.id &&
          order.status === "draft" &&
          !order.is_template &&
          order.merged_into_order_id === null &&
          order.supplier_id === target.supplier_id,
      ),
    [candidates, target.id, target.supplier_id],
  );

  if (!open) return null;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Bestellungen zusammenführen" : "Merge orders"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "BESTELLUNG › ZUSAMMENFÜHREN" : "ORDER › MERGE"}
            </span>
            <h2 className="werkstatt-modal-title">
              {de ? "In diese Bestellung übernehmen" : "Merge into this order"}
            </h2>
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

        <div className="werkstatt-modal-body werkstatt-modal-body--stacked">
          <p className="werkstatt-machine-modal-sub">
            <span className="werkstatt-machine-number">{target.order_number}</span>
            {target.title ? ` · ${target.title}` : ""} · {target.supplier_name}
          </p>

          {eligible.length === 0 ? (
            <p className="werkstatt-modal-hint">
              {de
                ? "Es gibt keine weitere Entwurfs-Bestellung bei diesem Lieferanten, die übernommen werden könnte."
                : "There is no other draft order for this supplier to merge in."}
            </p>
          ) : (
            <label className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "Diese Bestellung übernehmen" : "Merge this order in"}
              </span>
              <select
                className="werkstatt-field-select"
                value={sourceId ?? ""}
                onChange={(event) =>
                  setSourceId(event.target.value ? Number(event.target.value) : null)
                }
              >
                <option value="">{de ? "— auswählen —" : "— choose —"}</option>
                {eligible.map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.order_number}
                    {order.title ? ` · ${order.title}` : ""} (
                    {de ? `${order.line_count} Pos.` : `${order.line_count} lines`})
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* No `werkstatt-field` here: that class stacks its children in a
              column, which would put the tick above its own label. */}
          <label className="werkstatt-machine-check">
            <input
              type="checkbox"
              checked={combine}
              onChange={(event) => setCombine(event.target.checked)}
            />
            <span>
              {de
                ? "Gleiche Artikel zu einer Position zusammenfassen"
                : "Combine identical articles into one line"}
            </span>
          </label>
          <p className="werkstatt-modal-hint">
            {de
              ? "Zusammengefasst wird nur, was Artikel UND Preis teilt. Zwei Preise für denselben Artikel bleiben getrennt — das ist entweder eine Preisänderung oder ein Fehler, und beides soll sichtbar bleiben."
              : "Only lines sharing article AND price are combined. Two prices for the same article stay apart — that is either a price change or a mistake, and both should stay visible."}
          </p>

          {error && <p className="werkstatt-modal-error">{error}</p>}
        </div>

        <footer className="werkstatt-modal-foot">
          <button type="button" className="werkstatt-action-btn" onClick={onClose}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={sourceId === null || busy}
            onClick={() => sourceId !== null && onConfirm(sourceId, combine)}
          >
            {de ? "Zusammenführen" : "Merge"}
          </button>
        </footer>
      </div>
    </div>
  );
}
