import { useMemo } from "react";
import { useAppContext } from "../context/AppContext";
import { formatProjectTitleParts, statusLabel } from "../utils/projects";
import { CriticalDot } from "../components/project/CriticalDot";

function statusBadgeClass(status: string): string {
  const normalized = status.toLowerCase().trim();
  if (normalized === "active") return "projects-all-status-pill projects-all-status-pill--active";
  if (normalized === "planning") return "projects-all-status-pill projects-all-status-pill--planning";
  if (normalized === "on_hold" || normalized === "hold")
    return "projects-all-status-pill projects-all-status-pill--hold";
  if (normalized === "completed" || normalized === "done")
    return "projects-all-status-pill projects-all-status-pill--completed";
  if (normalized === "archived")
    return "projects-all-status-pill projects-all-status-pill--archived";
  return "projects-all-status-pill projects-all-status-pill--default";
}

function relativeTimeLabel(
  timestampSeconds: number,
  nowMs: number,
  language: "de" | "en",
): string {
  if (!timestampSeconds || timestampSeconds <= 0) return "—";
  const diffMs = nowMs - timestampSeconds * 1000;
  const seconds = Math.max(Math.round(diffMs / 1000), 0);
  const minutes = Math.round(seconds / 60);
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);
  const months = Math.round(days / 30);
  const years = Math.round(days / 365);

  const de = language === "de";
  if (seconds < 60) return de ? "gerade eben" : "just now";
  if (minutes < 60) return de ? `vor ${minutes} Min.` : `${minutes} min ago`;
  if (hours < 24) return de ? `vor ${hours} Std.` : `${hours} hours ago`;
  if (days === 1) return de ? "gestern" : "Yesterday";
  if (days < 30) return de ? `vor ${days} Tagen` : `${days} days ago`;
  if (months === 1) return de ? "vor 1 Monat" : "1 month ago";
  if (months < 12) return de ? `vor ${months} Monaten` : `${months} months ago`;
  if (years === 1) return de ? "vor 1 Jahr" : "1 year ago";
  return de ? `vor ${years} Jahren` : `${years} years ago`;
}

export function ProjectsAllPage() {
  const {
    mainView,
    language,
    now,
    filteredProjectsAll,
    projectsAllSearch,
    setProjectsAllSearch,
    projectsAllStateFilter,
    setProjectsAllStateFilter,
    projectsAllEditedFilter,
    setProjectsAllEditedFilter,
    overviewStatusOptions,
    canCreateProject,
    openCreateProjectModal,
    setActiveProjectId,
    setProjectTab,
    setProjectBackView,
    setMainView,
    projects,
  } = useAppContext();

  // O(1) lookup from overview row → full Project so we can surface the critical flag.
  const projectsById = useMemo(() => {
    const map = new Map<number, (typeof projects)[number]>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  if (mainView !== "projects_all") return null;

  const de = language === "de";
  const projectCount = filteredProjectsAll.length;
  const nowMs = now.getTime();

  return (
    <section className="projects-all">
      <div className="projects-all-card">
        <header className="projects-all-head">
          <h2 className="projects-all-title">{de ? "Alle Projekte" : "All Projects"}</h2>
          <span className="projects-all-count">
            {projectCount} {de ? "Projekte" : projectCount === 1 ? "project" : "projects"}
          </span>
        </header>

        <div className="projects-all-filters">
          <label className="projects-all-filter-field projects-all-filter-field--search">
            <span className="projects-all-filter-label">
              {de ? "Projektsuche" : "Project search"}
            </span>
            <div className="projects-all-search-wrap">
              <svg
                className="projects-all-search-icon"
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
                className="projects-all-search-input"
                value={projectsAllSearch}
                onChange={(event) => setProjectsAllSearch(event.target.value)}
                placeholder={
                  de
                    ? "Nummer, Kunde, Projektname oder Adresse"
                    : "Number, customer, project name, or address"
                }
              />
            </div>
          </label>
          <label className="projects-all-filter-field">
            <span className="projects-all-filter-label">{de ? "Status" : "State"}</span>
            <select
              className="projects-all-filter-select"
              value={projectsAllStateFilter}
              onChange={(event) => setProjectsAllStateFilter(event.target.value)}
            >
              <option value="all">{de ? "Alle Status" : "All states"}</option>
              {overviewStatusOptions.map((statusValue) => (
                <option key={statusValue} value={statusValue}>
                  {statusLabel(statusValue, language)}
                </option>
              ))}
            </select>
          </label>
          <label className="projects-all-filter-field">
            <span className="projects-all-filter-label">
              {de ? "Letzte Änderung" : "Last edited"}
            </span>
            <select
              className="projects-all-filter-select"
              value={projectsAllEditedFilter}
              onChange={(event) => setProjectsAllEditedFilter(event.target.value)}
            >
              <option value="all">{de ? "Alle" : "Any time"}</option>
              <option value="7d">{de ? "Letzte 7 Tage" : "Last 7 days"}</option>
              <option value="30d">{de ? "Letzte 30 Tage" : "Last 30 days"}</option>
              <option value="90d">{de ? "Letzte 90 Tage" : "Last 90 days"}</option>
              <option value="older">{de ? "Älter als 90 Tage" : "Older than 90 days"}</option>
              <option value="missing">{de ? "Ohne Datum" : "Without date"}</option>
            </select>
          </label>
          {canCreateProject && (
            <button
              type="button"
              className="projects-all-new-btn"
              onClick={openCreateProjectModal}
            >
              + {de ? "Neues Projekt" : "New project"}
            </button>
          )}
        </div>

        <ul className="projects-all-list">
          {filteredProjectsAll.length === 0 && (
            <li className="projects-all-empty muted">
              {de ? "Keine Projekte mit diesem Filter." : "No projects for this filter."}
            </li>
          )}
          {filteredProjectsAll.map((row) => {
            const projectId = Number(row.project_id);
            const projectLabel = formatProjectTitleParts(
              String(row.project_number ?? ""),
              String(row.customer_name ?? ""),
              String(row.project_name ?? ""),
              projectId,
            );
            const statusValue = String(row.status ?? "").trim();
            const lastEditedRel = relativeTimeLabel(
              Number(row.last_updated_timestamp ?? 0),
              nowMs,
              language,
            );
            const isCompleted =
              statusValue === "completed" ||
              statusValue === "done" ||
              statusValue === "archived";
            const openTasksLabel = `${row.open_tasks} ${
              de
                ? Number(row.open_tasks) === 1
                  ? "offene Aufgabe"
                  : "offene Aufgaben"
                : Number(row.open_tasks) === 1
                  ? "open task"
                  : "open tasks"
            }`;
            const sitesLabel = `${row.sites} ${
              de
                ? Number(row.sites) === 1
                  ? "Standort"
                  : "Standorte"
                : Number(row.sites) === 1
                  ? "site"
                  : "sites"
            }`;
            const lastStateText = String(row.last_state ?? "").trim();
            return (
              <li
                key={`projects-all-${row.project_id}`}
                className={`projects-all-row${isCompleted ? " projects-all-row--muted" : ""}`}
              >
                <button
                  type="button"
                  className="projects-all-row-btn"
                  onClick={() => {
                    if (!projectId) return;
                    setActiveProjectId(projectId);
                    setProjectTab("overview");
                    setProjectBackView("projects_all");
                    setMainView("project");
                  }}
                  aria-label={projectLabel.title}
                >
                  <div className="projects-all-row-id-col">
                    <span className="projects-all-row-number">
                      {row.project_number ?? `#${projectId}`}
                      {projectsById.get(projectId) && (
                        <CriticalDot project={projectsById.get(projectId)!} />
                      )}
                    </span>
                    <span className={statusBadgeClass(statusValue)}>
                      <span aria-hidden="true" className="projects-all-status-dot" />
                      {statusLabel(statusValue, language)}
                    </span>
                  </div>
                  <div className="projects-all-row-main">
                    <span className="projects-all-row-title">{projectLabel.title}</span>
                    <span className="projects-all-row-meta">
                      {[row.customer_name, openTasksLabel, sitesLabel, lastStateText && `${de ? "Stand" : "State"}: ${lastStateText}`]
                        .filter((value) => value && String(value).trim().length > 0)
                        .join(" · ")}
                    </span>
                  </div>
                  <div className="projects-all-row-edited">
                    <span className="projects-all-row-edited-label">
                      {de ? "ZULETZT GEÄNDERT" : "LAST EDITED"}
                    </span>
                    <span className="projects-all-row-edited-value">{lastEditedRel}</span>
                  </div>
                  <span aria-hidden="true" className="projects-all-row-arrow">
                    →
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
