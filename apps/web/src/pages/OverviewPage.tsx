import { useMemo } from "react";
import { useAppContext } from "../context/AppContext";
import { SidebarNavIcon } from "../components/icons";
import { formatServerDateTime, parseServerDateTime } from "../utils/dates";
import { formatProjectTitleParts, statusLabel } from "../utils/projects";
import { CriticalDot } from "../components/project/CriticalDot";

function formatHours(value: number) {
  return `${value.toFixed(1)}h`;
}

export function OverviewPage() {
  const {
    mainView,
    language,
    now,
    user,
    tasks,
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
    projectTitleParts: buildProjectTitleParts,
    filePreviewUrl,
    openProjectById,
    setProjectBackView,
    setMainView,
    setOverviewShortcutBackVisible,
    setConstructionBackView,
    clockIn,
    clockOut,
    startBreak,
    endBreak,
    projects,
  } = useAppContext();

  // Look up the full Project (with is_critical / audit fields) from an
  // overview row's project_id — overview rows don't carry the critical flag.
  const projectsById = useMemo(() => {
    const map = new Map<number, (typeof projects)[number]>();
    for (const p of projects) map.set(p.id, p);
    return map;
  }, [projects]);

  if (mainView !== "overview") return null;

  const de = language === "de";
  const locale = de ? "de-DE" : "en-US";
  const currentTimeLabel = now.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const currentShiftStart = parseServerDateTime(timeCurrent?.clock_in || "");
  const displayNetHours = Number(timeCurrent?.daily_net_hours ?? gaugeNetHours ?? 0);
  const displayRequiredHours = Number(timeCurrent?.required_daily_hours ?? requiredDailyHours ?? 0);
  const progressPercent = displayRequiredHours > 0 ? Math.max(0, Math.min(displayNetHours / displayRequiredHours, 1)) : 0;
  const gaugeCircumference = 2 * Math.PI * 26;
  const gaugeDash = `${progressPercent * gaugeCircumference} ${gaugeCircumference}`;
  const myOpenTaskCount = user
    ? tasks.filter((task) => {
        const assigned = (task.assignee_ids ?? []).includes(user.id) || task.assignee_id === user.id;
        const done = ["done", "completed", "archived"].includes(String(task.status ?? "").toLowerCase());
        return assigned && !done;
      }).length
    : 0;

  const shortcuts = [
    { view: "my_tasks", label: de ? "Meine Aufgaben" : "My Tasks", count: myOpenTaskCount },
    { view: "planning", label: de ? "Planung" : "Planning" },
    { view: "construction", label: de ? "Bericht" : "Report" },
    { view: "materials", label: de ? "Material" : "Materials" },
    { view: "messages", label: de ? "Nachrichten" : "Messages" },
    { view: "time", label: de ? "Zeit" : "Time" },
    { view: "wiki", label: "Wiki" },
  ] as const;

  const latestReports = recentConstructionReports.slice(0, 2);
  const myProjects = recentAssignedProjects.slice(0, 3);
  const overviewProjects = filteredDetailedOverview.slice(0, 6);

  return (
    <section className="overview-layout">
      <div className="overview-shortcuts">
        {shortcuts.map((action) => (
          <button
            key={action.view}
            type="button"
            className="overview-shortcut-card"
            onClick={() => {
              setProjectBackView(null);
              setOverviewShortcutBackVisible(true);
              setConstructionBackView(null);
              setMainView(action.view);
            }}
          >
            <span className="overview-shortcut-icon" aria-hidden="true">
              <SidebarNavIcon view={action.view} />
            </span>
            <span className="overview-shortcut-label">{action.label}</span>
            {"count" in action && typeof action.count === "number" && action.count > 0 ? (
              <span className="overview-shortcut-badge">{action.count}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="overview-main-grid">
        <div className="overview-primary-column">
          <article className="overview-card overview-status-card">
            <div className="overview-card-head">
              <h3>{de ? "Mein aktueller Status" : "My current status"}</h3>
            </div>

            <div className="overview-status-line">
              <span>{de ? "Aktuelle Uhrzeit" : "Current time"}</span>
              <strong>{currentTimeLabel}</strong>
            </div>

            <div className="overview-status-gauge-row">
              <svg viewBox="0 0 64 64" className="overview-status-gauge" aria-hidden="true">
                <circle cx="32" cy="32" r="26" className="overview-status-gauge-track" />
                <circle
                  cx="32"
                  cy="32"
                  r="26"
                  className="overview-status-gauge-fill"
                  strokeDasharray={gaugeDash}
                  transform="rotate(-90 32 32)"
                />
                <text x="32" y="36" textAnchor="middle" className="overview-status-gauge-text">
                  {formatHours(displayNetHours)}
                </text>
              </svg>

              <div className="overview-status-copy">
                <div>{`${de ? "Heute" : "Today"}: ${displayNetHours.toFixed(1)} / ${displayRequiredHours.toFixed(1)} h`}</div>
                <small>
                  {timeCurrent?.clock_entry_id
                    ? `${de ? "Schicht seit" : "Shift since"} ${currentShiftStart?.toLocaleTimeString(locale, {
                        hour: "2-digit",
                        minute: "2-digit",
                      }) || "-"}`
                    : de
                      ? "Keine offene Schicht"
                      : "No open shift"}
                </small>
              </div>
            </div>

            <div className="overview-status-actions">
              {timeCurrent?.clock_entry_id ? (
                <button type="button" className="overview-status-primary-btn" onClick={clockOut}>
                  {de ? "Ausstempeln" : "Clock out"}
                </button>
              ) : (
                <button type="button" className="overview-status-primary-btn" onClick={clockIn}>
                  {de ? "Einstempeln" : "Clock in"}
                </button>
              )}
              <button
                type="button"
                className="overview-status-secondary-btn"
                onClick={timeCurrent?.break_open ? endBreak : startBreak}
                disabled={!timeCurrent?.clock_entry_id}
              >
                {timeCurrent?.break_open ? (de ? "Pause Ende" : "Break end") : de ? "Pause" : "Break"}
              </button>
            </div>
          </article>

          <article className="overview-card overview-recent-reports-card">
            <div className="overview-card-head">
              <h3>{de ? "Neueste Berichte" : "Latest reports"}</h3>
            </div>
            <div className="overview-report-list">
              {latestReports.map((report) => {
                const reportProjectLabel = recentReportProjectTitleParts(report);
                return (
                  <div key={`recent-report-${report.id}`} className="overview-report-item">
                    <div className="overview-report-title">
                      {(de ? "Bericht" : "Report")}{" "}
                      {report.report_number != null ? `#${report.report_number}` : `#${report.id}`}
                    </div>
                    <div className="overview-report-meta">
                      {de ? "Projekt" : "Project"}: {reportProjectLabel.title}
                    </div>
                    {reportProjectLabel.subtitle ? (
                      <div className="overview-report-meta">{reportProjectLabel.subtitle}</div>
                    ) : null}
                    <div className="overview-report-meta">{formatServerDateTime(report.created_at, language)}</div>
                    <div className="overview-report-links">
                      {report.attachment_id ? (
                        <a href={filePreviewUrl(report.attachment_id)} target="_blank" rel="noreferrer">
                          {de ? "Öffnen" : "Open"} ↗
                        </a>
                      ) : (
                        <span className="muted">{de ? "Wird verarbeitet" : "Processing"}</span>
                      )}
                      {report.project_id ? (
                        <>
                          <span className="overview-inline-dot">·</span>
                          <button type="button" onClick={() => openProjectById(report.project_id!, null)}>
                            {de ? "Projekt" : "Project"}
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {latestReports.length === 0 ? (
                <div className="overview-empty-state">
                  {de ? "Keine Berichte vorhanden." : "No reports found."}
                </div>
              ) : null}
            </div>
          </article>
        </div>

        <article className="overview-card overview-side-card">
          <div className="overview-card-head">
            <h3>{de ? "Meine Projekte" : "My projects"}</h3>
          </div>
          <div className="overview-side-list">
            {myProjects.map((project) => {
              const projectLabel = buildProjectTitleParts(project);
              return (
                <button
                  key={project.id}
                  type="button"
                  className="overview-side-row"
                  onClick={() => openProjectById(project.id, null)}
                >
                  <strong>
                    {projectLabel.title}
                    <CriticalDot project={project} />
                  </strong>
                  <small>{projectLabel.subtitle}</small>
                </button>
              );
            })}
            {myProjects.length === 0 ? (
              <div className="overview-empty-state">
                {de ? "Keine zugewiesenen Projekte." : "No assigned projects."}
              </div>
            ) : null}
          </div>
        </article>

        <article className="overview-card overview-projects-card">
          <div className="overview-projects-head">
            <h3>{de ? "Projektübersicht" : "Projects overview"}</h3>
            <div className="overview-projects-controls">
              <label className="overview-state-filter">
                <span>{de ? "Status:" : "State:"}</span>
                <select value={overviewStatusFilter} onChange={(event) => setOverviewStatusFilter(event.target.value)}>
                  <option value="all">{de ? "Alle" : "All"}</option>
                  {overviewStatusOptions.map((statusValue) => (
                    <option key={statusValue} value={statusValue}>
                      {statusLabel(statusValue, language)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="overview-open-full-btn"
                onClick={() => {
                  setProjectBackView(null);
                  setMainView("projects_all");
                }}
              >
                <span aria-hidden="true">≡</span>
                <span>{de ? "Liste" : "List"}</span>
              </button>
            </div>
          </div>

          <div className="overview-projects-list">
            {overviewProjects.map((row) => {
              const projectId = Number(row.project_id);
              const projectNumber = row.project_number ?? row.project_id;
              const projectLabel = formatProjectTitleParts(
                String(projectNumber),
                String(row.customer_name ?? ""),
                String(row.project_name ?? ""),
                projectId,
              );
              const normalizedStatus = String(row.status ?? "unknown").replace(/_/g, "-").toLowerCase();
              return (
                <button
                  key={row.project_id}
                  type="button"
                  className="overview-project-row"
                  onClick={() => {
                    if (!projectId) return;
                    openProjectById(projectId, null);
                  }}
                >
                  <div className="overview-project-row-copy">
                    <strong>
                      {projectLabel.title}
                      {projectsById.get(projectId) && (
                        <CriticalDot project={projectsById.get(projectId)!} />
                      )}
                    </strong>
                    <small>
                      {String(row.customer_name ?? "").trim() || projectLabel.subtitle || (de ? "Ohne Kunde" : "No customer")} ·{" "}
                      {row.open_tasks} {de ? "Aufgaben" : "tasks"} · {row.sites}{" "}
                      {de ? (Number(row.sites) === 1 ? "Ort" : "Orte") : Number(row.sites) === 1 ? "site" : "sites"}
                    </small>
                  </div>
                  <span className={`overview-status-badge status-${normalizedStatus}`}>
                    {statusLabel(String(row.status ?? ""), language)}
                  </span>
                </button>
              );
            })}
            {overviewProjects.length === 0 ? (
              <div className="overview-empty-state">
                {de ? "Keine Projekte in diesem Status." : "No projects in this state."}
              </div>
            ) : null}
          </div>
        </article>
      </div>
    </section>
  );
}
