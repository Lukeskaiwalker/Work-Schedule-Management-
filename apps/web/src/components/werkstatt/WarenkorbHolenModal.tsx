/**
 * WarenkorbHolenModal — fetch a shopping cart from a wholesaler.
 *
 * Two routes to the same result, because the first one is not always available:
 *
 *   Shop     — IDS-Connect punchout. Opens the wholesaler's own webshop in a
 *              new tab; the finished cart comes back on its own and lands in a
 *              draft order. Only offered when the supplier has a configured,
 *              enabled connection.
 *   XML      — paste or drop a cart file. Same parser, same audit trail. This
 *              is the path that works before the punchout is set up, and the
 *              fallback when a wholesaler mails an export instead.
 *
 * The cart can extend an existing draft ("go and get the rest") instead of
 * always starting a new order — a second trip for the same job should not
 * produce a second order to reconcile.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { Language } from "../../types";
import type { WerkstattSupplier } from "../../types/werkstatt";
import type { WerkstattOrderSummary } from "../../types/werkstatt";

export type WarenkorbMode = "shop" | "xml";

export interface WarenkorbHolenModalProps {
  open: boolean;
  language: Language;
  suppliers: ReadonlyArray<WerkstattSupplier>;
  /** Supplier ids with an enabled punchout — gates the "Shop" route. */
  shopSupplierIds: ReadonlySet<number>;
  /** Draft orders a returned cart may be appended to. */
  draftOrders: ReadonlyArray<WerkstattOrderSummary>;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onStartShop: (supplierId: number, orderId: number | null) => void;
  onImportXml: (supplierId: number, xml: string, orderId: number | null) => void;
}

export function WarenkorbHolenModal({
  open,
  language,
  suppliers,
  shopSupplierIds,
  draftOrders,
  busy = false,
  error = null,
  onClose,
  onStartShop,
  onImportXml,
}: WarenkorbHolenModalProps) {
  const de = language === "de";
  const fileInput = useRef<HTMLInputElement | null>(null);

  const liveSuppliers = useMemo(
    () => suppliers.filter((supplier) => !supplier.is_archived),
    [suppliers],
  );

  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [orderId, setOrderId] = useState<number | null>(null);
  const [mode, setMode] = useState<WarenkorbMode>("shop");
  const [xml, setXml] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  // Re-arm on open. A dialog reopening with the previous supplier still chosen
  // would file a Sonepar cart under Unielektro on a mis-click.
  useEffect(() => {
    if (!open) return;
    const preferred = liveSuppliers.find((supplier) => shopSupplierIds.has(supplier.id));
    const fallback = liveSuppliers[0] ?? null;
    setSupplierId((preferred ?? fallback)?.id ?? null);
    setOrderId(null);
    setMode(preferred ? "shop" : "xml");
    setXml("");
    setFileError(null);
  }, [open, liveSuppliers, shopSupplierIds]);

  const hasShop = supplierId !== null && shopSupplierIds.has(supplierId);

  // Fall back automatically when the chosen supplier has no punchout, so the
  // dialog is never sitting on a route its own button would reject.
  useEffect(() => {
    if (!hasShop && mode === "shop") setMode("xml");
  }, [hasShop, mode]);

  const eligibleOrders = useMemo(
    () => draftOrders.filter((order) => order.status === "draft"),
    [draftOrders],
  );

  async function readFile(file: File) {
    setFileError(null);
    try {
      // Read as text — the parser sniffs the XML declaration for the real
      // encoding, and a wrong guess here would only mangle umlauts.
      setXml(await file.text());
    } catch {
      setFileError(de ? "Datei konnte nicht gelesen werden." : "Could not read the file.");
    }
  }

  if (!open) return null;

  const canSubmit =
    supplierId !== null && !busy && (mode === "shop" ? hasShop : xml.trim().length > 0);

  function submit() {
    if (!canSubmit || supplierId === null) return;
    if (mode === "shop") onStartShop(supplierId, orderId);
    else onImportXml(supplierId, xml, orderId);
  }

  return (
    <div className="werkstatt-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="werkstatt-modal"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Warenkorb holen" : "Fetch cart"}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="werkstatt-modal-head">
          <div>
            <span className="werkstatt-sub-breadcrumb">
              {de ? "BESTELLUNGEN › WARENKORB" : "ORDERS › CART"}
            </span>
            <h2 className="werkstatt-modal-title">
              {de ? "Warenkorb holen" : "Fetch a cart"}
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
          <label className="werkstatt-field">
            <span className="werkstatt-field-label">{de ? "Lieferant" : "Supplier"}</span>
            <select
              className="werkstatt-field-select"
              value={supplierId ?? ""}
              onChange={(event) =>
                setSupplierId(event.target.value ? Number(event.target.value) : null)
              }
            >
              {liveSuppliers.length === 0 && (
                <option value="">{de ? "— keine Lieferanten —" : "— no suppliers —"}</option>
              )}
              {liveSuppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                  {shopSupplierIds.has(supplier.id) ? " · Shop" : ""}
                </option>
              ))}
            </select>
          </label>

          <div
            className="werkstatt-orders-mode-switch"
            role="tablist"
            aria-label={de ? "Quelle" : "Source"}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "shop"}
              disabled={!hasShop}
              className={`werkstatt-orders-chip${mode === "shop" ? " werkstatt-orders-chip--active" : ""}`}
              onClick={() => setMode("shop")}
              title={
                hasShop
                  ? undefined
                  : de
                    ? "Für diesen Lieferanten ist keine Shop-Anbindung eingerichtet"
                    : "This supplier has no shop connection configured"
              }
            >
              {de ? "Im Shop einkaufen" : "Shop online"}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "xml"}
              className={`werkstatt-orders-chip${mode === "xml" ? " werkstatt-orders-chip--active" : ""}`}
              onClick={() => setMode("xml")}
            >
              {de ? "XML-Datei einlesen" : "Import XML"}
            </button>
          </div>

          {mode === "shop" ? (
            <p className="werkstatt-modal-hint">
              {de
                ? "Der Shop öffnet sich in einem neuen Tab. Dort den Warenkorb zusammenstellen und auf „Warenkorb übergeben“ klicken — er landet dann automatisch hier."
                : "The shop opens in a new tab. Build the cart there and hand it over — it comes back here automatically."}
            </p>
          ) : (
            <>
              <label className="werkstatt-field">
                <span className="werkstatt-field-label">
                  {de ? "Warenkorb-XML" : "Cart XML"}
                </span>
                <textarea
                  className="werkstatt-field-input werkstatt-field-textarea"
                  rows={7}
                  value={xml}
                  spellCheck={false}
                  placeholder={'<?xml version="1.0"?>\n<IDS>…'}
                  onChange={(event) => setXml(event.target.value)}
                />
              </label>
              <div className="werkstatt-modal-inline-actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".xml,text/xml,application/xml"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file);
                    event.target.value = "";
                  }}
                />
                <button
                  type="button"
                  className="werkstatt-action-btn"
                  onClick={() => fileInput.current?.click()}
                >
                  {de ? "Datei wählen…" : "Choose file…"}
                </button>
                {xml.trim().length > 0 && (
                  <span className="werkstatt-modal-hint">
                    {de
                      ? `${xml.length.toLocaleString("de-DE")} Zeichen geladen`
                      : `${xml.length.toLocaleString("en-GB")} characters loaded`}
                  </span>
                )}
              </div>
              {fileError && <p className="werkstatt-modal-error">{fileError}</p>}
            </>
          )}

          <label className="werkstatt-field">
            <span className="werkstatt-field-label">{de ? "Ziel" : "Target"}</span>
            <select
              className="werkstatt-field-select"
              value={orderId ?? ""}
              onChange={(event) =>
                setOrderId(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">
                {de ? "— neue Bestellung anlegen —" : "— create a new order —"}
              </option>
              {eligibleOrders
                .filter((order) => supplierId === null || order.id !== null)
                .map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.order_number}
                    {order.title ? ` · ${order.title}` : ""} ({order.line_count})
                  </option>
                ))}
            </select>
          </label>

          {error && <p className="werkstatt-modal-error">{error}</p>}
        </div>

        <footer className="werkstatt-modal-foot">
          <button type="button" className="werkstatt-action-btn" onClick={onClose}>
            {de ? "Abbrechen" : "Cancel"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            disabled={!canSubmit}
            onClick={submit}
          >
            {mode === "shop"
              ? de
                ? "Shop öffnen"
                : "Open shop"
              : de
                ? "Einlesen"
                : "Import"}
          </button>
        </footer>
      </div>
    </div>
  );
}
