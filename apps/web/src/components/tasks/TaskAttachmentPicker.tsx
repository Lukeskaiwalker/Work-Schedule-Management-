/**
 * "Datei hinzufügen" for the task modals: a button over a hidden file input,
 * inside a drop zone. The button is the control — on a phone it is what
 * offers the camera — and the drop zone is the desktop's shortcut, whose hint
 * only shows where a pointer can drag (tasks.css hides it on touch).
 *
 * No `accept`: the plan is a PDF, the photo a JPEG, the note whatever the
 * office had at hand, and phones offer the camera by themselves.
 *
 * Feedback lives with the picker because it is about the pick: the bar while
 * bytes move, and — after a failure — the message next to "Erneut versuchen",
 * so a retry does not mean finding the photo again.
 */
import { useRef, useState } from "react";
import type { DragEvent } from "react";
import type { Language } from "../../types";

export type UploadFeedback =
  | { status: "idle" }
  | { status: "busy"; percent: number | null; phase: "uploading" | "processing" }
  | { status: "failed"; message: string };

type Props = {
  language: Language;
  feedback: UploadFeedback;
  /** Nothing can be picked right now (the created task is still receiving files). */
  disabled?: boolean;
  onPick: (files: File[]) => void;
  /** Offered while a failed selection is being kept for another try. */
  onRetry?: () => void;
  onDiscard?: () => void;
};

export function TaskAttachmentPicker({ language, feedback, disabled = false, onPick, onRetry, onDiscard }: Props) {
  const de = language === "de";
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const blocked = disabled || feedback.status === "busy";

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    // Without this the browser navigates to the dropped file.
    event.preventDefault();
    setDragging(false);
    if (blocked) return;
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length > 0) onPick(dropped);
  }

  return (
    <div className="task-attachments-picker">
      <div
        className={`task-attachments-add${dragging ? " task-attachments-add--drag" : ""}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (!blocked) setDragging(true);
        }}
        onDragLeave={(event) => {
          // Not when the pointer merely moves between the zone's own children.
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={handleDrop}
      >
        <button
          type="button"
          className="task-attachments-add-btn"
          disabled={blocked}
          onClick={() => inputRef.current?.click()}
        >
          + {de ? "Datei hinzufügen" : "Add file"}
        </button>
        <span className="task-attachments-add-hint">
          {de ? "oder Dateien hierher ziehen" : "or drop files here"}
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          aria-label={de ? "Dateien auswählen" : "Choose files"}
          onChange={(event) => {
            const picked = Array.from(event.target.files ?? []);
            // Reset so picking the same file again still fires onChange.
            event.target.value = "";
            if (picked.length > 0) onPick(picked);
          }}
        />
      </div>

      {feedback.status === "busy" && (
        <div className="file-upload-progress" role="status" aria-live="polite">
          <div className="file-upload-progress-bar">
            <div
              className={`file-upload-progress-fill${feedback.phase === "processing" ? " is-processing" : ""}`}
              style={{ width: `${feedback.percent ?? 0}%` }}
            />
          </div>
          <small className="muted">
            {feedback.phase === "processing"
              ? de
                ? "Dateien werden gespeichert…"
                : "Saving files…"
              : de
                ? `Hochladen… ${feedback.percent ?? 0}%`
                : `Uploading… ${feedback.percent ?? 0}%`}
          </small>
        </div>
      )}

      {feedback.status === "failed" && (
        <div className="task-attachments-retry">
          <p className="file-upload-error" role="alert">
            {feedback.message}
          </p>
          {onRetry && (
            <button type="button" className="task-modal-section-action" onClick={onRetry}>
              {de ? "Erneut versuchen" : "Try again"}
            </button>
          )}
          {onDiscard && (
            <button type="button" className="task-modal-section-action" onClick={onDiscard}>
              {de ? "Auswahl verwerfen" : "Discard selection"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
