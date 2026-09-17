import { useEffect, useMemo, useState } from "react";
import type { Language } from "../../../types";
import type { MaterialNeedOrderResult, MaterialNeedRow } from "../../../types/materialNeeds";
import type { WerkstattOrderSummary } from "../../../types/werkstatt";
import { splitSelectionBySupplier } from "../../../utils/bedarfeOrdering";
import { needSkipReasonLabel, previewOrderQuantity } from "../../../utils/materials";
import { listOrders } from "../../../utils/werkstattOrdersApi";

/**
 * "Bestellung erstellen" — what would be ordered, before anything is.
 *
 * The screen it replaces had no such step at all: needs were copied into a
 * wholesaler basket by hand. The three things it must show, because each was
 * a way to order the wrong thing silently:
 *
 *   1. the split by supplier — a selection spanning two wholesalers becomes
 *      two drafts, and the buyer should know that before confirming;
 *   2. every quantity that had to be rounded, per position, in amber;
 *   3. every row that will NOT be ordered and why, rather than a count.
 *
 * The preview is computed from the rows already on screen; the server's own
 * answer (authoritative) is shown afterwards in the same dialog. `rows` must
 * therefore still hold the CONFIRMED rows while a result is shown — the page
 * clears its selection the moment the server answers, and a skip list that
 * falls back to "#412" names nothing the buyer can act on.
 */
export interface BedarfOrderModalProps {
  open: boolean;
  language: Language;
  token: string | null;
  rows: readonly MaterialNeedRow[];
  busy: boolean;
  result: MaterialNeedOrderResult | null;
  error: string | null;
  onConfirm: (input: { supplierId: number | null; orderId: number | null; title: string | null }) => void;
  onClose: () => void;
  onOpenOrders: () => void;
}

export function BedarfOrderModal({
  open,
  language,
  token,
  rows,
  busy,
  result,
  error,
  onConfirm,
  onClose,
  onOpenOrders,
}: BedarfOrderModalProps) {
  const de = language === "de";
  const [title, setTitle] = useState("");
  const [targetOrderId, setTargetOrderId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<WerkstattOrderSummary[]>([]);

  const { groups, skipped } = useMemo(() => splitSelectionBySupplier(rows), [rows]);
  const singleSupplier = groups.length === 1 ? groups[0] : null;

  // Appending to an existing draft is only offered when the whole selection
  // goes to one supplier: an order belongs to exactly one wholesaler, so the
  // choice would be meaningless for a split selection.
  useEffect(() => {
    if (!open || singleSupplier == null) {
      setDrafts([]);
      setTargetOrderId(null);
      return;
    }
    let cancelled = false;
    void listOrders(token, { status: "draft", supplier_id: singleSupplier.supplierId })
      .then((found) => {
        if (!cancelled) setDrafts(found.filter((order) => !order.is_template));
      })
      .catch(() => {
        // Not fatal: without the list the modal simply offers "new order".
        if (!cancelled) setDrafts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, singleSupplier?.supplierId, token]);

  useEffect(() => {
    if (open) return;
    setTitle("");
    setTargetOrderId(null);
  }, [open]);

  if (!open) return null;

  const orderable = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal werkstatt-modal--wide"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Bestellung aus Bedarf erstellen" : "Create an order from needs"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "PROJEKT-BEDARFE › BESTELLUNG" : "PROJECT NEEDS › ORDER"}
            </span>
            <h2 className="werkstatt-modal-title">
              {de ? "Bestellung erstellen" : "Create an order"}
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

        <div className="werkstatt-modal-body bedarfe-order-body">
          {result ? (
            <div className="bedarfe-order-result">
              {result.orders.length === 0 ? (
                // Not a success with zero positions: the server refused every
                // row (an archived supplier, or somebody else ordered the same
                // selection first), and the pluralised sentence with a blank
                // order number read as if something had been bought.
                <p className="bedarfe-hint bedarfe-hint--warn">
                  {de
                    ? `Keine Bestellung erstellt – alle ${result.skipped.length} ${
                        result.skipped.length === 1 ? "Zeile wurde" : "Zeilen wurden"
                      } übersprungen.`
                    : `No order created – all ${result.skipped.length} ${
                        result.skipped.length === 1 ? "row was" : "rows were"
                      } skipped.`}
                </p>
              ) : (
                <p>
                  {de
                    ? `${result.orders.length === 1 ? "Bestellung" : "Bestellungen"} ${result.orders
                        .map((order) => order.order_number)
                        .join(", ")} erstellt (${result.added.length} ${
                        result.added.length === 1 ? "Position" : "Positionen"
                      })`
                    : `${result.orders.length === 1 ? "Order" : "Orders"} ${result.orders
                        .map((order) => order.order_number)
                        .join(", ")} created (${result.added.length} ${
                        result.added.length === 1 ? "line" : "lines"
                      })`}
                </p>
              )}
              {result.added.some((entry) => entry.quantity_warning) && (
                <ul className="bedarfe-order-warnings">
                  {result.added
                    .filter((entry) => entry.quantity_warning)
                    .map((entry) => (
                      <li key={`warn-${entry.need_id}`} className="bedarfe-hint bedarfe-hint--warn">
                        {entry.quantity_warning}
                      </li>
                    ))}
                </ul>
              )}
              {result.skipped.length > 0 && (
                <ul className="bedarfe-order-skipped">
                  {result.skipped.map((entry) => (
                    <li key={`skipped-${entry.need_id}`} className="muted">
                      {rows.find((row) => row.id === entry.need_id)?.item ?? `#${entry.need_id}`} —{" "}
                      {needSkipReasonLabel(entry.reason, language, entry.order_number)}
                    </li>
                  ))}
                </ul>
              )}
              {result.orders.length > 0 && (
                <p className="bedarfe-hint">
                  {de
                    ? "Die Bestellung ist ein Entwurf — sie wird erst in Werkstatt › Bestellungen übergeben."
                    : "The order is a draft — it is handed over in Workshop › Orders."}
                </p>
              )}
            </div>
          ) : (
            <>
              {groups.length === 0 && (
                <p className="bedarfe-hint bedarfe-hint--warn">
                  {de
                    ? "Keine der ausgewählten Zeilen hat einen Katalog-Artikel mit Lieferant."
                    : "None of the selected rows has a catalogue article with a supplier."}
                </p>
              )}
              {groups.map((group) => (
                <section key={`order-group-${group.supplierId}`} className="bedarfe-order-group">
                  <h3 className="bedarfe-order-group-head">
                    {group.supplierName} ·{" "}
                    {de
                      ? `${group.rows.length} ${group.rows.length === 1 ? "Position" : "Positionen"}`
                      : `${group.rows.length} ${group.rows.length === 1 ? "line" : "lines"}`}
                  </h3>
                  <ul className="bedarfe-order-lines">
                    {group.rows.map((row) => {
                      const preview = previewOrderQuantity(row.quantity, language);
                      return (
                        <li key={`order-line-${row.id}`} className="bedarfe-order-line">
                          <span className="bedarfe-order-line-name">
                            {row.catalog_item_name ?? row.item}
                          </span>
                          <span className="muted">
                            {row.article_no ? `Art.-Nr. ${row.article_no}` : ""}
                          </span>
                          <span className="bedarfe-order-line-qty">
                            {preview.quantity} {row.unit ?? ""}
                          </span>
                          {preview.warning && (
                            <span className="bedarfe-hint bedarfe-hint--warn">
                              {preview.warning}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))}

              {skipped.length > 0 && (
                <section className="bedarfe-order-group">
                  <h3 className="bedarfe-order-group-head">
                    {de
                      ? `Wird übersprungen (${skipped.length})`
                      : `Will be skipped (${skipped.length})`}
                  </h3>
                  <ul className="bedarfe-order-skipped">
                    {skipped.map((entry) => (
                      <li key={`skip-${entry.row.id}`} className="muted">
                        {entry.row.item} —{" "}
                        {needSkipReasonLabel(
                          entry.reason,
                          language,
                          entry.row.werkstatt_order_number,
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {groups.length > 1 && (
                <p className="bedarfe-hint">
                  {de
                    ? `Die Auswahl umfasst ${groups.length} Lieferanten — es entsteht je ein Entwurf.`
                    : `The selection spans ${groups.length} suppliers — one draft each.`}
                </p>
              )}

              {singleSupplier && drafts.length > 0 && (
                <label className="bedarfe-select bedarfe-order-target">
                  <span className="bedarfe-select-label">{de ? "Ziel" : "Target"}</span>
                  <select
                    value={targetOrderId == null ? "" : String(targetOrderId)}
                    onChange={(event) =>
                      setTargetOrderId(event.target.value ? Number(event.target.value) : null)
                    }
                  >
                    <option value="">{de ? "Neue Bestellung" : "New order"}</option>
                    {drafts.map((draft) => (
                      <option key={`draft-${draft.id}`} value={draft.id}>
                        {de ? "An Entwurf anhängen" : "Append to draft"}: {draft.order_number}
                        {draft.title ? ` · ${draft.title}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {targetOrderId == null && (
                <label className="bedarfe-field">
                  <span className="bedarfe-field-label">
                    {de ? "Titel (optional)" : "Title (optional)"}
                  </span>
                  <input
                    type="text"
                    className="bedarfe-input"
                    value={title}
                    placeholder={de ? "z. B. Bedarf Halle 2" : "e.g. needs for hall 2"}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
              )}
            </>
          )}
        </div>

        {error && <p className="werkstatt-modal-error">{error}</p>}

        <footer className="werkstatt-modal-foot">
          <button type="button" className="werkstatt-action-btn" onClick={onClose}>
            {result ? (de ? "Schließen" : "Close") : de ? "Abbrechen" : "Cancel"}
          </button>
          {result ? (
            result.orders.length > 0 && (
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--primary"
                onClick={onOpenOrders}
              >
                {de ? "Zu den Bestellungen" : "Go to orders"}
              </button>
            )
          ) : (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              disabled={busy || orderable === 0}
              onClick={() =>
                onConfirm({
                  supplierId: targetOrderId == null && singleSupplier ? singleSupplier.supplierId : null,
                  orderId: targetOrderId,
                  title: title.trim() || null,
                })
              }
            >
              {busy
                ? de
                  ? "Wird erstellt…"
                  : "Creating…"
                : de
                  ? `${orderable} Positionen übernehmen`
                  : `Add ${orderable} lines`}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
