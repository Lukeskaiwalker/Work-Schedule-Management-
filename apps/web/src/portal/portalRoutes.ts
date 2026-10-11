// The partner portal's URLs. The office app has no router library and keys
// navigation on state; the portal is small enough to keep the address bar
// honest instead, so a partner can bookmark a job, share a link with a
// colleague who has their own login, and use the phone's back gesture.

import type { PortalScope } from "./portalTypes";
import { PORTAL_BASE_PATH } from "./shellChoice";

export type PortalRoute =
  | { name: "tasks"; scope: PortalScope }
  | { name: "task"; id: number }
  | { name: "projects"; scope: PortalScope }
  | { name: "project"; id: number }
  | { name: "account" }
  | { name: "invite"; token: string }
  | { name: "reset"; token: string };

const HOME: PortalRoute = { name: "tasks", scope: "open" };

function positiveId(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function parsePortalRoute(pathname: string, search: string): PortalRoute {
  if (!pathname.startsWith(PORTAL_BASE_PATH)) return HOME;
  const rest = pathname.slice(PORTAL_BASE_PATH.length).replace(/\/+$/, "");
  const segments = rest.split("/").filter(Boolean);
  const params = new URLSearchParams(search);
  const view = params.get("ansicht");
  const [first, second] = segments;
  if (segments.length === 0) return HOME;
  if (first === "einladung" && segments.length === 1) return { name: "invite", token: params.get("token") ?? "" };
  if (first === "passwort" && segments.length === 1) return { name: "reset", token: params.get("token") ?? "" };
  if (first === "konto" && segments.length === 1) return { name: "account" };
  if (first === "aufgaben") {
    if (segments.length === 1) return { name: "tasks", scope: view === "erledigt" ? "done" : "open" };
    const id = segments.length === 2 ? positiveId(second) : null;
    return id ? { name: "task", id } : HOME;
  }
  if (first === "projekte") {
    if (segments.length === 1) return { name: "projects", scope: view === "abgeschlossen" ? "done" : "open" };
    const id = segments.length === 2 ? positiveId(second) : null;
    return id ? { name: "project", id } : HOME;
  }
  return HOME;
}

export function portalPath(route: PortalRoute): string {
  switch (route.name) {
    case "tasks":
      return route.scope === "done" ? `${PORTAL_BASE_PATH}/aufgaben?ansicht=erledigt` : PORTAL_BASE_PATH;
    case "task":
      return `${PORTAL_BASE_PATH}/aufgaben/${route.id}`;
    case "projects":
      return route.scope === "done"
        ? `${PORTAL_BASE_PATH}/projekte?ansicht=abgeschlossen`
        : `${PORTAL_BASE_PATH}/projekte`;
    case "project":
      return `${PORTAL_BASE_PATH}/projekte/${route.id}`;
    case "account":
      return `${PORTAL_BASE_PATH}/konto`;
    case "invite":
      return `${PORTAL_BASE_PATH}/einladung?token=${encodeURIComponent(route.token)}`;
    case "reset":
      return `${PORTAL_BASE_PATH}/passwort?token=${encodeURIComponent(route.token)}`;
    default:
      return PORTAL_BASE_PATH;
  }
}
