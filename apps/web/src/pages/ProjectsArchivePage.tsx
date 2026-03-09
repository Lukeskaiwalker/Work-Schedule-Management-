import { useAppContext } from "../context/AppContext";
import { formatServerDateTime } from "../utils/dates";

export function ProjectsArchivePage() {
  const {
    mainView,
    language,
    archivedProjects,
    projectTitleParts,
    highlightedArchivedProjectId,
    canCreateProject,
    unarchiveProject,
    deleteProjectById,
  } = useAppContext();

  if (mainView !== "projects_archive") return null;

  return (
    <section className="card">
      <h3>{language === "de" ? "Projektarchiv" : "Project archive"}</h3>
      <ul className="overview-list">
        {archivedProjects.map((project) => {
          const projectLabel = projectTitleParts(project);
          const lastEditedLabel = project.last_status_at
            ? formatServerDateTime(project.last_status_at, language)
            : "-";
          return (
            <li key={`archive-project-${project.id}`}>
              <div
                className={[
                  "overview-list-item",
                  "archive-list-item",
                  highlightedArchivedProjectId === project.id ? "archive-list-item-highlighted" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <b>{projectLabel.title}</b>
                {projectLabel.subtitle && <small className="project-name-subtle">{projectLabel.subtitle}</small>}
                <small>
                  {language === "de" ? "Letzter Stand" : "Last state"}: {project.last_state || "-"} |{" "}
                  {language === "de" ? "Letzte Änderung" : "Last edited"}: {lastEditedLabel}
                </small>
                <div className="row wrap task-actions task-actions-left">
                  {canCreateProject ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void unarchiveProject(project.id, project.last_updated_at ?? null)}
                      >
                        {language === "de" ? "Wiederherstellen" : "Unarchive"}
                      </button>
                      <button
                        type="button"
                        className="danger-btn"
                        onClick={() => void deleteProjectById(project.id)}
                      >
                        {language === "de" ? "Löschen" : "Delete"}
                      </button>
                    </>
                  ) : (
                    <small className="muted">
                      {language === "de"
                        ? "Keine Rechte zum Bearbeiten des Archivs."
                        : "No permission to modify archive entries."}
                    </small>
                  )}
                </div>
              </div>
            </li>
          );
        })}
        {archivedProjects.length === 0 && (
          <li className="muted">{language === "de" ? "Keine archivierten Projekte." : "No archived projects."}</li>
        )}
      </ul>
    </section>
  );
}
