import { useState } from "react";
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

  // Per-item quantity inputs keyed by catalog item ID
  const [itemQuantities, setItemQuantities] = useState<Record<number, string>>({});

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

  const projectSelected = Boolean(materialCatalogProjectId);

  function setItemQty(itemId: number, value: string) {
    setItemQuantities((prev) => ({ ...prev, [itemId]: value }));
  }

  async function handleAddItem(catalogItem: { id: number; item_name: string; [k: string]: unknown }) {
    const qty = itemQuantities[catalogItem.id] ?? "";
    await addCatalogMaterialNeed(catalogItem as Parameters<typeof addCatalogMaterialNeed>[0], qty || undefined);
    // Clear the quantity field after successful add
    setItemQuantities((prev) => {
      const next = { ...prev };
      delete next[catalogItem.id];
      return next;
    });
  }

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
        {/* ── Left: needs list ──────────────────────────────────────── */}
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

        {/* ── Right: catalog / shopping panel ─────────────────────── */}
        <div className="materials-panel materials-catalog-panel">
          <h4>{language === "de" ? "Materialkatalog" : "Material catalog"}</h4>

          {/* Step 1 — choose project */}
          <div className="materials-shop-step">
            <span className="materials-shop-step-badge">1</span>
            <div className="materials-catalog-search-field" style={{ flex: 1 }}>
              <b>{language === "de" ? "Projekt wählen" : "Choose project"}</b>
              <input
                className={`materials-catalog-search-input${projectSelected ? " materials-step-done" : ""}`}
                value={materialCatalogProjectSearch}
                placeholder={language === "de" ? "Projektname oder Nummer…" : "Project name or number…"}
                onFocus={(event) => {
                  const input = event.currentTarget;
                  setMaterialCatalogProjectSearchFocused(true);
                  window.requestAnimationFrame(() => { input.select(); });
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
                      onMouseDown={(event) => { event.preventDefault(); }}
                      onClick={() => selectMaterialCatalogProject(project)}
                    >
                      {projectSearchLabel(project)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {projectSelected && (
              <span className="materials-shop-step-check" aria-hidden>✓</span>
            )}
          </div>

          {/* Step 2 — search items */}
          <div className="materials-shop-step">
            <span className={`materials-shop-step-badge${projectSelected ? "" : " materials-shop-step-badge--dim"}`}>2</span>
            <label className="materials-catalog-search-field" style={{ flex: 1 }}>
              <b>{language === "de" ? "Material suchen" : "Search items"}</b>
              <input
                className="materials-catalog-search-input"
                value={materialCatalogQuery}
                onChange={(event) => setMaterialCatalogQuery(event.target.value)}
                placeholder={language === "de" ? "Name, Artikel-Nr., Hersteller…" : "Name, article no., manufacturer…"}
                disabled={!projectSelected}
              />
            </label>
          </div>

          {/* Image sync status */}
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
                      ? `Phase: ${imageLookupPhase === "unielektro_first_pass"
                          ? language === "de" ? "1. Durchlauf" : "Pass 1"
                          : language === "de" ? "2. Durchlauf" : "Pass 2"
                        } | `
                      : ""}
                    {language === "de"
                      ? `Letzter Durchlauf: ${imageLastProcessed} Einträge`
                      : `Last run: ${imageLastProcessed} items`}
                    {materialCatalogState.image_last_checked_at
                      ? ` | ${language === "de" ? "Letzte Prüfung" : "Last check"}: ${formatServerDateTime(materialCatalogState.image_last_checked_at, language)}`
                      : ""}
                  </small>
                </>
              )}
            </div>
          )}

          {materialCatalogState && materialCatalogState.duplicates_skipped > 0 && (
            <p className="muted materials-import-note">
              {language === "de"
                ? `${materialCatalogState.duplicates_skipped} Duplikate wurden beim Import übersprungen.`
                : `${materialCatalogState.duplicates_skipped} duplicates were skipped during import.`}
            </p>
          )}

          {materialCatalogLoading && <p className="muted">{language === "de" ? "Lädt..." : "Loading..."}</p>}

          {/* Step 3 — pick items with quantities */}
          {!materialCatalogLoading && materialCatalogRows.length > 0 && (
            <p className="materials-shop-hint muted">
              {language === "de"
                ? "Menge eingeben und hinzufügen:"
                : "Enter quantity and add to project:"}
            </p>
          )}
          <ul className="materials-list materials-catalog-list">
            {!materialCatalogLoading &&
              materialCatalogRows.map((catalogItem) => {
                const isAdding = Boolean(materialCatalogAdding[catalogItem.id]);
                const qty = itemQuantities[catalogItem.id] ?? "";
                const catalogMeta = [
                  catalogItem.article_no
                    ? `${language === "de" ? "Art.-Nr." : "Art."}: ${catalogItem.article_no}`
                    : "",
                  catalogItem.unit ? `${language === "de" ? "Einheit" : "Unit"}: ${catalogItem.unit}` : "",
                  catalogItem.manufacturer ? catalogItem.manufacturer : "",
                  catalogItem.price_text
                    ? `${language === "de" ? "Preis" : "Price"}: ${catalogItem.price_text}`
                    : "",
                ]
                  .filter((entry) => entry)
                  .join(" · ");
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
                    <div className="materials-item-actions materials-cart-actions">
                      <input
                        type="text"
                        className="materials-qty-input"
                        value={qty}
                        onChange={(event) => setItemQty(catalogItem.id, event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            if (!isAdding && projectSelected) {
                              void handleAddItem(catalogItem);
                            }
                          }
                        }}
                        placeholder={language === "de" ? "Menge" : "Qty"}
                        aria-label={language === "de" ? "Menge" : "Quantity"}
                        disabled={isAdding || !projectSelected}
                      />
                      <button
                        type="button"
                        className="materials-add-btn"
                        disabled={isAdding || !projectSelected}
                        onClick={() => void handleAddItem(catalogItem)}
                        title={
                          !projectSelected
                            ? language === "de"
                              ? "Zuerst ein Projekt auswählen"
                              : "Select a project first"
                            : undefined
                        }
                      >
                        {isAdding
                          ? language === "de" ? "…" : "…"
                          : language === "de" ? "Hinzufügen" : "Add"}
                      </button>
                    </div>
                  </li>
                );
              })}
            {!materialCatalogLoading && materialCatalogRows.length === 0 && projectSelected && materialCatalogQuery && (
              <li className="muted">
                {language === "de"
                  ? `Keine Einträge für "${materialCatalogQuery}" gefunden.`
                  : `No items found for "${materialCatalogQuery}".`}
              </li>
            )}
            {!materialCatalogLoading && materialCatalogRows.length === 0 && !projectSelected && (
              <li className="muted">
                {language === "de"
                  ? "Wähle zuerst ein Projekt, dann suche nach Materialien."
                  : "Select a project first, then search for materials."}
              </li>
            )}
            {!materialCatalogLoading && materialCatalogRows.length === 0 && projectSelected && !materialCatalogQuery && (
              <li className="muted">
                {language === "de"
                  ? "Gib einen Suchbegriff ein um Materialien zu finden."
                  : "Enter a search term to find materials."}
              </li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
