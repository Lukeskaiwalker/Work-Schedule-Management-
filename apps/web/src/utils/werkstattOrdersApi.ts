// API client for Werkstatt orders, wholesaler punchout and order composition.
//
// Backends:
//   apps/api/app/routers/workflow_werkstatt_orders.py             (lifecycle)
//   apps/api/app/routers/workflow_werkstatt_order_composition.py  (contents)
//   apps/api/app/routers/workflow_werkstatt_ids.py                (punchout)
//
// Gating, as enforced server-side:
//   reads                      → any authenticated user
//   order + line mutations     → `werkstatt:manage`
//   shop connection settings   → `settings:manage` (it holds a credential)

import { apiFetch } from "../api/client";
import type { WerkstattOrder, WerkstattOrderSummary } from "../types/werkstatt";
import type {
  CartImportResult,
  IdsConnection,
  IdsConnectionTest,
  IdsConnectionUpsert,
  IdsHandoff,
  OrderAttach,
  OrderImportRow,
  OrderLineCreate,
  OrderLineUpdate,
} from "../types/werkstattProcurement";

export interface OrderListFilters {
  status?: string;
  supplier_id?: number;
  task_id?: number;
  overdue_only?: boolean;
  /** Orders folded into another are hidden by default — see merge semantics. */
  include_merged?: boolean;
}

// Takes a plain object rather than Record<string, unknown> so an interface
// without an index signature (OrderListFilters) is accepted directly.
function buildQuery(filters: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ── Lifecycle ─────────────────────────────────────────────────────────────

export async function listOrders(
  token: string | null,
  filters: OrderListFilters = {},
): Promise<WerkstattOrderSummary[]> {
  return apiFetch<WerkstattOrderSummary[]>(
    `/werkstatt/orders${buildQuery(filters)}`,
    token,
  );
}

/** Full order INCLUDING lines — the list endpoint returns summaries only. */
export async function getOrder(token: string | null, id: number): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${id}`, token);
}

export async function createOrder(
  token: string | null,
  payload: {
    supplier_id: number;
    title?: string | null;
    task_id?: number | null;
    project_id?: number | null;
    notes?: string | null;
  },
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function markOrderSent(token: string | null, id: number): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${id}/mark-sent`, token, { method: "POST" });
}

export async function markOrderDelivered(
  token: string | null,
  id: number,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${id}/mark-delivered`, token, {
    method: "POST",
  });
}

export async function cancelOrder(token: string | null, id: number): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${id}/cancel`, token, { method: "POST" });
}

// ── Contents ──────────────────────────────────────────────────────────────

/** Every mutation below returns the whole refreshed order, so no re-fetch. */
export async function addOrderLine(
  token: string | null,
  orderId: number,
  payload: OrderLineCreate,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${orderId}/lines`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateOrderLine(
  token: string | null,
  orderId: number,
  lineId: number,
  patch: OrderLineUpdate,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${orderId}/lines/${lineId}`, token, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteOrderLine(
  token: string | null,
  orderId: number,
  lineId: number,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${orderId}/lines/${lineId}`, token, {
    method: "DELETE",
  });
}

/**
 * Fold `sourceOrderId` into `orderId`. The source is retired (status
 * `cancelled`, `merged_into_order_id` set) rather than deleted.
 *
 * With `combineDuplicates` (the default) identical lines at identical prices
 * are summed. Turn it off when the two orders were for different jobs and the
 * split has to survive.
 */
export async function mergeOrders(
  token: string | null,
  orderId: number,
  sourceOrderId: number,
  combineDuplicates = true,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${orderId}/merge`, token, {
    method: "POST",
    body: JSON.stringify({
      source_order_id: sourceOrderId,
      combine_duplicates: combineDuplicates,
    }),
  });
}

/**
 * Attach to a job or project, or detach with an explicit null.
 *
 * Only the keys present are applied, so passing `{ title }` alone will not
 * silently unlink the task.
 */
export async function attachOrder(
  token: string | null,
  orderId: number,
  payload: OrderAttach,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${orderId}/attach`, token, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function listOrdersForTask(
  token: string | null,
  taskId: number,
): Promise<WerkstattOrderSummary[]> {
  return apiFetch<WerkstattOrderSummary[]>(`/werkstatt/tasks/${taskId}/orders`, token);
}

// ── Templates ─────────────────────────────────────────────────────────────

export async function listOrderTemplates(
  token: string | null,
  supplierId?: number,
): Promise<WerkstattOrderSummary[]> {
  return apiFetch<WerkstattOrderSummary[]>(
    `/werkstatt/order-templates${buildQuery({ supplier_id: supplierId })}`,
    token,
  );
}

/** Copies the order. Prices are deliberately NOT carried into the template. */
export async function saveOrderAsTemplate(
  token: string | null,
  orderId: number,
  name: string,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${orderId}/save-as-template`, token, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** Appends — apply several templates to build up one order. */
export async function applyTemplateToOrder(
  token: string | null,
  orderId: number,
  templateId: number,
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/${orderId}/apply-template`, token, {
    method: "POST",
    body: JSON.stringify({ template_id: templateId }),
  });
}

export async function createOrderFromTemplate(
  token: string | null,
  payload: {
    template_id: number;
    title?: string | null;
    task_id?: number | null;
    project_id?: number | null;
  },
): Promise<WerkstattOrder> {
  return apiFetch<WerkstattOrder>(`/werkstatt/orders/from-template`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

// ── Punchout ──────────────────────────────────────────────────────────────

/**
 * Begin a shopping trip. Open `handoff_url` in a NEW TAB — it serves a form
 * that posts itself to the wholesaler, which a same-tab navigation would
 * replace the app with.
 */
export async function startPunchout(
  token: string | null,
  payload: {
    supplier_id: number;
    order_id?: number | null;
    task_id?: number | null;
    project_id?: number | null;
  },
): Promise<IdsHandoff> {
  return apiFetch<IdsHandoff>(`/werkstatt/ids/start`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/**
 * Hand an assembled order to the shop's basket. Does NOT place the order —
 * the user confirms in the wholesaler's own checkout, under their prices.
 */
export async function submitOrderToShop(
  token: string | null,
  orderId: number,
): Promise<IdsHandoff> {
  return apiFetch<IdsHandoff>(`/werkstatt/ids/submit?order_id=${orderId}`, token, {
    method: "POST",
  });
}

/** Import a cart XML by hand — works without a configured punchout. */
export async function importCartXml(
  token: string | null,
  payload: {
    supplier_id: number;
    xml: string;
    order_id?: number | null;
    task_id?: number | null;
    project_id?: number | null;
  },
): Promise<CartImportResult> {
  return apiFetch<CartImportResult>(`/werkstatt/ids/import`, token, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** The import log — where a cart that failed to parse is recovered from. */
export async function listCartImports(
  token: string | null,
  limit = 50,
): Promise<OrderImportRow[]> {
  return apiFetch<OrderImportRow[]>(`/werkstatt/ids/imports?limit=${limit}`, token);
}

// ── Shop connection (settings:manage) ─────────────────────────────────────

export async function listIdsConnections(token: string | null): Promise<IdsConnection[]> {
  return apiFetch<IdsConnection[]>(`/werkstatt/ids/connections`, token);
}

export async function saveIdsConnection(
  token: string | null,
  payload: IdsConnectionUpsert,
): Promise<IdsConnection> {
  return apiFetch<IdsConnection>(`/werkstatt/ids/connections`, token, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteIdsConnection(
  token: string | null,
  supplierId: number,
): Promise<void> {
  await apiFetch(`/werkstatt/ids/connections/${supplierId}`, token, { method: "DELETE" });
}

/**
 * Pre-flight the configuration. Nothing is contacted — a punchout has no
 * server-to-server endpoint — but everything checkable before the user's first
 * failed trip is checked.
 */
export async function testIdsConnection(
  token: string | null,
  supplierId: number,
): Promise<IdsConnectionTest> {
  return apiFetch<IdsConnectionTest>(`/werkstatt/ids/connections/${supplierId}/test`, token, {
    method: "POST",
  });
}
