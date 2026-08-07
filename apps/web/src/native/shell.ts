/**
 * Native-shell awareness for the iOS app.
 *
 * On the web the SPA is served by the same Caddy that reverse-proxies `/api/*`
 * to FastAPI, so every request is same-origin: no CORS preflight, no hostname
 * baked into the bundle, and exactly one thing to configure at deploy time.
 * Nothing in this module changes that — in a browser `apiUrl` is the identity
 * function and `IS_NATIVE_SHELL` is false, so the web build behaves as before.
 *
 * The iOS shell is different by construction. Capacitor serves the bundled SPA
 * from `capacitor://localhost` instead of from the server, and that is the
 * whole point: a custom scheme is a SECURE CONTEXT, so `getUserMedia` is
 * permitted and the barcode scanner finally runs against a server that only
 * speaks plain http on the LAN. In mobile Safari over http:// the camera is
 * blocked outright — that is the `insecure_context` branch in
 * CameraScannerSheet, and in the app it becomes unreachable.
 *
 * The price of that trade is that `/api/...` no longer resolves to the server;
 * it resolves to the app bundle, which does not contain an API. So the shell
 * has to know the one thing the web never needs to: which server this device
 * talks to.
 */

const SERVER_URL_KEY = "smpl.server_url";

type CapacitorGlobal = { isNativePlatform?: () => boolean };

declare global {
  interface Window {
    Capacitor?: CapacitorGlobal;
  }
}

function detectNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  // Capacitor injects this global before any app code runs.
  if (window.Capacitor?.isNativePlatform?.() === true) return true;
  // Belt and braces: the custom scheme is ours alone.
  return window.location.protocol === "capacitor:";
}

/** True only inside the native iOS shell. Always false in a browser. */
export const IS_NATIVE_SHELL: boolean = detectNativeShell();

/**
 * Accept what a person would actually type on a phone keyboard — `192.168.1.127`,
 * `smpl.local:8080`, `https://smpl.example.de/` — and return a canonical origin
 * with no trailing slash, or null if it cannot be a server address.
 *
 * Exported because the setup screen validates as the user types, and it must
 * apply exactly the rule that `apiUrl` will later rely on.
 */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Crews type a bare IP far more often than a full URL.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;

  // Keep a sub-path if the deployment has one, but never a trailing slash:
  // callers concatenate "/api/..." straight onto this.
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/**
 * Baked in at build time so a fresh install can reach the usual server without
 * anyone typing an IP address on a phone. Still fully overridable at runtime —
 * this is a default, not a lock.
 */
const BUILT_IN_SERVER_URL: string | null = normalizeServerUrl(
  import.meta.env.VITE_SMPL_SERVER_URL ?? "",
);

function readStoredServerUrl(): string | null {
  try {
    const stored = window.localStorage.getItem(SERVER_URL_KEY);
    return stored ? normalizeServerUrl(stored) : null;
  } catch {
    // Storage can be unavailable (private mode, storage pressure). Falling
    // back to the built-in default beats refusing to start.
    return null;
  }
}

let serverUrl: string | null = IS_NATIVE_SHELL
  ? (readStoredServerUrl() ?? BUILT_IN_SERVER_URL)
  : null;

/** The server this device talks to, or null on the web (where it is implicit). */
export function getServerUrl(): string | null {
  return serverUrl;
}

/** Persist a new server address. Returns the stored form, or null if invalid. */
export function setServerUrl(raw: string): string | null {
  const normalized = normalizeServerUrl(raw);
  if (!normalized) return null;
  serverUrl = normalized;
  try {
    window.localStorage.setItem(SERVER_URL_KEY, normalized);
  } catch {
    // Non-fatal: the address still applies for this launch.
  }
  return normalized;
}

/** Forget the server, sending the shell back to the setup screen. */
export function clearServerUrl(): void {
  serverUrl = null;
  try {
    window.localStorage.removeItem(SERVER_URL_KEY);
  } catch {
    // Non-fatal.
  }
}

/** True when the app cannot reach anything until the user names a server. */
export function needsServerSetup(): boolean {
  return IS_NATIVE_SHELL && serverUrl === null;
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Point an app-relative API URL at the configured server.
 *
 * Identity on the web, and identity in the shell for anything that is not an
 * `/api` path — SPA routes like `/admin` must keep resolving inside the bundle,
 * or navigation would try to load the server's HTML instead of the app's.
 *
 * Accepts both the relative form (`/api/files/1/preview`) and the already
 * resolved same-origin form (`capacitor://localhost/api/files/1/preview`),
 * because `Request.url` and `XMLHttpRequest` hand us the latter.
 */
export function apiUrl(raw: string): string {
  if (!IS_NATIVE_SHELL || serverUrl === null) return raw;

  let parsed: URL;
  try {
    parsed = new URL(raw, window.location.href);
  } catch {
    return raw;
  }

  // Compare protocol+host rather than `origin`: WebKit reports `origin` as
  // "null" for some custom schemes, which would make every URL look remote.
  const isOwnOrigin =
    parsed.protocol === window.location.protocol && parsed.host === window.location.host;
  if (!isOwnOrigin) return raw;
  if (!isApiPath(parsed.pathname)) return raw;

  return `${serverUrl}${parsed.pathname}${parsed.search}${parsed.hash}`;
}
