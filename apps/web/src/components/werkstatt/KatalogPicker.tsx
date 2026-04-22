import { useMemo, useState } from "react";
import type { MockCatalogEntry } from "./mockData";

/**
 * KatalogPicker — the multi-supplier catalog picker component reused by
 *   - the Katalog page (Paper BIV-0)
 *   - the Neuer-Artikel "Aus Katalog" tab (Paper 9ZD-0)
 *
 * Rendering rules (per WERKSTATT_CONTRACT and Paper BIV-0):
 *   - hero card when an entry has >1 supplier offer (shows the group)
 *   - compact card when an entry has exactly 1 supplier offer
 *   - amber footer callout when the picker contains any no-EAN entry
 *     (since those can't be resolved by scan later)
 *
 * This is purely a presenter — no fetching. Caller supplies entries and a
 * selection callback so both contexts can decide what "select" means.
 */
export interface KatalogPickerProps {
  entries: ReadonlyArray<MockCatalogEntry>;
  selectedEntryId: string | null;
  selectedOfferIds: ReadonlySet<string>;
  onToggleOffer: (entryId: string, offerId: string) => void;
  onSelectEntry: (entryId: string) => void;
  language: "de" | "en";
  /** When true, the picker renders without the top search field (used inside modals). */
  embedded?: boolean;
  /** Optional list of supplier names to drive the filter chips. */
  supplierChips?: ReadonlyArray<{ id: string; name: string; count: number }>;
}

export function KatalogPicker({
  entries,
  selectedEntryId,
  selectedOfferIds,
  onToggleOffer,
  onSelectEntry,
  language,
  embedded = false,
  supplierChips,
}: KatalogPickerProps) {
  const [query, setQuery] = useState("");
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const de = language === "de";

  const visibleEntries = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (
        activeChip &&
        !entry.offers.some((offer) => offer.supplier_name === activeChip)
      ) {
        return false;
      }
      if (!needle) return true;
      return (
        entry.item_name.toLowerCase().includes(needle) ||
        (entry.manufacturer?.toLowerCase().includes(needle) ?? false) ||
        (entry.ean?.includes(needle) ?? false) ||
        entry.offers.some(
          (offer) =>
            offer.supplier_article_no.toLowerCase().includes(needle) ||
            offer.supplier_name.toLowerCase().includes(needle),
        )
      );
    });
  }, [entries, query, activeChip]);

  const hasNoEan = visibleEntries.some((entry) => !entry.ean);

  return (
    <div className="werkstatt-katalog-picker">
      {!embedded && (
        <div className="werkstatt-search werkstatt-search--katalog">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              de
                ? "Name, EAN, Artikelnummer oder Hersteller suchen…"
                : "Search name, EAN, article number or manufacturer…"
            }
          />
        </div>
      )}

      {supplierChips && supplierChips.length > 0 && (
        <div className="werkstatt-chips" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeChip === null}
            className={`werkstatt-chip${activeChip === null ? " werkstatt-chip--active" : ""}`}
            onClick={() => setActiveChip(null)}
          >
            {de ? "Alle" : "All"}
            <span className="werkstatt-chip-count">
              {entries.reduce((sum, entry) => sum + entry.offers.length, 0)}
            </span>
          </button>
          {supplierChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              role="tab"
              aria-selected={activeChip === chip.name}
              className={`werkstatt-chip${activeChip === chip.name ? " werkstatt-chip--active" : ""}`}
              onClick={() => setActiveChip(chip.name)}
            >
              {chip.name}
              <span className="werkstatt-chip-count">{chip.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="werkstatt-katalog-head">
        <span>
          {de
            ? `${visibleEntries.length} Treffer · sortiert nach Relevanz`
            : `${visibleEntries.length} hits · sorted by relevance`}
        </span>
        <button type="button" className="werkstatt-katalog-sort">
          {de ? "Sortieren ▾" : "Sort ▾"}
        </button>
      </div>

      <ul className="werkstatt-katalog-list">
        {visibleEntries.map((entry) => {
          const isMulti = entry.offers.length > 1;
          const isSelected = selectedEntryId === entry.id;
          const preferred = entry.offers.find((o) => o.is_preferred) ?? entry.offers[0];
          return (
            <li
              key={entry.id}
              className={`werkstatt-katalog-card${isMulti ? " werkstatt-katalog-card--hero" : ""}${isSelected ? " werkstatt-katalog-card--selected" : ""}`}
            >
              <button
                type="button"
                className="werkstatt-katalog-card-head"
                onClick={() => onSelectEntry(entry.id)}
              >
                <span className="werkstatt-katalog-thumb" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
                      stroke="#5C7895"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="werkstatt-katalog-title">
                  <b>{entry.item_name}</b>
                  {isMulti && (
                    <span className="werkstatt-katalog-supplier-tag">
                      {entry.offers.length} {de ? "Lieferanten" : "suppliers"}
                    </span>
                  )}
                  {!isMulti && (
                    <span className="werkstatt-katalog-supplier-tag werkstatt-katalog-supplier-tag--single">
                      1 {de ? "Lieferant" : "supplier"}
                    </span>
                  )}
                  <small className="werkstatt-katalog-meta">
                    {entry.manufacturer ?? "—"} ·{" "}
                    {entry.ean
                      ? `EAN ${entry.ean}`
                      : de
                        ? "keine EAN"
                        : "no EAN"}
                  </small>
                </span>
                {!isMulti && (
                  <span className="werkstatt-katalog-hero-price">
                    <b>{preferred.price_text}</b>
                    <small>
                      {de
                        ? `${preferred.lead_time_days} Werktage`
                        : `${preferred.lead_time_days} days`}
                    </small>
                  </span>
                )}
                <span className={`werkstatt-katalog-check${isSelected ? " werkstatt-katalog-check--on" : ""}`} aria-hidden="true">
                  {isSelected ? "✓" : ""}
                </span>
              </button>

              {isMulti && (
                <ul className="werkstatt-katalog-offers">
                  {entry.offers.map((offer) => {
                    const offerSelected = selectedOfferIds.has(offer.id);
                    return (
                      <li key={offer.id} className="werkstatt-katalog-offer">
                        <button
                          type="button"
                          className={`werkstatt-katalog-offer-check${offerSelected ? " werkstatt-katalog-offer-check--on" : ""}`}
                          aria-pressed={offerSelected}
                          onClick={() => onToggleOffer(entry.id, offer.id)}
                        >
                          {offerSelected ? "✓" : ""}
                        </button>
                        <span className="werkstatt-katalog-offer-main">
                          <b>
                            {offer.supplier_name}
                            {offer.is_preferred && (
                              <span className="werkstatt-katalog-preferred">
                                {de ? "PREFERRED" : "PREFERRED"}
                              </span>
                            )}
                          </b>
                          <small>Art.-Nr. {offer.supplier_article_no}</small>
                        </span>
                        <span className="werkstatt-katalog-offer-lead">
                          {de
                            ? `${offer.lead_time_days} Werktage`
                            : `${offer.lead_time_days} days`}
                        </span>
                        <span className="werkstatt-katalog-offer-price">{offer.price_text}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
        {visibleEntries.length === 0 && (
          <li className="werkstatt-katalog-empty muted">
            {de ? "Keine Katalogeinträge gefunden." : "No catalog entries found."}
          </li>
        )}
      </ul>

      {hasNoEan && (
        <div className="werkstatt-no-ean-warn" role="note">
          <span className="werkstatt-no-ean-warn-icon" aria-hidden="true">
            ⚠
          </span>
          <span>
            {de
              ? "Keine EAN — kann später nicht per Scan gefunden werden. System verwendet die interne SP-Nummer."
              : "No EAN — cannot be found by scan later. The system will use the internal SP number."}
          </span>
        </div>
      )}
    </div>
  );
}
