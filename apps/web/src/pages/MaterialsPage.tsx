import { useMemo, useState } from "react";
import { useAppContext } from "../context/AppContext";
import { formatDayLabel } from "../utils/dates";
import {
  normalizeMaterialNeedStatus,
  materialNeedStatusLabel,
  materialNeedStatusClass,
  nextMaterialNeedStatus,
} from "../utils/materials";
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
    updateMaterialNeedNote,
    selectMaterialCatalogProject,
    addCatalogMaterialNeed,
  } = useAppContext();

  // Per-item quantity inputs keyed by catalog item ID
  const [itemQuantities, setItemQuantities] = useState<Record<number, string>>({});
  // Note editing state
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [pendingNotes, setPendingNotes] = useState<Record<number, string>>({});
  // Set of project IDs whose group is collapsed
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());

  // Group material needs by project, preserving insertion order (sorted by project number)
  const needGroups = useMemo(() => {
    const map = new Map<
      number,
      {
        projectId: number;
        projectNumber: string;
        projectTitle: string;
        projectSubtitle: string | null;
        items: typeof materialNeedRows;
      }
    >();
    for (const entry of materialNeedRows) {
      if (!map.has(entry.project_id)) {
        const parts = formatProjectTitleParts(
          entry.project_number,
          entry.customer_name ?? null,
          entry.project_name,
          entry.project_id,
        );
        map.set(entry.project_id, {
          projectId: entry.project_id,
          projectNumber: entry.project_number,
          projectTitle: parts.title,
          projectSubtitle: parts.subtitle ?? null,
          items: [],
        });
      }
      map.get(entry.project_id)!.items.push(entry);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.projectNumber.localeCompare(b.projectNumber, undefined, { numeric: true }),
    );
  }, [materialNeedRows]);

  function toggleGroup(projectId: number) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  if (mainView !== "materials") return null;

  const de = language === "de";
  const projectSelected = Boolean(materialCatalogProjectId);

  function setItemQty(itemId: number, value: string) {
    setItemQuantities((prev) => ({ ...prev, [itemId]: value }));
  }

  function startEditNote(itemId: number, currentNote: string | null | undefined) {
    setEditingNoteId(itemId);
    setPendingNotes((prev) => ({ ...prev, [itemId]: currentNote ?? "" }));
  }

  function cancelEditNote(itemId: number) {
    setEditingNoteId(null);
    setPendingNotes((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  async function commitNote(itemId: number) {
    const note = pendingNotes[itemId] ?? "";
    setEditingNoteId(null);
    await updateMaterialNeedNote(itemId, note);
    setPendingNotes((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  async function handleAddItem(catalogItem: {
    id: number;
    item_name: string;
    [k: string]: unknown;
  }) {
    const qty = itemQuantities[catalogItem.id] ?? "";
    await addCatalogMaterialNeed(
      catalogItem as Parameters<typeof addCatalogMaterialNeed>[0],
      qty || undefined,
    );
    setItemQuantities((prev) => {
      const next = { ...prev };
      delete next[catalogItem.id];
      return next;
    });
  }

  return (
    <section className="materials-page">
      {/* ── Left: Material Needs card ────────────────────────────── */}
      <div className="materials-page-card materials-page-needs">
        <header className="materials-page-head">
          <h2 className="materials-page-title">
            {de ? "Materialbedarf" : "Material Needs"}
          </h2>
          <button
            type="button"
            className="materials-page-refresh-btn"
            onClick={() => {
              void loadMaterialNeeds();
              void loadMaterialCatalog(materialCatalogQuery);
            }}
          >
            {de ? "Aktualisieren" : "Refresh"}
          </button>
        </header>

        <div className="materials-page-needs-list">
          {needGroups.length === 0 && (
            <div className="materials-page-empty muted">
              {de
                ? "Kein offener Materialbedarf gefunden."
                : "No open material needs found."}
            </div>
          )}

          {needGroups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.projectId);
            const project = projectsById.get(group.projectId) ?? null;
            return (
              <div key={`group-${group.projectId}`} className="materials-page-group">
                <button
                  type="button"
                  className="materials-page-group-header"
                  onClick={() => toggleGroup(group.projectId)}
                  aria-expanded={!isCollapsed}
                >
                  <span className="materials-page-group-chevron" aria-hidden="true">
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <span
                    className="materials-page-group-title"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (!project) return;
                      setActiveProjectId(project.id);
                      setProjectTab("overview");
                      setProjectBackView(null);
                      setMainView("project");
                    }}
                  >
                    {group.projectNumber} · {group.projectTitle}
                  </span>
                  <span className="materials-page-group-count">
                    {group.items.length}{" "}
                    {de
                      ? group.items.length === 1
                        ? "Eintrag"
                        : "Einträge"
                      : group.items.length === 1
                        ? "item"
                        : "items"}
                  </span>
                </button>

                {!isCollapsed && (
                  <ul className="materials-page-items">
                    {group.items.map((entry) => {
                      const normalizedStatus = normalizeMaterialNeedStatus(entry.status);
                      const statusVariant = materialNeedStatusClass(normalizedStatus);
                      const isUpdating = Boolean(materialNeedUpdating[entry.id]);
                      const metaParts: string[] = [];
                      if (entry.quantity) {
                        metaParts.push(
                          `${de ? "Menge" : "Qty"}: ${entry.quantity}${entry.unit ? ` ${entry.unit}` : ""}`,
                        );
                      }
                      if (entry.report_date) {
                        metaParts.push(
                          `${de ? "Hinzugefügt" : "Added"}: ${formatDayLabel(entry.report_date, language)}`,
                        );
                      }
                      return (
                        <li key={`material-need-${entry.id}`} className="materials-page-item">
                          <div className="materials-page-item-main">
                            <span className="materials-page-item-title">{entry.item}</span>
                            {metaParts.length > 0 && (
                              <span className="materials-page-item-meta">
                                {metaParts.join(" · ")}
                                {entry.article_no ? ` · ${entry.article_no}` : ""}
                              </span>
                            )}
                            {editingNoteId === entry.id ? (
                              <input
                                type="text"
                                className="materials-page-note-input"
                                autoFocus
                                value={pendingNotes[entry.id] ?? ""}
                                placeholder={de ? "Notiz hinzufügen…" : "Add a note…"}
                                onChange={(event) =>
                                  setPendingNotes((prev) => ({
                                    ...prev,
                                    [entry.id]: event.target.value,
                                  }))
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") {
                                    event.preventDefault();
                                    void commitNote(entry.id);
                                  }
                                  if (event.key === "Escape") cancelEditNote(entry.id);
                                }}
                                onBlur={() => void commitNote(entry.id)}
                              />
                            ) : entry.notes ? (
                              <button
                                type="button"
                                className="materials-page-note"
                                onClick={() => startEditNote(entry.id, entry.notes)}
                                title={de ? "Notiz bearbeiten" : "Edit note"}
                              >
                                {entry.notes}
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="materials-page-note-add"
                                onClick={() => startEditNote(entry.id, null)}
                              >
                                {de ? "+ Notiz" : "+ Note"}
                              </button>
                            )}
                          </div>
                          <div className="materials-page-item-actions">
                            <button
                              type="button"
                              className={`materials-page-status-pill materials-page-status-pill--${statusVariant}`}
                              disabled={isUpdating}
                              onClick={() =>
                                void updateMaterialNeedState(
                                  entry.id,
                                  nextMaterialNeedStatus(normalizedStatus),
                                )
                              }
                              title={
                                de
                                  ? `Status wechseln zu: ${materialNeedStatusLabel(nextMaterialNeedStatus(normalizedStatus), language)}`
                                  : `Change status to: ${materialNeedStatusLabel(nextMaterialNeedStatus(normalizedStatus), language)}`
                              }
                            >
                              {materialNeedStatusLabel(normalizedStatus, language)}
                            </button>
                            {normalizedStatus === "available" && (
                              <button
                                type="button"
                                className="materials-page-complete-btn"
                                disabled={isUpdating}
                                onClick={() =>
                                  void updateMaterialNeedState(entry.id, "completed")
                                }
                              >
                                {de ? "Erledigt" : "Complete"}
                              </button>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Right: Material Catalog card ─────────────────────────── */}
      <div className="materials-page-card materials-page-catalog">
        <header className="materials-page-head">
          <h2 className="materials-page-title">
            {de ? "Materialkatalog" : "Material Catalog"}
          </h2>
        </header>

        {/* Search input with magnifying glass icon */}
        <div className="materials-page-search-wrap">
          <svg
            className="materials-page-search-icon"
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
            type="text"
            className="materials-page-search-input"
            value={materialCatalogQuery}
            onChange={(event) => setMaterialCatalogQuery(event.target.value)}
            placeholder={de ? "Katalog durchsuchen…" : "Search catalog…"}
            disabled={!projectSelected}
          />
        </div>

        {/* Project filter */}
        <div className="materials-page-project-filter-wrap">
          <svg
            className="materials-page-project-filter-icon"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3.5 7.5a1.8 1.8 0 0 1 1.8-1.8h3.9l1.8 2.1h7.7a1.8 1.8 0 0 1 1.8 1.8v8.6a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Z"
              stroke="#5C7895"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
          </svg>
          <input
            type="text"
            className="materials-page-project-filter-input"
            value={materialCatalogProjectSearch}
            placeholder={de ? "Nach Projekt filtern…" : "Filter by project…"}
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
          <span aria-hidden="true" className="materials-page-project-filter-chevron">
            ▾
          </span>
          {materialCatalogProjectSearchFocused &&
            materialCatalogProjectSuggestions.length > 0 && (
              <div className="materials-page-project-suggestions">
                {materialCatalogProjectSuggestions.map((project) => (
                  <button
                    key={`material-catalog-project-suggestion-${project.id}`}
                    type="button"
                    className="materials-page-project-suggestion"
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

        {/* Catalog list */}
        <ul className="materials-page-catalog-list">
          {materialCatalogLoading && (
            <li className="materials-page-empty muted">{de ? "Lädt…" : "Loading…"}</li>
          )}
          {!materialCatalogLoading &&
            materialCatalogRows.map((catalogItem) => {
              const isAdding = Boolean(materialCatalogAdding[catalogItem.id]);
              const qty = itemQuantities[catalogItem.id] ?? "";
              const metaPieces: string[] = [];
              if (catalogItem.article_no) {
                metaPieces.push(`${de ? "Art." : "Art."} ${catalogItem.article_no}`);
              }
              if (catalogItem.unit) {
                metaPieces.push(catalogItem.unit);
              }
              return (
                <li
                  key={`catalog-item-${catalogItem.id}`}
                  className="materials-page-catalog-item"
                >
                  <div className="materials-page-catalog-item-main">
                    <span className="materials-page-catalog-item-title">
                      {catalogItem.item_name}
                    </span>
                    {metaPieces.length > 0 && (
                      <span className="materials-page-catalog-item-meta">
                        {metaPieces.join(" · ")}
                      </span>
                    )}
                  </div>
                  <div className="materials-page-catalog-item-actions">
                    <input
                      type="text"
                      className="materials-page-qty-input"
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
                      placeholder={de ? "Menge" : "Qty"}
                      aria-label={de ? "Menge" : "Quantity"}
                      disabled={isAdding || !projectSelected}
                    />
                    <button
                      type="button"
                      className="materials-page-add-btn"
                      disabled={isAdding || !projectSelected}
                      onClick={() => void handleAddItem(catalogItem)}
                      title={
                        !projectSelected
                          ? de
                            ? "Zuerst ein Projekt auswählen"
                            : "Select a project first"
                          : undefined
                      }
                    >
                      {isAdding ? "…" : de ? "Hinzufügen" : "Add"}
                    </button>
                  </div>
                </li>
              );
            })}
          {!materialCatalogLoading &&
            materialCatalogRows.length === 0 &&
            projectSelected &&
            materialCatalogQuery && (
              <li className="materials-page-empty muted">
                {de
                  ? `Keine Einträge für "${materialCatalogQuery}" gefunden.`
                  : `No items found for "${materialCatalogQuery}".`}
              </li>
            )}
          {!materialCatalogLoading &&
            materialCatalogRows.length === 0 &&
            !projectSelected && (
              <li className="materials-page-empty muted">
                {de
                  ? "Wähle zuerst ein Projekt, dann suche nach Materialien."
                  : "Select a project first, then search for materials."}
              </li>
            )}
          {!materialCatalogLoading &&
            materialCatalogRows.length === 0 &&
            projectSelected &&
            !materialCatalogQuery && (
              <li className="materials-page-empty muted">
                {de
                  ? "Gib einen Suchbegriff ein um Materialien zu finden."
                  : "Enter a search term to find materials."}
              </li>
            )}
        </ul>

        {materialCatalogState && materialCatalogState.duplicates_skipped > 0 && (
          <small className="muted materials-page-import-note">
            {de
              ? `${materialCatalogState.duplicates_skipped} Duplikate wurden beim Import übersprungen.`
              : `${materialCatalogState.duplicates_skipped} duplicates were skipped during import.`}
          </small>
        )}
      </div>
    </section>
  );
}
