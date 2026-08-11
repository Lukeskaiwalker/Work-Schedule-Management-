/**
 * BestellungDetailPanel — one order, and everything you can do to it.
 *
 * The drawer is where an order stops being a list and becomes editable: add a
 * position someone forgot, correct a quantity the shop rounded, pull in
 * another order, attach it to the job it is for, hand it back to the
 * wholesaler.
 *
 * Two ideas drive the layout:
 *
 *   A line is either *stocked* or *free*. A free line — job material we buy but
 *   do not keep — is marked, because on delivery it records the receipt but
 *   moves no stock. That distinction is invisible in the numbers and matters
 *   when the stock figures are questioned, so it is visible in the list.
 *
 *   Editing stops when the order is sent. A sent order is a statement about
 *   what the wholesaler was asked for; the editing controls disappear rather
 *   than erroring, so the drawer never offers an action the server will refuse.
 */
import { useState } from "react";

import type { Language, Task } from "../../types";
import type { WerkstattOrder, WerkstattOrderLine } from "../../types/werkstatt";
import {
  formatMoney,
  orderStatusLabel,
  orderStatusToTone,
  shortDate,
} from "./mockData";

export interface BestellungDetailPanelProps {
  language: Language;
  order: WerkstattOrder;
  tasks: ReadonlyArray<Task>;
  canManage: boolean;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onAddLine: (description: string, quantity: number, priceCents: number | null) => void;
  onUpdateLine: (lineId: number, patch: { quantity_ordered?: number }) => void;
  onDeleteLine: (lineId: number) => void;
  onMarkSent: () => void;
  onMarkDelivered: () => void;
  onCancel: () => void;
  onMerge: () => void;
  onSaveAsTemplate: (name: string) => void;
  onApplyTemplate: () => void;
  onAttachTask: (taskId: number | null) => void;
  onSubmitToShop: () => void;
  onShopAgain: () => void;
}

/** German comma or English dot, both to cents. Empty means "no price". */
function parsePriceCents(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (!text) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

function sourceLabel(source: string, de: boolean): string {
  switch (source) {
    case "ids":
      return de ? "Aus Shop-Warenkorb" : "From shop cart";
    case "template":
      return de ? "Aus Vorlage" : "From template";
    case "reorder":
      return de ? "Aus Nachbestellung" : "From reorder";
    default:
      return de ? "Manuell angelegt" : "Created manually";
  }
}

export function BestellungDetailPanel({
  language,
  order,
  tasks,
  canManage,
  busy = false,
  error = null,
  onClose,
  onAddLine,
  onUpdateLine,
  onDeleteLine,
  onMarkSent,
  onMarkDelivered,
  onCancel,
  onMerge,
  onSaveAsTemplate,
  onApplyTemplate,
  onAttachTask,
  onSubmitToShop,
  onShopAgain,
}: BestellungDetailPanelProps) {
  const de = language === "de";
  const [newDescription, setNewDescription] = useState("");
  const [newQuantity, setNewQuantity] = useState("1");
  const [newPrice, setNewPrice] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [namingTemplate, setNamingTemplate] = useState(false);

  const editable = order.status === "draft" && canManage;
  const freeLineCount = order.lines.filter((line) => !line.is_stocked).length;

  function submitLine() {
    const quantity = Number(newQuantity);
    if (!newDescription.trim() || !Number.isFinite(quantity) || quantity < 1) return;
    onAddLine(newDescription.trim(), Math.floor(quantity), parsePriceCents(newPrice));
    setNewDescription("");
    setNewQuantity("1");
    setNewPrice("");
  }

  function renderLine(line: WerkstattOrderLine) {
    return (
      <li key={line.id} className="werkstatt-orders-drawer-line">
        <div className="werkstatt-orders-drawer-line-main">
          <b>{line.article_name}</b>
          <small>
            {[
              line.article_number,
              line.supplier_article_no,
              line.manufacturer,
              // The badge answers "will this move stock?" — see the file header.
              line.is_stocked ? null : de ? "Freiposition" : "Free item",
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
          {line.notes && (
            <small className="werkstatt-orders-drawer-line-note">{line.notes}</small>
          )}
        </div>
        <div className="werkstatt-orders-drawer-line-qty">
          {editable ? (
            <input
              type="number"
              min={1}
              className="werkstatt-field-input werkstatt-orders-qty-input"
              value={line.quantity_ordered}
              aria-label={de ? "Menge" : "Quantity"}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (Number.isFinite(next) && next >= 1) {
                  onUpdateLine(line.id, { quantity_ordered: Math.floor(next) });
                }
              }}
            />
          ) : (
            <span>
              {line.quantity_received} / {line.quantity_ordered}
            </span>
          )}
          <small>
            {formatMoney(line.unit_price_cents, line.currency)}
            {line.unit ? ` / ${line.unit}` : ""}
          </small>
        </div>
        {editable && (
          <button
            type="button"
            className="werkstatt-orders-line-remove"
            onClick={() => onDeleteLine(line.id)}
            aria-label={de ? `${line.article_name} entfernen` : `Remove ${line.article_name}`}
          >
            ✕
          </button>
        )}
      </li>
    );
  }

  return (
    <aside
      className="werkstatt-orders-drawer"
      aria-label={de ? "Bestelldetails" : "Order details"}
    >
      <header className="werkstatt-orders-drawer-head">
        <div className="werkstatt-orders-drawer-title-block">
          <span className="werkstatt-orders-drawer-number">{order.order_number}</span>
          <h2 className="werkstatt-orders-drawer-title">
            {order.title || order.supplier_name}
          </h2>
          <span
            className={`werkstatt-orders-status werkstatt-orders-status--${orderStatusToTone(order.status)}`}
          >
            {orderStatusLabel(order.status, de)}
          </span>
        </div>
        <button
          type="button"
          className="werkstatt-orders-drawer-close"
          onClick={onClose}
          aria-label={de ? "Schließen" : "Close"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6L6 18"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </header>

      <dl className="werkstatt-orders-drawer-meta">
        <div>
          <dt>{de ? "Lieferant" : "Supplier"}</dt>
          <dd>{order.supplier_name}</dd>
        </div>
        <div>
          <dt>{de ? "Herkunft" : "Source"}</dt>
          <dd>{sourceLabel(order.source, de)}</dd>
        </div>
        <div>
          <dt>{de ? "Bestellt am" : "Ordered"}</dt>
          <dd>{shortDate(order.ordered_at, de)}</dd>
        </div>
        <div>
          <dt>{de ? "Erwartet" : "Expected"}</dt>
          <dd>{shortDate(order.expected_delivery_at, de)}</dd>
        </div>
        <div>
          <dt>{de ? "Summe" : "Total"}</dt>
          <dd>{formatMoney(order.total_amount_cents, order.currency)}</dd>
        </div>
        {order.external_reference && (
          <div>
            <dt>{de ? "Shop-Referenz" : "Shop ref"}</dt>
            <dd>{order.external_reference}</dd>
          </div>
        )}
      </dl>

      <section className="werkstatt-orders-drawer-section">
        <h3 className="werkstatt-orders-drawer-section-title">
          {de ? "Auftrag" : "Job"}
        </h3>
        <select
          className="werkstatt-field-select"
          value={order.task_id ?? ""}
          disabled={!canManage}
          aria-label={de ? "Bestellung einem Auftrag zuordnen" : "Attach order to a job"}
          onChange={(event) =>
            onAttachTask(event.target.value ? Number(event.target.value) : null)
          }
        >
          <option value="">{de ? "— keinem Auftrag —" : "— no job —"}</option>
          {tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
        {order.project_name && (
          <p className="werkstatt-modal-hint">
            {de ? "Projekt: " : "Project: "}
            {order.project_name}
          </p>
        )}
      </section>

      <section className="werkstatt-orders-drawer-lines">
        <h3 className="werkstatt-orders-drawer-section-title">
          {de ? "Positionen" : "Lines"}
          {freeLineCount > 0 && (
            <span className="werkstatt-orders-drawer-section-hint">
              {de
                ? ` · ${freeLineCount} Freiposition${freeLineCount === 1 ? "" : "en"} (kein Lagerbestand)`
                : ` · ${freeLineCount} free item${freeLineCount === 1 ? "" : "s"} (no stock)`}
            </span>
          )}
        </h3>
        {order.lines.length === 0 ? (
          <p className="werkstatt-modal-hint">
            {de ? "Noch keine Positionen." : "No lines yet."}
          </p>
        ) : (
          <ul className="werkstatt-orders-drawer-lines-list">{order.lines.map(renderLine)}</ul>
        )}

        {editable && (
          <div className="werkstatt-orders-add-line">
            <input
              className="werkstatt-field-input"
              placeholder={de ? "Position hinzufügen…" : "Add a position…"}
              value={newDescription}
              onChange={(event) => setNewDescription(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitLine();
              }}
              aria-label={de ? "Bezeichnung" : "Description"}
            />
            <input
              className="werkstatt-field-input werkstatt-orders-qty-input"
              type="number"
              min={1}
              value={newQuantity}
              onChange={(event) => setNewQuantity(event.target.value)}
              aria-label={de ? "Menge" : "Quantity"}
            />
            <input
              className="werkstatt-field-input werkstatt-orders-price-input"
              inputMode="decimal"
              placeholder={de ? "€ netto" : "€ net"}
              value={newPrice}
              onChange={(event) => setNewPrice(event.target.value)}
              aria-label={de ? "Einzelpreis" : "Unit price"}
            />
            <button
              type="button"
              className="werkstatt-action-btn"
              disabled={busy || !newDescription.trim()}
              onClick={submitLine}
            >
              {de ? "Hinzufügen" : "Add"}
            </button>
          </div>
        )}
      </section>

      {error && <p className="werkstatt-modal-error">{error}</p>}

      <footer className="werkstatt-orders-drawer-actions">
        {editable && (
          <>
            <button type="button" className="werkstatt-action-btn" onClick={onShopAgain}>
              {de ? "Nachkaufen" : "Shop again"}
            </button>
            <button type="button" className="werkstatt-action-btn" onClick={onApplyTemplate}>
              {de ? "Vorlage einfügen" : "Insert template"}
            </button>
            <button type="button" className="werkstatt-action-btn" onClick={onMerge}>
              {de ? "Zusammenführen" : "Merge"}
            </button>
          </>
        )}

        {canManage && !order.is_template && (
          namingTemplate ? (
            <div className="werkstatt-orders-add-line">
              <input
                className="werkstatt-field-input"
                autoFocus
                placeholder={de ? "Name der Vorlage" : "Template name"}
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && templateName.trim()) {
                    onSaveAsTemplate(templateName.trim());
                    setTemplateName("");
                    setNamingTemplate(false);
                  }
                  if (event.key === "Escape") setNamingTemplate(false);
                }}
              />
              <button
                type="button"
                className="werkstatt-action-btn"
                disabled={!templateName.trim() || busy}
                onClick={() => {
                  onSaveAsTemplate(templateName.trim());
                  setTemplateName("");
                  setNamingTemplate(false);
                }}
              >
                {de ? "Speichern" : "Save"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={() => setNamingTemplate(true)}
            >
              {de ? "Als Vorlage speichern" : "Save as template"}
            </button>
          )
        )}

        {order.supplier_has_shop && order.status === "draft" && canManage && (
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={busy || order.lines.length === 0}
            onClick={onSubmitToShop}
            title={
              de
                ? "Öffnet den Warenkorb im Shop. Bestellt wird dort — mit den Preisen und Beständen des Lieferanten."
                : "Fills the basket in the shop. You order there, under the supplier's prices and stock."
            }
          >
            {de ? "Im Shop bestellen" : "Order in shop"}
          </button>
        )}

        {canManage && order.status === "draft" && (
          <button type="button" className="werkstatt-action-btn" onClick={onCancel}>
            {de ? "Stornieren" : "Cancel order"}
          </button>
        )}
        {canManage && (
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={order.status !== "draft" || busy}
            onClick={onMarkSent}
          >
            {de ? "Als versendet markieren" : "Mark as sent"}
          </button>
        )}
        {canManage && (
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={
              busy ||
              !["sent", "confirmed", "partially_delivered"].includes(order.status)
            }
            onClick={onMarkDelivered}
          >
            {de ? "Als geliefert markieren" : "Mark as delivered"}
          </button>
        )}
      </footer>
    </aside>
  );
}
