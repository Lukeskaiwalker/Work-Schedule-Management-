import { useAppContext } from "../context/AppContext";
import { formatDayLabel, formatServerDateTime } from "../utils/dates";
import { normalizeMaterialNeedStatus, materialNeedStatusLabel, materialNeedStatusClass, nextMaterialNeedStatus } from "../utils/materials";
import { formatProjectTitleParts } from "../utils/projects";

export function MaterialsPage() {
  const {
    mainView,
    language,
    materialNeedRows,
    materialNeedUpdating,
    materialCatalogRows,
    materialCatalogState,
    materialCatalogQuery,
    setMaterialCatalogQuery,
    materialCatalogLoading,
    materialCatalogProjectSearch,
    setMaterialCatalogProjectSearch,
    materialCatalogProjectSearchFocused,
    setMaterialCatalogProjectSearchFocused,
    materialCatalogProjectSuggestions,
    materialCatalogProjectId,
    materialCatalogAdding,
    selectedMaterialCatalogProjectLabel,
    projectsById,
    projectSearchLabel,
    setActiveProjectId,
    setProjectTab,
    setProjectBackView,
    setMainView,
    loadMaterialNeeds,
    loadMaterialCatalog,
    updateMaterialNeedState,
    selectMaterialCatalogProject,
    addCatalogMaterialNeed,
  } = useAppContext();

  if (mainView !== "materials") return null;

  const imageTotal = materialCatalogState?.image_total_items ?? materialCatalogState?.item_count ?? 0;
  const imageWithImage = materialCatalogState?.image_items_with_image ?? 0;
  const imagePending = materialCatalogState?.image_items_pending ?? 0;
  const imageNotFound = materialCatalogState?.image_items_not_found ?? 0;
  const imageWaitingFallback = materialCatalogState?.image_items_waiting_fallback ?? 0;
  const imageWaitingRetry = materialCatalogState?.image_items_waiting_retry ?? 0;
  const imageLastProcessed = materialCatalogState?.image_last_run_processed ?? 0;
  const imageLookupPhase = materialCatalogState?.image_lookup_phase ?? null;
  const imageProgress = imageTotal > 0 ? Math.round((imageWithImage / imageTotal) * 100) : 0;

  return (
    <section className="card materials-view-card">
      <div className="materials-view-head">
        <h3>{language === "de" ? "Materialbedarf" : "Material needs"}</h3>
        <button
          type="button"
          onClick={() => {
            void loadMaterialNeeds();
            void loadMaterialCatalog(materialCatalogQuery);
          }}
        >
          {language === "de" ? "Aktualisieren" : "Refresh"}
        </button>
      </div>
      <div className="materials-view-layout">
        <div className="materials-panel">
          <h4>{language === "de" ? "Bedarfsliste" : "Needs list"}</h4>
          <ul className="materials-list">
            {materialNeedRows.map((entry) => {
              const normalizedStatus = normalizeMaterialNeedStatus(entry.status);
              const statusClass = materialNeedStatusClass(normalizedStatus);
              const project = projectsById.get(entry.project_id) ?? null;
              const projectLabel = formatProjectTitleParts(
                entry.project_number,
                entry.customer_name ?? project?.customer_name ?? null,
                entry.project_name,
                entry.project_id,
              );
              const isUpdating = Boolean(materialNeedUpdating[entry.id]);
              return (
                <li key={`material-need-${entry.id}`} className="materials-item">
                  {entry.image_url ? (
                    <div className="materials-item-image-wrap">
                      <img
                        src={entry.image_url}
                        alt={entry.item}
                        className="materials-item-image"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(event) => {
                          event.currentTarget.style.display = "none";
                        }}
                      />
                    </div>
                  ) : (
                    <div className="materials-item-image-wrap materials-item-image-empty" aria-hidden />
                  )}
                  <div className="materials-item-main">
                    <b>{entry.item}</b>
                    {(entry.article_no || entry.quantity || entry.unit) && (
                      <small>
                        {entry.article_no ? `${language === "de" ? "Art.-Nr." : "Article"}: ${entry.article_no}` : ""}
                        {entry.quantity ? ` | ${language === "de" ? "Menge" : "Qty"}: ${entry.quantity}` : ""}
                        {entry.unit ? ` ${entry.unit}` : ""}
                      </small>
                    )}
                    <small>
                      {language === "de" ? "Projekt" : "Project"}:{" "}
                      <button
                        type="button"
                        className="linklike"
                        onClick={() => {
                          if (!project) return;
                          setActiveProjectId(project.id);
                          setProjectTab("overview");
                          setProjectBackView(null);
                          setMainView("project");
                        }}
                      >
                        {projectLabel.title}
                      </button>
                    </small>
                    {projectLabel.subtitle && <small className="project-name-subtle">{projectLabel.subtitle}</small>}
                    <small>
                      {language === "de" ? "Berichtdatum" : "Report date"}:{" "}
                      {entry.report_date ? formatDayLabel(entry.report_date, language) : "-"}
                    </small>
                  </div>
                  <div className="materials-item-actions">
                    <button
                      type="button"
                      className={`materials-status-badge materials-status-toggle ${statusClass}`}
                      disabled={isUpdating}
                      onClick={() => void updateMaterialNeedState(entry.id, nextMaterialNeedStatus(normalizedStatus))}
                      title={
                        language === "de"
                          ? `Status wechseln zu: ${materialNeedStatusLabel(nextMaterialNeedStatus(normalizedStatus), language)}`
                          : `Change status to: ${materialNeedStatusLabel(nextMaterialNeedStatus(normalizedStatus), language)}`
                      }
                    >
                      {materialNeedStatusLabel(normalizedStatus, language)}
                    </button>
                    {normalizedStatus === "available" && (
                      <button
                        type="button"
                        className="materials-complete-btn"
                        disabled={isUpdating}
                        onClick={() => void updateMaterialNeedState(entry.id, "completed")}
                      >
                        {language === "de" ? "Erledigt" : "Complete"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {materialNeedRows.length === 0 && (
              <li className="muted">
                {language === "de" ? "Kein offener Materialbedarf gefunden." : "No open material needs found."}
              </li>
            )}
          </ul>
        </div>

        <div className="materials-panel materials-catalog-panel">
          <h4>{language === "de" ? "Materialkatalog" : "Material catalog"}</h4>
          <div className="materials-catalog-controls">
            <div className="materials-catalog-search-field">
              <b>{language === "de" ? "Projekt suchen" : "Search project"}</b>
              <input
                className="materials-catalog-search-input"
                value={materialCatalogProjectSearch}
                onFocus={(event) => {
                  const input = event.currentTarget;
                  setMaterialCatalogProjectSearchFocused(true);
                  window.requestAnimationFrame(() => {
                    input.select();
                  });
                }}
                onBlur={() => {
                  setMaterialCatalogProjectSearchFocused(false);
                  setMaterialCatalogProjectSearch(selectedMaterialCatalogProjectLabel);
                }}
                onChange={(event) => setMaterialCatalogProjectSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  const first = materialCatalogProjectSuggestions[0];
                  if (first) selectMaterialCatalogProject(first);
                }}
              />
              {materialCatalogProjectSearchFocused && materialCatalogProjectSuggestions.length > 0 && (
                <div className="assignee-suggestions">
                  {materialCatalogProjectSuggestions.map((project) => (
                    <button
                      key={`material-catalog-project-suggestion-${project.id}`}
                      type="button"
                      className="assignee-suggestion-btn"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => selectMaterialCatalogProject(project)}
                    >
                      {projectSearchLabel(project)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <label className="materials-catalog-search-field">
              <b>{language === "de" ? "Material suchen" : "Search material"}</b>
              <input
                className="materials-catalog-search-input"
                value={materialCatalogQuery}
                onChange={(event) => setMaterialCatalogQuery(event.target.value)}
                placeholder={
                  language === "de" ? "Artikelnummer oder Bezeichnung" : "Article number or item name"
                }
              />
            </label>
          </div>
          {materialCatalogState && materialCatalogState.duplicates_skipped > 0 && (
            <p className="muted materials-import-note">
              {language === "de"
                ? `${materialCatalogState.duplicates_skipped} Duplikate wurden beim Import übersprungen.`
                : `${materialCatalogState.duplicates_skipped} duplicates were skipped during import.`}
            </p>
          )}
          {materialCatalogState && (
            <div className="materials-image-sync-box">
              {materialCatalogState.image_lookup_enabled === false ? (
                <small className="muted">
                  {language === "de"
                    ? "Bildabgleich ist in den API-Einstellungen deaktiviert."
                    : "Image sync is disabled in API settings."}
                </small>
              ) : (
                <>
                  <small>
                    {language === "de"
                      ? `Bildabgleich: ${imageWithImage}/${imageTotal} (${imageProgress}%)`
                      : `Image sync: ${imageWithImage}/${imageTotal} (${imageProgress}%)`}
                  </small>
                  <small className="muted">
                    {language === "de"
                      ? `Offen: ${imagePending} | Ohne Treffer: ${imageNotFound} | 2. Durchlauf: ${imageWaitingFallback} | Wartezeit: ${imageWaitingRetry}`
                      : `Pending: ${imagePending} | Not found: ${imageNotFound} | Waiting fallback: ${imageWaitingFallback} | Waiting retry: ${imageWaitingRetry}`}
                  </small>
                  <small className="muted">
                    {imageLookupPhase
                      ? `${
                          language === "de" ? "Phase" : "Phase"
                        }: ${
                          imageLookupPhase === "unielektro_first_pass"
                            ? language === "de"
                              ? "1. Durchlauf (EAN auf unielektro.de)"
                              : "Pass 1 (EAN on unielektro.de)"
                            : language === "de"
                              ? "2. Durchlauf (Hersteller/Open EAN)"
                              : "Pass 2 (manufacturer/open EAN)"
                        } | `
                      : ""}
                    {language === "de"
                      ? `Letzter Durchlauf: ${imageLastProcessed} Einträge`
                      : `Last run: ${imageLastProcessed} items`}
                    {materialCatalogState.image_last_checked_at
                      ? ` | ${
                          language === "de" ? "Letzte Prüfung" : "Last check"
                        }: ${formatServerDateTime(materialCatalogState.image_last_checked_at, language)}`
                      : ""}
                  </small>
                </>
              )}
            </div>
          )}
          {materialCatalogLoading && <p className="muted">{language === "de" ? "Lädt..." : "Loading..."}</p>}
          <ul className="materials-list materials-catalog-list">
            {!materialCatalogLoading &&
              materialCatalogRows.map((catalogItem) => {
                const isAdding = Boolean(materialCatalogAdding[catalogItem.id]);
                const catalogMeta = [
                  catalogItem.article_no
                    ? `${language === "de" ? "Art.-Nr." : "Article"}: ${catalogItem.article_no}`
                    : "",
                  catalogItem.unit ? `${language === "de" ? "Einheit" : "Unit"}: ${catalogItem.unit}` : "",
                  catalogItem.manufacturer
                    ? `${language === "de" ? "Hersteller" : "Manufacturer"}: ${catalogItem.manufacturer}`
                    : "",
                  catalogItem.ean ? `EAN: ${catalogItem.ean}` : "",
                  catalogItem.price_text ? `${language === "de" ? "Preis" : "Price"}: ${catalogItem.price_text}` : "",
                ]
                  .filter((entry) => entry)
                  .join(" | ");
                return (
                  <li key={`catalog-item-${catalogItem.id}`} className="materials-item">
                    {catalogItem.image_url ? (
                      <div className="materials-item-image-wrap">
                        <img
                          src={catalogItem.image_url}
                          alt={catalogItem.item_name}
                          className="materials-item-image"
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      </div>
                    ) : (
                      <div className="materials-item-image-wrap materials-item-image-empty" aria-hidden />
                    )}
                    <div className="materials-item-main">
                      <b>{catalogItem.item_name}</b>
                      {catalogMeta && <small>{catalogMeta}</small>}
                    </div>
                    <div className="materials-item-actions">
                      <button
                        type="button"
                        className="materials-add-btn"
                        disabled={isAdding || !materialCatalogProjectId}
                        onClick={() => void addCatalogMaterialNeed(catalogItem)}
                      >
                        {language === "de" ? "Hinzufügen" : "Add"}
                      </button>
                    </div>
                  </li>
                );
              })}
            {!materialCatalogLoading && materialCatalogRows.length === 0 && (
              <li className="muted">
                {language === "de"
                  ? "Keine Katalogeinträge gefunden. Prüfe den Ordner Datanorm_Neuanlage."
                  : "No catalog entries found. Check the Datanorm_Neuanlage folder."}
              </li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
