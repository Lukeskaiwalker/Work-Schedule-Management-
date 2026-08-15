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
  // v2.5.0: customer-confirmation public page. URL shape is
  // /confirm/<token> (path param to match the email links the api
  // generates in customer_confirmation_email.py).
  if (normalizedPath.startsWith("/confirm/")) return "customer_confirmation" as const;
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

/** v2.5.0: extract the customer-confirmation token from the path
 *  /confirm/<token>. Returns "" if the path doesn't match or the
 *  token segment is missing/empty. Used by the public confirmation
 *  page to look up its task. */
export function readCustomerConfirmationToken(): string {
  const normalizedPath = window.location.pathname.replace(/\/+$/, "");
  if (!normalizedPath.startsWith("/confirm/")) return "";
  const token = normalizedPath.slice("/confirm/".length);
  return token.trim();
}

/**
 * v2.9.13: the order id an IDS punchout wants us to open, from
 * `/?werkstatt_order=<id>`.
 *
 * The wholesaler returns the finished cart as a browser form POST with
 * target=_top, so the API's result page replaces the tab the buyer started in
 * and its "Zurück zu SMPL" button is their way back. That button used to point
 * at `/`, which dropped them on the dashboard with the order they had just
 * created nowhere in sight — the app has no router, so there is no path that
 * means "the orders tab".
 *
 * A query parameter is the way this codebase already carries a destination
 * across an external round trip (invite and password-reset links do the same),
 * and it survives the shop's redirect where in-memory state cannot.
 *
 * Returns 0 when absent or not a positive integer, so a hand-edited URL cannot
 * push anything but a plausible id into the caller.
 */
export function readWerkstattOrderParam(): number {
  try {
    const raw = (new URLSearchParams(window.location.search).get("werkstatt_order") || "").trim();
    if (!/^\d+$/.test(raw)) return 0;
    const id = Number.parseInt(raw, 10);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  } catch {
    return 0;
  }
}

/**
 * Drop a consumed deep-link parameter from the address bar.
 *
 * Without this a reload would re-open the order after the buyer had navigated
 * away, and the id would ride along into any link they shared. Mirrors the
 * `history.replaceState({}, "", "/")` the public auth flows already do once
 * their token is spent.
 */
export function clearDeepLinkParams(): void {
  try {
    if (window.location.search) window.history.replaceState({}, "", window.location.pathname);
  } catch {
    /* replaceState is unavailable in some embedded webviews; a stale query
       parameter is harmless next to throwing during boot. */
  }
}
