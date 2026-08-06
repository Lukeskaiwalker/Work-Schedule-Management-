export const API_BASE = "/api";

export class ApiError extends Error {
  status: number;
  detail: unknown;
  body: unknown;

  constructor(message: string, status: number, detail: unknown = null, body: unknown = null) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.body = body;
  }
}

function authHeader(token: string | null): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Called when the server rejects an authenticated request as unauthenticated.
 *
 * The API issues one 8-hour token at login and has no refresh endpoint, so a
 * 401 on a request that DID carry a token means the session is over and cannot
 * be recovered without signing in again. Before this hook existed, every call
 * site caught that 401 and rendered `detail` — the literal string "Invalid
 * token" — as a dismissible banner while the app carried on looking signed in.
 * A worker could tap "Einstempeln", miss the banner, and work an entire day
 * unclocked.
 *
 * Registered once by App. Module-level rather than React state because
 * `apiFetch` is a plain function used from everywhere, including outside
 * components.
 */
type UnauthorizedHandler = () => void;

let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

function reportUnauthorized(token: string | null, status: number): void {
  // Only for requests that actually presented a token. A 401 from /auth/login
  // means "wrong password" and must stay on the login form; signing the user
  // out there would be nonsense.
  if (status !== 401 || !token) return;
  unauthorizedHandler?.();
}

export type UploadProgress = {
  loaded: number;
  total: number | null;
  percent: number | null;
};

export async function apiFetch<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...authHeader(token),
      ...(options.headers ?? {}),
    },
    credentials: "include",
  });

  if (!response.ok) {
    reportUnauthorized(token, response.status);
    let detail: unknown = response.statusText;
    let body: unknown = null;
    try {
      const data = await response.json();
      body = data;
      detail = data.detail ?? detail;
    } catch {
      // no-op
    }
    const message =
      typeof detail === "string"
        ? detail
        : typeof (detail as { message?: unknown } | null)?.message === "string"
          ? String((detail as { message: string }).message)
          : response.statusText || `HTTP ${response.status}`;
    throw new ApiError(message, response.status, detail, body);
  }

  // 204 No Content carries no body, but FastAPI still sends
  // `content-type: application/json` on endpoints declared `status_code=204`.
  // Parsing that empty body throws — in WebKit with the message "The string
  // did not match the expected pattern.", which surfaced to users as a red
  // error banner on actions that had in fact succeeded (deleting a line from a
  // construction box was the reported case). Because the throw happened before
  // the caller's refetch, the deleted row also stayed on screen until some
  // later action refreshed it.
  //
  // 205 and 304 are likewise defined as bodiless, so they get the same guard.
  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return {} as T;
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json() as Promise<T>;
  }
  return {} as T;
}

export async function apiUploadWithProgress<T>(
  path: string,
  token: string | null,
  body: FormData,
  onProgress?: (progress: UploadProgress) => void,
  method = "POST",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(method, `${API_BASE}${path}`, true);
    request.withCredentials = true;
    if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);

    request.upload.onprogress = (event) => {
      if (!onProgress) return;
      const total = event.lengthComputable ? event.total : null;
      const percent = total && total > 0 ? Math.min(100, Math.round((event.loaded / total) * 100)) : null;
      onProgress({ loaded: event.loaded, total, percent });
    };

    request.onerror = () => {
      reject(new ApiError("Network request failed", 0));
    };
    request.onabort = () => {
      reject(new ApiError("Upload aborted", 0));
    };
    request.onload = () => {
      const status = request.status;
      const contentType = request.getResponseHeader("content-type") ?? "";
      const responseText = request.responseText ?? "";

      if (status < 200 || status >= 300) {
        let detail: unknown = request.statusText || `HTTP ${status}`;
        let body: unknown = null;
        if (contentType.includes("application/json")) {
          try {
            const data = JSON.parse(responseText);
            body = data;
            detail = data.detail ?? detail;
          } catch {
            // no-op
          }
        }
        const message =
          typeof detail === "string"
            ? detail
            : typeof (detail as { message?: unknown } | null)?.message === "string"
              ? String((detail as { message: string }).message)
              : request.statusText || `HTTP ${status}`;
        reject(new ApiError(message, status, detail, body));
        return;
      }

      if (contentType.includes("application/json")) {
        try {
          resolve(JSON.parse(responseText) as T);
          return;
        } catch {
          // no-op
        }
      }
      resolve({} as T);
    };

    request.send(body);
  });
}
