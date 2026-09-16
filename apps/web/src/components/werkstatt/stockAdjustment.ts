import type { StockAdjustmentKind } from "../../utils/werkstattArticlesApi";

/**
 * Arithmetic behind the "Bestand anpassen" dialog.
 *
 * Pure and separate from the component so the numbers can be tested without a
 * DOM — they book real stock, and the ledger they feed is the workshop's only
 * record of what it owns.
 *
 * What each kind means, and why the bounds are what they are, follows the
 * movement deltas in apps/api/app/services/werkstatt_movements.py:
 *
 *   intake     → `intake`          { total +n, available +n }
 *   defect     → `inventory_minus` { total −n, available −n }
 *   inventory  → `inventory_plus` / `inventory_minus`, derived from the
 *                difference between the counted total and the current one
 *
 * Note what is NOT here: `correction`. It also decrements `stock_out`, which
 * is right only for a checked-out item confirmed lost. Neither a delivery nor
 * a shelf count can see checked-out stock, so using it for either would
 * silently write off tools that are sitting in someone's van.
 *
 * ── The shelf count, and why it is not the total ──────────────────────────
 *
 * All three kinds take a number a person read off the physical world, and for
 * `inventory` that person is standing at the shelf with a clipboard. They can
 * count what is ON the shelf. They cannot count the three pieces on a van or
 * the two away at repair — those are invisible from where they stand.
 *
 * So the `inventory` amount is the SHELF COUNT, never the total. The total the
 * count implies is `counted + offShelfCount(stock)`, and that is what the API's
 * `target_total` receives. Reading a shelf count as a total is how an article
 * with 12 owned and 9 on the shelf gets written down to 9, booking away three
 * items that physically exist.
 *
 * This is the same distinction the backend's movement vocabulary encodes:
 * `inventory_plus`/`inventory_minus` move `total` and `available` together and
 * never touch `out` or `repair`, precisely because a shelf count is a
 * statement about the shelf alone.
 */
export interface ArticleStock {
  stock_total: number;
  stock_available: number;
}

/** Past any plausible workshop count; exists so a slipped keypress cannot
 *  book a million pieces. */
export const MAX_ADJUSTMENT = 999999;

/**
 * Stock that exists but is not on the shelf: checked out, or away at repair.
 *
 * The figure a shelf count cannot see, and therefore the figure that has to be
 * added back to it before it means anything about the total.
 */
export function offShelfCount(stock: ArticleStock): number {
  return Math.max(0, stock.stock_total - stock.stock_available);
}

/**
 * Turn a counted shelf figure into the total it implies.
 *
 * `counted` is what is lying on the shelf right now; everything that is out or
 * in repair still belongs to the workshop and still counts towards the total.
 */
export function totalFromShelfCount(counted: number, stock: ArticleStock): number {
  return Math.max(0, counted) + offShelfCount(stock);
}

export interface AmountBounds {
  min: number;
  max: number;
}

/**
 * Limits for the amount field, per kind.
 *
 * The `defect` ceiling exists to keep `total == available + out + repair` true:
 * it writes off from the shelf, and `inventory_minus` takes from `available` as
 * well as `total`, so you cannot scrap more than is on the shelf.
 *
 * `inventory` has no floor beyond zero — an empty shelf is a legitimate count,
 * and it does not mean the article is gone: whatever is out on a job survives
 * it, because the count is converted to a total by adding the off-shelf stock
 * back on. (It used to floor at `total − available`, which was the right floor
 * for a field holding the TOTAL. That field holds the shelf count now.)
 */
export function boundsFor(kind: StockAdjustmentKind, stock: ArticleStock): AmountBounds {
  if (kind === "defect") return { min: 0, max: Math.max(0, stock.stock_available) };
  return { min: 0, max: MAX_ADJUSTMENT };
}

/**
 * Starting value when the dialog opens, and when the user switches kind.
 *
 * `intake` and `defect` count pieces, so they start at one. `inventory` starts
 * at what the system believes is on the SHELF — a stock-take nudges that
 * figure, it does not retype it from nothing. (The field used to open on 200
 * for all three: a leftover from the design mock, and the first thing the
 * workshop complained about.)
 *
 * Clamped into the kind's own bounds, because a seed outside them is a dialog
 * that opens already invalid: `defect` on an article with nothing available
 * would otherwise offer 1 against a ceiling of 0, with Save enabled and only a
 * 400 to show for it.
 */
export function seedAmountFor(kind: StockAdjustmentKind, stock: ArticleStock): number {
  const wanted = kind === "inventory" ? Math.max(0, stock.stock_available) : 1;
  const { min, max } = boundsFor(kind, stock);
  return Math.min(max, Math.max(min, wanted));
}

export interface AdjustmentPreview {
  /** Signed change to `stock_total`. Zero means there is nothing to book. */
  delta: number;
  /** What `stock_total` becomes — for `inventory`, the counted shelf figure
   *  plus everything that is out or in repair. This is the number sent as
   *  `target_total`. */
  newTotal: number;
  /** Glyph shown in front of the input. */
  sign: "+" | "−" | "=";
  /** The whole signed display: "+5", "−5", "= 12". */
  signedLabel: string;
}

/**
 * What the pending adjustment would do — a preview only.
 *
 * The server recomputes both counters from the ledger; this is what the user
 * is told will happen, never what gets stored.
 *
 * `amount === null` is the field being momentarily empty mid-retype. It yields
 * a zero delta so nothing can be booked, and leaves the total untouched so the
 * preview does not flash a number nobody asked for.
 *
 * The result is floored at a total of zero. A typed 500 on an article holding
 * 12 is refused before it is sent, but until then the pill has to show a figure
 * the workshop could actually end up with — negative stock is not one.
 */
export function previewAdjustment(
  kind: StockAdjustmentKind,
  amount: number | null,
  stock: ArticleStock,
): AdjustmentPreview {
  const sign: AdjustmentPreview["sign"] =
    kind === "intake" ? "+" : kind === "defect" ? "−" : "=";

  if (amount === null) {
    return { delta: 0, newTotal: stock.stock_total, sign, signedLabel: sign };
  }

  const rawTotal =
    kind === "inventory"
      ? totalFromShelfCount(amount, stock)
      : kind === "defect"
        ? stock.stock_total - amount
        : stock.stock_total + amount;
  const newTotal = Math.max(0, rawTotal);

  return {
    delta: newTotal - stock.stock_total,
    newTotal,
    sign,
    signedLabel: kind === "inventory" ? `= ${newTotal}` : `${sign}${amount}`,
  };
}
