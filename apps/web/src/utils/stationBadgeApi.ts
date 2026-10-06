// API client for a person's own scan-station badge ("Stations-Ausweis").
//
// The badge is a DataMatrix the person scans at the Regal station: instead of
// tapping their name, and to clock in and out of a Verteiler. The code is a
// bearer identifier for the station only — never a login — so it is shown to
// its owner (and to whoever prints badges, with users:manage) and to nobody
// else. The server marks every answer `Cache-Control: no-store`.
//
// ── Endpoint contract ────────────────────────────────────────────────────
// All paths are relative to `/api` (apiFetch prefixes it).
//
//   GET  /users/me/station-badge                  → StationBadge (minted on first read)
//   POST /users/me/station-badge/rotate           → StationBadge (the old code stops working)
//   GET  /admin/users/{id}/station-badge          → StationBadge   (users:manage)
//   POST /admin/users/{id}/station-badge/rotate   → StationBadge   (users:manage)

import { apiFetch } from "../api/client";

export type StationBadge = {
  user_id: number;
  user_name: string;
  /** `SMPL-P-` and ten characters — what the DataMatrix encodes. */
  code: string;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
};

/** The badge code's shape, as minted by the server. Anything else is not drawn. */
export const STATION_BADGE_CODE_RE = /^SMPL-P-[0-9ABCDEFGHJKLMNPQRSTUVWX]{10}$/;

function asBadge(value: unknown): StationBadge {
  const candidate = (value ?? {}) as Partial<StationBadge>;
  if (typeof candidate.code !== "string" || !STATION_BADGE_CODE_RE.test(candidate.code)) {
    throw new Error("Der Server hat keinen gültigen Ausweis zurückgegeben.");
  }
  return {
    user_id: Number(candidate.user_id),
    user_name: typeof candidate.user_name === "string" ? candidate.user_name : "",
    code: candidate.code,
    created_at: typeof candidate.created_at === "string" ? candidate.created_at : "",
    last_used_at: typeof candidate.last_used_at === "string" ? candidate.last_used_at : null,
    use_count: typeof candidate.use_count === "number" && Number.isFinite(candidate.use_count) ? candidate.use_count : 0,
  };
}

/** Your own badge; the server mints it the first time you look. */
export async function getMyStationBadge(token: string | null): Promise<StationBadge> {
  return asBadge(await apiFetch<unknown>("/users/me/station-badge", token));
}

/** A fresh code for your badge — the printed one stops working at once. */
export async function rotateMyStationBadge(token: string | null): Promise<StationBadge> {
  return asBadge(await apiFetch<unknown>("/users/me/station-badge/rotate", token, { method: "POST" }));
}

/** A colleague's badge, for printing it (users:manage). */
export async function getUserStationBadge(token: string | null, userId: number): Promise<StationBadge> {
  return asBadge(await apiFetch<unknown>(`/admin/users/${userId}/station-badge`, token));
}

export async function rotateUserStationBadge(token: string | null, userId: number): Promise<StationBadge> {
  return asBadge(
    await apiFetch<unknown>(`/admin/users/${userId}/station-badge/rotate`, token, { method: "POST" }),
  );
}
