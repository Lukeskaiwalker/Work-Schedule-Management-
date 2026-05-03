import { useState, useMemo, useEffect } from "react";
import { useAppContext } from "../../context/AppContext";
import { formatServerDateTime } from "../../utils/dates";
import type { Language, ProjectFile } from "../../types";

// View-mode persistence keeps the user's preference across sessions
// without needing a backend round-trip — folders stay organised in
// the list view, but operators who use this tab to scan project
// photos shouldn't have to flip the toggle every visit.
const VIEW_MODE_STORAGE_KEY = "smpl_project_files_view_mode";
type FilesViewMode = "list" | "gallery";

function readStoredViewMode(): FilesViewMode {
  if (typeof window === "undefined") return "list";
  try {
    const raw = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return raw === "gallery" ? "gallery" : "list";
  } catch {
    return "list";
  }
}

function isReportFolder(folder: string): boolean {
  const f = folder.toLowerCase();
  return f.includes("bericht") || f.includes("report");
}

function fileTypeLabel(contentType: string): string {
  if (contentType.startsWith("image/")) return contentType.replace("image/", "");
  if (contentType === "application/pdf") return "PDF";
  if (contentType.startsWith("text/")) return contentType.replace("text/", "");
  return contentType;
}

function isImageFile(file: ProjectFile): boolean {
  return (file.content_type ?? "").toLowerCase().startsWith("image/");
}

/** Map a content_type to a single emoji used as the gallery tile glyph
 *  for non-image files. Kept conservative on the type detection — we
 *  prefer "📎" for the unknown case rather than guessing wrong. */
function iconForContentType(contentType: string): string {
  const ct = (contentType ?? "").toLowerCase();
  if (ct === "application/pdf") return "📄";
  if (ct.startsWith("video/")) return "🎥";
  if (ct.startsWith("audio/")) return "🎵";
  if (ct.startsWith("text/")) return "📝";
  if (ct.includes("word") || ct.includes("document")) return "📝";
  if (ct.includes("sheet") || ct.includes("excel") || ct.includes("csv")) return "📊";
  if (ct.includes("zip") || ct.includes("archive") || ct.includes("compressed")) return "🗜️";
  if (ct.includes("presentation") || ct.includes("powerpoint")) return "📽️";
  return "📎";
}

function GalleryTile({
  file,
  isPreviewable,
  filePreviewUrl,
  fileDownloadUrl,
}: {
  file: ProjectFile;
  isPreviewable: (f: ProjectFile) => boolean;
  filePreviewUrl: (id: number) => string;
  fileDownloadUrl: (id: number) => string;
}) {
  const previewable = isPreviewable(file);
  // Click target: prefer in-browser preview when available, fall back to
  // download for files the backend won't render inline (binary types,
  // unsupported content). target="_blank" so the gallery stays open.
  const targetHref = previewable ? filePreviewUrl(file.id) : fileDownloadUrl(file.id);
  const isImage = isImageFile(file);
  return (
    <a
      href={targetHref}
      target="_blank"
      rel="noreferrer"
      className="gallery-tile"
      title={`${file.file_name} · ${file.folder || "/"}`}
    >
      {isImage ? (
        <img
          src={filePreviewUrl(file.id)}
          alt={file.file_name}
          className="gallery-tile-image"
          loading="lazy"
        />
      ) : (
        <div className="gallery-tile-icon" aria-hidden="true">
          {iconForContentType(file.content_type)}
        </div>
      )}
      <div className="gallery-tile-name">{file.file_name}</div>
      <div className="gallery-tile-folder">{file.folder || "/"}</div>
    </a>
  );
}

function FileRow({
  file,
  language,
  canManageFiles,
  isPreviewable,
  filePreviewUrl,
  fileDownloadUrl,
  onDelete,
}: {
  file: ProjectFile;
  language: Language;
  canManageFiles: boolean;
  isPreviewable: (f: ProjectFile) => boolean;
  filePreviewUrl: (id: number) => string;
  fileDownloadUrl: (id: number) => string;
  onDelete: (fileId: number) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="file-row">
      <span>{file.file_name}</span>
      <small>{file.folder || "/"}</small>
      <small>{fileTypeLabel(file.content_type)}</small>
      <small>{formatServerDateTime(file.created_at, language)}</small>
      <div className="row wrap file-row-actions">
        {isPreviewable(file) && (
          <a href={filePreviewUrl(file.id)} target="_blank" rel="noreferrer">
            {language === "de" ? "Vorschau" : "Preview"}
          </a>
        )}
        <a href={fileDownloadUrl(file.id)} target="_blank" rel="noreferrer">
          {language === "de" ? "Download" : "Download"}
        </a>
        {canManageFiles && (
          confirming ? (
            <>
              <button
                type="button"
                className="file-delete-confirm-btn"
                onClick={() => { setConfirming(false); onDelete(file.id); }}
              >
                {language === "de" ? "Löschen" : "Delete"}
              </button>
              <button
                type="button"
                className="linklike"
                onClick={() => setConfirming(false)}
              >
                {language === "de" ? "Abbrechen" : "Cancel"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="file-delete-btn linklike"
              onClick={() => setConfirming(true)}
              title={language === "de" ? "Datei löschen" : "Delete file"}
            >
              {language === "de" ? "Löschen" : "Delete"}
            </button>
          )
        )}
      </div>
    </div>
  );
}

export function ProjectFilesTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    fileRows,
    fileQuery,
    setFileQuery,
    fileUploadFolder,
    setFileUploadFolder,
    setFileUploadModalOpen,
    projectFolders,
    canUseProtectedFolders,
    canManageFiles,
    activeProjectDavUrl,
    copyToClipboard,
    fileDownloadUrl,
    filePreviewUrl,
    isPreviewable,
    deleteFile,
  } = useAppContext();

  // Single set tracks which folders have been manually toggled from their default state.
  // Report-like folders default to collapsed; others default to expanded.
  // If a folder is in toggledFolders, its visible state is flipped from the default.
  const [toggledFolders, setToggledFolders] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<FilesViewMode>(() => readStoredViewMode());

  // Persist view-mode toggles to localStorage so the user's preference
  // (list vs gallery) survives reloads. Done via useEffect rather than
  // inline-on-toggle so the read path stays a single source of truth.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch {
      // localStorage may be disabled (private mode, quota); silently
      // ignore — the toggle still works for the current session.
    }
  }, [viewMode]);

  const isSearching = fileQuery.trim().length > 0;

  const groupedFiles = useMemo<Array<[string, ProjectFile[]]> | null>(() => {
    if (isSearching) return null;
    const map = new Map<string, ProjectFile[]>();
    for (const file of fileRows) {
      const key = (file.folder ?? "").trim() || "/";
      const existing = map.get(key);
      if (existing) {
        existing.push(file);
      } else {
        map.set(key, [file]);
      }
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "/") return -1;
      if (b === "/") return 1;
      return a.localeCompare(b);
    });
  }, [fileRows, isSearching]);

  function isFolderCollapsed(folder: string): boolean {
    const defaultCollapsed = isReportFolder(folder);
    return toggledFolders.has(folder) ? !defaultCollapsed : defaultCollapsed;
  }

  function toggleFolder(folder: string) {
    setToggledFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  }

  if (mainView !== "project" || !activeProject || projectTab !== "files") return null;

  const folderLabel = (folder: string) =>
    folder === "/" ? (language === "de" ? "Hauptordner" : "Root") : folder;

  return (
    <section className="grid files-grid">
      <div className="card">
        <div className="file-explorer-head">
          <h3>{language === "de" ? "Online Datei-Explorer" : "Online file explorer"}</h3>
          <div className="row">
            <div
              className="file-view-toggle"
              role="tablist"
              aria-label={language === "de" ? "Ansicht" : "View"}
            >
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "list"}
                className={viewMode === "list" ? "is-active" : undefined}
                onClick={() => setViewMode("list")}
                title={language === "de" ? "Listenansicht" : "List view"}
              >
                {language === "de" ? "Liste" : "List"}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={viewMode === "gallery"}
                className={viewMode === "gallery" ? "is-active" : undefined}
                onClick={() => setViewMode("gallery")}
                title={language === "de" ? "Galerieansicht" : "Gallery view"}
              >
                {language === "de" ? "Galerie" : "Gallery"}
              </button>
            </div>
            <input
              value={fileQuery}
              onChange={(e) => setFileQuery(e.target.value)}
              placeholder={language === "de" ? "Datei suchen" : "Search file"}
            />
            <button
              type="button"
              className="icon-btn upload-arrow-btn"
              aria-label={language === "de" ? "Datei hochladen" : "Upload file"}
              title={language === "de" ? "Datei hochladen" : "Upload file"}
              onClick={() => {
                if (!fileUploadFolder) {
                  const fallback = projectFolders.find((folder) => canUseProtectedFolders || !folder.is_protected);
                  setFileUploadFolder(fallback?.path ?? "/");
                }
                setFileUploadModalOpen(true);
              }}
            >
              ↑
            </button>
            <div className="webdav-help">
              <button type="button" className="icon-btn" aria-label="WebDAV info">
                ⚙
              </button>
              <div className="webdav-tooltip">
                <p>
                  {language === "de"
                    ? "Dateien wie in SharePoint per WebDAV im Betriebssystem einbinden:"
                    : "SharePoint-like OS integration via WebDAV:"}
                </p>
                <small>{language === "de" ? "Alle Projekte:" : "All projects:"}</small>
                <div className="webdav-copy-row">
                  <code>{`${window.location.origin}/api/dav/projects/`}</code>
                  <button
                    type="button"
                    className="webdav-copy-btn"
                    onClick={() => void copyToClipboard(`${window.location.origin}/api/dav/projects/`, "all")}
                  >
                    {language === "de" ? "Kopieren" : "Copy"}
                  </button>
                </div>
                <small>{language === "de" ? "Nur aktuelles Projekt:" : "Current project only:"}</small>
                <div className="webdav-copy-row">
                  <code>{activeProjectDavUrl}</code>
                  <button
                    type="button"
                    className="webdav-copy-btn"
                    onClick={() => void copyToClipboard(activeProjectDavUrl, "project")}
                  >
                    {language === "de" ? "Kopieren" : "Copy"}
                  </button>
                </div>
                <small>
                  {language === "de"
                    ? "Jede berechtigte Person kann denselben Link mit eigenen App-Zugangsdaten verbinden."
                    : "Any authorized user can connect the same link with their own app credentials."}
                </small>
                <small>
                  {language === "de"
                    ? "macOS Finder: Gehe zu > Mit Server verbinden (Cmd+K). Anmeldung mit App-E-Mail + Passwort."
                    : "macOS Finder: Go > Connect to Server (Cmd+K). Sign in with app email + password."}
                </small>
                <small>
                  {language === "de"
                    ? "Wichtig: URL mit abschließendem / verwenden. Für andere Geräte im LAN: http://<SERVER-LAN-IP>/api/dav/projects/PROJEKTNUMMER/"
                    : "Important: use URL with trailing /. For other devices on LAN: http://<SERVER-LAN-IP>/api/dav/projects/PROJECT_NUMBER/"}
                </small>
                <small>
                  {language === "de"
                    ? "Wenn HTTPS-Zertifikat auf fremden Geräten fehlschlägt, LAN-HTTP nur im vertrauenswürdigen Netzwerk nutzen."
                    : "If HTTPS certificate trust fails on other devices, use LAN HTTP only on trusted networks."}
                </small>
              </div>
            </div>
          </div>
        </div>

        {viewMode === "gallery" ? (
          /* Flat contact-sheet grid — every attachment as a tile,
             images get thumbnails, others get an emoji-icon stand-in.
             Search filter still applies; folder grouping is dropped
             on purpose because the gallery's job is "see at a glance"
             not "navigate hierarchy". */
          <div className="file-gallery">
            {fileRows.map((file) => (
              <GalleryTile
                key={file.id}
                file={file}
                isPreviewable={isPreviewable}
                filePreviewUrl={filePreviewUrl}
                fileDownloadUrl={fileDownloadUrl}
              />
            ))}
            {fileRows.length === 0 && (
              <small className="muted">
                {isSearching
                  ? (language === "de" ? "Keine Treffer" : "No files found")
                  : (language === "de" ? "Keine Dateien vorhanden" : "No files yet")}
              </small>
            )}
          </div>
        ) : (
          <div className="file-explorer">
          {/* Column headers */}
          <div className="file-row file-row-head">
            <b>{language === "de" ? "Datei" : "File"}</b>
            <b>{language === "de" ? "Ordner" : "Folder"}</b>
            <b>{language === "de" ? "Typ" : "Type"}</b>
            <b>{language === "de" ? "Hochgeladen" : "Uploaded"}</b>
            <b>{language === "de" ? "Aktion" : "Action"}</b>
          </div>

          {isSearching ? (
            /* Flat list when searching */
            <>
              {fileRows.map((file) => (
                <FileRow
                  key={file.id}
                  file={file}
                  language={language}
                  canManageFiles={canManageFiles}
                  isPreviewable={isPreviewable}
                  filePreviewUrl={filePreviewUrl}
                  fileDownloadUrl={fileDownloadUrl}
                  onDelete={(id) => void deleteFile(id)}
                />
              ))}
              {fileRows.length === 0 && (
                <small className="muted">{language === "de" ? "Keine Treffer" : "No files found"}</small>
              )}
            </>
          ) : (
            /* Grouped by folder when browsing */
            <>
              {(groupedFiles ?? []).map(([folder, folderFiles]) => {
                const collapsed = isFolderCollapsed(folder);
                const isReport = isReportFolder(folder);
                return (
                  <div key={folder} className="file-folder-group">
                    <button
                      type="button"
                      className={`file-folder-header${isReport ? " file-folder-header--report" : ""}`}
                      onClick={() => toggleFolder(folder)}
                      aria-expanded={!collapsed}
                    >
                      <span className="file-folder-chevron">{collapsed ? "▶" : "▼"}</span>
                      <span className="file-folder-name">📁 {folderLabel(folder)}</span>
                      <span className="file-folder-count">
                        {folderFiles.length} {language === "de" ? "Datei" : "file"}{folderFiles.length !== 1 ? (language === "de" ? "en" : "s") : ""}
                      </span>
                      {isReport && collapsed && (
                        <span className="file-folder-hint">
                          {language === "de" ? "Automatisch generiert" : "Auto-generated"}
                        </span>
                      )}
                    </button>
                    {!collapsed && folderFiles.map((file) => (
                      <FileRow
                        key={file.id}
                        file={file}
                        language={language}
                        canManageFiles={canManageFiles}
                        isPreviewable={isPreviewable}
                        filePreviewUrl={filePreviewUrl}
                        fileDownloadUrl={fileDownloadUrl}
                        onDelete={(id) => void deleteFile(id)}
                      />
                    ))}
                  </div>
                );
              })}
              {fileRows.length === 0 && (
                <small className="muted">{language === "de" ? "Keine Dateien vorhanden" : "No files yet"}</small>
              )}
            </>
          )}
        </div>
        )}
      </div>
    </section>
  );
}
