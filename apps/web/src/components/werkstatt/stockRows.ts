/**
 * API row → the presentational shape the Bestand table renders.
 *
 * StockRow is label-shaped, not number-shaped: it wants the strings the table
 * prints. Formatting here keeps the table dumb and means German wording lives
 * in one place instead of being rebuilt per cell. Moved out of
 * WerkstattInventarPage (past its size budget); pure, so it is testable
 * without the page.
 */
import type { WerkstattArticleLite } from "../../utils/werkstattArticlesApi";
import type { StockTableRowData } from "./StockTableRow";
import type { StockTone } from "./stockRowTypes";
import { unitLabel } from "./unitLabel";

export function toStockRow(a: WerkstattArticleLite, de: boolean): StockTableRowData {
  const out = Math.max(0, a.stock_total - a.stock_available);
  // One abbreviation for this article, used by the row and by every dialog the
  // row opens. The row used to print a hard-coded "Stk" while the dialog
  // printed "St." — same article, two units, two numbers.
  const unit = unitLabel(a.unit, de);
  const tone: StockTone =
    a.stock_status === "unavailable" ? "empty" : (a.stock_status as StockTone);
  return {
    id: String(a.id),
    article_no: a.article_number,
    item_name: a.item_name,
    sub_meta: [a.manufacturer, a.ean].filter(Boolean).join(" · "),
    category: a.category_name ?? "—",
    location: a.location_name ?? "—",
    stock_label: `${a.stock_available} ${unit}`,
    stock_available: a.stock_available,
    stock_total: a.stock_total,
    unit: a.unit ?? null,
    stock_tone: tone,
    out_initials: null,
    out_label: out > 0 ? (de ? `${out} unterwegs` : `${out} out`) : null,
    in_transit_label: a.next_expected_delivery_at
      ? new Date(a.next_expected_delivery_at).toLocaleDateString(de ? "de-DE" : "en-US")
      : null,
    article_id: a.id,
    // Either identifier makes the article findable with a scanner; with
    // neither, it can only be found by typing its name.
    scannable: Boolean(a.ean || a.internal_code),
    // Only ever true while "Archivierte anzeigen" is on.
    is_archived: Boolean(a.is_archived),
    // Set only when a search found the row by a supplier's number.
    matched_supplier_article_no: a.matched_supplier_article_no ?? null,
  };
}
