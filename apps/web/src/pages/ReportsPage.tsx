import { useAppContext } from "../context/AppContext";
import { formatServerDateTime } from "../utils/dates";

/**
 * Dedicated construction-report history view — the last 4 weeks of reports,
 * analogous to the site calendar, so reports can be browsed without searching.
 * Self-gates on `mainView === "reports"`; the window is loaded by App's per-view
 * effect into `reportsWindow`. Reuses the Overview report-item markup/styles.
 */
export function ReportsPage() {
  const {
    mainView,
    language,
    reportsWindow,
    reportsWindowLoading,
    recentReportProjectTitleParts,
    filePreviewUrl,
    openProjectById,
  } = useAppContext();

  if (mainView !== "reports") return null;
  const de = language === "de";

  return (
    <section className="reports-page">
      <p className="reports-page-subtitle muted">
        {de
          ? "Baustellenberichte der letzten 4 Wochen"
          : "Construction reports from the last 4 weeks"}
      </p>

      {reportsWindowLoading && reportsWindow.length === 0 ? (
        <div className="overview-empty-state">{de ? "Wird geladen…" : "Loading…"}</div>
      ) : reportsWindow.length === 0 ? (
        <div className="overview-empty-state">
          {de ? "Keine Berichte in den letzten 4 Wochen." : "No reports in the last 4 weeks."}
        </div>
      ) : (
        <div className="overview-report-list reports-page-list">
          {reportsWindow.map((report) => {
            const projectLabel = recentReportProjectTitleParts(report);
            return (
              <article key={`report-window-${report.id}`} className="overview-report-item">
                <div className="overview-report-title">
                  {(de ? "Bericht" : "Report")}{" "}
                  {report.report_number != null ? `#${report.report_number}` : `#${report.id}`}
                </div>
                <div className="overview-report-meta">
                  {de ? "Projekt" : "Project"}: {projectLabel.title}
                </div>
                {projectLabel.subtitle ? (
                  <div className="overview-report-meta">{projectLabel.subtitle}</div>
                ) : null}
                <div className="overview-report-meta">
                  {de ? "Berichtsdatum" : "Report date"}: {report.report_date}
                </div>
                <div className="overview-report-meta">
                  {de ? "Eingereicht" : "Submitted"}: {formatServerDateTime(report.created_at, language)}
                  {report.user_display_name ? ` · ${report.user_display_name}` : ""}
                </div>
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
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
