import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import {
  MOCK_ORDERS,
  ORDERS_FILTER_CHIPS,
  canMarkDelivered,
  canMarkSent,
  daysSinceIso,
  deliveryLabel,
  formatMoney,
  orderMatchesFilter,
  orderOverdueDays,
  orderStatusLabel,
  orderStatusToTone,
  shortDate,
  type MockOrder,
  type OrdersFilterKey,
} from "../../components/werkstatt/mockData";
import type { WerkstattOrderStatus } from "../../types/werkstatt";

/**
 * WerkstattOrdersPage — supervisor order list. Self-gates on
 * `mainView === "werkstatt" && werkstattTab === "orders"`.
 *
 * There is no Paper artboard for this screen yet; the layout follows the
 * existing Werkstatt visual vocabulary (breadcrumb eyebrow → title →
 * KPI strip → filter chips → table card → right-hand detail drawer).
 *
 * Order-status transitions are stub callbacks — real wiring lives with the
 * Tablet BE agent (`POST /api/werkstatt/orders/{id}/mark-sent|mark-delivered`,
 * see WERKSTATT_CONTRACT.md §3.4).
 *
 * Presentation helpers (date / money formatting, filter chip defs) live in
 * `components/werkstatt/mockData.ts` so this file stays under the 400-line
 * size cap.
 */

// "Today" for all relative-date math. Declared once per render so every row
// sees the same instant — prevents jitter across a render pass and makes the
// helper functions pure.
const NOW_MS: number = Date.now();

type KpiTone = "neutral" | "warning" | "info" | "danger";

interface KpiDef {
  label: string;
  value: string;
  subtitle: string;
  tone: KpiTone;
}

export function WerkstattOrdersPage() {
  const { mainView, language, werkstattTab } = useAppContext();
  const [activeFilter, setActiveFilter] = useState<OrdersFilterKey>("all");
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null);
  // Local status overrides so the stub buttons feel alive without touching
  // the fixture module. Keyed by order id.
  const [statusOverrides, setStatusOverrides] = useState<
    Readonly<Record<number, WerkstattOrderStatus>>
  >({});

  const orders = useMemo<ReadonlyArray<MockOrder>>(() => {
    return MOCK_ORDERS.map((order) => {
      const override = statusOverrides[order.id];
      return override && override !== order.status
        ? { ...order, status: override }
        : order;
    });
  }, [statusOverrides]);

  const kpiNumbers = useMemo(() => {
    let openCount = 0;
    let overdueCount = 0;
    let deliveredWeek = 0;
    let openValueCents = 0;
    for (const order of orders) {
      const od = orderOverdueDays(order, NOW_MS);
      const isOpen =
        order.status !== "delivered" && order.status !== "cancelled";
      if (isOpen) {
        openCount += 1;
        openValueCents += order.total_amount_cents ?? 0;
      }
      if (od !== null && od > 0 && isOpen) overdueCount += 1;
      if (order.status === "delivered") {
        const ago = daysSinceIso(order.delivered_at, NOW_MS);
        if (ago !== null && ago <= 7) deliveredWeek += 1;
      }
    }
    return { openCount, overdueCount, deliveredWeek, openValueCents };
  }, [orders]);

  const filteredOrders = useMemo<ReadonlyArray<MockOrder>>(() => {
    return orders.filter((o) =>
      orderMatchesFilter(o, activeFilter, orderOverdueDays(o, NOW_MS)),
    );
  }, [orders, activeFilter]);

  const activeOrder = useMemo<MockOrder | null>(() => {
    if (activeOrderId === null) return null;
    return orders.find((o) => o.id === activeOrderId) ?? null;
  }, [orders, activeOrderId]);

  if (mainView !== "werkstatt" || werkstattTab !== "orders") return null;

  const de = language === "de";

  const applyTransition = (id: number, to: WerkstattOrderStatus) => {
    setStatusOverrides((current) => ({ ...current, [id]: to }));
  };

  const inTransitCount = orders.filter(
    (o) => o.status === "sent" || o.status === "confirmed",
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
          <button type="button" className="werkstatt-action-btn">
            {de ? "Exportieren" : "Export"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {de ? "Neue Bestellung" : "New order"}
          </button>
        </div>
      </header>

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
            <span className="werkstatt-orders-col werkstatt-orders-col-status">
              {de ? "STATUS" : "STATUS"}
            </span>
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
            <span
              className="werkstatt-orders-col werkstatt-orders-col-kebab"
              aria-hidden="true"
            />
          </div>

          {filteredOrders.length === 0 ? (
            <div className="werkstatt-orders-empty">
              {de ? "Keine Bestellungen für diesen Filter." : "No orders match this filter."}
            </div>
          ) : (
            <ul className="werkstatt-orders-table-body">
              {filteredOrders.map((order) => {
                const delivery = deliveryLabel(order, de, NOW_MS);
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
                      onClick={() => setActiveOrderId(order.id)}
                      aria-label={
                        de
                          ? `Bestellung ${order.order_number} öffnen`
                          : `Open order ${order.order_number}`
                      }
                    >
                      <span className="werkstatt-orders-col werkstatt-orders-col-number werkstatt-orders-col-number--value">
                        {order.order_number}
                      </span>
                      <span className="werkstatt-orders-col werkstatt-orders-col-supplier">
                        {order.supplier_name}
                      </span>
                      <span className="werkstatt-orders-col werkstatt-orders-col-status">
                        <span
                          className={`werkstatt-orders-status werkstatt-orders-status--${tone}`}
                        >
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
                    <button
                      type="button"
                      className="werkstatt-orders-kebab"
                      aria-label={de ? "Aktionen" : "Actions"}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="5" cy="12" r="1.5" fill="currentColor" />
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                        <circle cx="19" cy="12" r="1.5" fill="currentColor" />
                      </svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {activeOrder && (
          <aside
            className="werkstatt-orders-drawer"
            aria-label={de ? "Bestelldetails" : "Order details"}
          >
            <header className="werkstatt-orders-drawer-head">
              <div className="werkstatt-orders-drawer-title-block">
                <span className="werkstatt-orders-drawer-number">
                  {activeOrder.order_number}
                </span>
                <h2 className="werkstatt-orders-drawer-title">
                  {activeOrder.supplier_name}
                </h2>
                <span
                  className={`werkstatt-orders-status werkstatt-orders-status--${orderStatusToTone(activeOrder.status)}`}
                >
                  {orderStatusLabel(activeOrder.status, de)}
                </span>
              </div>
              <button
                type="button"
                className="werkstatt-orders-drawer-close"
                onClick={() => setActiveOrderId(null)}
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
                <dt>{de ? "Bestellt am" : "Ordered"}</dt>
                <dd>{shortDate(activeOrder.ordered_at, de)}</dd>
              </div>
              <div>
                <dt>{de ? "Erwartet" : "Expected"}</dt>
                <dd>{shortDate(activeOrder.expected_delivery_at, de)}</dd>
              </div>
              <div>
                <dt>{de ? "Summe" : "Total"}</dt>
                <dd>{formatMoney(activeOrder.total_amount_cents, activeOrder.currency)}</dd>
              </div>
              {activeOrder.delivery_reference && (
                <div>
                  <dt>{de ? "Lieferschein" : "Delivery ref"}</dt>
                  <dd>{activeOrder.delivery_reference}</dd>
                </div>
              )}
            </dl>

            <section className="werkstatt-orders-drawer-lines">
              <h3 className="werkstatt-orders-drawer-section-title">
                {de ? "Positionen" : "Lines"}
              </h3>
              <ul className="werkstatt-orders-drawer-lines-list">
                {activeOrder.lines.map((line) => (
                  <li key={line.id} className="werkstatt-orders-drawer-line">
                    <div className="werkstatt-orders-drawer-line-main">
                      <b>{line.article_name}</b>
                      <small>
                        {line.article_number}
                        {line.supplier_article_no ? ` · ${line.supplier_article_no}` : ""}
                      </small>
                    </div>
                    <div className="werkstatt-orders-drawer-line-qty">
                      <span>
                        {line.quantity_received} / {line.quantity_ordered}
                      </span>
                      <small>{formatMoney(line.unit_price_cents, line.currency)}</small>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <footer className="werkstatt-orders-drawer-actions">
              <button
                type="button"
                className="werkstatt-action-btn"
                disabled={!canMarkSent(activeOrder.status)}
                onClick={() => applyTransition(activeOrder.id, "sent")}
              >
                {de ? "Als versendet markieren" : "Mark as sent"}
              </button>
              <button
                type="button"
                className="werkstatt-action-btn werkstatt-action-btn--primary"
                disabled={!canMarkDelivered(activeOrder.status)}
                onClick={() => applyTransition(activeOrder.id, "delivered")}
              >
                {de ? "Als geliefert markieren" : "Mark as delivered"}
              </button>
            </footer>
          </aside>
        )}
      </div>
    </section>
  );
}
