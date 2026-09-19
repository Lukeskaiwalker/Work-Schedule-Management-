/**
 * The file browser shell: toolbar (view toggle, S/M/L, search, upload, and
 * whatever the host adds — the WebDAV help), a drop target for uploads, and
 * the rows below. Scope-agnostic: it knows files, not whose they are, so the
 * project tab and the customer card render the same rows and tiles.
 *
 * `children` go between the toolbar and the host's own rows; the customer
 * card puts its project folders there. They may render FileBrowserFiles of
 * their own and follow the same view settings through the context.
 */
import { useState, type DragEvent, type ReactNode } from "react";

import { FileBrowserViewContext } from "./fileBrowserContext";
import { FileBrowserFiles } from "./FileBrowserFiles";
import { FileViewModeToggle, GallerySizeToggle } from "./FileViewToggle";
import { useFileViewPrefs, type FileViewStorageKeys } from "./useFileViewPrefs";
import type { Language, StoredFile } from "../../types";
import "../../styles/files.css";

export type FileBrowserStatus =
  | { kind: "ready" }
  | { kind: "loading"; text: string }
  | { kind: "error"; text: string; detail?: string; onRetry: () => void };

export type FileBrowserProps = {
  rows: readonly StoredFile[];
  query: string;
  onQueryChange: (query: string) => void;
  /** Where the view choice and tile size are remembered; one pair per host. */
  storageKeys: FileViewStorageKeys;
  language: Language;
  title: ReactNode;
  className?: string;
  /** Extra toolbar content, after the upload button. */
  headerExtra?: ReactNode;
  /** The clicked file and everything on screen with it, in display order. */
  onOpen: (file: StoredFile, sequence: StoredFile[]) => void;
  /** Present only when the host may delete. */
  onDelete?: (file: StoredFile) => void;
  /** The ↑ button; absent, the button is not rendered. */
  onUpload?: () => void;
  /** Files dropped on the card; absent, drops are ignored. */
  onDropFiles?: (files: File[]) => void;
  emptyText?: string;
  noMatchText?: string;
  /** Replaces the body while loading or after a failed load. */
  status?: FileBrowserStatus;
  children?: ReactNode;
};

/** Only a drag that carries files counts — text or links dragged across the page must not flicker the highlight. */
function isFileDrag(event: DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

export function FileBrowser({
  rows,
  query,
  onQueryChange,
  storageKeys,
  language,
  title,
  className,
  headerExtra,
  onOpen,
  onDelete,
  onUpload,
  onDropFiles,
  emptyText,
  noMatchText,
  status = { kind: "ready" },
  children,
}: FileBrowserProps) {
  const de = language === "de";
  const { viewMode, setViewMode, gallerySize, setGallerySize } = useFileViewPrefs(storageKeys);
  const [dragHover, setDragHover] = useState(false);

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!onDropFiles || !isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragHover) setDragHover(true);
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragHover(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!onDropFiles || !isFileDrag(event)) return;
    event.preventDefault();
    setDragHover(false);
    const dropped = Array.from(event.dataTransfer.files || []);
    if (dropped.length > 0) onDropFiles(dropped);
  }

  const classes = ["card", "file-browser", className, dragHover ? "card--file-drop-active" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <FileBrowserViewContext.Provider value={{ viewMode, gallerySize, language, query }}>
      <div
        className={classes}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragHover && (
          <div className="file-drop-overlay" aria-hidden="true">
            <strong>{de ? "Dateien hier ablegen zum Hochladen" : "Drop files here to upload"}</strong>
          </div>
        )}
        <div className="file-explorer-head">
          <h3 className="file-browser-title">{title}</h3>
          <div className="row wrap file-explorer-controls">
            <FileViewModeToggle value={viewMode} onChange={setViewMode} language={language} />
            {viewMode === "gallery" && (
              <GallerySizeToggle value={gallerySize} onChange={setGallerySize} language={language} />
            )}
            <input
              className="file-explorer-search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={de ? "Datei suchen" : "Search file"}
              aria-label={de ? "Datei suchen" : "Search file"}
            />
            {onUpload && (
              <button
                type="button"
                className="icon-btn upload-arrow-btn"
                aria-label={de ? "Datei hochladen" : "Upload file"}
                title={de ? "Datei hochladen" : "Upload file"}
                onClick={onUpload}
              >
                ↑
              </button>
            )}
            {headerExtra}
          </div>
        </div>

        {status.kind === "loading" ? (
          <div className="file-browser-status" role="status" aria-live="polite">
            <small className="muted">{status.text}</small>
          </div>
        ) : status.kind === "error" ? (
          <div className="file-browser-status file-browser-status--error" role="alert">
            <span>{status.text}</span>
            {status.detail && <small className="muted">{status.detail}</small>}
            <button type="button" className="linklike" onClick={status.onRetry}>
              {de ? "Erneut versuchen" : "Try again"}
            </button>
          </div>
        ) : (
          <>
            {children}
            <FileBrowserFiles
              rows={rows}
              onOpen={onOpen}
              onDelete={onDelete}
              emptyText={emptyText ?? (de ? "Keine Dateien vorhanden" : "No files yet")}
              noMatchText={noMatchText}
            />
          </>
        )}
      </div>
    </FileBrowserViewContext.Provider>
  );
}
