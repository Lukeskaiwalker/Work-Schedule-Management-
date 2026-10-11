// One job, as the partner needs it on site: when, where (with a route link
// and the access note), what the office wrote, the project's plans, the
// photos, the hours worked, who to call, and the one action that matters —
// "Als erledigt melden".

import { useRef, useState, type ChangeEvent } from "react";
import { ApiError } from "../api/client";
import { compressReportImage } from "../utils/imageCompression";
import { CalendarIcon, CameraIcon, CheckIcon, ChevronRightIcon, DocumentIcon, KeyIcon, PhoneIcon, PinIcon, RouteIcon } from "./PortalIcons";
import { DocumentsSection } from "./PortalDocuments";
import { HoursSection, HoursSheet, useHoursReporting } from "./PortalHours";
import { PortalBand, PortalTitle, Skeletons, accessText, mapsHref, telHref, type NavTarget } from "./PortalParts";
import { completePortalTask, getPortalTask, portalFileUrl, uploadPortalFiles } from "./portalApi";
import { formatShortDate, localTodayIso, whenLines } from "./portalDates";
import type { PortalFile, PortalMe, PortalTaskDetail } from "./portalTypes";
import { usePortalResource } from "./usePortalResource";

const STATUS_LABEL: Record<PortalTaskDetail["status"], string> = {
  open: "Offen",
  in_progress: "In Arbeit",
  on_hold: "Pausiert",
  done: "Erledigt",
};

function whenPill(task: PortalTaskDetail, todayIso: string) {
  if (task.status === "done") return null;
  if (task.is_overdue) return <span className="pp-pill pp-pill--overdue">Überfällig</span>;
  if (task.due_date && task.due_date <= todayIso && todayIso <= (task.end_date || task.due_date)) {
    return <span className="pp-pill pp-pill--today">Heute</span>;
  }
  if (task.due_date) return <span className="pp-pill pp-pill--band">{formatShortDate(task.due_date)}</span>;
  return null;
}

function sourceLabel(file: PortalFile): string {
  if (file.source === "partner") return "von Ihnen";
  if (file.source === "office") return "vom Büro";
  return "von Partner";
}

function uploadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return "Eine Datei ist zu groß (höchstens 25 MB).";
    if (error.status === 400) return "Nur Fotos (JPG, PNG, HEIC) und PDF-Dateien, höchstens 10 auf einmal.";
  }
  return "Hochladen hat nicht geklappt. Bitte erneut versuchen.";
}

function FileTiles({ taskId, files }: { taskId: number; files: PortalFile[] }) {
  return (
    <div className="pp-tiles">
      {files.map((file) => {
        const isImage = file.content_type.startsWith("image/");
        return (
          <a key={file.id} className="pp-tile" href={portalFileUrl(taskId, file.id)} target="_blank" rel="noopener" aria-label={`${file.file_name} öffnen`}>
            {isImage ? (
              <>
                <img src={portalFileUrl(taskId, file.id)} alt={file.file_name} loading="lazy" />
                <span className="pp-tile-badge">{sourceLabel(file)}</span>
              </>
            ) : (
              <>
                <span className="pp-tile-doc-icon"><DocumentIcon size={26} /></span>
                <span className="pp-tile-name">{file.file_name}</span>
                <span className="pp-tile-source">{sourceLabel(file)}</span>
              </>
            )}
          </a>
        );
      })}
    </div>
  );
}

function CompleteDialog({ busy, error, onConfirm, onCancel }: { busy: boolean; error: string | null; onConfirm: (note: string) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="pp-dialog-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <div className="pp-dialog" role="dialog" aria-modal="true" aria-labelledby="pp-complete-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="pp-complete-title" className="pp-dialog-title">Als erledigt melden?</h2>
        <p className="pp-info-detail">Das Büro sieht Ihre Meldung sofort. Fehlt noch etwas oder ist etwas aufgefallen? Schreiben Sie es dazu.</p>
        <label className="pp-field" htmlFor="pp-complete-note">
          Rückmeldung an das Büro (optional)
          <textarea id="pp-complete-note" className="pp-textarea" value={note} maxLength={4000} onChange={(event) => setNote(event.target.value)} />
        </label>
        {error && <div className="pp-alert" role="alert">{error}</div>}
        <div className="pp-dialog-actions">
          <button type="button" className="pp-btn pp-btn--primary" disabled={busy} onClick={() => onConfirm(note)}>
            <CheckIcon size={22} />
            {busy ? "Wird gemeldet …" : "Erledigt melden"}
          </button>
          <button type="button" className="pp-btn pp-btn--soft" disabled={busy} onClick={onCancel}>
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}

export function PortalTaskPage({
  token,
  me,
  taskId,
  onBack,
  onNavigate,
  onOpenProject,
}: {
  token: string;
  me: PortalMe;
  taskId: number;
  onBack: () => void;
  onNavigate: (target: NavTarget) => void;
  onOpenProject: (id: number) => void;
}) {
  const resource = usePortalResource(() => getPortalTask(token, taskId), `task:${taskId}`);
  const task = resource.data;
  const todayIso = localTodayIso();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState<string | null>(null);
  const [justCompleted, setJustCompleted] = useState(false);
  const hoursFlow = useHoursReporting(token, resource.reload);

  async function onFilesChosen(event: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!task || chosen.length === 0) return;
    setUploading(true);
    setUploadMessage(null);
    try {
      const prepared = await Promise.all(chosen.map((file) => (file.type.startsWith("image/") || /\.hei[cf]$/i.test(file.name) ? compressReportImage(file) : file)));
      await uploadPortalFiles(token, task.id, prepared);
      await resource.reload();
      setUploadMessage(prepared.length === 1 ? "Foto hochgeladen." : `${prepared.length} Dateien hochgeladen.`);
    } catch (error) {
      setUploadMessage(uploadError(error));
    } finally {
      setUploading(false);
    }
  }

  async function complete(note: string) {
    if (!task) return;
    setCompleting(true);
    setCompleteError(null);
    try {
      resource.replace(await completePortalTask(token, task.id, note));
      setDialogOpen(false);
      setJustCompleted(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await resource.reload();
        setDialogOpen(false);
        return;
      }
      setCompleteError("Das hat nicht geklappt. Bitte erneut versuchen.");
    } finally {
      setCompleting(false);
    }
  }

  const context = task?.project ? `${task.project.name} · ${task.project.number}` : task?.customer_name ?? null;
  const when = task ? whenLines(task) : null;
  const access = task ? accessText(task.site_access_type, task.site_access_note) : null;
  const companyName = me.company.name || "Büro";
  const hasJobText = Boolean(task && (task.description || task.subtasks.length > 0 || task.materials || task.team.length > 0));

  return (
    <>
      <PortalBand me={me} active={null} onNavigate={onNavigate}>
        <PortalTitle
          back={{ label: "Aufgaben", onClick: onBack }}
          eyebrow={context}
          title={task?.title ?? "Aufgabe"}
          detail
          pills={
            task ? (
              <>
                {whenPill(task, todayIso)}
                <span className={task.status === "done" ? "pp-pill pp-pill--done" : "pp-pill pp-pill--band"}>{STATUS_LABEL[task.status]}</span>
              </>
            ) : null
          }
        />
      </PortalBand>
      <main className={task?.can_complete ? "pp-main pp-main--with-action" : "pp-main"}>
        <div className="pp-main-inner">
          {resource.loading && !task ? (
            <Skeletons count={3} />
          ) : !task ? (
            <div className="pp-alert" role="alert">
              {resource.error instanceof ApiError && resource.error.status === 404
                ? "Diese Aufgabe ist Ihnen nicht (mehr) zugewiesen."
                : "Die Aufgabe konnte nicht geladen werden."}
            </div>
          ) : (
            <>
              {justCompleted && (
                <div className="pp-done-banner" role="status">
                  <CheckIcon size={22} />
                  Erledigt gemeldet – danke!
                </div>
              )}
              <section className="pp-card" aria-label="Wann und wo">
                <div className="pp-info-row">
                  <span className="pp-icon-slot"><CalendarIcon size={18} /></span>
                  <span className="pp-info-text">
                    <span className="pp-info-title">{when?.title}</span>
                    {when?.detail && <span className="pp-info-detail">{when.detail}</span>}
                  </span>
                </div>
                {task.address && (
                  <div className="pp-info-row">
                    <span className="pp-icon-slot"><PinIcon size={18} /></span>
                    <span className="pp-info-text">
                      <span className="pp-info-title">{task.address}</span>
                    </span>
                    <a className="pp-btn" href={mapsHref(task.address)} target="_blank" rel="noopener">
                      <RouteIcon size={16} />
                      Route
                    </a>
                  </div>
                )}
                {access && (
                  <div className="pp-info-row pp-info-row--access">
                    <span className="pp-icon-slot"><KeyIcon size={18} /></span>
                    <span className="pp-info-text">
                      <span className="pp-kicker">Zugang</span>
                      <span className="pp-body-text">{access}</span>
                    </span>
                  </div>
                )}
              </section>

              {task.project_note && (
                <section className="pp-card pp-card--padded" aria-label="Hinweis vom Büro">
                  <span className="pp-kicker">Hinweis vom Büro</span>
                  <p className="pp-body-text">{task.project_note}</p>
                </section>
              )}

              {hasJobText && (
                <section className="pp-card pp-card--padded" aria-label="Auftrag">
                  <span className="pp-kicker">Auftrag</span>
                  {task.description && <p className="pp-body-text">{task.description}</p>}
                  {task.subtasks.length > 0 && (
                    <ol className="pp-steps">
                      {task.subtasks.map((step, index) => (
                        <li key={`${index}-${step}`} className="pp-step">
                          <span className="pp-step-num" aria-hidden="true">{index + 1}</span>
                          <span>{step}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {task.materials && (
                    <p className="pp-body-text"><strong>Material:</strong> {task.materials}</p>
                  )}
                  {task.team.length > 0 && (
                    <p className="pp-info-detail">Vor Ort von {companyName}: {task.team.join(", ")}</p>
                  )}
                </section>
              )}

              <DocumentsSection documents={task.documents} hint="Vom Büro für das ganze Projekt bereitgestellt." />

              <section className="pp-card pp-card--padded" aria-label="Fotos und Dateien">
                <div className="pp-section-head">
                  <span className="pp-kicker">Fotos &amp; Dateien</span>
                  {task.files.length > 0 && (
                    <span className="pp-section-meta">{task.files.length === 1 ? "1 Datei" : `${task.files.length} Dateien`}</span>
                  )}
                </div>
                {task.files.length > 0 && <FileTiles taskId={task.id} files={task.files} />}
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  hidden
                  onChange={onFilesChosen}
                />
                <button type="button" className="pp-btn pp-btn--dashed" disabled={uploading} onClick={() => fileInput.current?.click()}>
                  <CameraIcon size={20} />
                  {uploading ? "Wird hochgeladen …" : "Fotos hinzufügen"}
                </button>
                {uploadMessage && <p className="pp-info-detail" role="status">{uploadMessage}</p>}
              </section>

              <HoursSection
                entries={task.hours}
                total={task.hours_total}
                showTask={false}
                message={hoursFlow.message}
                deletingId={hoursFlow.deletingId}
                onAdd={hoursFlow.open}
                onDelete={(entry) => void hoursFlow.remove(entry)}
              />

              {task.project && (
                <button type="button" className="pp-card pp-project-card" onClick={() => onOpenProject(task.project!.id)}>
                  <span className="pp-project-number">Projekt {task.project.number}</span>
                  <span className="pp-project-footer" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
                    <span className="pp-project-name">{task.project.name}</span>
                    <span className="pp-chevron"><ChevronRightIcon size={20} /></span>
                  </span>
                </button>
              )}

              {me.company.phone && (
                <div className="pp-contact">
                  <span className="pp-info-text">
                    <span className="pp-info-detail">Fragen zum Auftrag?</span>
                    <span className="pp-info-title">{companyName} · {me.company.phone}</span>
                  </span>
                  <a className="pp-btn pp-btn--round" href={telHref(me.company.phone)} aria-label={`${companyName} anrufen`}>
                    <PhoneIcon size={20} />
                  </a>
                </div>
              )}
            </>
          )}
        </div>
      </main>
      {task?.can_complete && (
        <div className="pp-action-bar">
          <div className="pp-action-bar-inner">
            <button type="button" className="pp-btn pp-btn--primary" onClick={() => { setCompleteError(null); setDialogOpen(true); }}>
              <CheckIcon size={22} />
              Als erledigt melden
            </button>
            <p className="pp-action-hint">Das Büro sieht die Meldung sofort in {companyName}.</p>
          </div>
        </div>
      )}
      {dialogOpen && <CompleteDialog busy={completing} error={completeError} onConfirm={complete} onCancel={() => setDialogOpen(false)} />}
      {task && hoursFlow.sheetOpen && (
        <HoursSheet
          busy={hoursFlow.busy}
          error={hoursFlow.error}
          onSubmit={(draft) => void hoursFlow.submit({ ...draft, task_id: task.id })}
          onCancel={hoursFlow.close}
        />
      )}
    </>
  );
}
