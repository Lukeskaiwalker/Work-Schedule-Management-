/**
 * CustomerReportsCard — construction reports filed for a customer.
 *
 * Reports are customer-owned with an optional project, so this is the primary
 * place a customer's site documentation lives. It lists reports linked directly
 * to the customer as well as reports belonging to that customer's projects
 * (the backend unions both), newest site-visit date first.
 *
 * Data loading mirrors CustomerTasksCard. One deliberate difference: a 403 is
 * swallowed to an empty list rather than raised, because report visibility is
 * permission- and project-scoped — a user without report access should simply
 * see no card content, not a red error banner on the customer page.
 */
import { useEffect, useState } from "react";

import { apiFetch, ApiError } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { formatServerDateTime } from "../../utils/dates";
import type { RecentConstructionReport } from "../../types";

type Props = {
  customerId: number;
};

export function CustomerReportsCard({ customerId }: Props) {
  const { token, language, setError, filePreviewUrl, openProjectById } = useAppContext();
  const de = language === "de";

  const [reports, setReports] = useState<RecentConstructionReport[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const rows = await apiFetch<RecentConstructionReport[]>(
          `/customers/${customerId}/construction-reports`,
          token,
        );
        if (!cancelled) setReports(rows);
      } catch (err: unknown) {
        if (cancelled) return;
        setReports([]);
        // Not having report permission is a normal state here, not an error.
        if (err instanceof ApiError && err.status === 403) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [customerId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <article className="card customer-reports-card">
      <div className="overview-card-head">
        <h3>{de ? "Baustellenberichte" : "Construction reports"}</h3>
        {reports.length > 0 && (
          <span className="muted">{reports.length}</span>
        )}
      </div>

      {loading && reports.length === 0 ? (
        <div className="overview-empty-state">{de ? "Wird geladen…" : "Loading…"}</div>
      ) : reports.length === 0 ? (
        <div className="overview-empty-state">
          {de
            ? "Noch keine Berichte für diesen Kunden."
            : "No reports for this customer yet."}
        </div>
      ) : (
        <div className="overview-report-list">
          {reports.map((report) => (
            <div key={`customer-report-${report.id}`} className="overview-report-item">
              <div className="overview-report-title">
                {(de ? "Bericht" : "Report")}{" "}
                {report.report_number != null ? `#${report.report_number}` : `#${report.id}`}
              </div>
              <div className="overview-report-meta">
                {de ? "Datum" : "Date"}: {report.report_date}
                {report.user_display_name ? ` · ${report.user_display_name}` : ""}
              </div>
              {/* Project is optional — only shown when the report has one. */}
              {report.project_id != null && (
                <div className="overview-report-meta">
                  {de ? "Projekt" : "Project"}: {report.project_name || `#${report.project_id}`}
                </div>
              )}
              <div className="overview-report-meta">
                {de ? "Eingereicht" : "Submitted"}:{" "}
                {formatServerDateTime(report.created_at, language)}
              </div>
              <div className="overview-report-links">
                {report.attachment_id ? (
                  <a href={filePreviewUrl(report.attachment_id)} target="_blank" rel="noreferrer">
                    {de ? "Öffnen" : "Open"} ↗
                  </a>
                ) : (
                  <span className="muted">{de ? "Wird verarbeitet" : "Processing"}</span>
                )}
                {report.project_id != null && (
                  <>
                    <span className="overview-inline-dot">·</span>
                    <button type="button" onClick={() => openProjectById(report.project_id!, null)}>
                      {de ? "Projekt" : "Project"}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
