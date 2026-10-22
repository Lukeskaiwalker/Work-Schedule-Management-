import { useAppContext } from "../../../../context/AppContext";
import { useDashboardNavigation } from "../../../../hooks/useDashboardNavigation";
import { useDashboardResource } from "../../../../hooks/useDashboardResource";
import type { Language, RecentConstructionReport } from "../../../../types";
import { parseServerDateTime } from "../../../../utils/dates";
import { DASHBOARD_POLL_MS } from "../../dashboardPolling";
import { DashboardWidgetFrame } from "../../DashboardWidgetFrame";
import { DASHBOARD_WIDGET_META } from "../../widgetMeta";
import type { DashboardWidgetProps } from "../../widgetTypes";
import { RECENT_REPORTS_KEY, loadRecentReports } from "./officeResources";
import { frameStateOf, limitRows, localeOf, useFullPageLink } from "./officeShared";
import "./office.css";

/** „20.10., 14:03“: day and time are what tells two reports of a week apart. */
function formatCreated(value: string, language: Language): string {
  const parsed = parseServerDateTime(value);
  if (!parsed) return "";
  return parsed.toLocaleString(localeOf(language), { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/**
 * „Neueste Berichte“: the newest construction reports, with the PDF and the
 * project one tap away (docs/DASHBOARD.md §1). It replaces the reports card
 * App used to load for the overview, and polls only while it is on screen.
 */
export default function RecentReportsWidget({ size }: DashboardWidgetProps) {
  const { language, recentReportProjectTitleParts, filePreviewUrl } = useAppContext();
  const { open } = useDashboardNavigation();
  const resource = useDashboardResource(RECENT_REPORTS_KEY, loadRecentReports, {
    pollMs: DASHBOARD_POLL_MS.recentReports,
  });
  const openAll = useFullPageLink("reports");

  const de = language === "de";
  const reports = resource.data ?? [];
  const { visible, more } = limitRows(reports, size);

  function placeOf(report: RecentConstructionReport): string {
    if (report.project_id) return recentReportProjectTitleParts(report).title;
    // A customer-only report has no project to name.
    return report.customer_name?.trim() ?? "";
  }

  return (
    <DashboardWidgetFrame
      title={DASHBOARD_WIDGET_META.recent_reports.title[language]}
      action={openAll ? { label: de ? "Alle anzeigen" : "Show all", onClick: openAll } : null}
      state={frameStateOf(resource)}
      isEmpty={resource.data !== null && reports.length === 0}
      emptyText={de ? "Keine Berichte vorhanden." : "No reports found."}
      more={openAll ? { count: more, onClick: openAll } : null}
    >
      <ul className="dashboard-office__list">
        {visible.map((report) => {
          const place = placeOf(report);
          const created = formatCreated(report.created_at, language);
          const author = report.user_display_name?.trim() ?? "";
          const projectId = report.project_id ?? null;
          return (
            <li key={report.id} className="dashboard-office__row dashboard-office__row--static dashboard-office__row--report">
              <div className="dashboard-office__main">
                <span className="dashboard-office__primary">
                  {`${de ? "Bericht" : "Report"} #${report.report_number ?? report.id}`}
                </span>
                {place ? <span className="dashboard-office__secondary">{place}</span> : null}
                <span className="dashboard-office__secondary">{[created, author].filter(Boolean).join(" · ")}</span>
              </div>
              <div className="dashboard-office__links">
                {report.attachment_id ? (
                  <a
                    className="dashboard-office__link"
                    href={filePreviewUrl(report.attachment_id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {de ? "Öffnen" : "Open"} <span aria-hidden="true">↗</span>
                  </a>
                ) : (
                  <span className="dashboard-office__pending">{de ? "Wird verarbeitet" : "Processing"}</span>
                )}
                {projectId !== null ? (
                  <button
                    type="button"
                    className="dashboard-office__link"
                    onClick={() => open({ kind: "project", projectId })}
                  >
                    {de ? "Projekt" : "Project"}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </DashboardWidgetFrame>
  );
}
