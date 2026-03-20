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
