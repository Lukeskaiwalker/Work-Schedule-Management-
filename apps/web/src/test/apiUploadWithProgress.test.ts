/**
 * The XHR multipart upload, driven through a fake XMLHttpRequest.
 *
 * Two things matter here beyond "it uploads": an extra header (the report's
 * Idempotency-Key) reaches `setRequestHeader`, and a dropped connection is
 * distinguishable from a user abort by a machine-readable `code` rather than
 * by comparing message strings. The messages themselves are pinned unchanged
 * — App.tsx maps status 0 to its German "Verbindung unterbrochen" text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiUploadWithProgress } from "../api/client";

type ProgressLike = { lengthComputable: boolean; loaded: number; total: number };

class FakeXhr {
  static instances: FakeXhr[] = [];

  method = "";
  url = "";
  async: boolean | undefined = undefined;
  headers: Record<string, string> = {};
  withCredentials = false;
  /** The browser default. The upload must never set one — rural links. */
  timeout = 0;
  status = 0;
  statusText = "";
  responseText = "";
  sent: unknown = null;
  private responseHeaders: Record<string, string> = {};

  upload: { onprogress: ((event: ProgressLike) => void) | null } = { onprogress: null };
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(method: string, url: string, async?: boolean) {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  send(body: unknown) {
    this.sent = body;
  }

  /** The server answers. */
  respond(status: number, body: string, contentType = "application/json") {
    this.status = status;
    this.statusText = status === 200 ? "OK" : "";
    this.responseText = body;
    this.responseHeaders["content-type"] = contentType;
    this.onload?.();
  }
}

function lastRequest(): FakeXhr {
  const request = FakeXhr.instances[FakeXhr.instances.length - 1];
  if (!request) throw new Error("no XMLHttpRequest was created");
  return request;
}

beforeEach(() => {
  FakeXhr.instances = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiUploadWithProgress", () => {
  it("sets the extra headers on the request — the Idempotency-Key reaches setRequestHeader", async () => {
    const form = new FormData();
    const pending = apiUploadWithProgress<{ id: number }>("/construction-reports", "tok-1", form, undefined, "POST", {
      headers: { "Idempotency-Key": "abc-123" },
    });
    const request = lastRequest();

    expect(request.method).toBe("POST");
    expect(request.url).toBe("/api/construction-reports");
    expect(request.async).toBe(true);
    expect(request.withCredentials).toBe(true);
    expect(request.headers).toEqual({ Authorization: "Bearer tok-1", "Idempotency-Key": "abc-123" });
    expect(request.sent).toBe(form);

    request.respond(200, '{"id":1}');
    await expect(pending).resolves.toEqual({ id: 1 });
  });

  it("deliberately sets no timeout", async () => {
    const pending = apiUploadWithProgress("/construction-reports", "tok", new FormData());
    const request = lastRequest();
    expect(request.timeout).toBe(0);
    request.respond(200, "{}");
    await pending;
  });

  it("still works for callers that pass no options", async () => {
    const pending = apiUploadWithProgress<{ ok: boolean }>("/projects/3/files", null, new FormData());
    const request = lastRequest();
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({});
    request.respond(200, '{"ok":true}');
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("a dropped connection rejects with status 0 and code 'network', message unchanged", async () => {
    const pending = apiUploadWithProgress("/construction-reports", "tok", new FormData());
    lastRequest().onerror?.();

    const error = await pending.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: "network", message: "Network request failed" });
  });

  it("a user abort rejects with status 0 and code 'abort', message unchanged", async () => {
    const pending = apiUploadWithProgress("/construction-reports", "tok", new FormData());
    lastRequest().onabort?.();

    const error = await pending.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, code: "abort", message: "Upload aborted" });
  });

  it("a 2xx JSON body resolves parsed", async () => {
    const pending = apiUploadWithProgress<{ id: number; processing_status: string }>(
      "/construction-reports",
      "tok",
      new FormData(),
    );
    lastRequest().respond(201, '{"id":9,"processing_status":"queued"}');
    await expect(pending).resolves.toEqual({ id: 9, processing_status: "queued" });
  });

  it("a 4xx rejects with that status and the server's detail, and carries no network code", async () => {
    const pending = apiUploadWithProgress("/construction-reports", "tok", new FormData());
    lastRequest().respond(422, '{"detail":"Bitte ein Datum angeben"}');

    const error = await pending.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, message: "Bitte ein Datum angeben" });
    expect((error as ApiError).code).toBeUndefined();
  });

  it("reports upload progress as a percentage when the total is known", async () => {
    const onProgress = vi.fn();
    const pending = apiUploadWithProgress("/construction-reports", "tok", new FormData(), onProgress);
    const request = lastRequest();
    request.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 200 });
    request.upload.onprogress?.({ lengthComputable: false, loaded: 60, total: 0 });
    request.respond(200, "{}");
    await pending;

    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      { loaded: 50, total: 200, percent: 25 },
      { loaded: 60, total: null, percent: null },
    ]);
  });
});
