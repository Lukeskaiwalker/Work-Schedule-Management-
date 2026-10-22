/**
 * The reads behind the „Werkstatt“ widgets: resource-store keys, their
 * module-level loaders, and one hook per read (docs/DASHBOARD.md §1, §9.3).
 *
 * The store keeps the first loader registered for a key, so two widgets on one
 * key must hand it the same function. Binding key, loader and poll interval in
 * one hook per read makes that impossible to get wrong: „Lager-Kennzahlen“,
 * „Nachbestellen“ and „Auf Baustelle“ all call `useWerkstattDashboardResource`
 * and so share one request and one poller.
 *
 * Every read here needs only a signed-in user, exactly as the Werkstatt nav
 * does (Q3), so a widget never shows more than its page would.
 */
import { apiFetch } from "../../../../api/client";
import { useDashboardResource, type DashboardResourceState } from "../../../../hooks/useDashboardResource";
import type { PanelPlanSummary } from "../../../../types/schaltplan";
import type { WerkstattDashboard, WerkstattInspectionDue } from "../../../../types/werkstatt";
import type { MyCheckout } from "../../../../utils/werkstattMobileApi";
import { DASHBOARD_POLL_MS } from "../../dashboardPolling";

/**
 * The server's ceiling for `preview_limit` (D15). Asked for always, so one
 * answer serves every widget size; each widget slices to its own row limit.
 * The Werkstatt page itself keeps calling without it and still gets 5.
 */
const DASHBOARD_PREVIEW_LIMIT = 10;
/** Per status. The rack has eight crates; 50 leaves room for every Sonderkiste. */
const BOX_LIMIT = 50;
const INSPECTION_DAYS_AHEAD = 30;
/** The largest row limit („Groß“); the endpoint allows up to 25. */
const RECENT_PANELS_LIMIT = 10;

export const WERKSTATT_RESOURCE_KEYS = {
  dashboard: "werkstatt:dashboard",
  myCheckouts: "werkstatt:my-checkouts",
  boxesPacked: "werkstatt:boxes:gepackt",
  boxesAssigned: "werkstatt:boxes:zugewiesen",
  inspectionsDue: "werkstatt:inspections-due",
  recentPanels: "schaltplan:recent-panels",
} as const;

/** The status a crate list is read for: packed and waiting, or out with the customer. */
export type DashboardBoxStatus = "gepackt" | "zugewiesen";

/**
 * The fields of `WerkstattBoxOut` (schemas/werkstatt_boxes.py) a row shows.
 * The list endpoint sends no item lines (`with_items=False`), only the count.
 */
export interface DashboardBox {
  id: number;
  box_number: string;
  label: string;
  status: string;
  customer_name: string | null;
  project_name: string | null;
  item_count: number;
}

export function loadWerkstattDashboard(token: string | null, signal: AbortSignal): Promise<WerkstattDashboard> {
  return apiFetch<WerkstattDashboard>(`/werkstatt/dashboard?preview_limit=${DASHBOARD_PREVIEW_LIMIT}`, token, { signal });
}

export function loadMyCheckouts(token: string | null, signal: AbortSignal): Promise<MyCheckout[]> {
  return apiFetch<MyCheckout[]>("/werkstatt/mobile/my-checkouts", token, { signal });
}

function boxesPath(status: DashboardBoxStatus): string {
  return `/werkstatt/boxes?status=${status}&limit=${BOX_LIMIT}`;
}

export function loadPackedBoxes(token: string | null, signal: AbortSignal): Promise<DashboardBox[]> {
  return apiFetch<DashboardBox[]>(boxesPath("gepackt"), token, { signal });
}

export function loadAssignedBoxes(token: string | null, signal: AbortSignal): Promise<DashboardBox[]> {
  return apiFetch<DashboardBox[]>(boxesPath("zugewiesen"), token, { signal });
}

export function loadDueInspections(token: string | null, signal: AbortSignal): Promise<WerkstattInspectionDue[]> {
  return apiFetch<WerkstattInspectionDue[]>(`/werkstatt/inspections/due?days_ahead=${INSPECTION_DAYS_AHEAD}`, token, {
    signal,
  });
}

export function loadRecentPanels(token: string | null, signal: AbortSignal): Promise<PanelPlanSummary[]> {
  return apiFetch<PanelPlanSummary[]>(`/schaltplan/panels/recent?limit=${RECENT_PANELS_LIMIT}`, token, { signal });
}

const WERKSTATT_POLL = { pollMs: DASHBOARD_POLL_MS.werkstatt };

export function useWerkstattDashboardResource(): DashboardResourceState<WerkstattDashboard> {
  return useDashboardResource(WERKSTATT_RESOURCE_KEYS.dashboard, loadWerkstattDashboard, WERKSTATT_POLL);
}

export function useMyCheckoutsResource(): DashboardResourceState<MyCheckout[]> {
  return useDashboardResource(WERKSTATT_RESOURCE_KEYS.myCheckouts, loadMyCheckouts, WERKSTATT_POLL);
}

export function usePackedBoxesResource(): DashboardResourceState<DashboardBox[]> {
  return useDashboardResource(WERKSTATT_RESOURCE_KEYS.boxesPacked, loadPackedBoxes, WERKSTATT_POLL);
}

export function useAssignedBoxesResource(): DashboardResourceState<DashboardBox[]> {
  return useDashboardResource(WERKSTATT_RESOURCE_KEYS.boxesAssigned, loadAssignedBoxes, WERKSTATT_POLL);
}

/** Inspection dates move a few times a day at most; the slow interval is plenty. */
export function useDueInspectionsResource(): DashboardResourceState<WerkstattInspectionDue[]> {
  return useDashboardResource(WERKSTATT_RESOURCE_KEYS.inspectionsDue, loadDueInspections, {
    pollMs: DASHBOARD_POLL_MS.slow,
  });
}

export function useRecentPanelsResource(): DashboardResourceState<PanelPlanSummary[]> {
  return useDashboardResource(WERKSTATT_RESOURCE_KEYS.recentPanels, loadRecentPanels, WERKSTATT_POLL);
}
