/**
 * Opening server files in-app, for surfaces where a link cannot open a tab.
 *
 * Two of those exist: the native iOS shell, and the SPA installed to the home
 * screen as a PWA. They fail differently and only the shell has the auth
 * problem, but the user-visible symptom is identical — tapping a file throws you
 * out into Safari to read your own PDF.
 *
 * On the web an `<a href="/api/files/12/preview" target="_blank">` is the whole
 * feature: the tab is same-origin, the session cookie rides along, and the
 * browser renders the PDF. Neither half of that survives in the shell.
 *
 *   - The link is cross-origin, so WKWebView hands it to the system browser
 *     instead of opening it in the app — which is what the crew sees as "it
 *     tries to open Safari".
 *   - Even if it opened, an `<a>` cannot carry an Authorization header, and the
 *     cookie is SameSite=Strict so it is not sent cross-site either. The server
 *     answers 401. (Verified against the running API: an unauthenticated
 *     /api/files/1/preview returns 401.)
 *
 * So the shell has to fetch the bytes itself, with the bearer token, and render
 * them in-app. This module is the interception half: it catches clicks on links
 * that point at the API and hands them to whatever viewer has registered.
 *
 * Wholesale interception rather than rewriting ~20 call sites, for the same
 * reason the network bridge wraps fetch: the next `<a href={filePreviewUrl(id)}>`
 * someone adds would work on the web, pass review, and silently bounce to Safari
 * only on a phone.
 *
 * The PWA case is simpler: it is same-origin, so the session cookie still rides
 * along and only the navigation needs intercepting. The shell additionally has
 * to attach the bearer token, which is what fetchFile does for both.
 *
 * Inert in a browser tab — nothing is installed and every link behaves as
 * before.
 */
import { IS_APP_SURFACE, getServerUrl } from "./shell";

export type OpenFileRequest = {
  /** Absolute URL of the file on the configured server. */
  url: string;
  /** Best-effort display name, from the link text or the URL. */
  name: string;
};

type OpenHandler = (request: OpenFileRequest) => void;

let handler: OpenHandler | null = null;
let installed = false;

/** Registered by the viewer. Only one viewer exists, so last registration wins. */
export function setFileOpenHandler(next: OpenHandler | null): void {
  handler = next;
}

/** Bearer token the SPA stores at login. Read lazily: it changes on re-login. */
export function currentToken(): string | null {
  try {
    return window.localStorage.getItem("smpl_token");
  } catch {
    return null;
  }
}

function isApiFileUrl(raw: string): boolean {
  const server = getServerUrl();
  if (server) {
    // Native shell: links were absolutised to the configured server by apiUrl().
    if (!raw.startsWith(server)) return false;
    return raw.slice(server.length).startsWith("/api/");
  }

  // Installed PWA: no rewriting happened, so the link is same-origin. Only
  // intercept our own /api paths — an external link should still leave the app.
  try {
    const parsed = new URL(raw, window.location.href);
    const sameOrigin =
      parsed.protocol === window.location.protocol && parsed.host === window.location.host;
    return sameOrigin && parsed.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function nameFor(anchor: HTMLAnchorElement, url: string): string {
  const explicit = anchor.getAttribute("download");
  if (explicit) return explicit;
  const text = (anchor.textContent ?? "").trim();
  // Link text is often a real filename ("Bericht.pdf"); prefer it when it looks
  // like one, otherwise fall back to the last path segment.
  if (/\.[a-z0-9]{2,5}$/i.test(text)) return text;
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
  } catch {
    // fall through
  }
  return text || "Datei";
}

/**
 * Catch clicks on API links before the WebView can navigate.
 *
 * Capture phase so it runs ahead of any component's own onClick, and only for
 * plain primary clicks — a modifier-click means the user deliberately asked for
 * something else, and there is nothing to intercept on a non-API link.
 */
export function installNativeFileOpener(): void {
  if (!IS_APP_SURFACE || installed) return;
  installed = true;

  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;
      // `anchor.href` is already resolved against the document, which is what
      // apiUrl() produced for these links.
      const url = anchor.href;
      if (!isApiFileUrl(url)) return;
      if (!handler) return;

      event.preventDefault();
      event.stopPropagation();
      handler({ url, name: nameFor(anchor as HTMLAnchorElement, url) });
    },
    true,
  );
}

export type FetchedFile = {
  objectUrl: string;
  contentType: string;
  size: number;
  name: string;
  /**
   * The bytes themselves, so a caller that needs the content rather than a URL
   * can read it directly.
   *
   * Handing back only an object URL forced the text viewer to re-`fetch()` its
   * own blob, and `fetch("blob:…")` is governed by `connect-src` — which lists
   * 'self' and the Nominatim host, not `blob:`. So the read was refused by the
   * CSP and the rejection escaped into the caller's error path, meaning every
   * .txt, .json, .csv and .log file failed to open with a generic "could not be
   * loaded" and no way to save it. Keeping the Blob makes that read a local
   * operation that no policy governs.
   */
  blob: Blob;
};

/**
 * Download a server file with the session token and hand back an object URL.
 *
 * The caller owns the returned `objectUrl` and must revoke it — object URLs are
 * held for the lifetime of the document otherwise, and a report photo is
 * several megabytes.
 */
export async function fetchFile(request: OpenFileRequest): Promise<FetchedFile> {
  const token = currentToken();
  const response = await fetch(request.url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(String(response.status));
  }

  const blob = await response.blob();
  // Trust the server's Content-Type over the blob's: the API sets it explicitly
  // and sends X-Content-Type-Options: nosniff.
  const contentType = (response.headers.get("content-type") ?? blob.type ?? "").split(";")[0].trim();

  // Content-Disposition carries the real filename; it is exposed to JS via the
  // API's CORS expose_headers, so it is readable here.
  let name = request.name;
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match?.[1]) {
    try {
      name = decodeURIComponent(match[1]);
    } catch {
      name = match[1];
    }
  }

  return { objectUrl: URL.createObjectURL(blob), contentType, size: blob.size, name, blob };
}


/**
 * Fetch any same-app URL with the bearer token and hand back an object URL.
 * Used by the viewer's paged-PDF mode, where every page image needs the same
 * auth treatment as the document itself. Caller revokes the URL.
 */
export async function fetchAuthorizedBlobUrl(url: string): Promise<string> {
  const token = currentToken();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(String(response.status));
  }
  return URL.createObjectURL(await response.blob());
}

/** JSON variant of the authorized fetch, for tiny metadata endpoints. */
export async function fetchAuthorizedJson<T>(url: string): Promise<T> {
  const token = currentToken();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(String(response.status));
  }
  return (await response.json()) as T;
}
