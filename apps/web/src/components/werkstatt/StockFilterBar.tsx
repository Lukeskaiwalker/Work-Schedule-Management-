/**
 * The Bestand page's filter bar: search, taxonomy, archived, status chips.
 *
 * Presentational only — every value and every setter belongs to the page, so
 * the filters and the list they describe cannot drift apart. Extracted because
 * the page had grown past a thousand lines and this is seventy of them that
 * nothing else in it reads.
 */
export type StockFilterKey = "all" | "available" | "low" | "empty" | "out";

export interface StockFilterDef {
  key: StockFilterKey;
  label_de: string;
  label_en: string;
  count: number;
}

export interface StockFilterBarProps {
  de: boolean;
  search: string;
  onSearch: (value: string) => void;
  category: string;
  categoryOptions: ReadonlyArray<string>;
  onCategory: (value: string) => void;
  location: string;
  locationOptions: ReadonlyArray<string>;
  onLocation: (value: string) => void;
  /** Archived rows are hidden by default; "Archivieren" promises they come
   *  back, and this is the list they come back FROM. */
  showArchived: boolean;
  onShowArchived: (value: boolean) => void;
  filters: ReadonlyArray<StockFilterDef>;
  activeFilter: StockFilterKey;
  onFilter: (key: StockFilterKey) => void;
}

export function StockFilterBar({
  de,
  search,
  onSearch,
  category,
  categoryOptions,
  onCategory,
  location,
  locationOptions,
  onLocation,
  showArchived,
  onShowArchived,
  filters,
  activeFilter,
  onFilter,
}: StockFilterBarProps) {
  return (
    <div className="werkstatt-filter-bar">
      <div className="werkstatt-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
          <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={
            de
              ? "Nach Name, Artikelnummer, Lagerort oder Kategorie suchen…"
              : "Search by name, number, location or category…"
          }
        />
      </div>
      <label className="werkstatt-select">
        <span className="werkstatt-select-label">{de ? "Kategorie:" : "Category:"}</span>
        <select value={category} onChange={(event) => onCategory(event.target.value)}>
          <option value="all">{de ? "Alle" : "All"}</option>
          {categoryOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="werkstatt-select">
        <span className="werkstatt-select-label">{de ? "Lagerort:" : "Location:"}</span>
        <select value={location} onChange={(event) => onLocation(event.target.value)}>
          <option value="all">{de ? "Alle" : "All"}</option>
          {locationOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="werkstatt-select">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => onShowArchived(event.target.checked)}
        />
        <span className="werkstatt-select-label">
          {de ? "Archivierte anzeigen" : "Show archived"}
        </span>
      </label>
      <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
        {filters.map((def) => (
          <button
            key={def.key}
            type="button"
            role="tab"
            aria-selected={activeFilter === def.key}
            className={`werkstatt-segmented-btn${
              activeFilter === def.key ? " werkstatt-segmented-btn--active" : ""
            }`}
            onClick={() => onFilter(def.key)}
          >
            {(de ? def.label_de : def.label_en)} · {def.count}
          </button>
        ))}
      </div>
    </div>
  );
}
