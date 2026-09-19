/**
 * The upload dialog, without a scope: target folder, an optional new folder,
 * a drop zone that is also the file picker, the selection, progress and the
 * error. The project modal binds it to the app context; the customer card
 * binds it to its own hook. Neither knows the other exists.
 *
 * Selection is controlled state so the list in the dialog always matches
 * what will be uploaded, and so files dropped on the browser outside can
 * arrive through `pendingFiles`. Submit hands the host the files and the
 * folder — and the form event, because the project path builds its request
 * from the form's FormData and needs the hidden input to carry the files.
 */
import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";

import type { Language, ProjectFolder } from "../../types";

export type UploadPhase = "uploading" | "processing" | null;

export type UploadFilesDialogProps = {
  open: boolean;
  folders: readonly ProjectFolder[];
  selectedFolder: string;
  onFolderChange: (folder: string) => void;
  newFolderPath: string;
  onNewFolderPathChange: (path: string) => void;
  onCreateFolder: () => void;
  /** Files queued from outside (a drop on the browser); consumed on open. */
  pendingFiles: readonly File[];
  busy: boolean;
  percent: number | null;
  phase: UploadPhase;
  error: string;
  /** `folder` is the new folder path when one is typed, else the selection. */
  onSubmit: (files: File[], folder: string, event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  canUseProtectedFolders: boolean;
  language: Language;
};

function dedupe(files: readonly File[]): File[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function UploadFilesDialog({
  open,
  folders,
  selectedFolder,
  onFolderChange,
  newFolderPath,
  onNewFolderPathChange,
  onCreateFolder,
  pendingFiles,
  busy,
  percent,
  phase,
  error,
  onSubmit,
  onClose,
  canUseProtectedFolders,
  language,
}: UploadFilesDialogProps) {
  const de = language === "de";
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Files queued outside join the selection when the dialog opens. Appended
  // and deduplicated rather than assigned, so a host that hands the same
  // queue over twice cannot double the list.
  useEffect(() => {
    if (!open || pendingFiles.length === 0) return;
    setSelectedFiles((current) => dedupe([...current, ...pendingFiles]));
  }, [open, pendingFiles]);

  // A closed dialog forgets its selection, so the next open starts clean.
  useEffect(() => {
    if (open) return;
    setSelectedFiles([]);
    setIsDragging(false);
  }, [open]);

  if (!open) return null;

  function appendFiles(more: File[]) {
    if (more.length === 0) return;
    setSelectedFiles((current) => dedupe([...current, ...more]));
  }

  function removeFile(index: number) {
    setSelectedFiles((current) => current.filter((_, i) => i !== index));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedFiles.length === 0 || busy) return;
    // The hidden input mirrors the controlled selection at submit time, so a
    // host that serialises the form gets the files that are on screen. Some
    // engines lack the DataTransfer constructor; those hosts receive the
    // files as the first argument anyway.
    try {
      const transfer = new DataTransfer();
      selectedFiles.forEach((file) => transfer.items.add(file));
      if (inputRef.current) inputRef.current.files = transfer.files;
    } catch {
      // No DataTransfer here; the files travel as the argument.
    }
    const folder = newFolderPath.trim() || selectedFolder;
    onSubmit(selectedFiles, folder, event);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    appendFiles(Array.from(event.dataTransfer.files || []));
  }

  const submitLabel = busy
    ? de
      ? "Wird hochgeladen…"
      : "Uploading…"
    : selectedFiles.length > 1
      ? de
        ? `Hochladen (${selectedFiles.length})`
        : `Upload (${selectedFiles.length})`
      : de
        ? "Hochladen"
        : "Upload";

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        // Not while bytes are moving: closing hides the only progress there
        // is, and the request carries on regardless.
        if (!busy) onClose();
      }}
    >
      <div
        className="card modal-card modal-card-sm"
        role="dialog"
        aria-modal="true"
        aria-label={de ? "Dateien hochladen" : "Upload files"}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{de ? "Dateien hochladen" : "Upload files"}</h3>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label>
            {de ? "Zielordner" : "Target folder"}
            <select value={selectedFolder} onChange={(event) => onFolderChange(event.target.value)}>
              <option value="/">{de ? "Hauptordner (/)" : "Base folder (/)"}</option>
              {folders
                .filter((folder) => canUseProtectedFolders || !folder.is_protected)
                .map((folder) => (
                  <option key={folder.path} value={folder.path}>
                    {folder.path}
                  </option>
                ))}
            </select>
          </label>
          <div className="row wrap">
            <input
              value={newFolderPath}
              onChange={(event) => onNewFolderPathChange(event.target.value)}
              placeholder={
                de
                  ? "Neuer Ordnerpfad (optional, z.B. Bilder/Tag2)"
                  : "New folder path (optional, e.g. Bilder/Tag2)"
              }
            />
            <button type="button" onClick={onCreateFolder}>
              {de ? "Ordner anlegen" : "Create folder"}
            </button>
          </div>
          <small className="muted">
            {de
              ? "Wenn ein neuer Ordnerpfad gesetzt ist, wird er beim Upload automatisch erstellt und genutzt."
              : "If a new folder path is set, upload auto-creates it and uploads there."}
          </small>

          {/* The drop zone is also the file picker: clicking it opens the
              hidden input, dropping appends. */}
          <div
            className={`file-upload-dropzone${isDragging ? " file-upload-dropzone--drag" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(event) => {
              // Don't flicker off when moving between child elements.
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setIsDragging(false);
            }}
            onDrop={handleDrop}
            onClick={() => inputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                inputRef.current?.click();
              }
            }}
          >
            <strong>{de ? "Dateien hier ablegen" : "Drop files here"}</strong>
            <small className="muted">{de ? "oder klicken zum Auswählen" : "or click to select"}</small>
            <input
              ref={inputRef}
              type="file"
              name="files"
              multiple
              style={{ display: "none" }}
              aria-label={de ? "Dateien auswählen" : "Choose files"}
              onChange={(event) => {
                appendFiles(Array.from(event.target.files || []));
                // Reset so picking the same file again still fires onChange.
                event.target.value = "";
              }}
            />
          </div>

          {selectedFiles.length > 0 && (
            <ul className="file-upload-list">
              {selectedFiles.map((file, index) => (
                <li key={`${file.name}|${file.size}|${file.lastModified}|${index}`}>
                  <span>
                    {file.name}
                    <small className="muted"> ({Math.round(file.size / 1024)} KB)</small>
                  </span>
                  <button
                    type="button"
                    className="file-upload-list-remove"
                    aria-label={de ? "Entfernen" : "Remove"}
                    onClick={() => removeFile(index)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Twelve photos take a while; a still dialog reads as a missed
              click and people uploaded everything again. */}
          {busy && (
            <div className="file-upload-progress" role="status" aria-live="polite">
              <div className="file-upload-progress-bar">
                <div
                  className={`file-upload-progress-fill${phase === "processing" ? " is-processing" : ""}`}
                  style={{ width: `${percent ?? 0}%` }}
                />
              </div>
              <small className="muted">
                {phase === "processing"
                  ? de
                    ? "Dateien werden gespeichert…"
                    : "Saving files…"
                  : de
                    ? `Hochladen… ${percent ?? 0}%`
                    : `Uploading… ${percent ?? 0}%`}
              </small>
            </div>
          )}

          {/* In the dialog, and the dialog stays open, so the selection
              survives and a retry does not mean picking the files again. */}
          {error && !busy && (
            <p className="file-upload-error" role="alert">
              {error}
            </p>
          )}

          <div className="row wrap">
            <button type="submit" disabled={selectedFiles.length === 0 || busy}>
              {submitLabel}
            </button>
            <button type="button" disabled={busy} onClick={onClose}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
