/**
 * The decisions the "Anhänge" section makes that have nothing to do with a
 * DOM: who may take a file off a task, how a picked selection is merged, and
 * the words for counts and dates. Pure, so the tests read as a list of rules
 * and the row badge can share the wording without pulling in the api client.
 */
import type { Language, StoredFile } from "../../types";
import { parseServerDateTime } from "../../utils/dates";

/**
 * DELETE /files/{id}'s rule for a task file: `files:manage`, or being the one
 * who attached it — the crew member who added a photo to their own task can
 * take it back without the office's permission (see docs/FILE_SCOPES.md).
 */
export function canRemoveTaskAttachment(
  file: Pick<StoredFile, "uploaded_by">,
  access: { canManageFiles: boolean; userId: number | null },
): boolean {
  if (access.canManageFiles) return true;
  return access.userId != null && file.uploaded_by === access.userId;
}

/** What tells two picked files apart before either has an id. */
export function pickedFileKey(file: File): string {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

/** The same file picked twice (a second pick, a drop after a pick) is one file. */
export function mergePickedFiles(current: readonly File[], picked: readonly File[]): File[] {
  const seen = new Set(current.map(pickedFileKey));
  const added = picked.filter((file) => {
    const key = pickedFileKey(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...current, ...added];
}

export function withoutFileAt(files: readonly File[], index: number): File[] {
  return files.filter((_, position) => position !== index);
}

/** "3 Anhänge" — the paperclip's tooltip and the badge's spoken name. */
export function attachmentCountLabel(count: number, language: Language): string {
  if (language === "de") return `${count} ${count === 1 ? "Anhang" : "Anhänge"}`;
  return `${count} ${count === 1 ? "attachment" : "attachments"}`;
}

export function attachmentsAddedNotice(count: number, language: Language): string {
  if (count === 1) return language === "de" ? "Anhang hinzugefügt" : "Attachment added";
  return language === "de" ? `${count} Anhänge hinzugefügt` : `${count} attachments added`;
}

/**
 * The day only: a tile has no room for the time, and the day is what tells
 * last year's plan from this morning's photo.
 */
export function formatAttachmentDate(createdAt: string, language: Language): string {
  const parsed = parseServerDateTime(createdAt);
  if (!parsed) return createdAt;
  return parsed.toLocaleDateString(language === "de" ? "de-DE" : "en-US");
}

/** What a tile shows when there is no picture to show. */
export function attachmentGlyph(contentType: string): string {
  const type = (contentType ?? "").toLowerCase();
  if (type === "application/pdf") return "📄";
  if (type.startsWith("text/")) return "📝";
  if (type.startsWith("video/")) return "🎥";
  return "📎";
}

/** "(123 KB)" behind a pending file's name, as the upload dialog prints it. */
export function formatPickedFileSize(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
