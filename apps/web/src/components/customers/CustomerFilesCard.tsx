/**
 * "Dateien" on the customer page: the customer's own folder, with the
 * project folders that land in it listed first.
 *
 * Same browser, rows and tiles as the project files tab, with its own
 * view/size preference. The customer's files can be uploaded (↑ or a drop
 * on the card), previewed in the viewer and deleted (files:manage); a
 * project's files are preview and download only — the project page is
 * where they are managed, one link away.
 */
import { useState } from "react";

import { useAppContext } from "../../context/AppContext";
import { copyText } from "../files/copyText";
import { FileBrowser, type FileBrowserStatus } from "../files/FileBrowser";
import { FileLightbox } from "../files/FileLightbox";
import { folderKeyOf, folderLabel } from "../files/folderGroups";
import { UploadFilesDialog } from "../files/UploadFilesDialog";
import { useFileViewer } from "../files/useFileViewer";
import { WebdavHelp, webdavCertificateHint, webdavCommonHints } from "../files/WebdavHelp";
import { useCustomerFiles } from "../../hooks/useCustomerFiles";
import type { CustomerProjectSummary } from "../../utils/customersApi";
import type { StoredFile } from "../../types";
import { CustomerProjectFolders } from "./CustomerProjectFolders";

const CUSTOMER_FILES_STORAGE_KEYS = {
  viewMode: "smpl_customer_files_view_mode",
  gallerySize: "smpl_customer_files_gallery_size",
};

type Props = {
  customerId: number;
};

export function customerDavUrl(customerId: number): string {
  return `${window.location.origin}/api/dav/customers/${customerId}/`;
}

export function CustomerFilesCard({ customerId }: Props) {
  const {
    token,
    language,
    canManageFiles,
    canUseProtectedFolders,
    openProjectById,
    setProjectTab,
    setError,
    setNotice,
  } = useAppContext();
  const de = language === "de";
  const data = useCustomerFiles(customerId, token);
  const viewer = useFileViewer();

  const [query, setQuery] = useState("");
  // Whether the open sequence is the customer's own files. A project's files
  // are read-only on this card, so the viewer offers Löschen only for these.
  const [viewerDeletable, setViewerDeletable] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [selectedFolder, setSelectedFolder] = useState("/");
  const [newFolderPath, setNewFolderPath] = useState("");

  function openUpload(dropped: File[] = []) {
    setPendingFiles(dropped);
    data.clearUploadError();
    setUploadOpen(true);
  }

  function closeUpload() {
    setUploadOpen(false);
    setPendingFiles([]);
  }

  async function submitUpload(files: File[], folder: string) {
    try {
      await data.uploadFiles(files, folder);
    } catch {
      // Kept in the dialog by the hook; the dialog stays open with the
      // selection so a retry does not mean picking the files again.
      return;
    }
    if (newFolderPath.trim()) {
      setSelectedFolder(newFolderPath.trim());
      setNewFolderPath("");
    }
    closeUpload();
    setNotice(de ? "Dateien hochgeladen" : "Files uploaded");
  }

  async function createFolder() {
    const path = newFolderPath.trim();
    if (!path) return;
    try {
      const created = await data.createFolder(path);
      setSelectedFolder(created.path);
      setNewFolderPath("");
      setNotice(de ? "Ordner erstellt" : "Folder created");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function deleteFromRow(file: StoredFile) {
    void data.removeFile(file.id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }

  // The viewer reports its own failure; deleting there is not confirmed
  // twice, the viewer's Löschen is the confirmation.
  async function deleteFromViewer(id: number) {
    await data.removeFile(id);
    viewer.remove(id);
  }

  function openCustomerFile(file: StoredFile, sequence: StoredFile[]) {
    setViewerDeletable(true);
    viewer.open(sequence, file, (entry) => folderLabel(folderKeyOf(entry), language));
  }

  function openProjectFile(file: StoredFile, sequence: StoredFile[], project: CustomerProjectSummary) {
    setViewerDeletable(false);
    viewer.open(
      sequence,
      file,
      (entry) => `${project.project_number} · ${folderLabel(folderKeyOf(entry), language)}`,
    );
  }

  function openProjectFiles(projectId: number) {
    openProjectById(projectId, "customer_detail");
    setProjectTab("files");
  }

  async function copyDavUrl() {
    try {
      await copyText(customerDavUrl(customerId));
      setNotice(de ? "WebDAV-Link (Kunde) kopiert" : "WebDAV link (customer) copied");
    } catch {
      setError(de ? "Kopieren nicht möglich" : "Could not copy");
    }
  }

  const status: FileBrowserStatus =
    data.load.kind === "loading"
      ? { kind: "loading", text: de ? "Dateien werden geladen…" : "Loading files…" }
      : data.load.kind === "error"
        ? {
            kind: "error",
            text: de ? "Dateien konnten nicht geladen werden." : "Files could not be loaded.",
            detail: data.load.message,
            onRetry: () => void data.reload(),
          }
        : { kind: "ready" };

  // Only a loaded number: while loading or after a failure the title has none.
  const title = (
    <>
      {de ? "Dateien" : "Files"}
      {data.load.kind === "ready" && (
        <span className="customer-projects-count muted"> ({data.files.length})</span>
      )}
    </>
  );

  const hasProjectSection = data.projects.length > 0 || data.projectsError !== null;

  return (
    <>
      <FileBrowser
        className="customer-files-card"
        rows={data.files}
        query={query}
        onQueryChange={setQuery}
        storageKeys={CUSTOMER_FILES_STORAGE_KEYS}
        language={language}
        title={title}
        status={status}
        onOpen={openCustomerFile}
        onDelete={canManageFiles ? deleteFromRow : undefined}
        onUpload={() => openUpload()}
        onDropFiles={canManageFiles ? openUpload : undefined}
        emptyText={
          de
            ? "Noch keine Dateien — was für alle Projekte dieses Kunden gilt, gehört hierher."
            : "No files yet — what applies to all of this customer's projects belongs here."
        }
        headerExtra={
          <WebdavHelp
            language={language}
            links={[
              {
                label: de ? "Dieser Kunde:" : "This customer:",
                url: customerDavUrl(customerId),
                onCopy: () => void copyDavUrl(),
              },
            ]}
            hints={[
              ...webdavCommonHints(language),
              de
                ? "Wichtig: URL mit abschließendem / verwenden. Für andere Geräte im LAN: http://<SERVER-LAN-IP>/api/dav/customers/KUNDENNUMMER/"
                : "Important: use URL with trailing /. For other devices on LAN: http://<SERVER-LAN-IP>/api/dav/customers/CUSTOMER_ID/",
              webdavCertificateHint(language),
            ]}
          />
        }
      >
        {hasProjectSection && (
          <>
            {data.projectsError !== null ? (
              <div className="file-browser-status file-browser-status--error" role="alert">
                <span>{de ? "Projekte konnten nicht geladen werden." : "Projects could not be loaded."}</span>
                <small className="muted">{data.projectsError}</small>
                <button type="button" className="linklike" onClick={() => void data.reloadProjects()}>
                  {de ? "Erneut versuchen" : "Try again"}
                </button>
              </div>
            ) : (
              <CustomerProjectFolders
                projects={data.projects}
                token={token}
                language={language}
                onOpenFile={openProjectFile}
                onOpenProject={openProjectFiles}
              />
            )}
            <h4 className="file-browser-section-title">{de ? "Kundenordner" : "Customer folders"}</h4>
          </>
        )}
      </FileBrowser>

      <UploadFilesDialog
        open={uploadOpen}
        folders={data.folders}
        selectedFolder={selectedFolder}
        onFolderChange={setSelectedFolder}
        newFolderPath={newFolderPath}
        onNewFolderPathChange={setNewFolderPath}
        onCreateFolder={() => void createFolder()}
        pendingFiles={pendingFiles}
        busy={data.upload.busy}
        percent={data.upload.percent}
        phase={data.upload.phase}
        error={data.upload.error}
        onSubmit={(files, folder) => void submitUpload(files, folder)}
        onClose={closeUpload}
        canUseProtectedFolders={canUseProtectedFolders}
        language={language}
      />

      {viewer.state && (
        <FileLightbox
          files={viewer.state.files}
          index={viewer.state.index}
          onIndexChange={viewer.setIndex}
          onClose={viewer.close}
          onDelete={
            canManageFiles && viewerDeletable ? (file) => deleteFromViewer(file.id) : undefined
          }
          language={language}
        />
      )}
    </>
  );
}
