/**
 * Retrying a construction-report upload without ever filing it twice.
 *
 * A phone on a Baustelle loses the connection mid-upload; the app used to give
 * up on the first drop. Retrying is only safe because every attempt of one
 * submission carries the SAME Idempotency-Key, so a retry after a LOST
 * RESPONSE (the server filed the report, the phone never heard) is replayed by
 * the server instead of creating a second report. These pin exactly that: the
 * key is constant across attempts, only a dropped connection is retried, and a
 * real HTTP answer — or a user abort — is final.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import {
  IDEMPOTENCY_KEY_HEADER,
  formDataFingerprint,
  isValidIdempotencyKey,
  keyForSubmission,
  newIdempotencyKey,
  sendUnderSubmissionKey,
  uploadWithIdempotentRetry,
} from "../utils/idempotentRetry";
import type { SubmissionKeyRef } from "../utils/idempotentRetry";

const KEY = "11111111-2222-4333-8444-555555555555";

function networkError(label: string): ApiError {
  return new ApiError(`Network request failed (${label})`, 0, null, null, "network");
}

/** A sleep that returns at once but remembers what it was asked to wait. */
function instantSleep() {
  return vi.fn(async (_ms: number) => undefined);
}

function keysSentBy(upload: ReturnType<typeof vi.fn>): string[] {
  return upload.mock.calls.map((call) => (call[0] as Record<string, string>)[IDEMPOTENCY_KEY_HEADER]);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("uploadWithIdempotentRetry", () => {
  it("retries a dropped connection with the SAME key and resolves with the late success", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(networkError("1"))
      .mockRejectedValueOnce(networkError("2"))
      .mockResolvedValueOnce({ id: 7 });
    const sleep = instantSleep();
    const onAttempt = vi.fn();

    const result = await uploadWithIdempotentRetry({ key: KEY, upload, sleep, onAttempt });

    expect(result).toEqual({ id: 7 });
    expect(upload).toHaveBeenCalledTimes(3);
    expect(keysSentBy(upload)).toEqual([KEY, KEY, KEY]);
    expect(onAttempt.mock.calls.map(([info]) => info)).toEqual([
      { attempt: 1, maxAttempts: 3 },
      { attempt: 2, maxAttempts: 3 },
      { attempt: 3, maxAttempts: 3 },
    ]);
    // Short backoff: about a second, then about three.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 3000]);
  });

  it("gives up after the last attempt and rejects with the LAST error", async () => {
    const last = networkError("3");
    const upload = vi
      .fn()
      .mockRejectedValueOnce(networkError("1"))
      .mockRejectedValueOnce(networkError("2"))
      .mockRejectedValueOnce(last);

    await expect(uploadWithIdempotentRetry({ key: KEY, upload, sleep: instantSleep() })).rejects.toBe(last);
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("resolves with the result of a success on attempt 2", async () => {
    const upload = vi.fn().mockRejectedValueOnce(networkError("1")).mockResolvedValueOnce({ id: 42 });
    const onAttempt = vi.fn();

    await expect(
      uploadWithIdempotentRetry({ key: KEY, upload, sleep: instantSleep(), onAttempt }),
    ).resolves.toEqual({ id: 42 });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(onAttempt.mock.calls.map(([info]) => info.attempt)).toEqual([1, 2]);
  });

  it.each([[400], [422], [500], [503]])("an HTTP %i is a real answer and is never retried", async (status) => {
    const answer = new ApiError(`HTTP ${status}`, status);
    const upload = vi.fn().mockRejectedValueOnce(answer);
    const sleep = instantSleep();
    const onAttempt = vi.fn();

    await expect(uploadWithIdempotentRetry({ key: KEY, upload, sleep, onAttempt })).rejects.toBe(answer);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onAttempt.mock.calls.map(([info]) => info.attempt)).toEqual([1]);
  });

  it("a user abort is never retried", async () => {
    const aborted = new ApiError("Upload aborted", 0, null, null, "abort");
    const upload = vi.fn().mockRejectedValueOnce(aborted);
    const sleep = instantSleep();

    await expect(uploadWithIdempotentRetry({ key: KEY, upload, sleep })).rejects.toBe(aborted);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("a status-0 error without the network code is not retried either — the code decides, not the status", async () => {
    const unknown = new ApiError("Something status-0", 0);
    const upload = vi.fn().mockRejectedValueOnce(unknown);

    await expect(uploadWithIdempotentRetry({ key: KEY, upload, sleep: instantSleep() })).rejects.toBe(unknown);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("an error that is not an ApiError at all is not retried", async () => {
    const broken = new TypeError("Failed to construct 'FormData'");
    const upload = vi.fn().mockRejectedValueOnce(broken);

    await expect(uploadWithIdempotentRetry({ key: KEY, upload, sleep: instantSleep() })).rejects.toBe(broken);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("the injected delays decide how many attempts there are", async () => {
    const upload = vi.fn().mockRejectedValue(networkError("always"));
    const sleep = instantSleep();

    await expect(
      uploadWithIdempotentRetry({ key: KEY, upload, sleep, retryDelaysMs: [5] }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([5]);
  });

  it("announces a retry BEFORE waiting, so the UI can say so during the backoff", async () => {
    const order: string[] = [];
    const upload = vi.fn(async () => {
      order.push("upload");
      if (order.filter((entry) => entry === "upload").length < 2) throw networkError("1");
      return { id: 1 };
    });
    const sleep = vi.fn(async (ms: number) => {
      order.push(`sleep ${ms}`);
    });
    const onAttempt = vi.fn(({ attempt }: { attempt: number }) => {
      order.push(`attempt ${attempt}`);
    });

    await uploadWithIdempotentRetry({ key: KEY, upload, sleep, onAttempt });

    expect(order).toEqual(["attempt 1", "upload", "attempt 2", "sleep 1000", "upload"]);
  });

  it("refuses a key the server would refuse, before sending anything", async () => {
    const upload = vi.fn();
    await expect(uploadWithIdempotentRetry({ key: "not a key!", upload })).rejects.toThrow(/idempotency key/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it("really waits the backoff with the default sleep", async () => {
    vi.useFakeTimers();
    const upload = vi
      .fn()
      .mockRejectedValueOnce(networkError("1"))
      .mockRejectedValueOnce(networkError("2"))
      .mockResolvedValueOnce({ id: 3 });

    const pending = uploadWithIdempotentRetry({ key: KEY, upload });
    // Attach the handler now: the promise must not be observed as unhandled
    // while the fake clock is being advanced.
    const settled = expect(pending).resolves.toEqual({ id: 3 });

    await vi.advanceTimersByTimeAsync(0);
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(upload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(upload).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(upload).toHaveBeenCalledTimes(3);

    await settled;
  });
});

describe("newIdempotencyKey", () => {
  const SERVER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

  it("produces a key the server accepts, and a different one each time", () => {
    const first = newIdempotencyKey();
    const second = newIdempotencyKey();
    expect(first).toMatch(SERVER_PATTERN);
    expect(isValidIdempotencyKey(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("still produces a valid key on a WebView without crypto.randomUUID", () => {
    const bytes = new Uint8Array(16);
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => {
        array.set(bytes.map((_, index) => (index * 37 + 11) % 256));
        return array;
      },
    });
    const key = newIdempotencyKey();
    expect(key).toMatch(SERVER_PATTERN);
    expect(isValidIdempotencyKey(key)).toBe(true);
  });

  it("still produces a valid key with no crypto object at all", () => {
    vi.stubGlobal("crypto", undefined);
    const key = newIdempotencyKey();
    expect(key).toMatch(SERVER_PATTERN);
    expect(newIdempotencyKey()).not.toBe(key);
  });

  it("rejects what the server would reject", () => {
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("a".repeat(65))).toBe(false);
    expect(isValidIdempotencyKey("has space")).toBe(false);
    expect(isValidIdempotencyKey("umlaut-ä")).toBe(false);
    expect(isValidIdempotencyKey("a".repeat(64))).toBe(true);
  });
});

describe("keyForSubmission", () => {
  it("mints a key for a new submission", () => {
    const submission = keyForSubmission(null, "fp-1");
    expect(isValidIdempotencyKey(submission.key)).toBe(true);
    expect(submission.fingerprint).toBe("fp-1");
  });

  it("keeps the key while the contents are unchanged — a manual re-send replays, it does not duplicate", () => {
    const first = keyForSubmission(null, "fp-1");
    expect(keyForSubmission(first, "fp-1")).toBe(first);
  });

  it("mints a fresh key once the contents differ — that is a new report, not a replay", () => {
    const first = keyForSubmission(null, "fp-1");
    const second = keyForSubmission(first, "fp-2");
    expect(second.key).not.toBe(first.key);
    expect(second.fingerprint).toBe("fp-2");
  });
});

describe("sendUnderSubmissionKey — the key's life on the form", () => {
  function formRef(): SubmissionKeyRef {
    return { current: null };
  }

  /** A sender that answers with the key it was handed, so tests can compare keys across Sends. */
  function echoingSend() {
    return vi.fn(async (key: string) => key);
  }

  it("mints a key on the first Send and hands that key to the sender", async () => {
    const keyRef = formRef();
    const send = echoingSend();

    const key = await sendUnderSubmissionKey(keyRef, "fp-1", send);

    expect(isValidIdempotencyKey(key)).toBe(true);
    expect(send).toHaveBeenCalledWith(key);
  });

  it("is spent on success: the next Send of even identical contents is a new report", async () => {
    const keyRef = formRef();
    const send = echoingSend();

    const first = await sendUnderSubmissionKey(keyRef, "fp-1", send);
    expect(keyRef.current).toBeNull();
    const second = await sendUnderSubmissionKey(keyRef, "fp-1", send);

    expect(second).not.toBe(first);
  });

  it.each([
    ["a 500 after the commit (a Telegram or PDF step failed)", new ApiError("Telegram failed", 500)],
    ["a 4xx", new ApiError("Unprocessable", 422)],
    ["a dropped connection", new ApiError("Network request failed", 0, null, null, "network")],
    ["a user abort", new ApiError("Upload aborted", 0, null, null, "abort")],
    ["a client-side crash", new TypeError("boom")],
  ])("survives %s, so the unchanged re-send replays instead of filing a duplicate", async (_label, error) => {
    const keyRef = formRef();
    const send = vi.fn().mockRejectedValueOnce(error).mockImplementationOnce(async (key: string) => key);

    await expect(sendUnderSubmissionKey(keyRef, "fp-1", send)).rejects.toBe(error);
    expect(keyRef.current).not.toBeNull();
    const firstKey = send.mock.calls[0][0];

    await expect(sendUnderSubmissionKey(keyRef, "fp-1", send)).resolves.toBe(firstKey);
    expect(keyRef.current).toBeNull();
  });

  it("after a failure, changed contents get a new key — that is a different report", async () => {
    const keyRef = formRef();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Unprocessable", 422))
      .mockImplementationOnce(async (key: string) => key);

    await expect(sendUnderSubmissionKey(keyRef, "fp-1", send)).rejects.toBeInstanceOf(ApiError);
    const firstKey = send.mock.calls[0][0];

    await expect(sendUnderSubmissionKey(keyRef, "fp-2", send)).resolves.not.toBe(firstKey);
  });

  it("a form reset (the ref emptied, as resetReportFormFields does) ends the submission: identical contents get a new key", async () => {
    const keyRef = formRef();
    const send = vi.fn().mockRejectedValueOnce(networkError("1")).mockImplementationOnce(async (key: string) => key);

    await expect(sendUnderSubmissionKey(keyRef, "fp-1", send)).rejects.toBeInstanceOf(ApiError);
    const firstKey = send.mock.calls[0][0];
    keyRef.current = null;

    await expect(sendUnderSubmissionKey(keyRef, "fp-1", send)).resolves.not.toBe(firstKey);
  });
});

describe("formDataFingerprint", () => {
  function photo(name: string, bytes: string, lastModified = 1_700_000_000_000): File {
    return new File([bytes], name, { type: "image/jpeg", lastModified });
  }

  function report(overrides: { payload?: string; photos?: File[] } = {}): FormData {
    const form = new FormData();
    form.set("report_date", "2026-09-17");
    form.set("payload", overrides.payload ?? '{"work_done":"Zähler getauscht"}');
    for (const file of overrides.photos ?? [photo("a.jpg", "aaaa")]) form.append("images", file, file.name);
    return form;
  }

  it("is the same for the same contents", () => {
    expect(formDataFingerprint(report())).toBe(formDataFingerprint(report()));
  });

  it("changes when a text field changes", () => {
    expect(formDataFingerprint(report({ payload: '{"work_done":"Zähler geprüft"}' }))).not.toBe(
      formDataFingerprint(report()),
    );
  });

  it("identifies a photo by name, size and modification time without reading it", () => {
    const same = formDataFingerprint(report({ photos: [photo("a.jpg", "zzzz")] }));
    expect(same).toBe(formDataFingerprint(report()));
    expect(formDataFingerprint(report({ photos: [photo("a.jpg", "aaaaa")] }))).not.toBe(same);
    expect(formDataFingerprint(report({ photos: [photo("a.jpg", "aaaa", 1)] }))).not.toBe(same);
    expect(formDataFingerprint(report({ photos: [photo("b.jpg", "aaaa")] }))).not.toBe(same);
  });

  it("changes when a photo is added or removed", () => {
    const one = formDataFingerprint(report());
    const two = formDataFingerprint(report({ photos: [photo("a.jpg", "aaaa"), photo("b.jpg", "bb")] }));
    const none = formDataFingerprint(report({ photos: [] }));
    expect(new Set([one, two, none]).size).toBe(3);
  });
});
