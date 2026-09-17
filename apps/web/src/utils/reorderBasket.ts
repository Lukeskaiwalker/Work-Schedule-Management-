/**
 * The arithmetic behind Werkstatt › Nachbestellen, kept out of the pages.
 *
 * Both reorder screens (desktop and phone) show the same numbers from the same
 * endpoint, so the totals are computed once here and rendered twice. Pure
 * functions: no React, no fetch — which is also what makes the money rules
 * testable without a DOM.
 *
 * Two rules the UI must not get wrong:
 *
 *   1. A suggestion line may carry NO price (`unit_price_cents === null`, when
 *      the article↔supplier link has none). Such a line still belongs in the
 *      basket, but it cannot be added to a sum. Totals therefore report how
 *      many positions are unpriced, and the pages label the amount as a
 *      lower bound instead of printing a number that pretends to be complete.
 *   2. Quantity 0 means "do not order this line". The server refuses a
 *      quantity below 1, so such a line is left out of the submission
 *      entirely rather than sent as a zero.
 */

import type { ReorderSuggestionGroup, ReorderSuggestionLine, ReorderSubmitLine } from "./werkstattReorderApi";

/** How far below minimum a line is — drives the stock pill. */
export type ReorderSeverity = "out" | "low";

/** Quantity overrides, keyed by {@link basketLineKey}. */
export type ReorderQuantities = ReadonlyMap<string, number>;

export interface ReorderGroupTotals {
  /** Positions with quantity ≥ 1 — what would actually be ordered. */
  positionCount: number;
  /** Sum over priced positions only. */
  cents: number;
  /** Positions with quantity ≥ 1 whose price is unknown. */
  unpricedCount: number;
}

export interface ReorderBasketTotals extends ReorderGroupTotals {
  /** Suppliers still holding at least one position. */
  supplierCount: number;
  /** Lines in the list (regardless of quantity) — "unter Mindestbestand". */
  lineCount: number;
  /** Lines whose stock has run out completely. */
  criticalCount: number;
}

/**
 * Article ids are unique per article but a line is only unique per supplier
 * group: the same article can be suggested for two suppliers if the preferred
 * link changes underneath. Key on both so an edit in one group never moves a
 * stepper in another.
 */
export function basketLineKey(supplierId: number, articleId: number): string {
  return `${supplierId}:${articleId}`;
}

export function severityOf(line: ReorderSuggestionLine): ReorderSeverity {
  return line.stock_available <= 0 ? "out" : "low";
}

/** The buyer's quantity for one line, falling back to the suggestion. */
export function quantityOf(
  quantities: ReorderQuantities,
  supplierId: number,
  line: ReorderSuggestionLine,
): number {
  const override = quantities.get(basketLineKey(supplierId, line.article_id));
  return override === undefined ? line.suggested_quantity : override;
}

export function groupTotals(
  group: ReorderSuggestionGroup,
  quantities: ReorderQuantities,
): ReorderGroupTotals {
  let cents = 0;
  let positionCount = 0;
  let unpricedCount = 0;
  for (const line of group.lines) {
    const quantity = quantityOf(quantities, group.supplier_id, line);
    if (quantity < 1) continue;
    positionCount += 1;
    if (line.unit_price_cents === null) unpricedCount += 1;
    else cents += quantity * line.unit_price_cents;
  }
  return { positionCount, cents, unpricedCount };
}

/**
 * Page-level totals. `skipSupplierIds` holds the groups already ordered in
 * this session — their money has left the basket and must not be counted a
 * second time — while `lineCount` / `criticalCount` keep describing the whole
 * list, because those articles are still below their minimum until stock
 * actually arrives.
 */
export function basketTotals(
  groups: readonly ReorderSuggestionGroup[],
  quantities: ReorderQuantities,
  skipSupplierIds: ReadonlySet<number> = new Set(),
): ReorderBasketTotals {
  let cents = 0;
  let positionCount = 0;
  let unpricedCount = 0;
  let supplierCount = 0;
  let lineCount = 0;
  let criticalCount = 0;

  for (const group of groups) {
    lineCount += group.lines.length;
    for (const line of group.lines) {
      if (severityOf(line) === "out") criticalCount += 1;
    }
    if (skipSupplierIds.has(group.supplier_id)) continue;
    const totals = groupTotals(group, quantities);
    if (totals.positionCount === 0) continue;
    supplierCount += 1;
    positionCount += totals.positionCount;
    cents += totals.cents;
    unpricedCount += totals.unpricedCount;
  }

  return { positionCount, cents, unpricedCount, supplierCount, lineCount, criticalCount };
}

/**
 * The submission payload for one group: what the buyer set, minus everything
 * they zeroed out. The unit price travels with the line so the order records
 * the price the buyer was shown rather than whatever the link says later.
 */
export function submitLinesFor(
  group: ReorderSuggestionGroup,
  quantities: ReorderQuantities,
): ReorderSubmitLine[] {
  return group.lines
    .map((line) => ({
      article_id: line.article_id,
      quantity: quantityOf(quantities, group.supplier_id, line),
      unit_price_cents: line.unit_price_cents,
    }))
    .filter((line) => line.quantity >= 1);
}

/** An immutable quantity update — never mutate the map the page renders from. */
export function withQuantity(
  quantities: ReorderQuantities,
  supplierId: number,
  articleId: number,
  quantity: number,
): ReorderQuantities {
  const next = new Map(quantities);
  next.set(basketLineKey(supplierId, articleId), Math.max(0, Math.trunc(quantity)));
  return next;
}

/**
 * One position the server refused to send, named.
 *
 * `unresolved_positions` in the 409 is 1-based over the lines as submitted,
 * which is a number the buyer cannot act on by itself. Resolving it back to
 * the article is the difference between "2 Positionen ohne Artikelnummer" and
 * knowing which two articles to go and fix.
 */
export interface UnresolvedPosition {
  position: number;
  articleNumber: string | null;
  articleName: string | null;
}

export function unresolvedPositions(
  group: ReorderSuggestionGroup,
  submittedArticleIds: readonly number[],
  positions: readonly number[],
): UnresolvedPosition[] {
  const linesById = new Map(group.lines.map((line) => [line.article_id, line]));
  return positions.map((position) => {
    const articleId = submittedArticleIds[position - 1];
    const line = articleId === undefined ? undefined : linesById.get(articleId);
    return {
      position,
      articleNumber: line?.article_number ?? null,
      articleName: line?.article_name ?? null,
    };
  });
}

/**
 * The one currency every group is quoted in, or null when they differ.
 *
 * Suppliers carry their own currency, so a page-level sum across groups is
 * only meaningful when they agree. Where they do not, the pages show the
 * per-group subtotals and say why there is no grand total, rather than adding
 * francs to euros.
 */
export function commonCurrency(groups: readonly ReorderSuggestionGroup[]): string | null {
  let currency: string | null = null;
  for (const group of groups) {
    const groupCurrency = (group.currency || "EUR").toUpperCase();
    if (currency === null) currency = groupCurrency;
    else if (currency !== groupCurrency) return null;
  }
  return currency;
}

export function formatCents(
  cents: number,
  currency: string,
  language: "de" | "en",
): string {
  return (cents / 100).toLocaleString(language === "de" ? "de-DE" : "en-US", {
    style: "currency",
    // A currency the browser does not know throws inside Intl; the server
    // stores free text here, so an unknown code must not take the page down.
    currency: /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** The short marker beside a unit price. Unknown codes print as themselves. */
export function currencySymbol(currency: string): string {
  const code = (currency || "EUR").toUpperCase();
  if (code === "EUR") return "€";
  if (code === "CHF") return "CHF";
  if (code === "USD") return "$";
  if (code === "GBP") return "£";
  return code;
}

/** Unit prices are quoted to three decimals below one euro (cable, per metre). */
export function formatUnitPrice(cents: number, language: "de" | "en"): string {
  const euros = cents / 100;
  return euros.toLocaleString(language === "de" ? "de-DE" : "en-US", {
    minimumFractionDigits: euros < 1 ? 3 : 2,
    maximumFractionDigits: 3,
  });
}

/** "Contorion GmbH" → "Contorion", for the per-group call to action. */
export function shortSupplierName(group: ReorderSuggestionGroup): string {
  const short = (group.supplier_short_name ?? "").trim();
  if (short) return short;
  const name = group.supplier_name.trim();
  for (const suffix of [" GmbH", " AG", " KG", " Group", " OHG", " SE"]) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  }
  const firstSpace = name.indexOf(" ");
  return firstSpace > 0 ? name.slice(0, firstSpace) : name;
}

export function leadTimeLabel(
  group: ReorderSuggestionGroup,
  de: boolean,
): string | null {
  const days = group.default_lead_time_days;
  if (days === null || days <= 0) return null;
  if (de) return `Lieferzeit ca. ${days} ${days === 1 ? "Tag" : "Tage"}`;
  return `lead time approx. ${days} ${days === 1 ? "day" : "days"}`;
}
