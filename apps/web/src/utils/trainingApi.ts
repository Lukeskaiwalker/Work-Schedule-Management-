// API client for the Ausbildungsnachweis (apprentice weekly training report).
//
// Backend: apps/api/app/routers/workflow_training_reports.py. Gating in short:
// writing needs user.is_apprentice (a fact, not a permission), reading someone
// else's sheet or countersigning needs `training:manage`, flagging apprentices
// needs `users:manage`.

import { apiFetch } from "../api/client";

export type TrainingEntryCategory = "betrieb" | "unterweisung" | "schule";
export type TrainingReportStatus = "draft" | "submitted" | "signed";

export interface TrainingDayEntry {
  text: string;
  hours: number;
  category: TrainingEntryCategory;
}

export interface TrainingReportDay {
  day: string; // ISO date
  entries: TrainingDayEntry[];
}

export interface TrainingReport {
  id: number;
  user_id: number;
  user_display_name: string | null;
  week_start: string;
  report_number: number;
  ausbildungsjahr: number;
  status: TrainingReportStatus;
  days: TrainingReportDay[];
  remarks: string | null;
  total_hours: number;
  azubi_signed_at: string | null;
  ausbilder_signed_at: string | null;
  ausbilder_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrainingPrefillDay {
  day: string;
  worked_hours: number;
  school_day: boolean;
  suggested_lines: string[];
}

export interface TrainingPrefill {
  week_start: string;
  ausbildungsjahr: number;
  days: TrainingPrefillDay[];
}

/** One apprentice as the trainer's roster lists them. */
export interface Apprentice {
  id: number;
  full_name: string;
  display_name: string;
  email: string;
  is_apprentice: boolean;
  training_started_on: string | null;
  report_count: number;
  pending_count: number;
  missing_week_count: number;
  last_week_start: string | null;
}

export async function listApprentices(token: string | null): Promise<Apprentice[]> {
  return apiFetch<Apprentice[]>(`/training/apprentices`, token);
}

export async function listTrainingReports(
  token: string | null,
  options: { view?: "own" | "review"; userId?: number } = {},
): Promise<TrainingReport[]> {
  const params = new URLSearchParams();
  if (options.view) params.set("view", options.view);
  if (options.userId != null) params.set("user_id", String(options.userId));
  const qs = params.toString();
  return apiFetch<TrainingReport[]>(`/training/reports${qs ? `?${qs}` : ""}`, token);
}

export async function getTrainingPrefill(
  token: string | null,
  weekStart: string,
): Promise<TrainingPrefill> {
  return apiFetch<TrainingPrefill>(`/training/prefill?week_start=${weekStart}`, token);
}

export async function createTrainingReport(
  token: string | null,
  payload: { week_start: string; ausbildungsjahr?: number; days: TrainingReportDay[]; remarks?: string | null },
): Promise<TrainingReport> {
  return apiFetch<TrainingReport>(`/training/reports`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateTrainingReport(
  token: string | null,
  id: number,
  payload: { ausbildungsjahr?: number; days?: TrainingReportDay[]; remarks?: string | null },
): Promise<TrainingReport> {
  return apiFetch<TrainingReport>(`/training/reports/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteTrainingReport(token: string | null, id: number): Promise<void> {
  await apiFetch<void>(`/training/reports/${id}`, token, { method: "DELETE" });
}

export async function signTrainingReportAsAzubi(
  token: string | null,
  id: number,
  signature: string,
): Promise<TrainingReport> {
  return apiFetch<TrainingReport>(`/training/reports/${id}/sign-azubi`, token, {
    method: "POST",
    body: JSON.stringify({ signature }),
  });
}

export async function withdrawTrainingReport(token: string | null, id: number): Promise<TrainingReport> {
  return apiFetch<TrainingReport>(`/training/reports/${id}/withdraw`, token, { method: "POST" });
}

export async function signTrainingReportAsAusbilder(
  token: string | null,
  id: number,
  signature: string,
): Promise<TrainingReport> {
  return apiFetch<TrainingReport>(`/training/reports/${id}/sign-ausbilder`, token, {
    method: "POST",
    body: JSON.stringify({ signature }),
  });
}

/**
 * Relative URLs. On the web the session cookie rides along on a same-origin
 * navigation; in the native shell and the installed PWA `native/fileOpen.ts`
 * intercepts clicks on `/api/` links and fetches the bytes with the bearer
 * token instead. Both are handled centrally, so a plain <a href> is correct.
 */
export function trainingReportPdfUrl(id: number): string {
  return `/api/training/reports/${id}/pdf`;
}

/** The whole Ausbildungsheft — Deckblatt, index, every sheet — as one PDF. */
export function trainingHeftPdfUrl(options: { userId?: number; includeDrafts?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (options.userId != null) params.set("user_id", String(options.userId));
  if (options.includeDrafts) params.set("include_drafts", "true");
  const qs = params.toString();
  return `/api/training/heft${qs ? `?${qs}` : ""}`;
}

export async function updateApprenticeSettings(
  token: string | null,
  userId: number,
  payload: { is_apprentice?: boolean; training_started_on?: string | null; clear_training_started_on?: boolean },
): Promise<{ user_id: number; is_apprentice: boolean; training_started_on: string | null }> {
  return apiFetch(`/training/apprentices/${userId}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}
