/**
 * The sentence under a downloaded order CSV.
 *
 * Its own module, and a pure function: the download itself touches the DOM and
 * the network and is mocked out wherever a page is rendered, while THIS is the
 * part that must never be mocked — it is the only thing that tells the buyer
 * the file is shorter than the order.
 */
import type { OrderExportResult } from "../types/werkstattProcurement";

/**
 * What the download actually did, said completely.
 *
 * The file can be SHORTER than the order: `build_order_csv` writes only the
 * positions the identifier policy can express (see
 * apps/api/app/services/werkstatt_order_export.py), and the response reports
 * the rest as `dropped_positions` with `warnings` that name the articles.
 * Printing `sent_positions` alone hands the buyer a three-line CSV for an
 * order SMPL's own record says has five — they e-mail it, two articles are
 * never ordered, and the shortage turns up on the Baustelle. That is exactly
 * the short basket the pre-send gate exists to prevent.
 *
 * Same sentence, same warning prefix, as the Bestellungen drawer builds for
 * the very same endpoint in `hooks/useOrderHandover.ts`.
 */
export function orderCsvNotice(result: OrderExportResult, de: boolean): string {
  const warned = result.warnings.length > 0 ? `${result.warnings.join(" · ")} — ` : "";
  const total = result.sent_positions + result.dropped_positions;
  if (result.dropped_positions > 0) {
    const missing = result.dropped_positions;
    return de
      ? `${warned}${result.filename} heruntergeladen (${result.sent_positions} von ${total} Positionen; ${missing} ohne Lieferanten-Artikelnummer ${missing === 1 ? "ist" : "sind"} NICHT in der Datei).`
      : `${warned}${result.filename} downloaded (${result.sent_positions} of ${total} lines; ${missing} without a supplier article number ${missing === 1 ? "is" : "are"} NOT in the file).`;
  }
  return de
    ? `${warned}${result.filename} heruntergeladen (${result.sent_positions} ${result.sent_positions === 1 ? "Position" : "Positionen"}).`
    : `${warned}${result.filename} downloaded (${result.sent_positions} ${result.sent_positions === 1 ? "line" : "lines"}).`;
}
