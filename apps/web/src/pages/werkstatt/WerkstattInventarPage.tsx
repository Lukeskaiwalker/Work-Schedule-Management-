import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { useBarcodeScanner } from "../../hooks/useBarcodeScanner";
import { NeuerArtikelModal } from "../../components/werkstatt/NeuerArtikelModal";
import { EntnehmenModal } from "../../components/werkstatt/EntnehmenModal";
import { BestandAnpassenModal } from "../../components/werkstatt/BestandAnpassenModal";
import {
  MOCK_INVENTORY_ROWS,
  type MockInventoryRow,
  type MockStockTone,
} from "../../components/werkstatt/mockData";

/**
 * WerkstattInventarPage — full inventory list. Ported from Paper 7RO-0
 * "Alle Artikel". Self-gates on mainView+werkstattTab. Backed by mock rows
 * until /api/werkstatt/articles lands; see WERKSTATT_CONTRACT.md §3.3.
 *
 * External HID barcode scans are routed through useBarcodeScanner — a scan
 * outside any input jumps to the matching SP-/EAN-lookup. Until the BE
 * scan-resolve endpoint exists, the callback is a stub (see TODO below).
 */
type FilterKey = "all" | "available" | "low" | "empty" | "out";

type FilterDef = {
  key: FilterKey;
  label_de: string;
  label_en: string;
  count: number;
};

export function WerkstattInventarPage() {
  const { mainView, language, werkstattTab, projects, setNotice } = useAppContext();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [location, setLocation] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<FilterKey>("all");

  /* Modal state — each modal gets its own slot; Entnehmen + BestandAnpassen
   * hold the row the user is acting on (null when closed). */
  const [neuerArtikelOpen, setNeuerArtikelOpen] = useState(false);
  const [entnehmenRow, setEntnehmenRow] = useState<MockInventoryRow | null>(null);
  const [bestandRow, setBestandRow] = useState<MockInventoryRow | null>(null);

  // TODO(werkstatt): replace stub with real /api/werkstatt/scan/resolve call.
  useBarcodeScanner({
    enabled: mainView === "werkstatt" && werkstattTab === "inventar",
    onScan: (code) => {
      // Placeholder: route the scan to the search box so users see a signal.
      setSearch(code);
    },
  });

  const counts = useMemo(() => {
    const by: Record<MockStockTone, number> = {
      available: 0,
      low: 0,
      empty: 0,
      out: 0,
    };
    for (const row of MOCK_INVENTORY_ROWS) by[row.stock_tone] += 1;
    return by;
  }, []);

  const filters: ReadonlyArray<FilterDef> = useMemo(
    () => [
      { key: "all", label_de: "Alle", label_en: "All", count: 412 },
      { key: "available", label_de: "Verfügbar", label_en: "Available", count: 368 },
      { key: "low", label_de: "Niedrig", label_en: "Low", count: 14 },
      { key: "empty", label_de: "Leer", label_en: "Empty", count: 3 },
      { key: "out", label_de: "Unterwegs", label_en: "Out", count: 27 },
    ],
    [],
  );

  const rows = useMemo<ReadonlyArray<MockInventoryRow>>(() => {
    const needle = search.trim().toLowerCase();
    return MOCK_INVENTORY_ROWS.filter((row) => {
      if (activeFilter !== "all" && row.stock_tone !== activeFilter) return false;
      if (category !== "all" && row.category !== category) return false;
      if (location !== "all" && row.location !== location) return false;
      if (!needle) return true;
      return (
        row.item_name.toLowerCase().includes(needle) ||
        row.article_no.toLowerCase().includes(needle) ||
        row.category.toLowerCase().includes(needle) ||
        row.location.toLowerCase().includes(needle)
      );
    });
  }, [search, category, location, activeFilter]);

  if (mainView !== "werkstatt" || werkstattTab !== "inventar") return null;

  const de = language === "de";
  const categoryOptions = Array.from(new Set(MOCK_INVENTORY_ROWS.map((r) => r.category)));
  const locationOptions = Array.from(new Set(MOCK_INVENTORY_ROWS.map((r) => r.location)));
  // Only the counts above are still counted; 'counts' feeds future badges.
  void counts;

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › INVENTAR" : "WORKSHOP › INVENTORY"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Alle Artikel" : "All items"}
          </h1>
        </div>
        <div className="werkstatt-sub-actions">
          <button type="button" className="werkstatt-action-btn">
            {de ? "Exportieren" : "Export"}
          </button>
          <button
            type="button"
            className="werkstatt-action-btn werkstatt-action-btn--primary"
            onClick={() => setNeuerArtikelOpen(true)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            {de ? "Neuer Artikel" : "New item"}
          </button>
        </div>
      </header>

      <div className="werkstatt-filter-bar">
        <div className="werkstatt-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="11" cy="11" r="6.3" stroke="#5C7895" strokeWidth="1.8" />
            <path d="m15.6 15.6 4 4" stroke="#5C7895" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={
              de
                ? "Nach Name, Artikelnummer, Lagerort oder Kategorie suchen…"
                : "Search by name, number, location or category…"
            }
          />
        </div>
        <label className="werkstatt-select">
          <span className="werkstatt-select-label">
            {de ? "Kategorie:" : "Category:"}
          </span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">{de ? "Alle" : "All"}</option>
            {categoryOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="werkstatt-select">
          <span className="werkstatt-select-label">
            {de ? "Lagerort:" : "Location:"}
          </span>
          <select value={location} onChange={(event) => setLocation(event.target.value)}>
            <option value="all">{de ? "Alle" : "All"}</option>
            {locationOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <div className="werkstatt-segmented werkstatt-segmented--fill" role="tablist">
          {filters.map((def) => (
            <button
              key={def.key}
              type="button"
              role="tab"
              aria-selected={activeFilter === def.key}
              className={`werkstatt-segmented-btn${activeFilter === def.key ? " werkstatt-segmented-btn--active" : ""}`}
              onClick={() => setActiveFilter(def.key)}
            >
              {(de ? def.label_de : def.label_en)} · {def.count}
            </button>
          ))}
        </div>
      </div>

      <div className="werkstatt-table-card">
        <div className="werkstatt-table-head" role="row">
          <span className="werkstatt-col werkstatt-col-checkbox" />
          <span className="werkstatt-col werkstatt-col-item">
            {de ? "ARTIKEL" : "ITEM"}
          </span>
          <span className="werkstatt-col werkstatt-col-category">
            {de ? "KATEGORIE" : "CATEGORY"}
          </span>
          <span className="werkstatt-col werkstatt-col-location">
            {de ? "LAGERORT" : "LOCATION"}
          </span>
          <span className="werkstatt-col werkstatt-col-stock">
            {de ? "BESTAND" : "STOCK"}
          </span>
          <span className="werkstatt-col werkstatt-col-out">
            {de ? "UNTERWEGS" : "OUT"}
          </span>
          <span className="werkstatt-col werkstatt-col-actions" />
        </div>

        <ul className="werkstatt-table-body">
          {rows.map((row) => (
            <li
              key={row.id}
              className="werkstatt-row werkstatt-row--clickable"
              role="row"
              onClick={(event) => {
                // Row click opens Entnehmen, BUT don't hijack clicks on the
                // checkbox / overflow button / other interactive children.
                const target = event.target as HTMLElement;
                if (target.closest("input, button")) return;
                setEntnehmenRow(row);
              }}
            >
              <span className="werkstatt-col werkstatt-col-checkbox">
                <input type="checkbox" aria-label={row.item_name} />
              </span>
              <span className="werkstatt-col werkstatt-col-item">
                <span className="werkstatt-row-thumb" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                    <path
                      d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z"
                      stroke="#5C7895"
                      strokeWidth="1.6"
                      strokeLinejoin="round"
                    />
                    <path d="M3 7.5 12 12l9-4.5M12 12v9" stroke="#5C7895" strokeWidth="1.6" />
                  </svg>
                </span>
                <span className="werkstatt-row-main">
                  <b className="werkstatt-row-name">{row.item_name}</b>
                  <small className="werkstatt-row-meta">
                    {row.article_no} · {row.sub_meta}
                  </small>
                </span>
              </span>
              <span className="werkstatt-col werkstatt-col-category">{row.category}</span>
              <span className="werkstatt-col werkstatt-col-location">{row.location}</span>
              <span className="werkstatt-col werkstatt-col-stock">
                <span className={`werkstatt-stock-pill werkstatt-stock-pill--${row.stock_tone}`}>
                  <span className="werkstatt-stock-pill-dot" aria-hidden="true" />
                  {row.stock_label}
                </span>
              </span>
              <span className="werkstatt-col werkstatt-col-out">
                {row.out_initials ? (
                  <span className="werkstatt-initials" aria-hidden="true">
                    {row.out_initials}
                  </span>
                ) : (
                  <span className="werkstatt-initials werkstatt-initials--empty" aria-hidden="true" />
                )}
                <span className="werkstatt-row-out-label">{row.out_label}</span>
              </span>
              <span className="werkstatt-col werkstatt-col-actions">
                <button
                  type="button"
                  className="werkstatt-row-overflow"
                  aria-label={de ? "Bestand anpassen" : "Adjust stock"}
                  title={de ? "Bestand anpassen" : "Adjust stock"}
                  onClick={() => setBestandRow(row)}
                >
                  …
                </button>
              </span>
            </li>
          ))}
          {rows.length === 0 && (
            <li className="werkstatt-row werkstatt-row--empty muted">
              {de ? "Keine Artikel für die aktuelle Auswahl." : "No items match the current filter."}
            </li>
          )}
        </ul>
      </div>

      {/* Modals */}
      <NeuerArtikelModal
        open={neuerArtikelOpen}
        onClose={() => setNeuerArtikelOpen(false)}
        language={language}
        onSave={(payload) => {
          setNeuerArtikelOpen(false);
          setNotice(
            de
              ? `Artikel "${payload.item_name || "Neuer Artikel"}" gespeichert (API folgt)`
              : `Article "${payload.item_name || "New item"}" saved (API pending)`,
          );
          // TODO(werkstatt): POST /api/werkstatt/articles.
        }}
      />

      {entnehmenRow && (
        <EntnehmenModal
          open={true}
          onClose={() => setEntnehmenRow(null)}
          language={language}
          article={{
            item_name: entnehmenRow.item_name,
            article_number: entnehmenRow.article_no,
            location_name: entnehmenRow.location,
            stock_available: 3, // TODO(werkstatt): derive from row
            stock_total: 4,
          }}
          projects={projects.map((p) => ({
            id: String(p.id),
            number: p.project_number,
            title: p.name,
          }))}
          onConfirm={(payload) => {
            setEntnehmenRow(null);
            setNotice(
              de
                ? `${payload.quantity}× ${entnehmenRow.item_name} entnommen (API folgt)`
                : `Checked out ${payload.quantity}× ${entnehmenRow.item_name} (API pending)`,
            );
            // TODO(werkstatt): POST /api/werkstatt/mobile/checkout.
          }}
        />
      )}

      {bestandRow && (
        <BestandAnpassenModal
          open={true}
          onClose={() => setBestandRow(null)}
          language={language}
          article={{
            item_name: bestandRow.item_name,
            article_number: bestandRow.article_no,
            category_name: bestandRow.category,
            stock_total: 4,
            unit: null,
          }}
          onConfirm={(payload) => {
            setBestandRow(null);
            setNotice(
              de
                ? `Bestand ${payload.delta >= 0 ? "+" : ""}${payload.delta} für ${bestandRow.item_name} gebucht (API folgt)`
                : `Stock adjusted by ${payload.delta} for ${bestandRow.item_name} (API pending)`,
            );
            // TODO(werkstatt): POST /api/werkstatt/articles/{id}/movements.
          }}
        />
      )}
    </section>
  );
}
