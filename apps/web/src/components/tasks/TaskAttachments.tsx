/**
 * "Anhänge" in the task modals: the plan or the photo the office attaches so
 * the person the task is assigned to knows what to do — and can open it on
 * the task, on the phone too.
 *
 * Two lives, one section. For a task that exists the files are read from
 * GET /tasks/{id}/files, shown as tiles, opened in the click-through viewer,
 * and added or removed against the api — re-reading the list after every
 * change rather than patching it, because the server decides order and
 * counts. Before the task exists (the create modal) the same section only
 * collects files; App.createWeeklyPlanTask uploads them once the POST has
 * minted an id.
 *
 * The list never goes blank on a reload: the tiles stay while the fresh list
 * is fetched, and a failed fetch says so under them with a way to try again.
 */
import { useEffect, useState } from "react";
import type { UploadProgress } from "../../api/client";
import { useAppContext } from "../../context/AppContext";
import type { StoredFile } from "../../types";
import { FileLightbox, type LightboxFile } from "../files/FileLightbox";
import { TaskAttachmentPicker, type UploadFeedback } from "./TaskAttachmentPicker";
import { TaskAttachmentTile } from "./TaskAttachmentTile";
import { TaskPendingAttachments } from "./TaskPendingAttachments";
import { deleteTaskAttachment, loadTaskAttachments, uploadTaskAttachments } from "./taskAttachmentsApi";
import { attachmentsAddedNotice, canRemoveTaskAttachment } from "./taskAttachmentsModel";
import "../../styles/tasks.css";

type StoredProps = {
  taskId: number;
  /** Named under the file in the viewer: "Aufgabe: <title>". */
  taskTitle: string;
  /** Whether the add controls show — whoever may edit the task (tasks:manage or assigned). */
  canAdd: boolean;
};

type PendingProps = {
  pendingFiles: readonly File[];
  onPendingFilesChange: (next: File[]) => void;
  /** True while the task just created is receiving the files. */
  uploading: boolean;
};

export type TaskAttachmentsProps = StoredProps | PendingProps;

export function TaskAttachments(props: TaskAttachmentsProps) {
  const { language } = useAppContext();
  const de = language === "de";
  return (
    <section className="task-modal-section task-modal-section--stack task-attachments">
      <div className="task-modal-section-head">
        <span className="task-modal-section-label">{de ? "ANHÄNGE" : "ATTACHMENTS"}</span>
        <span className="task-modal-section-hint">
          {de
            ? "Plan oder Foto für die Person, die die Aufgabe ausführt"
            : "Plan or photo for the person doing the task"}
        </span>
      </div>
      {"taskId" in props ? (
        // Keyed by task: a modal that swaps tasks without unmounting must not
        // carry one task's tiles, open viewer or failed selection into the next.
        <StoredAttachments key={props.taskId} {...props} />
      ) : (
        <TaskPendingAttachments
          language={language}
          files={props.pendingFiles}
          uploading={props.uploading}
          onChange={props.onPendingFilesChange}
        />
      )}
    </section>
  );
}

type RemoveOutcome = "removed" | "cancelled" | "failed";

/** The bar's reading of an upload event, as the project upload dialog reads it. */
function busyFeedback(progress: UploadProgress): UploadFeedback {
  if (progress.percent == null) {
    // No total: show movement rather than a number that cannot be computed.
    return { status: "busy", percent: progress.loaded > 0 ? 1 : 0, phase: "uploading" };
  }
  // The bytes are gone but the request is not done: the server still has to
  // encrypt and store every file. "Processing" beats a bar stuck at 100%.
  return { status: "busy", percent: progress.percent, phase: progress.percent >= 100 ? "processing" : "uploading" };
}

function StoredAttachments({ taskId, taskTitle, canAdd }: StoredProps) {
  const { language, token, user, canManageFiles, setError, setNotice } = useAppContext();
  const de = language === "de";
  // null until the first answer: "loading" and "no files" must not look alike.
  const [files, setFiles] = useState<StoredFile[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // Bumped to re-read the list; the effect below keys on it.
  const [loadTicket, setLoadTicket] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<UploadFeedback>({ status: "idle" });
  // The selection a failed upload keeps, so "Erneut versuchen" is one tap.
  const [heldFiles, setHeldFiles] = useState<File[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    loadTaskAttachments(taskId, token)
      .then((rows) => {
        if (!cancelled) setFiles(rows);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, token, loadTicket]);

  function reload() {
    setLoadTicket((ticket) => ticket + 1);
  }

  async function upload(picked: File[]) {
    if (picked.length === 0) return;
    setFeedback({ status: "busy", percent: 0, phase: "uploading" });
    try {
      await uploadTaskAttachments(taskId, token, picked, (progress) => setFeedback(busyFeedback(progress)));
      setHeldFiles([]);
      setFeedback({ status: "idle" });
      setNotice(attachmentsAddedNotice(picked.length, language));
      reload();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Next to the picker AND in the corner: the toast is easy to miss while
      // looking at a modal, and the selection survives for the retry.
      setHeldFiles(picked);
      setFeedback({ status: "failed", message });
      setError(message);
    }
  }

  async function remove(file: StoredFile): Promise<RemoveOutcome> {
    const confirmed = window.confirm(
      de ? `Anhang „${file.file_name}“ entfernen?` : `Remove attachment “${file.file_name}”?`,
    );
    if (!confirmed) return "cancelled";
    try {
      await deleteTaskAttachment(file.id, token);
      setNotice(de ? "Anhang entfernt" : "Attachment removed");
      reload();
      return "removed";
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      return "failed";
    }
  }

  function canRemove(file: StoredFile): boolean {
    return canRemoveTaskAttachment(file, { canManageFiles, userId: user?.id ?? null });
  }

  function discardHeld() {
    setHeldFiles([]);
    setFeedback({ status: "idle" });
  }

  const rows = files ?? [];
  // Derived, not stored: a removal shrinks the list under the viewer, and the
  // viewer has to land on a neighbour — or close when nothing is left.
  const viewerIndex = openIndex != null && rows.length > 0 ? Math.min(openIndex, rows.length - 1) : null;
  const viewerCurrent = viewerIndex != null ? rows[viewerIndex] : undefined;
  const viewerFiles: LightboxFile[] = rows.map((file) => ({
    id: file.id,
    file_name: file.file_name,
    content_type: file.content_type,
    subtitle: `${de ? "Aufgabe" : "Task"}: ${taskTitle}`,
  }));

  async function removeFromViewer(target: LightboxFile) {
    const row = rows.find((file) => file.id === target.id);
    if (!row) return;
    // The viewer shows its own "Löschen fehlgeschlagen." on a throw; a
    // cancelled confirm is not a failure and must not be reported as one.
    if ((await remove(row)) === "failed") throw new Error("delete failed");
  }

  return (
    <>
      {files === null && !loadFailed && (
        <div className="task-attachments-state" role="status">
          {de ? "Anhänge werden geladen…" : "Loading attachments…"}
        </div>
      )}
      {files !== null && rows.length === 0 && !loadFailed && (
        <div className="task-attachments-empty">{de ? "Noch keine Anhänge." : "No attachments yet."}</div>
      )}
      {rows.length > 0 && (
        <ul className="task-attachments-grid">
          {rows.map((file, index) => (
            <TaskAttachmentTile
              key={file.id}
              file={file}
              language={language}
              canRemove={canRemove(file)}
              onOpen={() => setOpenIndex(index)}
              onRemove={() => void remove(file)}
            />
          ))}
        </ul>
      )}
      {loadFailed && (
        <div className="task-attachments-state task-attachments-state--error" role="alert">
          <span>{de ? "Anhänge konnten nicht geladen werden." : "Attachments could not be loaded."}</span>
          <button type="button" className="task-modal-section-action" onClick={reload}>
            {de ? "Erneut laden" : "Reload"}
          </button>
        </div>
      )}
      {canAdd && (
        <TaskAttachmentPicker
          language={language}
          feedback={feedback}
          onPick={(picked) => void upload(picked)}
          onRetry={heldFiles.length > 0 ? () => void upload(heldFiles) : undefined}
          onDiscard={heldFiles.length > 0 ? discardHeld : undefined}
        />
      )}
      {viewerIndex != null && viewerCurrent && (
        <FileLightbox
          files={viewerFiles}
          index={viewerIndex}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          onDelete={canRemove(viewerCurrent) ? removeFromViewer : undefined}
          language={language}
        />
      )}
    </>
  );
}
