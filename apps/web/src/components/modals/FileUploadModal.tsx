import { useEffect, useRef, useState } from "react";
import { useAppContext } from "../../context/AppContext";

/**
 * v2.5.22 rewrite of the project-files upload modal.
 *
 * Previous version used an uncontrolled ``<input type="file">`` + form
 * FormData submission and only handled a single file. The new version:
 *
 *   1. **Controlled selection state** so the file list shown in the modal
 *      always matches what will be uploaded — and so drag-dropped files
 *      can populate the modal from outside.
 *   2. **Multi-file selection** — both via the native file picker
 *      (multiple attribute) and via drop. Matches the new backend, which
 *      accepts list[UploadFile] and creates one Attachment per file.
 *   3. **Drag-and-drop area inside the modal**: drop more files at any
 *      time before submitting.
 *   4. **Pre-fill from the project files tab**: when the operator drops
 *      files onto the project files browser, AppContext.requestFileUploadWithFiles
 *      sets ``fileUploadPendingFiles`` + opens the modal. The modal reads
 *      that on open, pre-populates its state, and clears the context value.
 */
export function FileUploadModal() {
  const {
    language,
    fileUploadModalOpen,
    mainView,
    activeProject,
    projectTab,
    fileUploadFolder,
    setFileUploadFolder,
    projectFolders,
    newProjectFolderPath,
    setNewProjectFolderPath,
    canUseProtectedFolders,
    setFileUploadModalOpen,
    uploadFile,
    createProjectFolderFromInput,
    fileUploadPendingFiles,
    setFileUploadPendingFiles,
  } = useAppContext();

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // When the modal opens, hydrate the local state from any pending files
  // queued by the drop-target outside the modal (the ProjectFilesTab drop
  // handler). Then immediately clear the queue so a later normal click-
  // through doesn't accidentally re-inherit the old files.
  useEffect(() => {
    if (!fileUploadModalOpen) return;
    if (fileUploadPendingFiles.length > 0) {
      setSelectedFiles(fileUploadPendingFiles);
      setFileUploadPendingFiles([]);
    }
  }, [fileUploadModalOpen, fileUploadPendingFiles, setFileUploadPendingFiles]);

  // When the modal closes, reset local state so the next open is clean.
  useEffect(() => {
    if (!fileUploadModalOpen) {
      setSelectedFiles([]);
      setIsDragging(false);
    }
  }, [fileUploadModalOpen]);

  if (!fileUploadModalOpen || mainView !== "project" || !activeProject || projectTab !== "files") return null;

  const de = language === "de";

  function dedupe(files: File[]): File[] {
    const seen = new Set<string>();
    const result: File[] = [];
    for (const f of files) {
      const key = `${f.name}|${f.size}|${f.lastModified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(f);
    }
    return result;
  }

  function appendFiles(more: File[]) {
    if (!more.length) return;
    setSelectedFiles((current) => dedupe([...current, ...more]));
  }

  function removeFile(index: number) {
    setSelectedFiles((current) => current.filter((_, i) => i !== index));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedFiles.length === 0) return;
    // uploadFile reads the FormData from the event target. Make sure the
    // hidden file input reflects the controlled state at submit time —
    // for some browsers, programmatically-added files via DataTransfer
    // don't survive form serialisation, so we build the FormData manually
    // here and pass via a fake event-like shim. But easier: synchronise
    // the input's files via DataTransfer right before submit.
    const dt = new DataTransfer();
    selectedFiles.forEach((f) => dt.items.add(f));
    if (inputRef.current) {
      inputRef.current.files = dt.files;
    }
    void uploadFile(event);
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
    const dropped = Array.from(event.dataTransfer.files || []);
    appendFiles(dropped);
  }

  return (
    <div className="modal-backdrop" onClick={() => setFileUploadModalOpen(false)}>
      <div className="card modal-card modal-card-sm" onClick={(event) => event.stopPropagation()}>
        <h3>{de ? "Dateien hochladen" : "Upload files"}</h3>
        <form className="modal-form" onSubmit={handleSubmit}>
          <label>
            {de ? "Zielordner" : "Target folder"}
            <select value={fileUploadFolder} onChange={(event) => setFileUploadFolder(event.target.value)}>
              <option value="/">{de ? "Hauptordner (/)" : "Base folder (/)"}</option>
              {projectFolders
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
              value={newProjectFolderPath}
              onChange={(event) => setNewProjectFolderPath(event.target.value)}
              placeholder={
                de
                  ? "Neuer Ordnerpfad (optional, z.B. Bilder/Tag2)"
                  : "New folder path (optional, e.g. Bilder/Tag2)"
              }
            />
            <button type="button" onClick={() => void createProjectFolderFromInput()}>
              {de ? "Ordner anlegen" : "Create folder"}
            </button>
          </div>
          <small className="muted">
            {de
              ? "Wenn ein neuer Ordnerpfad gesetzt ist, wird er beim Upload automatisch erstellt und genutzt."
              : "If a new folder path is set, upload auto-creates it and uploads there."}
          </small>

          {/* v2.5.22: drag-and-drop zone wraps the file picker. Clicking the
              zone triggers the hidden input; dropping files appends them. */}
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
            <small className="muted">
              {de ? "oder klicken zum Auswählen" : "or click to select"}
            </small>
            <input
              ref={inputRef}
              type="file"
              name="files"
              multiple
              style={{ display: "none" }}
              onChange={(event) => {
                const picked = Array.from(event.target.files || []);
                appendFiles(picked);
                // Reset so picking the same file again still fires onChange.
                event.target.value = "";
              }}
            />
          </div>

          {selectedFiles.length > 0 ? (
            <ul className="file-upload-list">
              {selectedFiles.map((f, idx) => (
                <li key={`${f.name}|${f.size}|${f.lastModified}|${idx}`}>
                  <span>
                    {f.name}
                    <small className="muted"> ({Math.round(f.size / 1024)} KB)</small>
                  </span>
                  <button
                    type="button"
                    className="file-upload-list-remove"
                    aria-label={de ? "Entfernen" : "Remove"}
                    onClick={() => removeFile(idx)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="row wrap">
            <button type="submit" disabled={selectedFiles.length === 0}>
              {de
                ? selectedFiles.length > 1
                  ? `Hochladen (${selectedFiles.length})`
                  : "Hochladen"
                : selectedFiles.length > 1
                  ? `Upload (${selectedFiles.length})`
                  : "Upload"}
            </button>
            <button type="button" onClick={() => setFileUploadModalOpen(false)}>
              {de ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
