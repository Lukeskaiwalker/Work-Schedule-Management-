import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import {
  MOCK_NACHBESTELL_GROUPS,
  type NachbestellGroup,
  type NachbestellSeverity,
} from "../../components/werkstatt/mockData";

/**
 * WerkstattNachbestellenPage — Bestell-Bericht grouped by supplier.
 * Ported from Paper artboard 8SK-0. Self-gates on
 * `mainView === "werkstatt" && werkstattTab === "nachbestellen"`.
 *
 * Each supplier-group shows its lines with per-line stock pill, qty stepper
 * and computed line-total. Per-group subtotal + page-level total-ribbon at
 * the top. "Bestellen bei X →" CTA sits in every group header.
 *
 * Data currently from MOCK_NACHBESTELL_GROUPS. Swap to
 * GET /api/werkstatt/reorder/suggestions once wired.
 */

function formatEuro(cents: number, language: "de" | "en"): string {
  const euros = cents / 100;
  return euros.toLocaleString(language === "de" ? "de-DE" : "en-US", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUnitPrice(cents: number, language: "de" | "en"): string {
  const euros = cents / 100;
  return euros.toLocaleString(language === "de" ? "de-DE" : "en-US", {
    minimumFractionDigits: euros < 1 ? 3 : 2,
    maximumFractionDigits: 3,
  });
}

/** Severity class + accessibility label for the stock pill. */
function severityMeta(severity: NachbestellSeverity, de: boolean): {
  cls: string;
  srLabel: string;
} {
  if (severity === "out") {
    return { cls: "werkstatt-nachbestell-stock--out", srLabel: de ? "leer" : "out of stock" };
  }
  return { cls: "werkstatt-nachbestell-stock--low", srLabel: de ? "niedrig" : "low stock" };
}

export function WerkstattNachbestellenPage() {
  const { mainView, language, werkstattTab, setNotice } = useAppContext();

  // Per-line quantity overrides — keyed by line.id. Undefined → use suggested.
  const [quantityById, setQuantityById] = useState<Record<string, number>>({});

  const de = language === "de";

  /* Aggregate totals across groups. useMemo so stepper edits don't recompute
   * on every render of unrelated state changes. */
  const pageTotals = useMemo(() => {
    let totalCents = 0;
    let totalLines = 0;
    let criticalLines = 0;
    for (const group of MOCK_NACHBESTELL_GROUPS) {
      for (const line of group.lines) {
        const qty = quantityById[line.id] ?? line.suggested_quantity;
        totalCents += qty * line.unit_price_cents;
        totalLines += 1;
        if (line.severity === "out") criticalLines += 1;
      }
    }
    return { totalCents, totalLines, criticalLines };
  }, [quantityById]);

  const supplierCount = MOCK_NACHBESTELL_GROUPS.length;

  if (mainView !== "werkstatt" || werkstattTab !== "nachbestellen") return null;

  function adjustQuantity(lineId: string, suggested: number, delta: number): void {
    setQuantityById((prev) => {
      const current = prev[lineId] ?? suggested;
      const next = Math.max(0, current + delta);
      return { ...prev, [lineId]: next };
    });
  }

  function setExactQuantity(lineId: string, value: string): void {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return;
    setQuantityById((prev) => ({ ...prev, [lineId]: Math.max(0, parsed) }));
  }

  return (
    <section className="werkstatt-tab-page werkstatt-nachbestell-page">
      {/* Header — reuses existing werkstatt-sub-* classes from other sub-pages */}
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › NACHBESTELLEN" : "WERKSTATT › REORDER"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Nachbestell-Bericht" : "Reorder report"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            <span className="werkstatt-kpi-dot werkstatt-kpi-dot--warning" aria-hidden="true" />{" "}
            {de
              ? `${pageTotals.totalLines} Artikel unter Mindestbestand`
              : `${pageTotals.totalLines} items below minimum stock`}
          </p>
        </div>
        <div className="werkstatt-sub-head-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={() =>
              setNotice(
                de ? "PDF-Export wird vorbereitet (API folgt)" : "PDF export starting (API pending)",
              )
            }
          >
            {de ? "PDF exportieren" : "Export PDF"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            onClick={() =>
              setNotice(
                de
                  ? `${MOCK_NACHBESTELL_GROUPS.length} Bestellungen an Lieferanten versendet (API folgt)`
                  : `${MOCK_NACHBESTELL_GROUPS.length} orders submitted to suppliers (API pending)`,
              )
            }
          >
            {de ? "Bestellung versenden" : "Submit orders"}
          </button>
        </div>
      </header>

      {/* KPI strip */}
      <div className="werkstatt-kpi-strip werkstatt-nachbestell-kpi-strip">
        <div className="werkstatt-kpi werkstatt-kpi--neutral">
          <span className="werkstatt-kpi-label">
            {de ? "VORGESCHLAGENER BESTELLWERT" : "SUGGESTED ORDER VALUE"}
          </span>
          <div className="werkstatt-kpi-row">
            <span className="werkstatt-kpi-value">
              {formatEuro(pageTotals.totalCents, language)}
            </span>
            <span className="werkstatt-kpi-subtitle">netto</span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--info">
          <span className="werkstatt-kpi-label">
            {de ? `BEI ${supplierCount} LIEFERANTEN` : `AT ${supplierCount} SUPPLIERS`}
          </span>
          <div className="werkstatt-kpi-row">
            <span className="werkstatt-kpi-value">{pageTotals.totalLines}</span>
            <span className="werkstatt-kpi-subtitle">
              {de ? "Artikel nachzubestellen" : "items to reorder"}
            </span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--info">
          <span className="werkstatt-kpi-label">
            {de ? "BEREITS BESTELLT" : "ALREADY ON ORDER"}
          </span>
          <div className="werkstatt-kpi-row">
            <span className="werkstatt-kpi-value">3</span>
            <span className="werkstatt-kpi-subtitle">
              {de ? "Lieferung erwartet" : "deliveries pending"}
            </span>
          </div>
        </div>
        <div className="werkstatt-kpi werkstatt-kpi--danger">
          <span className="werkstatt-kpi-label">{de ? "KRITISCH" : "CRITICAL"}</span>
          <div className="werkstatt-kpi-row">
            <span className="werkstatt-kpi-value">{pageTotals.criticalLines}</span>
            <span className="werkstatt-kpi-subtitle">{de ? "völlig leer" : "completely out"}</span>
          </div>
        </div>
      </div>

      {/* Supplier-grouped list */}
      <div className="werkstatt-nachbestell-groups">
        {MOCK_NACHBESTELL_GROUPS.map((group) => (
          <SupplierGroup
            key={group.id}
            group={group}
            de={de}
            language={language}
            quantityById={quantityById}
            adjustQuantity={adjustQuantity}
            setExactQuantity={setExactQuantity}
            onSubmitGroup={(g, subtotal) => {
              const amount = formatEuro(subtotal, language);
              setNotice(
                de
                  ? `Bestellung an ${g.supplier_name} (${amount}) versendet (API folgt)`
                  : `Order to ${g.supplier_name} (${amount}) submitted (API pending)`,
              );
              // TODO(werkstatt): POST /api/werkstatt/reorder/submit
              //   { supplier_id: g.supplier_id, lines: [...], notes: null }
            }}
          />
        ))}
      </div>
    </section>
  );
}

/* ──────────────────────────────────────────────────────────────────────── */

interface SupplierGroupProps {
  group: NachbestellGroup;
  de: boolean;
  language: "de" | "en";
  quantityById: Record<string, number>;
  adjustQuantity: (lineId: string, suggested: number, delta: number) => void;
  setExactQuantity: (lineId: string, value: string) => void;
  onSubmitGroup: (group: NachbestellGroup, subtotalCents: number) => void;
}

function SupplierGroup({
  group,
  de,
  language,
  quantityById,
  adjustQuantity,
  setExactQuantity,
  onSubmitGroup,
}: SupplierGroupProps) {
  const subtotalCents = useMemo(() => {
    let sum = 0;
    for (const line of group.lines) {
      const qty = quantityById[line.id] ?? line.suggested_quantity;
      sum += qty * line.unit_price_cents;
    }
    return sum;
  }, [group.lines, quantityById]);

  return (
    <article className="werkstatt-nachbestell-group">
      <header className="werkstatt-nachbestell-group-head">
        <div className="werkstatt-nachbestell-group-identity">
          <div className="werkstatt-nachbestell-group-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
              <path d="M3.5 9.5h17" />
            </svg>
          </div>
          <div>
            <h3 className="werkstatt-nachbestell-group-name">
              {group.supplier_name}{" "}
              <span className="werkstatt-nachbestell-group-cat">
                {de ? group.supplier_category_de : group.supplier_category_en}
              </span>
            </h3>
            <p className="werkstatt-nachbestell-group-meta">
              {group.lines.length} {de ? "Artikel" : "items"} ·{" "}
              {de ? "Lieferzeit typisch" : "typical lead time"} {group.lead_time_days_label} ·{" "}
              {de ? "Kontakt" : "Contact"}: {group.contact_email}
            </p>
          </div>
        </div>
        <div className="werkstatt-nachbestell-group-totals">
          <div>
            <span className="werkstatt-nachbestell-group-subtotal-label">
              {de ? "ZWISCHENSUMME" : "SUBTOTAL"}
            </span>
            <span className="werkstatt-nachbestell-group-subtotal">
              {formatEuro(subtotalCents, language)}
            </span>
          </div>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            onClick={() => onSubmitGroup(group, subtotalCents)}
          >
            {de ? `Bestellen bei ${shortName(group.supplier_name)} →` : `Order from ${shortName(group.supplier_name)} →`}
          </button>
        </div>
      </header>

      {/* Lines */}
      <ul className="werkstatt-nachbestell-lines">
        {group.lines.map((line) => {
          const qty = quantityById[line.id] ?? line.suggested_quantity;
          const lineTotalCents = qty * line.unit_price_cents;
          const sev = severityMeta(line.severity, de);
          return (
            <li key={line.id} className="werkstatt-nachbestell-line">
              <div className="werkstatt-nachbestell-line-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" />
                  <path d="M3 7.5 12 12m0 0 9-4.5M12 12v9" />
                </svg>
              </div>
              <div className="werkstatt-nachbestell-line-main">
                <div className="werkstatt-nachbestell-line-title">{line.item_name}</div>
                <div className="werkstatt-nachbestell-line-meta">
                  <span className="werkstatt-nachbestell-line-sp">{line.article_no}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {de ? "Art.-Nr. beim Lieferanten" : "supplier art.-no"}: {line.supplier_article_no}
                  </span>
                </div>
              </div>
              <div className="werkstatt-nachbestell-line-stock">
                <span className="werkstatt-nachbestell-stock-label">{de ? "BESTAND" : "STOCK"}</span>
                <span
                  className={`werkstatt-pill ${sev.cls}`}
                  aria-label={`${sev.srLabel}: ${line.stock_label}`}
                >
                  {line.stock_label}
                </span>
              </div>
              <div className="werkstatt-nachbestell-line-qty">
                <span className="werkstatt-nachbestell-stock-label">
                  {de ? "BESTELLMENGE" : "ORDER QTY"}
                </span>
                <div className="werkstatt-stepper" role="group" aria-label={de ? "Bestellmenge" : "Order quantity"}>
                  <button
                    type="button"
                    className="werkstatt-stepper-btn"
                    aria-label={de ? "weniger" : "less"}
                    onClick={() => adjustQuantity(line.id, line.suggested_quantity, -1)}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    className="werkstatt-stepper-input"
                    inputMode="numeric"
                    min={0}
                    value={qty}
                    onChange={(e) => setExactQuantity(line.id, e.target.value)}
                  />
                  <button
                    type="button"
                    className="werkstatt-stepper-btn"
                    aria-label={de ? "mehr" : "more"}
                    onClick={() => adjustQuantity(line.id, line.suggested_quantity, 1)}
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="werkstatt-nachbestell-line-total">
                <span className="werkstatt-nachbestell-stock-label">{de ? "SUMME" : "LINE TOTAL"}</span>
                <span className="werkstatt-nachbestell-line-total-value">
                  {formatEuro(lineTotalCents, language)}
                </span>
                <span className="werkstatt-nachbestell-line-unit-price">
                  {formatUnitPrice(line.unit_price_cents, language)} € / {line.unit_label}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

/** Abbreviate the supplier's name for the per-group CTA
 * ("Contorion GmbH" → "Contorion", "voestalpine Böhler GmbH" → "voestalpine"). */
function shortName(name: string): string {
  const dropSuffixes = [" GmbH", " AG", " KG", " Group", " OHG", " SE"];
  let result = name;
  for (const suffix of dropSuffixes) {
    if (result.endsWith(suffix)) {
      result = result.slice(0, -suffix.length);
      break;
    }
  }
  // If still multi-word, use the first word.
  const firstSpace = result.indexOf(" ");
  if (firstSpace > 0) return result.slice(0, firstSpace);
  return result;
}
