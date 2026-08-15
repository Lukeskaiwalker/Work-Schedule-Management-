/**
 * "What did this person do on this day" — shown inside the time-page day modal.
 *
 * The modal already answers *how long* someone worked; this answers *on what*,
 * by pulling the two records that carry it: the tasks scheduled for them that
 * day, and the construction reports they filed (the report holds the "where"
 * and a snippet of the "what").
 *
 * Self-contained on purpose. It reads its own context and fetches its own data
 * from `day` + `userId`, so mounting it is a one-liner in TimePage and the
 * large page file grows by almost nothing. It fetches on every (day, userId)
 * change because the modal is reused across days and across viewed employees.
 *
 * Access is enforced server-side (same gate as the hours themselves), so there
 * is nothing to check here — a 403 simply renders as "not available".
 */
import { useEffect, useState } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";

interface DayActivityTask {
  id: number;
  title: string;
  status: string;
  task_type: string;
  project_id: number | null;
  project_number: string | null;
  project_name: string | null;
  customer_id: number | null;
  customer_name: string | null;
}

interface DayActivityReport {
  id: number;
  report_number: number | null;
  project_id: number | null;
  project_number: string | null;
  project_name: string | null;
  customer_id: number | null;
  customer_name: string | null;
  work_summary: string | null;
  attachment_id: number | null;
  processing_status: string;
}

interface DayActivity {
  user_id: number;
  day: string;
  tasks: DayActivityTask[];
  reports: DayActivityReport[];
}

type Phase = "loading" | "ready" | "error";

/** "2026-101 · PV-Anlage Müller", or the customer, or nothing. */
function whereLabel(row: {
  project_number: string | null;
  project_name: string | null;
  customer_name: string | null;
}): string {
  const project = [row.project_number, row.project_name].filter(Boolean).join(" · ");
  return project || row.customer_name || "";
}

export function DayActivityPanel({ day, userId }: { day: string; userId: number | null }) {
  const { token, language, openProjectById, filePreviewUrl, setTimeReopenDay } = useAppContext();
  const de = language === "de";
  const [phase, setPhase] = useState<Phase>("loading");
  const [data, setData] = useState<DayActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    setData(null);

    const query = new URLSearchParams({ day });
    if (userId != null) query.set("user_id", String(userId));

    apiFetch<DayActivity>(`/time/day-activity?${query.toString()}`, token)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setPhase("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setPhase("error");
      });

    return () => {
      cancelled = true;
    };
  }, [day, userId, token]);

  if (phase === "loading") {
    return (
      <div className="day-activity">
        <h3 className="day-activity-title">{de ? "Tätigkeiten" : "Activity"}</h3>
        <p className="day-activity-muted">{de ? "Wird geladen…" : "Loading…"}</p>
      </div>
    );
  }

  // A failure here is not worth shouting about — the hours below are the point
  // of the modal, and this section is an enrichment. Fail quietly.
  if (phase === "error" || !data) {
    return (
      <div className="day-activity">
        <h3 className="day-activity-title">{de ? "Tätigkeiten" : "Activity"}</h3>
        <p className="day-activity-muted">
          {de ? "Tätigkeiten nicht verfügbar." : "Activity not available."}
        </p>
      </div>
    );
  }

  const nothing = data.tasks.length === 0 && data.reports.length === 0;

  return (
    <div className="day-activity">
      <h3 className="day-activity-title">{de ? "Tätigkeiten" : "Activity"}</h3>

      {nothing && (
        <p className="day-activity-muted">
          {de
            ? "Keine Aufgaben oder Berichte an diesem Tag."
            : "No tasks or reports on this day."}
        </p>
      )}

      {data.tasks.length > 0 && (
        <div className="day-activity-group">
          <div className="day-activity-group-label">{de ? "Aufgaben" : "Tasks"}</div>
          <ul className="day-activity-list">
            {data.tasks.map((task) => {
              const place = whereLabel(task);
              const openable = task.project_id != null;
              return (
                <li key={`task-${task.id}`} className="day-activity-item">
                  <button
                    type="button"
                    className="day-activity-row"
                    disabled={!openable}
                    onClick={() => {
                      if (task.project_id == null) return;
                      // Remember the day so returning reopens it (TimePage
                      // consumes this on mount), and pass "time" as the
                      // back-view so the project page shows a "← Zeiterfassung"
                      // button. Passing null sent people to All Projects,
                      // stranding them several clicks from where they started.
                      setTimeReopenDay(day);
                      openProjectById(task.project_id, "time");
                    }}
                  >
                    <span className="day-activity-row-main">{task.title}</span>
                    {place && <span className="day-activity-row-where">{place}</span>}
                    <span className={`day-activity-status day-activity-status-${task.status}`}>
                      {task.status}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {data.reports.length > 0 && (
        <div className="day-activity-group">
          <div className="day-activity-group-label">{de ? "Berichte" : "Reports"}</div>
          <ul className="day-activity-list">
            {data.reports.map((report) => {
              const place = whereLabel(report);
              return (
                <li key={`report-${report.id}`} className="day-activity-item">
                  <div className="day-activity-report">
                    <div className="day-activity-report-head">
                      <span className="day-activity-row-main">
                        {place || (de ? "Bericht" : "Report")}
                      </span>
                      {report.attachment_id != null ? (
                        <a
                          className="day-activity-open"
                          href={filePreviewUrl(report.attachment_id)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {de ? "PDF öffnen" : "Open PDF"}
                        </a>
                      ) : (
                        <span className="day-activity-muted">
                          {de ? "PDF in Arbeit" : "PDF pending"}
                        </span>
                      )}
                    </div>
                    {report.work_summary && (
                      <p className="day-activity-report-summary">{report.work_summary}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
