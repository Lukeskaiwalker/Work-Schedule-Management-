/**
 * The data behind the customer files card: the customer's own files and
 * folders, the projects whose folders "land in" this customer, and the
 * writes — upload with progress, folder creation, delete.
 *
 * Self-contained like CustomerTasksCard: it loads with apiFetch and keeps
 * its state here rather than in App, because the customer page is the only
 * place these files are shown. Errors are kept, not swallowed: an employee
 * without access to a customer's files gets the API's 403 text on the card,
 * not an empty card that looks like "no files".
 */
import { useCallback, useEffect, useState } from "react";

import { apiFetch, apiUploadWithProgress } from "../api/client";
import { listCustomerProjects, type CustomerProjectSummary } from "../utils/customersApi";
import type { ProjectFolder, StoredFile } from "../types";

export type CustomerFilesLoad =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export type UploadProgressState = {
  busy: boolean;
  percent: number | null;
  phase: "uploading" | "processing" | null;
  error: string;
};

const IDLE_UPLOAD: UploadProgressState = { busy: false, percent: null, phase: null, error: "" };

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useCustomerFiles(customerId: number, token: string | null) {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [projects, setProjects] = useState<CustomerProjectSummary[]>([]);
  const [load, setLoad] = useState<CustomerFilesLoad>({ kind: "loading" });
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadProgressState>(IDLE_UPLOAD);

  const reloadFiles = useCallback(async () => {
    const [rows, folderRows] = await Promise.all([
      apiFetch<StoredFile[]>(`/customers/${customerId}/files`, token),
      apiFetch<ProjectFolder[]>(`/customers/${customerId}/folders`, token),
    ]);
    setFiles(rows);
    setFolders(folderRows);
  }, [customerId, token]);

  const reloadProjects = useCallback(async () => {
    setProjectsError(null);
    try {
      setProjects(await listCustomerProjects(token, customerId));
    } catch (err: unknown) {
      setProjects([]);
      setProjectsError(errorMessage(err, "Failed to load projects"));
    }
  }, [customerId, token]);

  const reload = useCallback(async () => {
    setLoad({ kind: "loading" });
    try {
      await reloadFiles();
      setLoad({ kind: "ready" });
    } catch (err: unknown) {
      setFiles([]);
      setFolders([]);
      setLoad({ kind: "error", message: errorMessage(err, "Failed to load files") });
    }
  }, [reloadFiles]);

  // Files and projects load independently: a project list that fails must
  // not hide the customer's own files, and vice versa. The card is keyed by
  // customer on the page, so a switch remounts rather than races this.
  useEffect(() => {
    void reload();
    void reloadProjects();
  }, [reload, reloadProjects]);

  /** DELETE the file and drop it from the list; throws so the caller can say what failed. */
  const removeFile = useCallback(
    async (id: number) => {
      await apiFetch<void>(`/files/${id}`, token, { method: "DELETE" });
      setFiles((current) => current.filter((file) => file.id !== id));
    },
    [token],
  );

  /** POST the folder, refresh the list, and return the created row. */
  const createFolder = useCallback(
    async (path: string): Promise<ProjectFolder> => {
      const created = await apiFetch<ProjectFolder>(`/customers/${customerId}/folders`, token, {
        method: "POST",
        body: JSON.stringify({ path }),
      });
      setFolders(await apiFetch<ProjectFolder[]>(`/customers/${customerId}/folders`, token));
      return created;
    },
    [customerId, token],
  );

  /**
   * Multipart upload into `folder` ("" or "/" is the root), with the same
   * progress phases as the project upload. Resolves on success after the
   * list is reloaded; rejects with the API's message, which is also kept in
   * `upload.error` for the dialog.
   */
  const uploadFiles = useCallback(
    async (picked: readonly File[], folder: string) => {
      if (picked.length === 0 || upload.busy) return;
      const form = new FormData();
      picked.forEach((file) => form.append("files", file));
      form.set("folder", folder || "/");
      setUpload({ busy: true, percent: 0, phase: "uploading", error: "" });
      try {
        await apiUploadWithProgress(`/customers/${customerId}/files`, token, form, (progress) => {
          const percent = progress.percent;
          if (percent != null) {
            setUpload((current) => ({
              ...current,
              percent,
              // Bytes sent, but the server still encrypts and stores every
              // file: "processing" beats a bar stuck at 100 % looking hung.
              phase: percent >= 100 ? "processing" : current.phase,
            }));
            return;
          }
          // No total: show movement rather than a number we cannot compute.
          if (progress.loaded > 0) {
            setUpload((current) => ({ ...current, percent: current.percent ?? 1 }));
          }
        });
        await reloadFiles();
        setUpload(IDLE_UPLOAD);
      } catch (err: unknown) {
        const message = errorMessage(err, "File upload failed");
        setUpload({ ...IDLE_UPLOAD, error: message });
        throw err;
      }
    },
    [customerId, token, upload.busy, reloadFiles],
  );

  const clearUploadError = useCallback(() => {
    setUpload((current) => (current.error ? { ...current, error: "" } : current));
  }, []);

  return {
    files,
    folders,
    projects,
    projectsError,
    load,
    upload,
    reload,
    reloadProjects,
    removeFile,
    createFolder,
    uploadFiles,
    clearUploadError,
  };
}
