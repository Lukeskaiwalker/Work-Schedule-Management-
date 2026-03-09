import { WORKSPACE_MODE_STORAGE_KEY } from "../constants";
import type { WorkspaceMode } from "../types";

export function isLikelyJwtToken(value: string) {
  return /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(value.trim());
}

export function readStoredToken() {
  try {
    const raw = localStorage.getItem("smpl_token");
    if (!raw) return null;
    const clean = raw.trim();
    if (!clean || !isLikelyJwtToken(clean)) {
      localStorage.removeItem("smpl_token");
      return null;
    }
    return clean;
  } catch {
    return null;
  }
}

export function readStoredWorkspaceMode(): WorkspaceMode {
  try {
    const raw = (localStorage.getItem(WORKSPACE_MODE_STORAGE_KEY) || "").trim().toLowerCase();
    if (raw === "office") return "office";
    return "construction";
  } catch {
    return "construction";
  }
}

export function detectPublicAuthMode() {
  const normalizedPath = window.location.pathname.replace(/\/+$/, "");
  if (normalizedPath === "/invite") return "invite" as const;
  if (normalizedPath === "/reset-password") return "reset" as const;
  return null;
}

export function readPublicTokenParam() {
  try {
    const params = new URLSearchParams(window.location.search);
    return (params.get("token") || "").trim();
  } catch {
    return "";
  }
}
