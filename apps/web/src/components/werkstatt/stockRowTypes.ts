/**
 * The row shape the Bestand table renders.
 *
 * Lived in `components/werkstatt/mockData.ts` as `MockInventoryRow` while the
 * table was fed by fixtures. The table is fed by `/api/werkstatt/articles`
 * now, so the type outlived the fixtures and moves here — same fields, no
 * demo data anywhere in the module, and a name that no longer claims the
 * rows are fake.
 */

export type StockTone = "available" | "low" | "empty" | "out";

/**
 * One article, already formatted for the table.
 *
 * Label-shaped on purpose: the page formats, the row prints. That is what
 * keeps one article from being quoted in one unit here and another unit in
 * the dialog this row opens.
 */
export type StockRow = {
  id: string;
  article_no: string;
  item_name: string;
  sub_meta: string;
  category: string;
  location: string;
  stock_label: string;
  stock_tone: StockTone;
  out_initials: string | null;
  out_label: string | null;
  in_transit_label: string | null;
  /** Numeric article id, for calls that act on the article itself. */
  article_id: number;
  /** The counters behind `stock_label`, unformatted.
   *
   * The row is otherwise label-shaped, but the dialogs this row opens do
   * arithmetic on stock and cap their inputs against it. Both figures travel
   * together because they mean different things: `stock_label` prints
   * AVAILABLE, an adjustment moves TOTAL, and a checkout can only take what
   * is available. */
  stock_available: number;
  stock_total: number;
  /** The article's own unit ("Stk", "m", "Rolle"), null when it has none.
   *  Travels with the counters so the row and the dialog it opens cannot end
   *  up quoting the same article in two different units. */
  unit: string | null;
  /** Whether anything on this article can be scanned. Drives the label button:
   *  a false here is stock you cannot find with a scanner. */
  scannable: boolean;
  /** Out of service. Only ever true while "Archivierte anzeigen" is on, and
   *  the row says so — an archived article sitting unmarked among live ones is
   *  how somebody books a delivery onto a row nobody looks at again. */
  is_archived: boolean;
};
