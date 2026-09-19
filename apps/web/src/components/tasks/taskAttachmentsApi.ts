/**
 * The three calls behind the "Anhänge" section, in one place because two
 * callers need the upload: the section itself for a task that exists, and
 * App's createWeeklyPlanTask for files picked before the task did — those go
 * up against the id the POST has just minted.
 */
import { apiFetch, apiUploadWithProgress, type UploadProgress } from "../../api/client";
import type { StoredFile } from "../../types";

export function taskFilesPath(taskId: number): string {
  return `/tasks/${taskId}/files`;
}

/**
 * The task's files, newest first. A response that is not a list is a broken
 * api answer, not an empty task — the section shows its retry state for it
 * rather than an empty grid that would read as "nothing attached".
 */
export async function loadTaskAttachments(taskId: number, token: string | null): Promise<StoredFile[]> {
  const rows = await apiFetch<unknown>(taskFilesPath(taskId), token);
  if (!Array.isArray(rows)) throw new Error("Unexpected response for task files");
  return rows as StoredFile[];
}

/** The multipart body POST /tasks/{id}/files reads: every file under `files`. */
export function buildTaskFilesFormData(files: readonly File[]): FormData {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  return form;
}

export function uploadTaskAttachments(
  taskId: number,
  token: string | null,
  files: readonly File[],
  onProgress?: (progress: UploadProgress) => void,
): Promise<StoredFile[]> {
  return apiUploadWithProgress<StoredFile[]>(taskFilesPath(taskId), token, buildTaskFilesFormData(files), onProgress);
}

export function deleteTaskAttachment(fileId: number, token: string | null): Promise<void> {
  return apiFetch<void>(`/files/${fileId}`, token, { method: "DELETE" });
}
