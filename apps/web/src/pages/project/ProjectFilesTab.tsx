import { useState, useMemo } from "react";
import { useAppContext } from "../../context/AppContext";
import { formatServerDateTime } from "../../utils/dates";
import type { Language, ProjectFile } from "../../types";

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
      </div>
    </section>
  );
}
