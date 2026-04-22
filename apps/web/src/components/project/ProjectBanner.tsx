import { useState } from "react";
import { useAppContext } from "../../context/AppContext";
import { statusLabel } from "../../utils/projects";
import { formatHours } from "../../utils/misc";
import { formatServerDateTime } from "../../utils/dates";

export function ProjectBanner() {
  const {
    mainView,
    activeProject,
    language,
    projectTabs,
    projectTab,
    setProjectTab,
    tabLabels,
    projectReportedHoursTotal,
    projectPlannedHoursTotal,
    projectOverviewDetails,
    projectOverviewOpenTasks,
    activeProjectLastState,
    activeProjectLastUpdatedLabel,
    canMarkCritical,
    setProjectCritical,
    userNameById,
  } = useAppContext();

  const [saving, setSaving] = useState(false);

  if (mainView !== "project" || !activeProject) return null;

  const openTasksCount = projectOverviewDetails?.open_tasks ?? projectOverviewOpenTasks.length;
  const customerName = (activeProject.customer_name ?? "").trim() || "-";
  const projectState = (activeProjectLastState ?? "").trim();
  const isCritical = !!activeProject.is_critical;

  const criticalSinceLabel = activeProject.critical_since
    ? formatServerDateTime(activeProject.critical_since, language)
    : "-";
  const criticalByLabel = activeProject.critical_set_by_user_id
    ? userNameById(activeProject.critical_set_by_user_id)
    : "-";
  const criticalTooltip =
    language === "de"
      ? `Kritisch seit ${criticalSinceLabel} · Gesetzt von ${criticalByLabel}`
      : `Critical since ${criticalSinceLabel} · Set by ${criticalByLabel}`;

  async function handleToggleCritical() {
    if (!activeProject || saving) return;
    setSaving(true);
    try {
      await setProjectCritical(activeProject.id, !isCritical);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="project-banner">
      {isCritical && (
        <div
          className="project-critical-banner"
          role="status"
          aria-live="polite"
          title={criticalTooltip}
        >
          <svg
            className="project-critical-banner-icon"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              d="M12 3 2.5 19.5h19L12 3Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path
              d="M12 10v4M12 17.2v.1"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span className="project-critical-banner-text">
            {language === "de"
              ? "Dieses Projekt ist als kritisch markiert"
              : "This project is marked as critical"}
          </span>
          <span className="project-critical-banner-meta">{criticalTooltip}</span>
        </div>
      )}
      <div className="project-banner-inner">
        {/* Project info row */}
        <div className="project-banner-info">
          <div className="project-banner-topline">
            <span className="project-banner-number">#{activeProject.project_number}</span>
            <span className="project-banner-badge">
              <span className="project-banner-badge-dot" />
              {statusLabel(activeProject.status, language)}
            </span>
            {projectState && (
              <span className="project-banner-badge project-banner-badge-muted">{projectState}</span>
            )}
            {canMarkCritical && (
              <button
                type="button"
                className={`project-banner-critical-toggle${isCritical ? " active" : ""}`}
                onClick={handleToggleCritical}
                disabled={saving}
                title={isCritical ? criticalTooltip : undefined}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 3 2.5 19.5h19L12 3Z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 10v4M12 17.2v.1"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                {isCritical
                  ? language === "de"
                    ? "Kritisch aufheben"
                    : "Unmark critical"
                  : language === "de"
                    ? "Als kritisch markieren"
                    : "Mark critical"}
              </button>
            )}
          </div>
          <h2 className="project-banner-title">{activeProject.name}</h2>
          <p className="project-banner-subtitle">
            {language === "de" ? "Kunde" : "Customer"}: {customerName}
            {" · "}
            {language === "de" ? "Letzte Änderung" : "Last updated"}: {activeProjectLastUpdatedLabel || "-"}
          </p>
        </div>

        {/* Stats + tabs bottom row */}
        <div className="project-banner-bottom">
          <div className="project-banner-stat">
            <span className="project-banner-stat-label">
              {language === "de" ? "Gemeldete Std." : "Reported HRS"}
            </span>
            <span className="project-banner-stat-value">
              {formatHours(projectReportedHoursTotal)}
            </span>
          </div>
          <div className="project-banner-stat">
            <span className="project-banner-stat-label">
              {language === "de" ? "Geplante Std." : "Planned HRS"}
            </span>
            <span className="project-banner-stat-value">
              {projectPlannedHoursTotal > 0 ? formatHours(projectPlannedHoursTotal) : "-"}
            </span>
          </div>
          <div className="project-banner-stat">
            <span className="project-banner-stat-label">
              {language === "de" ? "Offene Aufgaben" : "Open Tasks"}
            </span>
            <span className="project-banner-stat-value project-banner-stat-accent">
              {openTasksCount}
            </span>
          </div>

          <div className="project-banner-spacer" />

          <nav className="project-banner-tabs">
            {projectTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                className={`project-banner-tab${projectTab === tab ? " active" : ""}`}
                onClick={() => setProjectTab(tab)}
              >
                {tabLabels[tab]}
              </button>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}
