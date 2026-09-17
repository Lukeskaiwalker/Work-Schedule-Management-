/**
 * The order presentation helpers, pinned down where they now live.
 *
 * They moved out of `components/werkstatt/mockData.ts` — a module that is
 * being deleted — without a line of their behaviour changing. This file is
 * what makes that claim checkable: every case here is a figure a buyer reads
 * off the Bestellungen list, and a silent drift in any of them (a wrong
 * currency, an off-by-one overdue count) would be believed.
 */
import { describe, expect, it } from "vitest";
import {
  ORDERS_FILTER_CHIPS,
  daysSinceIso,
  deliveryLabel,
  formatMoney,
  orderMatchesFilter,
  orderOverdueDays,
  orderStatusLabel,
  orderStatusToTone,
  shortDate,
  type OrderTiming,
} from "../components/werkstatt/orderPresentation";

const NOW = Date.parse("2026-09-17T10:00:00Z");

function timing(over: Partial<OrderTiming> = {}): OrderTiming {
  return {
    status: "sent",
    expected_delivery_at: null,
    delivered_at: null,
    ...over,
  };
}

/** de-DE money uses a non-breaking space before the symbol. */
function squashed(value: string): string {
  return value.replace(/ /g, " ");
}

describe("formatMoney", () => {
  it("prints euro cents in German", () => {
    expect(squashed(formatMoney(123456, "EUR"))).toBe("1.234,56 €");
  });

  it("keeps an unknown total unknown rather than showing 0,00 €", () => {
    expect(formatMoney(null, "EUR")).toBe("—");
  });
});

describe("shortDate", () => {
  it("formats an ISO date for the list", () => {
    expect(shortDate("2026-09-17T10:00:00Z", true)).toBe("17.09.26");
  });

  it("answers an em dash for null and for junk", () => {
    expect(shortDate(null, true)).toBe("—");
    expect(shortDate("not-a-date", true)).toBe("—");
  });
});

describe("daysSinceIso / orderOverdueDays", () => {
  it("counts whole days elapsed", () => {
    expect(daysSinceIso("2026-09-14T10:00:00Z", NOW)).toBe(3);
  });

  it("clamps a future ETA to zero days overdue", () => {
    expect(orderOverdueDays(timing({ expected_delivery_at: "2026-09-20T10:00:00Z" }), NOW)).toBe(0);
  });

  it("counts days past the ETA", () => {
    expect(orderOverdueDays(timing({ expected_delivery_at: "2026-09-10T10:00:00Z" }), NOW)).toBe(7);
  });

  it("does not call a delivered or cancelled order overdue", () => {
    const delivered = timing({ status: "delivered", expected_delivery_at: "2026-09-01T10:00:00Z" });
    const cancelled = timing({ status: "cancelled", expected_delivery_at: "2026-09-01T10:00:00Z" });
    expect(orderOverdueDays(delivered, NOW)).toBeNull();
    expect(orderOverdueDays(cancelled, NOW)).toBeNull();
  });
});

describe("deliveryLabel", () => {
  it("admits when there is no delivery date at all", () => {
    expect(deliveryLabel(timing(), true, NOW)).toEqual({ text: "kein Termin", tone: "neutral" });
  });

  it("marks an overdue order red with its day count", () => {
    expect(deliveryLabel(timing({ expected_delivery_at: "2026-09-15T10:00:00Z" }), true, NOW)).toEqual(
      { text: "überfällig 2 Tage", tone: "red" },
    );
  });

  it("uses the singular on the first day overdue", () => {
    expect(deliveryLabel(timing({ expected_delivery_at: "2026-09-16T10:00:00Z" }), true, NOW).text)
      .toBe("überfällig 1 Tag");
  });

  it("says today, and counts forward for a future date", () => {
    expect(deliveryLabel(timing({ expected_delivery_at: "2026-09-17T09:00:00Z" }), true, NOW)).toEqual(
      { text: "heute", tone: "amber" },
    );
    expect(deliveryLabel(timing({ expected_delivery_at: "2026-09-20T10:00:00Z" }), true, NOW).text)
      .toBe("in 3 Tagen");
  });

  it("reports a delivered order by how long ago it arrived", () => {
    const order = timing({ status: "delivered", delivered_at: "2026-09-15T10:00:00Z" });
    expect(deliveryLabel(order, true, NOW)).toEqual({ text: "vor 2 Tagen geliefert", tone: "mint" });
  });
});

describe("orderMatchesFilter", () => {
  it("treats confirmed and partially delivered as in transit", () => {
    expect(orderMatchesFilter({ status: "confirmed" }, "in_transit", null)).toBe(true);
    expect(orderMatchesFilter({ status: "partially_delivered" }, "in_transit", null)).toBe(true);
    expect(orderMatchesFilter({ status: "draft" }, "in_transit", null)).toBe(false);
  });

  it("only counts an open order as overdue", () => {
    expect(orderMatchesFilter({ status: "sent" }, "overdue", 2)).toBe(true);
    expect(orderMatchesFilter({ status: "delivered" }, "overdue", 2)).toBe(false);
    expect(orderMatchesFilter({ status: "sent" }, "overdue", 0)).toBe(false);
    expect(orderMatchesFilter({ status: "sent" }, "overdue", null)).toBe(false);
  });

  it("lets everything through the all filter", () => {
    expect(orderMatchesFilter({ status: "cancelled" }, "all", null)).toBe(true);
  });
});

describe("status labels and tones", () => {
  it("labels every status in both languages", () => {
    expect(orderStatusLabel("partially_delivered", true)).toBe("Teilgeliefert");
    expect(orderStatusLabel("partially_delivered", false)).toBe("Partial");
    expect(orderStatusLabel("cancelled", true)).toBe("Storniert");
  });

  it("gives a delivered order the calm tone and a cancelled one the red", () => {
    expect(orderStatusToTone("delivered")).toBe("mint");
    expect(orderStatusToTone("cancelled")).toBe("red");
    expect(orderStatusToTone("draft")).toBe("grey");
  });
});

describe("ORDERS_FILTER_CHIPS", () => {
  it("offers each filter exactly once", () => {
    const keys = ORDERS_FILTER_CHIPS.map((chip) => chip.key);
    expect(keys).toEqual(["all", "draft", "sent", "in_transit", "overdue", "delivered"]);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
