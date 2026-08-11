/**
 * BestellVorlagenModal — the saved shopping lists.
 *
 * A template is an order that never ships: "Zählerschrank-Standardbestückung",
 * the twelve things that go on every service van refill. Applying one appends
 * its lines, so templates compose — a standard kit plus a second kit plus
 * whatever the job needs on top.
 *
 * Templates deliberately carry no prices. Wholesale prices do not survive the
 * months a template does, and a stale one applied silently is worse than none
 * because it looks authoritative. Prices are refreshed from the current
 * supplier link at the moment the template is used.
 */
import { useEffect, useMemo, useState } from "react";

import type { Language } from "../../types";
import type { WerkstattOrderSummary } from "../../types/werkstatt";

export interface BestellVorlagenModalProps {
  open: boolean;
  language: Language;
  templates: ReadonlyArray<WerkstattOrderSummary>;
  /**
   * The order the user came from, when there is one. Present means "apply into
   * this"; absent means the only sensible action is starting a new order.
   */
  targetOrderId: number | null;
  targetSupplierId: number | null;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onApply: (templateId: number) => void;
  onCreate: (templateId: number, title: string | null) => void;
}

export function BestellVorlagenModal({
  open,
  language,
  templates,
  targetOrderId,
  targetSupplierId,
  busy = false,
  error = null,
  onClose,
  onApply,
  onCreate,
}: BestellVorlagenModalProps) {
  const de = language === "de";
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setTitle("");
  }, [open]);

  /**
   * A template can only be applied INTO an order for the same supplier — one
   * order goes to one wholesaler. Incompatible templates stay visible but
   * unselectable-for-apply, with the reason on the row: hiding them would make
   * a template the user knows exists look deleted.
   *
   * Starting a NEW order from any template is always fine — the new order
   * simply inherits the template's supplier.
   */
  const rows = useMemo(
    () =>
      templates.map((template) => ({
        template,
        appliesHere: targetSupplierId === null || template.supplier_id === targetSupplierId,
      })),
    [templates, targetSupplierId],
  );

  const selectedRow = rows.find((row) => row.template.id === selected) ?? null;

  if (!open) return null;

  const canApply =
    selected !== null && targetOrderId !== null && !busy && (selectedRow?.appliesHere ?? false);
  const canCreate = selected !== null && !busy;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Bestellvorlagen" : "Order templates"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "BESTELLUNGEN › VORLAGEN" : "ORDERS › TEMPLATES"}
            </span>
            <h2 className="werkstatt-modal-title">{de ? "Vorlagen" : "Templates"}</h2>
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
          {rows.length === 0 ? (
            <p className="werkstatt-modal-hint">
              {de
                ? "Es gibt noch keine Vorlagen. Eine bestehende Bestellung lässt sich über „Als Vorlage speichern“ zu einer machen."
                : "No templates yet. Turn any order into one with “Save as template”."}
            </p>
          ) : (
            <ul className="werkstatt-orders-template-list">
              {rows.map(({ template, appliesHere }) => (
                <li key={template.id}>
                  <button
                    type="button"
                    className={`werkstatt-orders-template-row${
                      selected === template.id ? " werkstatt-orders-template-row--active" : ""
                    }`}
                    onClick={() => setSelected(template.id)}
                    aria-pressed={selected === template.id}
                  >
                    <span className="werkstatt-orders-template-name">
                      {template.template_name || template.title || template.order_number}
                    </span>
                    <span className="werkstatt-orders-template-meta">
                      {template.supplier_name} ·{" "}
                      {de
                        ? `${template.line_count} Positionen`
                        : `${template.line_count} lines`}
                      {targetOrderId !== null && !appliesHere
                        ? de
                          ? " · anderer Lieferant"
                          : " · different supplier"
                        : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {selected !== null && (
            <label className="werkstatt-field">
              <span className="werkstatt-field-label">
                {de ? "Titel der neuen Bestellung" : "New order title"}
              </span>
              <input
                className="werkstatt-field-input"
                value={title}
                placeholder={de ? "z. B. Neubau Weber" : "e.g. Weber new build"}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          )}

          {error && <p className="werkstatt-modal-error">{error}</p>}
        </div>

        <footer className="werkstatt-modal-foot">
          <button type="button" className="werkstatt-action-btn" onClick={onClose}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          {targetOrderId !== null && (
            <button
              type="button"
              className="werkstatt-action-btn"
              disabled={!canApply}
              onClick={() => selected !== null && onApply(selected)}
            >
              {de ? "Zu dieser Bestellung hinzufügen" : "Add to this order"}
            </button>
          )}
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={!canCreate}
            onClick={() => selected !== null && onCreate(selected, title.trim() || null)}
          >
            {de ? "Neue Bestellung anlegen" : "Create new order"}
          </button>
        </footer>
      </div>
    </div>
  );
}
