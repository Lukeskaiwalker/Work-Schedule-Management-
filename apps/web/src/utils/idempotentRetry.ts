/**
 * Safely retryable multipart uploads.
 *
 * WHY A KEY BEFORE ANY RETRY
 *
 * A construction report leaves a phone on a Baustelle over a rural link, and
 * the link drops. The app used to give up on the first drop — "Network request
 * failed" — because retrying blindly is worse than not retrying: after a LOST
 * RESPONSE (the server filed the report, the phone never heard back) a second
 * POST files it twice. So every attempt of one submission carries the same
 * `Idempotency-Key`, and the server replays its original answer for a key it
 * has already seen instead of creating anything. A retry after a lost
 * response is then indistinguishable from a first success, which is exactly
 * what lets the caller's success path stay as it is.
 *
 * WHAT IS RETRIED
 *
 * Only a dropped connection: an `ApiError` with status 0 AND code "network".
 * A real HTTP status is a real answer — a 422 will not pass on the second try
 * and a 500 was the server's decision; both go straight back to the user. A
 * user abort is the user's decision. Anything that is not an `ApiError` is a
 * bug in the client, not the link.
 */
import { ApiError } from "../api/client";
import { buildClientFileKey } from "./reports";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** What the server accepts: 1–64 characters of `[A-Za-z0-9_-]`. A UUID fits. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Two retries: about a second, then about three. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 3000];

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(value);
}

function randomHex(byteCount: number): string {
  const bytes =
    typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
      ? crypto.getRandomValues(new Uint8Array(byteCount))
      : Uint8Array.from({ length: byteCount }, () => Math.floor(Math.random() * 256));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A fresh key. `crypto.randomUUID` needs a secure context, which a WebView on
 * the local network over plain HTTP does not have, so this falls back to
 * random bytes from `getRandomValues`, and from there to `Math.random`. Every
 * branch yields the server's charset.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `k-${Date.now().toString(36)}-${randomHex(16)}`;
}

/** A dropped connection, as the XHR upload reports it. Nothing else is retried. */
export function isDroppedConnection(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 0 && error.code === "network";
}

export type RetryAttempt = {
  /** 1-based. */
  attempt: number;
  maxAttempts: number;
};

export type IdempotentRetryOptions<T> = {
  /** The submission's key. The same one goes on every attempt. */
  key: string;
  /** One attempt. Receives the headers that must go on the request. */
  upload: (headers: Record<string, string>, attempt: RetryAttempt) => Promise<T>;
  /**
   * Called before every attempt. For a retry that is BEFORE the backoff, so
   * the UI can already say "erneuter Versuch 2/3" while the app waits.
   */
  onAttempt?: (attempt: RetryAttempt) => void;
  /** Backoff before each retry; its length is the number of retries. */
  retryDelaysMs?: readonly number[];
  /** Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Run `upload` under one idempotency key, retrying a dropped connection.
 *
 * Resolves with the first successful result. Rejects with the error of the
 * last attempt — at once for anything that is not a dropped connection.
 */
export async function uploadWithIdempotentRetry<T>(options: IdempotentRetryOptions<T>): Promise<T> {
  const { key, upload, onAttempt, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, sleep = wait } = options;
  if (!isValidIdempotencyKey(key)) {
    throw new Error(`Invalid idempotency key: ${JSON.stringify(key)}`);
  }
  const headers = { [IDEMPOTENCY_KEY_HEADER]: key };
  const maxAttempts = retryDelaysMs.length + 1;

  for (let attempt = 1; ; attempt += 1) {
    const info: RetryAttempt = { attempt, maxAttempts };
    onAttempt?.(info);
    if (attempt > 1) await sleep(retryDelaysMs[attempt - 2]);
    try {
      return await upload(headers, info);
    } catch (error) {
      if (!isDroppedConnection(error) || attempt >= maxAttempts) throw error;
    }
  }
}

/**
 * The key of the submission on the form, tied to the contents it was minted
 * for.
 *
 * The key belongs to the SUBMISSION, not to the tap on "Senden": it stays the
 * same across the automatic retries and across a manual re-send of the same
 * unsent form — if the last attempt silently succeeded server-side, that
 * re-send must replay, not duplicate. It changes as soon as the contents
 * change, because a replay would then file the OLD contents under a green
 * "gespeichert" and drop the edit on the floor — worse than a duplicate the
 * office can delete.
 */
export type SubmissionKey = {
  key: string;
  fingerprint: string;
};

export function keyForSubmission(previous: SubmissionKey | null, fingerprint: string): SubmissionKey {
  if (previous && previous.fingerprint === fingerprint) return previous;
  return { key: newIdempotencyKey(), fingerprint };
}

/**
 * What the form is about to send, as a string that is equal for equal
 * contents. A file counts by name, size and modification time — enough to
 * tell "the same photos" from "one removed" without reading megabytes.
 */
export function formDataFingerprint(form: FormData): string {
  return Array.from(form.entries(), ([name, value]) =>
    JSON.stringify([name, typeof value === "string" ? value : buildClientFileKey(value)]),
  ).join("\n");
}

/** The cell the form keeps its submission key in — a React ref fits. */
export type SubmissionKeyRef = { current: SubmissionKey | null };

/**
 * Run one Send under the form's submission key.
 *
 * `keyRef` outlives the call: it is the ref the form owns. The key in it is
 * minted on the first Send for these contents, handed to `send` on every Send
 * of the same contents, and spent only when `send` RESOLVES — the server has
 * the report, so the next Send is a new one. The other way a key ends is a
 * form reset, which empties the ref.
 *
 * It is kept on EVERY failure, whatever the status:
 *
 * - status 0: no answer. The server may have filed the report; only a re-send
 *   under the same key is safe.
 * - 5xx: the one that matters happens AFTER the commit — the create endpoint
 *   runs processing inline after db.commit, and a Telegram or PDF step can
 *   fail there. Dropping the key on that 500 would make the next Send of the
 *   unchanged form file the report a second time: precisely the duplicate this
 *   key exists to prevent. Kept, that re-send is a replay.
 * - 4xx: the user has to change something, which changes the fingerprint and
 *   mints a new key anyway. An unchanged re-send finds no stored key on the
 *   server and is created normally.
 *
 * A replay can never be a bad or stale answer — the server only replays a
 * report it actually created — so there is no case where keeping the key
 * hurts, and "stuck on a replay" is not a failure mode.
 */
export async function sendUnderSubmissionKey<T>(
  keyRef: SubmissionKeyRef,
  fingerprint: string,
  send: (key: string) => Promise<T>,
): Promise<T> {
  const submission = keyForSubmission(keyRef.current, fingerprint);
  keyRef.current = submission;
  const result = await send(submission.key);
  keyRef.current = null;
  return result;
}
