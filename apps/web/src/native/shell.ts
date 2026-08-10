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

function detectStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  if (IS_NATIVE_SHELL) return false;
  // iOS Safari predates the standard and only reports the legacy flag.
  const legacy = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  const modern =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  return legacy || modern;
}

/**
 * True when the SPA is running as a home-screen app rather than a browser tab.
 *
 * It is same-origin like any tab — so requests, cookies and `/api` URLs all work
 * untouched — but it has no browser chrome, which changes one thing that matters:
 * a `target="_blank"` link cannot open "a new tab". iOS hands it to Safari
 * instead, throwing the user out of the app to read their own PDF. That is the
 * same complaint the native shell had, so it gets the same in-app viewer.
 *
 * Deliberately false inside the native shell, which has its own detection and
 * additionally needs credentials attached; here the cookie already rides along.
 */
export const IS_STANDALONE_PWA: boolean = detectStandalonePwa();

/** Surfaces where a link cannot open a tab, and files must be shown in-app. */
export const IS_APP_SURFACE: boolean = IS_NATIVE_SHELL || IS_STANDALONE_PWA;

/**
 * Accept what a person would actually type on a phone keyboard — `192.168.1.127`,
 * `smpl.local:8080`, `https://smpl.example.de/` — and return a canonical origin
 * with no trailing slash, or null if it cannot be a server address.
 *
 * Exported because the setup screen validates as the user types, and it must
 * apply exactly the rule that `apiUrl` will later rely on.
 */
/**
 * Is this host inside the local network, in the sense App Transport Security
 * uses? NSAllowsLocalNetworking permits cleartext to exactly these and nothing
 * else, so this predicate has to agree with iOS or we will hand the user a
 * scheme the OS then refuses to dial.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Crews type a bare host far more often than a full URL, so a missing scheme
  // has to be filled in — but not blindly with http://. App Transport Security
  // only exempts cleartext for local addresses (NSAllowsLocalNetworking), so
  // defaulting a public hostname to http:// produces a URL iOS refuses to load
  // at all, surfacing as "server unreachable" for what is really a scheme
  // problem. Guess by where the host lives: LAN gets http, anything else https.
  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const hostOnly = trimmed.split("/")[0].split(":")[0];
    candidate = `${isLocalHost(hostOnly) ? "http" : "https"}://${trimmed}`;
  }

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
