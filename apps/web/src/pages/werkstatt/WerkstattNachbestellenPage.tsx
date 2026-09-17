import { useCallback, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { NachbestellGruppe } from "../../components/werkstatt/NachbestellGruppe";
import { useReorderBasket } from "../../hooks/useReorderBasket";
import { commonCurrency, formatCents } from "../../utils/reorderBasket";
import { orderCsvNotice } from "../../utils/reorderExportNotice";
import { downloadOrderCsv } from "../../utils/reorderOrderCsv";
import "../../styles/reorder.css";

/**
 * WerkstattNachbestellenPage — Bestell-Bericht grouped by supplier.
 *
 * Self-gates on `mainView === "werkstatt" && werkstattTab === "nachbestellen"`
 * and on a non-phone viewport (`WerkstattMobileNachbestellenPage` owns the
 * phone; both are mounted at once by `WerkstattPage`).
 *
 * Wired to the real API:
 *   GET  /werkstatt/reorder/suggestions  — the list, grouped by supplier
 *   POST /werkstatt/reorder/submit       — one order per supplier, auto-sent
 *   GET  /werkstatt/orders/{id}/export   — the CSV of an order that EXISTS
 *
 * Two things this page deliberately does not do. It does not add up a total
 * across suppliers quoted in different currencies, and it does not carry a
 * "PDF-Export" button any more: there is no export of a suggestion list in the
 * API, only of an order, so the download is offered on the order once it has
 * been created. A button that produces nothing is worse than no button.
 */
export function WerkstattNachbestellenPage() {
  const { mainView, language, werkstattTab, setWerkstattTab, token } = useAppContext();
  const { isMobile } = useIsMobileViewport();

  const active = mainView === "werkstatt" && werkstattTab === "nachbestellen" && !isMobile;
  const basket = useReorderBasket(active);

  // The CSV of a created order, per supplier: which one is downloading, what
  // the last download did, and what went wrong. Keyed by supplier so two
  // orders on screen cannot show each other's outcome.
  const [exportingSupplierId, setExportingSupplierId] = useState<number | null>(null);
  const [exportNotices, setExportNotices] = useState<ReadonlyMap<number, string>>(new Map());
  const [exportErrors, setExportErrors] = useState<ReadonlyMap<number, string>>(new Map());

  const de = language === "de";

  const putExportResult = useCallback(
    (supplierId: number, notice: string | null, error: string | null) => {
      setExportNotices((current) => {
        const next = new Map(current);
        if (notice === null) next.delete(supplierId);
        else next.set(supplierId, notice);
        return next;
      });
      setExportErrors((current) => {
        const next = new Map(current);
        if (error === null) next.delete(supplierId);
        else next.set(supplierId, error);
        return next;
      });
    },
    [],
  );

  const exportOrderCsv = useCallback(
    async (supplierId: number, orderId: number, allowUnresolved: boolean) => {
      setExportingSupplierId(supplierId);
      putExportResult(supplierId, null, null);
      try {
        const result = await downloadOrderCsv(token, orderId, allowUnresolved);
        // The file can be SHORTER than the order: the export drops every
        // position the policy cannot number. Saying so is the whole point —
        // see `orderCsvNotice`.
        putExportResult(supplierId, orderCsvNotice(result, de), null);
      } catch (err) {
        putExportResult(
          supplierId,
          null,
          de
            ? `CSV nicht erstellt: ${err instanceof Error ? err.message : String(err)}`
            : `CSV not created: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setExportingSupplierId(null);
      }
    },
    [de, putExportResult, token],
  );

  /** Forget every download message — a new list, or a new order, is a new
   *  story, and a leftover "heruntergeladen" would belong to neither. */
  const clearExportResults = useCallback(() => {
    setExportNotices(new Map());
    setExportErrors(new Map());
  }, []);

  // Parsing belongs to the field, which owns the half-typed states an input
  // goes through (see ReorderQuantityField); what arrives here is a number.
  const { setQuantity } = basket;

  if (!active) return null;

  const { totals } = basket;
  const currency = commonCurrency(basket.groups);

  return (
    <section className="werkstatt-tab-page werkstatt-nachbestell-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › NACHBESTELLEN" : "WERKSTATT › REORDER"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Nachbestell-Bericht" : "Reorder report"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {basket.loadError ? (
              de ? "Bestand konnte nicht gelesen werden." : "Stock could not be read."
            ) : basket.loading ? (
              de ? "Bestand wird gelesen…" : "Reading stock…"
            ) : (
              <>
                <span className="werkstatt-kpi-dot werkstatt-kpi-dot--warning" aria-hidden="true" />{" "}
                {de
                  ? `${totals.lineCount} Artikel unter Mindestbestand`
                  : `${totals.lineCount} ${totals.lineCount === 1 ? "item" : "items"} below minimum stock`}
              </>
            )}
          </p>
        </div>
        <div className="werkstatt-sub-head-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            disabled={basket.loading || basket.busy}
            onClick={() => {
              clearExportResults();
              basket.reload();
            }}
          >
            {de ? "Aktualisieren" : "Refresh"}
          </button>
        </div>
      </header>

      {!basket.canManage && !basket.loadError && (
        <p className="reorder-permission-note">
          {de
            ? "Nur Ansicht: Bestellen erfordert die Berechtigung „werkstatt:manage“."
            : "View only: ordering requires the “werkstatt:manage” permission."}
        </p>
      )}

      {basket.loadError && (
        <div className="reorder-banner reorder-banner--error" role="alert">
          <b>
            {de
              ? "Die Nachbestell-Vorschläge konnten nicht geladen werden."
              : "The reorder suggestions could not be loaded."}
          </b>
          <p>{basket.loadError}</p>
          <p>
            {de
              ? "Es werden keine Zahlen angezeigt, solange die Liste nicht gelesen werden kann."
              : "No figures are shown while the list cannot be read."}
          </p>
          <button type="button" className="werkstatt-action-btn" onClick={basket.reload}>
            {de ? "Erneut laden" : "Try again"}
          </button>
        </div>
      )}

      {!basket.loadError && basket.loading && (
        <div className="reorder-banner" role="status">
          {de ? "Wird geladen…" : "Loading…"}
        </div>
      )}

      {!basket.loadError && !basket.loading && basket.groups.length === 0 && (
        <div className="reorder-banner" role="status">
          <b>{de ? "Nichts nachzubestellen." : "Nothing to reorder."}</b>
          <p>
            {de
              ? "Kein Artikel liegt unter seinem Mindestbestand. Artikel ohne hinterlegten Lieferanten erscheinen hier nicht — die stehen unter Werkstatt › Bestand."
              : "No article is below its minimum stock. Articles without a supplier link do not appear here — they live under Werkstatt › Bestand."}
          </p>
        </div>
      )}

      {!basket.loadError && !basket.loading && basket.groups.length > 0 && (
        <>
          <div className="werkstatt-kpi-strip werkstatt-nachbestell-kpi-strip">
            <div className="werkstatt-kpi werkstatt-kpi--neutral">
              <span className="werkstatt-kpi-label">
                {de ? "VORGESCHLAGENER BESTELLWERT" : "SUGGESTED ORDER VALUE"}
              </span>
              <div className="werkstatt-kpi-value-row">
                <span className="werkstatt-kpi-value">
                  {currency === null
                    ? de ? "gemischte Währungen" : "mixed currencies"
                    : formatCents(totals.cents, currency, language)}
                </span>
                <span className="werkstatt-kpi-subtitle">
                  {currency === null
                    ? de ? "Summe je Lieferant unten" : "per-supplier subtotals below"
                    : totals.unpricedCount > 0
                      ? de
                        ? `netto, ohne ${totals.unpricedCount} Position(en) ohne Preis`
                        : `net, excluding ${totals.unpricedCount} line(s) without a price`
                      : "netto"}
                </span>
              </div>
            </div>
            <div className="werkstatt-kpi werkstatt-kpi--info">
              <span className="werkstatt-kpi-label">
                {de
                  ? `BEI ${totals.supplierCount} ${totals.supplierCount === 1 ? "LIEFERANT" : "LIEFERANTEN"}`
                  : `AT ${totals.supplierCount} ${totals.supplierCount === 1 ? "SUPPLIER" : "SUPPLIERS"}`}
              </span>
              <div className="werkstatt-kpi-value-row">
                <span className="werkstatt-kpi-value">{totals.positionCount}</span>
                <span className="werkstatt-kpi-subtitle">
                  {de ? "Positionen im Warenkorb" : "lines in the basket"}
                </span>
              </div>
            </div>
            <div className="werkstatt-kpi werkstatt-kpi--info">
              <span className="werkstatt-kpi-label">{de ? "OHNE PREIS" : "WITHOUT A PRICE"}</span>
              <div className="werkstatt-kpi-value-row">
                <span className="werkstatt-kpi-value">{totals.unpricedCount}</span>
                <span className="werkstatt-kpi-subtitle">
                  {totals.unpricedCount === 0
                    ? de ? "alle Positionen bepreist" : "every line priced"
                    : de ? "Summe unvollständig" : "total incomplete"}
                </span>
              </div>
            </div>
            <div className="werkstatt-kpi werkstatt-kpi--danger">
              <span className="werkstatt-kpi-label">{de ? "KRITISCH" : "CRITICAL"}</span>
              <div className="werkstatt-kpi-value-row">
                <span className="werkstatt-kpi-value">{totals.criticalCount}</span>
                <span className="werkstatt-kpi-subtitle">
                  {de ? "völlig leer" : "completely out"}
                </span>
              </div>
            </div>
          </div>

          <div className="werkstatt-nachbestell-groups">
            {basket.groups.map((group) => {
              const sendState = basket.sendStateFor(group.supplier_id);
              return (
                <NachbestellGruppe
                  key={group.supplier_id}
                  group={group}
                  de={de}
                  language={language}
                  canManage={basket.canManage}
                  busy={basket.busy}
                  totals={basket.totalsFor(group)}
                  sendState={sendState}
                  quantityFor={(line) => basket.quantityFor(group, line)}
                  onStep={(line, delta) => basket.stepQuantity(group.supplier_id, line, delta)}
                  onSetQuantity={(line, quantity) =>
                    setQuantity(group.supplier_id, line.article_id, quantity)
                  }
                  onSubmit={(allowUnresolved) => {
                    putExportResult(group.supplier_id, null, null);
                    void basket.submitGroup(group, allowUnresolved);
                  }}
                  onDismiss={() => basket.dismissSendState(group.supplier_id)}
                  onOpenOrders={() => setWerkstattTab("orders")}
                  exportAction={
                    sendState?.kind === "sent"
                      ? {
                          onExport: () => {
                            void exportOrderCsv(
                              group.supplier_id,
                              sendState.order.id,
                              sendState.allowUnresolved,
                            );
                          },
                          busy: exportingSupplierId === group.supplier_id,
                          notice: exportNotices.get(group.supplier_id) ?? null,
                          error: exportErrors.get(group.supplier_id) ?? null,
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
