import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { BestellVorlagenModal } from "../../components/werkstatt/BestellVorlagenModal";
import { BestellungDetailPanel } from "../../components/werkstatt/BestellungDetailPanel";
import { BestellungZusammenfuehrenModal } from "../../components/werkstatt/BestellungZusammenfuehrenModal";
import {
  NeueBestellungModal,
  type NeueBestellungPayload,
} from "../../components/werkstatt/NeueBestellungModal";
import { WarenkorbHolenModal } from "../../components/werkstatt/WarenkorbHolenModal";
import {
  ORDERS_FILTER_CHIPS,
  daysSinceIso,
  deliveryLabel,
  formatMoney,
  orderMatchesFilter,
  orderOverdueDays,
  orderStatusLabel,
  orderStatusToTone,
  shortDate,
  type OrdersFilterKey,
} from "../../components/werkstatt/orderPresentation";
import { useOrderHandover } from "../../hooks/useOrderHandover";
import type { WerkstattOrder, WerkstattOrderSummary, WerkstattSupplier } from "../../types/werkstatt";
import type { OrderResolution } from "../../types/werkstattProcurement";
import { listSuppliers } from "../../utils/werkstattSuppliersApi";
import {
  addOrderLine,
  applyTemplateToOrder,
  attachOrder,
  cancelOrder,
  createOrder,
  createOrderFromTemplate,
  deleteOrderLine,
  getOrder,
  getOrderResolution,
  importCartXml,
  listIdsConnections,
  listOrderTemplates,
  listOrders,
  markOrderDelivered,
  markOrderSent,
  mergeOrders,
  saveOrderAsTemplate,
  startPunchout,
  updateOrderLine,
} from "../../utils/werkstattOrdersApi";
import "../../styles/orders.css";
import "../../styles/werkstatt-load-states.css";

/**
 * WerkstattOrdersPage — the buyer's order list. Self-gates on
 * `mainView === "werkstatt" && werkstattTab === "orders"`.
 *
 * Wired to the real API. Beyond the plain order lifecycle it is the home of
 * procurement: pulling a cart out of a wholesaler's webshop (IDS-Connect),
 * merging the day's orders into one, and the saved templates that make a
 * recurring job one click instead of forty.
 *
 * Presentation helpers (money, dates, status tones, filter chips) live in
 * `components/werkstatt/orderPresentation.ts`. They were first written beside
 * the fixtures, but nothing about them was ever demo data — they are typed
 * against the real API shapes, which is why they outlived the fixture module.
 */

type ModalKind = "new" | "cart" | "merge" | "templates" | null;

type KpiTone = "neutral" | "warning" | "info" | "danger";

interface KpiDef {
  label: string;
  value: string;
  subtitle: string;
  tone: KpiTone;
}

export function WerkstattOrdersPage() {
  const {
    mainView,
    language,
    werkstattTab,
    token,
    user,
    tasks,
    pendingWerkstattOrderId,
    consumePendingWerkstattOrderId,
  } = useAppContext();

  const [orders, setOrders] = useState<WerkstattOrderSummary[]>([]);
  const [templates, setTemplates] = useState<WerkstattOrderSummary[]>([]);
  const [suppliers, setSuppliers] = useState<WerkstattSupplier[]>([]);
  const [shopSupplierIds, setShopSupplierIds] = useState<ReadonlySet<number>>(new Set());
  const [activeOrder, setActiveOrder] = useState<WerkstattOrder | null>(null);

  const [activeFilter, setActiveFilter] = useState<OrdersFilterKey>("all");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Set while the LIST could not be read, and not dismissible: the banner
   * above can be closed with one click, and everything this page prints —
   * four KPI figures, the subtitle, the empty state — is derived from a list
   * that is then empty for the wrong reason. Zero open orders and zero
   * overdue ones are findings; "we did not get the orders" is not one. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set only when the browser refused the popup, so the buyer still has a way
  // through. Cleared on the next hand-over attempt.
  const [blockedShopUrl, setBlockedShopUrl] = useState<string | null>(null);
  // The exported article numbers when the clipboard refused them (WebKit
  // outside a gesture, a locked-down browser): shown in a selectable box so
  // the hand-over the server already stamped is not lost. Cleared with the
  // notice and at the next export.
  const [clipboardFallback, setClipboardFallback] = useState<string | null>(null);
  // Per-line send status of the open order; re-read after every change to it.
  const [resolution, setResolution] = useState<OrderResolution | null>(null);

  const de = language === "de";
  const active = mainView === "werkstatt" && werkstattTab === "orders";
  const canManage = (user?.effective_permissions ?? []).includes("werkstatt:manage");
  /** Only admins may read the shop connections; everyone else just sees no shop button. */
  const canReadConnections = (user?.effective_permissions ?? []).includes("settings:manage");

  const reportError = useCallback(
    (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [orderRows, templateRows, supplierRows] = await Promise.all([
        listOrders(token),
        listOrderTemplates(token),
        listSuppliers(token),
      ]);
      setOrders(orderRows);
      setTemplates(templateRows);
      setSuppliers(supplierRows);
      setLoadError(null);
    } catch (err) {
      reportError(err);
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token, reportError]);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  /**
   * Which suppliers can be shopped at. Read from the connection list, which
   * needs `settings:manage`; without it the set stays empty and the shop route
   * simply is not offered. A non-admin never sees a button that would 403.
   *
   * `supplier_has_shop` on the full order covers the same question for the
   * drawer, which is why the drawer does not depend on this.
   */
  useEffect(() => {
    if (!active || !canReadConnections) return;
    let cancelled = false;
    listIdsConnections(token)
      .then((connections) => {
        if (cancelled) return;
        setShopSupplierIds(
          new Set(connections.filter((c) => c.is_enabled).map((c) => c.supplier_id)),
        );
      })
      .catch(() => {
        // Non-fatal: the XML import route still works without this.
      });
    return () => {
      cancelled = true;
    };
  }, [active, canReadConnections, token]);

  /**
   * Run a mutation, adopt the order it returns, and re-read the list.
   *
   * Every composition endpoint answers with the whole refreshed order, so the
   * drawer never needs a second round trip — but the LIST does, because line
   * counts and totals moved.
   */
  const runMutation = useCallback(
    async (action: () => Promise<WerkstattOrder | null>) => {
      setBusy(true);
      setError(null);
      try {
        const updated = await action();
        if (updated) setActiveOrder(updated);
        await refresh();
      } catch (err) {
        reportError(err);
      } finally {
        setBusy(false);
      }
    },
    [refresh, reportError],
  );

  // Everything that sends: the punchout tab, the CSV / clipboard export, the
  // 409 on a short basket and its override, and the supplier-number writes.
  const {
    conflict,
    clearConflict,
    openHandoff,
    sendActiveOrder,
    setSupplierNo,
    pickAlternative,
  } = useOrderHandover({
    token,
    de,
    activeOrder,
    setActiveOrder,
    refresh,
    runMutation,
    reportError,
    setBusy,
    setError,
    setNotice,
    setBlockedShopUrl,
    setClipboardFallback,
  });

  const openOrder = useCallback(
    async (id: number) => {
      setError(null);
      clearConflict();
      try {
        setActiveOrder(await getOrder(token, id));
      } catch (err) {
        reportError(err);
      }
    },
    [token, reportError, clearConflict],
  );

  /**
   * Re-read the send status whenever the open order changes.
   *
   * Every mutation adopts a fresh order object, so depending on the object
   * rather than its id refetches after each line change — which is when the
   * badges can move. The read is server-side read-only (no backfill), so
   * opening an order a dozen times writes nothing. A failure here clears the
   * badges rather than raising the page banner: nothing the buyer did failed.
   */
  useEffect(() => {
    if (!activeOrder) {
      setResolution(null);
      return;
    }
    let cancelled = false;
    getOrderResolution(token, activeOrder.id)
      .then((result) => {
        if (!cancelled) setResolution(result);
      })
      .catch(() => {
        if (!cancelled) setResolution(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeOrder, token]);

  /**
   * Open the order the wholesaler just sent back.
   *
   * The buyer arrives here from the shop's return POST, which App resolves into
   * `pendingWerkstattOrderId` before switching to this tab. Consuming it
   * immediately — before the await, not after — means a slow fetch cannot let a
   * re-render queue the same order twice, and re-entering the tab later does
   * not re-open a detail panel the buyer has closed.
   */
  useEffect(() => {
    if (!active || !pendingWerkstattOrderId) return;
    const id = pendingWerkstattOrderId;
    consumePendingWerkstattOrderId();
    void openOrder(id);
  }, [active, pendingWerkstattOrderId, consumePendingWerkstattOrderId, openOrder]);

  const createDraft = useCallback(
    (payload: NeueBestellungPayload) => {
      setModal(null);
      void runMutation(async () => {
        const created = await createOrder(token, payload);
        setNotice(
          de
            ? `Entwurf ${created.order_number} mit ${created.line_count} Position(en) angelegt.`
            : `Draft ${created.order_number} created with ${created.line_count} line(s).`,
        );
        return created;
      });
    },
    [de, runMutation, token],
  );

  const kpiNumbers = useMemo(() => {
    let openCount = 0;
    let overdueCount = 0;
    let deliveredWeek = 0;
    let openValueCents = 0;
    const nowMs = Date.now();
    for (const order of orders) {
      const overdue = order.days_overdue;
      const isOpen = order.status !== "delivered" && order.status !== "cancelled";
      if (isOpen) {
        openCount += 1;
        openValueCents += order.total_amount_cents ?? 0;
      }
      if (overdue !== null && overdue > 0 && isOpen) overdueCount += 1;
      if (order.status === "delivered") {
        const ago = daysSinceIso(order.delivered_at, nowMs);
        if (ago !== null && ago <= 7) deliveredWeek += 1;
      }
    }
    return { openCount, overdueCount, deliveredWeek, openValueCents };
  }, [orders]);

  const filteredOrders = useMemo(() => {
    const nowMs = Date.now();
    // The server already computes days_overdue against its own clock; the
    // local fallback only covers a summary that predates that field.
    return orders.filter((order) =>
      orderMatchesFilter(
        order,
        activeFilter,
        order.days_overdue ?? orderOverdueDays(order, nowMs),
      ),
    );
  }, [orders, activeFilter]);

  if (!active) return null;

  const inTransitCount = orders.filter(
    (order) => order.status === "sent" || order.status === "confirmed",
  ).length;

  /* No figure survives a failed load. A buyer who glances at "ÜBERFÄLLIG 0"
   * and closes the red banner otherwise walks away believing nothing is late,
   * on a page that never received the orders. */
  const unknown = de ? "nicht geladen" : "not loaded";
  const kpis: ReadonlyArray<KpiDef> = [
    {
      label: de ? "OFFEN" : "OPEN",
      value: loadError ? "—" : String(kpiNumbers.openCount),
      subtitle: loadError ? unknown : de ? "Bestellungen" : "orders",
      tone: "neutral",
    },
    {
      label: de ? "ÜBERFÄLLIG" : "OVERDUE",
      value: loadError ? "—" : String(kpiNumbers.overdueCount),
      subtitle: loadError ? unknown : de ? "Termin verpasst" : "past ETA",
      tone: "danger",
    },
    {
      label: de ? "DIESE WOCHE GELIEFERT" : "DELIVERED THIS WEEK",
      value: loadError ? "—" : String(kpiNumbers.deliveredWeek),
      subtitle: loadError ? unknown : de ? "Bestellungen" : "orders",
      tone: "info",
    },
    {
      label: de ? "OFFENER WARENWERT" : "OPEN VALUE",
      value: loadError ? "—" : formatMoney(kpiNumbers.openValueCents, "EUR"),
      subtitle: loadError ? unknown : de ? "netto, kumuliert" : "net, cumulative",
      tone: "warning",
    },
  ];

  return (
    <section className="werkstatt-tab-page werkstatt-orders-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › BESTELLUNGEN" : "WORKSHOP › ORDERS"}
          </span>
          <h1 className="werkstatt-sub-title">{de ? "Bestellungen" : "Orders"}</h1>
          <span className="werkstatt-sub-subtitle">
            {loadError
              ? de
                ? "Keine Zahlen — Bestellungen wurden nicht geladen."
                : "No figures — the orders did not load."
              : de
                ? `${kpiNumbers.openCount} offen · ${inTransitCount} unterwegs · ${kpiNumbers.deliveredWeek} geliefert diese Woche`
                : `${kpiNumbers.openCount} open · ${inTransitCount} in transit · ${kpiNumbers.deliveredWeek} delivered this week`}
          </span>
        </div>
        <div className="werkstatt-sub-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={() => setModal("templates")}
          >
            {de ? "Vorlagen" : "Templates"}
          </button>
          {canManage && (
            <button
              type="button"
              className="werkstatt-action-btn"
              onClick={() => setModal("cart")}
            >
              {de ? "Warenkorb holen" : "Fetch cart"}
            </button>
          )}
          {canManage && (
            <button
              type="button"
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={() => setModal("new")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {de ? "Neue Bestellung" : "New order"}
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div
          className={`werkstatt-orders-notice${clipboardFallback ? " werkstatt-orders-notice--stacked" : ""}`}
          role="status"
        >
          {notice}
          {clipboardFallback && (
            <textarea
              className="werkstatt-orders-notice-copy"
              readOnly
              value={clipboardFallback}
              aria-label={de ? "Artikelnummern zum Kopieren" : "Article numbers to copy"}
              onFocus={(event) => event.currentTarget.select()}
            />
          )}
          {blockedShopUrl && (
            /* A real anchor, not another window.open: the buyer's click on it is
               a fresh user gesture, which is the one thing no popup blocker
               refuses. rel keeps the opener severed as the scripted path does. */
            <a
              className="werkstatt-orders-notice-link"
              href={blockedShopUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => {
                setBlockedShopUrl(null);
                setNotice(null);
              }}
            >
              {de ? "Shop öffnen" : "Open shop"}
            </a>
          )}
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setBlockedShopUrl(null);
              setClipboardFallback(null);
            }}
            aria-label={de ? "Schließen" : "Dismiss"}
          >
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="werkstatt-orders-notice werkstatt-orders-notice--error" role="alert">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label={de ? "Schließen" : "Dismiss"}>
            ✕
          </button>
        </div>
      )}

      <div className="werkstatt-kpi-strip">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="werkstatt-kpi">
            <div className="werkstatt-kpi-label-row">
              {kpi.tone !== "neutral" && (
                <span
                  className={`werkstatt-kpi-dot werkstatt-kpi-dot--${kpi.tone}`}
                  aria-hidden="true"
                />
              )}
              <span
                className={
                  kpi.tone === "neutral"
                    ? "werkstatt-kpi-label"
                    : `werkstatt-kpi-label werkstatt-kpi-label--${kpi.tone}`
                }
              >
                {kpi.label}
              </span>
            </div>
            <div className="werkstatt-kpi-value-row">
              <span className="werkstatt-kpi-value">{kpi.value}</span>
              <span className="werkstatt-kpi-subtitle">{kpi.subtitle}</span>
            </div>
          </div>
        ))}
      </div>

      <div
        className="werkstatt-orders-filter-bar"
        role="tablist"
        aria-label={de ? "Bestellstatus filtern" : "Filter orders by status"}
      >
        {ORDERS_FILTER_CHIPS.map((chip) => (
          <button
            key={chip.key}
            type="button"
            role="tab"
            aria-selected={activeFilter === chip.key}
            className={`werkstatt-orders-chip${activeFilter === chip.key ? " werkstatt-orders-chip--active" : ""}`}
            onClick={() => setActiveFilter(chip.key)}
          >
            {de ? chip.label_de : chip.label_en}
          </button>
        ))}
      </div>

      <div
        className={`werkstatt-orders-body${activeOrder ? " werkstatt-orders-body--with-drawer" : ""}`}
      >
        <div className="werkstatt-orders-table-card">
          <div className="werkstatt-orders-table-head" role="row">
            <span className="werkstatt-orders-col werkstatt-orders-col-number">
              {de ? "BESTELLNR" : "ORDER NO"}
            </span>
            <span className="werkstatt-orders-col werkstatt-orders-col-supplier">
              {de ? "LIEFERANT" : "SUPPLIER"}
            </span>
            <span className="werkstatt-orders-col werkstatt-orders-col-status">STATUS</span>
            <span className="werkstatt-orders-col werkstatt-orders-col-items">
              {de ? "ARTIKEL" : "ITEMS"}
            </span>
            <span className="werkstatt-orders-col werkstatt-orders-col-total">
              {de ? "SUMME" : "TOTAL"}
            </span>
            <span className="werkstatt-orders-col werkstatt-orders-col-ordered">
              {de ? "BESTELLT" : "ORDERED"}
            </span>
            <span className="werkstatt-orders-col werkstatt-orders-col-expected">
              {de ? "LIEFERUNG" : "DELIVERY"}
            </span>
          </div>

          {/* The last list that did load, kept on screen rather than thrown
              away — but labelled, so nobody reads it as today's. */}
          {loadError && orders.length > 0 && (
            <div className="werkstatt-orders-stale" role="status">
              {de
                ? "Letzter geladener Stand — die Aktualisierung ist fehlgeschlagen."
                : "Last loaded state — the refresh failed."}{" "}
              <button type="button" className="werkstatt-orders-retry" onClick={() => void refresh()}>
                {de ? "Erneut versuchen" : "Try again"}
              </button>
            </div>
          )}

          {loading ? (
            <div className="werkstatt-orders-empty">{de ? "Wird geladen…" : "Loading…"}</div>
          ) : loadError && orders.length === 0 ? (
            /* NOT "Noch keine Bestellungen": that invites a buyer with forty
               open orders to create their first one. */
            <div className="werkstatt-orders-empty" role="alert">
              {de
                ? "Bestellungen konnten nicht geladen werden — das heißt nicht, dass es keine gibt."
                : "The orders could not be loaded — that does not mean there are none."}{" "}
              <span className="werkstatt-orders-empty-detail">{loadError}</span>{" "}
              <button type="button" className="werkstatt-orders-retry" onClick={() => void refresh()}>
                {de ? "Erneut versuchen" : "Try again"}
              </button>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="werkstatt-orders-empty">
              {orders.length === 0
                ? de
                  ? "Noch keine Bestellungen. Über „Neue Bestellung“ Artikel aus Lager und Lieferantenkatalog zusammenstellen, oder über „Warenkorb holen“ einen Warenkorb aus dem Shop übernehmen."
                  : "No orders yet. Use “New order” to pick articles from stock and the supplier's catalogue, or “Fetch cart” to pull one from the shop."
                : de
                  ? "Keine Bestellungen für diesen Filter."
                  : "No orders match this filter."}
            </div>
          ) : (
            <ul className="werkstatt-orders-table-body">
              {filteredOrders.map((order) => {
                const delivery = deliveryLabel(order, de, Date.now());
                const tone = orderStatusToTone(order.status);
                const isActive = activeOrder?.id === order.id;
                return (
                  <li
                    key={order.id}
                    className={`werkstatt-orders-row${isActive ? " werkstatt-orders-row--active" : ""}`}
                    role="row"
                  >
                    <button
                      type="button"
                      className="werkstatt-orders-row-btn"
                      onClick={() => void openOrder(order.id)}
                      aria-label={
                        de
                          ? `Bestellung ${order.order_number} öffnen`
                          : `Open order ${order.order_number}`
                      }
                    >
                      <span className="werkstatt-orders-col werkstatt-orders-col-number werkstatt-orders-col-number--value">
                        {order.order_number}
                        {order.title && (
                          <small className="werkstatt-orders-row-title">{order.title}</small>
                        )}
                      </span>
                      <span className="werkstatt-orders-col werkstatt-orders-col-supplier">
                        {order.supplier_name}
                        {order.task_title && (
                          <small className="werkstatt-orders-row-title">{order.task_title}</small>
                        )}
                      </span>
                      <span className="werkstatt-orders-col werkstatt-orders-col-status">
                        <span className={`werkstatt-orders-status werkstatt-orders-status--${tone}`}>
                          {orderStatusLabel(order.status, de)}
                        </span>
                      </span>
                      <span className="werkstatt-orders-col werkstatt-orders-col-items">
                        {order.line_count}
                      </span>
                      <span className="werkstatt-orders-col werkstatt-orders-col-total">
                        {formatMoney(order.total_amount_cents, order.currency)}
                      </span>
                      <span className="werkstatt-orders-col werkstatt-orders-col-ordered">
                        {shortDate(order.ordered_at, de)}
                      </span>
                      <span
                        className={`werkstatt-orders-col werkstatt-orders-col-expected werkstatt-orders-col-expected--${delivery.tone}`}
                      >
                        {delivery.text}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {activeOrder && (
          <BestellungDetailPanel
            language={language}
            token={token}
            order={activeOrder}
            tasks={tasks}
            canManage={canManage}
            busy={busy}
            resolution={resolution}
            conflict={conflict}
            onClose={() => setActiveOrder(null)}
            onAddLine={(payload) =>
              void runMutation(() => addOrderLine(token, activeOrder.id, payload))
            }
            onUpdateLine={(lineId, patch) =>
              void runMutation(() => updateOrderLine(token, activeOrder.id, lineId, patch))
            }
            onDeleteLine={(lineId) =>
              void runMutation(() => deleteOrderLine(token, activeOrder.id, lineId))
            }
            onSetSupplierNo={setSupplierNo}
            onPickAlternative={pickAlternative}
            onSend={sendActiveOrder}
            onDismissConflict={clearConflict}
            onMarkSent={() => void runMutation(() => markOrderSent(token, activeOrder.id))}
            onMarkDelivered={() =>
              void runMutation(() => markOrderDelivered(token, activeOrder.id))
            }
            onCancel={() => void runMutation(() => cancelOrder(token, activeOrder.id))}
            onMerge={() => setModal("merge")}
            onApplyTemplate={() => setModal("templates")}
            onSaveAsTemplate={(name) =>
              void runMutation(async () => {
                await saveOrderAsTemplate(token, activeOrder.id, name);
                setNotice(de ? `Vorlage „${name}“ gespeichert.` : `Template “${name}” saved.`);
                // Re-read the ORDER, not the template the call returned — the
                // drawer is still showing the order the user was working on.
                return getOrder(token, activeOrder.id);
              })
            }
            onAttachTask={(taskId) =>
              void runMutation(() => attachOrder(token, activeOrder.id, { task_id: taskId }))
            }
            onShopAgain={() =>
              void openHandoff(() =>
                startPunchout(token, {
                  supplier_id: activeOrder.supplier_id,
                  order_id: activeOrder.id,
                }),
              )
            }
          />
        )}
      </div>

      <NeueBestellungModal
        open={modal === "new"}
        language={language}
        token={token}
        suppliers={suppliers}
        shopSupplierIds={shopSupplierIds}
        tasks={tasks}
        templates={templates}
        busy={busy}
        onClose={() => setModal(null)}
        onCreate={createDraft}
        onStartFromTemplate={(templateId, title) => {
          setModal(null);
          void runMutation(() => createOrderFromTemplate(token, { template_id: templateId, title }));
        }}
      />

      <WarenkorbHolenModal
        open={modal === "cart"}
        language={language}
        suppliers={suppliers}
        shopSupplierIds={shopSupplierIds}
        draftOrders={orders}
        busy={busy}
        onClose={() => setModal(null)}
        onStartShop={(supplierId, orderId) => {
          setModal(null);
          void openHandoff(() =>
            startPunchout(token, { supplier_id: supplierId, order_id: orderId }),
          );
        }}
        onImportXml={(supplierId, xml, orderId) => {
          setModal(null);
          void runMutation(async () => {
            const result = await importCartXml(token, {
              supplier_id: supplierId,
              xml,
              order_id: orderId,
            });
            setNotice(
              de
                ? `${result.line_count} Position(en) in ${result.order_number} übernommen.`
                : `${result.line_count} line(s) imported into ${result.order_number}.`,
            );
            return getOrder(token, result.order_id);
          });
        }}
      />

      {activeOrder && (
        <BestellungZusammenfuehrenModal
          open={modal === "merge"}
          language={language}
          target={activeOrder}
          candidates={orders}
          busy={busy}
          onClose={() => setModal(null)}
          onConfirm={(sourceOrderId, combineDuplicates) => {
            setModal(null);
            void runMutation(() =>
              mergeOrders(token, activeOrder.id, sourceOrderId, combineDuplicates),
            );
          }}
        />
      )}

      <BestellVorlagenModal
        open={modal === "templates"}
        language={language}
        templates={templates}
        targetOrderId={activeOrder && activeOrder.status === "draft" ? activeOrder.id : null}
        targetSupplierId={activeOrder?.supplier_id ?? null}
        busy={busy}
        onClose={() => setModal(null)}
        onApply={(templateId) => {
          setModal(null);
          if (!activeOrder) return;
          void runMutation(() => applyTemplateToOrder(token, activeOrder.id, templateId));
        }}
        onCreate={(templateId, title) => {
          setModal(null);
          void runMutation(() => createOrderFromTemplate(token, { template_id: templateId, title }));
        }}
      />
    </section>
  );
}
