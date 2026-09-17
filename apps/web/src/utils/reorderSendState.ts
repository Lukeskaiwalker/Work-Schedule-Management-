/**
 * What one supplier's hand-over did — and what may safely be done next.
 *
 * Deliberately outside the hook: both decisions here are about money and have
 * to be testable without React.
 *
 * 1. A FAILED SUBMISSION IS NOT AUTOMATICALLY "NOTHING WAS SENT".
 *    `POST /werkstatt/reorder/submit` creates the order, resolves it,
 *    transitions it to `sent` and `db.commit()`s it BEFORE the response is
 *    serialised (apps/api/app/routers/workflow_werkstatt_reorder.py). Only a
 *    status the API itself produced carries its `except HTTPException:
 *    db.rollback()` guarantee. A dropped connection (`fetch` rejects with a
 *    TypeError — `apiFetch` does not wrap transport failures, so there is not
 *    even a status) or a gateway's own 502/503/504 on a dead upstream carries
 *    no such guarantee: the order may exist. Saying "Es wurde nichts
 *    versendet" there invites a retry that orders the same shortfall twice.
 *
 * 2. A SUPPLIER ALREADY ORDERED FROM STAYS BLOCKED ACROSS A RELOAD.
 *    `compute_reorder_suggestions` filters on `stock_min > 0 AND
 *    stock_available < stock_min` and never joins open orders, so the same
 *    shortfall comes back in full until the goods physically arrive. The order
 *    number the page already holds is the only thing on screen that knows
 *    better, and it is keyed by a supplier id that survives the reload.
 */
import { ApiError } from "../api/client";
import type { WerkstattOrder } from "../types/werkstatt";
import type { UnresolvedLinesConflict } from "../types/werkstattProcurement";

/** The quantities as actually submitted, by article id. */
export type OrderedQuantities = ReadonlyMap<number, number>;

/**
 * Whether the server's refusal is a fact ("not-sent") or a guess ("unknown").
 * Never widened to a boolean: the UI says different sentences for the two and
 * only one of them may claim that nothing happened.
 */
export type SubmitFailureOutcome = "not-sent" | "unknown";

/** Where one supplier's hand-over stands. Absent from the map = untouched. */
export type ReorderSendState =
  | { kind: "sending" }
  | {
      kind: "conflict";
      detail: UnresolvedLinesConflict;
      /**
       * The article ids exactly as submitted, in order. `unresolved_positions`
       * is 1-based over that list, so this is what turns "Position 2" back
       * into an article the buyer recognises.
       */
      submittedArticleIds: readonly number[];
    }
  | {
      kind: "sent";
      order: WerkstattOrder;
      allowUnresolved: boolean;
      /** What went out per article — the list on screen may since have moved. */
      orderedQuantities: OrderedQuantities;
      /** True once the suggestion list has been re-read under this order. */
      carriedOver: boolean;
    }
  | { kind: "error"; outcome: SubmitFailureOutcome; message: string };

/**
 * A gateway status is not the API's answer.
 *
 * Caddy sits in front of the api container (see the deploy runbook) and the
 * container is memory-capped and has been OOM-killed in production. When the
 * upstream dies mid-request the proxy answers 502/504 on its own — after the
 * commit, possibly — so those statuses say nothing about whether the order
 * exists. 503 joins them because the same proxy answers it for an upstream it
 * cannot reach, and "unknown" is the safe reading either way.
 */
const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export function submitFailureOutcome(err: unknown): SubmitFailureOutcome {
  // Not an ApiError at all: `fetch` itself rejected. No answer ever arrived.
  if (!(err instanceof ApiError)) return "unknown";
  // Status 0 is the client's own "no answer" (see api/client.ts), whether the
  // connection dropped or the caller aborted it.
  if (err.status === 0 || err.code === "network" || err.code === "abort") return "unknown";
  if (GATEWAY_STATUSES.has(err.status)) return "unknown";
  return "not-sent";
}

/**
 * True while sending again could duplicate a real purchase order: the order
 * exists, or we never learned whether it does. Both are cleared only by the
 * buyer dismissing the panel, never by a reload.
 */
export function resendBlocked(state: ReorderSendState | null): boolean {
  if (state === null) return false;
  if (state.kind === "sent" || state.kind === "sending") return true;
  return state.kind === "error" && state.outcome === "unknown";
}

/**
 * The send states that survive re-reading the suggestion list.
 *
 * The rule is `resendBlocked`: everything that would make a second click
 * dangerous is a fact about the world, not about the list, and a reload knows
 * nothing that could retire it. A refusal is the opposite — a 409's positions
 * are 1-based over lines that may have moved, and a 4xx describes a request
 * made against the old list — so those go, and the buyer starts clean.
 *
 * Sent orders are marked `carriedOver` so the panel says "bereits bestellt"
 * instead of repeating a success that happened before the refresh.
 */
export function sendStatesAcrossReload(
  states: ReadonlyMap<number, ReorderSendState>,
): ReadonlyMap<number, ReorderSendState> {
  const next = new Map<number, ReorderSendState>();
  for (const [supplierId, state] of states) {
    if (!resendBlocked(state)) continue;
    next.set(supplierId, state.kind === "sent" ? { ...state, carriedOver: true } : state);
  }
  return next;
}
