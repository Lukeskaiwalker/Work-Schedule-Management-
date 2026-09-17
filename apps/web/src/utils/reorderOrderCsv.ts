/**
 * The list on paper, for an order that exists.
 *
 * Werkstatt › Nachbestellen used to carry a "PDF-Export" button with no
 * endpoint behind it. There is no export of a SUGGESTION list — the export
 * the API offers belongs to an order (`GET /werkstatt/orders/{id}/export`),
 * which is why the download is offered after the reorder has been submitted
 * and not before. Same endpoint, same CSV, as the Bestellungen drawer's
 * "CSV herunterladen" (see `hooks/useOrderHandover.ts`); this is the two-line
 * version for a page that has exactly one order to hand over and no drawer.
 *
 * The order is already `sent` by then, so the server does not move
 * `submitted_at` — re-downloading the list is bookkeeping, not a second
 * hand-over.
 */
import type { OrderExportResult } from "../types/werkstattProcurement";
import { exportOrder } from "./werkstattOrdersApi";

// Excel opens a UTF-8 CSV with umlauts intact only when it starts with a BOM.
const CSV_BOM = "﻿";

/**
 * Fetch the order's CSV and hand it to the browser as a download.
 *
 * `allowUnresolved` must carry the same value the submission used: an order
 * that went out with "Trotzdem übergeben" still has a line the supplier
 * cannot identify, and the export path runs the very same gate — without the
 * flag it would answer 409 and the buyer would be told their own order is
 * broken minutes after sending it.
 *
 * Throws whatever the API layer throws; the caller owns the error surface.
 */
export async function downloadOrderCsv(
  token: string | null,
  orderId: number,
  allowUnresolved: boolean,
): Promise<OrderExportResult> {
  const result = await exportOrder(token, orderId, { allowUnresolved });
  const blob = new Blob([CSV_BOM + result.csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
  return result;
}
