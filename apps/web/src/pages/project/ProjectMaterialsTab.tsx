import { useState, useMemo } from "react";
import { useAppContext } from "../../context/AppContext";
import { formatMaterialQuantity } from "../../utils/materials";
import { formatShortIsoDate } from "../../utils/dates";
import type { ProjectTrackedMaterial } from "../../types";

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
    return <span className="project-mat-sort-arrow">{sortDir === "asc" ? " ↑" : " ↓"}</span>;
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

  return (
    <section className="grid">
      <div className="card project-materials-card">
        {/* Header */}
        <div className="project-overview-card-head">
          <div>
            <h3>{de ? "Material aus Berichten" : "Materials from reports"}</h3>
            <small className="muted">
              {de
                ? "Gleiche Positionen (Artikel + Einheit + ArtNr) werden zusammengeführt."
                : "Matching rows (item + unit + article no.) are merged."}
            </small>
          </div>
          <div className="row">
            <button
              type="button"
              onClick={exportCSV}
              disabled={projectTrackedMaterials.length === 0}
              title={de ? "Als CSV-Datei exportieren (Excel-kompatibel)" : "Export as CSV (Excel-compatible)"}
            >
              {de ? "CSV exportieren" : "Export CSV"}
            </button>
            <button
              type="button"
              onClick={() => void loadProjectTrackedMaterials(activeProject.id)}
            >
              {de ? "Aktualisieren" : "Refresh"}
            </button>
          </div>
        </div>

        {/* Summary stats */}
        {projectTrackedMaterials.length > 0 && (
          <div className="project-mat-stats">
            <span>
              <b>{projectTrackedMaterials.length}</b>{" "}
              {de ? "Positionen" : "items"}
            </span>
            <span className="project-mat-stats-sep">·</span>
            <span>
              <b>{totalEntries}</b>{" "}
              {de ? "Einträge gesamt" : "total entries"}
            </span>
            {query && (
              <>
                <span className="project-mat-stats-sep">·</span>
                <span className="project-mat-filter-hint">
                  {filteredMaterials.length}{" "}
                  {de ? "Treffer" : "matches"}
                </span>
              </>
            )}
          </div>
        )}

        {/* Search */}
        <input
          className="project-mat-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={de ? "Material suchen…" : "Search materials…"}
        />

        {projectTrackedMaterials.length === 0 ? (
          <small className="muted">
            {de
              ? "Noch kein Material in Berichten erfasst."
              : "No materials tracked in reports yet."}
          </small>
        ) : (
          <div className="project-mat-table">
            {/* Column headers */}
            <div className="project-mat-row project-mat-row--head">
              <button
                type="button"
                className="project-mat-col-btn"
                onClick={() => toggleSort("item")}
              >
                {de ? "Material" : "Material"}{sortIndicator("item")}
              </button>
              <button
                type="button"
                className="project-mat-col-btn"
                onClick={() => toggleSort("article_no")}
              >
                {de ? "ArtNr" : "Art. No."}{sortIndicator("article_no")}
              </button>
              <button
                type="button"
                className="project-mat-col-btn"
                onClick={() => toggleSort("quantity")}
              >
                {de ? "Menge" : "Qty"}{sortIndicator("quantity")}
              </button>
              <b className="project-mat-col-notes">{de ? "Manuelle Notizen" : "Manual notes"}</b>
              <button
                type="button"
                className="project-mat-col-btn"
                onClick={() => toggleSort("occurrence_count")}
              >
                {de ? "Eintr. / Ber." : "Entries / Rep."}{sortIndicator("occurrence_count")}
              </button>
              <button
                type="button"
                className="project-mat-col-btn"
                onClick={() => toggleSort("last_report_date")}
              >
                {de ? "Zuletzt" : "Last report"}{sortIndicator("last_report_date")}
              </button>
            </div>

            {filteredMaterials.map((entry, index) => {
              const quantityParts: string[] = [];
              if (entry.quantity_total != null) {
                quantityParts.push(formatMaterialQuantity(entry.quantity_total, language));
              }
              if (entry.unit) quantityParts.push(entry.unit);
              const quantityLabel = quantityParts.join("\u00a0").trim();
              const quantityNotes =
                entry.quantity_notes.length > 0 ? entry.quantity_notes.join(", ") : "–";

              return (
                <div
                  key={`pm-${entry.item}-${entry.unit ?? ""}-${entry.article_no ?? ""}-${index}`}
                  className="project-mat-row"
                >
                  <span className="project-mat-name">{entry.item}</span>
                  <small>{entry.article_no || "–"}</small>
                  <small className="project-mat-qty">
                    {quantityLabel || "–"}
                  </small>
                  <small className="project-mat-notes">{quantityNotes}</small>
                  <small className="project-mat-counts">
                    {entry.occurrence_count}
                    {entry.occurrence_count !== entry.report_count && (
                      <span className="project-mat-report-count"> / {entry.report_count}</span>
                    )}
                  </small>
                  <small>
                    {entry.last_report_date
                      ? formatShortIsoDate(entry.last_report_date, language)
                      : "–"}
                  </small>
                </div>
              );
            })}

            {filteredMaterials.length === 0 && query && (
              <small className="muted project-mat-empty">
                {de ? "Keine Treffer für diese Suche." : "No matches for this search."}
              </small>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
