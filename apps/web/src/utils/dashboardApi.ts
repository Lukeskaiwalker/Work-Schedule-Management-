// Every /api/dashboard* call of the personal start page.
//
// Backend: apps/api/app/routers/dashboard.py (docs/DASHBOARD.md §4).
//
// Gating, as enforced server-side:
//   layouts (GET, PUT, DELETE)      → signed in; the server filters every
//                                     layout to what the caller may see
//   absent-today                    → planning:manage | time:view_all |
//                                     time:manage, else 403
//   role-defaults (GET, PUT, DELETE) → settings:manage
//
// Every function throws ApiError on a non-2xx answer. Responses are
// normalised on the way in: a widget's `settings: null` is dropped, so the
// rest of the web only ever sees "absent" (`sameLayout` treats both alike,
// but nothing else has to). The same goes on the way out — the client never
// sends `settings: null`.

import { ApiError, apiFetch } from "../api/client";
import {
  DASHBOARD_DEVICES,
  type AbsentToday,
  type DashboardDevice,
  type DashboardErrorCode,
  type DashboardErrorDetail,
  type DashboardLayout,
  type DashboardLayoutInput,
  type DashboardRoleDefault,
  type DashboardRoleDefaults,
  type DashboardState,
  type DashboardWidgetItem,
} from "../types/dashboard";

const ERROR_CODES: ReadonlySet<DashboardErrorCode> = new Set<DashboardErrorCode>([
  "unknown_widget",
  "duplicate_widget",
  "settings_not_allowed",
  "unknown_view",
  "duplicate_view",
  "too_large",
]);

function layoutPath(device: DashboardDevice): string {
  return `/dashboard/layouts/${encodeURIComponent(device)}`;
}

function roleDefaultPath(role: string, device: DashboardDevice): string {
  // Both segments escaped: a role name is admin-facing text, and an
  // unescaped "/" or ".." would address another route.
  return `/dashboard/role-defaults/${encodeURIComponent(role)}/${encodeURIComponent(device)}`;
}

/** A fresh item without a null or empty `settings`. Never mutates its input. */
function normalizeWidget(raw: DashboardWidgetItem): DashboardWidgetItem {
  const { id, size } = raw;
  const views = raw.settings?.views;
  return Array.isArray(views) && views.length > 0 ? { id, size, settings: { views: [...views] } } : { id, size };
}

function normalizeWidgets(raw: unknown): DashboardWidgetItem[] {
  return Array.isArray(raw) ? (raw as DashboardWidgetItem[]).map(normalizeWidget) : [];
}

function normalizeLayout(raw: DashboardLayout): DashboardLayout {
  return {
    ...raw,
    widgets: normalizeWidgets(raw.widgets),
    updated_at: raw.updated_at ?? null,
    role_changed: raw.role_changed === true,
  };
}

function normalizeRoleDefault(raw: DashboardRoleDefault): DashboardRoleDefault {
  return {
    ...raw,
    widgets: normalizeWidgets(raw.widgets),
    hidden_for_role: Array.isArray(raw.hidden_for_role) ? [...raw.hidden_for_role] : [],
    updated_at: raw.updated_at ?? null,
  };
}

function normalizeState(raw: DashboardState): DashboardState {
  const layouts = raw?.layouts;
  // The page renders one of the three by width; a missing one would be a
  // blank start page with no error. Fail loudly instead — the host shows
  // „Startseite konnte nicht geladen werden.“ and a retry.
  if (!layouts || DASHBOARD_DEVICES.some((device) => !layouts[device])) {
    throw new Error("Unexpected dashboard response: a device layout is missing");
  }
  return {
    layouts: {
      mobile: normalizeLayout(layouts.mobile),
      tablet: normalizeLayout(layouts.tablet),
      desktop: normalizeLayout(layouts.desktop),
    },
    available_widgets: Array.isArray(raw.available_widgets) ? [...raw.available_widgets] : [],
    default_sizes: { ...raw.default_sizes },
  };
}

function layoutBody(layout: DashboardLayoutInput): string {
  return JSON.stringify({ version: layout.version, widgets: layout.widgets.map(normalizeWidget) });
}

export async function fetchDashboard(token: string | null, signal?: AbortSignal): Promise<DashboardState> {
  return normalizeState(await apiFetch<DashboardState>("/dashboard", token, { signal }));
}

export async function saveDashboardLayout(
  token: string | null,
  device: DashboardDevice,
  layout: DashboardLayoutInput,
): Promise<DashboardLayout> {
  const saved = await apiFetch<DashboardLayout>(layoutPath(device), token, {
    method: "PUT",
    body: layoutBody(layout),
  });
  return normalizeLayout(saved);
}

/** Drops the user's own layout for the device; answers the one that applies now (role or built-in). */
export async function resetDashboardLayout(token: string | null, device: DashboardDevice): Promise<DashboardLayout> {
  return normalizeLayout(await apiFetch<DashboardLayout>(layoutPath(device), token, { method: "DELETE" }));
}

export async function fetchAbsentToday(token: string | null, signal?: AbortSignal): Promise<AbsentToday> {
  return apiFetch<AbsentToday>("/dashboard/absent-today", token, { signal });
}

export async function fetchDashboardRoleDefaults(token: string | null): Promise<DashboardRoleDefaults> {
  const raw = await apiFetch<DashboardRoleDefaults>("/dashboard/role-defaults", token);
  return {
    catalog: Array.isArray(raw.catalog) ? [...raw.catalog] : [],
    roles: Array.isArray(raw.roles) ? [...raw.roles] : [],
    defaults: Array.isArray(raw.defaults) ? raw.defaults.map(normalizeRoleDefault) : [],
  };
}

export async function saveDashboardRoleDefault(
  token: string | null,
  role: string,
  device: DashboardDevice,
  layout: DashboardLayoutInput,
): Promise<DashboardRoleDefault> {
  const saved = await apiFetch<DashboardRoleDefault>(roleDefaultPath(role, device), token, {
    method: "PUT",
    body: layoutBody(layout),
  });
  return normalizeRoleDefault(saved);
}

/** Back to the built-in default for that role and device. */
export async function resetDashboardRoleDefault(
  token: string | null,
  role: string,
  device: DashboardDevice,
): Promise<DashboardRoleDefault> {
  return normalizeRoleDefault(
    await apiFetch<DashboardRoleDefault>(roleDefaultPath(role, device), token, { method: "DELETE" }),
  );
}

/**
 * The server's reason for refusing a layout: a 422 whose `detail` is an
 * object `{code, message, ids}` (§3.1 rules 2–5). Null for anything else —
 * including FastAPI's own 422 with a list `detail` (a malformed body or a bad
 * device), for which the editor shows its generic save error.
 */
export function dashboardErrorDetail(error: unknown): DashboardErrorDetail | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const detail = error.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const { code, message, ids } = detail as Record<string, unknown>;
  if (typeof code !== "string" || !ERROR_CODES.has(code as DashboardErrorCode)) return null;
  if (typeof message !== "string") return null;
  return {
    code: code as DashboardErrorCode,
    message,
    ids: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [],
  };
}
