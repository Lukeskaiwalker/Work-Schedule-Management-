// Hours and documents in the portal: the formatting and checking that the
// task and project pages share. Pure, so the tests read the same rules the
// screens use. The server checks all of it again (schemas/portal.py).

import type { PortalDocument, PortalHoursEntry } from "./portalTypes";

export const HOURS_MAX_WORKERS = 50;
export const HOURS_MAX_PER_PERSON = 24;
export const HOURS_MIN = 0.25;
/** One tap on the stepper. Quarter hours can still be typed. */
export const HOURS_STEP = 0.5;
/** The usual answers, one tap each. */
export const HOURS_QUICK_PICKS = [4, 6, 8, 10] as const;

function decimal(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded).replace(".", ",");
}

export function formatHours(value: number): string {
  return `${decimal(value)} Std`;
}

/** "6 Std" for one person, "2 × 7,5 Std = 15 Std" for a crew. */
export function entryAmount(entry: Pick<PortalHoursEntry, "workers" | "hours" | "total_hours">): string {
  if (entry.workers <= 1) return formatHours(entry.hours);
  return `${entry.workers} × ${formatHours(entry.hours)} = ${formatHours(entry.total_hours)}`;
}

function onQuarterGrid(value: number): boolean {
  return Math.abs(value * 4 - Math.round(value * 4)) < 1e-9;
}

/** "7,5" or "7.5" → 7.5; anything off the quarter-hour grid → null. */
export function parseHoursInput(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || !onQuarterGrid(value)) return null;
  return value;
}

/** Half an hour up or down, never below a quarter hour or above a day. */
export function stepHours(value: number, direction: 1 | -1): number {
  const next = value + direction * HOURS_STEP;
  return Math.min(HOURS_MAX_PER_PERSON, Math.max(HOURS_MIN, next));
}

export function hoursProblem(input: {
  workers: number;
  hours: number | null;
  workDate: string;
  todayIso: string;
}): string | null {
  if (!input.workDate) return "Bitte ein Datum wählen.";
  if (input.workDate > input.todayIso) return "Das Datum liegt in der Zukunft.";
  if (!Number.isInteger(input.workers) || input.workers < 1) return "Anzahl Personen: mindestens 1.";
  if (input.workers > HOURS_MAX_WORKERS) return `Höchstens ${HOURS_MAX_WORKERS} Personen pro Eintrag.`;
  if (input.hours == null || input.hours < HOURS_MIN || !onQuarterGrid(input.hours)) {
    return "Stunden bitte in Viertelstunden angeben, z. B. 7,5.";
  }
  if (input.hours > HOURS_MAX_PER_PERSON) return `Höchstens ${HOURS_MAX_PER_PERSON} Stunden pro Person und Tag.`;
  return null;
}

export type DocumentGroup = { folder: string; documents: PortalDocument[] };

/** The folder's own files first, then each subfolder by name; order inside a group is kept (newest first). */
export function groupDocuments(documents: readonly PortalDocument[]): DocumentGroup[] {
  const byFolder = new Map<string, PortalDocument[]>();
  for (const document of documents) {
    const key = document.folder.trim();
    byFolder.set(key, [...(byFolder.get(key) ?? []), document]);
  }
  return Array.from(byFolder.entries())
    .sort(([a], [b]) => {
      if (a === "") return -1;
      if (b === "") return 1;
      return a.localeCompare(b, "de");
    })
    .map(([folder, docs]) => ({ folder, documents: docs }));
}

export function documentKind(contentType: string): "pdf" | "image" | "file" {
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("image/")) return "image";
  return "file";
}
