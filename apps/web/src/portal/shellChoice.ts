// Which app boots: the office app or the partner portal.
//
// Decided before either app mounts, because the office app starts loading
// projects, tasks, users and chat the moment it has a session — every one of
// which the server refuses a partner login. The token's role claim is read
// without verification on purpose: it only picks which screens to show. The
// server re-checks every request, so a forged claim gains nothing but a
// portal that cannot load.

export type ShellChoice = "portal" | "app";

export const PORTAL_BASE_PATH = "/partner";

function decodeSegment(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

export function roleFromToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(decodeSegment(parts[1])) as { role?: unknown };
    return typeof payload.role === "string" && payload.role ? payload.role : null;
  } catch {
    return null;
  }
}

export function isPortalPath(pathname: string): boolean {
  return pathname === PORTAL_BASE_PATH || pathname.startsWith(`${PORTAL_BASE_PATH}/`);
}

export function chooseShell(pathname: string, token: string | null): ShellChoice {
  if (isPortalPath(pathname)) return "portal";
  return roleFromToken(token) === "external" ? "portal" : "app";
}
