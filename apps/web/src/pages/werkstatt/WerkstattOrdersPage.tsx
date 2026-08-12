import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { BestellVorlagenModal } from "../../components/werkstatt/BestellVorlagenModal";
import { BestellungDetailPanel } from "../../components/werkstatt/BestellungDetailPanel";
import { BestellungZusammenfuehrenModal } from "../../components/werkstatt/BestellungZusammenfuehrenModal";
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
} from "../../components/werkstatt/mockData";
import type { WerkstattOrder, WerkstattOrderSummary, WerkstattSupplier } from "../../types/werkstatt";
import { listSuppliers } from "../../utils/werkstattSuppliersApi";
import {
  addOrderLine,
  applyTemplateToOrder,
  attachOrder,
  cancelOrder,
  createOrderFromTemplate,
  deleteOrderLine,
  getOrder,
  importCartXml,
  listIdsConnections,
  listOrderTemplates,
  listOrders,
  markOrderDelivered,
  markOrderSent,
  mergeOrders,
  saveOrderAsTemplate,
  startPunchout,
  submitOrderToShop,
  updateOrderLine,
} from "../../utils/werkstattOrdersApi";

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
 * `components/werkstatt/mockData.ts` — they were written for the fixtures but
 * are typed against the real API shapes, so they survived the de-mocking.
 */

type ModalKind = "cart" | "merge" | "templates" | null;

type KpiTone = "neutral" | "warning" | "info" | "danger";

interface KpiDef {
  label: string;
  value: string;
  subtitle: string;
  tone: KpiTone;
}

export function WerkstattOrdersPage() {
  const { mainView, language, werkstattTab, token, user, tasks } = useAppContext();

  const [orders, setOrders] = useState<WerkstattOrderSummary[]>([]);
  const [templates, setTemplates] = useState<WerkstattOrderSummary[]>([]);
  const [suppliers, setSuppliers] = useState<WerkstattSupplier[]>([]);
  const [shopSupplierIds, setShopSupplierIds] = useState<ReadonlySet<number>>(new Set());
  const [activeOrder, setActiveOrder] = useState<WerkstattOrder | null>(null);

  const [activeFilter, setActiveFilter] = useState<OrdersFilterKey>("all");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    } catch (err) {
      reportError(err);
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

  const openOrder = useCallback(
    async (id: number) => {
      setError(null);
      try {
        setActiveOrder(await getOrder(token, id));
      } catch (err) {
        reportError(err);
      }
    },
    [token, reportError],
  );

  /**
   * Open a punchout hand-over.
   *
   * A NEW TAB, never this one: the URL serves a form that posts itself to the
   * wholesaler, so navigating in place would replace the app. The tab is
   * opened synchronously from the click and its location set once the token
   * arrives — opening it after the await would be swallowed by the popup
   * blocker, which only trusts a window opened during a user gesture.
   */
  const openHandoff = useCallback(
    async (request: () => Promise<{ handoff_url: string; warnings?: string[] }>) => {
      const tab = window.open("", "_blank", "noopener,noreferrer");
      setBusy(true);
      setError(null);
      try {
        const handoff = await request();
        // Resolve against our own origin explicitly. The server returns a
        // relative path — the handoff page is ours, and hard-coding an
        // absolute base is what previously sent everyone to https://localhost.
        // The target tab is still `about:blank` at this point, and relying on
        // it to inherit the opener's base URL for a relative href is subtle
        // enough to be worth not relying on.
        const target = new URL(handoff.handoff_url, window.location.origin).toString();
        if (tab) tab.location.href = target;
        else window.location.assign(target);
        const opened = de
          ? "Shop geöffnet. Der Warenkorb erscheint hier, sobald er übergeben wurde."
          : "Shop opened. The cart appears here once you hand it over.";
        // Warnings first — a line the shop cannot match is the thing the user
        // needs to read, and appending the reassuring sentence after it keeps
        // both instead of one silently replacing the other.
        setNotice(
          handoff.warnings?.length ? `${handoff.warnings.join(" · ")} — ${opened}` : opened,
        );
      } catch (err) {
        tab?.close();
        reportError(err);
      } finally {
        setBusy(false);
      }
    },
    [de, reportError],
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

  const kpis: ReadonlyArray<KpiDef> = [
    {
      label: de ? "OFFEN" : "OPEN",
      value: String(kpiNumbers.openCount),
      subtitle: de ? "Bestellungen" : "orders",
      tone: "neutral",
    },
    {
      label: de ? "ÜBERFÄLLIG" : "OVERDUE",
      value: String(kpiNumbers.overdueCount),
      subtitle: de ? "Termin verpasst" : "past ETA",
      tone: "danger",
    },
    {
      label: de ? "DIESE WOCHE GELIEFERT" : "DELIVERED THIS WEEK",
      value: String(kpiNumbers.deliveredWeek),
      subtitle: de ? "Bestellungen" : "orders",
      tone: "info",
    },
    {
      label: de ? "OFFENER WARENWERT" : "OPEN VALUE",
      value: formatMoney(kpiNumbers.openValueCents, "EUR"),
      subtitle: de ? "netto, kumuliert" : "net, cumulative",
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
            {de
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
              className="werkstatt-action-btn werkstatt-action-btn--primary"
              onClick={() => setModal("cart")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              {de ? "Warenkorb holen" : "Fetch cart"}
            </button>
          )}
        </div>
      </header>

      {notice && (
        <div className="werkstatt-orders-notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(null)} aria-label={de ? "Schließen" : "Dismiss"}>
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

          {loading ? (
            <div className="werkstatt-orders-empty">{de ? "Wird geladen…" : "Loading…"}</div>
          ) : filteredOrders.length === 0 ? (
            <div className="werkstatt-orders-empty">
              {orders.length === 0
                ? de
                  ? "Noch keine Bestellungen. Über „Warenkorb holen“ lässt sich ein Warenkorb aus dem Shop des Lieferanten übernehmen."
                  : "No orders yet. Use “Fetch cart” to pull one from a supplier's shop."
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
            order={activeOrder}
            tasks={tasks}
            canManage={canManage}
            busy={busy}
            onClose={() => setActiveOrder(null)}
            onAddLine={(description, quantity, priceCents) =>
              void runMutation(() =>
                addOrderLine(token, activeOrder.id, {
                  description,
                  quantity_ordered: quantity,
                  unit_price_cents: priceCents,
                }),
              )
            }
            onUpdateLine={(lineId, patch) =>
              void runMutation(() => updateOrderLine(token, activeOrder.id, lineId, patch))
            }
            onDeleteLine={(lineId) =>
              void runMutation(() => deleteOrderLine(token, activeOrder.id, lineId))
            }
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
            onSubmitToShop={() =>
              void openHandoff(() => submitOrderToShop(token, activeOrder.id))
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
