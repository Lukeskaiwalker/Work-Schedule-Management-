/**
 * What the Bestand page tells the workshop it just did.
 *
 * Two lies lived in these sentences, and both were readable as truth:
 *
 *  - the success toast derived its delta as "server total − the total this
 *    browser was showing". The second number is fetched on mount and on
 *    search only, so on a tablet left open all morning it is hours old, and a
 *    Wareneingang of 20 could announce "+40" in the same green notice that is
 *    supposed to prove the booking landed.
 *  - the 409 carried the server's "Bitte den Dialog neu öffnen" and this
 *    page's "no need to reopen" in one breath. The dialog stays open and is
 *    refreshed in place, so exactly one of those was true of the code.
 */
import { describe, expect, it } from "vitest";
import {
  signed,
  staleStockMessage,
  stockAdjustmentNotice,
} from "../components/werkstatt/stockNotices";

/** 12 owned, 9 on the shelf — the same article the render tests book against. */
const ITEM = "Bohrer SDS-Plus 8mm";

describe("signed", () => {
  it("never prints a bare number", () => {
    expect(signed(3)).toBe("+3");
    expect(signed(-3)).toBe("−3");
    expect(signed(0)).toBe("±0");
  });
});

describe("stockAdjustmentNotice — the change it claims", () => {
  it("reports intake as the amount entered, whatever the row was showing", () => {
    // The browser's row said 12; the article is at 40 because a colleague
    // booked 25 in the meantime. Three boxes arrived. The notice says three.
    expect(
      stockAdjustmentNotice(
        {
          kind: "intake",
          itemName: ITEM,
          amount: 3,
          confirmedTotalBefore: null,
          totalAfter: 40,
          availableAfter: 37,
        },
        false,
      ),
    ).toBe("Intake +3 · Bohrer SDS-Plus 8mm — now 40 total, 37 available");
  });

  it("reports a write-off as a decrease of the amount entered", () => {
    expect(
      stockAdjustmentNotice(
        {
          kind: "defect",
          itemName: ITEM,
          amount: 2,
          confirmedTotalBefore: null,
          totalAfter: 10,
          availableAfter: 7,
        },
        true,
      ),
    ).toBe("Schwund / Defekt −2 · Bohrer SDS-Plus 8mm — neuer Bestand 10 gesamt, 7 verfügbar");
  });

  it("reports a stock-take against the total the server confirmed", () => {
    // The shelf count is not a delta — 5 counted on a shelf that held 9 is a
    // change of −4, and only the before-figure says which. That figure is
    // worth using because it went up as `expected_total`: the endpoint would
    // have answered 409 if its own total had not matched.
    expect(
      stockAdjustmentNotice(
        {
          kind: "inventory",
          itemName: ITEM,
          amount: 5,
          confirmedTotalBefore: 12,
          totalAfter: 8,
          availableAfter: 5,
        },
        false,
      ),
    ).toBe("Inventory adjust −4 · Bohrer SDS-Plus 8mm — now 8 total, 5 available");
  });

  it("claims no delta for a stock-take with no confirmed before-figure", () => {
    // Nothing verified the before-figure, so there is no honest subtraction to
    // print. The notice reports the booking and the server's totals, and
    // asserts no change it cannot stand behind. (Unreachable while the lock is
    // sent with every count — which is exactly why it is pinned here: dropping
    // the lock must not quietly put a guessed delta back on screen.)
    expect(
      stockAdjustmentNotice(
        {
          kind: "inventory",
          itemName: ITEM,
          amount: 5,
          confirmedTotalBefore: null,
          totalAfter: 8,
          availableAfter: 5,
        },
        true,
      ),
    ).toBe("Inventur-Korrektur gebucht · Bohrer SDS-Plus 8mm — neuer Bestand 8 gesamt, 5 verfügbar");
  });

  it("keeps a count that changed nothing honest about it", () => {
    expect(
      stockAdjustmentNotice(
        {
          kind: "inventory",
          itemName: ITEM,
          amount: 9,
          confirmedTotalBefore: 12,
          totalAfter: 12,
          availableAfter: 9,
        },
        false,
      ),
    ).toBe("Inventory adjust ±0 · Bohrer SDS-Plus 8mm — now 12 total, 9 available");
  });
});

describe("staleStockMessage — one instruction, not two", () => {
  /** Verbatim from `_assert_optimistic_total` in
   *  apps/api/app/routers/workflow_werkstatt_article_stock.py. */
  const SERVER_409 =
    "Der Bestand hat sich inzwischen geändert: angezeigt waren 12 Stk, aktuell sind es 15 Stk. " +
    "Bitte den Dialog neu öffnen und die Buchung prüfen.";

  it("keeps both totals and drops the instruction that is not true here", () => {
    const message = staleStockMessage(SERVER_409, true);
    expect(message).toBe(
      "Der Bestand hat sich inzwischen geändert: angezeigt waren 12 Stk, aktuell sind es 15 Stk. " +
        "Die Zahlen oben sind soeben aktualisiert worden — bitte die Eingabe dagegen prüfen und erneut speichern.",
    );
    expect(message).not.toContain("neu öffnen");
  });

  it("says the same thing in English", () => {
    expect(staleStockMessage(SERVER_409, false)).toBe(
      "Der Bestand hat sich inzwischen geändert: angezeigt waren 12 Stk, aktuell sind es 15 Stk. " +
        "The figures above have just been refreshed — check your entry against them and save again.",
    );
  });

  it("passes any other 409 detail through and still says what to do", () => {
    // The strip is targeted at one known sentence; a detail without it must
    // survive word for word, because it is the server's account of the
    // conflict and the numbers in it are the point.
    expect(staleStockMessage("Der Bestand hat sich inzwischen geändert.", false)).toBe(
      "Der Bestand hat sich inzwischen geändert. " +
        "The figures above have just been refreshed — check your entry against them and save again.",
    );
  });

  it("stands alone when the detail was nothing but that instruction", () => {
    expect(staleStockMessage("Bitte den Dialog neu öffnen und die Buchung prüfen.", false)).toBe(
      "The figures above have just been refreshed — check your entry against them and save again.",
    );
  });
});
