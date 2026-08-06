import type { Language, RecentConstructionReport } from "../../types";
import {
  REPORTS_PENDING_DELAY_MINUTES,
  pendingAgeMinutes,
  reportDocumentBranch,
} from "../../utils/reportsLedger";
import { ReportsOpenIcon } from "./ReportsIcons";

type Props = {
  report: RecentConstructionReport;
  language: Language;
  /** `Date.now()` snapshot, only read by the pending branch. */
  nowMs: number;
  filePreviewUrl: (fileId: number) => string;
};

/**
 * Lane 5's status control — exactly one of four renderings, driven by
 * `processing_status` **and** `attachment_id` together.
 *
 * The failed branch deliberately offers **no open link even when
 * `attachment_id` is set**: a stale PDF served as the current one is precisely
 * the lie this view exists to stop. It also offers no retry button, because
 * `workflow_reports.py` exposes no retry endpoint and drawing the affordance
 * that completes the triad visually would be a promise the API cannot keep.
 */
export function ReportDocumentControl({ report, language, nowMs, filePreviewUrl }: Props) {
  const de = language === "de";
  const branch = reportDocumentBranch(report);

  if (branch === "failed") {
    return (
      <span
        className="reports-status-chip reports-status-chip--failed"
        title={
          de
            ? "PDF-Erzeugung fehlgeschlagen — bitte das Büro informieren."
            : "PDF generation failed — please inform the office."
        }
      >
        <span className="reports-status-dot" aria-hidden="true" />
        {de ? "FEHLGESCHLAGEN" : "FAILED"}
      </span>
    );
  }

  if (branch === "open") {
    return (
      <a
        className="reports-open-btn"
        href={filePreviewUrl(report.attachment_id as number)}
        target="_blank"
        rel="noreferrer"
      >
        <ReportsOpenIcon />
        {de ? "Öffnen" : "Open"}
      </a>
    );
  }

  if (branch === "pending") {
    const minutes = pendingAgeMinutes(report, nowMs);
    const delayed = minutes >= REPORTS_PENDING_DELAY_MINUTES;
    const age = de
      ? `seit ${minutes} Min.${delayed ? " · verzögert" : ""}`
      : `${minutes} min ago${delayed ? " · delayed" : ""}`;
    return (
      <span className="reports-status-stack">
        <span
          className="reports-status-chip reports-status-chip--pending"
          title={
            de
              ? "Die PDF-Datei wird im Hintergrund erzeugt."
              : "The PDF file is being generated in the background."
          }
        >
          <span className="reports-status-dot" aria-hidden="true" />
          {de ? "WIRD ERSTELLT" : "GENERATING"}
        </span>
        <span className="reports-status-age">{age}</span>
      </span>
    );
  }

  return (
    <span
      className="reports-status-chip reports-status-chip--missing"
      title={
        de
          ? "Der Bericht ist fertig, die PDF-Datei ist nicht mehr vorhanden — bitte das Büro informieren."
          : "The report is complete but the PDF file is no longer available — please inform the office."
      }
    >
      <span className="reports-status-dot" aria-hidden="true" />
      {de ? "PDF FEHLT" : "PDF MISSING"}
    </span>
  );
}
