/**
 * BestellungDetailPanel — one order, and everything you can do to it.
 *
 * The drawer is where an order stops being a list and becomes editable: add a
 * position someone forgot, correct a quantity the shop rounded, pull in
 * another order, attach it to the job it is for, hand it back to the
 * wholesaler.
 *
 * Three ideas drive the layout:
 *
 *   A line is either *stocked* or *free*. A free line — job material we buy but
 *   do not keep — is marked, because on delivery it records the receipt but
 *   moves no stock. That distinction is invisible in the numbers and matters
 *   when the stock figures are questioned, so it is visible in the list.
 *
 *   Every line shows whether the supplier will receive it. The resolution
 *   (`GET /orders/{id}/resolution`) runs on open and after every change, and
 *   each line carries a badge: green, amber or red — see
 *   `BestellungPositionZeile`. The header sums it up as "3 von 4 Positionen
 *   übergabefähig", so a short basket is a thing the buyer sees, not
 *   discovers.
 *
 *   Editing stops when the order is sent. A sent order is a statement about
 *   what the wholesaler was asked for; the editing controls disappear rather
 *   than erroring, so the drawer never offers an action the server will refuse.
 */
import { useState } from "react";

import type { Language, Task } from "../../types";
import type { WerkstattOrder, WerkstattOrderLine } from "../../types/werkstatt";
import type {
  OrderLineCreate,
  OrderLineUpdate,
  OrderResolution,
  OrderResolutionAlternative,
} from "../../types/werkstattProcurement";
import { ArtikelSuchfeld, hitToOrderLine } from "./ArtikelSuchfeld";
import { BestellungPositionZeile } from "./BestellungPositionZeile";
import {
  BestellungVersandLeiste,
  type SendConflict,
  type SendRoute,
} from "./BestellungVersandLeiste";
import { formatMoney, orderStatusLabel, orderStatusToTone, shortDate } from "./mockData";

export interface BestellungDetailPanelProps {
  language: Language;
  token: string | null;
  order: WerkstattOrder;
  tasks: ReadonlyArray<Task>;
  canManage: boolean;
  busy?: boolean;
  error?: string | null;
  /** Per-line send status; null while loading. */
  resolution: OrderResolution | null;
  /** The last refused hand-over, until dismissed or overridden. */
  conflict: SendConflict | null;
  onClose: () => void;
  onAddLine: (payload: OrderLineCreate) => void;
  onUpdateLine: (lineId: number, patch: OrderLineUpdate) => void;
  onDeleteLine: (lineId: number) => void;
  onSetSupplierNo: (line: WerkstattOrderLine, supplierArticleNo: string) => void;
  onPickAlternative: (line: WerkstattOrderLine, alternative: OrderResolutionAlternative) => void;
  onSend: (route: SendRoute, allowUnresolved: boolean) => void;
  onDismissConflict: () => void;
  onMarkSent: () => void;
  onMarkDelivered: () => void;
  onCancel: () => void;
  onMerge: () => void;
  onSaveAsTemplate: (name: string) => void;
  onApplyTemplate: () => void;
  onAttachTask: (taskId: number | null) => void;
  onShopAgain: () => void;
}

function sourceLabel(source: string, de: boolean): string {
  switch (source) {
    case "ids":
      return de ? "Aus Shop-Warenkorb" : "From shop cart";
    case "template":
      return de ? "Aus Vorlage" : "From template";
    case "reorder":
      return de ? "Aus Nachbestellung" : "From reorder";
    case "needs":
      return de ? "Aus Bedarfen" : "From material needs";
    default:
      return de ? "Manuell angelegt" : "Created manually";
  }
}

export function BestellungDetailPanel({
  language,
  token,
  order,
  tasks,
  canManage,
  busy = false,
  error = null,
  resolution,
  conflict,
  onClose,
  onAddLine,
  onUpdateLine,
  onDeleteLine,
  onSetSupplierNo,
  onPickAlternative,
  onSend,
  onDismissConflict,
  onMarkSent,
  onMarkDelivered,
  onCancel,
  onMerge,
  onSaveAsTemplate,
  onApplyTemplate,
  onAttachTask,
  onShopAgain,
}: BestellungDetailPanelProps) {
  const de = language === "de";
  const [templateName, setTemplateName] = useState("");
  const [namingTemplate, setNamingTemplate] = useState(false);

  const editable = order.status === "draft" && canManage;
  const freeLineCount = order.lines.filter((line) => !line.is_stocked).length;
  const resolutionByLine = new Map(
    (resolution?.lines ?? []).map((line) => [line.line_id, line] as const),
  );
  const readiness =
    resolution && resolution.line_count > 0
      ? {
          short: resolution.ready_count < resolution.line_count,
          text: de
            ? `${resolution.ready_count} von ${resolution.line_count} Positionen übergabefähig`
            : `${resolution.ready_count} of ${resolution.line_count} lines ready to send`,
        }
      : null;

  return (
    <aside className="werkstatt-orders-drawer" aria-label={de ? "Bestelldetails" : "Order details"}>
      <header className="werkstatt-orders-drawer-head">
        <div className="werkstatt-orders-drawer-title-block">
          <span className="werkstatt-orders-drawer-number">{order.order_number}</span>
          <h2 className="werkstatt-orders-drawer-title">{order.title || order.supplier_name}</h2>
          <span
            className={`werkstatt-orders-status werkstatt-orders-status--${orderStatusToTone(order.status)}`}
          >
            {orderStatusLabel(order.status, de)}
          </span>
          {readiness && (
            <span
              className={`werkstatt-orders-readiness${readiness.short ? " werkstatt-orders-readiness--short" : ""}`}
              role="status"
            >
              {readiness.text}
            </span>
          )}
        </div>
        <button
          type="button"
          className="werkstatt-orders-drawer-close"
          onClick={onClose}
          aria-label={de ? "Schließen" : "Close"}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
        {order.submitted_at && (
          <div>
            <dt>{de ? "Übergeben am" : "Handed over"}</dt>
            <dd>{shortDate(order.submitted_at, de)}</dd>
          </div>
        )}
        {order.external_reference && (
          <div>
            <dt>{de ? "Shop-Referenz" : "Shop ref"}</dt>
            <dd>{order.external_reference}</dd>
          </div>
        )}
      </dl>

      <section className="werkstatt-orders-drawer-section">
        <h3 className="werkstatt-orders-drawer-section-title">{de ? "Auftrag" : "Job"}</h3>
        <select
          className="werkstatt-field-select"
          value={order.task_id ?? ""}
          disabled={!canManage}
          aria-label={de ? "Bestellung einem Auftrag zuordnen" : "Attach order to a job"}
          onChange={(event) => onAttachTask(event.target.value ? Number(event.target.value) : null)}
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
                ? ` · ${freeLineCount} Freiposition${freeLineCount === 1 ? "" : "en"} (kein Lagerartikel — kein Bestand gebucht)`
                : ` · ${freeLineCount} free item${freeLineCount === 1 ? "" : "s"} (not stocked — no stock booked)`}
            </span>
          )}
        </h3>
        {order.lines.length === 0 ? (
          <p className="werkstatt-modal-hint">{de ? "Noch keine Positionen." : "No lines yet."}</p>
        ) : (
          <ul className="werkstatt-orders-drawer-lines-list">
            {order.lines.map((line) => (
              <BestellungPositionZeile
                key={line.id}
                line={line}
                resolution={resolutionByLine.get(line.id) ?? null}
                de={de}
                editable={editable}
                busy={busy}
                onUpdateQuantity={(lineId, quantity) =>
                  onUpdateLine(lineId, { quantity_ordered: quantity })
                }
                onDelete={onDeleteLine}
                onSetSupplierNo={onSetSupplierNo}
                onPickAlternative={onPickAlternative}
              />
            ))}
          </ul>
        )}

        {editable && (
          <ArtikelSuchfeld
            token={token}
            language={language}
            supplierId={order.supplier_id}
            supplierName={order.supplier_name}
            disabled={busy}
            onPick={(hit, quantity) => onAddLine(hitToOrderLine(hit, quantity))}
          />
        )}
      </section>

      {error && <p className="werkstatt-modal-error">{error}</p>}

      <footer className="werkstatt-orders-drawer-actions">
        {editable && (
          <>
            {order.supplier_has_shop && (
              <button type="button" className="werkstatt-action-btn" onClick={onShopAgain}>
                {de ? "Nachkaufen" : "Shop again"}
              </button>
            )}
            <button type="button" className="werkstatt-action-btn" onClick={onApplyTemplate}>
              {de ? "Vorlage einfügen" : "Insert template"}
            </button>
            <button type="button" className="werkstatt-action-btn" onClick={onMerge}>
              {de ? "Zusammenführen" : "Merge"}
            </button>
          </>
        )}

        {canManage &&
          !order.is_template &&
          (namingTemplate ? (
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
            <button type="button" className="werkstatt-action-btn" onClick={() => setNamingTemplate(true)}>
              {de ? "Als Vorlage speichern" : "Save as template"}
            </button>
          ))}

        <BestellungVersandLeiste
          order={order}
          de={de}
          canManage={canManage}
          busy={busy}
          resolution={resolution}
          conflict={conflict}
          onSend={onSend}
          onDismissConflict={onDismissConflict}
          onMarkSent={onMarkSent}
          onMarkDelivered={onMarkDelivered}
          onCancel={onCancel}
        />
      </footer>
    </aside>
  );
}
