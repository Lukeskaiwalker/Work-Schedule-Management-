/**
 * The money rules behind Nachbestellen.
 *
 * Three of them are easy to get quietly wrong, and each one would put a number
 * on screen that a workshop would act on: a line without a price must not be
 * counted as zero, a supplier already ordered from must leave the basket
 * total, and suppliers quoted in different currencies must not be added up.
 */
import { describe, expect, it } from "vitest";

import {
  basketLineKey,
  basketTotals,
  commonCurrency,
  groupTotals,
  quantityOf,
  severityOf,
  shortSupplierName,
  submitLinesFor,
  unresolvedPositions,
  withQuantity,
} from "../utils/reorderBasket";
import type {
  ReorderSuggestionGroup,
  ReorderSuggestionLine,
} from "../utils/werkstattReorderApi";

function line(overrides: Partial<ReorderSuggestionLine> & { article_id: number }): ReorderSuggestionLine {
  return {
    article_number: `SP-${overrides.article_id}`,
    article_name: `Artikel ${overrides.article_id}`,
    image_url: null,
    stock_available: 2,
    stock_min: 10,
    suggested_quantity: 8,
    unit: "Stk",
    unit_price_cents: 250,
    line_total_cents: 2000,
    ...overrides,
  };
}

function group(overrides: Partial<ReorderSuggestionGroup> & { supplier_id: number }): ReorderSuggestionGroup {
  return {
    supplier_name: `Lieferant ${overrides.supplier_id}`,
    supplier_short_name: null,
    default_lead_time_days: null,
    subtotal_cents: null,
    currency: "EUR",
    lines: [line({ article_id: 1 })],
    ...overrides,
  };
}

describe("reorder basket totals", () => {
  it("counts an unpriced line as a position, never as zero euros", () => {
    const supplier = group({
      supplier_id: 7,
      lines: [
        line({ article_id: 1, unit_price_cents: 250, suggested_quantity: 4 }),
        line({ article_id: 2, unit_price_cents: null, suggested_quantity: 3 }),
      ],
    });

    const totals = groupTotals(supplier, new Map());

    expect(totals).toEqual({ positionCount: 2, cents: 1000, unpricedCount: 1 });
  });

  it("drops a line the buyer zeroed out of both the total and the payload", () => {
    const supplier = group({
      supplier_id: 7,
      lines: [
        line({ article_id: 1, suggested_quantity: 4 }),
        line({ article_id: 2, suggested_quantity: 6 }),
      ],
    });
    const quantities = withQuantity(new Map(), 7, 2, 0);

    expect(groupTotals(supplier, quantities).positionCount).toBe(1);
    expect(submitLinesFor(supplier, quantities)).toEqual([
      { article_id: 1, quantity: 4, unit_price_cents: 250 },
    ]);
  });

  it("keeps a supplier already ordered from out of the basket total", () => {
    const groups = [
      group({ supplier_id: 7, lines: [line({ article_id: 1, suggested_quantity: 4 })] }),
      group({ supplier_id: 9, lines: [line({ article_id: 2, suggested_quantity: 2 })] }),
    ];

    const before = basketTotals(groups, new Map());
    const after = basketTotals(groups, new Map(), new Set([7]));

    expect(before.cents).toBe(1500);
    expect(after.cents).toBe(500);
    expect(after.supplierCount).toBe(1);
    // The shortfall itself has not gone away — stock arrives later, not now.
    expect(after.lineCount).toBe(2);
  });

  it("counts an empty shelf as critical, a low one as not", () => {
    expect(severityOf(line({ article_id: 1, stock_available: 0 }))).toBe("out");
    expect(severityOf(line({ article_id: 1, stock_available: 1 }))).toBe("low");
    const groups = [
      group({
        supplier_id: 7,
        lines: [
          line({ article_id: 1, stock_available: 0 }),
          line({ article_id: 2, stock_available: 4 }),
        ],
      }),
    ];
    expect(basketTotals(groups, new Map()).criticalCount).toBe(1);
  });

  it("refuses to add up suppliers quoted in different currencies", () => {
    expect(commonCurrency([group({ supplier_id: 7 }), group({ supplier_id: 9 })])).toBe("EUR");
    expect(
      commonCurrency([group({ supplier_id: 7 }), group({ supplier_id: 9, currency: "CHF" })]),
    ).toBeNull();
  });

  it("keys a quantity per supplier, so one article in two groups stays apart", () => {
    expect(basketLineKey(7, 1)).not.toBe(basketLineKey(9, 1));
    const quantities = withQuantity(new Map(), 7, 1, 12);
    const subject = line({ article_id: 1, suggested_quantity: 4 });
    expect(quantityOf(quantities, 7, subject)).toBe(12);
    expect(quantityOf(quantities, 9, subject)).toBe(4);
  });

  it("never mutates the map it was handed", () => {
    const original: ReadonlyMap<string, number> = new Map([[basketLineKey(7, 1), 3]]);
    const next = withQuantity(original, 7, 1, 9);
    expect(original.get(basketLineKey(7, 1))).toBe(3);
    expect(next.get(basketLineKey(7, 1))).toBe(9);
  });

  it("turns the 409's 1-based positions back into articles", () => {
    const supplier = group({
      supplier_id: 7,
      lines: [line({ article_id: 1 }), line({ article_id: 2 }), line({ article_id: 3 })],
    });

    // Article 2 was zeroed before sending, so position 2 is article 3.
    expect(unresolvedPositions(supplier, [1, 3], [2])).toEqual([
      { position: 2, articleNumber: "SP-3", articleName: "Artikel 3" },
    ]);
    // A position the client cannot map is reported as a bare number, not
    // silently dropped — the buyer still learns something was refused.
    expect(unresolvedPositions(supplier, [1, 3], [7])).toEqual([
      { position: 7, articleNumber: null, articleName: null },
    ]);
  });

  it("shortens a supplier name only when it has no short name of its own", () => {
    expect(shortSupplierName(group({ supplier_id: 7, supplier_name: "Contorion GmbH" }))).toBe(
      "Contorion",
    );
    expect(
      shortSupplierName(
        group({ supplier_id: 7, supplier_name: "Unielektro Fulda GmbH", supplier_short_name: "UE" }),
      ),
    ).toBe("UE");
  });
});
