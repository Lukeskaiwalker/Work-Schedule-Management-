/**
 * NeueBestellungModal — start an order from here, not from the shop.
 *
 * Until now the only way to get an order into SMPL was to fetch a cart out of
 * the wholesaler's webshop; `createOrder` existed and nothing called it. This
 * dialog is the missing front door: pick the supplier, optionally name the
 * job, then search — our own articles and the supplier's catalogue in one box
 * (`ArtikelSuchfeld`) — and collect positions in the cart on the right.
 * "Entwurf anlegen" creates the draft with every line at once and the drawer
 * opens on it.
 *
 * One supplier per order, by design: an order has exactly one
 * (`WerkstattOrder.supplier_id`), and the merge endpoint refuses to fold two
 * suppliers together. Switching the supplier with positions in the cart keeps
 * them — the buyer picked the material, not the vendor — but a catalogue row
 * belongs to the supplier whose Datanorm it came from, so those are detached
 * from the row (keeping EAN, manufacturer and unit) and the new supplier's
 * catalogue re-resolves them by EAN. The dialog says so when it happens.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { Language, Task } from "../../types";
import type { WerkstattOrderSummary, WerkstattSupplier } from "../../types/werkstatt";
import type { OrderLineCreate } from "../../types/werkstattProcurement";
import { AmountStepper } from "./AmountStepper";
import {
  ArtikelSuchfeld,
  detachFromSupplier,
  hitKey,
  hitLabel,
  hitSupplierNo,
  hitToOrderLine,
  hitUnit,
  type ArtikelSuchTreffer,
} from "./ArtikelSuchfeld";

export interface NeueBestellungPayload {
  supplier_id: number;
  title: string | null;
  task_id: number | null;
  lines: OrderLineCreate[];
}

export interface NeueBestellungModalProps {
  open: boolean;
  language: Language;
  token: string | null;
  suppliers: ReadonlyArray<WerkstattSupplier>;
  /**
   * Suppliers with an enabled shop connection, as the page reads them from
   * the connection list. `order_channel` is the durable answer; this set is
   * the fallback for a supplier whose connection predates the channel
   * column and whose row nobody has edited since.
   */
  shopSupplierIds?: ReadonlySet<number>;
  tasks: ReadonlyArray<Task>;
  templates: ReadonlyArray<WerkstattOrderSummary>;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onCreate: (payload: NeueBestellungPayload) => void;
  onStartFromTemplate: (templateId: number, title: string | null) => void;
}

interface CartEntry {
  key: string;
  hit: ArtikelSuchTreffer;
  quantity: number | null;
}

/** Build the request the dialog sends. Pure, so the test can pin it. */
export function cartToLines(cart: ReadonlyArray<CartEntry>): OrderLineCreate[] {
  return cart.map((entry) => hitToOrderLine(entry.hit, entry.quantity ?? 1));
}

/**
 * The cart after the order moved to another supplier: catalogue rows are
 * detached (see `detachFromSupplier`), everything else survives as-is. Pure,
 * and called with the CURRENT cart before `setCart` — the count it reports
 * must not be gathered inside React's state updater, which runs later (and
 * twice in StrictMode), so a counter incremented there is read as 0.
 */
export function rehomeCart(cart: ReadonlyArray<CartEntry>): {
  cart: CartEntry[];
  converted: number;
} {
  const converted = cart.filter((entry) => entry.hit.kind === "catalog").length;
  const rehomed = cart.map((entry) => {
    if (entry.hit.kind !== "catalog") return entry;
    const hit = detachFromSupplier(entry.hit);
    return { ...entry, hit, key: hitKey(hit) };
  });
  return { cart: rehomed, converted };
}

const NO_SHOP_SUPPLIERS: ReadonlySet<number> = new Set();

export function NeueBestellungModal({
  open,
  language,
  token,
  suppliers,
  shopSupplierIds = NO_SHOP_SUPPLIERS,
  tasks,
  templates,
  busy = false,
  error = null,
  onClose,
  onCreate,
  onStartFromTemplate,
}: NeueBestellungModalProps) {
  const de = language === "de";

  const liveSuppliers = useMemo(
    () => suppliers.filter((supplier) => !supplier.is_archived),
    [suppliers],
  );
  const isShopSupplier = useCallback(
    (supplier: WerkstattSupplier) =>
      supplier.order_channel === "ids" || shopSupplierIds.has(supplier.id),
    [shopSupplierIds],
  );

  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [taskId, setTaskId] = useState<number | null>(null);
  const [cart, setCart] = useState<CartEntry[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [rehomed, setRehomed] = useState(0);

  // Re-arm on open. A dialog reopening with yesterday's cart would file
  // today's material under yesterday's supplier on a mis-click.
  useEffect(() => {
    if (!open) return;
    // The supplier with a shop connection is the one orders usually go to;
    // failing that, whoever sorts first.
    const preferred = liveSuppliers.find(isShopSupplier) ?? liveSuppliers[0] ?? null;
    setSupplierId(preferred?.id ?? null);
    setTitle("");
    setTaskId(null);
    setCart([]);
    setTemplateId(null);
    setRehomed(0);
  }, [open, liveSuppliers, isShopSupplier]);

  const supplier = liveSuppliers.find((row) => row.id === supplierId) ?? null;
  const supplierTemplates = useMemo(
    () => templates.filter((template) => template.supplier_id === supplierId),
    [templates, supplierId],
  );

  function switchSupplier(nextId: number | null) {
    if (nextId === supplierId) return;
    setSupplierId(nextId);
    setTemplateId(null);
    // Catalogue rows are the old supplier's; keep the material, drop the
    // row id (see the file header). Article and free lines survive as-is.
    const rehomedCart = rehomeCart(cart);
    setCart(rehomedCart.cart);
    setRehomed(rehomedCart.converted);
  }

  function addHit(hit: ArtikelSuchTreffer, quantity: number) {
    const key = hitKey(hit);
    setCart((entries) => {
      const existing = entries.find((entry) => entry.key === key);
      if (!existing) return [...entries, { key, hit, quantity }];
      // The same article twice is one line with more of it, not two lines.
      return entries.map((entry) =>
        entry.key === key ? { ...entry, quantity: (entry.quantity ?? 1) + quantity } : entry,
      );
    });
  }

  function setQuantity(key: string, quantity: number | null) {
    setCart((entries) =>
      entries.map((entry) => (entry.key === key ? { ...entry, quantity } : entry)),
    );
  }

  function removeEntry(key: string) {
    setCart((entries) => entries.filter((entry) => entry.key !== key));
  }

  if (!open) return null;

  const canCreate = supplierId !== null && !busy;
  const titleOrNull = title.trim() || null;

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Neue Bestellung" : "New order"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "BESTELLUNGEN › NEU" : "ORDERS › NEW"}
            </span>
            <h2 className="werkstatt-modal-title">{de ? "Neue Bestellung" : "New order"}</h2>
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

        <div className="werkstatt-modal-body werkstatt-neue-bestellung-body">
          <div className="werkstatt-neue-bestellung-form">
            <div className="werkstatt-neue-bestellung-form-row">
              <label className="werkstatt-field">
                <span className="werkstatt-field-label">{de ? "Lieferant" : "Supplier"}</span>
                <select
                  className="werkstatt-field-select"
                  value={supplierId ?? ""}
                  onChange={(event) =>
                    switchSupplier(event.target.value ? Number(event.target.value) : null)
                  }
                >
                  {liveSuppliers.length === 0 && (
                    <option value="">{de ? "— keine Lieferanten —" : "— no suppliers —"}</option>
                  )}
                  {liveSuppliers.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                      {isShopSupplier(row) ? " · Shop" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="werkstatt-field">
                <span className="werkstatt-field-label">{de ? "Titel" : "Title"}</span>
                <input
                  className="werkstatt-field-input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={de ? "z. B. Baustelle Müller" : "e.g. Müller site"}
                />
              </label>
              <label className="werkstatt-field">
                <span className="werkstatt-field-label">{de ? "Auftrag" : "Job"}</span>
                <select
                  className="werkstatt-field-select"
                  value={taskId ?? ""}
                  onChange={(event) =>
                    setTaskId(event.target.value ? Number(event.target.value) : null)
                  }
                >
                  <option value="">{de ? "— keinem Auftrag —" : "— no job —"}</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {rehomed > 0 && (
              <p className="werkstatt-neue-bestellung-warning" role="status">
                {de
                  ? `${rehomed} Katalog-Position(en) werden für den neuen Lieferanten neu aufgelöst.`
                  : `${rehomed} catalogue position(s) will be re-resolved for the new supplier.`}
              </p>
            )}

            <ArtikelSuchfeld
              token={token}
              language={language}
              supplierId={supplierId}
              supplierName={supplier?.name ?? null}
              disabled={busy || supplierId === null}
              autoFocus
              onPick={addHit}
            />

            {supplierTemplates.length > 0 && (
              <div className="werkstatt-modal-inline-actions">
                <select
                  className="werkstatt-field-select"
                  value={templateId ?? ""}
                  aria-label={de ? "Vorlage" : "Template"}
                  onChange={(event) =>
                    setTemplateId(event.target.value ? Number(event.target.value) : null)
                  }
                >
                  <option value="">{de ? "— Vorlage wählen —" : "— choose a template —"}</option>
                  {supplierTemplates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.template_name ?? template.order_number} ({template.line_count})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="werkstatt-action-btn"
                  disabled={busy || templateId === null}
                  onClick={() => templateId !== null && onStartFromTemplate(templateId, titleOrNull)}
                >
                  {de ? "Aus Vorlage starten" : "Start from template"}
                </button>
              </div>
            )}
          </div>

          <aside
            className="werkstatt-neue-bestellung-cart"
            aria-label={de ? "Positionen" : "Positions"}
          >
            <h3>
              {de ? "Positionen" : "Positions"} ({cart.length})
            </h3>
            {cart.length === 0 ? (
              <p className="werkstatt-modal-hint">
                {de
                  ? "Noch keine Positionen. Über „+“ aus der Suche übernehmen."
                  : "No positions yet. Use “+” on a search hit."}
              </p>
            ) : (
              <ul>
                {cart.map((entry) => {
                  const supplierNo = hitSupplierNo(entry.hit);
                  const unit = hitUnit(entry.hit);
                  return (
                    <li key={entry.key}>
                      <div>
                        <b>{hitLabel(entry.hit)}</b>
                        <small>
                          {[
                            entry.hit.kind === "article"
                              ? entry.hit.article.article_number
                              : entry.hit.kind === "catalog"
                                ? de
                                  ? "Katalog"
                                  : "Catalogue"
                                : entry.hit.kind === "detached"
                                  ? de
                                    ? "Freie Position (aus Katalog)"
                                    : "Free item (from catalogue)"
                                  : de
                                    ? "Freie Position"
                                    : "Free item",
                            supplierNo
                              ? `${de ? "Lieferanten-Nr." : "Supplier no."} ${supplierNo}`
                              : null,
                            entry.hit.kind === "detached" && entry.hit.item.ean
                              ? `EAN ${entry.hit.item.ean}`
                              : null,
                            unit,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </div>
                      <AmountStepper
                        value={entry.quantity}
                        onChange={(next) => setQuantity(entry.key, next)}
                        fallback={1}
                        min={1}
                        label={de ? `Menge ${hitLabel(entry.hit)}` : `Quantity ${hitLabel(entry.hit)}`}
                        decrementLabel={de ? "Weniger" : "Less"}
                        incrementLabel={de ? "Mehr" : "More"}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="werkstatt-orders-line-remove"
                        onClick={() => removeEntry(entry.key)}
                        aria-label={
                          de ? `${hitLabel(entry.hit)} entfernen` : `Remove ${hitLabel(entry.hit)}`
                        }
                      >
                        ✕
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>

        {error && <p className="werkstatt-modal-error">{error}</p>}

        <footer className="werkstatt-modal-foot">
          <button type="button" className="werkstatt-action-btn" onClick={onClose}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={!canCreate}
            onClick={() => {
              if (supplierId === null) return;
              onCreate({
                supplier_id: supplierId,
                title: titleOrNull,
                task_id: taskId,
                lines: cartToLines(cart),
              });
            }}
          >
            {de ? "Entwurf anlegen" : "Create draft"}
          </button>
        </footer>
      </div>
    </div>
  );
}
