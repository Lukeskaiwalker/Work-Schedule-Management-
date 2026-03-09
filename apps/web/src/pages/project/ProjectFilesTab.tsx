import { useAppContext } from "../../context/AppContext";
import { formatServerDateTime } from "../../utils/dates";

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
    activeProjectDavUrl,
    copyToClipboard,
    fileDownloadUrl,
    filePreviewUrl,
    isPreviewable,
  } = useAppContext();

  if (mainView !== "project" || !activeProject || projectTab !== "files") return null;

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
          <div className="file-row file-row-head">
            <b>{language === "de" ? "Datei" : "File"}</b>
            <b>{language === "de" ? "Ordner" : "Folder"}</b>
            <b>{language === "de" ? "Typ" : "Type"}</b>
            <b>{language === "de" ? "Hochgeladen" : "Uploaded"}</b>
            <b>{language === "de" ? "Aktion" : "Action"}</b>
          </div>
          {fileRows.map((file) => (
            <div key={file.id} className="file-row">
              <span>{file.file_name}</span>
              <small>{file.folder || "/"}</small>
              <small>{file.content_type}</small>
              <small>{formatServerDateTime(file.created_at, language)}</small>
              <div className="row wrap">
                {isPreviewable(file) && (
                  <a href={filePreviewUrl(file.id)} target="_blank" rel="noreferrer">
                    {language === "de" ? "Vorschau" : "Preview"}
                  </a>
                )}
                <a href={fileDownloadUrl(file.id)} target="_blank" rel="noreferrer">
                  {language === "de" ? "Download" : "Download"}
                </a>
              </div>
            </div>
          ))}
          {fileRows.length === 0 && <small className="muted">{language === "de" ? "Keine Treffer" : "No files found"}</small>}
        </div>
      </div>
    </section>
  );
}
