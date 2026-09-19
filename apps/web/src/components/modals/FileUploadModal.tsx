/**
 * The project-files upload modal: UploadFilesDialog bound to the app
 * context. Everything the dialog shows and does comes from App — the folder
 * list, the selected and the new folder, busy/progress/error — and the
 * submit is App's `uploadFile`, which reads the FormData off the form the
 * dialog rendered (the hidden `files` input mirrors the selection at submit).
 *
 * Files dropped on the project files tab arrive through
 * `fileUploadPendingFiles`: the dialog takes them on open, and this wrapper
 * empties the queue so a later normal open cannot inherit them.
 */
import { useEffect } from "react";

import { UploadFilesDialog } from "../files/UploadFilesDialog";
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
    fileUploadPendingFiles,
    fileUploadBusy,
    fileUploadPercent,
    fileUploadPhase,
    fileUploadError,
    setFileUploadPendingFiles,
  } = useAppContext();

  const open =
    fileUploadModalOpen && mainView === "project" && Boolean(activeProject) && projectTab === "files";

  // The dialog (a child) has already copied the queue in this commit —
  // React runs children's effects first — so clearing it here is safe.
  useEffect(() => {
    if (open && fileUploadPendingFiles.length > 0) setFileUploadPendingFiles([]);
  }, [open, fileUploadPendingFiles, setFileUploadPendingFiles]);

  return (
    <UploadFilesDialog
      open={open}
      folders={projectFolders}
      selectedFolder={fileUploadFolder}
      onFolderChange={setFileUploadFolder}
      newFolderPath={newProjectFolderPath}
      onNewFolderPathChange={setNewProjectFolderPath}
      onCreateFolder={() => void createProjectFolderFromInput()}
      pendingFiles={fileUploadPendingFiles}
      busy={fileUploadBusy}
      percent={fileUploadPercent}
      phase={fileUploadPhase}
      error={fileUploadError}
      onSubmit={(_files, _folder, event) => void uploadFile(event)}
      onClose={() => setFileUploadModalOpen(false)}
      canUseProtectedFolders={canUseProtectedFolders}
      language={language}
    />
  );
}
