/**
 * "Anhänge" on a task the crew reads but cannot edit: the plan or the photo
 * the office attached, as tiles that open in the click-through viewer.
 *
 * The modal's section (TaskAttachments) adds and removes; this strip only
 * shows. It sits in the expanded row of Meine Aufgaben, where the person
 * doing the task looks — the edit modal is closed to anyone without
 * tasks:manage, and until this strip existed the files were reachable
 * nowhere else.
 *
 * Loads only where there is something to load: a task's `attachment_count`
 * travels with every list, so a task with none renders nothing — no request,
 * no empty block. What was loaded once is kept per task and count, because
 * the rows are an accordion and folding one open again must not re-read the
 * server; a count that moved (a file added in the modal) reads afresh.
 */
import { useEffect, useState } from "react";
import { useAppContext } from "../../context/AppContext";
import type { Language, StoredFile, Task } from "../../types";
import { FileLightbox, type LightboxFile } from "../files/FileLightbox";
import { TaskAttachmentTile } from "./TaskAttachmentTile";
import { loadTaskAttachments } from "./taskAttachmentsApi";
import "../../styles/tasks.css";

type Props = {
  task: Pick<Task, "id" | "title" | "attachment_count">;
};

/* ── The memory between one expansion and the next ─────────────────────── */

// Keyed by task AND count: the count is the only signal the list has that the
// files changed, so a stale entry is simply never asked for again.
const loadedByKey = new Map<string, readonly StoredFile[]>();

function stripCacheKey(taskId: number, attachmentCount: number): string {
  return `${taskId}:${attachmentCount}`;
}

function recallAttachments(key: string): readonly StoredFile[] | null {
  return loadedByKey.get(key) ?? null;
}

function rememberAttachments(key: string, rows: readonly StoredFile[]): void {
  loadedByKey.set(key, rows);
}

/** Tests only: every case starts with an empty memory. */
export function resetTaskAttachmentStripCache(): void {
  loadedByKey.clear();
}

/* ── The strip ─────────────────────────────────────────────────────────── */

export function TaskAttachmentStrip({ task }: Props) {
  const { language, token } = useAppContext();
  const attachmentCount = task.attachment_count ?? 0;
  // The count decides before any state exists: the hooks live in the loaded
  // strip, which is keyed on task and count so a moved count starts over.
  if (attachmentCount === 0) return null;
  const cacheKey = stripCacheKey(task.id, attachmentCount);
  return (
    <LoadedStrip key={cacheKey} taskId={task.id} taskTitle={task.title} cacheKey={cacheKey} language={language} token={token} />
  );
}

type LoadedProps = {
  taskId: number;
  /** Named under the file in the viewer: "Aufgabe: <title>". */
  taskTitle: string;
  cacheKey: string;
  language: Language;
  token: string | null;
};

// The tile insists on a remove handler; here nobody may remove, so it is
// never rendered and this is never called.
const NEVER_REMOVE = () => undefined;

function LoadedStrip({ taskId, taskTitle, cacheKey, language, token }: LoadedProps) {
  const de = language === "de";
  // null until the first answer: "loading" and "no files" must not look alike.
  const [files, setFiles] = useState<readonly StoredFile[] | null>(() => recallAttachments(cacheKey));
  const [loadFailed, setLoadFailed] = useState(false);
  // Bumped by "Erneut laden"; the effect below keys on it.
  const [loadTicket, setLoadTicket] = useState(0);
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  useEffect(() => {
    // Remembered from an earlier expansion: nothing to fetch.
    if (recallAttachments(cacheKey)) return;
    let cancelled = false;
    setLoadFailed(false);
    loadTaskAttachments(taskId, token)
      .then((rows) => {
        if (cancelled) return;
        rememberAttachments(cacheKey, rows);
        setFiles(rows);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, token, cacheKey, loadTicket]);

  function reload() {
    setLoadTicket((ticket) => ticket + 1);
  }

  const rows = files ?? [];
  const loading = files === null && !loadFailed;
  // The count promised files and the server has none: the count was stale.
  // No block at all, as for a task that never had any.
  if (files !== null && rows.length === 0) return null;

  const viewerFiles: LightboxFile[] = rows.map((file) => ({
    id: file.id,
    file_name: file.file_name,
    content_type: file.content_type,
    subtitle: `${de ? "Aufgabe" : "Task"}: ${taskTitle}`,
  }));
  return (
    <div className="task-attachment-strip">
      <div className="task-attachment-strip-head">
        <span className="task-attachment-strip-label">{de ? "Anhänge" : "Attachments"}</span>
        <span className="task-attachment-strip-hint">
          {de ? "Plan oder Foto zu dieser Aufgabe" : "Plan or photo for this task"}
        </span>
      </div>
      {loading && (
        <div className="task-attachments-state" role="status">
          {de ? "Anhänge werden geladen…" : "Loading attachments…"}
        </div>
      )}
      {rows.length > 0 && (
        <ul className="task-attachments-grid">
          {rows.map((file, index) => (
            <TaskAttachmentTile
              key={file.id}
              file={file}
              language={language}
              canRemove={false}
              onOpen={() => setOpenIndex(index)}
              onRemove={NEVER_REMOVE}
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
      {openIndex != null && openIndex < rows.length && (
        <FileLightbox
          files={viewerFiles}
          index={openIndex}
          onIndexChange={setOpenIndex}
          onClose={() => setOpenIndex(null)}
          language={language}
        />
      )}
    </div>
  );
}
