// API client for the Raspberry Pi scan station ("Pi-Station").
//
// The station is a Pi in the office running `tools/label_agent/server.py`: a
// barcode scanner (HID keyboard), a Brother PT-P710BT over USB, and — later —
// Benning/Metrel device imports off an SD card. SMPL never talks to the Pi
// directly from the browser: the Pi is on the LAN, the browser may not be, and
// the agent has no authentication of its own (see the agent README, "No
// authentication"). Everything here goes through the SMPL API, which holds the
// pairing secret and proxies to the agent.
//
// ── Endpoint contract ────────────────────────────────────────────────────
// All paths are relative to `/api` (apiFetch prefixes it).
//
//   GET    /station/stations                              → StationListResponse
//   PATCH  /station/stations/{id}                         → Station
//   DELETE /station/stations/{id}                         → 204 (unpair)
//   POST   /station/stations/{id}/refresh                 → Station
//   POST   /station/stations/{id}/test-print              → StationActionResult
//   POST   /station/stations/{id}/restart                 → StationActionResult
//   GET    /station/stations/{id}/sessions                → StationSessionListResponse
//   POST   /station/stations/{id}/sessions/{name}/import  → StationImportResult
//   POST   /station/pairing                               → StationPairing
//   GET    /station/pairing/{code}                        → StationPairing
//   DELETE /station/pairing/{code}                        → 204 (revoke)
//   GET    /station/setup                                 → StationSetup
//
// The collection is `/station/stations` and not `/station/{id}` on purpose:
// `/station/pairing` and `/station/setup` would otherwise collide with an int
// path parameter, and FastAPI answers that collision with a 422 rather than
// falling through to the next route.
//
// Gating: everything here is `canManageSystem` territory (admin only). The
// restart endpoint additionally requires `{"confirm": true}` in the body so a
// stray POST cannot bounce the agent mid-inventory.
//
// Every call is time-boxed. `fetch` has no default timeout, and the most
// likely failure here is not an error response but a Pi that is simply not
// answering — an un-timed request would leave the page spinning forever.

import { ApiError, apiFetch } from "../api/client";

const BASE = "/station";

/** Reads and status polls: short, because the page polls them on a timer. */
const READ_TIMEOUT_MS = 12_000;
/** Hardware actions: a label physically feeds for ~2 s, a restart longer. */
const ACTION_TIMEOUT_MS = 30_000;

/** Status 0 marks "never reached the server" — timeout, offline, DNS, CORS. */
export const STATION_NETWORK_STATUS = 0;

// ── Types ────────────────────────────────────────────────────────────────

/**
 * How fresh the agent's last check-in is, as judged by the server.
 *
 * `stale` exists because "offline" is too strong for a Pi that missed one
 * heartbeat: the agent's own `/health` answers from a 2-second cache and the
 * box may simply be busy feeding tape.
 */
export type StationStatus = "online" | "stale" | "offline" | "unknown";

export interface StationHardware {
  printer_connected: boolean;
  /** Model string as the agent reports it, e.g. "Brother PT-P710BT". */
  printer_model: string | null;
  /** Tape width the printer senses, in mm. 12 mm is the common stock. */
  media_width_mm: number | null;
  /** Human-readable reason the printer is unusable, if it is. */
  printer_error: string | null;
  scanner_present: boolean;
  scanner_name: string | null;
  /** True when the agent runs with `--no-printer` (prints are simulated). */
  simulated: boolean;
}

export interface Station {
  id: number;
  name: string;
  location: string | null;
  status: StationStatus;
  agent_version: string | null;
  /** Agent process uptime in seconds, not host uptime. */
  uptime_seconds: number | null;
  /** LAN address the agent reported at check-in, for the admin's own SSH. */
  host: string | null;
  port: number | null;
  last_seen_at: string | null;
  paired_at: string | null;
  paired_by_name: string | null;
  hardware: StationHardware | null;
  session_count: number;
  /** Sessions recorded on the Pi that have not been imported into SMPL yet. */
  pending_count: number;
  /** Last error the agent reported, or the proxy's own reason for failing. */
  agent_error: string | null;
}

export interface StationListResponse {
  stations: Station[];
  /** Server clock, so "last seen" can be rendered without trusting the client. */
  server_time: string | null;
}

/**
 * One inventory session as the Pi recorded it.
 *
 * Mirrors the agent's `/session/{name}` view (`articles`, `total_qty`,
 * `total_scans`) plus the two fields only SMPL can know: whether it has
 * already been pulled in, and into which Werkstatt inventory session.
 */
export interface StationSession {
  name: string;
  started_at: string | null;
  status: string;
  articles: number;
  total_qty: number;
  total_scans: number;
  last_counted_at: string | null;
  imported_at: string | null;
  imported_session_id: number | null;
}

export interface StationSessionListResponse {
  sessions: StationSession[];
  /** False when the station answered but the agent could not list sessions. */
  ok: boolean;
  error: string | null;
}

export interface StationImportPayload {
  /** Append into an existing Werkstatt inventory session, or omit to create one. */
  target_session_id?: number | null;
  /** Name for the session the import creates. Defaults to the Pi's own name. */
  create_session_name?: string;
}

export interface StationImportResult {
  ok: boolean;
  /** The Werkstatt inventory session the counts landed in. */
  session_id: number;
  session_name: string;
  /** Rows newly written. */
  imported: number;
  /** Rows that already existed and were updated. */
  updated: number;
  skipped: number;
  /** Scanned codes that matched no article — the admin has to look at these. */
  unmatched: string[];
  detail: string;
}

export interface StationActionResult {
  ok: boolean;
  detail: string;
  /** Round trip in milliseconds, when the agent measured it. */
  ms: number | null;
}

/**
 * A short-lived pairing code.
 *
 * The point of the whole mechanism: an operator standing at the Pi types eight
 * characters instead of looking up an admin password. The code is single-use
 * and expires in minutes, so shoulder-surfing it is worthless a moment later.
 * `enroll_url` is what the QR encodes, for a Pi with a camera or a phone
 * relaying it.
 */
export interface StationPairing {
  code: string;
  expires_at: string;
  expires_in_seconds: number;
  enroll_url: string;
  claimed: boolean;
  claimed_station: Station | null;
}

export interface StationPairingPayload {
  name?: string;
  location?: string;
}

export interface StationPatchPayload {
  name?: string;
  location?: string | null;
}

export interface StationTestPrintPayload {
  /** Free text for the label. The backend falls back to a fixed test string. */
  text?: string;
}

export interface StationSetup {
  /** A copy-pasteable shell block for a fresh Pi. */
  script: string;
  /** The SMPL base URL the script bakes in. */
  base_url: string;
}

// ── Transport ────────────────────────────────────────────────────────────

/**
 * Turn anything `fetch` can throw into an ApiError, so callers have exactly
 * one error shape to reason about.
 *
 * An aborted request and a dead network are indistinguishable to the user and
 * both mean "the request never landed", so both get status 0.
 */
function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ApiError("timeout", STATION_NETWORK_STATUS);
  }
  if (error instanceof Error) {
    return new ApiError(error.message || "network error", STATION_NETWORK_STATUS);
  }
  return new ApiError(String(error), STATION_NETWORK_STATUS);
}

async function stationFetch<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch<T>(`${BASE}${path}`, token, {
      ...options,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    throw asApiError(error);
  } finally {
    window.clearTimeout(timer);
  }
}

/**
 * Pull a list out of a response that may or may not be enveloped.
 *
 * The backend for these endpoints is being written in parallel with this
 * client. A bare array where an envelope was expected is the single most
 * likely mismatch, and it is not worth a blank screen.
 */
function unwrapList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const inner = (payload as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

function readString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readBool(payload: unknown, key: string, fallback: boolean): boolean {
  if (!payload || typeof payload !== "object") return fallback;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : fallback;
}

// ── Error classification ─────────────────────────────────────────────────

/**
 * True when the failure means "this server has no station API", rather than
 * "the request failed".
 *
 * 404 and 405 are what a router that was never mounted answers; 501 is what a
 * deliberately stubbed one answers. The page shows a calm "not available yet"
 * card for these instead of a red error.
 */
export function isStationApiMissing(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.status === 404 || error.status === 405 || error.status === 501;
}

/** True when the request never reached the server (timeout, offline). */
export function isStationUnreachable(error: unknown): boolean {
  return error instanceof ApiError && error.status === STATION_NETWORK_STATUS;
}

/** A message an admin can act on, in the UI language. */
export function describeStationError(error: unknown, de: boolean): string {
  if (isStationApiMissing(error)) {
    return de
      ? "Die Stations-Schnittstelle ist auf diesem Server noch nicht verfügbar."
      : "The station API is not available on this server yet.";
  }
  if (isStationUnreachable(error)) {
    return de
      ? "Keine Antwort vom Server — Zeitüberschreitung oder keine Verbindung."
      : "No response from the server — timed out or offline.";
  }
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return de ? "Keine Berechtigung für die Pi-Station." : "Not permitted to manage the Pi station.";
    }
    if (error.status === 502 || error.status === 504) {
      return de
        ? "Die Station antwortet nicht. Läuft der Agent auf dem Pi?"
        : "The station is not answering. Is the agent running on the Pi?";
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

// ── Status helpers ───────────────────────────────────────────────────────

/** Freshness thresholds, matching what the backend is expected to apply. */
const ONLINE_WITHIN_MS = 90_000;
const STALE_WITHIN_MS = 10 * 60_000;

/**
 * The station's status, preferring the server's own verdict.
 *
 * Falls back to deriving it from `last_seen_at` so a backend that has not
 * implemented `status` yet still renders something truthful rather than
 * "unknown" on every row.
 */
export function stationStatus(station: Station, now: number = Date.now()): StationStatus {
  if (
    station.status === "online" ||
    station.status === "stale" ||
    station.status === "offline"
  ) {
    return station.status;
  }
  if (!station.last_seen_at) return "unknown";
  const seen = Date.parse(
    /(?:[zZ]|[+\-]\d{2}:\d{2})$/.test(station.last_seen_at)
      ? station.last_seen_at
      : `${station.last_seen_at}Z`,
  );
  if (Number.isNaN(seen)) return "unknown";
  const age = now - seen;
  if (age <= ONLINE_WITHIN_MS) return "online";
  if (age <= STALE_WITHIN_MS) return "stale";
  return "offline";
}

// ── Stations ─────────────────────────────────────────────────────────────

export async function listStations(token: string | null): Promise<StationListResponse> {
  const payload = await stationFetch<unknown>("/stations", token);
  return {
    stations: unwrapList<Station>(payload, "stations"),
    server_time: readString(payload, "server_time"),
  };
}

export async function patchStation(
  token: string | null,
  stationId: number,
  payload: StationPatchPayload,
): Promise<Station> {
  return stationFetch<Station>(`/stations/${stationId}`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function unpairStation(token: string | null, stationId: number): Promise<void> {
  await stationFetch<unknown>(`/stations/${stationId}`, token, { method: "DELETE" });
}

/** Force a fresh `/health` poll of the agent instead of serving cached state. */
export async function refreshStation(token: string | null, stationId: number): Promise<Station> {
  return stationFetch<Station>(`/stations/${stationId}/refresh`, token, { method: "POST" }, ACTION_TIMEOUT_MS);
}

export async function printTestLabel(
  token: string | null,
  stationId: number,
  payload: StationTestPrintPayload = {},
): Promise<StationActionResult> {
  return stationFetch<StationActionResult>(
    `/stations/${stationId}/test-print`,
    token,
    { method: "POST", body: JSON.stringify(payload) },
    ACTION_TIMEOUT_MS,
  );
}

/** Guarded: the body must carry `confirm: true` or the backend refuses. */
export async function restartStationAgent(
  token: string | null,
  stationId: number,
): Promise<StationActionResult> {
  return stationFetch<StationActionResult>(
    `/stations/${stationId}/restart`,
    token,
    { method: "POST", body: JSON.stringify({ confirm: true }) },
    ACTION_TIMEOUT_MS,
  );
}

// ── Sessions ─────────────────────────────────────────────────────────────

export async function listStationSessions(
  token: string | null,
  stationId: number,
): Promise<StationSessionListResponse> {
  const payload = await stationFetch<unknown>(`/stations/${stationId}/sessions`, token);
  return {
    sessions: unwrapList<StationSession>(payload, "sessions"),
    ok: readBool(payload, "ok", true),
    error: readString(payload, "error"),
  };
}

export async function importStationSession(
  token: string | null,
  stationId: number,
  sessionName: string,
  payload: StationImportPayload = {},
): Promise<StationImportResult> {
  return stationFetch<StationImportResult>(
    `/stations/${stationId}/sessions/${encodeURIComponent(sessionName)}/import`,
    token,
    { method: "POST", body: JSON.stringify(payload) },
    ACTION_TIMEOUT_MS,
  );
}

// ── Pairing ──────────────────────────────────────────────────────────────
//
// The backend implements the OAuth 2.0 **device authorization grant**
// (RFC 8628), which is the pattern designed for exactly this situation: a
// device with no convenient keyboard needs to act for a user, and must never
// hold a credential the user did not deliberately grant.
//
// So the direction is Pi-first, not admin-first: the Pi asks for a code and
// shows it; an admin sees it here and approves it; only then does the Pi
// receive a token, and only once. An admin cannot mint a credential for a
// device that never asked, which is the property that makes an unauthenticated
// pair/start endpoint safe to expose.

export interface StationPairingRequest {
  id: number;
  user_code: string;
  status: "pending" | "approved" | "denied" | "expired" | "claimed";
  device_hint: string | null;
  agent_version: string | null;
  requested_ip: string | null;
  created_at: string;
  expires_at: string;
  expires_in: number;
  poll_count: number;
  last_polled_at: string | null;
}

/** Codes waiting for an admin decision. Bare array from the API. */
export async function listPendingPairings(
  token: string | null,
): Promise<StationPairingRequest[]> {
  const rows = await stationFetch<StationPairingRequest[] | { pairings?: StationPairingRequest[] }>(
    "/pair/pending",
    token,
  );
  return Array.isArray(rows) ? rows : (rows?.pairings ?? []);
}

/** Approve a code and name the station. This is the step that replaces
 *  typing an SMPL password on the Pi. */
export async function approvePairing(
  token: string | null,
  payload: { user_code: string; name: string; expires_in_days?: number | null },
): Promise<{ status: string; user_code: string; station: Station }> {
  return stationFetch<{ status: string; user_code: string; station: Station }>(
    "/pair/approve",
    token,
    { method: "POST", body: JSON.stringify(payload) },
    ACTION_TIMEOUT_MS,
  );
}

export async function denyPairing(
  token: string | null,
  userCode: string,
): Promise<{ status: string; user_code: string }> {
  return stationFetch<{ status: string; user_code: string }>("/pair/deny", token, {
    method: "POST",
    body: JSON.stringify({ user_code: userCode }),
  });
}

/** Revoke a paired station. The backend soft-revokes (keeps the audit row)
 *  and the auth dependency rejects the token on the very next request. */
export async function revokeStation(token: string | null, stationId: number): Promise<Station> {
  return stationFetch<Station>(`/stations/${stationId}/revoke`, token, { method: "POST" });
}

// ── Setup ────────────────────────────────────────────────────────────────

export async function getSetupScript(token: string | null): Promise<StationSetup> {
  return stationFetch<StationSetup>("/setup", token);
}

/**
 * The fallback setup block, used when `/station/setup` is not implemented.
 *
 * Deliberately a literal here rather than a spinner over a missing endpoint:
 * an admin standing at a fresh Pi needs commands on screen, and these do not
 * depend on anything the server has to compute except its own URL.
 */
export function fallbackSetupScript(baseUrl: string, pairingCode?: string | null): string {
  const code = pairingCode?.trim() ? pairingCode.trim() : "<Kopplungscode>";
  return [
    "# 1) Abhängigkeiten (Raspberry Pi OS)",
    "sudo apt update && sudo apt install -y git python3-venv libusb-1.0-0",
    "",
    "# 2) SMPL Label-Agent holen",
    "git clone <SMPL-Repository-URL> ~/smpl && cd ~/smpl/tools/label_agent",
    "",
    "# 3) USB-Regel für den Brother PT-P710BT (sonst braucht der Agent root)",
    "sudo tee /etc/udev/rules.d/99-brother-ptouch.rules >/dev/null <<'EOF'",
    'SUBSYSTEM=="usb", ATTR{idVendor}=="04f9", ATTR{idProduct}=="20af", MODE="0660", GROUP="lp"',
    "EOF",
    "sudo udevadm control --reload-rules && sudo udevadm trigger",
    "",
    "# 4) Mit dieser SMPL-Installation koppeln",
    `export SMPL_API_URL=${baseUrl}`,
    `export SMPL_PAIRING_CODE=${code}`,
    "./run.sh --host 0.0.0.0",
  ].join("\n");
}
