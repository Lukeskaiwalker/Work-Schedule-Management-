import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { MOCK_SUPPLIERS } from "../../components/werkstatt/mockData";

/**
 * WerkstattLieferantenPage — NEW page, no Paper artboard yet. Visual
 * language mirrors the Kategorien/Lagerorte cards from 9EE-0: a single
 * card with header + primary CTA, then a table of suppliers.
 *
 * Columns: Name · Kontakt · Std. Lieferzeit · # Artikel · # Bestellungen.
 * Self-gates on mainView+werkstattTab. TODO(werkstatt): swap to API data
 * once /api/werkstatt/suppliers lands.
 */
export function WerkstattLieferantenPage() {
  const { mainView, language, werkstattTab, setNotice } = useAppContext();
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return MOCK_SUPPLIERS;
    return MOCK_SUPPLIERS.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) ||
        row.contact_person.toLowerCase().includes(needle) ||
        row.contact_email.toLowerCase().includes(needle),
    );
  }, [search]);

  if (mainView !== "werkstatt" || werkstattTab !== "lieferanten") return null;

  const de = language === "de";

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › LIEFERANTEN" : "WORKSHOP › SUPPLIERS"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Lieferanten" : "Suppliers"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? "Partner für Datanorm-Importe und Nachbestellungen verwalten."
              : "Manage partners for Datanorm imports and reordering."}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            onClick={() =>
              setNotice(
                de
                  ? "Lieferanten-Dialog folgt — Endpoint verfügbar unter POST /api/werkstatt/suppliers"
                  : "Supplier dialog coming soon — endpoint available at POST /api/werkstatt/suppliers",
              )
            }
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {de ? "Neuer Lieferant" : "New supplier"}
          </button>
        </div>
      </header>

      <div className="werkstatt-filter-bar werkstatt-filter-bar--slim">
        <div className="werkstatt-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={de ? "Lieferant suchen…" : "Search supplier…"}
          />
        </div>
      </div>

      <div className="werkstatt-table-card">
        <div className="werkstatt-table-head werkstatt-table-head--suppliers" role="row">
          <span className="werkstatt-col">{de ? "NAME" : "NAME"}</span>
          <span className="werkstatt-col">{de ? "KONTAKT" : "CONTACT"}</span>
          <span className="werkstatt-col">{de ? "LIEFERZEIT" : "LEAD TIME"}</span>
          <span className="werkstatt-col werkstatt-col--right">{de ? "ARTIKEL" : "ITEMS"}</span>
          <span className="werkstatt-col werkstatt-col--right">{de ? "BESTELLUNGEN" : "ORDERS"}</span>
          <span className="werkstatt-col werkstatt-col-actions" />
        </div>
        <ul className="werkstatt-table-body">
          {rows.map((supplier) => (
            <li key={supplier.id} className="werkstatt-row werkstatt-row--suppliers" role="row">
              <span className="werkstatt-col">
                <span className="werkstatt-supplier-name">
                  <span className="werkstatt-supplier-chip" aria-hidden="true">
                    {supplier.name.slice(0, 1)}
                  </span>
                  <b>{supplier.name}</b>
                </span>
              </span>
              <span className="werkstatt-col">
                <span className="werkstatt-row-main">
                  <b className="werkstatt-row-name">{supplier.contact_person}</b>
                  <small className="werkstatt-row-meta">{supplier.contact_email}</small>
                </span>
              </span>
              <span className="werkstatt-col">
                {de
                  ? `${supplier.lead_time_days} Werktage`
                  : `${supplier.lead_time_days} business days`}
              </span>
              <span className="werkstatt-col werkstatt-col--right">
                {supplier.article_count.toLocaleString(de ? "de-DE" : "en-US")}
              </span>
              <span className="werkstatt-col werkstatt-col--right">
                {supplier.order_count}
              </span>
              <span className="werkstatt-col werkstatt-col-actions">
                <button
                  type="button"
                  className="werkstatt-row-overflow"
                  aria-label={de ? "Mehr Aktionen" : "More actions"}
                >
                  …
                </button>
              </span>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="werkstatt-row werkstatt-row--empty muted">
              {de ? "Keine Lieferanten gefunden." : "No suppliers found."}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
