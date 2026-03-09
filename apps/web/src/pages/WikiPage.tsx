import { useAppContext } from "../context/AppContext";
import { formatServerDateTime } from "../utils/dates";

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

  return (
    <section className="grid wiki-grid wiki-library-grid">
      <div className="card wiki-library-card">
        <div className="row wrap wiki-library-head">
          <h3>{language === "de" ? "Lokale Wiki-Dateien" : "Local wiki files"}</h3>
          <input
            value={wikiSearch}
            onChange={(event) => setWikiSearch(event.target.value)}
            placeholder={language === "de" ? "Datei, Marke oder Ordner suchen" : "Search file, brand, or folder"}
          />
          <button type="button" onClick={() => void loadWikiLibraryFiles()}>
            {language === "de" ? "Neu laden" : "Refresh"}
          </button>
        </div>
        <small className="muted">
          {language === "de" ? "Dateien gesamt" : "Total files"}: {wikiFiles.length}
        </small>
        <div className="wiki-library-scroll">
          {wikiRows.map((brand) => (
            <details key={brand.name} className="wiki-brand-group" open>
              <summary>
                <b>{brand.name}</b>
                <small>{brand.folders.length}</small>
              </summary>
              {brand.folders.map((folder: any) => (
                <details key={`${brand.name}-${folder.path || "__root"}`} className="wiki-folder-group" open>
                  <summary>
                    <span>{folder.path || "/"}</span>
                  </summary>
                  <ul className="wiki-doc-list">
                    {folder.documents.map((document: any) => (
                      <li key={`${brand.name}-${folder.path}-${document.key}`} className="wiki-doc-item">
                        <div className="wiki-doc-main">
                          <b>{document.label}</b>
                          <small>{document.variants.length} {language === "de" ? "Varianten" : "variants"}</small>
                        </div>
                        <div className="row wrap wiki-doc-actions">
                          {document.variants.map((variant: any) => (
                            <button
                              key={variant.path}
                              type="button"
                              className={activeWikiPath === variant.path ? "active" : ""}
                              onClick={() => setActiveWikiPath(variant.path)}
                            >
                              {variant.extension ? variant.extension.toUpperCase() : language === "de" ? "DATEI" : "FILE"}
                            </button>
                          ))}
                        </div>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </details>
          ))}
          {wikiRows.length === 0 && (
            <p className="muted">
              {language === "de"
                ? "Keine Wiki-Dateien für diese Suche gefunden."
                : "No wiki files found for this search."}
            </p>
          )}
        </div>
      </div>

      <div className="card wiki-preview-card">
        <div className="row wrap wiki-preview-head">
          <h3>{language === "de" ? "Vorschau" : "Preview"}</h3>
          {activeWikiFile && (
            <div className="row wrap">
              <a href={wikiFileUrl(activeWikiFile.path)} target="_blank" rel="noreferrer">
                {language === "de" ? "In neuem Tab öffnen" : "Open in new tab"}
              </a>
              <a href={wikiFileUrl(activeWikiFile.path, true)} target="_blank" rel="noreferrer">
                {language === "de" ? "Download" : "Download"}
              </a>
            </div>
          )}
        </div>
        {!activeWikiFile && (
          <p className="muted">
            {language === "de"
              ? "Bitte links eine Datei auswählen."
              : "Please select a file on the left."}
          </p>
        )}
        {activeWikiFile && (
          <>
            <div className="wiki-preview-meta">
              <b>{activeWikiFile.file_name}</b>
              <small>{activeWikiFile.path}</small>
              <small>
                {formatFileSize(activeWikiFile.size_bytes)} |{" "}
                {formatServerDateTime(activeWikiFile.modified_at, language)}
              </small>
            </div>
            {activeWikiFile.previewable ? (
              <iframe
                key={activeWikiFile.path}
                src={wikiFileUrl(activeWikiFile.path)}
                title={activeWikiFile.file_name}
                className="wiki-preview-frame"
              />
            ) : (
              <p className="muted">
                {language === "de"
                  ? "Dateityp nicht direkt im Browser darstellbar. Bitte herunterladen."
                  : "This file type is not directly previewable. Please download it."}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
