/**
 * The arithmetic behind "Bestand anpassen".
 *
 * These numbers book real stock into a ledger that is the workshop's only
 * record of what it owns, and two of the three kinds move the count DOWN, so
 * an off-by-one here writes off tools nobody lost.
 *
 * The part worth staring at is the shelf count. `total == available + out +
 * repair` is the invariant the whole Werkstatt module rests on, and a person
 * doing a stock-take can see exactly one term of it: the shelf. Read their
 * figure as a total and the three pieces in a colleague's van are booked away
 * — they exist, they are simply not in the room. So the count is converted,
 * never taken at face value, and the ceilings keep the rest of the invariant:
 * you cannot scrap what is not on the shelf either.
 */
import { describe, expect, it } from "vitest";
import {
  boundsFor,
  offShelfCount,
  previewAdjustment,
  seedAmountFor,
  totalFromShelfCount,
} from "../components/werkstatt/stockAdjustment";

/** 12 owned, 9 on the shelf, 3 out with a colleague. */
const STOCK = { stock_total: 12, stock_available: 9 };
/** The simple case: nothing out, so the shelf IS the total. */
const ALL_ON_SHELF = { stock_total: 5, stock_available: 5 };

describe("offShelfCount / totalFromShelfCount", () => {
  it("names the stock a clipboard cannot see", () => {
    expect(offShelfCount(STOCK)).toBe(3);
    expect(offShelfCount(ALL_ON_SHELF)).toBe(0);
  });

  it("adds the van back onto a shelf count", () => {
    // The worker counts the 9 that are actually there. The total is still 12,
    // because the 3 on the van did not stop existing.
    expect(totalFromShelfCount(9, STOCK)).toBe(12);
  });

  it("keeps an empty shelf from writing off what is out", () => {
    // Shelf bare, 3 still on the van → the workshop owns 3, not 0.
    expect(totalFromShelfCount(0, STOCK)).toBe(3);
  });

  it("is the identity when nothing is out", () => {
    expect(totalFromShelfCount(4, ALL_ON_SHELF)).toBe(4);
  });
});

describe("seedAmountFor", () => {
  it("starts piece counts at one, not at the design mock's 200", () => {
    expect(seedAmountFor("intake", STOCK)).toBe(1);
    expect(seedAmountFor("defect", STOCK)).toBe(1);
  });

  it("starts a stock-take at what the system thinks is ON THE SHELF", () => {
    // 9, not 12: the field asks what is lying there, and a stock-take nudges
    // the known figure rather than retyping it from nothing.
    expect(seedAmountFor("inventory", STOCK)).toBe(9);
    // With nothing out the two are the same number anyway.
    expect(seedAmountFor("inventory", ALL_ON_SHELF)).toBe(5);
  });

  it("never opens above its own ceiling", () => {
    // Everything is out on jobs: there is nothing on the shelf to write off,
    // so the seed cannot be 1. A dialog that opens already invalid has Save
    // enabled and only a 400 to show for it.
    const nothingOnShelf = { stock_total: 4, stock_available: 0 };
    expect(seedAmountFor("defect", nothingOnShelf)).toBe(0);
    expect(seedAmountFor("defect", nothingOnShelf)).toBeLessThanOrEqual(
      boundsFor("defect", nothingOnShelf).max,
    );
  });
});

describe("boundsFor", () => {
  it("lets intake grow without a ceiling worth hitting", () => {
    expect(boundsFor("intake", STOCK).min).toBe(0);
    expect(boundsFor("intake", STOCK).max).toBeGreaterThan(9999);
  });

  it("caps a write-off at what is on the shelf", () => {
    // inventory_minus takes from `available` as well as `total`; scrapping 12
    // of 12 while 3 are out would push available to −3.
    expect(boundsFor("defect", STOCK).max).toBe(9);
    expect(boundsFor("defect", { stock_total: 0, stock_available: 0 }).max).toBe(0);
  });

  it("lets a shelf count go all the way to zero", () => {
    // The old floor of `total − available` belonged to a field holding the
    // TOTAL. This field holds the shelf count, and an empty shelf is a real
    // thing to count — what is out is added back afterwards.
    expect(boundsFor("inventory", STOCK).min).toBe(0);
    expect(boundsFor("inventory", ALL_ON_SHELF).min).toBe(0);
  });
});

describe("previewAdjustment", () => {
  it("adds for an intake", () => {
    const preview = previewAdjustment("intake", 5, STOCK);
    expect(preview).toMatchObject({ delta: 5, newTotal: 17, sign: "+", signedLabel: "+5" });
  });

  it("subtracts for a write-off", () => {
    const preview = previewAdjustment("defect", 5, STOCK);
    expect(preview).toMatchObject({ delta: -5, newTotal: 7, sign: "−", signedLabel: "−5" });
  });

  it("reads a stock-take as a SHELF count and adds back what is out", () => {
    // The worker counts 8 where the system expected 9 on the shelf. One piece
    // is missing — not four. Reading the 8 as a total would book −4 and write
    // off three items sitting in a van.
    const preview = previewAdjustment("inventory", 8, STOCK);
    expect(preview).toMatchObject({ delta: -1, newTotal: 11, sign: "=", signedLabel: "= 11" });
  });

  it("books nothing when the shelf holds exactly what was expected", () => {
    expect(previewAdjustment("inventory", 9, STOCK).delta).toBe(0);
  });

  it("counts upwards too", () => {
    // 15 on the shelf, 3 still out → 18 owned, six more than the system knew.
    expect(previewAdjustment("inventory", 15, STOCK)).toMatchObject({ delta: 6, newTotal: 18 });
  });

  it("an empty shelf does not empty the article", () => {
    expect(previewAdjustment("inventory", 0, STOCK)).toMatchObject({ delta: -9, newTotal: 3 });
  });

  it("is a plain total when nothing is out", () => {
    // Same field, simpler article: shelf count and total are one number.
    expect(previewAdjustment("inventory", 3, ALL_ON_SHELF)).toMatchObject({
      delta: -2,
      newTotal: 3,
    });
  });

  it("never previews a negative shelf", () => {
    // A typed 500 is refused before it is sent, but until then the pill has to
    // show a figure the workshop could actually end up with.
    const preview = previewAdjustment("defect", 500, STOCK);
    expect(preview.newTotal).toBe(0);
    expect(preview.delta).toBe(-12);
  });

  it("leaves the total alone while the field is empty", () => {
    // `null` is the field mid-retype. A zero delta means nothing is bookable,
    // and the untouched total means the preview shows no invented figure.
    const preview = previewAdjustment("inventory", null, STOCK);
    expect(preview.delta).toBe(0);
    expect(preview.newTotal).toBe(12);
  });
});
