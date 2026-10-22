/**
 * API client for the cabinet layer (docs/PANEL_ENCLOSURE.md §7).
 *
 * Backend: `routers/workflow_schaltplan_catalog.py` (catalogue),
 * `routers/workflow_schaltplan_enclosure.py` (Aufbau PDF) and the salvage
 * routes in `routers/workflow_schaltplan_material.py`. Reading the catalogue
 * needs a login; writing it, and booking a removed part back into stock,
 * needs `werkstatt:manage` — the server decides, these calls only ask.
 */

import { apiFetch, API_BASE } from "../api/client";
import type { CatalogEntry, CatalogEntryIn, EnclosureCatalog, EnclosureSpec, ModuleSpec } from "../types/panelEnclosure";
import type { PanelMaterial } from "../types/schaltplan";

type AnyEntry = CatalogEntry<EnclosureSpec | ModuleSpec>;

const JSON_HEADERS = { "Content-Type": "application/json" };
const entryPath = (code: string) => `/schaltplan/enclosure-catalog/${encodeURIComponent(code.trim().toUpperCase())}`;

/** Every cabinet and module the board may name — archived and invalid ones included, flagged. */
export async function getEnclosureCatalog(token: string | null): Promise<EnclosureCatalog> {
  return apiFetch<EnclosureCatalog>(`/schaltplan/enclosure-catalog`, token);
}

export async function createCatalogEntry(token: string | null, body: CatalogEntryIn): Promise<AnyEntry> {
  return apiFetch<AnyEntry>(`/schaltplan/enclosure-catalog`, token, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Replace a spec. 409 when it would drop a rail/fitting key, or resize a code a board uses (§3.5). */
export async function updateCatalogEntry(token: string | null, code: string, body: CatalogEntryIn): Promise<AnyEntry> {
  return apiFetch<AnyEntry>(entryPath(code), token, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** Archive (hidden from pickers, still resolving for boards) or restore. */
export async function setCatalogEntryArchived(token: string | null, code: string, archived: boolean): Promise<AnyEntry> {
  return apiFetch<AnyEntry>(entryPath(code), token, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ archived }),
  });
}

/** Back to the Hager standard: drops the override of a built-in (409 for a custom entry). */
export async function resetCatalogEntry(token: string | null, code: string): Promise<AnyEntry> {
  return apiFetch<AnyEntry>(`${entryPath(code)}/override`, token, { method: "DELETE" });
}

/**
 * The Aufbau sheet (front view + lists) followed by the Materialliste, as
 * one PDF. Cookie-authenticated like `panelPdfUrl` — no token in the URL.
 */
export function aufbauPdfUrl(panelId: number): string {
  return `${API_BASE}/schaltplan/panels/${panelId}/aufbau/pdf`;
}

/** Book a part taken out of a module back into stock (a `salvage` ledger row). Answers with the refreshed list. */
export async function salvagePanelMaterial(token: string | null, panelId: number, articleId: number, quantity = 1): Promise<PanelMaterial> {
  return apiFetch<PanelMaterial>(`/schaltplan/panels/${panelId}/material/salvage`, token, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ article_id: articleId, quantity }),
  });
}

/** Take a return back (`salvage_undo`); refused when the pieces are already out of stock again. */
export async function unsalvagePanelMaterial(token: string | null, panelId: number, articleId: number, quantity = 1): Promise<PanelMaterial> {
  return apiFetch<PanelMaterial>(`/schaltplan/panels/${panelId}/material/unsalvage`, token, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ article_id: articleId, quantity }),
  });
}
