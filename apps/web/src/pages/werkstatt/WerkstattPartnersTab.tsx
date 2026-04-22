import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { PartnerListRow } from "../../components/partners/PartnerListRow";
import { PartnerDetailOverlay } from "./PartnerDetailOverlay";
import type { PartnerListItem } from "../../types";

type ArchivedFilter = "all" | "active" | "archived";

/**
 * Werkstatt → Partner sub-tab. Mirrors the shape of `CustomersPage` (search
 * input + segmented filter + table) and opens `PartnerDetailOverlay` when
 * the user clicks a row. The partner list is sourced from AppContext
 * (backed by real `/partners` API), so it stays in sync with the
 * TaskModal's multi-select suggestions.
 *
 * Self-gates on `mainView === "werkstatt" && werkstattTab === "partner"`,
 * matching every other Werkstatt sub-page. That lets WerkstattPage render
 * this component inside the same flat fragment as the others — no
 * secondary tab bar needed.
 */
export function WerkstattPartnersTab() {
  const {
    mainView,
    werkstattTab,
    language,
    partners,
    loadPartners,
    openPartnerModal,
    archivePartner,
    unarchivePartner,
  } = useAppContext();

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ArchivedFilter>("active");
  const [selectedPartnerId, setSelectedPartnerId] = useState<number | null>(null);

  const isActive = mainView === "werkstatt" && werkstattTab === "partner";

  // Guard the fetch on the active check so we don't hit /api/partners every
  // time the user types in a different tab's search input.
  useEffect(() => {
    if (!isActive) return;
    void loadPartners(query, filter === "archived", null);
  }, [isActive, filter, query, loadPartners]);

  // All hooks MUST run on every render — React tracks them positionally.
  // Early-return after the hooks, never between them.
  const visiblePartners = useMemo<PartnerListItem[]>(() => {
    if (filter === "all") return partners;
    if (filter === "archived") return partners.filter((row) => row.archived_at);
    return partners.filter((row) => !row.archived_at);
  }, [partners, filter]);

  const selectedPartner = useMemo<PartnerListItem | null>(() => {
    if (selectedPartnerId == null) return null;
    return partners.find((row) => row.id === selectedPartnerId) ?? null;
  }, [partners, selectedPartnerId]);

  if (!isActive) return null;

  const de = language === "de";

  function handleArchiveToggle(partner: PartnerListItem) {
    if (partner.archived_at) {
      void unarchivePartner(partner.id);
    } else {
      void archivePartner(partner.id);
    }
  }

  return (
    <section className="werkstatt-tab-page werkstatt-partners-tab">
      <header className="customers-page-head">
        <div className="customers-page-title-block">
          <span className="customers-page-eyebrow">
            {de ? "WERKSTATT · PARTNER" : "WORKSHOP · PARTNERS"}
          </span>
          <h2 className="customers-page-title">
            {de ? "Externe Firmen" : "External partners"}
          </h2>
        </div>
        <div className="customers-page-actions">
          <button
            type="button"
            className="customers-action-btn customers-action-btn--primary"
            onClick={() => openPartnerModal({})}
          >
            + {de ? "Neuer Partner" : "New partner"}
          </button>
        </div>
      </header>

      <div className="customers-page-toolbar">
        <div className="customers-search-wrap">
          <svg
            className="customers-search-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path
              d="m15.6 15.6 4 4"
              stroke="#5C7895"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          <input
            type="search"
            className="customers-search-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              de
                ? "Firma, Gewerk, Ansprechpartner suchen…"
                : "Search company, trade, contact…"
            }
          />
        </div>
        <div
          className="customers-filter-segmented"
          role="group"
          aria-label={de ? "Partner-Filter" : "Partner filter"}
        >
          {(
            [
              { key: "all", labelDe: "Alle", labelEn: "All" },
              { key: "active", labelDe: "Aktiv", labelEn: "Active" },
              { key: "archived", labelDe: "Archiviert", labelEn: "Archived" },
            ] as const
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              className={
                filter === option.key
                  ? "customers-filter-segmented-btn customers-filter-segmented-btn--active"
                  : "customers-filter-segmented-btn"
              }
              onClick={() => setFilter(option.key)}
              aria-pressed={filter === option.key}
            >
              {de ? option.labelDe : option.labelEn}
            </button>
          ))}
        </div>
      </div>

      <div className="partner-tab-content">
        {visiblePartners.length === 0 ? (
          <div className="customers-empty muted">
            {query
              ? de
                ? `Keine Partner für "${query}" gefunden.`
                : `No partners found for "${query}".`
              : de
                ? "Noch keine Partner angelegt."
                : "No partners yet."}
          </div>
        ) : (
          <div className="customers-table-wrap partner-table-wrap">
            <table className="customers-table partner-table">
              <thead>
                <tr>
                  <th className="customer-list-th customer-list-th--name">
                    {de ? "Firma" : "Company"}
                  </th>
                  <th className="customer-list-th">{de ? "Gewerk" : "Trade"}</th>
                  <th className="customer-list-th customer-list-th--contact">
                    {de ? "Kontakt" : "Contact"}
                  </th>
                  <th className="customer-list-th">
                    {de ? "Aktuelle Aufgaben" : "Tasks"}
                  </th>
                  <th className="customer-list-th customer-list-th--activity">
                    {de ? "Letzte Aktivität" : "Last activity"}
                  </th>
                  <th className="customer-list-th customer-list-th--actions">
                    <span className="visually-hidden">
                      {de ? "Aktionen" : "Actions"}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visiblePartners.map((partner) => (
                  <PartnerListRow
                    key={`partner-row-${partner.id}`}
                    partner={partner}
                    language={de ? "de" : "en"}
                    onOpen={(id) => setSelectedPartnerId(id)}
                    onEdit={(p) => openPartnerModal({ initial: p })}
                    onArchiveToggle={handleArchiveToggle}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selectedPartner && (
          <PartnerDetailOverlay
            partner={selectedPartner}
            onClose={() => setSelectedPartnerId(null)}
          />
        )}
      </div>
    </section>
  );
}
