/**
 * "Projektbericht" on the project overview.
 *
 * The report is not a document anyone writes. It is rendered from the
 * project's data every time it is looked at — master data, tasks, the note
 * feed, the site reports — so there is nothing to keep up to date and
 * nothing that can be forgotten. "Vorschau anzeigen" opens that rendering
 * in the file viewer, as of now; the viewer gets the report's own URLs via
 * `source`, since there is no attachment to derive them from.
 *
 * When the project is marked abgeschlossen or archived the server files the
 * rendering of that moment as a PDF in Berichte, and the card then shows
 * it. A manager can file one by hand at any time, and again later — every
 * copy stays in the folder, the card points at the newest.
 */
import { useState } from "react";

import { apiFetch } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import { apiUrl } from "../../native/shell";
import type { ProjectReportState } from "../../types";
import { formatServerDateTime } from "../../utils/dates";
import { FileLightbox, fileDownloadUrl, type LightboxFile } from "../files/FileLightbox";
import "../../styles/project-report.css";

const NOT_FINALIZED: ProjectReportState = { finalized_at: null, attachment_id: null, file_name: null };

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function ProjectReportCard() {
  const {
    token,
    language,
    activeProject,
    activeProjectId,
    projectOverviewDetails,
    loadProjectOverview,
    canCreateProject,
    setError,
    setNotice,
  } = useAppContext();
  const de = language === "de";
  const [viewing, setViewing] = useState<LightboxFile | null>(null);
  const [finalizing, setFinalizing] = useState(false);

  if (!activeProjectId) return null;

  const projectNumber = (activeProject?.project_number ?? "").trim();
  const state = projectOverviewDetails?.project_report ?? NOT_FINALIZED;
  // Both together, or nothing: a date without a file (the file was deleted,
  // the pointer is SET NULL) is not a report anyone can open.
  const finalized = state.finalized_at && state.attachment_id != null ? state : null;

  const previewFile: LightboxFile = {
    // Negative on purpose: never an attachment id, so it cannot collide with
    // one should a host ever put both in one sequence.
    id: -activeProjectId,
    file_name: `Projektbericht ${projectNumber} (Vorschau).pdf`,
    content_type: "application/pdf",
    subtitle: de ? "Vorschau – Stand jetzt" : "Preview – as of now",
    source: {
      previewUrl: apiUrl(`/api/projects/${activeProjectId}/report/preview`),
      downloadUrl: apiUrl(`/api/projects/${activeProjectId}/report/preview?download=1`),
      pagesUrl: apiUrl(`/api/projects/${activeProjectId}/report/preview-pages`),
    },
  };

  function openStored() {
    if (!finalized || finalized.attachment_id == null) return;
    setViewing({
      id: finalized.attachment_id,
      file_name: finalized.file_name ?? `Projektbericht ${projectNumber}.pdf`,
      content_type: "application/pdf",
      subtitle: "Berichte",
    });
  }

  async function finalize() {
    if (!activeProjectId || finalizing) return;
    const question = finalized
      ? de
        ? "Projektbericht neu erstellen? Die bisherige Datei bleibt in Berichte."
        : "Create the project report again? The previous file stays in Berichte."
      : de
        ? "Projektbericht jetzt als PDF in Berichte ablegen?"
        : "File the project report as a PDF in Berichte now?";
    if (!window.confirm(question)) return;
    setFinalizing(true);
    try {
      await apiFetch<ProjectReportState>(`/projects/${activeProjectId}/report/finalize`, token, { method: "POST" });
      await loadProjectOverview(activeProjectId);
      setNotice(de ? "Projektbericht abgelegt" : "Project report filed");
    } catch (err) {
      setError(messageOf(err, de ? "Projektbericht konnte nicht abgelegt werden" : "Failed to file the project report"));
    } finally {
      setFinalizing(false);
    }
  }

  const finalizeLabel = finalizing
    ? de
      ? "Wird abgelegt …"
      : "Filing …"
    : finalized
      ? de
        ? "Neu erstellen"
        : "Create again"
      : de
        ? "Jetzt finalisieren"
        : "Finalize now";

  return (
    <div className="card project-report-card">
      <div className="project-overview-card-head">
        <h3 className="project-overview-title">{de ? "Projektbericht" : "Project report"}</h3>
      </div>
      <p className="project-report-lead">
        {de
          ? "Wird laufend aus Stammdaten, Aufgaben, internen Notizen und Baustellenberichten zusammengestellt und beim Abschluss oder Archivieren des Projekts als PDF in Berichte abgelegt."
          : "Compiled continuously from master data, tasks, internal notes and site reports, and filed as a PDF in Berichte when the project is completed or archived."}
      </p>
      <div className="project-report-actions">
        <button type="button" onClick={() => setViewing(previewFile)}>
          {de ? "Vorschau anzeigen" : "Show preview"}
        </button>
        {canCreateProject && (
          <button
            type="button"
            className="project-report-finalize"
            onClick={() => void finalize()}
            disabled={finalizing}
          >
            {finalizeLabel}
          </button>
        )}
      </div>
      {finalized && finalized.attachment_id != null && (
        <div className="project-report-final">
          <span className="project-report-final-label">
            {de ? "Abschlussbericht vom" : "Final report of"}{" "}
            <b>{formatServerDateTime(finalized.finalized_at, language)}</b>
          </span>
          <button type="button" className="linklike" onClick={openStored}>
            {de ? "Öffnen" : "Open"}
          </button>
          <a
            className="linklike"
            href={fileDownloadUrl(finalized.attachment_id)}
            download={finalized.file_name ?? undefined}
            target="_blank"
            rel="noreferrer"
          >
            {de ? "Herunterladen" : "Download"}
          </a>
        </div>
      )}
      {viewing && (
        <FileLightbox
          files={[viewing]}
          index={0}
          onIndexChange={() => undefined}
          onClose={() => setViewing(null)}
          language={de ? "de" : "en"}
        />
      )}
    </div>
  );
}
