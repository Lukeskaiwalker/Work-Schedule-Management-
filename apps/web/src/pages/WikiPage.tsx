import { useAppContext } from "../context/AppContext";
import { formatServerDateTime } from "../utils/dates";

function getTypeColor(extension: string | null | undefined): string {
  switch (extension?.toLowerCase()) {
    case "pdf":
      return "pdf";
    case "html":
    case "htm":
      return "html";
    case "docx":
    case "doc":
      return "word";
    case "pptx":
    case "ppt":
      return "ppt";
    case "xlsx":
    case "xls":
      return "excel";
    default:
      return "file";
  }
}

export function WikiPage() {
  const {
    mainView,
    language,
    wikiFiles,
    wikiRows,
    wikiSearch,
    setWikiSearch,
    activeWikiPath,
    setActiveWikiPath,
    activeWikiFile,
    loadWikiLibraryFiles,
    wikiFileUrl,
    formatFileSize,
  } = useAppContext();

  if (mainView !== "wiki") return null;

  const hasFile = activeWikiFile !== null;

  return (
    <div className="wiki-page">
      {/* ── File Browser Panel ──────────────────────────── */}
      <div className="wiki-browser">
        {/* Header */}
        <div className="wiki-browser-head">
          <span className="wiki-browser-title">
            {language === "de" ? "Wiki-Bibliothek" : "Wiki Library"}
          </span>
          <button
            type="button"
            className="wiki-refresh-btn"
            onClick={() => void loadWikiLibraryFiles()}
            title={language === "de" ? "Neu laden" : "Refresh"}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path
                d="M10.5 6A4.5 4.5 0 1 1 6 1.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
              <path
                d="M6 1.5l1.5 1.5L6 4.5"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {language === "de" ? "Neu laden" : "Refresh"}
          </button>
        </div>

        {/* Search */}
        <div className="wiki-search-wrap">
          <svg
            className="wiki-search-icon"
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
          >
            <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10 10l2.5 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            className="wiki-search-input"
            value={wikiSearch}
            onChange={(e) => setWikiSearch(e.target.value)}
            placeholder={
              language === "de"
                ? "Datei, Marke oder Ordner suchen…"
                : "Search files, brands, folders…"
            }
          />
        </div>

        {/* Stats */}
        <div className="wiki-stats">
          <span>
            {wikiFiles.length} {language === "de" ? "Dateien" : "files"}
          </span>
        </div>

        {/* Tree */}
        <div className="wiki-tree">
          {wikiRows.map((brand) => (
            <details key={brand.name} className="wiki-brand-item" open>
              <summary className="wiki-brand-summary">
                <svg
                  className="wiki-chevron"
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                >
                  <path
                    d="M1.5 3.5l3.5 3 3.5-3"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="wiki-brand-name">{brand.name}</span>
                <span className="wiki-count-badge">{brand.folders.length}</span>
              </summary>

              {brand.folders.map((folder: any) => (
                <details
                  key={`${brand.name}-${folder.path || "__root"}`}
                  className="wiki-folder-item"
                  open
                >
                  <summary className="wiki-folder-summary">
                    <svg
                      className="wiki-chevron"
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                    >
                      <path
                        d="M1.5 3.5l3.5 3 3.5-3"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <svg
                      className="wiki-folder-icon"
                      width="13"
                      height="11"
                      viewBox="0 0 13 11"
                      fill="none"
                    >
                      <path
                        d="M1 2.5C1 1.67 1.67 1 2.5 1H5l1.5 2H10.5C11.33 3 12 3.67 12 4.5v5c0 .83-.67 1.5-1.5 1.5h-8C1.67 11 1 10.33 1 9.5v-7z"
                        fill="currentColor"
                        fillOpacity="0.15"
                        stroke="currentColor"
                        strokeWidth="1"
                      />
                    </svg>
                    <span className="wiki-folder-name">{folder.path || "/"}</span>
                  </summary>

                  <div className="wiki-docs-list">
                    {folder.documents.map((document: any) => {
                      const isActive = document.variants.some(
                        (v: any) => v.path === activeWikiPath,
                      );
                      return (
                        <div
                          key={`${brand.name}-${folder.path}-${document.key}`}
                          className={`wiki-doc-row${isActive ? " active" : ""}`}
                        >
                          <div className="wiki-doc-info">
                            <span className="wiki-doc-label">{document.label}</span>
                            <span className="wiki-doc-variants">
                              {document.variants.length}{" "}
                              {language === "de" ? "Varianten" : "variants"}
                            </span>
                          </div>
                          <div className="wiki-doc-badges">
                            {document.variants.map((variant: any) => (
                              <button
                                key={variant.path}
                                type="button"
                                className={`wiki-type-badge wiki-type-${getTypeColor(variant.extension)}${activeWikiPath === variant.path ? " active" : ""}`}
                                onClick={() => setActiveWikiPath(variant.path)}
                              >
                                {variant.extension
                                  ? variant.extension.toUpperCase()
                                  : language === "de"
                                    ? "DATEI"
                                    : "FILE"}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              ))}
            </details>
          ))}

          {wikiRows.length === 0 && (
            <p className="wiki-empty-msg">
              {language === "de"
                ? "Keine Wiki-Dateien für diese Suche gefunden."
                : "No wiki files found for this search."}
            </p>
          )}
        </div>
      </div>

      {/* ── Preview Panel ──────────────────────────────── */}
      <div className="wiki-preview-panel">
        {hasFile ? (
          <>
            {/* Top bar */}
            <div className="wiki-preview-topbar">
              <div className="wiki-preview-file-info">
                <span className="wiki-preview-filename">{activeWikiFile!.file_name}</span>
                <span className="wiki-preview-filepath">{activeWikiFile!.path}</span>
              </div>
              <div className="wiki-preview-actions">
                <a
                  href={wikiFileUrl(activeWikiFile!.path)}
                  target="_blank"
                  rel="noreferrer"
                  className="wiki-action-btn wiki-action-secondary"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2 6h8M7.5 3.5l3 2.5-3 2.5"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {language === "de" ? "In neuem Tab öffnen" : "Open in new tab"}
                </a>
                <a
                  href={wikiFileUrl(activeWikiFile!.path, true)}
                  target="_blank"
                  rel="noreferrer"
                  className="wiki-action-btn wiki-action-primary"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M6 1v7M3.5 6L6 8.5 8.5 6M1 11h10"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {language === "de" ? "Download" : "Download"}
                </a>
              </div>
            </div>

            {/* Metadata strip */}
            <div className="wiki-meta-strip">
              <span
                className={`wiki-ext-badge wiki-ext-${getTypeColor(activeWikiFile!.extension)}`}
              >
                {activeWikiFile!.extension?.toUpperCase() ?? "FILE"}
              </span>
              <span className="wiki-meta-item">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" />
                  <path
                    d="M6 3.5v3l1.5 1"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                  />
                </svg>
                {formatServerDateTime(activeWikiFile!.modified_at, language)}
              </span>
              <span className="wiki-meta-item">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M2 10l2.5-2.5M4.5 7.5V4M4.5 7.5H8M8 7.5V2"
                    stroke="currentColor"
                    strokeWidth="1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {formatFileSize(activeWikiFile!.size_bytes)}
              </span>
              <span className="wiki-meta-item">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M1 2.5C1 1.67 1.67 1 2.5 1H5l1.5 2H9.5C10.33 3 11 3.67 11 4.5v5c0 .83-.67 1.5-1.5 1.5h-7C1.67 11 1 10.33 1 9.5v-7z"
                    stroke="currentColor"
                    strokeWidth="1.1"
                  />
                </svg>
                {activeWikiFile!.brand}
                {activeWikiFile!.folder ? ` / ${activeWikiFile!.folder}` : ""}
              </span>
            </div>

            {/* Preview content */}
            <div className="wiki-preview-body">
              {activeWikiFile!.previewable ? (
                <iframe
                  key={activeWikiFile!.path}
                  src={wikiFileUrl(activeWikiFile!.path)}
                  title={activeWikiFile!.file_name}
                  className="wiki-preview-iframe"
                />
              ) : (
                <div className="wiki-not-previewable">
                  <p className="muted">
                    {language === "de"
                      ? "Dateityp nicht direkt im Browser darstellbar. Bitte herunterladen."
                      : "This file type is not directly previewable. Please download it."}
                  </p>
                  <a
                    href={wikiFileUrl(activeWikiFile!.path, true)}
                    target="_blank"
                    rel="noreferrer"
                    className="wiki-action-btn wiki-action-primary"
                  >
                    {language === "de" ? "Download" : "Download"}
                  </a>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="wiki-preview-empty">
            <p className="muted">
              {language === "de"
                ? "Bitte links eine Datei auswählen."
                : "Select a file from the library to preview it."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
