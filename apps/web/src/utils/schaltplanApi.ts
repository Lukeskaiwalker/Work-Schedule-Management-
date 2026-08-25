/**
 * API client for Verteilerpläne (panel schematics).
 *
 * Backend: `apps/api/app/routers/workflow_schaltplan.py`. Gating in short:
 * reading is open to any signed-in user (a project-linked plan additionally
 * inherits that project's access), writing needs `reports:create` — the same
 * "may document field work" grant the Baustellenbericht uses.
 */

import { apiFetch, API_BASE } from "../api/client";
import type { DeviceKind, PanelDocument, PanelPlan, PanelPlanSummary, PanelStatus, PanelType } from "../types/schaltplan";

export interface ServerDeviceCatalogEntry {
  kind: DeviceKind;
  label: string;
  short: string;
  te: number;
  poles: number;
  group: boolean;
  circuit: boolean;
  symbol: string;
  rating_hint: string;
}

export async function listPanels(
  token: string | null,
  options: { customerId?: number | null; projectId?: number | null } = {},
): Promise<PanelPlanSummary[]> {
  const params = new URLSearchParams();
  if (options.customerId != null) params.set("customer_id", String(options.customerId));
  if (options.projectId != null) params.set("project_id", String(options.projectId));
  const qs = params.toString();
  return apiFetch<PanelPlanSummary[]>(`/schaltplan/panels${qs ? `?${qs}` : ""}`, token);
}

export async function getPanel(token: string | null, panelId: number): Promise<PanelPlan> {
  return apiFetch<PanelPlan>(`/schaltplan/panels/${panelId}`, token);
}

export interface CreatePanelPayload {
  customer_id: number;
  project_id?: number | null;
  name: string;
  designation: string;
  panel_type: PanelType;
  location?: string | null;
  fed_from_panel_id?: number | null;
  notes?: string | null;
  document?: PanelDocument;
}

export async function createPanel(
  token: string | null,
  payload: CreatePanelPayload,
): Promise<PanelPlan> {
  return apiFetch<PanelPlan>(`/schaltplan/panels`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export interface UpdatePanelPayload {
  project_id?: number | null;
  name?: string;
  designation?: string;
  panel_type?: PanelType;
  location?: string | null;
  fed_from_panel_id?: number | null;
  status?: PanelStatus;
  notes?: string | null;
  document?: PanelDocument;
}

export async function updatePanel(
  token: string | null,
  panelId: number,
  payload: UpdatePanelPayload,
): Promise<PanelPlan> {
  return apiFetch<PanelPlan>(`/schaltplan/panels/${panelId}`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function deletePanel(token: string | null, panelId: number): Promise<void> {
  await apiFetch<void>(`/schaltplan/panels/${panelId}`, token, { method: "DELETE" });
}

export async function duplicatePanel(token: string | null, panelId: number): Promise<PanelPlan> {
  return apiFetch<PanelPlan>(`/schaltplan/panels/${panelId}/duplicate`, token, { method: "POST" });
}

export async function fetchDeviceCatalog(token: string | null): Promise<ServerDeviceCatalogEntry[]> {
  return apiFetch<ServerDeviceCatalogEntry[]>(`/schaltplan/devices`, token);
}

/**
 * PDF URL for a plan.
 *
 * No token in the query string: the login response also sets an
 * `access_token` cookie, so a plain `<a href>` authenticates the same way
 * the Ausbildungsnachweis and report PDFs already do. Passing the JWT as a
 * query parameter would put it in proxy and browser-history logs for no
 * gain.
 */
export function panelPdfUrl(panelId: number, options: { legendOnly?: boolean } = {}): string {
  const qs = options.legendOnly ? "?legend_only=true" : "";
  return `${API_BASE}/schaltplan/panels/${panelId}/pdf${qs}`;
}
