/**
 * The completion notice says what happened, not what was asked for.
 *
 * The dialog's answer and the server's outcome can differ: `same_box` on a
 * crate whose last line vanished between the preview and the PATCH empties the
 * crate, and the server records `shelf`. Phrasing the notice from the click
 * put "Rest bleibt in K3" on screen next to a Kisten page showing K3 empty.
 */
import { describe, expect, it } from "vitest";

import { remainderOutcomeText } from "../utils/taskSettlementNotice";
import type { MaterialSettlementResult } from "../types/taskSettlement";

function result(extra: Partial<MaterialSettlementResult>): MaterialSettlementResult {
  return {
    disposition: "shelf",
    remainder_box_id: null,
    remainder_box_number: null,
    handover_booked: false,
    ...extra,
  };
}

describe("remainderOutcomeText", () => {
  it("names the crate the rest stayed in", () => {
    const settlement = result({
      disposition: "same_box",
      remainder_box_id: 3,
      remainder_box_number: "K3",
    });
    expect(remainderOutcomeText(settlement, { hadRemainder: true, de: true })).toBe(
      "Rest bleibt in K3",
    );
    expect(remainderOutcomeText(settlement, { hadRemainder: true, de: false })).toBe(
      "Rest stays in K3",
    );
  });

  it("names the crate that was created, by its number", () => {
    const settlement = result({
      disposition: "new_box",
      remainder_box_id: 9,
      remainder_box_number: "BK-2026-0007",
    });
    expect(remainderOutcomeText(settlement, { hadRemainder: true, de: true })).toBe(
      "Neue Kiste BK-2026-0007 angelegt",
    );
  });

  it("says the rest was stored when the server shelved it", () => {
    expect(
      remainderOutcomeText(result({ disposition: "shelf" }), { hadRemainder: true, de: true }),
    ).toBe("Rest eingelagert");
  });

  it("reports the outcome even when the choice was something else", () => {
    // The crate was emptied in another tab between the preview and the PATCH,
    // so "same_box" could not happen — and the notice must not claim it did.
    const settlement = result({ disposition: "shelf" });
    expect(remainderOutcomeText(settlement, { hadRemainder: true, de: true })).toBe(
      "Rest eingelagert",
    );
    expect(remainderOutcomeText(settlement, { hadRemainder: true, de: true })).not.toContain(
      "bleibt",
    );
  });

  it("stays quiet when there was never anything left over", () => {
    // The overwhelming majority of completions: a crate that came back empty,
    // or no crate at all. Neither deserves a sentence about the rest.
    expect(
      remainderOutcomeText(result({ disposition: "shelf" }), { hadRemainder: false, de: true }),
    ).toBeNull();
    expect(remainderOutcomeText(null, { hadRemainder: true, de: true })).toBeNull();
    expect(remainderOutcomeText(undefined, { hadRemainder: false, de: true })).toBeNull();
  });
});
