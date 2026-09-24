/**
 * API client for Verteilerpläne (panel schematics).
 *
 * Backend: `apps/api/app/routers/workflow_schaltplan.py`. Gating in short:
 * reading is open to any signed-in user (a project-linked plan additionally
 * inherits that project's access), writing needs `reports:create` — the same
 * "may document field work" grant the Baustellenbericht uses.
 */

import { apiFetch, API_BASE } from "../api/client";
import type {
  DeviceKind,
  PanelDocument,
  PanelMaterial,
  PanelMaterialMappingResult,
  PanelMaterialSummary,
  PanelPlan,
  PanelPlanSummary,
  PanelStatus,
  PanelType,
} from "../types/schaltplan";

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

export interface PanelLabelsPrintResult {
  /** Labelled segments (2009-110) or labels (210-805) actually printed. */
  printed: number;
  /**
   * Real devices without a BMK on the SELECTED rails — a selected rail with
   * nothing to print still counts its unnamed devices. A blank cover never
   * counts. For Reihenklemmen: the Leiste markers of the selected strips
   * left blank by an override.
   */
  skipped_without_bmk: number;
  printer: string;
  material: string;
  /**
   * One entry per piece that went out on the 2009-110, blank-free length;
   * empty for 210-805. A rail for BMK; a terminal strip (`row_id` = the
   * strip id, "f1:leiste" or "w1:block", `part_count` = its parts) for
   * Reihenklemmen.
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
   * Reihenklemmen target: the strips to print, by strip id. Absent = every
   * strip; an explicit empty array = none, which the server refuses with a
   * 400 — the sheet never sends it because Drucken is disabled with nothing
   * ticked. The marker texts are not sent: they live in the saved document
   * (`terminal_labels`), so the page flushes its autosave before printing.
   */
  stripIds?: string[];
  target?: PrintTarget;
}

/**
 * Print the board's BMK labels for the chosen rails — or, with
 * `target: "reihenklemmen"`, the WAGO terminal markers of the chosen strips.
 *
 * `materialId` is one of `LABEL_MATERIALS` in `utils/schaltplanStrip.ts`:
 * the 2009-110 strip gives one cut-marked strip per rail (or per Leiste,
 * and one 60 mm block label per Block), the 210-805 one die-cut label per
 * BMK (never for terminals). The preview the dialog shows is computed
 * client-side from the same segment and font-size rules the server prints
 * with (`utils/schaltplanStrip.ts` + `utils/schaltplanTerminals.ts` ↔
 * `services/schaltplan_layout.py` + `services/schaltplan_terminals.py`).
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
          // null = every strip on the server; [] would mean "none".
          strip_ids: options.stripIds ?? null,
          material_id: options.materialId,
        }
      : { target, row_ids: options.rowIds ?? [], material_id: options.materialId };
  return apiFetch<PanelLabelsPrintResult>(`/schaltplan/panels/${panelId}/labels`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Schrank-Etikett (type label) ────────────────────────────────────────────

/**
 * What the Schrank-Etikett will say, as the server resolved it for one panel.
 * The layout itself is server-side (`services/schaltplan_type_label.py`); the
 * sheet only shows a schematic preview and lets the user change `build_month`.
 */
export interface PanelTypeLabelInfo {
  /** "VT-0007" — printed as a DataMatrix bottom-left, scanned at the Regal station. */
  panel_number: string;
  customer: string;
  /** Null when the panel has no project. */
  project_number: string | null;
  project_name: string | null;
  /** `MM.YYYY`, the current month unless the user changes it. */
  build_month: string;
  /** What the QR code encodes. */
  url: string;
  contact_lines: string[];
  /** Name of the stock currently loaded in the printer. */
  material: string;
  /** False when the loaded stock is not a 99 × 44 label — the server refuses to print then. */
  material_ok: boolean;
}

export interface PanelTypeLabelPrintRequest {
  build_month?: string;
  /** 1..10, default 1. */
  copies?: number;
}

export interface PanelTypeLabelPrintResult {
  printer: string;
  material: string;
  sheets: number;
  customer: string;
  project_number: string | null;
  build_month: string;
}

export async function getPanelTypeLabel(token: string | null, panelId: number): Promise<PanelTypeLabelInfo> {
  return apiFetch<PanelTypeLabelInfo>(`/schaltplan/panels/${panelId}/type-label`, token);
}

/**
 * Print the panel's Schrank-Etikett on the label printer. A 400 carries a
 * German sentence in `detail` (bad Baujahr, wrong stock loaded) meant to be
 * shown as is; 503 = no label printer configured, 502 = printer unreachable.
 */
export async function printPanelTypeLabel(
  token: string | null,
  panelId: number,
  body: PanelTypeLabelPrintRequest,
): Promise<PanelTypeLabelPrintResult> {
  return apiFetch<PanelTypeLabelPrintResult>(`/schaltplan/panels/${panelId}/type-label`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The logo and QR code exactly as they print, for the preview's `<img>`.
 * No token in the URL — the `access_token` cookie authenticates the image
 * request, as it does for `panelPdfUrl` and the file previews.
 */
export function typeLabelLogoUrl(): string {
  return `${API_BASE}/schaltplan/type-label/logo.png`;
}

export function typeLabelQrUrl(): string {
  return `${API_BASE}/schaltplan/type-label/qr.svg`;
}

// ── Zuletzt bearbeitet ────────────────────────────────────────────────────────

/** The panels the user may see, newest `updated_at` first — what the search box shows before anything is typed. */
export async function listRecentPanels(token: string | null, limit = 8): Promise<PanelPlanSummary[]> {
  return apiFetch<PanelPlanSummary[]>(`/schaltplan/panels/recent?limit=${limit}`, token);
}

// ── Materialliste / Kommissionierung ─────────────────────────────────────────
// Backend contract: apps/api/app/routers/workflow_schaltplan_material.py.

export async function getPanelMaterial(token: string | null, panelId: number): Promise<PanelMaterial> {
  return apiFetch<PanelMaterial>(`/schaltplan/panels/${panelId}/material`, token);
}

/** Book `quantity` of a stock article as consumed for this panel (a `consumption` ledger row). */
export async function bookPanelMaterial(
  token: string | null,
  panelId: number,
  body: { article_id: number; quantity: number },
): Promise<PanelMaterial> {
  return apiFetch<PanelMaterial>(`/schaltplan/panels/${panelId}/material/book`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Take a booking back (a `consumption_undo` row); 400 when more than the net scanned quantity. */
export async function unbookPanelMaterial(
  token: string | null,
  panelId: number,
  body: { article_id: number; quantity: number },
): Promise<PanelMaterial> {
  return apiFetch<PanelMaterial>(`/schaltplan/panels/${panelId}/material/unbook`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Tell every panel which stock article a planned line means ("device:mcb:1p:b16"
 * is SP-0152). Global, not per panel; `article_id: null` forgets the mapping.
 */
export async function setPanelMaterialMapping(
  token: string | null,
  body: { key: string; article_id: number | null },
): Promise<PanelMaterialMappingResult> {
  return apiFetch<PanelMaterialMappingResult>(`/schaltplan/material/mapping`, token, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Every visible panel with its picking progress — the Werkstatt "Verteiler" tab. */
export async function getPanelMaterialOverview(token: string | null): Promise<PanelMaterialSummary[]> {
  return apiFetch<PanelMaterialSummary[]>(`/schaltplan/material/overview`, token);
}
