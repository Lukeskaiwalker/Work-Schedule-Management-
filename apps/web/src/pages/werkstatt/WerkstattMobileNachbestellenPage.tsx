import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { useIsMobileViewport } from "../../hooks/useIsMobileViewport";
import {
  MOCK_MOBILE_REORDER_GROUPS,
  MOCK_MOBILE_REORDER_TOTAL_LABEL,
  MOCK_MOBILE_REORDER_TOTAL_ITEMS,
  MOCK_MOBILE_BELOW_MIN_COUNT,
  MOCK_MOBILE_SUPPLIER_COUNT,
  type MockMobileReorderGroup,
  type MockMobileReorderLine,
} from "../../components/werkstatt/mockData";

/**
 * WerkstattMobileNachbestellenPage — mobile reorder / supplier-grouped
 * suggestions screen, ported from Paper artboard ATF-0 ("Werkstatt —
 * Mobile: Nachbestellen").
 *
 * Self-gates on:
 *   - mainView === "werkstatt"
 *   - werkstattTab === "nachbestellen"
 *   - viewport < 768px
 *
 * Quantities are tracked locally (immutable update via spread) — pressing
 * "Bestellung versenden" currently just logs a stub to the UI. Replace
 * with POST /api/werkstatt/reorder/submit once Tablet BE lands.
 */
export function WerkstattMobileNachbestellenPage() {
  const { mainView, werkstattTab, setWerkstattTab, language } = useAppContext();
  const { isMobile } = useIsMobileViewport();

  // Track quantity overrides per line id; undefined means "use suggested".
  const [quantities, setQuantities] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(
    () =>
      new Set(MOCK_MOBILE_REORDER_GROUPS.filter((g) => g.expanded).map((g) => g.id)),
  );
  const [submitStatus, setSubmitStatus] = useState<"idle" | "submitting">(
    "idle",
  );

  const quantityFor = useMemo(() => {
    return (line: MockMobileReorderLine): number =>
      quantities.has(line.id)
        ? (quantities.get(line.id) ?? line.suggested_quantity)
        : line.suggested_quantity;
  }, [quantities]);

  if (mainView !== "werkstatt" || werkstattTab !== "nachbestellen") return null;
  if (!isMobile) return null;

  const de = language === "de";

  const stepQty = (lineId: string, suggested: number, delta: number) => {
    setQuantities((prev) => {
      const next = new Map(prev);
      const current = next.get(lineId) ?? suggested;
      const updated = Math.max(0, current + delta);
      next.set(lineId, updated);
      return next;
    });
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const submitOrder = () => {
    // TODO(werkstatt): POST /api/werkstatt/reorder/submit with
    // { supplier_id, lines[], notes } once the Tablet BE endpoint lands.
    setSubmitStatus("submitting");
    window.setTimeout(() => setSubmitStatus("idle"), 800);
  };

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
          <span className="werkstatt-mobile-nach-eyebrow">
            {de ? "Werkstatt" : "Werkstatt"}
          </span>
          <span className="werkstatt-mobile-nach-title">
            {de ? "Nachbestellen" : "Reorder"}
          </span>
        </div>
        <button
          type="button"
          className="werkstatt-mobile-icon-btn werkstatt-mobile-icon-btn--plain"
          aria-label={de ? "Filter" : "Filter"}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#14293D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 5h18" />
            <path d="M6 12h12" />
            <path d="M10 19h4" />
          </svg>
        </button>
      </header>

      <div className="werkstatt-mobile-nach-alert">
        <span
          className="werkstatt-mobile-nach-alert-dot"
          aria-hidden="true"
        />
        <span className="werkstatt-mobile-nach-alert-text">
          <strong>
            {de
              ? `${MOCK_MOBILE_BELOW_MIN_COUNT} Artikel unter Mindestbestand`
              : `${MOCK_MOBILE_BELOW_MIN_COUNT} items below minimum stock`}
          </strong>
          <span className="werkstatt-mobile-nach-alert-suffix">
            {de
              ? ` · ${MOCK_MOBILE_SUPPLIER_COUNT} Lieferanten`
              : ` · ${MOCK_MOBILE_SUPPLIER_COUNT} suppliers`}
          </span>
        </span>
      </div>

      <div className="werkstatt-mobile-nach-body">
        {MOCK_MOBILE_REORDER_GROUPS.map((group) => {
          const expanded = expandedGroups.has(group.id);
          return (
            <NachbestellenGroup
              key={group.id}
              group={group}
              expanded={expanded}
              de={de}
              quantityFor={quantityFor}
              onToggle={() => toggleGroup(group.id)}
              onStep={stepQty}
            />
          );
        })}
      </div>

      <footer className="werkstatt-mobile-nach-footer">
        <div className="werkstatt-mobile-nach-total">
          <span className="werkstatt-mobile-nach-total-label">
            {de ? "GESAMT" : "TOTAL"}
          </span>
          <span className="werkstatt-mobile-nach-total-value">
            <strong>{MOCK_MOBILE_REORDER_TOTAL_LABEL}</strong>
            <span className="werkstatt-mobile-nach-total-count">
              {de
                ? ` · ${MOCK_MOBILE_REORDER_TOTAL_ITEMS} Art.`
                : ` · ${MOCK_MOBILE_REORDER_TOTAL_ITEMS} items`}
            </span>
          </span>
        </div>
        <button
          type="button"
          className="werkstatt-mobile-nach-submit"
          onClick={submitOrder}
          disabled={submitStatus === "submitting"}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12 L20 12" />
            <path d="M14 6 L20 12 L14 18" />
          </svg>
          <span>
            {submitStatus === "submitting"
              ? de ? "Sende…" : "Sending…"
              : de ? "Bestellung versenden" : "Send order"}
          </span>
        </button>
      </footer>
    </section>
  );
}

interface NachbestellenGroupProps {
  group: MockMobileReorderGroup;
  expanded: boolean;
  de: boolean;
  quantityFor: (line: MockMobileReorderLine) => number;
  onToggle: () => void;
  onStep: (lineId: string, suggested: number, delta: number) => void;
}

function NachbestellenGroup({
  group,
  expanded,
  de,
  quantityFor,
  onToggle,
  onStep,
}: NachbestellenGroupProps) {
  return (
    <section className="werkstatt-mobile-nach-group">
      <button
        type="button"
        className="werkstatt-mobile-nach-group-head"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span
          className={`werkstatt-mobile-nach-group-caret${
            expanded ? " werkstatt-mobile-nach-group-caret--open" : ""
          }`}
          aria-hidden="true"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5C7895" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6 L15 12 L9 18" />
          </svg>
        </span>
        <span
          className="werkstatt-mobile-nach-group-icon"
          aria-hidden="true"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F70B7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9 L12 3 L21 9 V20 A1 1 0 0 1 20 21 H4 A1 1 0 0 1 3 20 Z" />
            <path d="M9 21 V13 H15 V21" />
          </svg>
        </span>
        <span className="werkstatt-mobile-nach-group-text">
          <span className="werkstatt-mobile-nach-group-name">
            {group.supplier_name}
          </span>
          <span className="werkstatt-mobile-nach-group-meta">
            {de
              ? `${group.article_count} Artikel · ${group.lead_time_label_de}`
              : `${group.article_count} items · ${group.lead_time_label_en}`}
          </span>
        </span>
        <span className="werkstatt-mobile-nach-group-total">
          {group.subtotal_label}
        </span>
      </button>
      {expanded && group.lines.length > 0 ? (
        <ul className="werkstatt-mobile-nach-lines">
          {group.lines.map((line) => (
            <li key={line.id} className="werkstatt-mobile-nach-line">
              <div className="werkstatt-mobile-nach-line-head">
                <div className="werkstatt-mobile-nach-line-name">
                  <strong>{line.item_name}</strong>
                  <div className="werkstatt-mobile-nach-line-sub">
                    <span className="werkstatt-mobile-nach-line-sku">
                      {line.article_number}
                    </span>
                    <span className="werkstatt-mobile-nach-line-price">
                      {` · ${line.unit_price_label}`}
                    </span>
                  </div>
                </div>
                <span
                  className={`werkstatt-mobile-nach-line-pill werkstatt-mobile-nach-line-pill--${line.severity}`}
                >
                  {`${line.current_stock} / ${line.stock_min}`}
                </span>
              </div>
              <div className="werkstatt-mobile-nach-line-foot">
                <div
                  className="werkstatt-mobile-nach-stepper"
                  role="group"
                  aria-label={de ? "Menge" : "Quantity"}
                >
                  <button
                    type="button"
                    className="werkstatt-mobile-nach-stepper-btn"
                    onClick={() =>
                      onStep(line.id, line.suggested_quantity, -1)
                    }
                    aria-label={de ? "Weniger" : "Less"}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F70B7" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M5 12 H19" />
                    </svg>
                  </button>
                  <span className="werkstatt-mobile-nach-stepper-value">
                    {quantityFor(line)}
                  </span>
                  <button
                    type="button"
                    className="werkstatt-mobile-nach-stepper-btn"
                    onClick={() =>
                      onStep(line.id, line.suggested_quantity, 1)
                    }
                    aria-label={de ? "Mehr" : "More"}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2F70B7" strokeWidth="2.4" strokeLinecap="round">
                      <path d="M12 5 V19" />
                      <path d="M5 12 H19" />
                    </svg>
                  </button>
                </div>
                <span className="werkstatt-mobile-nach-line-total">
                  {line.line_total_label}
                </span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
