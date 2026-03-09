import { useAppContext } from "../../context/AppContext";
import { formatMaterialQuantity } from "../../utils/materials";
import { formatShortIsoDate } from "../../utils/dates";

export function ProjectMaterialsTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    projectTrackedMaterials,
    loadProjectTrackedMaterials,
  } = useAppContext();

  if (mainView !== "project" || !activeProject || projectTab !== "materials") return null;

  return (
    <section className="grid">
      <div className="card project-materials-card">
        <div className="project-overview-card-head">
          <h3>{language === "de" ? "Material aus Berichten" : "Materials from reports"}</h3>
          <button type="button" onClick={() => void loadProjectTrackedMaterials(activeProject.id)}>
            {language === "de" ? "Aktualisieren" : "Refresh"}
          </button>
        </div>
        <small className="muted">
          {language === "de"
            ? "Gleiche Positionen (Artikel + Einheit + ArtNr) werden zusammengeführt."
            : "Matching rows (item + unit + article no.) are merged."}
        </small>
        <ul className="project-materials-list">
          {projectTrackedMaterials.map((entry, index) => {
            const quantityParts: string[] = [];
            if (entry.quantity_total != null) {
              quantityParts.push(formatMaterialQuantity(entry.quantity_total, language));
            }
            if (entry.unit) quantityParts.push(entry.unit);
            const quantityLabel = quantityParts.join(" ").trim();
            const quantityNotes =
              entry.quantity_notes.length > 0
                ? entry.quantity_notes.join(", ")
                : language === "de"
                  ? "keine"
                  : "none";
            return (
              <li
                key={`project-material-${entry.item}-${entry.unit ?? ""}-${entry.article_no ?? ""}-${index}`}
                className="materials-item project-materials-item"
              >
                <div className="materials-item-main">
                  <b>{entry.item}</b>
                  <small>
                    {language === "de" ? "Menge" : "Qty"}: <b>{quantityLabel || "-"}</b>
                  </small>
                  <small>
                    {language === "de" ? "Manuelle Mengenangaben" : "Manual qty notes"}: <b>{quantityNotes}</b>
                  </small>
                  {entry.article_no && (
                    <small>
                      {language === "de" ? "ArtNr" : "Article"}: <b>{entry.article_no}</b>
                    </small>
                  )}
                  <small>
                    {language === "de" ? "Einträge" : "Entries"}: <b>{entry.occurrence_count}</b> |{" "}
                    {language === "de" ? "Berichte" : "Reports"}: <b>{entry.report_count}</b>
                    {entry.last_report_date
                      ? ` | ${language === "de" ? "Zuletzt im Bericht" : "Last report"}: ${formatShortIsoDate(entry.last_report_date, language)}`
                      : ""}
                  </small>
                </div>
              </li>
            );
          })}
          {projectTrackedMaterials.length === 0 && (
            <li className="muted">
              {language === "de"
                ? "Noch kein Material in Berichten erfasst."
                : "No materials tracked in reports yet."}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
