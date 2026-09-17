/**
 * API client for the two phone screens (Werkstatt — Mobile persona).
 *
 * Backend lives in apps/api/app/routers/workflow_werkstatt_mobile.py:
 *
 *   GET  /werkstatt/mobile/my-checkouts → listMyCheckouts
 *   GET  /werkstatt/mobile/movements    → listMyMovements
 *   POST /werkstatt/mobile/return       → returnArticle
 *
 * Deliberately NOT re-declared here: `getArticle`, `checkoutArticle` and
 * `adjustArticleStock` already exist in werkstattArticlesApi.ts and the phone
 * screens call those. Only the return path and the two phone-only reads had
 * no client at all.
 *
 * Every counter these endpoints answer with is DERIVED by the server from the
 * movement ledger. The phone displays what came back or it refetches — it
 * never works out a new stock figure from one it is holding.
 */

import { apiFetch } from "../api/client";
import type {
  WerkstattArticle,
  WerkstattDashboard,
  WerkstattMovement,
} from "../types/werkstatt";

/**
 * Mirrors `MyCheckoutOut` in apps/api/app/schemas/werkstatt.py — one row per
 * distinct (article, project) the caller still has out.
 */
export interface MyCheckout {
  article_id: number;
  article_number: string;
  article_name: string;
  image_url: string | null;
  unit: string | null;
  quantity_out: number;
  earliest_checkout_at: string;
  latest_expected_return_at: string | null;
  project_id: number | null;
  project_number: string | null;
  project_name: string | null;
}

/** What the signed-in user still has out. Empty array = nothing borrowed. */
export async function listMyCheckouts(token: string | null): Promise<MyCheckout[]> {
  return apiFetch<MyCheckout[]>("/werkstatt/mobile/my-checkouts", token);
}

/**
 * The below-minimum headline for the reorder pill.
 *
 * There is no lighter endpoint for this one number: `/werkstatt/dashboard` is
 * the aggregate that computes it, and its five sub-lists are capped at five
 * rows each, so the payload stays small enough for a phone. Reading one field
 * out of it here keeps the caller from holding a shape it does not use.
 */
export async function fetchBelowMinCount(token: string | null): Promise<number> {
  const dashboard = await apiFetch<WerkstattDashboard>("/werkstatt/dashboard", token);
  return dashboard.kpis.below_min_count;
}

/**
 * How an item came back. Mirrors `ReturnPayload.condition`; the server maps it
 * onto the ledger movement, which is why the UI never names one:
 *
 *   ok     → `return`      — back on the shelf, available again
 *   repair → `repair_out`  — leaves stock_out, enters stock_repair
 *   lost   → `correction`  — shrinks stock_total as well; it is gone
 */
export type ReturnCondition = "ok" | "repair" | "lost";

export interface ReturnInput {
  articleId: number;
  /** Pieces coming back; the server rejects more than is actually out. */
  quantity: number;
  condition: ReturnCondition;
  /**
   * WHICH loan is being closed, not a label.
   *
   * `list_my_checkouts` balances what a borrower still holds per
   * `(article, project)` tuple, so a return that names no project subtracts
   * from the borrower's *no-project* bucket. Sent against a project-tagged
   * checkout that meant: the row on "Meine Entnahmen" never reached zero (it
   * reappeared unchanged under the green success notice, permanently), while
   * the −qty cancelled an unrelated project-less loan of the same article.
   *
   * So every caller passes the project of the row it is returning, and `null`
   * only where the loan genuinely carries none.
   */
  projectId: number | null;
  notes: string | null;
}

/**
 * Give stock back.
 *
 * Answers with the refreshed article (`WerkstattArticleOut`), so the caller
 * can render the new counters without a second request.
 */
export async function returnArticle(
  token: string | null,
  input: ReturnInput,
): Promise<WerkstattArticle> {
  return apiFetch<WerkstattArticle>("/werkstatt/mobile/return", token, {
    method: "POST",
    body: JSON.stringify({
      article_id: input.articleId,
      quantity: input.quantity,
      condition: input.condition,
      project_id: input.projectId,
      notes: input.notes,
    }),
  });
}

/**
 * How many of the caller's movements one request can look at.
 *
 * The endpoint's own ceiling (`limit: int = Query(default=20, ge=1, le=200)`),
 * asked for in full because the list is GLOBAL to the caller and the article
 * screen filters it down to one article afterwards: a storeman who books sixty
 * movements in a shift pushed this morning's checkout out of a 50-row window,
 * and the screen then had nothing to show for an article he is holding. 200 is
 * the most this endpoint can answer, so the window is still a window — which is
 * why every surface that renders it has to SAY so rather than present an empty
 * result as "nothing was ever booked". See MobileArtikelMovements, and the
 * handoff note asking for `GET /werkstatt/articles/{id}/movements`.
 */
export const MY_MOVEMENTS_WINDOW = 200;

/**
 * The caller's own recent movements, newest first.
 *
 * Scope matters and the UI has to say so: without `?all=true` (which needs
 * `werkstatt:manage`) this endpoint returns only movements the caller
 * performed or received. The article screen filters this list to one article
 * and labels the card "Meine letzten Bewegungen" for exactly that reason —
 * there is no article-scoped movement endpoint to ask instead.
 */
export async function listMyMovements(
  token: string | null,
  limit = MY_MOVEMENTS_WINDOW,
): Promise<WerkstattMovement[]> {
  return apiFetch<WerkstattMovement[]>(`/werkstatt/mobile/movements?limit=${limit}`, token);
}
