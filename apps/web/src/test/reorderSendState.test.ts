/**
 * What a failed reorder proves, and what survives re-reading the list.
 *
 * Both are money rules, and both were wrong in a way no rendering test would
 * have shown: the page claimed "Es wurde nichts versendet" for a request that
 * never got an answer, and it forgot the order number it was holding the
 * moment the buyer left the tab and came back. Either one turns into a second
 * real purchase order at the supplier.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "../api/client";
import {
  resendBlocked,
  sendStatesAcrossReload,
  submitFailureOutcome,
  type ReorderSendState,
} from "../utils/reorderSendState";
import type { WerkstattOrder } from "../types/werkstatt";

function order(number_ = "BST-2026-0101"): WerkstattOrder {
  return {
    id: 1,
    order_number: number_,
    supplier_id: 7,
    supplier_name: "Unielektro Fulda GmbH",
    status: "sent",
    line_count: 2,
    currency: "EUR",
    total_amount_cents: 12000,
  } as unknown as WerkstattOrder;
}

function sent(carriedOver = false): ReorderSendState {
  return {
    kind: "sent",
    order: order(),
    allowUnresolved: false,
    orderedQuantities: new Map([[101, 100]]),
    carriedOver,
  };
}

describe("submitFailureOutcome", () => {
  it("calls a dropped connection unknown — the endpoint commits before it answers", () => {
    // `apiFetch` does not wrap a transport failure, so this is literally what
    // the page catches when the link dies mid-request.
    expect(submitFailureOutcome(new TypeError("Failed to fetch"))).toBe("unknown");
    expect(submitFailureOutcome(new ApiError("Network request failed", 0, null, null, "network"))).toBe(
      "unknown",
    );
    expect(submitFailureOutcome(new ApiError("Aborted", 0, null, null, "abort"))).toBe("unknown");
  });

  it("calls a gateway's own answer unknown — the api never spoke", () => {
    // Caddy answers these for a dead or unreachable upstream; the order may
    // already be committed behind it.
    expect(submitFailureOutcome(new ApiError("Bad Gateway", 502))).toBe("unknown");
    expect(submitFailureOutcome(new ApiError("Service Unavailable", 503))).toBe("unknown");
    expect(submitFailureOutcome(new ApiError("Gateway Timeout", 504))).toBe("unknown");
  });

  it("trusts a status the api produced — its handler rolls the order back", () => {
    expect(submitFailureOutcome(new ApiError("Supplier not found", 404))).toBe("not-sent");
    expect(submitFailureOutcome(new ApiError("Keine Berechtigung", 403))).toBe("not-sent");
    expect(submitFailureOutcome(new ApiError("Ungültige Menge", 422))).toBe("not-sent");
    expect(submitFailureOutcome(new ApiError("Interner Fehler", 500))).toBe("not-sent");
  });
});

describe("resendBlocked", () => {
  it("blocks a second send while an order exists or might exist", () => {
    expect(resendBlocked(sent())).toBe(true);
    expect(resendBlocked(sent(true))).toBe(true);
    expect(resendBlocked({ kind: "sending" })).toBe(true);
    expect(resendBlocked({ kind: "error", outcome: "unknown", message: "Failed to fetch" })).toBe(
      true,
    );
  });

  it("leaves a refusal re-sendable — there the server said nothing happened", () => {
    expect(resendBlocked(null)).toBe(false);
    expect(resendBlocked({ kind: "error", outcome: "not-sent", message: "404" })).toBe(false);
    expect(
      resendBlocked({
        kind: "conflict",
        detail: { code: "unresolved_lines", message: "1 Position", warnings: [], unresolved_positions: [2] },
        submittedArticleIds: [101, 102],
      }),
    ).toBe(false);
  });
});

describe("sendStatesAcrossReload", () => {
  it("keeps the order a reload cannot see and drops what described the old list", () => {
    const before = new Map<number, ReorderSendState>([
      [7, sent()],
      [8, { kind: "sending" }],
      [
        9,
        {
          kind: "conflict",
          detail: { code: "unresolved_lines", message: "1 Position", warnings: [], unresolved_positions: [1] },
          submittedArticleIds: [201],
        },
      ],
      [10, { kind: "error", outcome: "not-sent", message: "404" }],
    ]);

    const after = sendStatesAcrossReload(before);

    // The suggestion engine re-suggests the same shortfall — only this marker
    // knows an order for it already exists.
    expect(after.get(7)).toEqual({ ...sent(), carriedOver: true });
    expect(after.get(8)).toEqual({ kind: "sending" });
    // Positions in a 409 are 1-based over lines that may have moved.
    expect(after.has(9)).toBe(false);
    expect(after.has(10)).toBe(false);
  });

  it("keeps an unknown outcome — the buyer was sent to check, and comes back", () => {
    const unknown: ReorderSendState = {
      kind: "error",
      outcome: "unknown",
      message: "Failed to fetch",
    };
    // Leaving for Werkstatt › Bestellungen re-runs the load on the way back.
    // Losing the warning there is exactly how the second order gets placed.
    expect(sendStatesAcrossReload(new Map([[7, unknown]])).get(7)).toEqual(unknown);
  });

  it("never mutates the map it was handed", () => {
    const before = new Map<number, ReorderSendState>([[7, sent()]]);
    sendStatesAcrossReload(before);
    expect(before.get(7)).toEqual(sent());
  });
});
