import { useAppContext } from "../../context/AppContext";

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
  } = useAppContext();

  if (!fileUploadModalOpen || mainView !== "project" || !activeProject || projectTab !== "files") return null;

  return (
    <div className="modal-backdrop" onClick={() => setFileUploadModalOpen(false)}>
      <div className="card modal-card modal-card-sm" onClick={(event) => event.stopPropagation()}>
        <h3>{language === "de" ? "Datei hochladen" : "Upload file"}</h3>
        <form className="modal-form" onSubmit={uploadFile}>
          <label>
            {language === "de" ? "Zielordner" : "Target folder"}
            <select value={fileUploadFolder} onChange={(event) => setFileUploadFolder(event.target.value)}>
              <option value="/">{language === "de" ? "Hauptordner (/)" : "Base folder (/)"}</option>
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
                language === "de"
                  ? "Neuer Ordnerpfad (optional, z.B. Bilder/Tag2)"
                  : "New folder path (optional, e.g. Bilder/Tag2)"
              }
            />
            <button type="button" onClick={() => void createProjectFolderFromInput()}>
              {language === "de" ? "Ordner anlegen" : "Create folder"}
            </button>
          </div>
          <small className="muted">
            {language === "de"
              ? "Wenn ein neuer Ordnerpfad gesetzt ist, wird er beim Upload automatisch erstellt und genutzt."
              : "If a new folder path is set, upload auto-creates it and uploads there."}
          </small>
          <input type="file" name="file" required />
          <div className="row wrap">
            <button type="submit">{language === "de" ? "Hochladen" : "Upload"}</button>
            <button type="button" onClick={() => setFileUploadModalOpen(false)}>
              {language === "de" ? "Abbrechen" : "Cancel"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
