import { useState, useMemo } from "react";
import { useAppContext } from "../../context/AppContext";
import { formatMaterialQuantity } from "../../utils/materials";
import { formatShortIsoDate } from "../../utils/dates";
import { SearchIcon } from "../../components/icons";

function escapeCsvCell(value: string | number | null | undefined): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes(";")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

type SortKey = "item" | "quantity" | "article_no" | "last_report_date" | "occurrence_count";
type SortDir = "asc" | "desc";

export function ProjectMaterialsTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    projectTrackedMaterials,
    loadProjectTrackedMaterials,
  } = useAppContext();

  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("item");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const de = language === "de";

  const filteredMaterials = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? projectTrackedMaterials.filter(
          (m) =>
            m.item.toLowerCase().includes(q) ||
            (m.article_no ?? "").toLowerCase().includes(q) ||
            (m.unit ?? "").toLowerCase().includes(q),
        )
      : projectTrackedMaterials;

    return [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === "item") cmp = a.item.localeCompare(b.item);
      else if (sortKey === "quantity") cmp = (a.quantity_total ?? 0) - (b.quantity_total ?? 0);
      else if (sortKey === "article_no") cmp = (a.article_no ?? "").localeCompare(b.article_no ?? "");
      else if (sortKey === "last_report_date")
        cmp = (a.last_report_date ?? "").localeCompare(b.last_report_date ?? "");
      else if (sortKey === "occurrence_count") cmp = a.occurrence_count - b.occurrence_count;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [projectTrackedMaterials, query, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortIndicator(key: SortKey) {
    if (sortKey !== key) return null;
    return (
      <span className="project-mat-tab-sort-arrow" aria-hidden="true">
        {sortDir === "asc" ? "↑" : "↓"}
      </span>
    );
  }

  function exportCSV() {
    const headers = [
      de ? "Material" : "Material",
      de ? "ArtNr" : "Article No.",
      de ? "Menge" : "Qty",
      de ? "Einheit" : "Unit",
      de ? "Manuelle Notizen" : "Manual notes",
      de ? "Einträge" : "Entries",
      de ? "Berichte" : "Reports",
      de ? "Zuletzt im Bericht" : "Last report",
    ];
    const rows = filteredMaterials.map((m) => [
      escapeCsvCell(m.item),
      escapeCsvCell(m.article_no),
      escapeCsvCell(
        m.quantity_total != null ? formatMaterialQuantity(m.quantity_total, language) : "",
      ),
      escapeCsvCell(m.unit),
      escapeCsvCell(m.quantity_notes.join("; ")),
      escapeCsvCell(m.occurrence_count),
      escapeCsvCell(m.report_count),
      escapeCsvCell(
        m.last_report_date ? formatShortIsoDate(m.last_report_date, language) : "",
      ),
    ]);

    const csv = [
      headers.map(escapeCsvCell).join(","),
      ...rows.map((row) => row.join(",")),
    ].join("\r\n");

    // UTF-8 BOM so Excel opens the file with correct encoding
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeProject!.project_number}_material_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (mainView !== "project" || !activeProject || projectTab !== "materials") return null;

  const totalEntries = projectTrackedMaterials.reduce((s, m) => s + m.occurrence_count, 0);
  const itemCount = projectTrackedMaterials.length;

  return (
    <div className="project-mat-tab">
      <div className="project-mat-tab-toolbar">
        <label className="project-mat-tab-search">
          <span className="project-mat-tab-search-icon" aria-hidden="true">
            <SearchIcon />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={de ? "Material suchen…" : "Search materials…"}
            aria-label={de ? "Material suchen" : "Search materials"}
          />
        </label>

        <div className="project-mat-tab-stats" aria-live="polite">
          <span>
            <b>{itemCount}</b> {de ? "Positionen" : "items"}
          </span>
          <span className="project-mat-tab-stats-sep" aria-hidden="true">·</span>
          <span>
            <b>{totalEntries}</b> {de ? "Einträge gesamt" : "total entries"}
          </span>
          {query && (
            <>
              <span className="project-mat-tab-stats-sep" aria-hidden="true">·</span>
              <span className="project-mat-tab-stats-match">
                {filteredMaterials.length} {de ? "Treffer" : "matches"}
              </span>
            </>
          )}
        </div>

        <button
          type="button"
          className="project-mat-tab-tool-btn"
          onClick={exportCSV}
          disabled={projectTrackedMaterials.length === 0}
          title={de ? "Als CSV exportieren (Excel-kompatibel)" : "Export as CSV (Excel-compatible)"}
        >
          <span className="project-mat-tab-tool-btn-icon" aria-hidden="true">↓</span>
          {de ? "CSV exportieren" : "Export CSV"}
        </button>

        <button
          type="button"
          className="project-mat-tab-tool-btn"
          onClick={() => void loadProjectTrackedMaterials(activeProject.id)}
          title={de ? "Aktualisieren" : "Refresh"}
        >
          <span className="project-mat-tab-tool-btn-icon" aria-hidden="true">↻</span>
          {de ? "Aktualisieren" : "Refresh"}
        </button>
      </div>

      <div className="project-mat-tab-card">
        <div className="project-mat-tab-table" role="table">
          <div className="project-mat-tab-table-head" role="row">
            <button
              type="button"
              className="project-mat-tab-th project-mat-tab-th--item"
              onClick={() => toggleSort("item")}
              role="columnheader"
              aria-sort={
                sortKey === "item" ? (sortDir === "asc" ? "ascending" : "descending") : "none"
              }
            >
              {"Material"} {sortIndicator("item")}
            </button>
            <button
              type="button"
              className="project-mat-tab-th project-mat-tab-th--article"
              onClick={() => toggleSort("article_no")}
              role="columnheader"
              aria-sort={
                sortKey === "article_no" ? (sortDir === "asc" ? "ascending" : "descending") : "none"
              }
            >
              {de ? "ArtNr." : "Art. No."} {sortIndicator("article_no")}
            </button>
            <button
              type="button"
              className="project-mat-tab-th project-mat-tab-th--qty"
              onClick={() => toggleSort("quantity")}
              role="columnheader"
              aria-sort={
                sortKey === "quantity" ? (sortDir === "asc" ? "ascending" : "descending") : "none"
              }
            >
              {de ? "Menge" : "Qty"} {sortIndicator("quantity")}
            </button>
            <div className="project-mat-tab-th project-mat-tab-th--notes" role="columnheader">
              {de ? "Manuelle Notizen" : "Manual notes"}
            </div>
            <button
              type="button"
              className="project-mat-tab-th project-mat-tab-th--count"
              onClick={() => toggleSort("occurrence_count")}
              role="columnheader"
              aria-sort={
                sortKey === "occurrence_count"
                  ? sortDir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
              }
            >
              {de ? "Eintr. / Ber." : "Entries / Rep."}{" "}
              {sortIndicator("occurrence_count")}
            </button>
            <button
              type="button"
              className="project-mat-tab-th project-mat-tab-th--last"
              onClick={() => toggleSort("last_report_date")}
              role="columnheader"
              aria-sort={
                sortKey === "last_report_date"
                  ? sortDir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none"
              }
            >
              {de ? "Zuletzt" : "Last report"} {sortIndicator("last_report_date")}
            </button>
          </div>

          {projectTrackedMaterials.length === 0 && (
            <div className="project-mat-tab-empty">
              {de
                ? "Noch kein Material in Berichten erfasst."
                : "No materials tracked in reports yet."}
            </div>
          )}

          {projectTrackedMaterials.length > 0 &&
            filteredMaterials.map((entry, index) => {
              const quantityParts: string[] = [];
              if (entry.quantity_total != null) {
                quantityParts.push(formatMaterialQuantity(entry.quantity_total, language));
              }
              if (entry.unit) quantityParts.push(entry.unit);
              const quantityLabel = quantityParts.join("\u00a0").trim();
              const quantityNotes =
                entry.quantity_notes.length > 0 ? entry.quantity_notes.join(", ") : "–";
              // Paper design always shows both numbers (e.g. "3 / 2") so the
              // grid column reads with a consistent "entries / reports" shape
              // even when they happen to be equal.
              const countLabel = `${entry.occurrence_count} / ${entry.report_count}`;

              return (
                <div
                  key={`pm-${entry.item}-${entry.unit ?? ""}-${entry.article_no ?? ""}-${index}`}
                  className="project-mat-tab-row"
                  role="row"
                >
                  <div className="project-mat-tab-td project-mat-tab-td--item" role="cell">
                    {entry.item}
                  </div>
                  <div className="project-mat-tab-td project-mat-tab-td--article" role="cell">
                    {entry.article_no || "–"}
                  </div>
                  <div className="project-mat-tab-td project-mat-tab-td--qty" role="cell">
                    {quantityLabel || "–"}
                  </div>
                  <div className="project-mat-tab-td project-mat-tab-td--notes" role="cell">
                    {quantityNotes}
                  </div>
                  <div className="project-mat-tab-td project-mat-tab-td--count" role="cell">
                    {countLabel}
                  </div>
                  <div className="project-mat-tab-td project-mat-tab-td--last" role="cell">
                    {entry.last_report_date
                      ? formatShortIsoDate(entry.last_report_date, language)
                      : "–"}
                  </div>
                </div>
              );
            })}

          {projectTrackedMaterials.length > 0 &&
            filteredMaterials.length === 0 &&
            query && (
              <div className="project-mat-tab-empty">
                {de ? "Keine Treffer für diese Suche." : "No matches for this search."}
              </div>
            )}
        </div>
      </div>
    </div>
  );
}
