import { useAppContext } from "../context/AppContext";
import { formatServerDateTime, parseServerDateTime } from "../utils/dates";
import { formatProjectTitleParts, statusLabel } from "../utils/projects";
import { SidebarNavIcon } from "../components/icons";
import { WorkHoursGauge } from "../components/gauges";

export function OverviewPage() {
  const {
    mainView,
    language,
    now,
    overviewActionCards,
    overviewActionCardWidth,
    gaugeNetHours,
    requiredDailyHours,
    timeCurrent,
    recentConstructionReports,
    recentAssignedProjects,
    filteredDetailedOverview,
    overviewStatusOptions,
    overviewStatusFilter,
    setOverviewStatusFilter,
    recentReportProjectTitleParts,
    projectTitleParts,
    filePreviewUrl,
    openProjectById,
    setActiveProjectId,
    setProjectTab,
    setProjectBackView,
    setMainView,
    setOverviewShortcutBackVisible,
    setConstructionBackView,
    clockIn,
    clockOut,
  } = useAppContext();

  if (mainView !== "overview") return null;

  return (
    <section className="overview-layout">
      <div className="overview-shortcuts">
        {overviewActionCards.map((action) => (
          <button
            key={action.view}
            type="button"
            className="overview-shortcut-card"
            style={{ width: overviewActionCardWidth }}
            onClick={() => {
              setProjectBackView(null);
              setOverviewShortcutBackVisible(true);
              setConstructionBackView(null);
              setMainView(action.view as any);
            }}
          >
            <SidebarNavIcon view={action.view as any} />
            <span>{action.label}</span>
          </button>
        ))}
      </div>

      <div className="overview-main-grid">
        <div className="overview-primary-column">
          <div className="card overview-card overview-status-card">
            <h3>{language === "de" ? "Mein aktueller Status" : "My current status"}</h3>
            <small className="muted">
              {language === "de" ? "Aktuelle Uhrzeit" : "Current time"}:{" "}
              <b>{now.toLocaleTimeString(language === "de" ? "de-DE" : "en-US")}</b>
            </small>
            <WorkHoursGauge
              language={language}
              netHours={gaugeNetHours}
              requiredHours={requiredDailyHours}
              compact
            />
            {timeCurrent?.clock_entry_id ? (
              <div className="overview-status-shift-row">
                <button className="overview-shift-action-btn" onClick={clockOut}>
                  {language === "de" ? "Ausstempeln" : "Clock out"}
                </button>
                <small className="muted overview-status-shift-info">
                  {language === "de" ? "Schicht seit" : "Shift since"}:{" "}
                  {parseServerDateTime(timeCurrent.clock_in || "")?.toLocaleTimeString(language === "de" ? "de-DE" : "en-US") || "-"}
                </small>
              </div>
            ) : (
              <div className="overview-status-shift-row">
                <button className="overview-shift-action-btn" onClick={clockIn}>
                  {language === "de" ? "Einstempeln" : "Clock in"}
                </button>
                <small className="muted overview-status-shift-info">
                  {language === "de" ? "Keine offene Schicht." : "No open shift."}
                </small>
              </div>
            )}
          </div>

          <div className="card overview-card overview-recent-reports-card">
            <h3>{language === "de" ? "Neueste Baustellenberichte" : "Latest construction reports"}</h3>
            <ul className="overview-list">
              {recentConstructionReports.map((report) => {
                const reportProjectLabel = recentReportProjectTitleParts(report);
                return (
                  <li key={`recent-report-${report.id}`} className="task-list-item">
                    <div className="task-list-main">
                      <b>
                        {(language === "de" ? "Bericht" : "Report")}{" "}
                        {report.report_number != null ? `#${report.report_number}` : `#${report.id}`}
                      </b>
                      <small>
                        {language === "de" ? "Projekt" : "Project"}: {reportProjectLabel.title}
                      </small>
                      {reportProjectLabel.subtitle && <small className="project-name-subtle">{reportProjectLabel.subtitle}</small>}
                      <small>
                        {language === "de" ? "Erstellt" : "Created"}: {formatServerDateTime(report.created_at, language)}
                      </small>
                    </div>
                    <div className="row wrap task-actions">
                      {report.attachment_id ? (
                        <a href={filePreviewUrl(report.attachment_id)} target="_blank" rel="noreferrer">
                          {language === "de" ? "Öffnen" : "Open"}
                        </a>
                      ) : (
                        <small className="muted">
                          {language === "de" ? "Wird verarbeitet" : "Processing"}
                        </small>
                      )}
                      {report.project_id ? (
                        <button type="button" onClick={() => openProjectById(report.project_id!, null)}>
                          {language === "de" ? "Projekt" : "Project"}
                        </button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
              {recentConstructionReports.length === 0 && (
                <li className="muted">
                  {language === "de" ? "Keine Berichte vorhanden." : "No reports found."}
                </li>
              )}
            </ul>
          </div>
        </div>

        <div className="card overview-card">
          <h3>{language === "de" ? "Meine Projekte" : "My projects"}</h3>
          <ul className="overview-list">
            {recentAssignedProjects.map((project) => {
              const projectLabel = projectTitleParts(project);
              return (
                <li key={project.id}>
                  <button
                    className="linklike overview-list-item"
                    onClick={() => {
                      setActiveProjectId(project.id);
                      setProjectTab("overview");
                      setProjectBackView(null);
                      setMainView("project");
                    }}
                  >
                    <b>{projectLabel.title}</b>
                    {projectLabel.subtitle && <small className="project-name-subtle">{projectLabel.subtitle}</small>}
                  </button>
                </li>
              );
            })}
            {recentAssignedProjects.length === 0 && (
              <li className="muted">
                {language === "de" ? "Keine zugewiesenen Projekte." : "No assigned projects."}
              </li>
            )}
          </ul>
        </div>

        <div className="card overview-card">
          <div className="overview-filter-row">
            <div className="overview-filter-title-row">
              <h3>{language === "de" ? "Projektübersicht" : "Projects overview"}</h3>
              <button
                type="button"
                className="icon-btn overview-open-full-btn"
                onClick={() => {
                  setProjectBackView(null);
                  setMainView("projects_all");
                }}
                aria-label={language === "de" ? "Alle Projekte öffnen" : "Open all projects"}
                title={language === "de" ? "Alle Projekte öffnen" : "Open all projects"}
              >
                <span aria-hidden>≡</span>
                <span>{language === "de" ? "Liste" : "List"}</span>
              </button>
            </div>
            <div className="overview-state-filter">
              <span>{language === "de" ? "Status" : "State"}</span>
              <select
                aria-label={language === "de" ? "Status auswählen" : "Select state"}
                value={overviewStatusFilter}
                onChange={(event) => setOverviewStatusFilter(event.target.value)}
              >
                <option value="all">{language === "de" ? "Alle Status" : "All states"}</option>
                {overviewStatusOptions.map((statusValue) => (
                  <option key={statusValue} value={statusValue}>
                    {statusLabel(statusValue, language)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <ul className="overview-list">
            {filteredDetailedOverview.map((row) => {
              const projectId = Number(row.project_id);
              const projectNumber = row.project_number ?? row.project_id;
              const projectLabel = formatProjectTitleParts(
                String(projectNumber),
                String(row.customer_name ?? ""),
                String(row.project_name ?? ""),
                projectId,
              );
              return (
                <li key={row.project_id}>
                  <button
                    className="linklike overview-list-item"
                    onClick={() => {
                      if (!projectId) return;
                      setActiveProjectId(projectId);
                      setProjectTab("overview");
                      setProjectBackView(null);
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
                  </button>
                </li>
              );
            })}
            {filteredDetailedOverview.length === 0 && (
              <li className="muted">
                {language === "de" ? "Keine Projekte in diesem Status." : "No projects in this state."}
              </li>
            )}
          </ul>
        </div>

      </div>
    </section>
  );
}
