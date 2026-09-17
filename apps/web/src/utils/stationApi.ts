// API client for the Raspberry Pi scan station ("Pi-Station").
//
// The station is a Pi in the office running `tools/label_agent/server.py`: a
// barcode scanner (HID keyboard), a Brother PT-P710BT over USB, and
// Benning/Metrel device imports off an SD card. SMPL never talks to the Pi
// directly from the browser: the Pi is on the LAN, the browser may not be, and
// the agent has no authentication of its own (see the agent README, "No
// authentication"). Everything here goes through the SMPL API, which knows the
// Pi's LAN address (the agent reports it on every heartbeat) and proxies to it
// through a fixed, address-checked client.
//
// ── Endpoint contract ────────────────────────────────────────────────────
// All paths are relative to `/api` (apiFetch prefixes it).
//
//   GET    /station/stations[?include_inactive=1]        → Station[] (bare list)
//   PATCH  /station/stations/{id}                         → Station
//   DELETE /station/stations/{id}                         → 204 (unpair)
//   POST   /station/stations/{id}/refresh                 → Station
//   POST   /station/stations/{id}/test-print              → StationActionResult
//   POST   /station/stations/{id}/restart                 → StationActionResult
//   GET    /station/stations/{id}/sessions                → StationSessionListResponse
//   POST   /station/stations/{id}/sessions/{name}/import  → StationImportResult
//   POST   /station/pair/start                            → device grant (Pi)
//   GET    /station/pair/pending                          → StationPairingRequest[]
//   POST   /station/pair/approve                          → { station: Station }
//   POST   /station/pair/deny                             → { user_code }
//   GET    /station/setup                                 → StationSetup
//   GET    /werkstatt/inventory/sessions                  → InventorySessionSummary[]
//
// The collection is `/station/stations` and not `/station/{id}` on purpose:
// `/station/pair/...` and `/station/setup` would otherwise collide with an int
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
 * heartbeat: the agent beats every two minutes, and the box may simply be busy
 * feeding tape.
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
  /** LAN address the agent reported at check-in, validated private server-side. */
  host: string | null;
  port: number | null;
  /** Admin-typed `http://<ip>:<port>` that wins over the reported pair. */
  agent_url_override: string | null;
  last_seen_at: string | null;
  paired_at: string | null;
  paired_by_name: string | null;
  hardware: StationHardware | null;
  session_count: number;
  /** Sessions recorded on the Pi that have not been imported into SMPL yet. */
  pending_count: number;
  /** The API's own reason its last call to the agent failed, if any. */
  agent_error: string | null;
  /** True when the token still authenticates (not revoked, not expired). */
  active?: boolean;
  /** Set once an admin unpaired the station; the row stays as the audit trail. */
  revoked_at?: string | null;
  /** When the token stops authenticating; null means never. */
  expires_at?: string | null;
}

export interface StationListResponse {
  stations: Station[];
  /** Server clock, so "last seen" can be rendered without trusting the client. */
  server_time: string | null;
}

/**
 * One inventory session as the Pi recorded it.
 *
 * Mirrors the agent's `/sessions` row (`articles`, `total_qty`, `total_scans`,
 * `last_counted_at`) plus the two fields only SMPL can know: whether it has
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
  /** False when the Pi could not be asked; `error` then says why. */
  ok: boolean;
  error: string | null;
}

export interface StationImportPayload {
  /** Append into an existing open Werkstatt inventory, or omit to reuse/create one. */
  target_session_id?: number | null;
  /** Name for the session the import creates. Defaults to the station's name. */
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

export interface StationPatchPayload {
  name?: string;
  location?: string | null;
  /** `http://<private ip or *.local>:<port>`; null clears the override. */
  agent_url?: string | null;
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

/** A Werkstatt inventory session, as far as the import target select needs. */
export interface InventorySessionSummary {
  id: number;
  name: string;
  status: string;
  counted_articles: number;
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

async function timedFetch<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await apiFetch<T>(path, token, {
      ...options,
      signal: controller.signal,
    });
  } catch (error: unknown) {
    throw asApiError(error);
  } finally {
    window.clearTimeout(timer);
  }
}

function stationFetch<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<T> {
  return timedFetch<T>(`${BASE}${path}`, token, options, timeoutMs);
}

/**
 * Pull a list out of a response that may or may not be enveloped.
 *
 * `GET /station/stations` answers a bare list by contract; the envelope form is
 * accepted too because a wrapped list is the single most likely shape a later
 * server might grow, and it is not worth a blank screen.
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

/** What FastAPI answers for a path no route matches — and nothing else. */
const FASTAPI_DEFAULT_404 = "Not Found";

/** The API's own sentence on an error, or null when it sent none. */
function apiDetail(error: ApiError): string | null {
  return typeof error.detail === "string" && error.detail.trim() ? error.detail.trim() : null;
}

/**
 * True when the failure means "this server has no station API", rather than
 * "the request failed".
 *
 * A 404 counts only when it carries no sentence of its own: FastAPI answers
 * an unrouted path with exactly "Not Found", while a route that exists and
 * says 404 does so in German ("Sitzung „regal“ wurde auf der Station nicht
 * gefunden.") — that is an answer to show, not a missing API.
 *
 * Kept as a defence for a web build that is newer than the API it talks to;
 * no page path reaches it against a current server.
 */
export function isStationApiMissing(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 405 || error.status === 501) return true;
  if (error.status !== 404) return false;
  const detail = apiDetail(error);
  return detail === null || detail === FASTAPI_DEFAULT_404;
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
    // 404 (unknown Pi session, missing inventory), 409 (no address yet,
    // station unpaired, inventory closed) and 502 (the agent's own words)
    // carry a German sentence from the API — show it.
    const detail = apiDetail(error);
    if (detail !== null) return detail;
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

/**
 * Freshness thresholds, identical to the API's (`services/station_view.py`).
 * The agent beats every 120 s: one missed beat is not an outage.
 */
export const ONLINE_WITHIN_MS = 3 * 60_000;
export const STALE_WITHIN_MS = 15 * 60_000;

/**
 * The station's status, preferring the server's own verdict.
 *
 * Falls back to deriving it from `last_seen_at` so a row that carries no
 * `status` still renders something truthful rather than "unknown".
 */
export function stationStatus(station: Station, now: number = Date.now()): StationStatus {
  if (
    station.status === "online" ||
    station.status === "stale" ||
    station.status === "offline"
  ) {
    return station.status;
  }
  const seen = parseServerStamp(station.last_seen_at);
  if (seen === null) return "unknown";
  const age = now - seen;
  if (age <= ONLINE_WITHIN_MS) return "online";
  if (age <= STALE_WITHIN_MS) return "stale";
  return "offline";
}

/** `host:port`, the admin override, or null when the API has no address. */
export function stationAddress(station: Station): string | null {
  if (station.agent_url_override) return station.agent_url_override;
  if (!station.host) return null;
  return station.port ? `${station.host}:${station.port}` : station.host;
}

function parseServerStamp(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const stamp = Date.parse(/(?:[zZ]|[+\-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(stamp) ? null : stamp;
}

/**
 * Revoked or expired — the rows the default list hides and the audit toggle
 * brings back. The same rule as the API's `is_station_retired`: an approved
 * station whose Pi has not collected its token yet is *not* retired, and the
 * admin who just approved it must still see it.
 */
export function isStationRetired(station: Station, now: number = Date.now()): boolean {
  if (station.revoked_at) return true;
  const expires = parseServerStamp(station.expires_at);
  return expires !== null && expires <= now;
}

/**
 * The station the page selects on its own: the first one that still works.
 * A retired row is never auto-selected — every action on it would answer 409,
 * and the page would open on a Pi that is not there.
 */
export function firstSelectableStation(stations: Station[], now: number = Date.now()): Station | null {
  return stations.find((station) => !isStationRetired(station, now)) ?? null;
}

// ── Stations ─────────────────────────────────────────────────────────────

export interface ListStationsOptions {
  /** Also return revoked/expired rows — the audit list, greyed on the page. */
  includeInactive?: boolean;
}

export async function listStations(
  token: string | null,
  options: ListStationsOptions = {},
): Promise<StationListResponse> {
  const path = options.includeInactive ? "/stations?include_inactive=1" : "/stations";
  const payload = await stationFetch<unknown>(path, token);
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

/**
 * Open Werkstatt inventories, for the "Ziel-Inventur" select.
 *
 * Only open ones: a finalized inventory is never written, and offering it
 * would turn the select into a way to earn a 409.
 */
export async function listOpenInventorySessions(
  token: string | null,
): Promise<InventorySessionSummary[]> {
  const rows = await timedFetch<unknown>("/werkstatt/inventory/sessions", token);
  return unwrapList<InventorySessionSummary>(rows, "sessions").filter(
    (row) => row && row.status === "open" && typeof row.id === "number",
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
 * The setup block shown until `/station/setup` has answered (or when it
 * cannot). The same documented path the server renders — install-pi.sh, then
 * `--pair` — so the two can never contradict each other. The server's copy
 * additionally pins the release tag on the clone.
 */
export function fallbackSetupScript(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return [
    "# 1) Code holen — einmalig. Später zum Aktualisieren: cd ~/smpl && git pull",
    "git clone --depth 1 <SMPL-Repository-URL> ~/smpl",
    "",
    "# 2) Installer — Dienst, udev-Regeln und venv; idempotent, nach jedem Update erneut ausführen",
    "#    (mit --with-kiosk zusätzlich die beiden Werkstatt-Bildschirme)",
    `sudo ~/smpl/tools/label_agent/packaging/install-pi.sh --smpl-url ${base}`,
    "",
    "# 3) Koppeln — zeigt einen Code; hier unter „Neue Station koppeln“ freigeben",
    "sudo -u smpl-station AGENT_STATE_DIR=/var/lib/smpl-station \\",
    "  /opt/smpl-station/tools/label_agent/.venv/bin/python \\",
    "  /opt/smpl-station/tools/label_agent/server.py --pair",
    "",
    "# Danach meldet der Agent alle 2 Minuten Adresse und Hardware an SMPL;",
    "# erst dann funktionieren Testetikett, Hardware prüfen und Neustart.",
  ].join("\n");
}
