export const API_BASE = "/api";

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
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
    let detail = response.statusText;
    try {
      const data = await response.json();
      detail = data.detail ?? detail;
    } catch {
      // no-op
    }
    throw new ApiError(detail, response.status);
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
        let detail = request.statusText || `HTTP ${status}`;
        if (contentType.includes("application/json")) {
          try {
            const data = JSON.parse(responseText);
            detail = data.detail ?? detail;
          } catch {
            // no-op
          }
        }
        reject(new ApiError(detail, status));
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
