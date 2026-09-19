/**
 * The project's files: the shared FileBrowser over the context's file list,
 * with the click-through viewer on top. What is project-specific stays here
 * — the context bindings, the two WebDAV links, and where an upload goes.
 */
import { FileBrowser } from "../../components/files/FileBrowser";
import { FileLightbox } from "../../components/files/FileLightbox";
import { folderKeyOf, folderLabel } from "../../components/files/folderGroups";
import { useFileViewer } from "../../components/files/useFileViewer";
import {
  WebdavHelp,
  webdavCertificateHint,
  webdavCommonHints,
} from "../../components/files/WebdavHelp";
import { useAppContext } from "../../context/AppContext";
import type { StoredFile } from "../../types";

// The user's list/gallery choice and tile size, remembered across sessions;
// the customer card keeps its own pair.
const PROJECT_FILES_STORAGE_KEYS = {
  viewMode: "smpl_project_files_view_mode",
  gallerySize: "smpl_project_files_gallery_size",
};

export function ProjectFilesTab() {
  const {
    mainView,
    projectTab,
    activeProject,
    language,
    files,
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
    deleteFile,
    // Drop files anywhere on the browser to open the upload modal pre-filled.
    requestFileUploadWithFiles,
  } = useAppContext();
  const viewer = useFileViewer();

  if (mainView !== "project" || !activeProject || projectTab !== "files") return null;

  const de = language === "de";
  const allProjectsDavUrl = `${window.location.origin}/api/dav/projects/`;

  function openUploadModal() {
    if (!fileUploadFolder) {
      const fallback = projectFolders.find((folder) => canUseProtectedFolders || !folder.is_protected);
      setFileUploadFolder(fallback?.path ?? "/");
    }
    setFileUploadModalOpen(true);
  }

  function openViewer(file: StoredFile, sequence: StoredFile[]) {
    viewer.open(sequence, file, (entry) => folderLabel(folderKeyOf(entry), language));
  }

  async function deleteFromViewer(id: number) {
    await deleteFile(id);
    viewer.remove(id);
  }

  return (
    <section className="grid files-grid">
      <FileBrowser
        rows={files}
        query={fileQuery}
        onQueryChange={setFileQuery}
        storageKeys={PROJECT_FILES_STORAGE_KEYS}
        language={language}
        title={de ? "Online Datei-Explorer" : "Online file explorer"}
        onOpen={openViewer}
        onDelete={canManageFiles ? (file) => void deleteFile(file.id) : undefined}
        onUpload={openUploadModal}
        onDropFiles={canManageFiles ? requestFileUploadWithFiles : undefined}
        headerExtra={
          <WebdavHelp
            language={language}
            links={[
              {
                label: de ? "Alle Projekte:" : "All projects:",
                url: allProjectsDavUrl,
                onCopy: () => void copyToClipboard(allProjectsDavUrl, "all"),
              },
              {
                label: de ? "Nur aktuelles Projekt:" : "Current project only:",
                url: activeProjectDavUrl,
                onCopy: () => void copyToClipboard(activeProjectDavUrl, "project"),
              },
            ]}
            hints={[
              ...webdavCommonHints(language),
              de
                ? "Wichtig: URL mit abschließendem / verwenden. Für andere Geräte im LAN: http://<SERVER-LAN-IP>/api/dav/projects/PROJEKTNUMMER/"
                : "Important: use URL with trailing /. For other devices on LAN: http://<SERVER-LAN-IP>/api/dav/projects/PROJECT_NUMBER/",
              webdavCertificateHint(language),
            ]}
          />
        }
      />
      {viewer.state && (
        <FileLightbox
          files={viewer.state.files}
          index={viewer.state.index}
          onIndexChange={viewer.setIndex}
          onClose={viewer.close}
          onDelete={canManageFiles ? (file) => deleteFromViewer(file.id) : undefined}
          language={language}
        />
      )}
    </section>
  );
}
