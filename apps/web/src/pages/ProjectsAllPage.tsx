import { useAppContext } from "../context/AppContext";
import { formatServerDateTime } from "../utils/dates";
import { formatProjectTitleParts, statusLabel } from "../utils/projects";

export function ProjectsAllPage() {
  const {
    mainView,
    language,
    filteredProjectsAll,
    projectsAllSearch,
    setProjectsAllSearch,
    projectsAllStateFilter,
    setProjectsAllStateFilter,
    projectsAllEditedFilter,
    setProjectsAllEditedFilter,
    overviewStatusOptions,
    setActiveProjectId,
    setProjectTab,
    setProjectBackView,
    setMainView,
  } = useAppContext();

  if (mainView !== "projects_all") return null;

  return (
    <section className="card projects-all-card">
      <div className="projects-all-head">
        <button
          type="button"
          onClick={() => {
            setProjectBackView(null);
            setMainView("overview");
          }}
        >
          {language === "de" ? "Zur Übersicht" : "Back to overview"}
        </button>
      </div>
      <div className="projects-all-filters">
        <label className="projects-all-search">
          {language === "de" ? "Projektsuche" : "Project search"}
          <input
            value={projectsAllSearch}
            onChange={(event) => setProjectsAllSearch(event.target.value)}
            placeholder={language === "de" ? "Nummer, Kunde oder Projektname" : "Number, customer, or project name"}
          />
        </label>
        <label>
          {language === "de" ? "Status" : "State"}
          <select
            value={projectsAllStateFilter}
            onChange={(event) => setProjectsAllStateFilter(event.target.value)}
          >
            <option value="all">{language === "de" ? "Alle Status" : "All states"}</option>
            {overviewStatusOptions.map((statusValue) => (
              <option key={statusValue} value={statusValue}>
                {statusLabel(statusValue, language)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {language === "de" ? "Letzte Änderung" : "Last edited"}
          <select
            value={projectsAllEditedFilter}
            onChange={(event) => setProjectsAllEditedFilter(event.target.value)}
          >
            <option value="all">{language === "de" ? "Alle" : "Any time"}</option>
            <option value="7d">{language === "de" ? "Letzte 7 Tage" : "Last 7 days"}</option>
            <option value="30d">{language === "de" ? "Letzte 30 Tage" : "Last 30 days"}</option>
            <option value="90d">{language === "de" ? "Letzte 90 Tage" : "Last 90 days"}</option>
            <option value="older">{language === "de" ? "Älter als 90 Tage" : "Older than 90 days"}</option>
            <option value="missing">{language === "de" ? "Ohne Datum" : "Without date"}</option>
          </select>
        </label>
      </div>

      <ul className="overview-list projects-all-list">
        {filteredProjectsAll.map((row) => {
          const projectId = Number(row.project_id);
          const projectLabel = formatProjectTitleParts(
            String(row.project_number ?? ""),
            String(row.customer_name ?? ""),
            String(row.project_name ?? ""),
            projectId,
          );
          const lastEditedLabel =
            row.last_updated_at && Number(row.last_updated_timestamp) > 0
              ? formatServerDateTime(row.last_updated_at, language)
              : "-";
          return (
            <li key={`all-project-${row.project_id}`}>
              <button
                className="linklike overview-list-item"
                onClick={() => {
                  if (!projectId) return;
                  setActiveProjectId(projectId);
                  setProjectTab("overview");
                  setProjectBackView("projects_all");
                  setMainView("project");
                }}
              >
                <b>{projectLabel.title}</b>
                {projectLabel.subtitle && <small className="project-name-subtle">{projectLabel.subtitle}</small>}
                <small>
                  {language === "de" ? "Offene Aufgaben" : "Open tasks"}: {row.open_tasks} |{" "}
                  {language === "de" ? "Standorte" : "Sites"}: {row.sites} |{" "}
                  {statusLabel(String(row.status ?? ""), language)}
                </small>
                <small>
                  {language === "de" ? "Letzter Stand" : "Last state"}: {row.last_state} |{" "}
                  {language === "de" ? "Letzte Änderung" : "Last edited"}: {lastEditedLabel}
                </small>
              </button>
            </li>
          );
        })}
        {filteredProjectsAll.length === 0 && (
          <li className="muted">
            {language === "de" ? "Keine Projekte mit diesem Filter." : "No projects for this filter."}
          </li>
        )}
      </ul>
    </section>
  );
}
