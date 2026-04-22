import { useMemo, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { formatDayLabel } from "../../utils/dates";
import {
  normalizeMaterialNeedStatus,
  materialNeedStatusLabel,
  materialNeedStatusClass,
  nextMaterialNeedStatus,
} from "../../utils/materials";
import { formatProjectTitleParts } from "../../utils/projects";
import type { ProjectMaterialNeed } from "../../types";

/**
 * WerkstattBedarfePage — the "Projekt-Bedarfe" panel. Relocated from the
 * legacy MaterialsPage: rows grouped by project, collapsible headers, inline
 * status pills. Same data source (`materialNeedRows`) and same AppContext
 * mutators — no new BE surface, just a new home under Werkstatt.
 *
 * Sort order inherits the legacy behaviour: by project number ascending
 * (numeric-aware localeCompare).
 */
export function WerkstattBedarfePage() {
  const {
    mainView,
    language,
    werkstattTab,
    materialNeedRows,
    materialNeedUpdating,
    projectsById,
    setActiveProjectId,
    setProjectTab,
    setProjectBackView,
    setMainView,
    loadMaterialNeeds,
    updateMaterialNeedState,
    updateMaterialNeedNote,
  } = useAppContext();

  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const [pendingNotes, setPendingNotes] = useState<Record<number, string>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<number>>(new Set());

  const needGroups = useMemo(() => {
    const map = new Map<
      number,
      {
        projectId: number;
        projectNumber: string;
        projectTitle: string;
        projectSubtitle: string | null;
        items: ProjectMaterialNeed[];
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
      const bucket = map.get(entry.project_id);
      if (bucket) bucket.items = [...bucket.items, entry];
    }
    return Array.from(map.values()).sort((a, b) =>
      a.projectNumber.localeCompare(b.projectNumber, undefined, { numeric: true }),
    );
  }, [materialNeedRows]);

  function toggleGroup(projectId: number) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
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

  if (mainView !== "werkstatt" || werkstattTab !== "bedarfe") return null;

  const de = language === "de";

  return (
    <section className="werkstatt-tab-page">
      <header className="werkstatt-sub-head">
        <div className="werkstatt-sub-head-text">
          <span className="werkstatt-sub-breadcrumb">
            {de ? "WERKSTATT › PROJEKT-BEDARFE" : "WORKSHOP › PROJECT NEEDS"}
          </span>
          <h1 className="werkstatt-sub-title">
            {de ? "Materialbedarf" : "Material needs"}
          </h1>
          <p className="werkstatt-sub-subtitle">
            {de
              ? "Offener Bedarf aus den Projekten — nach Projekt gruppiert."
              : "Open material needs from projects — grouped by project."}
          </p>
        </div>
        <div className="werkstatt-sub-actions">
          <button
            type="button"
            className="werkstatt-action-btn"
            onClick={() => void loadMaterialNeeds()}
          >
            {de ? "Aktualisieren" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="werkstatt-card materials-page-needs">
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
    </section>
  );
}
