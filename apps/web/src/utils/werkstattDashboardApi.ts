// API client for the two Werkstatt overview screens: the dashboard landing
// tab and the full "Auf Baustelle" list.
//
// Backends:
//   GET  /werkstatt/dashboard           routers/workflow_werkstatt_desktop.py
//   GET  /werkstatt/on-site             routers/workflow_werkstatt_on_site.py
//   POST /werkstatt/mobile/return       routers/workflow_werkstatt_mobile.py
//
// Gating, as enforced server-side:
//   both reads          → authenticated (no extra permission)
//   return, as yourself → authenticated
//   return, for someone → `werkstatt:manage`, because booking it against
//                         another person means `?on_behalf_of=<id>`
//
// Two endpoints for what looks like one dataset, on purpose. The dashboard
// answers with a PREVIEW of the on-site list — three projects, five rows each —
// which is right for a card and wrong for the screen whose only job is to show
// everything that is still out.

import { apiFetch } from "../api/client";
import type { WerkstattDashboard } from "../types/werkstatt";

/**
 * One article still outstanding at one project, for one person.
 *
 * Mirrors `WerkstattOnSiteItemOut` in apps/api/app/schemas/werkstatt_on_site.py.
 * `quantity_out` is what is LEFT after the returns that followed the checkout,
 * not the quantity originally taken.
 */
export interface WerkstattOnSiteItem {
  article_id: number;
  article_number: string;
  article_name: string;
  unit: string | null;
  image_url: string | null;
  quantity_out: number;
  assignee_user_id: number | null;
  assignee_display_name: string | null;
  checked_out_at: string;
  expected_return_at: string | null;
  is_overdue: boolean;
}

/**
 * Mirrors `WerkstattOnSiteGroupOut`. `project_id` is null for the one group
 * collecting checkouts booked without a building site.
 *
 * No customer name and no site address: the endpoint is gated on
 * authentication alone, while every other project read scopes on membership,
 * so the server deliberately stopped sending either. Number and title answer
 * "what is still out, and where" without naming the customer.
 */
export interface WerkstattOnSiteGroup {
  project_id: number | null;
  project_number: string | null;
  project_title: string | null;
  item_count: number;
  total_quantity: number;
  overdue_count: number;
  items: WerkstattOnSiteItem[];
}

export async function fetchWerkstattDashboard(
  token: string | null,
  signal?: AbortSignal,
): Promise<WerkstattDashboard> {
  return apiFetch<WerkstattDashboard>("/werkstatt/dashboard", token, { signal });
}

export async function listOnSiteGroups(
  token: string | null,
  signal?: AbortSignal,
): Promise<WerkstattOnSiteGroup[]> {
  return apiFetch<WerkstattOnSiteGroup[]>("/werkstatt/on-site", token, { signal });
}

export interface ReturnArticleInput {
  articleId: number;
  quantity: number;
  /**
   * Who the tool was checked out to, when that is not the caller.
   *
   * Sent as `?on_behalf_of=`, which makes the server write the return against
   * THEIR ledger balance. Booking it against the office user instead would
   * leave the item on the technician's "Meine Entnahmen" list forever, because
   * a return only settles checkouts belonging to the same person.
   *
   * Requires `werkstatt:manage`; the caller checks before offering the button.
   */
  onBehalfOf?: number | null;
  notes?: string | null;
}

/**
 * Book a return. `condition: "ok"` — the item goes back on the shelf.
 *
 * Damage and losses are NOT offered here: they write different movement types
 * (`repair_out` / `correction`), and deciding between them belongs with the
 * person holding the tool, not with an overview screen.
 */
export async function returnArticle(
  token: string | null,
  input: ReturnArticleInput,
): Promise<{ id: number; stock_out?: number }> {
  const query =
    input.onBehalfOf != null ? `?on_behalf_of=${encodeURIComponent(String(input.onBehalfOf))}` : "";
  return apiFetch<{ id: number; stock_out?: number }>(
    `/werkstatt/mobile/return${query}`,
    token,
    {
      method: "POST",
      body: JSON.stringify({
        article_id: input.articleId,
        quantity: input.quantity,
        condition: "ok",
        notes: input.notes ?? null,
      }),
    },
  );
}
