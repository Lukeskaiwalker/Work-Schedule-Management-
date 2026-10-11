// The partner portal's calls. Everything authenticated goes to /api/portal —
// the only routes a partner login may use (the server refuses the rest).
// Login, logout, invite acceptance and password reset are the shared public
// auth endpoints.

import { ApiError, apiFetch } from "../api/client";
import type {
  PortalFile,
  PortalHoursEntry,
  PortalHoursInput,
  PortalMe,
  PortalProject,
  PortalProjectDetail,
  PortalScope,
  PortalTask,
  PortalTaskDetail,
} from "./portalTypes";

export const PORTAL_TOKEN_KEY = "smpl_token";

export type LoginResult =
  | { kind: "session"; token: string; role: string }
  | { kind: "mfa"; challenge: string };

async function readDetail(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data.detail === "string" && data.detail) return data.detail;
  } catch {
    // no body
  }
  return fallback;
}

function sessionFrom(response: Response, body: { role?: string }): LoginResult {
  const token = (response.headers.get("X-Access-Token") ?? "").trim();
  if (!token) throw new ApiError("Anmeldung fehlgeschlagen", response.status);
  return { kind: "session", token, role: String(body.role ?? "") };
}

export async function portalLogin(email: string, password: string): Promise<LoginResult> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password }),
    credentials: "include",
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response, "Anmeldung fehlgeschlagen"), response.status);
  }
  const body = (await response.json()) as { mfa_required?: boolean; role?: string };
  if (body.mfa_required) {
    return { kind: "mfa", challenge: (response.headers.get("X-Mfa-Challenge") ?? "").trim() };
  }
  return sessionFrom(response, body);
}

export async function portalLoginMfa(code: string, challenge: string): Promise<LoginResult> {
  const response = await fetch("/api/auth/login/mfa", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(challenge ? { "X-Mfa-Challenge": challenge } : {}) },
    body: JSON.stringify({ code: code.trim() }),
    credentials: "include",
  });
  if (!response.ok) {
    throw new ApiError(await readDetail(response, "Ungültiger Code"), response.status);
  }
  return sessionFrom(response, (await response.json()) as { role?: string });
}

export async function portalLogout(token: string | null): Promise<void> {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: "include",
    });
  } catch {
    // Signing out locally is what matters; the cookie dies with the session.
  }
}

/** Accept an invite: set the first password. Returns the login's email. */
export async function acceptPortalInvite(token: string, newPassword: string): Promise<{ email: string }> {
  return apiFetch<{ email: string }>("/auth/invites/accept", null, {
    method: "POST",
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

export async function confirmPortalPasswordReset(token: string, newPassword: string): Promise<unknown> {
  return apiFetch<unknown>("/auth/password-reset/confirm", null, {
    method: "POST",
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

export function getPortalMe(token: string): Promise<PortalMe> {
  return apiFetch<PortalMe>("/portal/me", token);
}

export function listPortalTasks(token: string, scope: PortalScope): Promise<PortalTask[]> {
  return apiFetch<PortalTask[]>(`/portal/tasks?scope=${scope}`, token);
}

export function getPortalTask(token: string, taskId: number): Promise<PortalTaskDetail> {
  return apiFetch<PortalTaskDetail>(`/portal/tasks/${taskId}`, token);
}

export function completePortalTask(token: string, taskId: number, note: string): Promise<PortalTaskDetail> {
  return apiFetch<PortalTaskDetail>(`/portal/tasks/${taskId}/complete`, token, {
    method: "POST",
    body: JSON.stringify({ note: note.trim() || null }),
  });
}

export function uploadPortalFiles(token: string, taskId: number, files: File[]): Promise<PortalFile[]> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file, file.name));
  return apiFetch<PortalFile[]>(`/portal/tasks/${taskId}/files`, token, { method: "POST", body: form });
}

/** Same-origin URL; the session cookie authenticates it, so an image element can load it directly. */
export function portalFileUrl(taskId: number, fileId: number, download = false): string {
  return `/api/portal/tasks/${taskId}/files/${fileId}${download ? "?download=1" : ""}`;
}

/** A file from a project's "Partnerportal" folder — same-origin, cookie-authenticated like task files. */
export function portalDocumentUrl(fileId: number, download = false): string {
  return `/api/portal/documents/${fileId}${download ? "?download=1" : ""}`;
}

export function reportPortalHours(token: string, input: PortalHoursInput): Promise<PortalHoursEntry> {
  return apiFetch<PortalHoursEntry>("/portal/hours", token, {
    method: "POST",
    body: JSON.stringify({ ...input, note: input.note?.trim() || null }),
  });
}

export async function deletePortalHours(token: string, entryId: number): Promise<void> {
  await apiFetch<unknown>(`/portal/hours/${entryId}`, token, { method: "DELETE" });
}

export function listPortalProjects(token: string, scope: PortalScope): Promise<PortalProject[]> {
  return apiFetch<PortalProject[]>(`/portal/projects?scope=${scope}`, token);
}

export function getPortalProject(token: string, projectId: number): Promise<PortalProjectDetail> {
  return apiFetch<PortalProjectDetail>(`/portal/projects/${projectId}`, token);
}

export async function changePortalPassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
  await apiFetch<unknown>("/portal/me/password", token, {
    method: "POST",
    body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
  });
}
