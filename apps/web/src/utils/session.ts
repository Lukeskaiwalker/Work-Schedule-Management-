/**
 * Reading the expiry out of the session token.
 *
 * Why this exists: the API issues one access token at login and never renews it
 * — `X-Access-Token` is set only by `_issue_session` in `routers/auth.py`, and
 * there is no refresh endpoint. Its lifetime is `access_token_expire_minutes`,
 * currently 8 hours, which is exactly the length of a working day. So a session
 * that starts at the beginning of a shift dies during it, and the only recovery
 * is a fresh login.
 *
 * A page reload already handles this: App's bootstrap effect calls `/auth/me`
 * and clears the token when it fails. What was missing is expiry during a LIVE
 * session — the phone left open on a van dashboard overnight. The next morning
 * the app is still showing the workspace, the worker taps "Einstempeln", the
 * POST 401s, and a dismissible banner reading "Invalid token" is the only sign
 * anything went wrong. They then work the whole day unclocked.
 *
 * These helpers only READ the `exp` claim for that UX decision. They do not and
 * cannot verify the signature — the server remains the only authority on
 * whether a token is valid. A token we cannot parse is reported as "no known
 * expiry" rather than "expired", so a parsing quirk can never sign anyone out;
 * the 401 handler is the backstop for that case.
 */

/** Milliseconds before the real expiry at which we treat the session as done. */
const EXPIRY_SKEW_MS = 30_000;

interface JwtPayload {
  exp?: unknown;
}

function decodeSegment(segment: string): JwtPayload | null {
  try {
    // base64url -> base64, then pad to a multiple of 4.
    const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const json = atob(padded);
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * Expiry of `token` in milliseconds since the epoch, or null when unknown.
 *
 * Null means "we cannot tell" — never "expired". Callers must not sign a user
 * out on null.
 */
export function tokenExpiresAt(token: string | null): number | null {
  if (!token) return null;
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const payload = decodeSegment(segments[1]);
  if (!payload) return null;
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  // `exp` is in seconds (RFC 7519).
  return exp * 1000;
}

/**
 * Whether the session should be treated as finished.
 *
 * Applies a small skew so we act just before the server starts refusing, rather
 * than letting one more request through and surfacing a raw 401.
 */
export function isSessionExpired(token: string | null, now: number = Date.now()): boolean {
  const expiresAt = tokenExpiresAt(token);
  if (expiresAt === null) return false;
  return expiresAt - EXPIRY_SKEW_MS <= now;
}

/**
 * Milliseconds until the session should be treated as finished, or null when
 * unknown. Never negative — an already-dead session returns 0.
 */
export function millisUntilSessionExpiry(
  token: string | null,
  now: number = Date.now(),
): number | null {
  const expiresAt = tokenExpiresAt(token);
  if (expiresAt === null) return null;
  return Math.max(0, expiresAt - EXPIRY_SKEW_MS - now);
}
