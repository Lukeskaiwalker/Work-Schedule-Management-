/**
 * Redirects `/api` traffic to the configured server, inside the native shell only.
 *
 * WHY PATCH THE GLOBALS INSTEAD OF EDITING CALL SITES
 *
 * The SPA reaches the API from roughly thirty places, and only some of them go
 * through `apiFetch`. The rest are bare `fetch("/api/...")` calls spread across
 * a 9k-line component, plus one `XMLHttpRequest` (upload progress needs it —
 * `fetch` still cannot report it) and one `EventSource`.
 *
 * Rewriting each of those would work today and rot tomorrow. The next
 * hand-written `fetch("/api/...")` would type-check, pass review, work in every
 * browser, and fail only on the phone — the worst possible failure shape,
 * because the web is where the code gets written and tested. Wrapping the three
 * network entry points instead makes the shell correct by construction rather
 * than by vigilance, and keeps the diff off the god component entirely.
 *
 * The wrappers are pure delegation: they rewrite a URL and call the original.
 * They never swallow errors, never alter payloads, and are installed exactly
 * once, before React mounts, and never in a browser.
 */
import { IS_NATIVE_SHELL, apiUrl } from "./shell";

let installed = false;

function patchFetch(): void {
  const originalFetch = window.fetch.bind(window);

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === "string") return originalFetch(apiUrl(input), init);
    if (input instanceof URL) return originalFetch(apiUrl(input.toString()), init);

    // A Request carries method, headers and body with it, so the URL cannot be
    // swapped in place — rebuild it around the rewritten target. Skip the
    // rebuild when nothing changed, to keep the common web-shaped path free.
    const target = apiUrl(input.url);
    if (target === input.url) return originalFetch(input, init);
    return originalFetch(new Request(target, input), init);
  };
}

function patchXhr(): void {
  type XhrOpen = typeof XMLHttpRequest.prototype.open;
  const originalOpen: XhrOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const target = apiUrl(typeof url === "string" ? url : url.toString());
    // `async` defaults to true when open() is called with two arguments.
    // Forwarding a bare `undefined` would be coerced to false and run the
    // request synchronously, freezing the UI thread — so restore the default
    // explicitly rather than passing it through.
    originalOpen.call(this, method, target, async ?? true, username, password);
  } as XhrOpen;
}

function patchEventSource(): void {
  if (typeof window.EventSource !== "function") return;
  const OriginalEventSource = window.EventSource;

  class ShellEventSource extends OriginalEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(apiUrl(typeof url === "string" ? url : url.toString()), init);
    }
  }

  window.EventSource = ShellEventSource as unknown as typeof EventSource;
}

/**
 * Install the rewrites. No-op in a browser and on repeat calls — double
 * wrapping would be harmless but would rewrite an already-absolute URL twice
 * on every request for no reason.
 */
export function installNativeNetworkBridge(): void {
  if (!IS_NATIVE_SHELL || installed) return;
  installed = true;
  patchFetch();
  patchXhr();
  patchEventSource();
}
