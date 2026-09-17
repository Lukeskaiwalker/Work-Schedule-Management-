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
export function panelPdfUrl(
  panelId: number,
  options: { legendOnly?: boolean; terminalsOnly?: boolean } = {},
): string {
  // Reihenklemmen win over the legend, as on the server: the Klemmen tab is
  // the only caller that sets it and wants exactly that page.
  const qs = options.terminalsOnly ? "?terminals_only=true" : options.legendOnly ? "?legend_only=true" : "";
  return `${API_BASE}/schaltplan/panels/${panelId}/pdf${qs}`;
}

export type PrintTarget = "bmk" | "reihenklemmen";
export type { TerminalTextMode } from "./schaltplanTerminals";
import type { TerminalTextMode } from "./schaltplanTerminals";

export interface PanelLabelsPrintResult {
  /** Labelled segments (2009-110) or labels (210-805) actually printed. */
  printed: number;
  /**
   * Real devices without a BMK on the SELECTED rails — a selected rail with
   * nothing to print still counts its unnamed devices. A blank cover never counts.
   */
  skipped_without_bmk: number;
  printer: string;
  material: string;
  /**
   * One entry per strip that went out on the 2009-110, blank-free length;
   * empty for 210-805. A rail for BMK, an FI group (`row_id` = the FI's
   * device id, `part_count` = its parts) for Reihenklemmen.
   */
  strips: { row_id: string; row_label: string; length_mm: number; part_count?: number | null }[];
  /**
   * The one size every BMK on the board is printed at, in printer dots
   * (12 dots/mm). Null for die-cut labels, which are fitted one by one.
   */
  font_size_dots: number | null;
  /** BMK texts too long for their segment at that size — printed anyway, running past the cut marks. */
  overflowing: string[];
}

export interface PrintPanelLabelsOptions {
  materialId: string;
  /** BMK target: the rails to print (empty = every rail). */
  rowIds?: string[];
  /**
   * Reihenklemmen target: the FI groups to print. Absent = every group; an
   * explicit empty array = none, which the server refuses with a 400 — the
   * sheet never sends it because Drucken is disabled with nothing ticked.
   */
  groupIds?: string[];
  target?: PrintTarget;
  /** Reihenklemmen only: what each marker says. Stromkreis-Nr. by default — it fits 5.2 mm. */
  terminalText?: TerminalTextMode;
}

/**
 * Print the board's BMK labels for the chosen rails — or, with
 * `target: "reihenklemmen"`, the WAGO terminal markers of the chosen FI groups.
 *
 * `materialId` is one of `LABEL_MATERIALS` in `utils/schaltplanStrip.ts`:
 * the 2009-110 strip gives one cut-marked strip per rail (or per FI group),
 * the 210-805 one die-cut label per BMK (never for terminals). The preview
 * the dialog shows is computed client-side from the same segment and
 * font-size rules the server prints with (`utils/schaltplanStrip.ts` +
 * `utils/schaltplanTerminals.ts` ↔ `services/schaltplan_layout.py` +
 * `services/schaltplan_terminals.py`).
 */
export async function printPanelLabels(
  token: string | null,
  panelId: number,
  options: PrintPanelLabelsOptions,
): Promise<PanelLabelsPrintResult> {
  const target = options.target ?? "bmk";
  const body =
    target === "reihenklemmen"
      ? {
          target,
          // null = every group on the server; [] would mean "none".
          group_ids: options.groupIds ?? null,
          material_id: options.materialId,
          terminal_text: options.terminalText ?? "circuit",
        }
      : { target, row_ids: options.rowIds ?? [], material_id: options.materialId };
  return apiFetch<PanelLabelsPrintResult>(`/schaltplan/panels/${panelId}/labels`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
