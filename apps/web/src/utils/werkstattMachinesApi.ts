// API client for the Werkstatt machine (Maschinen) endpoints.
//
// Backend lives in apps/api/app/routers/workflow_werkstatt_machines.py.
//
// Gating is deliberately split (see that module's docstring):
//   reads + book/return/inspection → any authenticated user
//   create                         → `werkstatt:machines_create` OR `werkstatt:manage`
//   update                         → `werkstatt:machines_edit`   OR `werkstatt:manage`
// The person who physically takes a drill off the shelf has to be the person
// who can record it, or the log stops matching the rack. Registering new tools
// and correcting existing ones are separate jobs, so they are separate grants —
// with `werkstatt:manage` as the umbrella that still implies both.
//
//   GET    /werkstatt/machines                  → listMachines
//   GET    /werkstatt/machines/{id}             → getMachine       (+components)
//   GET    /werkstatt/machines/{id}/history     → getMachineHistory
//   POST   /werkstatt/machines                  → createMachine
//   PATCH  /werkstatt/machines/{id}             → updateMachine
//   POST   /werkstatt/machines/{id}/book        → bookMachine      (cascades)
//   POST   /werkstatt/machines/{id}/return      → returnMachine    (cascades)
//   POST   /werkstatt/machines/{id}/inspection  → recordInspection
//   POST   /werkstatt/machines/{id}/print-label → printMachineLabel
//   POST   /werkstatt/machines/print-labels     → printMachineLabels (Druckliste)
//   GET    /werkstatt/machines/label-capabilities → getLabelCapabilities

import { apiFetch } from "../api/client";
import type {
  Machine,
  MachineBookPayload,
  MachineCreatePayload,
  MachineInspectionPayload,
  MachineLabelBatchPayload,
  MachineLabelBatchResult,
  MachineLabelCapabilities,
  MachineLabelPrintResult,
  MachineListFilters,
  MachineMovement,
  MachineReturnPayload,
  MachineUpdatePayload,
} from "../types/werkstattMachines";

/**
 * Build the query string, skipping empty values.
 *
 * `false` is dropped rather than sent: every boolean filter on this endpoint
 * defaults to false server-side, so `overdue_only=false` is noise, and sending
 * it would make otherwise-identical requests miss the browser cache.
 */
function buildQuery(filters: MachineListFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function listMachines(
  token: string | null,
  filters: MachineListFilters = {},
): Promise<Machine[]> {
  return apiFetch<Machine[]>(`/werkstatt/machines${buildQuery(filters)}`, token);
}

/** Single machine WITH its sub-components — the list endpoint omits those. */
export async function getMachine(token: string | null, id: number): Promise<Machine> {
  return apiFetch<Machine>(`/werkstatt/machines/${id}`, token);
}

export async function getMachineHistory(
  token: string | null,
  id: number,
  limit = 100,
): Promise<MachineMovement[]> {
  return apiFetch<MachineMovement[]>(`/werkstatt/machines/${id}/history?limit=${limit}`, token);
}

export async function createMachine(
  token: string | null,
  payload: MachineCreatePayload,
): Promise<Machine> {
  return apiFetch<Machine>(`/werkstatt/machines`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateMachine(
  token: string | null,
  id: number,
  patch: MachineUpdatePayload,
): Promise<Machine> {
  return apiFetch<Machine>(`/werkstatt/machines/${id}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/**
 * Hand a machine out. Returns EVERY unit that changed — the machine first, then
 * each sub-component that went with it. Callers should surface the count: a
 * packer who books one drill and sees "3 gebucht" learns that the battery and
 * charger are now signed out to them too.
 */
export async function bookMachine(
  token: string | null,
  id: number,
  payload: MachineBookPayload,
): Promise<Machine[]> {
  return apiFetch<Machine[]>(`/werkstatt/machines/${id}/book`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Book back in. Cascades to sub-components exactly like `bookMachine`. */
export async function returnMachine(
  token: string | null,
  id: number,
  payload: MachineReturnPayload = {},
): Promise<Machine[]> {
  return apiFetch<Machine[]>(`/werkstatt/machines/${id}/return`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Record a DGUV3 / BG-Prüfung. A failed check moves the machine to `defekt`. */
export async function recordInspection(
  token: string | null,
  id: number,
  payload: MachineInspectionPayload,
): Promise<Machine> {
  return apiFetch<Machine>(`/werkstatt/machines/${id}/inspection`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Print the machine's shelf label on the workshop's WAGO label printer.
 *
 * The server answers 503 when no printer is configured for the deployment and
 * 502 when the printer is off or unreachable — both carry a German `detail`
 * that can be shown to the user verbatim.
 */
export async function printMachineLabel(
  token: string | null,
  id: number,
): Promise<MachineLabelPrintResult> {
  return apiFetch<MachineLabelPrintResult>(`/werkstatt/machines/${id}/print-label`, token, {
    method: "POST",
  });
}

/**
 * Print the collected queue in one go. Klein entries pack four-per-sheet in
 * queue order — deliberately allowing different machines on one physical
 * label, which is the queue's reason to exist.
 */
export async function printMachineLabels(
  token: string | null,
  payload: MachineLabelBatchPayload,
): Promise<MachineLabelBatchResult> {
  return apiFetch<MachineLabelBatchResult>(`/werkstatt/machines/print-labels`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * What the loaded printer material can carry. The Maschinen page uses this to
 * disable the Vollformat button with a reason instead of letting it 400.
 */
export async function getLabelCapabilities(
  token: string | null,
): Promise<MachineLabelCapabilities> {
  return apiFetch<MachineLabelCapabilities>(`/werkstatt/machines/label-capabilities`, token);
}
