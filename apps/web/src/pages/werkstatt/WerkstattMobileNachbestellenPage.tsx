import { useCallback, useState } from "react";

import { useAppContext } from "../../context/AppContext";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import { MobileNachbestellGruppe } from "../../components/werkstatt/MobileNachbestellGruppe";
import { useReorderBasket } from "../../hooks/useReorderBasket";
import { commonCurrency, formatCents } from "../../utils/reorderBasket";
import { resendBlocked } from "../../utils/reorderSendState";
import "../../styles/reorder.css";

/**
 * WerkstattMobileNachbestellenPage — the phone reorder screen.
 *
 * Self-gates on `mainView === "werkstatt"`, `werkstattTab === "nachbestellen"`
 * and a viewport under 768px; the desktop page owns everything wider.
 *
 * Wired to `GET /werkstatt/reorder/suggestions` and
 * `POST /werkstatt/reorder/submit` through `useReorderBasket`, which is the
 * same code the desktop screen runs — including the 409 that refuses a basket
 * with an unresolvable line and the "Trotzdem übergeben" override.
 *
 * One order carries exactly one supplier, so the footer button is honest
 * about how many orders it will create: it walks the groups and sends them
 * one after another, and every group then shows its own outcome. Nothing is
 * reported as sent that the server did not confirm.
 */
export function WerkstattMobileNachbestellenPage() {
  const { mainView, werkstattTab, setWerkstattTab, language } = useAppContext();
  const { isMobile } = useIsMobileViewport();

  const active = mainView === "werkstatt" && werkstattTab === "nachbestellen" && isMobile;
  const basket = useReorderBasket(active);

  // Collapsed by default except the first group: a phone screen fits about one
  // open supplier, and the buyer scrolls to the one they mean.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<number>>(() => new Set());
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<number>>(() => new Set());

  const toggleGroup = useCallback((supplierId: number, expanded: boolean) => {
    if (expanded) {
      setCollapsedIds((current) => new Set(current).add(supplierId));
      setExpandedIds((current) => {
        const next = new Set(current);
        next.delete(supplierId);
        return next;
      });
      return;
    }
    setExpandedIds((current) => new Set(current).add(supplierId));
    setCollapsedIds((current) => {
      const next = new Set(current);
      next.delete(supplierId);
      return next;
    });
  }, []);

  const de = language === "de";

  /**
   * Send every supplier that still has a basket, one after another.
   *
   * Sequential on purpose: each POST creates and sends a real order, and a
   * failure or a 409 on one supplier must not take the others with it — each
   * group keeps its own outcome, which is what the panels show afterwards.
   */
  const submitAll = useCallback(async () => {
    for (const group of basket.groups) {
      // Skips what is already ordered AND what failed without an answer: the
      // walk must never be the thing that turns an uncertain outcome into a
      // second real order (see `resendBlocked`).
      if (resendBlocked(basket.sendStateFor(group.supplier_id))) continue;
      if (basket.totalsFor(group).positionCount === 0) continue;
      await basket.submitGroup(group, false);
    }
  }, [basket]);

  if (!active) return null;

  const { totals } = basket;
  const currency = commonCurrency(basket.groups);
  const pendingGroups = basket.groups.filter(
    (group) =>
      !resendBlocked(basket.sendStateFor(group.supplier_id)) &&
      basket.totalsFor(group).positionCount > 0,
  );
  const sentCount = basket.groups.filter(
    (group) => basket.sendStateFor(group.supplier_id)?.kind === "sent",
  ).length;

  return (
    <section
      className="werkstatt-mobile werkstatt-mobile--nachbestellen"
      aria-label={de ? "Nachbestellen" : "Reorder"}
    >
      <header className="werkstatt-mobile-nach-top">
        <button
          type="button"
          className="werkstatt-mobile-icon-btn werkstatt-mobile-icon-btn--plain"
          onClick={() => setWerkstattTab("dashboard")}
          aria-label={de ? "Zurück" : "Back"}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#14293D" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18 L9 12 L15 6" />
          </svg>
        </button>
        <div className="werkstatt-mobile-nach-topcenter">
          <span className="werkstatt-mobile-nach-eyebrow">Werkstatt</span>
          <span className="werkstatt-mobile-nach-title">
            {de ? "Nachbestellen" : "Reorder"}
          </span>
        </div>
        <button
          type="button"
          className="werkstatt-mobile-icon-btn werkstatt-mobile-icon-btn--plain"
          aria-label={de ? "Aktualisieren" : "Refresh"}
          disabled={basket.loading || basket.busy}
          onClick={basket.reload}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#14293D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 12a8 8 0 1 1-2.3-5.6" />
            <path d="M20 4v5h-5" />
          </svg>
        </button>
      </header>

      {basket.loadError ? (
        <div className="reorder-banner reorder-banner--error" role="alert">
          <b>{de ? "Liste nicht geladen" : "List not loaded"}</b>
          <p>{basket.loadError}</p>
          <p>
            {de
              ? "Es werden keine Zahlen angezeigt, solange nicht gelesen werden kann."
              : "No figures are shown while the list cannot be read."}
          </p>
          <button type="button" className="werkstatt-action-btn" onClick={basket.reload}>
            {de ? "Erneut laden" : "Try again"}
          </button>
        </div>
      ) : (
        <div className="werkstatt-mobile-nach-alert">
          <span className="werkstatt-mobile-nach-alert-dot" aria-hidden="true" />
          <span className="werkstatt-mobile-nach-alert-text">
            <strong>
              {basket.loading
                ? de ? "Wird geladen…" : "Loading…"
                : de
                  ? `${totals.lineCount} Artikel unter Mindestbestand`
                  : `${totals.lineCount} items below minimum stock`}
            </strong>
            {!basket.loading && (
              <span className="werkstatt-mobile-nach-alert-suffix">
                {de
                  ? ` · ${totals.supplierCount} ${totals.supplierCount === 1 ? "Lieferant" : "Lieferanten"}`
                  : ` · ${totals.supplierCount} ${totals.supplierCount === 1 ? "supplier" : "suppliers"}`}
              </span>
            )}
          </span>
        </div>
      )}

      <div className="werkstatt-mobile-nach-body">
        {!basket.loadError && !basket.loading && basket.groups.length === 0 && (
          <div className="reorder-banner" role="status">
            <b>{de ? "Nichts nachzubestellen." : "Nothing to reorder."}</b>
            <p>
              {de
                ? "Kein Artikel liegt unter seinem Mindestbestand."
                : "No article is below its minimum stock."}
            </p>
          </div>
        )}

        {!basket.canManage && !basket.loadError && basket.groups.length > 0 && (
          <p className="reorder-permission-note">
            {de
              ? "Nur Ansicht: Bestellen erfordert die Berechtigung „werkstatt:manage“."
              : "View only: ordering requires the “werkstatt:manage” permission."}
          </p>
        )}

        {basket.groups.map((group, index) => {
          const sendState = basket.sendStateFor(group.supplier_id);
          // First group open unless closed by hand; the rest closed unless
          // opened — plus anything the server refused and anything carrying an
          // order from before a reload: a warning the buyer has to go looking
          // for is a warning they will miss.
          const needsAttention =
            sendState?.kind === "conflict" ||
            sendState?.kind === "error" ||
            (sendState?.kind === "sent" && sendState.carriedOver);
          const expanded = expandedIds.has(group.supplier_id)
            ? true
            : collapsedIds.has(group.supplier_id)
              ? false
              : index === 0 || needsAttention;
          return (
            <MobileNachbestellGruppe
              key={group.supplier_id}
              group={group}
              de={de}
              language={language}
              expanded={expanded}
              canManage={basket.canManage}
              busy={basket.busy}
              totals={basket.totalsFor(group)}
              sendState={sendState}
              quantityFor={(line) => basket.quantityFor(group, line)}
              onToggle={() => toggleGroup(group.supplier_id, expanded)}
              onStep={(line, delta) => basket.stepQuantity(group.supplier_id, line, delta)}
              onSubmit={(allowUnresolved) => {
                void basket.submitGroup(group, allowUnresolved);
              }}
              onDismiss={() => basket.dismissSendState(group.supplier_id)}
              onOpenOrders={() => setWerkstattTab("orders")}
            />
          );
        })}
      </div>

      {!basket.loadError && !basket.loading && basket.groups.length > 0 && (
        <footer className="werkstatt-mobile-nach-footer">
          <div className="werkstatt-mobile-nach-total">
            <span className="werkstatt-mobile-nach-total-label">
              {de ? "GESAMT" : "TOTAL"}
            </span>
            <span className="werkstatt-mobile-nach-total-value">
              <strong>
                {currency === null
                  ? de ? "gemischte Währungen" : "mixed currencies"
                  : formatCents(totals.cents, currency, language)}
              </strong>
              <span className="werkstatt-mobile-nach-total-count">
                {de
                  ? ` · ${totals.positionCount} Pos.${totals.unpricedCount > 0 ? ` (${totals.unpricedCount} ohne Preis)` : ""}`
                  : ` · ${totals.positionCount} lines${totals.unpricedCount > 0 ? ` (${totals.unpricedCount} unpriced)` : ""}`}
              </span>
              {sentCount > 0 && (
                <span className="werkstatt-mobile-nach-total-count">
                  {de
                    ? ` · ${sentCount} ${sentCount === 1 ? "Bestellung" : "Bestellungen"} versendet`
                    : ` · ${sentCount} ${sentCount === 1 ? "order" : "orders"} submitted`}
                </span>
              )}
            </span>
          </div>
          {basket.canManage && (
            <button
              type="button"
              className="werkstatt-mobile-nach-submit"
              onClick={() => void submitAll()}
              disabled={basket.busy || pendingGroups.length === 0}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12 L20 12" />
                <path d="M14 6 L20 12 L14 18" />
              </svg>
              <span>
                {basket.busy
                  ? de ? "Sende…" : "Sending…"
                  : pendingGroups.length === 0
                    ? de ? "Nichts offen" : "Nothing pending"
                    : pendingGroups.length === 1
                      ? de ? "Bestellung versenden" : "Send order"
                      : de
                        ? `${pendingGroups.length} Bestellungen versenden`
                        : `Send ${pendingGroups.length} orders`}
              </span>
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
