/**
 * The "Anhänge" section before the task exists. Files are only held here —
 * there is no task id to upload against yet — and go up right after the POST
 * that mints one (App.createWeeklyPlanTask), which is why every row says so.
 * The list itself lives in the app context, so the submit in App.tsx reads
 * the same files the operator sees.
 */
import type { Language } from "../../types";
import { TaskAttachmentPicker } from "./TaskAttachmentPicker";
import { formatPickedFileSize, mergePickedFiles, pickedFileKey, withoutFileAt } from "./taskAttachmentsModel";

type Props = {
  language: Language;
  files: readonly File[];
  /** True while the task just created is receiving them. */
  uploading: boolean;
  onChange: (next: File[]) => void;
};

export function TaskPendingAttachments({ language, files, uploading, onChange }: Props) {
  const de = language === "de";
  return (
    <>
      {files.length === 0 ? (
        <div className="task-attachments-empty">{de ? "Noch keine Anhänge." : "No attachments yet."}</div>
      ) : (
        <ul className="task-attachments-pending-list">
          {files.map((file, index) => (
            <li key={pickedFileKey(file)}>
              <span className="task-attachments-pending-name" title={file.name}>
                {file.name}
                <small className="muted"> ({formatPickedFileSize(file.size)})</small>
              </span>
              <span className="task-attachments-pending-note">
                {de ? "wird nach dem Anlegen hochgeladen" : "uploaded once the task is created"}
              </span>
              <button
                type="button"
                className="task-attachments-pending-remove"
                disabled={uploading}
                aria-label={de ? `Entfernen: ${file.name}` : `Remove: ${file.name}`}
                title={de ? "Entfernen" : "Remove"}
                onClick={() => onChange(withoutFileAt(files, index))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploading && (
        <div className="task-attachments-state" role="status" aria-live="polite">
          {de ? "Anhänge werden hochgeladen…" : "Uploading attachments…"}
        </div>
      )}
      <TaskAttachmentPicker
        language={language}
        feedback={{ status: "idle" }}
        disabled={uploading}
        onPick={(picked) => onChange(mergePickedFiles(files, picked))}
      />
    </>
  );
}
