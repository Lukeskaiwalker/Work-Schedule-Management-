import type { Language, RecentConstructionReport } from "../../types";
import {
  counterpartDayKey,
  formatClockTime,
  formatLaneDay,
  isLateFiling,
  type ReportAxis,
} from "../../utils/reportsLedger";
import { ReportDocumentControl } from "./ReportDocumentControl";

type Props = {
  report: RecentConstructionReport;
  axis: ReportAxis;
  language: Language;
  nowMs: number;
  filePreviewUrl: (fileId: number) => string;
  openProjectById: (projectId: number, backView?: null) => void;
};

/**
 * One ledger row: five lanes, fixed-width slots so the columns register
 * vertically down the page, exactly one dominant field (the customer).
 *
 * The row itself is **not** clickable — the two real destinations (project and
 * PDF) are explicit controls, so there is no ambiguous full-row target, no
 * nested-interactive tab-order problem, and no row whose click silently does
 * nothing because its PDF has not been generated yet.
 *
 * Three lanes are rendered but hidden by CSS at narrower widths (§9): the
 * compact filer line inside lane 2 (1101–1251px) and the meta line after lane 3
 * (≤1100px). Doing the collapse in CSS rather than JS keeps the row a pure
 * function of its report and avoids a resize listener per row.
 */
export function ReportLedgerRow({
  report,
  axis,
  language,
  nowMs,
  filePreviewUrl,
  openProjectById,
}: Props) {
  const de = language === "de";

  const counterpartKey = counterpartDayKey(report, axis);
  const counterpartDate = formatLaneDay(counterpartKey, language);
  const filedTime = formatClockTime(report.created_at);
  const diverged = isLateFiling(report);
  // In "site" mode lane 1 carries the filing timestamp, which needs the clock.
  const laneCarriesTime = axis === "site" && Boolean(filedTime);
  const laneDateText = laneCarriesTime ? `${counterpartDate} ${filedTime}` : counterpartDate;
  const laneDateClass = [
    "reports-date-value",
    laneCarriesTime ? "reports-date-value--withtime" : "",
    diverged ? "reports-date-value--diverged" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const customerName = (report.customer_name ?? "").trim();
  const filerName = (report.user_display_name ?? "").trim();
  const projectName = (report.project_name ?? "").trim();
  const projectNumber = (report.project_number ?? "").trim();
  const numberToken =
    report.report_number != null
      ? `${de ? "Nr." : "No."} ${report.report_number}`
      : `ID ${report.id}`;

  const metaParts = [
    counterpartDate,
    filerName || (de ? "Unbekannt" : "Unknown"),
    numberToken,
  ].filter((part) => part.length > 0);

  return (
    <div className="reports-row">
      <div className="reports-lane reports-lane--date">
        <span className={laneDateClass}>{laneDateText}</span>
        {diverged ? (
          <span className="reports-nachtrag">{de ? "NACHTRAG" : "LATE FILING"}</span>
        ) : null}
      </div>

      <div className="reports-lane reports-lane--customer">
        {customerName ? (
          <span className="reports-customer" title={customerName}>
            {customerName}
          </span>
        ) : (
          <span className="reports-customer reports-customer--empty">
            {de ? "Ohne Kunde" : "No customer"}
          </span>
        )}
        {/* 1101–1251px only: lane 4 collapses into the customer lane. */}
        <span className="reports-row-compact-filer">
          {filerName || (de ? "Unbekannt" : "Unknown")}
          {axis === "filed" && filedTime ? ` · ${filedTime}` : ""}
        </span>
      </div>

      <ProjectLane
        report={report}
        de={de}
        projectName={projectName}
        projectNumber={projectNumber}
        openProjectById={openProjectById}
      />

      {/* ≤1100px only: the stacked layout's single meta line. */}
      <div className="reports-row-meta">{metaParts.join(" · ")}</div>

      <div className="reports-lane reports-lane--filer">
        {filerName ? (
          <span className="reports-filer-name" title={filerName}>
            {filerName}
          </span>
        ) : (
          <span className="reports-filer-name reports-filer-name--unknown">
            {de ? "Unbekannt" : "Unknown"}
          </span>
        )}
        {axis === "filed" && filedTime ? (
          <span className="reports-filer-time">{filedTime}</span>
        ) : null}
      </div>

      <div className="reports-lane reports-lane--doc">
        <span className="reports-doc-number">{numberToken}</span>
        <ReportDocumentControl
          report={report}
          language={language}
          nowMs={nowMs}
          filePreviewUrl={filePreviewUrl}
        />
      </div>
    </div>
  );
}

type ProjectLaneProps = {
  report: RecentConstructionReport;
  de: boolean;
  projectName: string;
  projectNumber: string;
  openProjectById: (projectId: number, backView?: null) => void;
};

/**
 * Lane 3, built from `project_name` + `project_number` **directly**.
 *
 * `formatProjectTitle` is deliberately not used: it puts the *customer* first
 * (`utils/projects.ts:127`), which would make this lane a restatement of the
 * customer lane 12px above it. A project-less report is a normal state (reports
 * are customer-owned), so it is rendered as words, not as an error.
 */
function ProjectLane({ report, de, projectName, projectNumber, openProjectById }: ProjectLaneProps) {
  const projectId = report.project_id;

  if (projectId == null) {
    return (
      <div className="reports-lane reports-lane--project">
        <span className="reports-project-plain">{de ? "Ohne Projekt" : "No project"}</span>
      </div>
    );
  }

  // Legacy rows can carry an id with no name. Never render a clickable element
  // that has no accessible name.
  if (!projectName && !projectNumber) {
    return (
      <div className="reports-lane reports-lane--project">
        <span className="reports-project-plain">{`${de ? "Projekt" : "Project"} #${projectId}`}</span>
      </div>
    );
  }

  const headline = projectName || projectNumber;
  const showNumber = Boolean(projectName) && Boolean(projectNumber);

  return (
    <div className="reports-lane reports-lane--project">
      <button
        type="button"
        className="reports-project-btn"
        onClick={() => openProjectById(projectId, null)}
        title={headline}
      >
        <span className="reports-project-name">{headline}</span>
      </button>
      {showNumber ? <span className="reports-project-number">{projectNumber}</span> : null}
    </div>
  );
}
